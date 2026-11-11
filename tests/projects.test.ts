import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/background/database';
import { ProjectStore, withProjectMetadata } from '../src/background/projects';
import { DEFAULT_SETTINGS, type Backup, type Conversation } from '../src/shared/model';
import { readBackup } from '../src/shared/validation';

function snapshot(id: string, folder = '', pinned = false): Conversation {
  return {
    id, url: `https://chat.deepseek.com/a/chat/s/${id}`, title: '同名会话', messages: [],
    capturedAt: 100, scope: 'observed', folder, pinned, tags: ['保留的标签'],
  };
}

function oldBackup(conversations: Conversation[]): Backup {
  return {
    format: 'ds-margin', version: 3, exportedAt: 101, settings: DEFAULT_SETTINGS, conversations,
    bookmarks: [], prompts: [], drafts: [], blocked: [], sideQuestions: [],
  };
}

async function seedVersionFour(name: string, ...snapshots: Conversation[]) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 4);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('conversations', { keyPath: 'id' });
      snapshots.forEach(row => store.put(row));
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

describe('workspace project data', () => {
  it('migrates legacy folders by name and preserves independent same-title rows and tags', async () => {
    const name = `projects-${crypto.randomUUID()}`;
    const first = snapshot('test-project-a', '  科研 ', true);
    const second = snapshot('test-project-b', '科研');
    const pinnedOnly = snapshot('test-project-c', '', true);
    await seedVersionFour(name, first, second, pinnedOnly);
    const db = new Database(name);
    const workspace = await db.projectData();
    expect(workspace.projects.map(project => project.name)).toEqual(['科研']);
    expect(workspace.conversations.map(row => [row.id, row.projectId, row.pinned])).toEqual([
      [first.id, workspace.projects[0].id, true], [second.id, workspace.projects[0].id, false], [pinnedOnly.id, null, true],
    ]);
    const book = withProjectMetadata(await db.all<Conversation>('conversations'), workspace);
    expect(book[0]).toMatchObject({ id: first.id, folder: '科研', pinned: true, tags: first.tags });
    expect(await new Database(name).projectData()).toEqual(workspace);
  });

  it('retains the same project record through pinning, renaming, deleting a snapshot and deleting a project', async () => {
    const db = new Database(`projects-${crypto.randomUUID()}`);
    const store = new ProjectStore(db);
    const project = await store.create('开发');
    const row = snapshot('test-project-new');
    const assigned = await store.assign(row, project.id, true);
    expect(await db.get('conversations', row.id)).toBeUndefined();
    const otherProject = await store.create('写作');
    expect(await store.assign(row, otherProject.id, true)).toEqual(assigned);
    await store.pin(row, true);
    await db.archive(row);
    await store.rename(project.id, '扩展开发');
    const book = withProjectMetadata(await db.all<Conversation>('conversations'), await store.all());
    expect(book[0]).toMatchObject({ folder: '扩展开发', pinned: true });
    await db.removeConversation(row.id);
    expect((await store.all()).conversations[0]).toMatchObject({ projectId: project.id, pinned: true });
    await store.remove(project.id);
    expect((await store.all()).conversations[0]).toMatchObject({ projectId: null, pinned: true });
  });

  it('merges v3/v4 backups without reviving locally removed membership or a deleted native link', async () => {
    const db = new Database(`projects-${crypto.randomUUID()}`);
    const store = new ProjectStore(db);
    const legacy = snapshot('test-project-imported', '科研', true);
    const backup = oldBackup([legacy]);
    await db.batch(await store.importOperations(readBackup(backup)));
    const workspace = await store.all();
    const portable = { ...backup, version: 4, projects: workspace.projects, projectConversations: workspace.conversations };
    await store.assign(legacy, null, false);
    expect(await store.importOperations(readBackup(backup))).toEqual([]);
    expect(await store.importOperations(readBackup(portable))).toEqual([]);
    await db.deleteSideQuestionTree(legacy.id);
    expect((await store.all()).conversations).toEqual([]);
    expect(await store.importOperations(readBackup(portable))).toEqual([]);
    await expect(store.assign(legacy, workspace.projects[0].id, true)).rejects.toThrow('原站会话已被删除');
  });

  it('validates v4 projects and matches existing projects of the same name on import', async () => {
    const store = new ProjectStore(new Database(`projects-${crypto.randomUUID()}`));
    const local = await store.create('研究');
    const row = { ...snapshot('test-project-portable'), projectId: 'portable-project', joinedAt: 7 };
    const raw = { ...oldBackup([]), version: 4, projects: [{ id: row.projectId, name: '研究', createdAt: 1 }], projectConversations: [row] };
    const portable = readBackup(raw);
    expect(portable.projectConversations?.[0]).not.toHaveProperty('messages');
    expect(await store.importOperations(portable)).toEqual([{
      store: 'projectConversations', put: { ...portable.projectConversations?.[0], projectId: local.id },
    }]);
    expect(() => readBackup({ ...raw, projects: [] })).toThrow('会话归属无效');
    expect(() => readBackup({ ...raw, projectConversations: [{ ...row, url: 'https://example.com/' }] })).toThrow('DeepSeek');
  });
});
