const origin = 'https://chat.deepseek.com';
const path = '/api/v0/chat_session/delete';
const eventName = 'ds-margin:native-conversations-deleted';

function isDeleteRequest(method: unknown, input: unknown) {
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return false;
  const value = input instanceof URL ? input.href : input;
  if (typeof value !== 'string' || !value.includes(path)) return false;
  try {
    const url = new URL(value, location.href);
    return url.origin === origin && url.pathname === path;
  } catch { return false; }
}

function deletedIds(body: unknown): string[] {
  if (typeof body !== 'string' || body.length > 65_536) return [];
  try {
    const ids: unknown = JSON.parse(body)?.chat_session_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 ||
        !ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(id))) return [];
    return [...new Set(ids)];
  } catch { return []; }
}

function report(ids: string[], response: unknown) {
  if (!response || typeof response !== 'object') return;
  const result = response as { code?: unknown; data?: { biz_code?: unknown } };
  if (result.code !== 0 || result.data?.biz_code !== 0) return;
  document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(ids) }));
}

if (location.origin === origin && window.top === window) {
  const prototype = XMLHttpRequest.prototype;
  const open = prototype.open;
  const send = prototype.send;
  const deletionRequests = new WeakSet<XMLHttpRequest>();
  const cleanups = new WeakMap<XMLHttpRequest, () => void>();
  prototype.open = function (this: XMLHttpRequest, ...args: Parameters<typeof open>) {
    cleanups.get(this)?.();
    Reflect.apply(open, this, args);
    deletionRequests.delete(this);
    if (isDeleteRequest(args[0], args[1])) deletionRequests.add(this);
  } as typeof open;
  prototype.send = function (this: XMLHttpRequest, ...args: Parameters<typeof send>) {
    const ids = deletionRequests.has(this) ? deletedIds(args[0]) : [];
    const inspect = () => {
      if (this.status < 200 || this.status >= 300 || !isDeleteRequest('POST', this.responseURL)) return;
      try { report(ids, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* Ignore an unreadable response. */ }
    };
    const cleanup = () => {
      this.removeEventListener('load', inspect);
      this.removeEventListener('loadend', cleanup);
      cleanups.delete(this);
    };
    if (ids.length) {
      this.addEventListener('load', inspect);
      this.addEventListener('loadend', cleanup);
      cleanups.set(this, cleanup);
    }
    try { return Reflect.apply(send, this, args); }
    catch (error) {
      cleanup();
      throw error;
    }
  };

  const fetch = window.fetch;
  window.fetch = function (this: Window, ...args: Parameters<typeof fetch>) {
    let copy: Request | undefined;
    let ids: string[] = [];
    try {
      const [input, options] = args;
      const request = input instanceof Request ? input : undefined;
      if (isDeleteRequest(options?.method ?? request?.method, request?.url ?? input)) {
        if (options?.body == null && request?.body) copy = request.clone();
        else ids = deletedIds(options?.body);
      }
    } catch { /* Keep the native request intact. */ }
    const response = Reflect.apply(fetch, this, args) as ReturnType<typeof fetch>;
    if (copy || ids.length) {
      // Clone before the caller can consume the response's original body.
      const parsed = response.then(result => result.ok && isDeleteRequest('POST', result.url) ? result.clone().json() : null);
      const candidates = copy ? copy.text().then(deletedIds) : Promise.resolve(ids);
      void Promise.all([parsed, candidates]).then(([result, confirmedIds]) => {
        if (confirmedIds.length) report(confirmedIds, result);
      }).catch(() => {});
    }
    return response;
  };
}

export {};
