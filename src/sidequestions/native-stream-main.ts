import './native-delete-main';
import { hasRawSideQuestionMarker } from './marker';

const origin = 'https://chat.deepseek.com';
const completionPath = '/api/v0/chat/completion';
const armEvent = 'ds-margin:native-stream-arm';
const disarmEvent = 'ds-margin:native-stream-disarm';
const streamEvent = 'ds-margin:native-stream';
const maxStreamSize = 4_000_000;
const maxFrameSize = 1_000_000;
const maxAnswerSize = 120_000;

interface ArmedTurn {
  id: string;
  selected?: NativeStream;
}

interface Fragment {
  type: string;
  content: string;
}

// DeepSeek's native SSE sends inherited path/op fields and nested batches.
interface PatchCursor {
  path: string;
  operation: 'SET' | 'APPEND' | 'BATCH';
}

let armedTurn: ArmedTurn | undefined;
let uninstall: (() => boolean) | undefined;

function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nativeMessageId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

function completionUrl(value: unknown): boolean {
  if (typeof value !== 'string' && !(value instanceof URL)) return false;
  try {
    const url = new URL(value, location.href);
    return url.origin === origin && url.pathname === completionPath && !url.username && !url.password;
  } catch { return false; }
}

function requestScope(body: unknown) {
  const turn = armedTurn;
  if (!turn || turn.selected || typeof body !== 'string' || body.length > 120_000) return;
  const request = record(json(body));
  const chatId = request?.chat_session_id;
  const prompt = request?.prompt;
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(chatId) ||
      typeof prompt !== 'string' || !hasRawSideQuestionMarker(prompt, turn.id)) return;
  return { turn, chatId };
}

async function requestCloneScope(copy: Request) {
  const reader = copy.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (body.length <= 120_000 && armedTurn) {
      const { done, value } = await reader.read();
      if (done) return requestScope(body + decoder.decode());
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseFragment(value: unknown): Fragment | undefined {
  const fields = record(value);
  if (!fields || typeof fields.type !== 'string') return;
  if (fields.type !== 'RESPONSE') return { type: fields.type, content: '' };
  const content = fields.content;
  if (typeof content !== 'string' || content.length > maxAnswerSize) return;
  return { type: fields.type, content };
}

function parseFragments(value: unknown): Fragment[] | undefined {
  if (!Array.isArray(value) || value.length > 1024) return;
  const result: Fragment[] = [];
  for (const item of value) {
    const fragment = parseFragment(item);
    if (!fragment) return;
    result.push(fragment);
  }
  return result;
}

class NativeStream {
  private buffer = '';
  private receivedSize = 0;
  private userMessageId?: string;
  private assistantMessageId?: string;
  private fragments?: Fragment[];
  private readonly cursor: PatchCursor = { path: '', operation: 'SET' };
  private invalid = false;
  private finished = false;
  private failed = false;
  private lastText?: string;

  constructor(private readonly turn: ArmedTurn, private readonly chatId: string) {}

  get active(): boolean {
    return !this.invalid && armedTurn === this.turn && (!this.turn.selected || this.turn.selected === this);
  }

  push(chunk: string) {
    if (!this.active || !chunk) return;
    this.receivedSize += chunk.length;
    if (this.receivedSize > maxStreamSize) { this.invalid = true; return; }
    this.buffer += chunk;
    const separator = /\r\n\r\n|\n\n|\r\r/g;
    let consumed = 0;
    for (let match = separator.exec(this.buffer); match; match = separator.exec(this.buffer)) {
      if (match.index - consumed > maxFrameSize || !this.frame(this.buffer.slice(consumed, match.index))) {
        this.invalid = true;
        return;
      }
      consumed = separator.lastIndex;
    }
    this.buffer = this.buffer.slice(consumed);
    if (this.buffer.length > maxFrameSize) { this.invalid = true; return; }
    this.emit(false);
  }

  end() {
    // A clean transport ending is separate from the server saying generation finished.
    if (!this.buffer.trim() && this.finished && !this.failed) this.emit(true);
  }

  private emit(done: boolean) {
    if (!this.active || !this.userMessageId || !this.assistantMessageId) return;
    const text = (this.fragments ?? []).filter(fragment => fragment.type === 'RESPONSE')
      .map(fragment => fragment.content).join('\n\n');
    if (text.length > maxAnswerSize) { this.invalid = true; return; }
    if (done ? !text.trim() : text === this.lastText) return;
    this.lastText = text;
    document.dispatchEvent(new CustomEvent(streamEvent, { detail: JSON.stringify({
      turnId: this.turn.id,
      chatId: this.chatId,
      userMessageId: this.userMessageId,
      assistantMessageId: this.assistantMessageId,
      text,
      done,
    }) }));
  }

  private frame(raw: string): boolean {
    let event = '';
    const lines: string[] = [];
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!lines.length) return true;
    const data = record(json(lines.join('\n')));
    switch (event) {
      case 'ready': {
        const userId = nativeMessageId(data?.request_message_id);
        const assistantId = nativeMessageId(data?.response_message_id);
        if (!userId || !assistantId || userId === assistantId ||
            (this.userMessageId && (userId !== this.userMessageId || assistantId !== this.assistantMessageId))) return false;
        this.turn.selected = this;
        this.userMessageId = userId;
        this.assistantMessageId = assistantId;
        return true;
      }
      case '':
      case 'delta':
        return !!data && this.patch(data, this.cursor, '', 0);
      case 'finish':
        this.finished = true;
        return true;
      case 'hint':
      case 'toast':
        if (data?.type === 'error' || data?.clear_response === true) this.failed = true;
        return true;
      case 'close':
        if (data?.click_behavior && data.click_behavior !== 'none') this.failed = true;
        return true;
      default:
        return true;
    }
  }

  private patch(delta: Record<string, unknown>, cursor: PatchCursor, prefix: string, depth: number): boolean {
    if (depth > 8) return false;
    if (delta.p !== undefined && delta.p !== null) {
      if (typeof delta.p !== 'string' || delta.p.length > 512) return false;
      cursor.path = delta.p.split('/').filter(Boolean).join('/');
    }
    if (delta.o !== undefined && delta.o !== null) {
      if (delta.o !== 'SET' && delta.o !== 'APPEND' && delta.o !== 'BATCH') return false;
      cursor.operation = delta.o;
    }
    const path = [prefix, cursor.path].filter(Boolean).join('/');
    if (cursor.operation !== 'BATCH') return this.apply(path, cursor.operation, delta.v);
    if (!Array.isArray(delta.v) || delta.v.length > 1024) return false;
    const child: PatchCursor = { path: '', operation: 'SET' };
    return delta.v.every(value => {
      const part = record(value);
      return !!part && this.patch(part, child, path, depth + 1);
    });
  }

  private apply(path: string, operation: 'SET' | 'APPEND', value: unknown): boolean {
    if (!this.assistantMessageId) return false;
    if (path === '' || path === 'response') {
      const response = record(path ? value : record(value)?.response);
      if (operation !== 'SET' || !response || nativeMessageId(response.message_id) !== this.assistantMessageId ||
          (response.parent_id !== undefined && nativeMessageId(response.parent_id) !== this.userMessageId)) return false;
      this.fragments = parseFragments(response.fragments);
      this.observeStatus(response.status);
      this.observeStatus(response.quasi_status);
      return !!this.fragments;
    }
    if (path === 'response/status' || path === 'response/quasi_status') {
      if (operation !== 'SET') return false;
      this.observeStatus(value);
      return true;
    }
    if (!this.fragments) return false;
    if (path === 'response/fragments') {
      const fragments = parseFragments(value);
      if (!fragments) return false;
      if (operation === 'SET') this.fragments = fragments;
      else this.fragments.push(...fragments);
      return this.fragments.length <= 1024;
    }
    const match = path.match(/^response\/fragments\/(-?\d+)(?:\/(.*))?$/);
    if (!match) return !path.startsWith('response/fragments/');
    const [, rawIndex, field] = match;
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index)) return false;
    if (!field && operation === 'APPEND') {
      const fragments = parseFragments(value);
      if (!fragments || index < -this.fragments.length || index > this.fragments.length) return false;
      this.fragments.splice(index, 0, ...fragments);
      return this.fragments.length <= 1024;
    }
    if (!field && operation === 'SET') {
      const fragment = parseFragment(value);
      const slot = index < 0 ? this.fragments.length + index : index;
      if (!fragment || slot < 0 || slot > this.fragments.length) return false;
      this.fragments[slot] = fragment;
      return this.fragments.length <= 1024;
    }
    const fragment = this.fragments.at(index);
    if (!fragment) return false;
    if (field === 'type') return operation === 'SET' && value === fragment.type;
    if (field !== 'content' || fragment.type !== 'RESPONSE') return true;
    if (typeof value !== 'string') return false;
    fragment.content = operation === 'SET' ? value : fragment.content + value;
    return fragment.content.length <= maxAnswerSize;
  }

  private observeStatus(value: unknown) {
    if (value === 'FINISHED') this.finished = true;
    else if (typeof value === 'string' && value !== 'WIP') this.failed = true;
  }
}

function readXhr(xhr: XMLHttpRequest, stream: NativeStream) {
  let offset = 0;
  const progress = () => {
    try {
      if (!stream.active || xhr.status < 200 || xhr.status >= 300 ||
          !completionUrl(xhr.responseURL) || !xhr.getResponseHeader('content-type')?.includes('text/event-stream')) return;
      const fullText = xhr.responseText;
      stream.push(fullText.slice(offset));
      offset = fullText.length;
    } catch { /* The site still owns this XMLHttpRequest. */ }
  };
  const load = () => { progress(); stream.end(); };
  const cleanup = () => {
    xhr.removeEventListener('progress', progress);
    xhr.removeEventListener('load', load);
    xhr.removeEventListener('loadend', cleanup);
  };
  xhr.addEventListener('progress', progress);
  xhr.addEventListener('load', load);
  xhr.addEventListener('loadend', cleanup);
  return cleanup;
}

async function readFetch(response: Response, stream: NativeStream) {
  if (!stream.active || !response.ok || !completionUrl(response.url) ||
      !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) return;
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  try {
    while (stream.active) {
      const { done, value } = await reader.read();
      if (done) {
        stream.push(decoder.decode());
        stream.end();
        return;
      }
      stream.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Cancel the copied branch only, without waiting for the site's original consumer.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function install() {
  // Ordinary chat pages never arm this observer. The matched worker still uses
  // the exact native request; neither transport changes what the site receives.
  const xhr = XMLHttpRequest.prototype;
  const open = xhr.open;
  const send = xhr.send;
  const requests = new WeakSet<XMLHttpRequest>();
  const observeOpen = function (this: XMLHttpRequest, ...args: Parameters<typeof open>) {
    const result = Reflect.apply(open, this, args);
    requests.delete(this);
    if (armedTurn && typeof args[0] === 'string' && args[0].toUpperCase() === 'POST' && completionUrl(args[1]))
      requests.add(this);
    return result;
  };
  const observeSend = function (this: XMLHttpRequest, ...args: Parameters<typeof send>) {
    const scope = requests.has(this) ? requestScope(args[0]) : undefined;
    const cleanup = scope && readXhr(this, new NativeStream(scope.turn, scope.chatId));
    try { return Reflect.apply(send, this, args); }
    catch (error) { cleanup?.(); throw error; }
  };

  const fetch = window.fetch;
  const observeFetch = function (this: Window, ...args: Parameters<typeof fetch>) {
    let scope: ReturnType<typeof requestScope>;
    let copy: Request | undefined;
    if (armedTurn) {
      try {
        const [input, init] = args;
        const request = input instanceof Request ? input : undefined;
        const method = init?.method ?? request?.method;
        if (method?.toUpperCase() === 'POST' && completionUrl(request?.url ?? input)) {
          scope = requestScope(init?.body);
          if (!scope && init?.body == null && request?.body) copy = request.clone();
        }
      } catch { /* Passive capture must not affect the original fetch. */ }
    }
    const result = Reflect.apply(fetch, this, args) as ReturnType<typeof fetch>;
    if (scope || copy) {
      const captured = copy ? requestCloneScope(copy) : Promise.resolve(scope);
      void Promise.all([result, captured]).then(([response, match]) => {
        if (match) return readFetch(response, new NativeStream(match.turn, match.chatId));
      }).catch(() => {});
    }
    return result;
  };
  xhr.open = observeOpen as typeof open;
  xhr.send = observeSend;
  window.fetch = observeFetch;
  return () => {
    if (xhr.open !== observeOpen || xhr.send !== observeSend || window.fetch !== observeFetch) return false;
    xhr.open = open;
    xhr.send = send;
    window.fetch = fetch;
    return true;
  };
}

function eventTurnId(event: Event): string | undefined {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'string' || detail.length > 160) return;
  const turnId = record(json(detail))?.turnId;
  return typeof turnId === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(turnId)
    ? turnId : undefined;
}

if (location.origin === origin && window.top === window) {
  document.addEventListener(armEvent, event => {
    const turnId = eventTurnId(event);
    if (!turnId || armedTurn?.id === turnId) return;
    armedTurn = { id: turnId };
    uninstall ??= install();
  });
  document.addEventListener(disarmEvent, event => {
    if (!armedTurn || eventTurnId(event) !== armedTurn.id) return;
    armedTurn = undefined;
    if (uninstall?.()) uninstall = undefined;
  });
}

export {};
