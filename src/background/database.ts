import { conversationId, mergeSnapshot, type Conversation } from '../shared/model';
import type { Project, Projects } from '../shared/projects';
import type { SideQuestionThread } from '../sidequestions/model';
import { legacyProjectRecord } from './projects';
// Keep the legacy stores for existing databases and explicit local-data clearing.
const LEGACY_TASK_STORES = ['jobs', 'artifacts', 'novels'] as const;
export const STORES = ['conversations', 'bookmarks', 'prompts', 'drafts', 'blocked', ...LEGACY_TASK_STORES,
  'sideQuestions', 'sideDeletedConversations', 'projects', 'projectConversations'] as const;
export type Store = typeof STORES[number];
export interface SideDeletedConversation { id: string; hidden: boolean; }
export interface DeletedSideQuestionTree {
  threads: SideQuestionThread[];
  nativeConversationIds: string[];
}
export class Database {
  private connection?: Promise<IDBDatabase>;
  constructor(private name = 'ds-margin-v1') {}
  private open(): Promise<IDBDatabase> {
    if(this.connection)return this.connection;
    const connection = new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(this.name, 5);
      r.onupgradeneeded = event => {
        for (const name of STORES) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath: 'id' });
        const tx = r.transaction!;
        const sideQuestions = tx.objectStore('sideQuestions');
        if (!sideQuestions.indexNames.contains('parentId')) sideQuestions.createIndex('parentId', 'parentId');
        if (!sideQuestions.indexNames.contains('nativeUrl')) sideQuestions.createIndex('nativeUrl', 'nativeUrl');
        if (event.oldVersion > 0 && event.oldVersion < 5) this.migrateProjects(tx);
      };
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('数据库正在另一页面中升级，请关闭旧页面重试'));
    });
    this.connection=connection;
    void connection.catch(()=>{if(this.connection===connection)this.connection=undefined;});
    return connection;
  }
  private migrateProjects(tx: IDBTransaction): void {
    const projects = tx.objectStore('projects');
    const membership = tx.objectStore('projectConversations');
    const byName = new Map<string, Project>();
    const deleted = tx.objectStore('sideDeletedConversations').getAllKeys();
    deleted.onsuccess = () => {
      const deletedIds = new Set(deleted.result);
      const cursor = tx.objectStore('conversations').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const snapshot = row.value as Conversation;
        if (!deletedIds.has(snapshot.id)) {
          const legacy = legacyProjectRecord(snapshot, byName);
          if (legacy?.created) projects.put(legacy.created);
          if (legacy) membership.put(legacy.record);
        }
        row.continue();
      };
    };
  }
  async projectData(): Promise<Projects> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['projects', 'projectConversations']);
      const projects = tx.objectStore('projects').getAll();
      const conversations = tx.objectStore('projectConversations').getAll();
      tx.oncomplete = () => resolve({ projects: projects.result, conversations: conversations.result });
      tx.onabort = () => reject(tx.error ?? new Error('项目存储事务中止'));
    });
  }
  async get<T>(store: Store, id: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(id);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async all<T>(store: Store): Promise<T[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async byIndex<T>(store: Store, index: string, key: IDBValidKey): Promise<T[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).index(index).getAll(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async indexKeys(store: Store, index: string, unique = false): Promise<IDBValidKey[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const keys: IDBValidKey[] = [];
      const request = db.transaction(store).objectStore(store).index(index).openKeyCursor(null, unique ? 'nextunique' : 'next');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(keys); return; }
        keys.push(cursor.key);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async update<T, R>(
    store: Store,
    id: string,
    mutate: (current: T | undefined) => { put?: T; result: R },
    blocker?: { store: Store; id: string; message: string },
  ): Promise<R> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(blocker ? [store, blocker.store] : store, 'readwrite');
      const objectStore = tx.objectStore(store);
      let result: R;
      let failure: unknown;
      const read = () => {
        const request = objectStore.get(id);
        request.onsuccess = () => {
          try {
            const change = mutate(request.result);
            result = change.result;
            if (change.put !== undefined) objectStore.put(change.put);
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      };
      if (blocker) {
        const check = tx.objectStore(blocker.store).getKey(blocker.id);
        check.onsuccess = () => {
          if (check.result === undefined) read();
          else {
            failure = new Error(blocker.message);
            tx.abort();
          }
        };
      } else read();
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('存储事务中止'));
    });
  }
  async deleteSideQuestionTree(rootId: string): Promise<DeletedSideQuestionTree> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['sideQuestions', 'sideDeletedConversations', 'projectConversations'], 'readwrite');
      const store = tx.objectStore('sideQuestions');
      const byParent = store.index('parentId');
      const byNative = store.index('nativeUrl');
      const deleted = tx.objectStore('sideDeletedConversations');
      const membership = tx.objectStore('projectConversations');
      const parents = [rootId];
      const reachable = new Set(parents);
      const graph = new Map<string, { threads: SideQuestionThread[]; references: Set<string> }>();
      const threads: SideQuestionThread[] = [];
      let nativeConversationIds: string[] = [];
      let offset = 0;

      const removeUnprotected = (protectedParents: Set<string>) => {
        // A retained conversation can itself keep a shared descendant alive.
        const queue = [...protectedParents];
        for (let i = 0; i < queue.length; i++) {
          for (const child of graph.get(queue[i])!.references) {
            if (child === rootId || !reachable.has(child) || protectedParents.has(child)) continue;
            protectedParents.add(child);
            queue.push(child);
          }
        }

        nativeConversationIds = parents.slice(1).filter(parent => !protectedParents.has(parent));
        for (const parent of [rootId, ...nativeConversationIds]) {
          membership.delete(parent);
          for (const thread of graph.get(parent)!.threads) {
            store.delete(thread.id);
            threads.push(thread);
          }
        }
        for (const child of nativeConversationIds) {
          deleted.put({ id: child, hidden: true } satisfies SideDeletedConversation);
        }
        const existing = deleted.get(rootId);
        existing.onsuccess = () => {
          deleted.put({ id: rootId, hidden: existing.result?.hidden === true } satisfies SideDeletedConversation);
        };
      };

      const findExternalReferences = () => {
        const protectedParents = new Set<string>();
        // Imported history can use different route spellings for the same ID.
        const paths = ['/a/chat/s/', '/chat/s/', '/a/chat/', '/chat/'];
        const checks = parents.slice(1).flatMap(id => paths.flatMap(path => ['', '/'].map(suffix => ({
          id, url: 'https://chat.deepseek.com' + path + id + suffix,
        }))));
        if (!checks.length) { removeUnprotected(protectedParents); return; }
        let remaining = checks.length;
        for (const { id, url } of checks) {
          const owners = byNative.getAll(url);
          owners.onsuccess = () => {
            if (owners.result.some((thread: SideQuestionThread) => !reachable.has(thread.parentId)))
              protectedParents.add(id);
            if (--remaining === 0) removeUnprotected(protectedParents);
          };
        }
      };

      const scan = () => {
        const parent = parents[offset++];
        if (parent === undefined) { findExternalReferences(); return; }
        const request = byParent.getAll(parent);
        request.onsuccess = () => {
          const records = request.result as SideQuestionThread[];
          const references = new Set<string>();
          graph.set(parent, { threads: records, references });
          for (const thread of records) {
            const child = thread.nativeUrl && conversationId(thread.nativeUrl);
            if (!child) continue;
            references.add(child);
            // Only a confirmed native link can extend the deletion subtree.
            if (!reachable.has(child) && thread.turns.some(({ checkpoint }) =>
              checkpoint.phase === 'awaiting' && checkpoint.userMessageId &&
              checkpoint.url && conversationId(checkpoint.url) === child)) {
              reachable.add(child);
              parents.push(child);
            }
          }
          scan();
        };
      };
      scan();
      tx.oncomplete = () => resolve({ threads, nativeConversationIds });
      tx.onabort = () => reject(tx.error ?? new Error('旁问删除事务中止'));
    });
  }
  async batch(operations: { store: Store; put?: unknown; remove?: string; clear?: boolean }[]): Promise<void> {
    if (!operations.length) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([...new Set(operations.map(o => o.store))], 'readwrite');
      for (const op of operations) {
        const store = tx.objectStore(op.store);
        if (op.clear) store.clear();
        if (op.remove !== undefined) store.delete(op.remove);
        if (op.put !== undefined) store.put(op.put);
      }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('存储事务中止'));
    });
  }
  async archive(next: Conversation): Promise<boolean> {
    if (await this.get('blocked', next.id)) return false;
    const old = await this.get<Conversation>('conversations', next.id);
    await this.batch([{ store: 'conversations', put: mergeSnapshot(old, next) }]); return true;
  }
  async removeConversation(id: string): Promise<void> {
    await this.batch([{ store: 'blocked', put: { id } }, { store: 'conversations', remove: id }]);
  }
}
