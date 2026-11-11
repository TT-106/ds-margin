// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://chat.deepseek.com/a/chat/s/fixture-session"}
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/background/database';
import { SideQuestionExecution } from '../src/sidequestions/execution';
import { readSideQuestionTurnId, sideQuestionMarker } from '../src/sidequestions/marker';
import type { NativeAnswer } from '../src/sidequestions/native-answer';
import { SideQuestionStore } from '../src/sidequestions/store';
import { SideQuestionWeb, type SideQuestionControl, type SideQuestionRequest } from '../src/sidequestions/web';

const turnId = 'a58f08db-beec-4397-8263-b4e12cb8c8d7';
const url = 'https://chat.deepseek.com/a/chat/s/fixture-session';
const marker = sideQuestionMarker(turnId);

function fixture() {
  const web = new SideQuestionWeb();
  vi.spyOn(web.adapter, 'composer').mockReturnValue(document.createElement('textarea'));
  vi.spyOn(web.controls, 'generation').mockReturnValue('idle');
  vi.spyOn(web.controls, 'activity').mockReturnValue(false);
  const prompt = '什么是测地线？\n\n' + marker;
  const request: SideQuestionRequest = {
    turnId, prompt, search: false, deadline: Date.now() + 100,
    checkpoint: {
      phase: 'awaiting', url, startedAt: Date.now(),
      userMessageId: '-2', assistantMessageId: '-3',
    },
  };
  const control: SideQuestionControl = {
    signal: new AbortController().signal,
    guard: async () => {},
    checkpoint: vi.fn(async fields => ({ ...request.checkpoint, ...fields })),
    progress: vi.fn(),
  };
  return { web, request, control };
}

describe('网页旁问结果归属', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it.each(['旁问编号', '任务编号'])('刷新后按同一原生地址的唯一 %s 恢复旧临时键对应的回答', async label => {
    document.body.innerHTML = `<div data-virtual-list-item-key="4">
      <div class="ds-message"><div><div class="ds-collapsible-text">
        <div>什么是测地线？</div><div>[DS Margin ${label}: </div><span>${turnId};</span>用于识别本次旁问，请勿复述。]
      </div></div></div>
    </div><div data-virtual-list-item-key="5"><div class="ds-think-content">不采集思考</div>
      <div class="ds-assistant-message-main-content"><p>曲面上的局部直线。</p></div>
    </div>`;
    const { web, request, control } = fixture();
    expect(readSideQuestionTurnId(web.adapter.messages()[0].message.text)).toBe(turnId);
    expect(await web.awaitDone(request, control, 0)).toMatchObject({
      text: '曲面上的局部直线。', userMessageId: '4', assistantMessageId: '5',
    });
    expect(control.checkpoint).toHaveBeenCalledWith({
      phase: 'awaiting', url, userMessageId: '4', assistantMessageId: '5', verifiedPair: true,
    }, '曲面上的局部直线。');
    expect(control.progress).not.toHaveBeenCalled();
  });

  it('未看到本次用户编号时不从之后的数字键猜测另一条回答', async () => {
    document.body.innerHTML = `<div data-virtual-list-item-key="9">
      <div class="ds-assistant-message-main-content">不属于本次请求的回答 ${marker}</div>
    </div>`;
    const { web, request, control } = fixture();
    request.checkpoint.userMessageId = '4';
    request.checkpoint.assistantMessageId = undefined;
    await expect(web.awaitDone(request, control, 0)).rejects.toThrow(/超时/);
    expect(control.checkpoint).not.toHaveBeenCalled();
    expect(control.progress).not.toHaveBeenCalled();
  });

  it('原站流首段随绑定送出，后续增量保留原始 Markdown 并单独推送', async () => {
    const { web, request, control } = fixture();
    request.deadline = Date.now() + 1000;
    request.checkpoint = { phase: 'sending', startedAt: Date.now() };
    const first = '### 原站标题\n\n> 引用';
    const complete = first + '\n\n1. **要点**';
    const pair = { url, userMessageId: '4', assistantMessageId: '5' };
    const nativeAnswer: NativeAnswer = new EventTarget();
    nativeAnswer.current = { ...pair, text: first, done: false };
    control.nativeAnswer = nativeAnswer;
    vi.mocked(control.checkpoint).mockImplementationOnce(async fields => {
      queueMicrotask(() => {
        nativeAnswer.current = { ...pair, text: complete, done: true };
        nativeAnswer.dispatchEvent(new Event('change'));
      });
      return { ...request.checkpoint, ...fields };
    });

    expect(await web.awaitDone(request, control, 0)).toMatchObject({ ...pair, text: complete });
    expect(control.checkpoint).toHaveBeenCalledExactlyOnceWith({ phase: 'awaiting', ...pair, verifiedPair: true }, first);
    expect(control.progress).toHaveBeenCalledExactlyOnceWith(complete);
  });

  it('流式预览和保存的回答都保留原生行内与独立公式的界限', async () => {
    document.body.innerHTML = String.raw`<div data-virtual-list-item-key="-2">
      <div class="ds-message d29f3d7d"><div class="fbb737a4">${marker}</div></div>
    </div><div data-virtual-list-item-key="-3"><div class="ds-assistant-message-main-content">
      <p>当 <span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span> 成立</p>
      <span class="katex-display"><span class="katex">
        <annotation encoding="application/x-tex">\frac{1}{2}</annotation>
      </span></span>
    </div></div>`;
    const { web, request, control } = fixture();
    const expected = String.raw`当 \(x^2\) 成立

\[\frac{1}{2}\]`;
    expect((await web.awaitDone(request, control, 0)).text).toBe(expected);
    expect(control.checkpoint).toHaveBeenCalledWith({
      phase: 'awaiting', url, userMessageId: '-2', assistantMessageId: '-3',
    }, expected);
    expect(control.progress).not.toHaveBeenCalled();
    expect(web.adapter.messages().at(-1)?.message.text).not.toContain(String.raw`\(`);
  });
});

it('后台只在有效执行页绑定成功后推送首段，拒绝错配、旧执行和删除后的首段', async () => {
  const store = new SideQuestionStore(new Database(`side-preview-${crypto.randomUUID()}`));
  const threadId = 'side-thread';
  const parentId = 'parent-chat';
  const tabId = 15;
  const sessionId = 'session-a';
  const scope = { threadId, turnId, sessionId };
  const owner = { threadId, turnId, windowId: 8, openerTabId: 5 };
  await store.begin({
    id: threadId, requestId: turnId, parentId, parentUrl: 'https://chat.deepseek.com/a/chat/s/parent-chat',
    parentTitle: '测地线', question: '什么是测地线？',
    anchor: { messageId: '1', fingerprint: 'f1', quote: '测地线', start: 0, end: 3 },
  });
  await store.checkpoint(threadId, turnId, { phase: 'prepared', workerTabId: tabId, workerSessionId: sessionId });
  await store.checkpoint(threadId, turnId, { phase: 'sending', candidateUrl: url }, sessionId);

  let committed: ReturnType<typeof store.get> | undefined;
  const sendMessage = vi.fn(async () => { committed = store.get(threadId); });
  vi.stubGlobal('chrome', {
    storage: { session: { get: async (key: string) => ({ [key]: owner }) } },
    tabs: { sendMessage },
  });
  try {
    const execution = new SideQuestionExecution(store);
    const binding = { phase: 'awaiting', url, userMessageId: '4', assistantMessageId: '5', preview: '首段正文' };
    const handle = (data: unknown) => execution.handle('side.worker.checkpoint', data, tabId, url);
    await expect(handle({ ...scope, ...binding, url: url + '-other' })).rejects.toThrow('原站会话发生变化');
    expect(sendMessage).not.toHaveBeenCalled();

    const write = store.checkpoint.bind(store);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const checkpoint = vi.spyOn(store, 'checkpoint').mockImplementationOnce(async (...args) => {
      await held;
      return write(...args);
    });
    const pending = handle({ ...scope, ...binding });
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledTimes(1));
    expect(sendMessage).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toMatchObject({ userMessageId: '4', assistantMessageId: '5' });
    await expect(committed).resolves.toMatchObject({ turns: [{ checkpoint: {
      phase: 'awaiting', url, userMessageId: '4', assistantMessageId: '5',
    } }] });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(5, {
      source: 'ds-margin', action: 'side.preview', data: { threadId, turnId, text: '首段正文' },
    });
    sendMessage.mockClear();

    await expect(handle({ ...scope, ...binding, assistantMessageId: '7' })).rejects.toThrow('不同原生消息');
    await store.checkpoint(threadId, turnId, { workerSessionId: 'session-b' }, sessionId);
    await expect(handle({ ...scope, ...binding, preview: '旧执行页' })).resolves.toBeNull();
    await store.deleteParent(parentId);
    await expect(handle({ ...scope, ...binding, sessionId: 'session-b', preview: '删除后' })).resolves.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
