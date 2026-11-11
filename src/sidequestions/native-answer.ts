import { conversationId } from '../shared/model';

export interface SideQuestionAnswer {
  text: string;
  url: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface NativeAnswer extends EventTarget {
  current?: SideQuestionAnswer & { done: boolean };
}

const STREAM_EVENT = 'ds-margin:native-stream';

export function observeNativeAnswer(turnId: string, existingUrl?: string) {
  const answer: NativeAnswer = new EventTarget();
  const existingId = existingUrl ? conversationId(existingUrl) : undefined;

  const read = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string' || event.detail.length > 250_000) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(event.detail); } catch { return; }
    if (!frame || frame.turnId !== turnId || typeof frame.chatId !== 'string' ||
        (existingId && frame.chatId !== existingId) || !/^[\w-]{1,128}$/.test(frame.chatId) ||
        typeof frame.userMessageId !== 'string' || !/^[1-9]\d{0,15}$/.test(frame.userMessageId) ||
        typeof frame.assistantMessageId !== 'string' || !/^[1-9]\d{0,15}$/.test(frame.assistantMessageId) ||
        frame.userMessageId === frame.assistantMessageId ||
        typeof frame.text !== 'string' || frame.text.length > 120_000 || typeof frame.done !== 'boolean') return;

    const url = new URL('/a/chat/s/' + frame.chatId, location.origin).href;
    if (conversationId(url) !== frame.chatId) return;
    const before = answer.current;
    if (before && (before.done || before.url !== url || before.userMessageId !== frame.userMessageId ||
        before.assistantMessageId !== frame.assistantMessageId ||
        (before.text === frame.text && !frame.done))) return;

    answer.current = {
      url, userMessageId: frame.userMessageId, assistantMessageId: frame.assistantMessageId,
      text: frame.text, done: frame.done && Boolean(frame.text.trim()),
    };
    answer.dispatchEvent(new Event('change'));
  };
  const announce = (action: 'arm' | 'disarm') => {
    document.dispatchEvent(new CustomEvent('ds-margin:native-stream-' + action, { detail: JSON.stringify({ turnId }) }));
  };
  document.addEventListener(STREAM_EVENT, read);
  announce('arm');
  return {
    answer,
    close() {
      document.removeEventListener(STREAM_EVENT, read);
      announce('disarm');
    },
  };
}
