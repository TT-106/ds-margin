import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConversationLink, Project, ProjectConversation, Projects } from '../shared/projects';
import { rpc } from '../shared/rpc';
import { viewportBounds, watchAnchor, watchOutsideInteraction } from './floating';
import { Icon } from './icons';

const PRIVACY_KEY = 'ds-margin:projectsPrivacyAcknowledged';

export interface ProjectSidebarProps {
  workspace: Projects | null;
  loaded: readonly ConversationLink[];
  currentId: string | null;
  current: ConversationLink | null;
  view: string | null;
  onSelectView: (id: string | null) => void;
  onNewChat: (projectId: string | null) => void;
  onOpenChat: (chat: ConversationLink, event: MouseEvent) => void;
  onOpenLibrary: (trigger: HTMLElement) => void;
  onRefresh: () => Promise<void>;
  onSearchChange?: (open: boolean) => void;
  onCloseDrawer?: () => void;
  newChatAvailable?: boolean;
  renderSideQuestion?: (chat: ConversationLink) => ComponentChildren;
}

interface MenuAction {
  label: string;
  title?: string;
  icon?: string;
  danger?: boolean;
  run: (trigger: HTMLButtonElement) => void;
}

function SidebarMenu({ label, actions, disabled }: { label: string; actions: () => MenuAction[]; disabled: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const restore = () => trigger.current?.focus({ preventScroll: true });

  useLayoutEffect(() => {
    const anchor = trigger.current, popup = menu.current;
    if (!open || !anchor || !popup) return;
    popup.showPopover();
    const stop = watchAnchor(anchor, () => {
      const rect = anchor.getBoundingClientRect(), viewport = viewportBounds();
      const width = Math.min(218, viewport.right - viewport.left - 16);
      const below = viewport.bottom - rect.bottom - 14;
      const above = rect.top - viewport.top - 14;
      const preferBelow = below >= Math.min(popup.scrollHeight, 272) || below >= above;
      popup.style.left = `${Math.max(viewport.left + 8, Math.min(rect.right - width, viewport.right - width - 8))}px`;
      popup.style.width = `${width}px`;
      popup.style.top = preferBelow ? `${rect.bottom + 5}px` : 'auto';
      popup.style.bottom = preferBelow ? 'auto' : `${innerHeight - rect.top + 5}px`;
      popup.style.maxHeight = `${Math.max(44, Math.min(272, preferBelow ? below : above))}px`;
    });
    const stopDismissal = watchOutsideInteraction(popup, (_event, path) => path.includes(anchor), () => setOpen(false));
    const visible = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) setOpen(false); });
    visible.observe(anchor);
    popup.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      stop();
      stopDismissal();
      visible.disconnect();
      if (popup.matches(':popover-open')) popup.hidePopover();
    };
  }, [open]);

  return <>
    <button ref={trigger} type="button" class="ps-icon" aria-label={label} title={label} disabled={disabled}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <Icon name="more" size={17}/>
    </button>
    {open && <div id={id} ref={menu} popover="manual" class="ps-menu" role="group" aria-label={label} onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      restore();
    }}>
      {actions().map(action => <button key={action.label} type="button" title={action.title} class="ps-menu-action"
        data-danger={action.danger || undefined} onClick={() => {
          setOpen(false);
          restore();
          if (trigger.current) action.run(trigger.current);
        }}>
        {action.icon && <Icon name={action.icon} size={15}/>}<span>{action.label}</span>
      </button>)}
    </div>}
  </>;
}

type Edit = { mode: 'create' } | { mode: 'rename' | 'delete'; project: Project };

function ProjectForm({ edit, busy, onCancel, onSave }: {
  edit: Edit;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(edit.mode === 'create' ? '' : edit.project.name);
  const focus = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  useLayoutEffect(() => focus.current?.focus(), []);
  if (edit.mode === 'delete') return <section class="ps-form" aria-label="删除项目确认">
    <p>删除「{edit.project.name}」？其中的对话仍可从原站历史打开。</p>
    <div class="ps-form-actions">
      <button type="button" ref={el => { focus.current = el; }} disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" class="ps-danger" disabled={busy} onClick={() => onSave(name)}>删除项目</button>
    </div>
  </section>;
  return <form class="ps-form" onSubmit={event => { event.preventDefault(); if (name.trim() && !busy) onSave(name.trim()); }}>
    <label for={id}>项目名称</label>
    <input id={id} ref={el => { focus.current = el; }} type="text" value={name} maxLength={80}
      onInput={event => setName(event.currentTarget.value)} required/>
    <div class="ps-form-actions">
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" class="ps-accent" disabled={busy || !name.trim()}>{edit.mode === 'create' ? '创建' : '保存'}</button>
    </div>
  </form>;
}

function compareConversations(a: ProjectConversation, b: ProjectConversation) {
  return Number(b.pinned) - Number(a.pinned) || b.joinedAt - a.joinedAt || a.id.localeCompare(b.id);
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export function ProjectSidebar({
  workspace, loaded, currentId, current, view, onSelectView, onNewChat, onOpenChat, onOpenLibrary, onRefresh, renderSideQuestion,
  onSearchChange, onCloseDrawer, newChatAvailable = true,
}: ProjectSidebarProps) {
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const editTrigger = useRef<HTMLButtonElement>();
  const pendingFocus = useRef<HTMLButtonElement>();

  useLayoutEffect(() => {
    let active = true;
    const update = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && PRIVACY_KEY in changes) setPrivacy(changes[PRIVACY_KEY].newValue !== true);
    };
    chrome.storage.onChanged.addListener(update);
    void chrome.storage.local.get(PRIVACY_KEY).then(values => {
      if (active) setPrivacy(values[PRIVACY_KEY] !== true);
    }, () => { if (active) setPrivacy(true); });
    return () => { active = false; chrome.storage.onChanged.removeListener(update); };
  }, []);
  useLayoutEffect(() => { if (search) searchRef.current?.focus({ preventScroll: true }); }, [search]);
  useLayoutEffect(() => {
    if (edit || busy || !pendingFocus.current) return;
    const trigger = pendingFocus.current;
    pendingFocus.current = undefined;
    (trigger.isConnected && trigger.getClientRects().length ? trigger : createButton.current)?.focus();
  }, [edit, busy]);

  const data = useMemo(() => {
    const projects = [...(workspace?.projects ?? [])].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const byProject = new Map<string, ProjectConversation[]>();
    const indexed = new Map<string, ProjectConversation>();
    const byLoaded = new Map(loaded.map(chat => [chat.id, chat]));
    const names = new Map(projects.map(project => [project.id, project.name]));
    for (const item of workspace?.conversations ?? []) {
      const native = byLoaded.get(item.id);
      const chat = native ? { ...item, ...native } : item;
      indexed.set(item.id, chat);
      if (chat.projectId) {
        const rows = byProject.get(chat.projectId) ?? [];
        rows.push(chat);
        byProject.set(chat.projectId, rows);
      }
    }
    for (const rows of byProject.values()) rows.sort(compareConversations);
    return { projects, byProject, indexed, byLoaded, names };
  }, [workspace, loaded]);
  const projectName = view ? data.names.get(view) : undefined;
  const searchAll = all || !projectName;
  const results = useMemo(() => {
    if (!search || !query.trim()) return [];
    const entries = searchAll ? new Map<string, ConversationLink>() : new Map(data.byProject.get(view ?? '')?.map(chat => [chat.id, chat]));
    if (searchAll) {
      for (const rows of data.byProject.values()) for (const chat of rows) entries.set(chat.id, chat);
      for (const chat of data.byLoaded.values()) entries.set(chat.id, chat);
    }
    const queryTerms = normalizeSearch(query.trim()).split(/\s+/);
    return [...entries.values()].filter(chat => {
      const title = normalizeSearch(chat.title);
      return queryTerms.every(term => title.includes(term));
    });
  }, [data, query, search, searchAll, view]);

  const run = async (action: () => Promise<void>, text?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      await onRefresh();
      if (text) setStatus({ text });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : '暂时无法保存项目', error: true });
    } finally {
      setBusy(false);
    }
  };
  const endSearch = (restore = true) => {
    setSearch(false);
    setQuery('');
    if (search) onSearchChange?.(false);
    if (restore) searchButton.current?.focus({ preventScroll: true });
  };
  const chooseView = (id: string | null) => {
    endSearch(false);
    setEdit(null);
    setStatus(null);
    onSelectView(id);
  };
  const beginEdit = (next: Edit, trigger: HTMLButtonElement) => {
    endSearch(false);
    setStatus(null);
    editTrigger.current = trigger;
    setEdit(next);
  };
  const finishEdit = () => {
    pendingFocus.current = editTrigger.current;
    setEdit(null);
  };
  const save = (name: string) => {
    if (!edit) return;
    void run(async () => {
      if (edit.mode === 'create') {
        const project = await rpc<Project>('project.create', { name });
        chooseView(project.id);
      } else if (edit.mode === 'rename') {
        await rpc('project.rename', { id: edit.project.id, name });
      } else {
        await rpc('project.delete', { id: edit.project.id });
        if (view === edit.project.id) chooseView(null);
      }
      finishEdit();
    }, edit.mode === 'delete' ? '项目已删除' : undefined);
  };
  const move = (chat: ConversationLink, projectId: string | null) => {
    const title = projectId ? data.names.get(projectId) : null;
    void run(async () => { await rpc('project.assign', { id: chat.id, title: chat.title, url: chat.url, projectId }); },
      title ? `已移入「${title}」` : '已移出项目');
  };
  const pin = (chat: ConversationLink, pinned: boolean) => {
    void run(async () => { await rpc('project.pin', { id: chat.id, title: chat.title, url: chat.url, pinned }); }, pinned ? '已置顶' : '已取消置顶');
  };

  const conversationActions = (chat: ConversationLink): MenuAction[] => {
    const indexed = data.indexed.get(chat.id);
    const actions: MenuAction[] = [];
    if (indexed?.projectId) {
      actions.push({ label: indexed.pinned ? '取消置顶' : '置顶', icon: 'pin', run: () => pin(chat, !indexed.pinned) });
      actions.push({ label: '移出项目', icon: 'minus', run: () => move(chat, null) });
    }
    for (const project of data.projects) {
      if (project.id === indexed?.projectId) continue;
      actions.push({ label: `移入项目：${project.name}`, title: project.name, run: () => move(chat, project.id) });
    }
    if (!actions.length) actions.push({ label: '先创建项目', icon: 'plus', run: trigger => beginEdit({ mode: 'create' }, trigger) });
    return actions;
  };
  const row = (chat: ConversationLink, source?: string, opened = false) => {
    const indexed = data.indexed.get(chat.id);
    const title = <>
      {indexed?.pinned && <Icon name="pin" size={13}/>}
      <span class="ps-conversation-copy"><span>{chat.title}</span>{source && <small>{source}</small>}</span>
    </>;
    return <li key={chat.id} class="ps-conversation" data-dsm-project-conversation={chat.id} data-current={chat.id === currentId || undefined}>
      {opened ? <span class="ps-opened-title" title={chat.title}>{title}</span> :
        <a href={chat.url} title={chat.title} aria-label={chat.title} aria-description={source} aria-current={chat.id === currentId ? 'page' : undefined}
          onClick={event => onOpenChat(chat, event)}>{title}</a>}
      {!opened && renderSideQuestion?.(chat)}
      <SidebarMenu label={`对话选项：${chat.title}`} actions={() => conversationActions(chat)} disabled={busy}/>
    </li>;
  };
  const opened = currentId && (current?.id === currentId ? current : data.byLoaded.get(currentId) ?? data.indexed.get(currentId));

  return <nav class="project-sidebar" data-dsm-project-sidebar="" data-native-view={!projectName || undefined}
    data-drawer={onCloseDrawer ? true : undefined} aria-label="会话工作区"
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (edit) { if (!busy) finishEdit(); }
      else if (search) endSearch();
      else return;
      event.preventDefault();
      event.stopPropagation();
    }}>
    <div class="ps-tools">
      <button class="ps-new-chat" type="button" disabled={!newChatAvailable}
        title={newChatAvailable ? undefined : '原站新建入口暂不可用'}
        onClick={() => onNewChat(projectName ? view : null)}><Icon name="plus" size={17}/>新建对话</button>
      <button class="ps-icon ps-search-toggle" ref={searchButton} type="button" aria-label={search ? '关闭搜索' : '搜索会话'}
        title={search ? '关闭搜索' : '搜索会话'} aria-expanded={search} onClick={() => {
          if (search) endSearch();
          else { setAll(false); setEdit(null); setSearch(true); onSearchChange?.(true); }
        }}><Icon name={search ? 'close' : 'search'} size={17}/></button>
      {onCloseDrawer && <button class="ps-icon" type="button" aria-label="收起会话侧栏" title="收起会话侧栏"
        onClick={onCloseDrawer}><Icon name="back" size={17}/></button>}
    </div>
    {privacy && workspace && <div class="ps-privacy">
      <p>项目保存在此浏览器配置。共用此配置的 DeepSeek 账号均可看到本地项目。</p>
      <button type="button" onClick={() => {
        setPrivacy(false);
        (searchRef.current ?? createButton.current)?.focus({ preventScroll: true });
        void chrome.storage.local.set({ [PRIVACY_KEY]: true }).catch(() => setPrivacy(true));
      }}>知道了</button>
    </div>}
    {search && <div class="ps-search-controls">
      <input ref={searchRef} type="text" aria-label="搜索会话" placeholder="按对话标题搜索" maxLength={200} value={query}
        onInput={event => setQuery(event.currentTarget.value)}/>
      <div class="ps-search-scope" aria-label="搜索范围" role="group">
        {projectName && <button type="button" aria-pressed={!searchAll} onClick={() => setAll(false)}>当前项目</button>}
        <button type="button" aria-pressed={searchAll} onClick={() => setAll(true)}>项目与已加载历史</button>
      </div>
    </div>}
    {status && <p class="ps-status" role={status.error ? 'alert' : 'status'}>{status.text}</p>}
    {search ? <div class="ps-scroll ps-search-results">
      {!query.trim() ? <p class="ps-hint">输入标题关键词查找对话。</p> : results.length ?
        <ul>{results.map(chat => {
          const projectId = data.indexed.get(chat.id)?.projectId;
          const name = projectId ? data.names.get(projectId) : undefined;
          const sources = [name && `项目：${name}`, data.byLoaded.has(chat.id) && '已加载历史'].filter(Boolean);
          return row(chat, sources.join(' · '));
        })}</ul> : <p class="ps-hint">此范围未找到对话。更早的记录可在原站历史中查看。</p>}
      <button class="ps-text-action" type="button" onClick={event => onOpenLibrary(event.currentTarget)}>在书库搜正文</button>
    </div> : <>
      <div class="ps-heading">
        <span>项目</span>
        <button class="ps-icon" ref={createButton} type="button" aria-label="创建项目" title="创建项目" disabled={!workspace || busy}
          onClick={event => beginEdit({ mode: 'create' }, event.currentTarget)}><Icon name="plus" size={17}/></button>
      </div>
      {edit && <ProjectForm key={edit.mode === 'create' ? edit.mode : `${edit.mode}-${edit.project.id}`} edit={edit} busy={busy} onSave={save} onCancel={finishEdit}/>}
      <div class="ps-scroll">
        {data.projects.length ? <ul class="ps-projects">{data.projects.map(project => {
          const expanded = project.id === view;
          const rows = data.byProject.get(project.id) ?? [];
          return <li key={project.id}>
            <div class="ps-project-title" data-expanded={expanded || undefined}>
              <button class="ps-disclosure" type="button" data-dsm-project={project.id} aria-expanded={expanded}
                title={project.name} onClick={() => chooseView(expanded ? null : project.id)}>
                <Icon name="chevronDown" size={15}/><span>{project.name}</span>
              </button>
              <SidebarMenu label={`项目选项：${project.name}`} disabled={busy} actions={() => [
                { label: '重命名项目', run: trigger => beginEdit({ mode: 'rename', project }, trigger) },
                { label: '删除项目', icon: 'trash', danger: true, run: trigger => beginEdit({ mode: 'delete', project }, trigger) },
              ]}/>
            </div>
            {expanded && (rows.length ? <ul class="ps-conversations">{rows.map(chat => row(chat))}</ul> :
              <p class="ps-hint ps-project-empty">在此项目新建对话，或从原站历史移入已有对话。</p>)}
          </li>;
        })}</ul> : <p class="ps-hint">{workspace ? '创建项目，整理你想继续的对话。' : '正在读取本地项目…'}</p>}
        {opened && (!projectName || data.indexed.get(opened.id)?.projectId !== view) && <div class="ps-current">
          <span>当前对话</span>
          <ul>{row(opened, undefined, true)}</ul>
        </div>}
      </div>
    </>}
    <button class="ps-history" type="button" aria-current={!projectName && !search ? 'page' : undefined}
      onClick={() => chooseView(null)}><Icon name="clock" size={16}/><span>原站历史</span><Icon name="chevronDown" size={14}/></button>
  </nav>;
}
