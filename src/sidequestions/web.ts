import { domToMarkdown, SiteAdapter, type MessageNode, type NativeControls } from '../content/adapter';
import { conversationId } from '../shared/model';
import { hasSideQuestionMarker } from './marker';
import type { SideQuestionCheckpoint, SideQuestionPhase } from './model';
import type { NativeAnswer, SideQuestionAnswer } from './native-answer';

type WebCheckpoint = Pick<SideQuestionCheckpoint, 'url' | 'userMessageId' | 'assistantMessageId'> & {
  phase: Exclude<SideQuestionPhase, 'queued'>;
  verifiedPair?: boolean;
};

export interface SideQuestionRequest {
  prompt: string;
  search: boolean;
  turnId: string;
  checkpoint: WebCheckpoint & { startedAt: number };
  deadline: number;
  existingConversationId?: string;
}

export interface SideQuestionControl {
  signal: AbortSignal;
  guard: () => Promise<void>;
  checkpoint: (data: WebCheckpoint, firstPreview?: string) => Promise<SideQuestionRequest['checkpoint']>;
  progress?: (text: string) => void;
  nativeAnswer?: NativeAnswer;
}

const provisionalKey = (id: string) => /^-(?:[2-9]|[1-9]\d+)$/.test(id);
const canonicalKey = (id: string) => /^[1-9]\d*$/.test(id);

export function watchChatChanges(signal: AbortSignal, nativeAnswer?: NativeAnswer) {
  let changed = false;
  let wake: (() => void) | undefined;
  const onChange = () => {
    changed = true;
    wake?.();
  };
  const observer = new MutationObserver(onChange);
  nativeAnswer?.addEventListener('change', onChange);
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-virtual-list-item-key', 'data-message-id', 'aria-label', 'aria-disabled', 'aria-pressed', 'disabled', 'hidden', 'class'],
  });
  return {
    close: () => {
      observer.disconnect();
      nativeAnswer?.removeEventListener('change', onChange);
    },
    wait(ms: number): Promise<void> {
      if (signal.aborted) return Promise.reject(new DOMException('已停止', 'AbortError'));
      if (changed) {
        changed = false;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const clean = () => {
          changed = false;
          wake = undefined;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        };
        const done = () => { clean(); resolve(); };
        const abort = () => { clean(); reject(new DOMException('已停止', 'AbortError')); };
        const timer = setTimeout(done, ms);
        wake = done;
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
}
export class SideQuestionWeb {
  readonly controls: NativeControls;
  constructor(readonly adapter = new SiteAdapter()) {
    this.controls = adapter.controls;
  }

  private async wait(predicate: () => boolean, control: SideQuestionControl, timeout: number) {
    if (!control.signal.aborted && predicate()) return;
    const end = Date.now() + timeout;
    const changes = watchChatChanges(control.signal);
    try {
      while (Date.now() < end) {
        await control.guard();
        if (predicate()) return;
        await changes.wait(300);
      }
    } finally {
      changes.close();
    }
    throw new Error('网页控件未在预期时间内就绪');
  }

  private async setMode(search: boolean, control: SideQuestionControl) {
    const mode = { think: false, search };
    for (const kind of ['think', 'search'] as const) {
      // Reading an already-correct switch needs no worker round trip.
      if (this.controls.modeState(kind) === mode[kind]) continue;
      await control.guard();
      const current = this.controls.modeState(kind);
      if (current === null)
        throw new Error(`无法确定${kind === 'think' ? '深度思考' : '智能搜索'}开关状态`);
      if (current !== mode[kind]) {
        const el = this.controls.mode(kind)!;
        if (this.controls.disabled(el)) throw new Error('请求的模式当前不可用');
        el.click();
        await this.wait(() => this.controls.modeState(kind) === mode[kind], control, 5000);
      }
    }
  }

  private fill(prompt: string) {
    const el = this.adapter.composer();
    if (!el) throw new Error('原生输入框已丢失');
    if (this.adapter.getText().trim() && this.adapter.getText() !== prompt)
      throw new Error('检测到新的手动输入，未覆盖文字');
    if (el instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, prompt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (this.adapter.getText() !== prompt) throw new Error('当前网页编辑器无法在后台填写旁问');
  }

  private matched(turnId: string, checkpoint: WebCheckpoint, nodes: MessageNode[]) {
    const users = nodes.filter(n => n.message.role === 'user' && hasSideQuestionMarker(n.message.text, turnId));
    const { userMessageId, assistantMessageId } = checkpoint;
    const previousUser = nodes.find(n => n.message.id === userMessageId && n.message.role === 'user');
    if (previousUser && !users.includes(previousUser))
      throw new Error('旁问提问已被修改，未继续读取其他回答');
    if (users.length > 1) throw new Error('页面出现多个相同的请求编号，请打开原对话核对');
    const [user] = users;
    const adjacent = user ? nodes[nodes.indexOf(user) + 1] : undefined;
    const nextAnswer = adjacent?.message.role === 'assistant' ? adjacent : undefined;
    const userChanged = userMessageId && user && user.message.id !== userMessageId;
    const answerChanged = assistantMessageId && nextAnswer && nextAnswer.message.id !== assistantMessageId;
    if (userChanged || answerChanged) {
      const replaces = (previous: string | undefined, current: string) =>
        !previous || previous === current || (provisionalKey(previous) && canonicalKey(current) &&
          !nodes.some(node => node.message.id === previous));
      // DeepSeek preserves negative render keys while streaming. Reloading
      // history rebuilds the DOM with positive message IDs.
      if (user && nextAnswer && checkpoint.url && conversationId(checkpoint.url) === this.adapter.id() &&
        replaces(userMessageId, user.message.id) && replaces(assistantMessageId, nextAnswer.message.id)) {
        return { user, answer: nextAnswer, verifiedPair: true as const };
      }
      return { user: undefined, answer: undefined };
    }
    const answer = assistantMessageId
      ? nodes.find(n => n.message.id === assistantMessageId && n.message.role === 'assistant')
      : nextAnswer;
    if (user && answer && nextAnswer !== answer) return { user, answer: undefined };
    return { user, answer };
  }
  private async send(request: SideQuestionRequest, control: SideQuestionControl) {
    await control.guard();
    const expectedId = request.existingConversationId ?? null;
    if (this.adapter.id() !== expectedId) throw new Error('发送前的原生对话发生变化');
    this.fill(request.prompt);
    await this.wait(
      () => {
        const send = this.controls.send();
        return !!send && !this.controls.disabled(send);
      },
      control,
      7000,
    );
    if (
      this.controls.modeState('think') !== false ||
      this.controls.modeState('search') !== request.search
    )
      throw new Error('思考或搜索模式发生变化，旁问已暂停');
    request.checkpoint = await control.checkpoint({ phase: 'sending' });
    await control.guard();
    const send = this.controls.send();
    if (
      !send ||
      this.controls.disabled(send) ||
      this.controls.generation() !== 'idle' ||
      this.controls.modeState('think') !== false ||
      this.controls.modeState('search') !== request.search ||
      this.adapter.id() !== expectedId ||
      this.adapter.getText() !== request.prompt
    )
      throw new Error('发送前的输入或控件发生变化，请检查当前对话');
    const beforeSend = new Set(this.adapter.messages({ textOnly: true }).map(n => n.message.id));
    send.click();
    return beforeSend;
  }

  async awaitDone(request: SideQuestionRequest, control: SideQuestionControl, stableMs: number, beforeSend?: ReadonlySet<string>): Promise<SideQuestionAnswer> {
    const changes = watchChatChanges(control.signal, control.nativeAnswer);
    try {
      return await this.readAnswer(request, control, stableMs, () => changes.wait(300), beforeSend);
    } finally {
      changes.close();
    }
  }

  private async readAnswer(
    request: SideQuestionRequest, control: SideQuestionControl, stableMs: number, wait: () => Promise<void>, beforeSend?: ReadonlySet<string>,
  ): Promise<SideQuestionAnswer> {
    let last = '',
      lastCheckpoint = '',
      sawOwnMessage = false;
    let stableSince: number | undefined;
    let lastDomText = '';
    let lastFollowAt = 0;
    while (Date.now() < request.deadline) {
      await control.guard();
      if (!this.adapter.composer()) throw new Error('聊天页或登录状态发生变化，旁问已暂停');
      const chatId = this.adapter.id();
      if (request.checkpoint.url && chatId && conversationId(request.checkpoint.url) !== chatId)
        throw new Error('当前对话已被手动切换，旁问已暂停');
      const native = control.nativeAnswer?.current;
      const canBind = (previous: string | undefined, id: string) =>
        !previous || previous === id || (provisionalKey(previous) && canonicalKey(id));
      const stream = native && chatId && conversationId(native.url) === chatId &&
        canBind(request.checkpoint.userMessageId, native.userMessageId) &&
        canBind(request.checkpoint.assistantMessageId, native.assistantMessageId) ? native : undefined;

      const nodes = this.adapter.messages({ textOnly: true });
      // A live DeepSeek row can still have a negative key after the stream supplies
      // its permanent ID. Recheck the exact prompt marker and its adjacent row.
      const domCheckpoint = stream
        ? { ...request.checkpoint, userMessageId: undefined, assistantMessageId: undefined }
        : request.checkpoint;
      const { user, answer, verifiedPair } = this.matched(request.turnId, domCheckpoint, nodes);
      const domAnswer = stream && (!user || !answer ||
        !canBind(user.message.id, stream.userMessageId) || !canBind(answer.message.id, stream.assistantMessageId))
        ? undefined : answer;
      const domText = domAnswer ? domToMarkdown(domAnswer.element, { delimitMath: true }) : '';
      const current = stream?.text || domText;
      const newText = current !== last ? current : '';
      const observedAnswerId = stream?.assistantMessageId ?? domAnswer?.message.id;
      let firstPreview: string | undefined;
      if (user || stream) sawOwnMessage = true;
      if ((user || answer || stream) && chatId) {
        const fields: WebCheckpoint = {
          phase: 'awaiting',
          url: location.origin + location.pathname,
          userMessageId: stream?.userMessageId ?? user?.message.id ?? request.checkpoint.userMessageId,
          assistantMessageId: stream?.assistantMessageId ?? answer?.message.id ?? request.checkpoint.assistantMessageId,
          ...(verifiedPair || stream ? { verifiedPair: true } : {}),
        };
        const key = JSON.stringify(fields);
        if (key !== lastCheckpoint) {
          if (newText && fields.url && conversationId(fields.url) === chatId && fields.userMessageId &&
              fields.assistantMessageId === observedAnswerId && !this.controls.error()) firstPreview = newText;
          request.checkpoint = await control.checkpoint(fields, firstPreview);
          lastCheckpoint = key;
        }
      }
      const error = this.controls.error();
      if (error) throw new Error(error.message);
      const { phase, url, userMessageId, assistantMessageId, startedAt } = request.checkpoint;
      if (!firstPreview && newText && phase === 'awaiting' && userMessageId &&
          url && this.adapter.id() === conversationId(url) &&
          observedAnswerId === assistantMessageId) {
        control.progress?.(newText);
      }
      if (stream?.done) return stream;
      if (!answer && !stream && Date.now() - lastFollowAt > 800) {
        lastFollowAt = Date.now();
        const tail = nodes.at(-1);
        // Read the preceding prompt, even when DeepSeek unmounts it while
        // following the answer. A scroll hint is never a message binding.
        if (!user && tail?.message.role === 'assistant' && !beforeSend?.has(tail.message.id))
          this.controls.revealPreceding(tail.element);
        else this.controls.followTail();
      }
      const settled =
        domText &&
        phase === 'awaiting' &&
        this.controls.generation() === 'idle' &&
        !this.controls.activity();
      if (!settled) stableSince = undefined;
      else if (stableSince === undefined || domText !== lastDomText) stableSince = Date.now();
      last = current;
      lastDomText = domText;
      if (stableSince !== undefined && Date.now() - stableSince >= stableMs) {
        if (!url || !userMessageId || !assistantMessageId || !domAnswer)
          throw new Error('未能确认本轮旁问的原生消息');
        return { text: domText, url, userMessageId, assistantMessageId };
      }
      const waitForRender = this.adapter.id() || this.controls.generation() === 'generating';
      if (
        !sawOwnMessage &&
        !userMessageId &&
        Date.now() - startedAt > (waitForRender ? 55_000 : 20_000)
      )
        throw new Error('未从 DeepSeek 页面读到本次提问，请打开原对话核对');
      await wait();
    }
    throw new Error('本轮旁问超时；已保存进度，未自动重复发送');
  }

  async run(request: SideQuestionRequest, control: SideQuestionControl): Promise<SideQuestionAnswer> {
    let beforeSend: ReadonlySet<string> | undefined;
    if (request.checkpoint.phase === 'prepared') {
      if (request.existingConversationId) {
        if (this.adapter.id() !== request.existingConversationId)
          throw new Error('未进入已关联的原生对话；未自动发送');
      } else if (this.adapter.id() || this.adapter.messages().length) {
        throw new Error('当前不是已准备的空白新对话；未自动发送');
      }
      await this.setMode(request.search, control);
      beforeSend = await this.send(request, control);
    }
    return this.awaitDone(request, control, 550, beforeSend);
  }
}
