import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { conversationId } from '../shared/model';
import { viewportBounds, watchAnchor, watchOutsideInteraction } from './floating';
import { Icon } from './icons';
import { SideQuestionAnswer } from './side-question-math';
import sideQuestionCss from './side-questions.css?inline';

type AnchorRect = () => DOMRectReadOnly | undefined;
type Position = { left: number; top: number };

export interface SideQuestionSelection {
  rect: AnchorRect;
}

export interface SideQuestionSheet {
  id: string;
  quote: string;
  rect?: AnchorRect;
  messages: readonly { id: string; role: 'user' | 'assistant'; text: string }[];
  starting?: boolean;
  pending?: boolean;
  search?: boolean;
  status?: string;
  error?: string;
  disabled?: boolean;
  canRetry?: boolean;
  onRetry?: () => void;
  nativeUrl?: string;
}

export interface SideQuestionList {
  title: string;
  rect: AnchorRect;
  items: readonly { id: string; title: string; status?: string }[];
  trigger?: HTMLElement;
  loading?: boolean;
}

export interface SideQuestionsProps {
  selection?: SideQuestionSelection;
  sheet?: SideQuestionSheet;
  list?: SideQuestionList;
  onSelect: (search: boolean) => void;
  onOpen: (id: string) => void;
  onCloseSheet: (restoreFocus?: boolean) => void;
  onCloseList: () => void;
  onCloseSelection?: () => void;
  onPreview?: (id?: string) => void;
  onSend: (text: string, search: boolean) => Promise<void> | void;
}

const EDGE = 12;
const GAP = 9;
const SHEET_WIDTH = 448;
const SHEET_HEIGHT = 540;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(value, maximum));
const INTERACTIVE = 'a[href],button,input,textarea,select,label,summary,img,video,canvas,svg,[contenteditable],[data-dsm-owned],[role="button"],[role="link"],[role="option"],[role="combobox"],[role="switch"],[role="checkbox"],[role^="menuitem"]';

export function pageTextAtPoint(event: MouseEvent): Range | undefined {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  const node = caret?.startContainer;
  if (!caret || !(node instanceof Text)) return;
  const glyph = document.createRange();
  for (const offset of [caret.startOffset - 1, caret.startOffset]) {
    if (offset < 0 || offset >= node.length || !node.data[offset].trim()) continue;
    glyph.setStart(node, offset);
    glyph.setEnd(node, offset + 1);
    if ([...glyph.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom)) return glyph;
  }
}

function positionLayer(layer: HTMLElement, left: number, top: number, width = layer.offsetWidth, height = layer.offsetHeight): Position {
  const bounds = viewportBounds();
  const point = {
    left: clamp(left, bounds.left + EDGE, bounds.right - width - EDGE),
    top: clamp(top, bounds.top + EDGE, bounds.bottom - height - EDGE),
  };
  layer.style.transform = 'translate3d(' + point.left + 'px,' + point.top + 'px,0)';
  layer.dataset.positioned = '';
  return point;
}

function visibleRect(read: AnchorRect | undefined) {
  const rect = read?.();
  const bounds = viewportBounds();
  return rect && rect.bottom >= bounds.top && rect.top <= bounds.bottom &&
    rect.right >= bounds.left && rect.left <= bounds.right ? rect : undefined;
}

function stopEscape(event: KeyboardEvent, dismiss: () => void) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  dismiss();
}

function SelectionButton({ selection, select, close }: {
  selection: SideQuestionSelection; select: SideQuestionsProps['onSelect']; close?: () => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = group.current;
    if (!layer) return;
    return watchAnchor(layer, () => {
      const rect = visibleRect(selection.rect);
      if (!rect) {
        delete layer.dataset.positioned;
        return;
      }
      const height = layer.offsetHeight;
      const above = rect.top - GAP - height;
      positionLayer(layer, rect.left, above >= viewportBounds().top + EDGE ? above : rect.bottom + GAP);
    });
  }, [selection.rect]);
  useLayoutEffect(() => {
    if (!close) return;
    const escape = (event: KeyboardEvent) => stopEscape(event, close);
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [close]);
  return <div ref={group} class="sq-selection sq-layer" role="group" aria-label="划词旁问" data-dsm-side-selection
    onPointerDown={event => event.preventDefault()}>
    <button type="button" title="快速旁问" onClick={() => select(false)}><Icon name="prompt" size={14}/>旁问</button>
    <button type="button" onClick={() => select(true)}><Icon name="search" size={14}/>联网旁问</button>
  </div>;
}

function ThreadList({ list, close, open, preview }: {
  list: SideQuestionList;
  close: () => void;
  open: (id: string) => void;
  preview?: (id?: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const firstFocusPending = useRef(true);
  const props = useRef({ list, close, preview });
  props.current = { list, close, preview };
  useLayoutEffect(() => {
    const layer = panel.current;
    if (!layer) return;
    const measure = () => {
      const rect = visibleRect(props.current.list.rect);
      if (!rect) {
        delete layer.dataset.positioned;
        return;
      }
      const bounds = viewportBounds();
      layer.style.width = Math.max(0, Math.min(236, bounds.right - bounds.left - EDGE * 2)) + 'px';
      layer.style.maxHeight = Math.max(0, Math.min(310, bounds.bottom - bounds.top - EDGE * 2)) + 'px';
      const right = rect.right + GAP;
      const fitsRight = right + layer.offsetWidth <= bounds.right - EDGE;
      positionLayer(layer, fitsRight ? right : rect.right - layer.offsetWidth, fitsRight ? rect.top : rect.bottom + GAP);
    };
    const stop = watchAnchor(layer, measure);
    const trigger = list.trigger;
    const stopTrigger = trigger && trigger.getRootNode() !== layer.getRootNode() ? watchAnchor(trigger, measure) : undefined;
    const dismiss = () => {
      props.current.preview?.();
      props.current.close();
    };
    const outside = watchOutsideInteraction(layer, (_event, path) => {
      const trigger = props.current.list.trigger;
      return Boolean(trigger && path.includes(trigger));
    }, dismiss);
    const escape = (event: KeyboardEvent) => stopEscape(event, () => {
      dismiss();
      props.current.list.trigger?.focus({ preventScroll: true });
    });
    const visibility = trigger && new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) dismiss(); });
    if (visibility && trigger) visibility.observe(trigger);
    document.addEventListener('keydown', escape, true);
    return () => {
      stop();
      stopTrigger?.();
      visibility?.disconnect();
      outside();
      document.removeEventListener('keydown', escape, true);
    };
  }, [list.trigger]);
  useLayoutEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>('[data-dsm-side-thread]');
    if (!firstFocusPending.current || !first) return;
    firstFocusPending.current = false;
    first.focus({ preventScroll: true });
  }, [list.items.length]);
  return <nav ref={panel} class="sq-list sq-acrylic sq-layer" data-dsm-side-list aria-label={list.title + '的旁问'}>
    <header class="sq-list-heading"><strong>{list.title}</strong><span>{list.items.length} 条旁问</span></header>
    <div class="sq-list-items">
      {!list.items.length && <p class="sq-list-empty" role="status">{list.loading ? '正在读取旁问…' : '暂无旁问'}</p>}
      {list.items.map(item => <button key={item.id} type="button" data-dsm-side-thread
        onFocus={() => preview?.(item.id)} onBlur={() => preview?.()}
        onMouseEnter={() => preview?.(item.id)} onMouseLeave={() => preview?.()}
        onClick={() => { preview?.(); open(item.id); }}>
        <Icon name="prompt" size={14}/><span>{item.title}</span>{item.status && <small>{item.status}</small>}
      </button>)}
    </div>
  </nav>;
}

type Drag = {
  pointer: number;
  origin: Position;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

function SideSheet({ sheet, close, send, listOpen }: {
  sheet: SideQuestionSheet;
  close: SideQuestionsProps['onCloseSheet'];
  send: SideQuestionsProps['onSend'];
  listOpen: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const followsEnd = useRef(false);
  const drag = useRef<Drag>();
  const manual = useRef<Position>();
  const submitting = useRef(false);
  const latest = useRef({ sheet, close, listOpen });
  latest.current = { sheet, close, listOpen };
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState(sheet.search === true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const blocked = Boolean(sheet.starting || sheet.pending || sheet.disabled || sending || !draft.trim());
  const generating = sheet.pending || (sheet.starting && !sheet.error);
  const shortQuote = Array.from(sheet.quote).length <= 8;
  const placeholder = shortQuote ? '关于「' + sheet.quote + '」，想问什么…' : '关于这段话，想问什么…';
  const checkedUrl = sheet.nativeUrl && conversationId(sheet.nativeUrl) ? new URL(sheet.nativeUrl) : null;
  const nativeUrl = checkedUrl ? checkedUrl.origin + checkedUrl.pathname : undefined;

  useLayoutEffect(() => {
    const layer = panel.current;
    if (!layer) return;
    const measure = () => {
      if (drag.current) return;
      const bounds = viewportBounds();
      const width = Math.max(0, Math.min(SHEET_WIDTH, bounds.right - bounds.left - EDGE * 2));
      layer.style.width = width + 'px';
      layer.style.maxHeight = Math.max(0, Math.min(SHEET_HEIGHT, bounds.bottom - bounds.top - EDGE * 2)) + 'px';
      if (manual.current) {
        positionLayer(layer, manual.current.left, manual.current.top);
        return;
      }
      const rect = visibleRect(latest.current.sheet.rect);
      const height = layer.offsetHeight;
      if (!rect) {
        positionLayer(layer, bounds.right - width - 68, bounds.top + 72);
        return;
      }
      const above = rect.top - height - GAP;
      const beside = rect.right + GAP;
      const below = rect.bottom + GAP;
      const center = (rect.left + rect.right - width) / 2;
      if (above >= bounds.top + EDGE) positionLayer(layer, center, above);
      else if (beside + width <= bounds.right - EDGE) positionLayer(layer, beside, rect.top - EDGE);
      else positionLayer(layer, center, below + height <= bounds.bottom - EDGE ? below : above);
    };
    const stop = watchAnchor(layer, measure);
    const escape = (event: KeyboardEvent) => {
      if (latest.current.listOpen) return;
      if (event.composedPath().includes(layer)) stopEscape(event, latest.current.close);
    };
    let listWasOpen = false;
    const rememberList = () => { listWasOpen = latest.current.listOpen; };
    const outside = (event: MouseEvent) => {
      const keepSheet = listWasOpen || latest.current.listOpen;
      listWasOpen = false;
      if (keepSheet || event.button !== 0 || event.detail === 0 || event.defaultPrevented) return;
      const path = event.composedPath();
      if (path.includes(layer) || path.some(node => node instanceof Element && node.matches(INTERACTIVE))) return;
      if (document.getSelection()?.isCollapsed === false || pageTextAtPoint(event)) return;
      latest.current.close(false);
    };
    document.addEventListener('keydown', escape, true);
    window.addEventListener('pointerdown', rememberList, true);
    document.addEventListener('click', outside, true);
    (textarea.current ?? layer).focus({ preventScroll: true });
    return () => {
      stop();
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerdown', rememberList, true);
      document.removeEventListener('click', outside, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (followsEnd.current && history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [sheet.messages.length, sheet.messages.at(-1)?.text, sheet.pending]);

  const submit = async () => {
    if (blocked || submitting.current) return;
    const text = draft.trim();
    submitting.current = true;
    followsEnd.current = true;
    setSending(true);
    setSendError('');
    try {
      await send(text, search);
      setDraft(previous => previous === draft ? '' : previous);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '旁问发送失败，请重试');
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  const beginDrag = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || !panel.current || drag.current) return;
    if (event.target instanceof Element && event.target.closest('.sq-close,.sq-quote')) return;
    const rect = panel.current.getBoundingClientRect();
    drag.current = {
      pointer: event.pointerId,
      origin: { left: rect.left, top: rect.top },
      offsetX: event.clientX,
      offsetY: event.clientY,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    panel.current.dataset.dragging = '';
    event.preventDefault();
  };
  const moveDrag = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId || !panel.current) return;
    manual.current = positionLayer(panel.current,
      start.origin.left + event.clientX - start.offsetX, start.origin.top + event.clientY - start.offsetY, start.width, start.height);
  };
  const endDrag = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (!panel.current) return;
    delete panel.current.dataset.dragging;
    if (manual.current) manual.current = positionLayer(panel.current, manual.current.left, manual.current.top);
  };
  const moveWithKeys = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    const layer = panel.current;
    if (!layer || event.isComposing) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const rect = layer.getBoundingClientRect();
    const step = event.shiftKey ? 32 : 12;
    manual.current = positionLayer(layer, rect.left + direction[0] * step, rect.top + direction[1] * step);
  };
  return <section ref={panel} class="sq-sheet sq-acrylic sq-layer" data-dsm-side-sheet
    role="dialog" aria-label="旁问" tabIndex={-1}>
    <header class="sq-sheet-heading" onPointerDown={beginDrag} onPointerMove={moveDrag}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      {shortQuote ? <h2 class="sq-heading-text">{sheet.quote}</h2> :
        <blockquote class="sq-quote" aria-label="引用原文"><p>{sheet.quote}</p></blockquote>}
      <div class="sq-heading-actions">
        <button type="button" class="sq-grip" aria-label="移动旁问浮层，使用方向键" title="拖动旁问浮层"
          onKeyDown={moveWithKeys}><Icon name="more" size={17}/></button>
        <button type="button" class="sq-close" aria-label="收起旁问" title="收起旁问" onClick={() => close()}>
          <Icon name="close" size={16}/>
        </button>
      </div>
    </header>
    <div ref={history} class="sq-messages" aria-label="旁问记录" role="log"
      onScroll={event => {
        const node = event.currentTarget;
        followsEnd.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
      }}>
      {sheet.messages.map(message => message.role === 'user' ?
        <p key={message.id} class="sq-asked"><span class="sr-only">我：</span>{message.text}</p> :
        <div key={message.id} class="sq-replied">
          <span class="sr-only">DeepSeek：</span>
          <SideQuestionAnswer text={message.text}/>
        </div>)}
    </div>
    {(sheet.status || generating) && <p class="sq-status" role="status">
      {generating && <Icon name="clock" size={13}/>}
      {sheet.status || '正在通过 DeepSeek 网页生成…'}
    </p>}
    {(sheet.error || sendError) && <div class="sq-error" role="alert">
      <Icon name="alert" size={14}/><span>{sheet.error || sendError}</span>
    </div>}
    {(nativeUrl || (sheet.canRetry && sheet.onRetry)) && <div class="sq-recovery">
      {sheet.canRetry && sheet.onRetry && <button type="button" class="sq-retry" onClick={sheet.onRetry}>重试</button>}
      {nativeUrl && <a href={nativeUrl} target="_blank" rel="noopener noreferrer">打开原网页会话 <Icon name="external" size={13}/></a>}
    </div>}
    {!sheet.starting && <form class="sq-compose" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea ref={textarea} aria-label="旁问输入框" placeholder={placeholder} rows={1} value={draft}
        onInput={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          void submit();
        }}/>
      <button type="button" class="sq-search" aria-label="联网搜索" aria-pressed={search}
        title="切换本次追问的联网搜索" disabled={sheet.pending || sheet.disabled || sending}
        onClick={() => setSearch(!search)}>
        <Icon name="search" size={14}/>联网
      </button>
      <button type="submit" class="sq-send" disabled={blocked} aria-label="发送旁问" title="发送旁问">
        <span class="sq-up"><Icon name="down" size={17}/></span>
      </button>
    </form>}
  </section>;
}

export function SideQuestions(props: SideQuestionsProps) {
  const { selection, sheet, list } = props;
  return <>
    <style>{sideQuestionCss}</style>
    {selection && !list && <SelectionButton selection={selection} select={props.onSelect} close={props.onCloseSelection}/>}
    {sheet && <SideSheet key={sheet.id} sheet={sheet} listOpen={Boolean(list)} close={props.onCloseSheet} send={props.onSend}/>}
    {list && <ThreadList key={list.trigger?.dataset.dsmSideParent ?? list.title} list={list} close={props.onCloseList} open={props.onOpen} preview={props.onPreview}/>}
  </>;
}
