import type { SiteAdapter } from './adapter';

export interface SlashInvocation {
  editor: HTMLElement;
  route: string;
  source: string;
  query: string;
  replacement: { start: number; end: number; node?: Text; token?: string };
}

const LINE_BLOCKS = 'div,p,li,blockquote,pre,h1,h2,h3,h4,h5,h6';

function findToken(beforeCaret: string) {
  const lineStart = beforeCaret.lastIndexOf('\n') + 1;
  const match = /^([ \t]*)[/／]([^/／\r\n]{0,60})$/.exec(beforeCaret.slice(lineStart));
  return match ? { start: lineStart + match[1].length, query: match[2] } : null;
}

export function readSlash(adapter: SiteAdapter, editor: HTMLElement): SlashInvocation | null {
  const source = adapter.getText(editor);
  const route = location.pathname;
  if (editor instanceof HTMLTextAreaElement) {
    const end = editor.selectionEnd;
    if (editor.selectionStart !== end || (end < source.length && source[end] !== '\n')) return null;
    const token = findToken(source.slice(0, end));
    return token && { editor, route, source, query: token.query, replacement: { start: token.start, end } };
  }
  const selection = document.getSelection();
  const node = selection?.focusNode;
  if (!selection?.isCollapsed || !(node instanceof Text) || !editor.contains(node)) return null;
  const end = selection.focusOffset;
  if (end < node.length && node.data[end] !== '\n') return null;
  if (!findToken(node.data.slice(0, end))) return null;

  // Contenteditable represents hard breaks as blocks or <br>, in addition
  // to literal newlines. Only replace within the caret's original text node.
  const block = node.parentElement?.closest(LINE_BLOCKS);
  const before = document.createRange();
  before.selectNodeContents(block && editor.contains(block) ? block : editor);
  before.setEnd(node, end);
  const fragment = before.cloneContents();
  for (const element of fragment.querySelectorAll(`br,${LINE_BLOCKS}`)) {
    if (element.tagName === 'BR') element.replaceWith('\n');
    else element.append('\n');
  }
  const text = fragment.textContent ?? '';
  const token = findToken(text);
  if (!token) return null;
  const start = end - (text.length - token.start);
  if (start < 0) return null;
  return {
    editor, route, source, query: token.query,
    replacement: { start, end, node, token: node.data.slice(start, end) },
  };
}

export function currentSlash(adapter: SiteAdapter, invocation: SlashInvocation) {
  const { editor, route, source, replacement } = invocation;
  if (location.pathname !== route || !editor.isConnected || adapter.composer() !== editor ||
    adapter.getText(editor) !== source) return false;
  if (editor instanceof HTMLTextAreaElement) return !editor.readOnly;
  const { node, start, end, token } = replacement;
  return Boolean(node && editor.contains(node) && node.data.slice(start, end) === token);
}

export function replaceSlash(adapter: SiteAdapter, invocation: SlashInvocation, text: string) {
  if (!currentSlash(adapter, invocation)) return false;
  const { editor, replacement } = invocation;
  editor.focus({ preventScroll: true });
  if (document.activeElement !== editor || !currentSlash(adapter, invocation)) return false;
  if (editor instanceof HTMLTextAreaElement) {
    const nextLength = invocation.source.length - (replacement.end - replacement.start) + text.length;
    if (editor.maxLength >= 0 && nextLength > editor.maxLength) return false;
    editor.setSelectionRange(replacement.start, replacement.end);
  } else if (replacement.node) {
    const selection = document.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.setStart(replacement.node, replacement.start);
    range.setEnd(replacement.node, replacement.end);
    selection.removeAllRanges();
    selection.addRange(range);
  } else return false;
  // Chromium records this as a normal edit. Assigning textarea.value would
  // clear the user's undo history and make Ctrl+Z unable to restore the token.
  return document.execCommand('insertText', false, text);
}
