import { conversationId, fingerprint, type ChatMessage, type Conversation } from '../shared/model';
import type { ConversationLink } from '../shared/projects';

export interface MessageNode { message: ChatMessage; element: HTMLElement; }
interface SidebarRow { link: ConversationLink; element: HTMLAnchorElement }
export interface SidebarLayout { sidebar?: HTMLElement; history?: HTMLElement; newChat?: HTMLElement; rows: SidebarRow[] }
export interface SiteLayout {
  composerBox: HTMLElement;
  scroll?: HTMLElement;
  scrollShell?: HTMLElement;
  fixedComposer?: HTMLElement;
  column?: HTMLElement;
  header?: HTMLElement;
  nativeBottom?: HTMLElement;
}
export const SITE_SELECTORS={
  assistant:'.ds-assistant-message-main-content, [data-message-role="assistant"] [data-message-content]',
  user:'[data-message-role="user"] [data-message-content], .ds-message.d29f3d7d .fbb737a4, .ds-message .ds-collapsible-text',
  messageItem:'[data-virtual-list-item-key],[data-message-id]',
  controls:'button,[role="button"],a,.ds-toggle-button,[tabindex="0"]',
  composer:'textarea.ds-textarea__textarea[placeholder],textarea[placeholder*="DeepSeek"],textarea[placeholder*="发送消息"],textarea[placeholder*="Message"]',
  editable:'[contenteditable="true"][role="textbox"][aria-label*="DeepSeek"]',
  mainButton:'._52c986b',knownComposer:'._77cefa5,[data-native-composer]',inputWrapper:'.ds-textarea',
  send:'[aria-label="发送"],[aria-label="Send"],[data-native-action="send"]',
  stop:'[aria-label="停止生成"],[aria-label="Stop"],[data-native-action="stop"]',
  newChat:'[data-native-action="new-chat"],[aria-label="开启新对话"],[aria-label="New chat"]',
  stopPath:'M2 4.88C2',sendPath:'M8.3125 0.980206',
  alerts:'[role="alert"],.ds-toast,.ds-notification,[data-native-error]',
  thinking:'[data-native-status],[role="status"]',
  sidebar:'aside,[role="navigation"]',history:'[data-native-history],._6d215eb',
  logo:'[data-native-logo],.e066abb8',
  rowLabel:'[data-native-session-title],.c08e6e93',rowTools:'._254829d',
  header:'[data-native-header],header,[role="banner"]',headerTitle:'[data-native-chat-title]',
  scrollBottom:'[data-native-action="scroll-bottom"],._0706cde',
  codeBlock:'.md-code-block',codeLabel:'.md-code-block-infostring,.ds-markdown-code-info',
} as const;
const ASSISTANT = SITE_SELECTORS.assistant;
// Verified against the public DeepSeek bundle main.26d4d4c4fd.js.
// Semantic hooks are preferred; hashed selectors are confined to this adapter.
const USER = SITE_SELECTORS.user;
const IGNORED = 'button,[role="button"],svg,script,style,.ds-think-content,[data-dsm-owned],.ds-markdown-code-info,.md-code-block-banner-wrap,.md-code-block-footer';

// These text nodes may also be read by bookmarks and export.
// Give those readers the original even when the page shows typographic quotes.
const displayQuotes = new Map<Text, { original: string; display: string }>();
function originalText(node: Text): string {
  const entry = displayQuotes.get(node);
  return entry && node.data === entry.display ? entry.original : node.data;
}
export function shapeProseQuotes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest(`${IGNORED},pre,code,.katex,math`)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  // Respect block boundaries, but allow a quotation to span inline emphasis or
  // the renderer's streaming spans. Never move or replace framework nodes.
  let block: Element | null = null, run: Text[] = [];
  const flush = () => {
    const parts = run.map(originalText);
    const pairs = [...parts.join('').matchAll(/"([^"\r\n]+)"/gu)]
      .filter(match => /\p{Script=Han}/u.test(match[1]));
    const edits = new Map(pairs.flatMap(match => [[match.index, '“'], [match.index + match[0].length - 1, '”']] as const));
    let offset = 0;
    run.forEach((node, index) => {
      const original = parts[index];
      const display = original.replace(/"/g, (quote, index: number) => edits.get(offset + index) ?? quote);
      offset += original.length;
      if (display === original) displayQuotes.delete(node);
      else displayQuotes.set(node, { original, display });
      if (node.data !== display) node.data = display;
    });
    run = [];
  };
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const next = node.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,div,td,th') ?? root;
    if (block !== next) { flush(); block = next; }
    run.push(node);
  }
  flush();
}
function safeLink(href: string): string | null {
  try { const u = new URL(href, location.href); return ['https:','http:','mailto:'].includes(u.protocol) ? u.href.replace(/[()]/g, c => c === '(' ? '%28' : '%29') : null; }
  catch { return null; }
}
export function domToText(root: Element): string {
  const render = (node: Node): string => {
    if (node instanceof Text) return originalText(node);
    if (!(node instanceof Element) || node.matches(IGNORED)) return '';
    if (node.matches('.katex')) {
      const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      return source ?? node.textContent ?? '';
    }
    if (node.tagName === 'BR') return '\n';
    const inner=[...node.childNodes].map(render).join('');
    return /^(P|DIV|H[1-6]|PRE|UL|OL|LI|BLOCKQUOTE|TR|SECTION)$/.test(node.tagName) ? `\n${inner}\n` : inner;
  };
  return render(root).replace(/\n[ \t]+\n/g,'\n\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function domToMarkdown(root: Element, { delimitMath = false } = {}): string {
  const render = (node: Node): string => {
    if (node instanceof Text) return originalText(node).replace(/([\\`*_\[\]<>])/g, '\\$1');
    if (!(node instanceof Element)) return '';
    const tag = node.tagName.toLowerCase();
    if (node.matches(IGNORED)) return '';
    if (tag === 'annotation') return '';
    if (node.matches('.katex')) {
      const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (source && delimitMath) {
        return node.closest('.katex-display') ? '\n\n\\[' + source.trim() + '\\]\n\n' : '\\(' + source.trim() + '\\)';
      }
      if (source) return node.closest('.katex-display') ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
    }
    if (tag === 'pre') {
      const code = node.querySelector('code') ?? node;
      const content = code.textContent ?? '';
      const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
      const fence = '`'.repeat(longest + 1);
      const label = node.closest(SITE_SELECTORS.codeBlock)?.querySelector(SITE_SELECTORS.codeLabel)?.textContent?.trim();
      const lang = (code.className.match(/language-([\w+-]+)/)?.[1] ?? (label && /^[\w+-]+$/.test(label) ? label : '')).slice(0, 30);
      return `\n\n${fence}${lang}\n${content}\n${fence}\n\n`;
    }
    const inner = [...node.childNodes].map(render).join('');
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'strong' || tag === 'b') return `**${inner}**`;
    if (tag === 'em' || tag === 'i') return `*${inner}*`;
    if (tag === 'code') { const fence = inner.includes('`') ? '``' : '`'; return `${fence}${inner}${fence}`; }
    if (tag === 'a') { const href = safeLink(node.getAttribute('href') ?? ''); return href ? `[${inner}](${href})` : inner; }
    if (tag === 'img') return node.getAttribute('alt') ? `[图片：${node.getAttribute('alt')}]` : '';
    if (tag === 'li') return `\n${node.parentElement?.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}.` : '-'} ${inner.trim()}\n`;
    if (tag === 'blockquote') return '\n\n' + inner.trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map(tr => [...tr.children].map(td => [...td.childNodes].map(render).join('').trim().replace(/\|/g,'\\|').replace(/\n/g,' ')));
      if (!rows.length) return '';
      return '\n\n' + rows.map((row, i) => `| ${row.join(' | ')} |${i === 0 ? `\n| ${row.map(()=>'---').join(' | ')} |` : ''}`).join('\n') + '\n\n';
    }
    if (['p','div','section','ul','ol'].includes(tag)) return `\n\n${inner}\n\n`;
    return inner;
  };
  return render(root).replace(/\n[ \t]+\n/g,'\n\n').replace(/\n{3,}/g,'\n\n').trim();
}

export function isAuthRoute() {
  return /^\/(?:sign_in|login|sign_up)(?:\/|$)/.test(location.pathname);
}

export class SiteAdapter {
  readonly controls = new NativeControls(this);
  private controlMarks = new Set<HTMLElement>();
  private layoutMarks = new Map<string, Set<HTMLElement>>();
  private sidebarMarks = new Map<string, Set<HTMLElement>>();
  sidebarLayout: SidebarLayout = { rows: [] };
  composer(): HTMLTextAreaElement | HTMLElement | null {
    if (isAuthRoute()) return null;
    const candidates = [...document.querySelectorAll<HTMLTextAreaElement>(SITE_SELECTORS.composer)]
      .filter(el => !el.disabled && el.getBoundingClientRect().width > 0);
    const preferred = candidates.find(el => el.closest(SITE_SELECTORS.knownComposer));
    if (preferred) return preferred;
    if (candidates.length === 1) return candidates[0];
    return document.querySelector<HTMLElement>(SITE_SELECTORS.editable);
  }
  id(): string | null { return conversationId(location.href); }
  draftId(): string { return this.id() ?? '__new__'; }
  messages({ textOnly = false } = {}): MessageNode[] {
    const result: MessageNode[] = [], seen = new Set<string>();
    const elements = document.querySelectorAll<HTMLElement>(`${ASSISTANT}, ${USER}`);
    for (const element of elements) {
      if (element.closest('.ds-think-content,[data-dsm-owned]')) continue;
      const role = element.matches(ASSISTANT) ? 'assistant' : 'user';
      const wrapper = element.closest<HTMLElement>(SITE_SELECTORS.messageItem);
      const nativeId = wrapper?.getAttribute('data-virtual-list-item-key') ?? wrapper?.getAttribute('data-message-id');
      // Refuse to invent a positional ID: virtualized/edited conversations would
      // otherwise silently attach bookmarks and drafts to the wrong message.
      if (!nativeId || !/^[\w:-]{1,150}$/.test(nativeId) || seen.has(nativeId)) continue;
      const text = domToText(element);
      if (!text) continue;
      seen.add(nativeId);
      const message: ChatMessage = { id: nativeId, role, text, markdown: role === 'user' || textOnly ? text : domToMarkdown(element), fingerprint: fingerprint(text) };
      element.dataset.dsmMessage = role;
      if (wrapper) wrapper.dataset.dsmMessageContainer = '';
      result.push({ message, element });
    }
    return result;
  }
  snapshot(nodes = this.messages()): Conversation | null {
    const id = this.id(); if (!id || !nodes.length) return null;
    const link = this.currentLink(nodes)!;
    return { ...link,
      messages: nodes.map(n => n.message), capturedAt: Date.now(), scope: 'observed', pinned: false, folder: '', tags: [] };
  }
  currentLink(nodes: MessageNode[]): ConversationLink | null {
    const id = this.id();
    if (!id) return null;
    const known = this.sidebarLayout.rows.find(row => row.link.id === id)?.link;
    if (known) return known;
    const title = document.querySelector(SITE_SELECTORS.headerTitle)?.textContent?.trim() ||
      nodes.find(node => node.message.role === 'user')?.message.text || '未命名对话';
    return { id, url: location.origin + location.pathname, title: title.slice(0, 160) };
  }
  getText(el = this.composer()): string { return el instanceof HTMLTextAreaElement ? el.value : el?.innerText ?? ''; }
  insertText(text: string): boolean {
    const el = this.composer(); if (!el) return false;
    if (el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
      const value = el.value.slice(0,start) + text + el.value.slice(end);
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus(); el.setSelectionRange(start + text.length, start + text.length);
    } else {
      el.focus();
      // execCommand preserves contenteditable's undo history and native editor
      // input handling. Never replace a framework-owned subtree with innerHTML.
      if (!document.execCommand('insertText', false, text)) return false;
    }
    return true;
  }
  locate(id: string, expectedFingerprint: string): boolean {
    const node = this.messages().find(n => n.message.id === id && n.message.fingerprint === expectedFingerprint);
    if (!node) return false;
    const reduced = document.documentElement.classList.contains('dsm-reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.element.scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
    node.element.dataset.dsmHighlight = '';
    setTimeout(() => delete node.element.dataset.dsmHighlight, 1800); return true;
  }
  markControls() {
    const next = new Set<HTMLElement>();
    const mark = (el: HTMLElement, name: string, value: string) => {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
      next.add(el);
    };
    for (const kind of ['think', 'search'] as const) {
      const { element, pressed } = this.controls.readMode(kind);
      if (!element) continue;
      mark(element, 'data-dsm-mode', kind);
      mark(element, 'data-dsm-mode-state', pressed === null ? 'unknown' : pressed ? 'on' : 'off');
    }
    const stop = this.controls.stop(), send = stop ?? this.controls.send();
    if (send) mark(send, 'data-dsm-send', stop ? 'stop' : this.controls.disabled(send) ? 'disabled' : 'send');
    for (const el of this.controlMarks) {
      if (!next.has(el)) for (const name of ['mode','mode-state','send']) el.removeAttribute(`data-dsm-${name}`);
    }
    this.controlMarks = next;
    return Boolean(stop);
  }
  markSidebar(composer = this.composer()) {
    const root = document.getElementById('root') ?? document.getElementById('__next');
    const marks = new Map<string, Set<HTMLElement>>();
    const mark = (element: HTMLElement, name: string, value = '') => {
      const attribute = `data-dsm-${name}`;
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
      let elements = marks.get(attribute);
      if (!elements) marks.set(attribute, elements = new Set());
      elements.add(element);
    };
    const current = this.sidebarLayout.sidebar;
    const previousNew = this.sidebarLayout.newChat;
    let newChat = previousNew?.isConnected && current?.contains(previousNew)
      ? previousNew : this.controls.newChat() ?? current?.querySelector<HTMLElement>(SITE_SELECTORS.newChat) ?? undefined;
    const anchor = [...(current?.isConnected ? current : root ?? document).querySelectorAll<HTMLAnchorElement>('a[href*="/chat/"]')]
      .find(a => !a.closest('[data-dsm-owned]') && !!conversationId(a.href));
    const start = anchor ?? (current?.isConnected ? current : newChat);
    let sidebar = start?.closest<HTMLElement>('aside') ?? start?.closest<HTMLElement>(SITE_SELECTORS.sidebar) ?? undefined;
    if (!sidebar && current?.isConnected && current.contains(start ?? null)) sidebar = current;
    if (!sidebar) {
      for (let el = start?.parentElement; el && el !== root && el !== document.body; el = el.parentElement) {
        const rect = el.getBoundingClientRect();
        if (rect.height > innerHeight * .65 && rect.width > 0 && rect.width <= 360 && !el.contains(composer)) sidebar = el;
      }
    }
    let history: HTMLElement | undefined;
    const rows: SidebarRow[] = [];
    if (sidebar && !sidebar.contains(composer)) {
      newChat ??= sidebar.querySelector<HTMLElement>(SITE_SELECTORS.newChat) ?? undefined;
      mark(sidebar, 'sidebar');
      const logo = sidebar.querySelector<HTMLElement>(SITE_SELECTORS.logo) ??
        [...sidebar.querySelectorAll<HTMLElement>('h1,svg[aria-label],img[alt]')]
          .find(el => /^deepseek$/i.test((el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? el.textContent ?? '').trim()));
      if (logo) mark(logo, 'sidebar-logo');
      history = sidebar.querySelector<HTMLElement>(SITE_SELECTORS.history) ?? anchor?.closest('nav') ?? anchor?.parentElement ?? undefined;
      if (history && history !== sidebar && sidebar.contains(history) && !history.contains(newChat ?? null)) mark(history, 'native-history');
      const active = this.id();
      for (const link of sidebar.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const id = conversationId(link.href);
        if (!id || link.closest('[data-dsm-owned]')) continue;
        mark(link, 'sidebar-row', active === id ? 'active' : '');
        const url = new URL(link.href);
        const title = (link.querySelector(SITE_SELECTORS.rowLabel)?.textContent ?? link.textContent)?.trim();
        rows.push({ link: { id, url: url.origin + url.pathname, title: title?.slice(0, 160) || '未命名对话' }, element: link });
        const tools = link.querySelector<HTMLElement>(SITE_SELECTORS.rowTools);
        if (tools) mark(tools, 'sidebar-tools');
      }
      for (const el of sidebar.querySelectorAll<HTMLElement>('div,span,h2,h3,[role="heading"]')) {
        if (el.childElementCount || el.closest('[data-dsm-owned]')) continue;
        if (/^(今天|昨天|过去\s*(7|30)\s*天|[7３3][0０]?\s*天内|Today|Yesterday|(Previous )?(7|30) days)$/i.test(el.textContent?.trim() ?? '')) mark(el, 'sidebar-group');
      }
      const fade = sidebar.querySelector<HTMLElement>('._1d72f01');
      if (fade) mark(fade, 'sidebar-fade');
    } else sidebar = undefined;
    for (const [name, elements] of this.sidebarMarks) {
      for (const element of elements) if (!marks.get(name)?.has(element)) element.removeAttribute(name);
    }
    this.sidebarMarks = marks;
    this.sidebarLayout = { sidebar, history, newChat, rows };
  }

  markLayout(composer = this.composer(), nodes = this.messages()): SiteLayout | undefined {
    if (!composer) return;
    for (const [node, entry] of displayQuotes) if (!node.isConnected) {
      if (node.data === entry.display) node.data = entry.original;
      displayQuotes.delete(node);
    }
    const marks = new Map<string, Set<HTMLElement>>();
    const mark = (el: HTMLElement, name: string, value = '') => {
      const attr = `data-dsm-${name}`;
      if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
      let elements = marks.get(attr);
      if (!elements) marks.set(attr, elements = new Set());
      elements.add(el);
    };
    mark(composer, 'composer');
    const composerBox = composer.closest<HTMLElement>(SITE_SELECTORS.knownComposer) ?? composer.closest<HTMLElement>(SITE_SELECTORS.inputWrapper);
    if (composerBox) mark(composerBox, 'composer-box');
    const root = document.getElementById('root') ?? document.getElementById('__next');
    if (root) mark(root, 'app');
    const newChat = this.controls.newChat();
    if (newChat) mark(newChat, 'new-chat');
    const message = nodes.find(({ message }) => message.role === 'assistant') ?? nodes[0];
    const item = message?.element.closest<HTMLElement>(SITE_SELECTORS.messageItem);
    let column: HTMLElement | undefined;
    let scroll: HTMLElement | undefined;
    for (let element = item?.parentElement; element && element !== root && !element.contains(composer); element = element.parentElement) {
      const style = getComputedStyle(element);
      if (!column && style.maxWidth !== 'none') column = element;
      if (/^(auto|scroll)$/.test(style.overflowY)) {
        scroll = element;
        break;
      }
    }
    if (column) mark(column, 'reading-column');
    if (scroll) mark(scroll, 'scroll');
    let scrollShell: HTMLElement | undefined, fixedComposer: HTMLElement | undefined;
    if (composerBox) {
      for (let el: HTMLElement | null = composerBox; el && el !== root && el !== document.body; el = el.parentElement) {
        if (scroll && el.contains(scroll)) break;
        if (getComputedStyle(el).position === 'fixed') { fixedComposer = el; mark(el, 'fixed-composer'); break; }
      }
    }
    if (composerBox && scroll) {
      for (let el = scroll; el.parentElement && el !== root; el = el.parentElement) {
        if (!el.parentElement.contains(composerBox)) continue;
        const workspace = el.parentElement;
        const style = getComputedStyle(workspace);
        mark(workspace, 'workspace');
        if (style.display.includes('flex') && style.flexDirection === 'column' && getComputedStyle(el).position !== 'absolute') {
          scrollShell = el;
          mark(el, 'scroll-shelf', fixedComposer ? 'fixed' : 'flow');
        }
        // A fixed editor is positioned against the viewport. Regular editors
        // keep their native layout and only share the reading measure.
        const editorArea = composerBox.parentElement;
        if (column && fixedComposer) mark(scroll, 'chat-gutter');
        if (column && !fixedComposer && (editorArea === workspace || editorArea?.parentElement === workspace)) {
          mark(scroll, 'chat-gutter');
          if (editorArea !== workspace && editorArea) mark(editorArea, 'chat-gutter');
          mark(composerBox, 'composer-aligned', editorArea === workspace ? 'standalone' : 'wrapped');
        }
        break;
      }
    }
    const header = [...(root ?? document).querySelectorAll<HTMLElement>(SITE_SELECTORS.header)]
      .find(el => !el.closest('[data-dsm-sidebar],[data-dsm-owned]') && !el.contains(composer) && (!scroll || !scroll.contains(el)));
    if (header) mark(header, 'header');
    const nativeBottom = (root ?? document).querySelector<HTMLElement>(SITE_SELECTORS.scrollBottom) ?? undefined;
    for (const [name, elements] of this.layoutMarks) for (const el of elements) {
      if (!marks.get(name)?.has(el)) el.removeAttribute(name);
    }
    this.layoutMarks = marks;
    return composerBox ? { composerBox, scroll, column, scrollShell, fixedComposer, header, nativeBottom } : undefined;
  }
  unmark(): void {
    for (const [name, elements] of this.layoutMarks) for (const el of elements) el.removeAttribute(name);
    this.layoutMarks.clear();
    for (const [name, elements] of this.sidebarMarks) for (const element of elements) element.removeAttribute(name);
    this.sidebarMarks.clear();
    this.sidebarLayout = { rows: [] };
    for (const el of this.controlMarks) for (const name of ['mode','mode-state','send']) el.removeAttribute(`data-dsm-${name}`);
    this.controlMarks.clear();
    for (const [node, entry] of displayQuotes) if (node.data === entry.display) node.data = entry.original;
    displayQuotes.clear();
    for (const el of document.querySelectorAll('[data-dsm-message],[data-dsm-message-container],[data-dsm-highlight]')) {
      for (const name of ['message','message-container','highlight']) el.removeAttribute(`data-dsm-${name}`);
    }
  }
}

const visible=(el:Element)=>!el.closest('[data-dsm-owned]')&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
export class NativeControls{
  constructor(readonly adapter:SiteAdapter){}
  private first(selector:string,root:ParentNode=document){return [...root.querySelectorAll<HTMLElement>(selector)].find(visible)??null;}
  private inputRoot(){
    const composer=this.adapter.composer();
    return composer?.closest(SITE_SELECTORS.knownComposer)??composer?.closest(SITE_SELECTORS.inputWrapper)??document;
  }
  private labelled(regex:RegExp){return [...document.querySelectorAll<HTMLElement>(SITE_SELECTORS.controls)].filter(visible).find(el=>regex.test([el.getAttribute('aria-label'),el.getAttribute('title'),el.textContent?.trim()].filter(Boolean).join(' ').trim()))??null;}
  newChat(){
    const explicit=this.first(SITE_SELECTORS.newChat)??this.labelled(/^(开启新对话|New chat)(?:\s|$)/i);if(explicit)return explicit;
    const leaf=[...document.querySelectorAll<HTMLElement>('span,div')].find(el=>el.childElementCount===0&&/^(开启新对话|New chat)$/.test(el.textContent?.trim()??'')&&visible(el));
    const parent=leaf?.parentElement;return parent&&getComputedStyle(parent).cursor==='pointer'?parent:null;
  }
  main(){const root=this.inputRoot();return this.first(SITE_SELECTORS.mainButton,root)??this.first(SITE_SELECTORS.send,root)??this.first(SITE_SELECTORS.stop,root);}
  send(){
    const explicit=this.first(SITE_SELECTORS.send,this.inputRoot());if(explicit)return explicit;
    const main=this.main();return main&&[...main.querySelectorAll('path')].some(p=>p.getAttribute('d')?.startsWith(SITE_SELECTORS.sendPath))?main:null;
  }
  stop(){
    const explicit=this.first(SITE_SELECTORS.stop,this.inputRoot());if(explicit)return explicit;
    const main=this.main();return main&&[...main.querySelectorAll('path')].some(p=>p.getAttribute('d')?.startsWith(SITE_SELECTORS.stopPath))?main:null;
  }
  disabled(el:HTMLElement){return el.matches(':disabled,[aria-disabled="true"],.ds-button--disabled,.ds-toggle-button--disabled')||el.classList.contains('bd74640a');}
  generation():'idle'|'generating'|'unknown'{if(this.stop())return 'generating';if(this.send())return 'idle';return 'unknown';}
  followTail() {
    const container = this.first(SITE_SELECTORS.scrollBottom);
    const button = container?.matches('button,[role="button"]') ? container : container?.querySelector<HTMLElement>('button,[role="button"]');
    if (button && visible(button) && !this.disabled(button)) button.click();
  }
  revealPreceding(answer: HTMLElement) {
    // Start of the virtual assistant row, with room above it for the user bubble.
    const row = answer.closest(SITE_SELECTORS.messageItem) ?? answer;
    for (let scroll = row.parentElement; scroll; scroll = scroll.parentElement) {
      if (!/^(auto|scroll)$/.test(getComputedStyle(scroll).overflowY) || scroll.scrollHeight <= scroll.clientHeight) continue;
      const gap = Math.min(160, scroll.clientHeight / 3);
      scroll.scrollBy({ top: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - gap, behavior: 'instant' });
      break;
    }
  }
  interruptsExecution(target:EventTarget|null){
    if(!(target instanceof Node))return false;
    return [this.newChat(),this.send(),this.stop(),this.mode('think'),this.mode('search')].some(control=>control?.contains(target));
  }
  mode(kind:'think'|'search'){
    const aliases=kind==='think'?/深度思考|DeepThink|Thinking/i:/智能搜索|联网搜索|^Search$/i;
    return [...this.inputRoot().querySelectorAll<HTMLElement>('.ds-toggle-button,[aria-pressed],[data-native-mode]')].find(el=>(aliases.test(el.textContent?.trim()??'')||aliases.test(el.getAttribute('aria-label')??'')||el.getAttribute('data-native-mode')===kind)&&visible(el))??null;
  }
  readMode(kind:'think'|'search') {
    const element = this.mode(kind);
    const state = element?.getAttribute('aria-pressed');
    const pressed = state === 'true' || state === 'false' ? state === 'true'
      : element?.classList.contains('ds-toggle-button') ? element.classList.contains('ds-toggle-button--selected') : null;
    return { element, pressed };
  }
  modeState(kind:'think'|'search'):boolean|null { return this.readMode(kind).pressed; }
  activity(){return [...document.querySelectorAll<HTMLElement>(SITE_SELECTORS.thinking)].filter(visible).some(el=>{const text=el.innerText.trim();return text.length<80&&/^(搜索中|思考中|Searching|Thinking)(?:[.\s…]|$)/i.test(text);});}
  error():{code:'busy'|'blocked';message:string}|null{
    for(const el of [...document.querySelectorAll<HTMLElement>(SITE_SELECTORS.alerts)].filter(visible)){
      const text=el.innerText.trim().slice(0,500);
      if(/服务(?:器)?(?:暂时)?(?:繁忙|不可用)|server.{0,20}(busy|unavailable)|搜索过于频繁|请求频率过高|并发请求过多|too many (?:concurrent )?requests/i.test(text))return {code:'busy',message:text};
      if(/验证码|验证您|verify you|captcha|访问受限|账号.*(?:异常|限制)|登录.*(?:失效|过期)|消息未能发送|网络异常|新建对话失败|创建会话失败|unable to send|network error/i.test(text))return {code:'blocked',message:text};
    }return null;
  }
}
