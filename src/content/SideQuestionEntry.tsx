import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Controller } from './controller';
import { domToMarkdown, domToText, type MessageNode } from './adapter';
import { fingerprint } from '../shared/model';
import { rpc } from '../shared/rpc';
import type { SideQuestionAnchor, SideQuestionThread } from '../sidequestions/model';
import { readSideQuestionTurnId } from '../sidequestions/marker';
import { pageTextAtPoint, SideQuestions } from '../ui/SideQuestions';
import badgeCss from './side-question-badges.css?inline';

interface Summary { parents: Record<string, number>; nativeConversationIds: string[] }
interface Parent { id: string; url: string; title: string }
interface Selection { parent: Parent; anchor: SideQuestionAnchor; range: Range }
interface Sheet { id: string; parent: Parent; anchor: SideQuestionAnchor; thread?: SideQuestionThread; auto?: boolean; search?: boolean }
interface List { parent: Parent; row: HTMLElement; trigger: HTMLElement; threads?: SideQuestionThread[] }
interface Badge { parent: Parent; row: HTMLAnchorElement; x: number; y: number; count: number }
interface Reference { id: string; anchor: SideQuestionAnchor }
const EMPTY: Summary = { parents: {}, nativeConversationIds: [] };
const HIGHLIGHT = 'dsm-side-question';
const PREVIEW = 'dsm-side-question-preview';
const REFERENCES_HIGHLIGHT = 'dsm-side-question-references';
const EXPLAIN_SELECTION = '用简洁的中文解释选中内容在原句中的含义。先给结论，再用必要的推导或一个短例子讲清楚，涉及公式时说明关键符号。';
const LEGACY_EXPLAIN_SELECTION = '请深入讲解我选中的内容在当前语境里是什么意思。先交代理解它需要的前提，再解释原句为什么成立，把关键的推导步骤或因果关系讲清楚，并给一个简短的例子。遇到数学内容时，说明关键符号和每一步的依据。如果上下文不足、存在歧义或原句有错，请明确指出。';
const EXCLUDED = '[data-dsm-owned],.ds-think-content,button,[role="button"]';
const asElement = (node: Node) => node instanceof Element ? node : node.parentElement;

function selectionInMessage(c: Controller): Selection | undefined {
  const current = c.state.current;
  const selection = document.getSelection();
  if (!current || current.id !== c.adapter.id() || !selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const first = asElement(range.startContainer), last = asElement(range.endContainer);
  if (!first || !last || first.closest(EXCLUDED) || last.closest(EXCLUDED)) return;
  const source = first.closest('[data-dsm-message]');
  const node = c.state.nodes.find(n => n.element === source);
  if (!node || !node.element.contains(range.endContainer)) return;
  if ([...node.element.querySelectorAll(EXCLUDED)].some(element => range.intersectsNode(element))) return;
  const raw = range.toString();
  const quote = raw.trim();
  if (!quote || quote.length > 6000) return;
  const prefix = document.createRange();
  prefix.selectNodeContents(node.element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length + raw.length - raw.trimStart().length;
  if (start + quote.length > 1_000_000) return;
  const block = first.closest('p,li,blockquote,pre,h1,h2,h3,h4,h5,h6');
  const context = block && node.element.contains(block) && block.contains(last) ? domToText(block).slice(0, 3000) : '';
  return {
    parent: { id: current.id, url: current.url, title: current.title },
    anchor: { messageId: node.message.id, fingerprint: fingerprint(domToText(node.element)), quote, start, end: start + quote.length, ...(context && context !== quote ? { context } : {}) },
    range: range.cloneRange(),
  };
}

function locateAnchor(c: Controller, parentId: string, anchor: SideQuestionAnchor): { node: MessageNode; range?: Range } | undefined {
  if (c.adapter.id() !== parentId) return;
  const node = c.state.nodes.find(n => n.element.isConnected && n.message.id === anchor.messageId && n.message.fingerprint === anchor.fingerprint);
  if (!node) return;
  return { node, range: locateRange(node.element, anchor) };
}

function locateRange(element: HTMLElement, anchor: SideQuestionAnchor) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0, started = false;
  for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
    const end = offset + text.length;
    if (!started && anchor.start < end) {
      range.setStart(text, anchor.start - offset);
      started = true;
    }
    if (started && anchor.end <= end) {
      range.setEnd(text, anchor.end - offset);
      return range.toString() === anchor.quote ? range : undefined;
    }
    offset = end;
  }
}

function rectOf(range?: Range) {
  if (!range?.startContainer.isConnected || !range.endContainer.isConnected) return;
  return [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
}

function BodyReferences({ c, parentId, onOpen }: {
  c: Controller; parentId: string; onOpen: (id: string) => void;
}) {
  const [references, setReferences] = useState<Reference[]>([]);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    let run = 0;
    const refresh = () => {
      const request = ++run;
      void rpc<Reference[]>('side.references', { parentId }).then(next => {
        if (request !== run || parentId !== c.adapter.id()) return;
        setReferences(previous => previous.length === next.length && next.every(({ id, anchor }, index) => {
          const old = previous[index];
          return old.id === id && old.anchor.messageId === anchor.messageId && old.anchor.fingerprint === anchor.fingerprint &&
            old.anchor.start === anchor.start && old.anchor.end === anchor.end && old.anchor.quote === anchor.quote;
        }) ? previous : next);
      }).catch(() => {});
    };
    const change = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes['ds-margin:dataEpoch'] || changes['ds-margin:sideReferenceEpoch'])) refresh();
    };
    chrome.storage.onChanged.addListener(change);
    refresh();
    return () => { run++; chrome.storage.onChanged.removeListener(change); };
  }, [c, parentId]);

  useLayoutEffect(() => {
    if (!references.length) return;
    let sourceNodes: MessageNode[] | undefined;
    const marks = globalThis.CSS?.highlights && typeof Highlight !== 'undefined' ? new Highlight() : undefined;
    if (marks) CSS.highlights.set(REFERENCES_HIGHLIGHT, marks);
    const anchors = new Map<HTMLElement, { reference: Reference; range: Range }[]>();
    const mutations = new MutationObserver(records => {
      // Wait for the controller to fingerprint the new DOM before reusing an anchor.
      for (const record of records) {
        const target = asElement(record.target);
        if (!target || target.closest('[data-dsm-owned]')) continue;
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes]
          .every(node => node instanceof Element && node.matches('[data-dsm-owned]'))) continue;
        const element = target.closest<HTMLElement>('[data-dsm-message]');
        const items = element && anchors.get(element);
        if (element && items) {
          for (const { range } of items) marks?.delete(range);
          anchors.delete(element);
        }
      }
    });
    const sync = () => {
      if (sourceNodes === c.state.nodes) return;
      sourceNodes = c.state.nodes;
      anchors.clear();
      marks?.clear();
      mutations.disconnect();
      if (!c.state.active || c.adapter.id() !== parentId) return;
      const messages = new Map(sourceNodes.filter(node => node.element.isConnected).map(node => [node.message.id, node]));
      references.forEach(reference => {
        const { anchor } = reference;
        const node = messages.get(anchor.messageId);
        if (!node || node.message.fingerprint !== anchor.fingerprint) return;
        const range = locateRange(node.element, anchor);
        if (!range) return;
        const items = anchors.get(node.element);
        if (items) items.push({ reference, range });
        else anchors.set(node.element, [{ reference, range }]);
        marks?.add(range);
      });
      for (const element of anchors.keys()) mutations.observe(element, { subtree: true, characterData: true, childList: true });
    };
    const open = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
          !c.state.active || c.adapter.id() !== parentId || document.getSelection()?.isCollapsed === false) return;
      const target = asElement(event.target as Node);
      if (!target || target.closest(`${EXCLUDED},a,input,textarea,select`)) return;
      const element = target.closest<HTMLElement>('[data-dsm-message]');
      const items = element && anchors.get(element);
      if (!element || !items) return;
      const glyph = pageTextAtPoint(event);
      if (!glyph) return;
      for (let index = items.length - 1; index >= 0; index--) {
        const { reference, range } = items[index];
        if (range.isPointInRange(glyph.startContainer, glyph.startOffset) && range.isPointInRange(glyph.endContainer, glyph.endOffset)) {
          openRef.current(reference.id);
          return;
        }
      }
    };
    const stop = c.subscribe(sync);
    document.addEventListener('click', open);
    sync();
    return () => {
      stop(); mutations.disconnect();
      globalThis.CSS?.highlights?.delete(REFERENCES_HIGHLIGHT);
      document.removeEventListener('click', open);
    };
  }, [c, parentId, references]);

  return null;
}

function parentOf(thread: SideQuestionThread): Parent {
  return { id: thread.parentId, url: thread.parentUrl, title: thread.parentTitle };
}

function sameSummary(a: Summary, b: Summary) {
  const ids = Object.keys(a.parents);
  return ids.length === Object.keys(b.parents).length && ids.every(id => a.parents[id] === b.parents[id]) &&
    a.nativeConversationIds.length === b.nativeConversationIds.length &&
    a.nativeConversationIds.every((id, index) => id === b.nativeConversationIds[index]);
}

function updateSheet(value: Sheet | undefined, thread: SideQuestionThread, requestedPreview?: SideQuestionThread['preview']) {
  if (value?.id !== thread.id || (value.thread && thread.updatedAt < value.thread.updatedAt)) return value;
  const currentPreview = value.thread?.preview;
  const turn = thread.turns.at(-1);
  // A push can reach the sheet while a storage snapshot is in flight.
  if (turn?.status === 'pending' && currentPreview?.turnId === turn.id && currentPreview !== requestedPreview)
    return { ...value, thread: { ...thread, preview: currentPreview } };
  return { ...value, thread };
}

function watchRecovery(c: Controller) {
  const attempted = new Set<string>();
  let timer = 0;
  let scheduled = '';
  const read = () => {
    const nodes = c.state.nodes;
    if (!c.state.active || !c.adapter.id() || c.adapter.controls.generation() !== 'idle' || c.adapter.controls.activity()) return;
    for (let index = nodes.length - 2; index >= 0; index--) {
      const user = nodes[index], answer = nodes[index + 1];
      if (user.message.role !== 'user' || answer.message.role !== 'assistant' ||
        !user.element.isConnected || !answer.element.isConnected || !user.message.text.includes('用于识别本次旁问')) continue;
      const turnId = readSideQuestionTurnId(user.message.text);
      if (!turnId) continue;
      if (attempted.has(turnId)) return;
      const url = location.origin + location.pathname;
      const key = [url, turnId, user.message.id, answer.message.id, answer.message.fingerprint].join('/');
      return { key, turnId, url, userMessageId: user.message.id, assistantMessageId: answer.message.id,
        answer: domToMarkdown(answer.element, { delimitMath: true }).slice(0, 120_000) };
    }
  };
  const scan = () => {
    const result = read();
    const key = result?.key ?? '';
    if (key === scheduled) return;
    scheduled = key;
    clearTimeout(timer);
    if (!result) return;
    timer = window.setTimeout(() => {
      if (read()?.key !== result.key) return;
      attempted.add(result.turnId);
      void rpc('side.recover', result).then(scan, () => {});
    }, 900);
  };
  const stop = c.subscribe(scan);
  scan();
  return () => { stop(); clearTimeout(timer); };
}

export function SideQuestionEntry({ c, suspended, renderWorkspace }: {
  c: Controller;
  suspended: boolean;
  renderWorkspace: (hiddenIds: readonly string[], badge: (parent: Parent) => ComponentChildren) => ComponentChildren;
}) {
  const [summary, setSummary] = useState<Summary>(EMPTY);
  const [selection, setSelection] = useState<Selection>();
  const [sheet, setSheet] = useState<Sheet>();
  const [list, setList] = useState<List>();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [route, setRoute] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const request = useRef<{ thread: string; question: string; search: boolean; id: string }>();
  const sheetRef = useRef(sheet);
  const selectionRef = useRef(selection);
  const listRef = useRef(list);
  const referenceRequest = useRef(0);
  const referenceTrigger = useRef<HTMLElement>();
  const anchorRef = useRef<ReturnType<typeof locateAnchor>>();
  const summaryRun = useRef(0);
  sheetRef.current = sheet;
  selectionRef.current = selection;
  listRef.current = list;
  useEffect(() => watchRecovery(c), [c]);

  const refreshSummary = () => {
    const run = ++summaryRun.current;
    void rpc<Summary>('side.summary').then(value => {
      if (run === summaryRun.current) setSummary(previous => sameSummary(previous, value) ? previous : value);
    }).catch(() => {});
  };
  useEffect(() => {
    refreshSummary();
    const change = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes['ds-margin:sideEpoch'] || changes['ds-margin:dataEpoch']) refreshSummary();
      if (changes['ds-margin:sideEpoch']) {
        const opened = listRef.current;
        const active = sheetRef.current;
        if (opened) void rpc<SideQuestionThread[]>('side.list', { parentId: opened.parent.id }).then(threads => {
          setList(value => value?.trigger === opened.trigger ? threads.length ? { ...value, threads } : undefined : value);
        }).catch(() => {});
        if (active?.thread) void rpc<SideQuestionThread | null>('side.get', { id: active.id }).then(thread => {
          setSheet(value => thread ? updateSheet(value, thread, active.thread?.preview) :
            value?.id === active.id ? undefined : value);
        }).catch(() => {});
      }
      if (changes['ds-margin:dataEpoch']) {
        referenceRequest.current++;
        referenceTrigger.current = undefined;
        setSheet(undefined);
        setList(undefined);
        setSelection(undefined);
        request.current = undefined;
      }
    };
    const preview = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message !== 'object') return;
      const { source, action, data } = message as { source?: unknown; action?: unknown; data?: Record<string, unknown> };
      if (source !== 'ds-margin' || action !== 'side.preview' || !data || typeof data !== 'object') return;
      const { threadId, turnId, text } = data;
      if (typeof threadId !== 'string' || typeof turnId !== 'string' ||
        typeof text !== 'string' || !text || text.length > 24_000) return;
      setSheet(value => {
        const thread = value?.thread;
        const turn = thread?.turns.at(-1);
        if (!value || !thread || value.id !== threadId || turn?.id !== turnId ||
          turn.status !== 'pending' || thread.preview?.text === text) return value;
        return { ...value, thread: { ...thread, preview: { turnId, text } } };
      });
    };
    chrome.storage.onChanged.addListener(change);
    chrome.runtime.onMessage.addListener(preview);
    return () => {
      summaryRun.current++;
      chrome.storage.onChanged.removeListener(change);
      chrome.runtime.onMessage.removeListener(preview);
    };
  }, []);

  useLayoutEffect(() => {
    let frame = 0;
    let sidebar: HTMLElement | undefined;
    let history: HTMLElement | undefined;
    let candidates: Omit<Badge, 'x' | 'y'>[] = [];
    let hidden = new Set<HTMLAnchorElement>();
    let counted = new Set<HTMLAnchorElement>();
    const children = new Set(summary.nativeConversationIds);
    const hasSidebarQuestions = children.size > 0 || Object.keys(summary.parents).length > 0;
    const measure = () => {
      frame = 0;
      if (listRef.current && !listRef.current.row.isConnected) setList(undefined);
      if (!candidates.length) {
        setBadges(previous => previous.length ? [] : previous);
        return;
      }
      const side = sidebar?.getBoundingClientRect();
      const clip = history === sidebar ? side : history?.getBoundingClientRect();
      const top = Math.max(0, side?.top ?? 0, clip?.height ? clip.top : 0);
      const bottom = Math.min(innerHeight, side?.bottom ?? innerHeight, clip?.height ? clip.bottom : innerHeight);
      const next: Badge[] = [];
      const seen = new Set<string>();
      for (const badge of candidates) {
        const { row, parent } = badge;
        if (!row.isConnected || seen.has(parent.id)) continue;
        const rect = row.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        if (rect.width < 100 || rect.height < 15 || middle < top || middle > bottom) continue;
        seen.add(parent.id);
        const title = (row.querySelector('[data-native-session-title],.c08e6e93')?.textContent ?? row.innerText).trim().slice(0, 160);
        next.push({ ...badge, parent: { ...parent, title: title || 'DeepSeek 对话' },
          x: Math.round(rect.right - 36), y: Math.round(middle) });
      }
      setBadges(previous => previous.length === next.length && next.every((b, index) => {
        const old = previous[index];
        return old.row === b.row && old.x === b.x && old.y === b.y && old.count === b.count &&
          old.parent.id === b.parent.id && old.parent.url === b.parent.url && old.parent.title === b.parent.title;
      }) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const syncSidebar = () => {
      const layout = c.adapter.sidebarLayout;
      if (sidebar !== layout.sidebar) {
        sidebar?.removeEventListener('scroll', schedule, true);
        sidebar = layout.sidebar;
        sidebar?.addEventListener('scroll', schedule, { capture: true, passive: true });
      }
      history = layout.history;
      const active = c.state.active;
      const id = active ? c.adapter.id() : null;
      setRoute(id);
      const nextHidden = new Set<HTMLAnchorElement>();
      const nextCounted = new Set<HTMLAnchorElement>();
      candidates = [];
      if (active && hasSidebarQuestions) {
        for (const { element: row, link } of layout.rows) {
          if (!row.isConnected) continue;
          if (children.has(link.id) && link.id !== id) {
            nextHidden.add(row);
            if (!hidden.has(row)) row.setAttribute('data-dsm-side-child', '');
          } else if (Object.hasOwn(summary.parents, link.id)) {
            nextCounted.add(row);
            if (!counted.has(row)) row.setAttribute('data-dsm-side-parent', '');
            candidates.push({ row, parent: link, count: summary.parents[link.id] });
          }
        }
      }
      for (const row of hidden) if (!nextHidden.has(row)) row.removeAttribute('data-dsm-side-child');
      for (const row of counted) if (!nextCounted.has(row)) row.removeAttribute('data-dsm-side-parent');
      hidden = nextHidden;
      counted = nextCounted;
      const opened = listRef.current;
      if (opened?.row instanceof HTMLAnchorElement &&
          !candidates.some(badge => badge.row === opened.row && badge.parent.id === opened.parent.id)) {
        setList(value => value?.trigger === opened.trigger ? undefined : value);
      }
      cancelAnimationFrame(frame);
      measure();
    };
    const unsubscribe = c.subscribeSidebar(syncSidebar);
    window.addEventListener('resize', schedule);
    syncSidebar();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      sidebar?.removeEventListener('scroll', schedule, true);
      for (const row of hidden) row.removeAttribute('data-dsm-side-child');
      for (const row of counted) row.removeAttribute('data-dsm-side-parent');
    };
  }, [c, summary]);

  useLayoutEffect(() => {
    referenceRequest.current++;
    referenceTrigger.current = undefined;
    setSheet(undefined);
    setList(undefined);
    setSelection(undefined);
    setError(undefined);
  }, [route]);

  useLayoutEffect(() => { referenceRequest.current++; }, [suspended]);

  useLayoutEffect(() => () => { globalThis.CSS?.highlights?.delete(PREVIEW); }, [list?.parent.id, suspended]);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      if (!c.state.active || suspended) return;
      setSelection(selectionInMessage(c));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerup', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerup', schedule);
    };
  }, [c, suspended]);

  useLayoutEffect(() => {
    anchorRef.current = undefined;
    if (!sheet || suspended) return;
    const update = () => {
      if (anchorRef.current?.range?.startContainer.isConnected && anchorRef.current.range.endContainer.isConnected) return;
      anchorRef.current = locateAnchor(c, sheet.parent.id, sheet.anchor);
      if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
      const range = anchorRef.current?.range;
      if (range) CSS.highlights.set(HIGHLIGHT, new Highlight(range));
      else CSS.highlights.delete(HIGHLIGHT);
    };
    update();
    const stop = c.subscribe(update);
    return () => { stop(); globalThis.CSS?.highlights?.delete(HIGHLIGHT); };
  }, [c, sheet?.id, sheet?.anchor, sheet?.parent.id, suspended]);

  const pending = sheet?.thread?.turns.at(-1)?.status === 'pending';
  useEffect(() => {
    if (!pending || !sheet) return;
    const id = sheet.id;
    let cancelled = false, busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const requestedPreview = sheetRef.current?.thread?.preview;
        const thread = await rpc<SideQuestionThread | null>('side.get', { id });
        if (!cancelled && thread) setSheet(value => updateSheet(value, thread, requestedPreview));
        else if (!cancelled && !thread) setSheet(value => value?.id === id ? undefined : value);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '暂时无法读取旁问进度');
      } finally { busy = false; }
    };
    const interval = window.setInterval(() => { void poll(); }, 650);
    return () => { cancelled = true; clearInterval(interval); };
  }, [pending, sheet?.id]);

  const openList = (parent: Parent, row: HTMLElement, trigger: HTMLElement) => {
    referenceRequest.current++;
    if (listRef.current?.trigger === trigger) { setList(undefined); return; }
    const opened = { parent, row, trigger };
    listRef.current = opened;
    setList(opened);
    void rpc<SideQuestionThread[]>('side.list', { parentId: parent.id }).then(threads => {
      setList(value => value?.trigger === trigger ? { ...value, threads } : value);
    }).catch(cause => { setList(value => value?.trigger === trigger ? undefined : value); c.notifyError(cause); });
  };
  const openThread = (thread: SideQuestionThread, trigger?: HTMLElement) => {
    referenceRequest.current++;
    referenceTrigger.current = trigger;
    setList(undefined);
    setSelection(undefined);
    setError(undefined);
    const location = locateAnchor(c, thread.parentId, thread.anchor);
    if (location) {
      const r = location.node.element.getBoundingClientRect();
      if (r.bottom < 64 || r.top > innerHeight - 64) location.node.element.scrollIntoView({ block: 'center' });
    }
    setSheet({ id: thread.id, parent: parentOf(thread), anchor: thread.anchor, thread });
  };
  const openReference = (id: string) => {
    const request = ++referenceRequest.current;
    void rpc<SideQuestionThread | null>('side.get', { id }).then(thread => {
      if (request === referenceRequest.current && thread?.parentId === c.adapter.id() && c.state.active) openThread(thread);
    }).catch(cause => { if (request === referenceRequest.current) c.notifyError(cause); });
  };
  const openSelected = (search: boolean) => {
    const chosen = selectionRef.current;
    if (!chosen || chosen.parent.id !== c.adapter.id()) return;
    referenceRequest.current++;
    referenceTrigger.current = undefined;
    selectionRef.current = undefined;
    setList(undefined);
    setError(undefined);
    document.getSelection()?.removeAllRanges();
    setSelection(undefined);
    const opened = { id: crypto.randomUUID(), parent: chosen.parent, anchor: chosen.anchor, auto: true, search };
    sheetRef.current = opened;
    setSheet(opened);
    explain(opened, search);
  };
  const closeSheet = (restoreFocus = true) => {
    referenceRequest.current++;
    const trigger = referenceTrigger.current;
    referenceTrigger.current = undefined;
    const chosen = sheetRef.current;
    sheetRef.current = undefined;
    setSheet(undefined);
    if (!restoreFocus) return;
    if (trigger?.isConnected && trigger.getClientRects().length) { trigger.focus({ preventScroll: true }); return; }
    const location = chosen && locateAnchor(c, chosen.parent.id, chosen.anchor);
    if (location) {
      const r = location.node.element.getBoundingClientRect();
      if (r.bottom < 64 || r.top > innerHeight - 64) location.node.element.scrollIntoView({ block: 'nearest' });
      const element = location.node.element;
      if (!element.hasAttribute('tabindex')) {
        element.tabIndex = -1;
        element.addEventListener('blur', () => { if (element.tabIndex === -1) element.removeAttribute('tabindex'); }, { once: true });
      }
      element.focus({ preventScroll: true });
    } else {
      c.adapter.composer()?.focus({ preventScroll: true });
    }
  };
  const send = async (question: string, search: boolean, chosen = sheetRef.current, automatic = false) => {
    if (!chosen || chosen.parent.id !== c.adapter.id()) throw new Error('打开这条旁问的主会话后再继续');
    if (question.length > 12000) throw new Error('旁问最多 12000 字符');
    if (!request.current || request.current.thread !== chosen.id || request.current.question !== question || request.current.search !== search) {
      request.current = { thread: chosen.id, question, search, id: crypto.randomUUID() };
    }
    setError(undefined);
    const data = { id: chosen.id, requestId: request.current.id, parentId: chosen.parent.id, parentUrl: chosen.parent.url,
      parentTitle: chosen.parent.title, anchor: chosen.anchor, question, search, automatic };
    try {
      const thread = await rpc<SideQuestionThread>('side.window.begin', data);
      if (request.current?.id === data.requestId) request.current = undefined;
      setSheet(value => value?.id === chosen.id ? { ...value, thread } : value);
      refreshSummary();
    } catch (cause) {
      const existing = await rpc<SideQuestionThread | null>('side.get', { id: chosen.id }).catch(() => null);
      if (existing?.turns.some(turn => turn.id === data.requestId)) {
        if (request.current?.id === data.requestId) request.current = undefined;
        setSheet(value => value?.id === chosen.id ? { ...value, thread: existing } : value);
        refreshSummary();
      } else throw cause;
    }
  };
  function explain(chosen: Sheet, search: boolean) {
    void send(EXPLAIN_SELECTION, search, chosen, true).catch(cause => {
      if (sheetRef.current?.id === chosen.id) setError(cause instanceof Error ? cause.message : '讲解未能开始');
    });
  }

  const workspace = renderWorkspace(summary.nativeConversationIds, parent => {
    const count = summary.parents[parent.id];
    if (!count) return null;
    return <button type="button" class="ps-side-question" aria-label={`${parent.title} · 旁问 ${count}`}
      aria-expanded={list?.parent.id === parent.id} onClick={event => {
        const button = event.currentTarget;
        openList(parent, button.closest<HTMLElement>('.ps-conversation') ?? button, button);
      }}>旁问 {count}</button>;
  });
  if (!c.state.active || suspended) return <>{workspace}</>;
  const turn = sheet?.thread?.turns.at(-1);
  const attention = turn?.status === 'attention';
  const firstTurn = sheet?.thread?.turns[0];
  const automatic = sheet?.auto || firstTurn?.automatic || firstTurn?.question === LEGACY_EXPLAIN_SELECTION;
  const starting = automatic && !sheet?.thread?.turns.some(item => item.status === 'complete');
  const canRetry = Boolean(starting && !pending && !attention && (error || turn?.status === 'failed') && sheet?.parent.id === route);
  const activeParent = c.state.current;
  const referenceCount = route ? summary.parents[route] ?? 0 : 0;
  const fallbackCount = activeParent && !badges.some(b => b.parent.id === route) ? referenceCount : 0;
  return <>
    <style>{badgeCss}</style>
    {route && referenceCount > 0 && <BodyReferences key={route} c={c} parentId={route} onOpen={openReference}/>}
    {badges.map(b => <button type="button" class="dsm-side-count" key={b.parent.id}
      style={{ left: b.x, top: b.y }} aria-label={b.parent.title + ' · 旁问 ' + b.count}
      aria-expanded={list?.parent.id === b.parent.id} onClick={event => openList(b.parent, b.row, event.currentTarget)}>
      旁问 {b.count}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </button>)}
    {!!fallbackCount && activeParent && <button type="button" class="dsm-side-count dsm-side-count-fallback"
      aria-expanded={list?.parent.id === activeParent.id} onClick={event => openList(activeParent, event.currentTarget, event.currentTarget)}>
      旁问 {fallbackCount}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </button>}
    <SideQuestions
      selection={selection ? { rect: () => rectOf(selection.range) } : undefined}
      sheet={sheet ? {
        id: sheet.id, quote: sheet.anchor.quote,
        rect: () => rectOf(anchorRef.current?.range) ?? anchorRef.current?.node.element.getBoundingClientRect(),
        messages: sheet.thread?.turns.flatMap(t => [
          ...(t.automatic || t.question === LEGACY_EXPLAIN_SELECTION ? [] : [{ id: t.id, role: 'user' as const, text: t.question }]),
          ...(t.answer ? [{ id: t.id + ':answer', role: 'assistant' as const, text: t.answer }]
            : t.status === 'pending' && sheet.thread?.preview?.turnId === t.id
              ? [{ id: t.id + ':answer', role: 'assistant' as const, text: sheet.thread.preview.text }] : []),
        ]) ?? [],
        starting, pending, disabled: attention || sheet.parent.id !== route,
        search: turn ? turn.search === true : sheet.search,
        status: pending ? (starting ? '正在讲解所选内容…' : '正在通过 DeepSeek 网页生成…') :
          sheet.parent.id !== route ? '打开主会话后可继续追问' : undefined,
        error: error ?? turn?.error,
        canRetry, onRetry: () => explain(sheet, turn ? turn.search === true : sheet.search === true),
        nativeUrl: sheet.thread?.nativeUrl ?? turn?.checkpoint.url ?? (!pending ? turn?.checkpoint.candidateUrl : undefined),
      } : undefined}
      list={list ? {
        title: list.parent.title, rect: () => list.row.isConnected ? list.row.getBoundingClientRect() : undefined, trigger: list.trigger,
        loading: !list.threads,
        items: list.threads?.map(thread => ({ id: thread.id, title: thread.anchor.quote, status: thread.turns.at(-1)?.status === 'pending' ? '生成中' : thread.turns.at(-1)?.status === 'attention' ? '需核对' : undefined })) ?? [],
      } : undefined}
      onSelect={openSelected}
      onCloseSelection={() => { setSelection(undefined); document.getSelection()?.removeAllRanges(); }}
      onPreview={id => {
        if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
        CSS.highlights.delete(PREVIEW);
        const thread = list?.threads?.find(item => item.id === id);
        const range = thread && locateAnchor(c, thread.parentId, thread.anchor)?.range;
        if (range) CSS.highlights.set(PREVIEW, new Highlight(range));
      }}
      onOpen={id => { const thread = list?.threads?.find(item => item.id === id); if (thread) openThread(thread, list?.trigger); }}
      onCloseSheet={closeSheet}
      onCloseList={() => setList(undefined)}
      onSend={send}
    />
    {workspace}
  </>;
}
