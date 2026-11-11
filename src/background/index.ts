import { BUILTIN_PROMPTS, LIBRARY_EPOCH_KEY, PROMPTS_EPOCH_KEY, conversationId, normalizeSettings, searchLibrary, type Backup, type Bookmark, type Conversation, type Draft, type PromptTemplate } from '../shared/model';
import { PROJECTS_EPOCH_KEY } from '../shared/projects';
import { readBackup, readBookmark, readConversation, readConversationLink, readDraft, readId, readProjectName, readPrompt } from '../shared/validation';
import { Database, STORES } from './database';
import { ProjectStore, withProjectMetadata } from './projects';
import { SideQuestionStore } from '../sidequestions/store';
import { SideQuestionExecution } from '../sidequestions/execution';
import type { SideQuestionThread } from '../sidequestions/model';
const db = new Database();
const projects = new ProjectStore(db);
const sideQuestions = new SideQuestionStore(db);
const sideExecution = new SideQuestionExecution(sideQuestions);
const SETTINGS_KEY = 'ds-margin:settings';
async function settings() { return normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]); }
async function sideChanged(referencesChanged = false) {
  const epoch = crypto.randomUUID();
  await chrome.storage.local.set({ 'ds-margin:sideEpoch': epoch,
    ...(referencesChanged ? { 'ds-margin:sideReferenceEpoch': epoch } : {}) }).catch(() => {});
}
async function projectsChanged() {
  await chrome.storage.local.set({ [PROJECTS_EPOCH_KEY]: crypto.randomUUID() }).catch(() => {});
}
function portableSideQuestion(thread: SideQuestionThread): SideQuestionThread {
  return { ...thread, turns: thread.turns.map(turn => {
    const { workerTabId, workerSessionId, ...checkpoint } = turn.checkpoint;
    if (turn.status !== 'pending') return { ...turn, checkpoint };
    const uncertain = checkpoint.phase === 'sending' || checkpoint.phase === 'awaiting';
    return { ...turn, checkpoint, status: uncertain ? 'attention' : 'failed',
      error: uncertain ? '备份时发送状态尚未确认，请打开原生旁问核对' : '备份时这条旁问尚未发出，可手动重新提问' };
  }) };
}
async function promptTemplates() {
  const prompts = await db.all<PromptTemplate>('prompts');
  const merged = new Map(BUILTIN_PROMPTS.map(prompt => [prompt.id, prompt]));
  for (const prompt of prompts) merged.set(prompt.id, prompt);
  return [...merged.values()];
}
async function library() {
  const [snapshots, bookmarks, prompts, blocked, workspace] = await Promise.all([
    db.all<Conversation>('conversations'), db.all<Bookmark>('bookmarks'), promptTemplates(), db.all<{ id: string }>('blocked'),
    projects.all(),
  ]);
  const conversations = withProjectMetadata(snapshots, workspace);
  return { conversations: conversations.sort((a,b) => Number(b.pinned) - Number(a.pinned) || b.capturedAt - a.capturedAt), bookmarks: bookmarks.sort((a,b) => b.createdAt-a.createdAt), prompts, blocked };
}
async function execute(action: string, raw: unknown,tabId?:number, senderUrl?: string): Promise<unknown> {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (action.startsWith('side.worker.')) {
    const result = await sideExecution.handle(action, raw, tabId, senderUrl);
    // A null result can follow timeout reconciliation, so use the committed result, not the requested phase.
    const quietCheckpoint = action === 'side.worker.checkpoint' && result !== null && typeof result === 'object' &&
      'phase' in result && (result.phase === 'prepared' || result.phase === 'sending');
    if ((action === 'side.worker.checkpoint' && !quietCheckpoint) ||
        action === 'side.worker.complete' || action === 'side.worker.fail') await sideChanged();
    return result;
  }
  switch (action) {
    case 'side.summary': return sideQuestions.counts();
    case 'side.parent.deleted': {
      if (tabId === undefined || !senderUrl?.startsWith('https://chat.deepseek.com/')) throw new Error('会话删除来源无效');
      const parentId = readId(data.parentId);
      if (conversationId('https://chat.deepseek.com/a/chat/s/' + parentId) !== parentId)
        throw new Error('原生会话 ID 无效');
      const deleted = await sideExecution.deleteParent(parentId);
      await Promise.all([sideChanged(deleted.removed > 0), projectsChanged()]);
      return deleted;
    }
    case 'side.recover': {
      if (tabId === undefined || !senderUrl?.startsWith('https://chat.deepseek.com/') || !(await settings()).enabled) return false;
      const recovered = await sideQuestions.recover(raw);
      if (recovered) await sideChanged();
      return recovered;
    }
    case 'side.references': return (await sideQuestions.list(data.parentId))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(({ id, anchor: { messageId, fingerprint, quote, start, end } }) => ({ id, anchor: { messageId, fingerprint, quote, start, end } }));
    case 'side.list': return Promise.all((await sideQuestions.list(data.parentId)).map(thread => sideExecution.reconcile(thread)));
    case 'side.get': {
      const thread = await sideQuestions.get(data.id);
      return thread ? sideExecution.preview(await sideExecution.reconcile(thread)) : null;
    }
    case 'side.begin':
    case 'side.quick.begin': throw new Error('这个 DeepSeek 页面还在使用旧版旁问，请刷新页面后再试');
    case 'side.window.begin': {
      // The frame sender URL can predate DeepSeek's in-document history navigation.
      // The isolated content script checks the current route, and the store verifies the parent URL/ID pair.
      if (tabId === undefined || !senderUrl?.startsWith('https://chat.deepseek.com/')) throw new Error('请在 DeepSeek 主会话内发送旁问');
      const parentId = readId(data.parentId);
      if (!(await settings()).enabled) throw new Error('DS Margin 已关闭');
      if (data.id !== undefined) {
        const previous = await sideQuestions.get(data.id);
        if (previous?.parentId === parentId) await sideExecution.reconcile(previous);
      }
      const { thread, turn, created } = await sideQuestions.begin(raw);
      if (!created) return thread;
      const launched = await sideExecution.launch(thread, turn, tabId);
      await sideChanged(thread.turns.length === 1);
      return launched;
    }
    case 'settings': return settings();
    case 'settings.bootstrap': {
      const value = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
      const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      if (typeof raw.reduceMotion === 'boolean') return normalizeSettings(raw);
      const initial = normalizeSettings({ ...raw, reduceMotion: data.reduced === true });
      await chrome.storage.local.set({ [SETTINGS_KEY]: initial });
      return initial;
    }
    case 'settings.save': {
      const s = normalizeSettings(raw);
      if (!s.enabled) {
        await sideExecution.abortAll('DS Margin 已关闭');
        await sideChanged();
      }
      await chrome.storage.local.set({ [SETTINGS_KEY]: s });
      return s;
    }
    case 'settings.motion': {const rawSettings=(await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];const original=rawSettings&&typeof rawSettings==='object'?rawSettings as Record<string,unknown>:{};if(typeof original.reduceMotion!=='boolean')await chrome.storage.local.set({[SETTINGS_KEY]:normalizeSettings({...original,reduceMotion:data.reduced===true})});return true;}
    case 'projects': {
      const [workspace, deleted] = await Promise.all([projects.all(), db.all<{ id: string }>('sideDeletedConversations')]);
      return { ...workspace, deletedIds: deleted.map(row => row.id) };
    }
    case 'project.create': {
      const project = await projects.create(readProjectName(data.name));
      await projectsChanged();
      return project;
    }
    case 'project.rename': {
      const project = await projects.rename(readId(data.id), readProjectName(data.name));
      await projectsChanged();
      return project;
    }
    case 'project.delete': {
      if (await projects.remove(readId(data.id))) await projectsChanged();
      return true;
    }
    case 'project.assign':
    case 'project.pin': {
      const link = readConversationLink(raw);
      if ((await sideQuestions.counts()).nativeConversationIds.includes(link.id)) throw new Error('旁问由主会话管理');
      const row = action === 'project.assign'
        ? await projects.assign(link, data.projectId === null ? null : readId(data.projectId), data.onlyUnassigned === true)
        : await projects.pin(link, data.pinned === true);
      await projectsChanged();
      return row;
    }
    case 'project.observe': {
      if (!Array.isArray(data.conversations) || data.conversations.length > 5000) throw new Error('会话列表无效');
      const changed = await projects.observe(data.conversations.map(readConversationLink));
      if (changed) await projectsChanged();
      return changed;
    }
    case 'library': return library();
    case 'prompts.list': return promptTemplates();
    case 'archive': { if (!(await settings()).autoArchive || !(await settings()).enabled) return false; return db.archive(readConversation(raw)); }
    case 'resume': await db.batch([{ store: 'blocked', remove: readId(data.id) }]); return true;
    case 'conversation.delete': await db.removeConversation(readId(data.id)); return true;
    case 'conversation.meta': {
      const c = await db.get<Conversation>('conversations', readId(data.id)); if (!c) throw new Error('本地对话不存在');
      const parsed = readConversation({ ...c, pinned: data.pinned, folder: data.folder, tags: data.tags });
      const projectId = data.projectId === undefined || data.projectId === null ? data.projectId : readId(data.projectId);
      await projects.editSnapshot(parsed, projectId);
      await projectsChanged();
      return true;
    }
    case 'search': {
      if (typeof data.query !== 'string' || data.query.length > 200) throw new Error('搜索词过长');
      return searchLibrary((await library()).conversations, data.query);
    }
    case 'bookmark.save': await db.batch([{ store: 'bookmarks', put: readBookmark(raw) }]); return true;
    case 'bookmark.delete': await db.batch([{ store: 'bookmarks', remove: readId(data.id) }]); return true;
    case 'prompt.save':
    case 'prompt.delete': {
      if (action === 'prompt.save') await db.batch([{ store: 'prompts', put: readPrompt(raw) }]);
      else {
        const id = readId(data.id);
        if (id.startsWith('builtin-')) throw new Error('内置模板可复制修改，自定义模板可删除');
        await db.batch([{ store: 'prompts', remove: id }]);
      }
      await chrome.storage.local.set({ [PROMPTS_EPOCH_KEY]: crypto.randomUUID() }).catch(() => {});
      return true;
    }
    case 'draft.get': return await db.get<Draft>('drafts', readId(data.id)) ?? null;
    case 'draft.save': {
      if (!(await settings()).saveDrafts || !(await settings()).enabled) return { saved: false, disabled: true };
      const draft = readDraft(raw), old = await db.get<Draft>('drafts', draft.id);
      const expected = typeof data.expectedAt === 'number' ? data.expectedAt : 0;
      if (old && old.updatedAt !== expected && old.text !== draft.text) return { saved: false, conflict: old };
      draft.updatedAt = Math.max(Date.now(), (old?.updatedAt ?? 0) + 1);
      await db.batch([{ store: 'drafts', put: draft }]); return { saved: true, draft };
    }
    case 'draft.delete': {
      const id=readId(data.id),old=await db.get<Draft>('drafts',id);
      if (typeof data.expectedAt==='number' && old?.updatedAt!==data.expectedAt) return false;
      await db.batch([{ store: 'drafts', remove: id }]); return true;
    }
    case 'backup': {
      const [snapshots, bookmarks, prompts, drafts, blocked, s, threads, workspace] = await Promise.all([
        db.all<Conversation>('conversations'), db.all<Bookmark>('bookmarks'), db.all<PromptTemplate>('prompts'),
        db.all<Draft>('drafts'), db.all<{ id: string }>('blocked'), settings(), sideQuestions.all(), projects.all(),
      ]);
      return {
        format: 'ds-margin', version: 4, exportedAt: Date.now(), settings: s,
        conversations: withProjectMetadata(snapshots, workspace), bookmarks, prompts, drafts, blocked,
        sideQuestions: threads.map(portableSideQuestion), projects: workspace.projects, projectConversations: workspace.conversations,
      } satisfies Backup;
    }
    case 'import': {
      const backup = readBackup(raw);
      // Merge, never delete existing records. Newer local snapshots/drafts win.
      const ops: Parameters<Database['batch']>[0] = [];
      for (const c of backup.conversations) {
        const old = await db.get<Conversation>('conversations', c.id);
        if (!old || old.capturedAt < c.capturedAt) ops.push({ store: 'conversations', put: c });
      }
      for (const store of ['bookmarks','prompts','blocked'] as const) for (const record of backup[store]) if (!await db.get(store, record.id)) ops.push({ store, put: record });
      for (const draft of backup.drafts) {
        const old = await db.get<Draft>('drafts', draft.id);
        if (!old || old.updatedAt < draft.updatedAt) ops.push({ store: 'drafts', put: draft });
      }
      for (const thread of backup.sideQuestions ?? []) {
        if (!await sideQuestions.isParentDeleted(thread.parentId) && !await sideQuestions.get(thread.id))
          ops.push({ store: 'sideQuestions', put: portableSideQuestion(thread) });
      }
      const projectOps = await projects.importOperations(backup);
      await db.batch([...ops, ...projectOps]);
      if (ops.some(op => op.store === 'sideQuestions')) await sideChanged(true);
      const changes: Record<string, string> = {};
      if (projectOps.length) changes[PROJECTS_EPOCH_KEY] = crypto.randomUUID();
      if (ops.some(op => op.store === 'conversations' || op.store === 'bookmarks' || op.store === 'blocked'))
        changes[LIBRARY_EPOCH_KEY] = crypto.randomUUID();
      if (ops.some(op => op.store === 'prompts')) changes[PROMPTS_EPOCH_KEY] = crypto.randomUUID();
      if (Object.keys(changes).length) await chrome.storage.local.set(changes).catch(() => {});
      return { imported: ops.length + projectOps.length };
    }
    case 'clear': {
      await sideExecution.abortAll('本地数据已清空');
      const existing = await db.all<Conversation>('conversations');
      const blocked=await db.all<{id:string}>('blocked');
      const ids = new Set([...existing.map(c => c.id),...blocked.map(b=>b.id)]); if (data.currentId) ids.add(readId(data.currentId));
      await db.batch([...STORES.map(store => ({ store, clear: true })), ...[...ids].map(id => ({ store: 'blocked' as const, put: { id } }))]);
      await chrome.storage.local.set({'ds-margin:dataEpoch':Date.now(), [PROJECTS_EPOCH_KEY]:crypto.randomUUID()});
      return true;
    }
    default: throw new Error('未知操作');
  }
}
// Serialize read-modify-write operations across tabs; a suspended worker keeps no
// authoritative state in memory. IndexedDB transactions own persisted records.
let queue: Promise<unknown> = Promise.resolve();
chrome.tabs.onRemoved.addListener(tabId => {
  queue = queue.catch(() => {}).then(async () => {
    if (await sideExecution.onTabRemoved(tabId)) await sideChanged();
  });
  void queue.catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.source !== 'ds-margin') return;
  const trusted = sender.id === chrome.runtime.id && (!sender.url || sender.url.startsWith(chrome.runtime.getURL('')) || sender.url.startsWith('https://chat.deepseek.com/'));
  if (!trusted) { respond({ ok: false, error: '来源不受支持' }); return; }
  if (typeof message.action !== 'string' || JSON.stringify(message.data ?? null).length > 30_000_000) { respond({ ok: false, error: '数据超过限制' }); return; }
  queue = queue.catch(() => {}).then(() => execute(message.action, message.data,sender.tab?.id,sender.url));
  queue.then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error instanceof Error ? error.message : '本地存储操作失败' }));
  return true;
});
