import { conversationId } from '../shared/model';
import type { SideQuestionThread, SideQuestionTurn } from './model';
import type { SideQuestionStore } from './store';

const ORIGIN = 'https://chat.deepseek.com';
const KEY_PREFIX = 'ds-margin:side-worker:';
const READY_MS = 55_000;
const TURN_MS = 4 * 60_000;

interface WorkerOwner {
  threadId: string;
  turnId: string;
  windowId: number;
  openerTabId: number;
}

export interface SideQuestionWorkerJob {
  threadId: string;
  turnId: string;
  sessionId: string;
  checkpoint: SideQuestionTurn['checkpoint'];
  startedAt: number;
  deadline: number;
  nativeUrl?: string;
  question: string;
  search: boolean;
  quote: string;
  context?: string;
}

function pending(thread: SideQuestionThread | undefined) {
  const turn = thread?.turns.at(-1);
  return turn?.status === 'pending' ? turn : undefined;
}

function tabKey(tabId: number) { return KEY_PREFIX + tabId; }

function isChatSite(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

function chatUrl(value: string | undefined) {
  if (!value || !isChatSite(value) || !conversationId(value)) return undefined;
  return ORIGIN + new URL(value).pathname;
}

function requiredString(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('旁问执行数据无效');
  return value;
}

export class SideQuestionExecution {
  private readonly previews = new Map<string, { turnId: string; text: string }>();
  constructor(private readonly store: SideQuestionStore) {}

  preview(thread: SideQuestionThread): SideQuestionThread {
    const preview = this.previews.get(thread.id);
    return preview && pending(thread)?.id === preview.turnId ? { ...thread, preview } : thread;
  }

  private publishPreview(owner: WorkerOwner, text: string) {
    const { threadId, turnId, openerTabId } = owner;
    this.previews.set(threadId, { turnId, text });
    if (openerTabId !== undefined) void chrome.tabs.sendMessage(openerTabId, {
      source: 'ds-margin', action: 'side.preview', data: { threadId, turnId, text },
    }).catch(() => {});
  }

  private async owner(tabId: number): Promise<WorkerOwner | undefined> {
    return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] as WorkerOwner | undefined;
  }

  async launch(thread: SideQuestionThread, turn: SideQuestionTurn, openerTabId: number): Promise<SideQuestionThread> {
    let tabId: number | undefined;
    let windowId: number | undefined;
    try {
      const destination = thread.nativeUrl ? chatUrl(thread.nativeUrl) : ORIGIN + '/';
      if (!destination) throw new Error('旁问的原站会话地址无效');
      const opener = await chrome.tabs.get(openerTabId);
      const created = await chrome.windows.create({
        url: 'about:blank', type: 'normal', state: 'minimized', focused: false, incognito: opener.incognito,
      });
      windowId = created?.id;
      if (windowId === opener.windowId) windowId = undefined;
      if (windowId === undefined) throw new Error('无法创建旁问后台窗口');
      let background = await chrome.windows.get(windowId, { populate: true });
      // Some Chrome configurations ignore the initial state. Keep the window blank until confirmed.
      if (!background.focused && background.state !== 'minimized') {
        await chrome.windows.update(windowId, { state: 'minimized', focused: false });
        background = await chrome.windows.get(windowId, { populate: true });
      }
      tabId = background.tabs?.[0]?.id;
      if (tabId === undefined || background.tabs?.length !== 1 || background.state !== 'minimized' || background.focused)
        throw new Error('Chrome 未保持旁问窗口最小化，尚未打开 DeepSeek 或发送');
      const owner: WorkerOwner = { threadId: thread.id, turnId: turn.id, windowId, openerTabId };
      await chrome.storage.session.set({ [tabKey(tabId)]: owner });
      const updated = await this.store.checkpoint(thread.id, turn.id, { workerTabId: tabId });
      await chrome.tabs.update(tabId, { url: destination });
      return updated;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '旁问后台窗口启动失败';
      try {
        return await this.store.fail(thread.id, turn.id, reason);
      } finally {
        if (tabId !== undefined) await chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
        if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => {});
      }
    }
  }

  private async release(tabId: number, close: boolean) {
    const owner = close ? await this.owner(tabId) : undefined;
    await chrome.storage.session.remove(tabKey(tabId));
    if (owner?.windowId === undefined) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== owner.windowId) return;
      const window = await chrome.windows.get(owner.windowId);
      if (window.state === 'minimized' && !window.focused) await chrome.tabs.remove(tabId);
    } catch { /* It may already be closed. */ }
  }

  async reconcile(thread: SideQuestionThread): Promise<SideQuestionThread> {
    const turn = pending(thread);
    if (!turn) return thread;
    const { workerTabId, workerSessionId } = turn.checkpoint;
    const elapsed = Date.now() - turn.createdAt;
    const owner = workerTabId === undefined ? undefined : await this.owner(workerTabId);
    const owned = owner?.threadId === thread.id && owner.turnId === turn.id;
    if (owned && elapsed < (workerSessionId ? TURN_MS : READY_MS)) return thread;
    const reason = owned
      ? (workerSessionId ? '旁问等待超时，请检查原站会话后再试' : 'DeepSeek 工作标签页未就绪，请检查登录状态后再试')
      : '旁问标签页已结束，请检查发送状态后再试';
    const updated = await this.store.fail(thread.id, turn.id, reason);
    this.previews.delete(thread.id);
    if (owned && workerTabId !== undefined) await this.release(workerTabId, true);
    return updated;
  }

  async onTabRemoved(tabId: number) {
    const owner = await this.owner(tabId);
    if (!owner) return false;
    const thread = await this.store.get(owner.threadId);
    const turn = pending(thread);
    if (turn?.id === owner.turnId && turn.checkpoint.workerTabId === tabId)
      await this.store.fail(owner.threadId, owner.turnId, '旁问的 DeepSeek 标签页已关闭，请检查发送状态');
    this.previews.delete(owner.threadId);
    await this.release(tabId, false);
    return true;
  }

  async abortAll(reason: string) {
    this.previews.clear();
    for (const thread of await this.store.all()) {
      const turn = pending(thread);
      if (!turn) continue;
      await this.store.fail(thread.id, turn.id, reason);
      const tabId = turn.checkpoint.workerTabId;
      if (tabId !== undefined) {
        const owner = await this.owner(tabId);
        if (owner?.threadId === thread.id && owner.turnId === turn.id) await this.release(tabId, true);
      }
    }
  }

  async deleteParent(parentId: string): Promise<{ removed: number; nativeConversationIds: string[] }> {
    const { threads, nativeConversationIds } = await this.store.deleteParent(parentId);
    const releaseWorkers = threads.map(async thread => {
      this.previews.delete(thread.id);
      const turn = pending(thread);
      const tabId = turn?.checkpoint.workerTabId;
      if (tabId === undefined) return;
      const owner = await this.owner(tabId);
      if (owner?.threadId === thread.id && owner.turnId === turn?.id) await this.release(tabId, true);
    });
    // The committed deletion already revokes access even if a tab or storage session has disappeared.
    await Promise.allSettled(releaseWorkers);
    return { removed: threads.length, nativeConversationIds };
  }

  async handle(action: string, raw: unknown, senderTabId?: number, senderUrl?: string): Promise<unknown> {
    if (senderTabId === undefined || !isChatSite(senderUrl)) {
      if (action === 'side.worker.claim') return null;
      throw new Error('旁问执行来源无效');
    }
    const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const owner = await this.owner(senderTabId);
    if (!owner) return action === 'side.worker.guard' ? false : null;
    const thread = await this.store.get(owner.threadId);
    const turn = pending(thread);
    if (!thread || !turn || turn.id !== owner.turnId || turn.checkpoint.workerTabId !== senderTabId) return null;
    const deadline = turn.createdAt + TURN_MS;
    if (Date.now() >= deadline) {
      await this.reconcile(thread);
      return action === 'side.worker.guard' ? false : null;
    }
    const sessionId = requiredString(data.sessionId, 128);
    if (action === 'side.worker.claim') {
      const updated = await this.store.checkpoint(thread.id, turn.id, { workerSessionId: sessionId });
      return {
        threadId: thread.id, turnId: turn.id, sessionId,
        checkpoint: updated.turns.at(-1)!.checkpoint, startedAt: turn.createdAt, deadline,
        nativeUrl: thread.nativeUrl, question: turn.question, search: turn.search === true,
        quote: thread.anchor.quote, context: thread.anchor.context,
      } satisfies SideQuestionWorkerJob;
    }
    if (data.threadId !== thread.id || data.turnId !== turn.id || sessionId !== turn.checkpoint.workerSessionId)
      return action === 'side.worker.guard' ? false : null;
    switch (action) {
      case 'side.worker.guard': {
        if (data.requireInactive === true) {
          const tab = await chrome.tabs.get(senderTabId);
          const window = await chrome.windows.get(owner.windowId);
          if (tab.windowId !== owner.windowId || window.focused || window.state !== 'minimized') {
            await this.store.fail(thread.id, turn.id, '旁问后台窗口不再处于最小化状态，此次尚未提交', sessionId, true);
            await this.release(senderTabId, false);
            return false;
          }
        }
        return true;
      }
      case 'side.worker.candidate': {
        if (turn.checkpoint.phase !== 'sending' || turn.checkpoint.candidateUrl || thread.nativeUrl) return false;
        const candidateUrl = chatUrl(requiredString(data.url, 2048));
        if (!candidateUrl || conversationId(candidateUrl) === thread.parentId) return false;
        await this.store.checkpoint(thread.id, turn.id, { candidateUrl }, sessionId);
        return true;
      }
      case 'side.worker.progress': {
        if (turn.checkpoint.phase !== 'awaiting' || !turn.checkpoint.userMessageId || !turn.checkpoint.assistantMessageId) return false;
        const text = requiredString(data.text, 24_000);
        this.publishPreview(owner, text);
        return true;
      }
      case 'side.worker.checkpoint': {
        const phase = data.phase;
        if (phase !== 'prepared' && phase !== 'sending' && phase !== 'awaiting')
          throw new Error('旁问阶段无效');
        const before = turn.checkpoint.phase;
        if (!((phase === 'prepared' && before === 'queued') || (phase === 'sending' && before === 'prepared') ||
          (phase === 'awaiting' && (before === 'sending' || before === 'awaiting'))))
          throw new Error('旁问阶段已经变化');
        const patch: Partial<SideQuestionTurn['checkpoint']> = { phase };
        if (phase === 'awaiting') {
          const url = chatUrl(requiredString(data.url, 2048));
          const expectedUrl = thread.nativeUrl ?? turn.checkpoint.url ?? turn.checkpoint.candidateUrl;
          if (!url || (expectedUrl && conversationId(expectedUrl) !== conversationId(url)))
            throw new Error('旁问原站会话发生变化');
          patch.url = url;
          if (data.userMessageId !== undefined) patch.userMessageId = requiredString(data.userMessageId, 256);
          if (data.assistantMessageId !== undefined) patch.assistantMessageId = requiredString(data.assistantMessageId, 256);
        }
        const updated = await this.store.checkpoint(thread.id, turn.id, patch, sessionId, data.verifiedPair === true);
        const checkpoint = updated.turns.at(-1)!.checkpoint;
        if (phase === 'awaiting' && checkpoint.workerSessionId === sessionId &&
            patch.url && patch.url === checkpoint.url &&
            patch.userMessageId && patch.userMessageId === checkpoint.userMessageId &&
            patch.assistantMessageId && patch.assistantMessageId === checkpoint.assistantMessageId &&
            typeof data.preview === 'string' && data.preview.length <= 24_000 && data.preview.trim()) {
          this.publishPreview(owner, data.preview);
        }
        return checkpoint;
      }
      case 'side.worker.complete': {
        if (turn.checkpoint.phase !== 'awaiting' || !turn.checkpoint.url || !turn.checkpoint.userMessageId ||
          !turn.checkpoint.assistantMessageId) throw new Error('无法确认旁问的原站消息');
        const updated = await this.store.complete(thread.id, turn.id, requiredString(data.answer, 120_000), sessionId);
        this.previews.delete(thread.id);
        await this.release(senderTabId, true);
        return updated;
      }
      case 'side.worker.fail': {
        const updated = await this.store.fail(thread.id, turn.id, requiredString(data.error, 500), sessionId);
        this.previews.delete(thread.id);
        await this.release(senderTabId, data.keepTab !== true);
        return updated;
      }
      default: throw new Error('未知旁问执行操作');
    }
  }
}
