import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/background/database';
import { SideQuestionStore } from '../src/sidequestions/store';
import type { SideQuestionThread } from '../src/sidequestions/model';

const threadId = 'notification-thread';
const turnId = 'notification-turn';
const tabId = 15;
const sessionId = 'notification-session';
const parentUrl = 'https://chat.deepseek.com/a/chat/s/parent-chat';
const nativeUrl = 'https://chat.deepseek.com/a/chat/s/native-side-chat';
const epochKey = 'ds-margin:sideEpoch';
const scope = { threadId, turnId, sessionId };

type Response = { ok: boolean; value?: unknown; error?: string };
type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (response: Response) => void) => boolean | undefined;

async function background() {
  const store = new SideQuestionStore(new Database());
  await store.begin({
    id: threadId, requestId: turnId, parentId: 'parent-chat', parentUrl, parentTitle: '测地线',
    question: '它是什么意思？', anchor: { messageId: '1', fingerprint: 'f1', quote: '测地线', start: 0, end: 3 },
  });
  await store.checkpoint(threadId, turnId, { workerTabId: tabId, workerSessionId: sessionId });

  const ownerKey = `ds-margin:side-worker:${tabId}`;
  const session: Record<string, unknown> = {
    [ownerKey]: { threadId, turnId, windowId: 8, openerTabId: 5 },
  };
  const notifications: { values: Record<string, unknown>; thread: SideQuestionThread | undefined }[] = [];
  const local: Record<string, unknown> = {};
  const removeTab = vi.fn(async () => {});
  let listener: Listener | undefined;
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'notification-test-extension',
      getURL: (path: string) => 'chrome-extension://notification-test-extension/' + path,
      onMessage: { addListener: (receive: Listener) => { listener = receive; } },
    },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        remove: async (key: string) => { delete session[key]; },
      },
      local: {
        get: async (key: string) => ({ [key]: local[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(local, values);
          notifications.push({ values, thread: await store.get(threadId) });
        },
      },
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      get: async () => ({ id: tabId, windowId: 8 }),
      remove: removeTab,
      sendMessage: vi.fn(async () => {}),
    },
    windows: { get: async () => ({ id: 8, state: 'minimized', focused: false }) },
  });
  const reload = async () => {
    vi.resetModules();
    listener = undefined;
    await import('../src/background/index');
  };
  await reload();

  const request = (action: string, fields: Record<string, unknown> = {}) => new Promise<Response>((resolve, reject) => {
    if (!listener) return reject(new Error('后台未注册消息入口'));
    const listening = listener({ source: 'ds-margin', action, data: { ...scope, ...fields } }, {
      id: 'notification-test-extension', url: nativeUrl, tab: { id: tabId } as chrome.tabs.Tab,
    }, resolve);
    if (listening !== true) reject(new Error('后台未保持异步响应'));
  });
  return { store, notifications, removeTab, request, reload };
}

describe('旁问后台检查点通知', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('准备和发送检查点仍落库，首次绑定、编号换绑和完成才广播已提交的状态', async () => {
    const { store, notifications, removeTab, request } = await background();
    for (const phase of ['prepared', 'sending']) {
      expect(await request('side.worker.checkpoint', { phase })).toMatchObject({ ok: true, value: { phase } });
      expect((await store.get(threadId))?.turns[0].checkpoint).toMatchObject({ phase, workerTabId: tabId, workerSessionId: sessionId });
      expect(notifications).toHaveLength(0);
    }

    const binding = { phase: 'awaiting', url: nativeUrl, userMessageId: '-2', assistantMessageId: '-3' };
    expect(await request('side.worker.checkpoint', binding)).toMatchObject({ ok: true, value: binding });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].values[epochKey]).toEqual(expect.any(String));
    expect(notifications[0].thread).toMatchObject({ nativeUrl, turns: [{ checkpoint: binding }] });

    const rebound = { ...binding, userMessageId: '4', assistantMessageId: '5' };
    expect(await request('side.worker.checkpoint', { ...rebound, verifiedPair: true })).toMatchObject({ ok: true, value: rebound });
    expect(notifications).toHaveLength(2);
    expect(notifications[1].thread?.turns[0].checkpoint).toMatchObject(rebound);

    expect(await request('side.worker.complete', { answer: '曲面上局部最短的路径。' })).toMatchObject({ ok: true });
    expect(notifications).toHaveLength(3);
    expect(notifications[2].thread?.turns[0]).toMatchObject({ status: 'complete', answer: '曲面上局部最短的路径。' });
    expect(notifications[2].thread?.turns[0].checkpoint.workerSessionId).toBeUndefined();
    expect(removeTab).toHaveBeenCalledExactlyOnceWith(tabId);
  });

  it('发送后的失败继续广播需要人工核对的状态', async () => {
    const { notifications, request } = await background();
    await request('side.worker.checkpoint', { phase: 'prepared' });
    await request('side.worker.checkpoint', { phase: 'sending' });
    expect(await request('side.worker.fail', { error: '执行页断开', keepTab: true })).toMatchObject({ ok: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].values[epochKey]).toEqual(expect.any(String));
    expect(notifications[0].thread?.turns[0]).toMatchObject({ status: 'attention', error: '执行页断开' });
  });

  it.each(['prepared', 'sending'])('静默的 %s 检查点可由重建后的后台与新执行会话恢复', async phase => {
    const { notifications, request, reload } = await background();
    await request('side.worker.checkpoint', { phase: 'prepared' });
    if (phase === 'sending') await request('side.worker.checkpoint', { phase: 'sending' });
    expect(notifications).toHaveLength(0);

    await reload();
    const renewedSession = sessionId + '-reload';
    expect(await request('side.worker.claim', { sessionId: renewedSession })).toMatchObject({
      ok: true,
      value: { threadId, turnId, sessionId: renewedSession, checkpoint: {
        phase, workerTabId: tabId, workerSessionId: renewedSession,
      } },
    });
    const restored = await new SideQuestionStore(new Database()).get(threadId);
    expect(restored?.turns[0]).toMatchObject({ status: 'pending', checkpoint: {
      phase, workerTabId: tabId, workerSessionId: renewedSession,
    } });
    expect(notifications).toHaveLength(0);
  });

  it.each([
    { savedPhase: 'queued', requestPhase: 'prepared', status: 'failed' },
    { savedPhase: 'prepared', requestPhase: 'sending', status: 'failed' },
    { savedPhase: 'sending', requestPhase: 'sending', status: 'attention' },
  ])('$savedPhase 过期后的 $requestPhase 请求返回 null，仍广播 $status 状态', async ({ savedPhase, requestPhase, status }) => {
    const { store, notifications, request } = await background();
    if (savedPhase !== 'queued') await request('side.worker.checkpoint', { phase: 'prepared' });
    if (savedPhase === 'sending') await request('side.worker.checkpoint', { phase: 'sending' });
    expect(notifications).toHaveLength(0);
    const createdAt = (await store.get(threadId))!.turns[0].createdAt;
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + 4 * 60_000 + 1);

    expect(await request('side.worker.checkpoint', { phase: requestPhase })).toEqual({ ok: true, value: null });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].values[epochKey]).toEqual(expect.any(String));
    expect(notifications[0].thread?.turns[0]).toMatchObject({ status, error: '旁问等待超时，请检查原站会话后再试' });
    expect((await store.get(threadId))?.turns[0].checkpoint.workerSessionId).toBeUndefined();
  });
});
