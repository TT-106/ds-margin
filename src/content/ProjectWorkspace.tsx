import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Controller } from './controller';
import type { ConversationLink } from '../shared/projects';
import { ProjectSidebar } from '../ui/ProjectSidebar';
import { Icon } from '../ui/icons';
import { rpc } from '../shared/rpc';
import sidebarCss from '../ui/project-sidebar.css?inline';

const viewKey = 'ds-margin:workspace-view';
const historyView = 'history';
const narrowViewport = '(max-width: 760px)';
const focusable = 'button,a[href],input,select,textarea,[tabindex]';

function readTabView() {
  try { return sessionStorage.getItem(viewKey) ?? undefined; } catch { return undefined; }
}

export function ProjectWorkspace({ c, suspended, hiddenIds, renderSideQuestion, onOpenLibrary }: {
  c: Controller;
  suspended: boolean;
  hiddenIds: readonly string[];
  renderSideQuestion: (chat: ConversationLink) => ComponentChildren;
  onOpenLibrary: (trigger: HTMLElement) => void;
}) {
  const [layout, setLayout] = useState(c.adapter.sidebarLayout);
  const [savedView, setSavedView] = useState<string | undefined>(readTabView);
  const [narrow, setNarrow] = useState(() => matchMedia(narrowViewport).matches);
  const [docked, setDocked] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [searching, setSearching] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const observed = useRef(new Map<string, string>());
  const workspace = c.state.projects;
  const { sidebar, history, newChat, rows } = layout;
  const hidden = useMemo(() => new Set([...hiddenIds, ...(workspace?.deletedIds ?? [])]), [hiddenIds, workspace?.deletedIds]);
  const visibleWorkspace = useMemo(() => workspace && {
    ...workspace, conversations: workspace.conversations.filter(chat => !hidden.has(chat.id)),
  }, [workspace, hidden]);
  const activeId = c.adapter.id();
  const current = activeId && !hidden.has(activeId) ? c.adapter.currentLink(c.state.nodes) : null;
  const projectHint = c.newProjectName;
  const composerBox = projectHint ? document.querySelector<HTMLElement>('[data-dsm-composer-box]') : null;
  const project = workspace?.projects.find(item => item.id === savedView);
  const view = project?.id ?? null;
  const available = Boolean(c.state.active && !c.state.focus && workspace && (sidebar || newChat || workspace.projects.length));
  const drawerMode = narrow || !sidebar || !docked;
  const openDrawer = available && drawerMode && drawer && !suspended;
  const showPanel = available && (!drawerMode || openDrawer);
  const mount = useMemo(() => {
    const host = document.createElement('div');
    host.dataset.dsmOwned = '';
    host.dataset.dsmProjectHost = '';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    const content = document.createElement('div');
    style.textContent = sidebarCss;
    root.append(style, content);
    return { host, root, content };
  }, []);

  useLayoutEffect(() => {
    const sync = () => setLayout(c.adapter.sidebarLayout);
    const stop = c.subscribeSidebar(sync);
    sync();
    return stop;
  }, [c]);
  useEffect(() => {
    if (savedView !== undefined) return;
    let active = true;
    void chrome.storage.local.get(viewKey).then(values => {
      const value = values[viewKey];
      if (active && typeof value === 'string') setSavedView(previous => previous ?? value);
    }).catch(() => {});
    return () => { active = false; };
  }, [savedView]);
  useLayoutEffect(() => {
    const query = matchMedia(narrowViewport);
    const sync = () => setNarrow(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  useLayoutEffect(() => {
    if (!sidebar || narrow || openDrawer) return;
    const measure = () => setDocked(sidebar.getBoundingClientRect().width >= 156);
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    measure();
    return () => observer.disconnect();
  }, [sidebar, narrow, openDrawer]);
  useEffect(() => { if (suspended || !available || !drawerMode) setDrawer(false); }, [suspended, available, drawerMode]);

  const loaded = useMemo(() => rows.map(row => row.link).filter(link => !hidden.has(link.id)), [rows, hidden]);
  useEffect(() => {
    if (!workspace || !loaded.length) return;
    const indexed = new Map(workspace.conversations.map(link => [link.id, link]));
    for (const id of observed.current.keys()) if (!indexed.has(id)) observed.current.delete(id);
    const changed: ConversationLink[] = [];
    for (const link of loaded) {
      const previous = indexed.get(link.id);
      if (!previous || link.title === '未命名对话' || observed.current.get(link.id) === link.title) continue;
      observed.current.set(link.id, link.title);
      if (previous.title !== link.title) changed.push(link);
    }
    for (let offset = 0; offset < changed.length; offset += 500) {
      const batch = changed.slice(offset, offset + 500);
      void rpc('project.observe', { conversations: batch }).catch(() => {
        for (const link of batch) if (observed.current.get(link.id) === link.title) observed.current.delete(link.id);
      });
    }
  }, [loaded, workspace]);
  useLayoutEffect(() => {
    if (!composerBox || !projectHint) return;
    const hint = document.createElement('div');
    hint.dataset.dsmOwned = '';
    hint.dataset.dsmProjectHint = '';
    hint.setAttribute('role', 'status');
    composerBox.prepend(hint);
    hint.textContent = `将归入 ${projectHint}`;
    return () => hint.remove();
  }, [composerBox, projectHint]);

  useLayoutEffect(() => {
    const host = mount.host;
    if (!available) { host.remove(); return; }
    if (sidebar) {
      if (history && history !== sidebar && sidebar.contains(history)) history.before(host);
      else sidebar.append(host);
    } else document.body.append(host);
    return () => host.remove();
  }, [sidebar, history, available, mount]);
  useLayoutEffect(() => {
    const html = document.documentElement;
    mount.host.hidden = !showPanel;
    mount.host.toggleAttribute('data-dsm-project-standalone', !sidebar);
    if (!available || !sidebar) return;
    if (openDrawer) sidebar.dataset.dsmProjectDrawer = 'open';
    else if (narrow) sidebar.dataset.dsmProjectDrawer = 'closed';
    sidebar.dataset.dsmProjectContent = showPanel && (view || searching) ? 'workspace' : 'history';
    if (showPanel && newChat && sidebar.contains(newChat)) newChat.setAttribute('data-dsm-project-new-native', '');
    html.toggleAttribute('data-dsm-project-current-row', Boolean(showPanel && view && !searching &&
      workspace?.conversations.some(chat => chat.id === current?.id && chat.projectId === view)));
    if (openDrawer && !newChat) c.adapter.markSidebar();
    c.refreshSidebarGeometry();
    return () => {
      delete sidebar.dataset.dsmProjectDrawer;
      delete sidebar.dataset.dsmProjectContent;
      newChat?.removeAttribute('data-dsm-project-new-native');
      html.removeAttribute('data-dsm-project-current-row');
    };
  }, [c, mount, available, sidebar, narrow, openDrawer, view, searching, showPanel, newChat, workspace, current?.id]);

  const selectView = (id: string | null) => {
    const value = id ?? historyView;
    setSavedView(value);
    setSearching(false);
    try { sessionStorage.setItem(viewKey, value); } catch { /* The global preference still works. */ }
    void chrome.storage.local.set({ [viewKey]: value }).catch(() => {});
    if (!id && !sidebar) {
      setDrawer(false);
      c.notify('可通过 DeepSeek 的侧栏按钮打开原站历史。');
    }
  };
  const closeDrawer = () => {
    setDrawer(false);
    requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
  };
  useLayoutEffect(() => {
    if (!openDrawer) return;
    const dialog = sidebar ?? mount.host;
    const attributes = Object.entries({ role: 'dialog', 'aria-label': '会话项目' })
      .map(([name, value]) => ({ name, value, previous: dialog.getAttribute(name) }));
    for (const { name, value } of attributes) dialog.setAttribute(name, value);
    const visible = (element: HTMLElement) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length;
    const controls = () => {
      const native = [...(sidebar?.querySelectorAll<HTMLElement>(focusable) ?? [])];
      const boundary = native.findIndex(element => mount.host.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
      native.splice(boundary === -1 ? native.length : boundary, 0, ...mount.root.querySelectorAll<HTMLElement>(focusable));
      return native.filter(visible);
    };
    const focusFrame = requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) controls()[0]?.focus();
    });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
      if (event.key !== 'Tab') return;
      const layer = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement &&
        node.matches('[data-dsm-side-list],[data-dsm-side-sheet],.ps-menu:popover-open'));
      const items = layer ? [...layer.querySelectorAll<HTMLElement>(focusable)].filter(visible) : controls();
      const active = event.composedPath()[0];
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      if (items.length) { event.preventDefault(); items[next]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', key);
      for (const { name, value, previous } of attributes) {
        if (dialog.getAttribute(name) !== value) continue;
        if (previous === null) dialog.removeAttribute(name);
        else dialog.setAttribute(name, previous);
      }
    };
  }, [openDrawer, mount, sidebar]);

  if (!available) return null;
  return <>
    {drawerMode && !openDrawer && !suspended && <button ref={launcher} class="project-drawer-trigger" type="button"
      aria-label="打开会话项目" aria-expanded={false} onClick={() => setDrawer(true)}><Icon name="outline"/> 会话项目</button>}
    {openDrawer && createPortal(<div data-dsm-owned="" data-dsm-project-scrim="" onClick={closeDrawer}/>, document.body)}
    {createPortal(<ProjectSidebar workspace={visibleWorkspace} loaded={loaded} current={current} currentId={current?.id ?? null}
      view={view} onSelectView={selectView} onSearchChange={setSearching} onRefresh={c.refreshProjects}
      newChatAvailable={Boolean(newChat?.isConnected && !c.adapter.controls.disabled(newChat))}
      onNewChat={id => { c.newProjectChat(id); setDrawer(false); }}
      onOpenChat={(chat, event) => { c.openProjectChat(chat, event); if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) setDrawer(false); }}
      onOpenLibrary={trigger => { setDrawer(false); onOpenLibrary(trigger); }}
      onCloseDrawer={openDrawer ? closeDrawer : undefined} renderSideQuestion={renderSideQuestion}/>, mount.content)}
  </>;
}
