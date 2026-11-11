import { BUILTIN_PROMPTS, LIBRARY_EPOCH_KEY, PROMPTS_EPOCH_KEY, conversationId, DEFAULT_SETTINGS, fingerprint, normalizeSettings, type Bookmark, type Conversation, type Draft, type Library, type PromptTemplate, type Settings } from '../shared/model';
import { rpc } from '../shared/rpc';
import { PROJECTS_EPOCH_KEY, type ConversationLink, type ProjectWorkspaceData } from '../shared/projects';
import { isAuthRoute, SiteAdapter, type MessageNode } from './adapter';
import { ProjectChat } from './project-chat';
import { ReadingChrome } from './reading-chrome';
const emptyLibrary: Omit<Library, 'prompts'> = { conversations: [], bookmarks: [], blocked: [] };
export interface ViewState {
  settings: Settings; active: boolean; current: Conversation | null; nodes: MessageNode[];
  library: Omit<Library, 'prompts'>;
  libraryStatus: 'loading' | 'ready' | 'error';
  prompts: PromptTemplate[]; promptsReady: boolean;
  draft: Draft | null; notice: string; noticeError: boolean; focus: boolean;
  nativeGenerating: boolean;
  projects: ProjectWorkspaceData | null;
}
export class Controller {
  readonly adapter = new SiteAdapter();
  state: ViewState = { settings: DEFAULT_SETTINGS, active: false, current: null, nodes: [],
    library: emptyLibrary, libraryStatus: 'loading', prompts: BUILTIN_PROMPTS, promptsReady: false,
    draft: null, notice: '', noticeError: false, focus: false,
    nativeGenerating: false, projects: null };
  private projectsRun = 0;
  private projectChat = new ProjectChat(this.adapter, () => this.notify('未能确认新会话。打开对话后可从左栏移入项目。'));
  private projectNewControl?: HTMLElement;
  private readingChrome = new ReadingChrome();
  private themeColor?: HTMLMetaElement;
  private listeners = new Set<() => void>();
  private sidebarListeners = new Set<() => void>();
  private sidebarFrame = 0;
  private navigation = (window as Window & { navigation?: EventTarget }).navigation;
  private route = '';
  private signature = '';
  private observer?: MutationObserver;
  private scanTimer = 0;
  private routeTimer = 0;
  private archiveTimer = 0;
  private pendingArchive: Conversation | null = null;
  private archiveViewOpen = false;
  private libraryStale = true;
  private libraryRequest?: Promise<void>;
  private promptsRun = 0;
  private draftTimer = 0;
  private draftRevision = 0;
  private draftLoadedFor = '';
  private conflict = false;
  private composing = false;
  private boundComposer: HTMLElement | null = null;
  private noticeTimer = 0;
  private selected: { node: MessageNode; text: string } | null = null;
  private pendingSend: { id: string; text: string; knownIds: Set<string> } | null = null;
  private suppressedDraft: { id: string; text: string } | null = null;
  private media = matchMedia('(prefers-color-scheme: dark)');
  onCommand: (name: string) => void = () => {};
  constructor(private host: HTMLElement) {}
  private syncControls() {
    this.state.nativeGenerating = this.adapter.markControls();
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  subscribeSidebar = (fn: () => void) => { this.sidebarListeners.add(fn); return () => this.sidebarListeners.delete(fn); };
  refreshSidebarGeometry() { this.emitSidebar(); }
  private emit() { for (const fn of this.listeners) fn(); }
  private emitSidebar() { for (const fn of this.sidebarListeners) fn(); }
  async start(settings: Settings) {
    this.state.settings = settings;
    this.observer = new MutationObserver(records => {
      const native = records.filter(r => {
        const element = r.target instanceof Element ? r.target : r.target.parentElement;
        return element && !element.closest('[data-dsm-owned]') &&
          (r.type !== 'childList' || [...r.addedNodes, ...r.removedNodes].some(node => !(node instanceof Element && node.matches('[data-dsm-owned]'))));
      });
      if (!this.state.active && this.state.settings.enabled && native.length && document.documentElement.dataset.dsmStartup !== 'ready') {
        const composer = this.adapter.composer();
        if (composer || isAuthRoute()) {
          this.scan(composer);
          return;
        }
      }
      const sidebar = this.adapter.sidebarLayout.sidebar;
      const affectsSidebar = native.some(record => sidebar?.contains(record.target));
      if (this.state.active && native.length &&
          (affectsSidebar || !sidebar?.isConnected || location.href !== this.route)) this.scheduleSidebar();
      if (native.some(r => r.type !== 'attributes' && !sidebar?.contains(r.target))) this.scheduleScan();
      if (this.state.active && native.some(r => r.type === 'attributes' &&
        r.target instanceof Element && r.target.closest('[data-dsm-composer-box],[data-dsm-new-chat]'))) {
        this.syncControls();
        this.emit();
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-pressed','aria-disabled','aria-label','disabled','hidden','class','href'] });
    this.routeTimer = window.setInterval(() => {
      if (location.href !== this.route || this.boundComposer && !this.boundComposer.isConnected) this.scan();
    }, 900);
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('compositionstart', this.onCompositionStart, true);
    document.addEventListener('compositionend', this.onCompositionEnd, true);
    document.addEventListener('mouseup', this.onSelection);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('click', this.onNativeClick, true);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('popstate', this.onHistoryTraversal);
    this.navigation?.addEventListener('currententrychange', this.onNavigate);
    this.media.addEventListener('change', this.applyAppearance);
    chrome.storage.onChanged.addListener(this.onStorage);
    this.scan();
    void this.refreshPrompts().catch(error => this.notifyError(error));
    void this.refreshProjects().catch(error => this.notifyError(error));
  }
  private onHistoryTraversal = () => { this.projectChat.cancel(); this.onNavigate(); };
  private onNavigate = () => {
    this.projectChat.routeChanged();
    this.scheduleSidebar();
    this.scheduleScan();
  };
  private scheduleSidebar = () => {
    if (this.sidebarFrame) return;
    this.sidebarFrame = requestAnimationFrame(() => {
      this.sidebarFrame = 0;
      if (!this.state.active) return;
      this.adapter.markSidebar(this.boundComposer);
      this.emitSidebar();
    });
  };
  private scheduleScan = () => { if (!this.scanTimer) this.scanTimer = window.setTimeout(() => { this.scanTimer = 0; this.scan(); }, 650); };
  private onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (area === 'local' && changes['ds-margin:settings']) {
      this.state.settings = normalizeSettings(changes['ds-margin:settings'].newValue);
      this.scan();
    }
    const dataChanged = changes['ds-margin:dataEpoch'];
    if (dataChanged) {
      clearTimeout(this.draftTimer);this.draftTimer=0;this.pendingSend=null;
      this.projectChat.cancel();
      this.suppressedDraft={id:this.adapter.draftId(),text:this.adapter.getText()};
      this.draftRevision=0;this.conflict=false;this.state.draft=null;
      this.state.library = emptyLibrary;
      this.state.libraryStatus = 'loading';
      this.state.prompts = BUILTIN_PROMPTS;
      this.state.promptsReady = false;
      this.emit();
    }
    if (dataChanged || changes[PROMPTS_EPOCH_KEY]) void this.refreshPrompts().catch(error => this.notifyError(error));
    if (dataChanged || changes[PROJECTS_EPOCH_KEY]) {
      void this.refreshProjects().catch(error => this.notifyError(error));
    }
    if (dataChanged || changes[PROJECTS_EPOCH_KEY] || changes[LIBRARY_EPOCH_KEY]) this.invalidateLibrary();
  };
  private scan(composer = this.adapter.composer()) {
    const active = this.state.settings.enabled && !!composer;
    const routeChanged = this.route !== location.href;
    if (routeChanged) {
      this.projectChat.routeChanged();
      this.flushArchive();
      clearTimeout(this.draftTimer); this.draftTimer = 0;
      this.route = location.href; this.signature = ''; this.draftRevision = 0;
      this.draftLoadedFor = ''; this.conflict = false; this.state.draft = null;
    }
    const activeChanged = this.state.active !== active;
    this.state.active = active; this.boundComposer = composer;
    this.applyAppearance();
    if (!active) {
      if (!this.state.settings.enabled || isAuthRoute()) document.documentElement.dataset.dsmStartup = 'ready';
      this.state.nodes = []; this.state.current = null;
      this.projectChat.cancel();
      clearTimeout(this.archiveTimer); this.archiveTimer = 0; this.pendingArchive = null;
      this.state.nativeGenerating = false;
      this.readingChrome.stop();
      this.adapter.unmark(); this.emitSidebar(); this.emit(); return;
    }
    if (activeChanged || routeChanged || !this.adapter.sidebarLayout.sidebar?.isConnected) {
      this.adapter.markSidebar(composer);
      this.emitSidebar();
    }
    const nodes = this.adapter.messages();
    const layout = this.adapter.markLayout(composer, nodes);
    this.syncControls();
    this.readingChrome.update(layout, nodes);
    const signature = nodes.map(n => `${n.message.id}:${n.message.fingerprint}`).join('|');
    this.state.nodes = nodes;
    if (signature !== this.signature || routeChanged) {
      this.signature = signature; this.state.current = this.adapter.snapshot(nodes);
      if (this.state.current && this.state.settings.autoArchive) {
        this.pendingArchive = this.state.current;
        if (!this.archiveTimer) this.archiveTimer = window.setTimeout(() => this.flushArchive(), 1800);
      }
      this.checkSentDraft();
    }
    const assignment = this.projectChat.confirm(nodes, composer);
    if (assignment) void rpc('project.assign', assignment).catch(() => this.notify('自动归组未完成，可从左栏移入项目。', true));
    const key = this.adapter.draftId();
    if (this.state.settings.saveDrafts && this.draftLoadedFor !== key) {
      this.draftLoadedFor = key;
      void rpc<Draft | null>('draft.get', { id: key }).then(draft => {
        if (!this.state.active || this.adapter.draftId() !== key) return;
        this.draftRevision = draft?.updatedAt ?? 0;
        this.state.draft = draft?.text ? draft : null; this.emit();
      }).catch(error => this.notifyError(error));
    }
    if (routeChanged && location.hash.startsWith('#dsm-')) {
      const params = new URLSearchParams(location.hash.slice(5));
      const id = params.get('message'), fp = params.get('fp');
      if (id && fp && !this.adapter.locate(id, fp)) this.notify('该消息当前未加载或已改变，可在本地收藏中阅读原文');
    }
    this.emit();
    document.documentElement.dataset.dsmStartup = 'ready';
  }
  private applyAppearance = () => {
    const s = this.state.settings, html = document.documentElement;
    html.classList.toggle('dsm-enabled', this.state.active);
    html.classList.toggle('dsm-focus', this.state.active && this.state.focus);
    html.classList.toggle('dsm-reduced', this.state.active && s.reduceMotion);
    this.host.hidden = !this.state.active;
    if (this.state.active) {
      html.dataset.dsmTheme = s.theme === 'system' ? this.media.matches ? 'dark' : 'light' : s.theme;
      if (!this.themeColor) {
        const meta = document.createElement('meta');
        meta.name = 'theme-color';
        meta.dataset.dsmOwned = '';
        document.head.prepend(meta);
        this.themeColor = meta;
      }
      this.themeColor.content = html.dataset.dsmTheme === 'dark' ? '#211F1C' : '#F5F2EA';
      html.style.setProperty('--dsm-font-size', `${s.fontSize}px`);
      html.style.setProperty('--dsm-leading', String(s.lineHeight));
      html.style.setProperty('--dsm-width', `${s.contentWidth}px`);
      html.style.setProperty('--dsm-spacing', `${s.spacing}px`);
    } else {
      delete html.dataset.dsmTheme;
      this.themeColor?.remove();
      this.themeColor = undefined;
      for (const name of ['--dsm-font-size','--dsm-leading','--dsm-width','--dsm-spacing']) html.style.removeProperty(name);
    }
  };
  private flushArchive() {
    clearTimeout(this.archiveTimer); this.archiveTimer = 0;
    const snapshot = this.pendingArchive; this.pendingArchive = null;
    if (!snapshot || !this.state.settings.enabled || !this.state.settings.autoArchive) return;
    void rpc<boolean>('archive', snapshot).then(saved => {
      if (!saved) return;
      this.invalidateLibrary();
    }).catch(error => this.notifyError(error));
  }
  private onCompositionStart = (event: Event) => { if (event.target === this.boundComposer) this.composing = true; };
  private onCompositionEnd = (event: Event) => { if (event.target === this.boundComposer) { this.composing = false; this.onInput(event); } };
  private onInput = (event: Event) => {
    if (!this.state.active || !this.state.settings.saveDrafts || this.composing || (event instanceof InputEvent && event.isComposing) || event.target !== this.boundComposer) return;
    const text = this.adapter.getText();
    if(this.suppressedDraft?.id===this.adapter.draftId()){
      if(this.suppressedDraft.text===text)return;
      this.suppressedDraft=null;
    }
    if (!text.trim()) return; // Keep recovery text until native user-message confirmation or explicit discard.
    const id = this.adapter.draftId();
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => { this.draftTimer = 0; void this.saveDraft(id, text); }, 550);
  };
  private async saveDraft(id: string, text: string) {
    if (this.conflict || this.composing || !this.state.active || id !== this.adapter.draftId() || this.suppressedDraft?.id===id&&this.suppressedDraft.text===text) return;
    try {
      const result = await rpc<{ saved: boolean; draft?: Draft; conflict?: Draft }>('draft.save', { id, text, updatedAt: Date.now(), expectedAt: this.draftRevision });
      if (id !== this.adapter.draftId()) return;
      if (result.draft) { this.draftRevision = result.draft.updatedAt; this.state.draft = null; }
      if (result.conflict) { this.conflict = true; this.state.draft = result.conflict; this.notify('另一标签页保存了不同草稿。请先选择恢复或放弃那份草稿'); }
      this.emit();
    } catch (error) { this.notifyError(error); }
  }
  private checkSentDraft() {
    const pending=this.pendingSend;
    if (!pending || this.adapter.getText().trim() || !this.state.nodes.some(n=>n.message.role==='user'&&!pending.knownIds.has(n.message.id)&&n.message.text.trim()===pending.text.trim())) return;
    this.pendingSend=null;
    void rpc<Draft|null>('draft.get',{id:pending.id}).then(async draft=>{
      if(!draft||draft.text.trim()!==pending.text.trim())return;
      const removed=await rpc<boolean>('draft.delete',{id:pending.id,expectedAt:draft.updatedAt});
      if(removed&&this.adapter.draftId()===pending.id){this.draftRevision=0;this.state.draft=null;this.emit();}
    }).catch(error=>this.notifyError(error));
  }
  private onSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = this.state.nodes.find(n => n.element.contains(range.startContainer) && n.element.contains(range.endContainer));
    this.selected = node ? { node, text: selection.toString().trim() } : null;
  };
  private onKey = (event: KeyboardEvent) => {
    if (this.state.active && event.target===this.boundComposer && event.key==='Enter' && !event.shiftKey && !event.isComposing && !this.composing) this.rememberSendIntent();
    if (!this.state.active || !this.state.settings.shortcuts || event.isComposing || this.composing || !event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (!['k','o'].includes(key)) return;
    event.preventDefault(); event.stopPropagation(); this.onCommand(key === 'k' ? 'command' : 'outline');
  };
  private rememberSendIntent() {
    const text=this.adapter.getText(this.boundComposer);
    if(text.trim())this.pendingSend={id:this.adapter.draftId(),text,knownIds:new Set(this.state.nodes.map(n=>n.message.id))};
    const send = this.adapter.controls.send();
    if (this.projectChat.projectId && send && !this.adapter.controls.disabled(send)) this.projectChat.recordSend(text);
  }
  private onNativeClick = (event:MouseEvent) => {
    if(!this.state.active || !(event.target instanceof Element) || this.host.contains(event.target))return;
    const nativeNew = this.adapter.sidebarLayout.newChat;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    if ((nativeNew?.contains(event.target) && nativeNew !== this.projectNewControl) ||
        (link && conversationId(link.href) && !link.closest('[data-dsm-owned]'))) this.projectChat.cancel();
    const send = this.adapter.controls.send();
    if (send?.contains(event.target)) { this.rememberSendIntent(); return; }
    const button=event.target.closest('button,[role="button"]');
    if(button && /发送|\bsend\b/i.test([button.getAttribute('aria-label'),button.getAttribute('title')].join(' ')))this.rememberSendIntent();
  };
  private onPageHide = () => { this.flushArchive(); const text = this.adapter.getText(); if (text.trim() && this.state.settings.saveDrafts) void this.saveDraft(this.adapter.draftId(), text); };
  notify(message: string, error = false) {
    this.state.notice = message; this.state.noticeError = error; clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { this.state.notice = ''; this.emit(); }, 4500); this.emit();
  }
  notifyError(error: unknown) { this.notify(error instanceof Error ? error.message : '操作未完成', true); }
  setArchiveView(open: boolean) {
    this.archiveViewOpen = open;
    if (open) void this.loadLibrary().catch(error => this.notifyError(error));
  }
  private invalidateLibrary() {
    this.libraryStale = true;
    if (this.archiveViewOpen) void this.loadLibrary().catch(error => this.notifyError(error));
  }
  private loadLibrary(): Promise<void> {
    if (this.libraryRequest) return this.libraryRequest;
    if (!this.libraryStale) return Promise.resolve();
    this.libraryRequest = Promise.resolve().then(() => this.readLibrary()).finally(() => { this.libraryRequest = undefined; });
    return this.libraryRequest;
  }
  private async readLibrary() {
    if (this.state.libraryStatus !== 'ready') {
      this.state.libraryStatus = 'loading';
      this.emit();
    }
    try {
      do {
        this.libraryStale = false;
        const { conversations, bookmarks, blocked } = await rpc<Library>('library');
        // A write invalidated the request while it was in flight. Read again
        // before exposing the result, especially after clearing the library.
        if (!this.libraryStale) {
          this.state.library = { conversations, bookmarks, blocked };
          this.state.libraryStatus = 'ready';
          this.emit();
        }
      } while (this.libraryStale);
    } catch (error) {
      this.libraryStale = true;
      if (this.state.libraryStatus !== 'ready') {
        this.state.libraryStatus = 'error';
        this.emit();
      }
      throw error;
    }
  }
  refreshLibrary() {
    this.libraryStale = true;
    return this.loadLibrary();
  }
  async refreshPrompts() {
    const run = ++this.promptsRun;
    try {
      const prompts = await rpc<PromptTemplate[]>('prompts.list');
      if (run === this.promptsRun) this.state.prompts = prompts;
    } catch (error) {
      if (run === this.promptsRun) throw error;
    } finally {
      if (run === this.promptsRun) {
        this.state.promptsReady = true;
        this.emit();
      }
    }
  }
  refreshProjects = async () => {
    const run = ++this.projectsRun;
    const projects = await rpc<ProjectWorkspaceData>('projects');
    if (run !== this.projectsRun) return;
    this.state.projects = projects;
    if (this.projectChat.projectId && !projects.projects.some(project => project.id === this.projectChat.projectId)) this.projectChat.cancel();
    this.emit();
  };
  get newProjectName() {
    return this.state.projects?.projects.find(project => project.id === this.projectChat.projectId)?.name;
  }
  newProjectChat(projectId: string | null) {
    const control = this.adapter.sidebarLayout.newChat ?? this.adapter.controls.newChat();
    if (!control?.isConnected || this.adapter.controls.disabled(control)) {
      this.notify('暂时找不到原站新建按钮。请展开原站历史后重试。', true);
      return;
    }
    this.projectChat.cancel();
    if (projectId) this.projectChat.arm(projectId);
    this.projectNewControl = control;
    try { control.click(); } finally { this.projectNewControl = undefined; }
    this.projectChat.routeChanged();
    this.scheduleScan();
    this.emit();
  }
  openProjectChat(chat: ConversationLink, event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    this.projectChat.cancel();
    if (chat.id === this.adapter.id()) { event.preventDefault(); this.emit(); return; }
    const native = this.adapter.sidebarLayout.rows.find(row => row.link.id === chat.id && row.element.isConnected)?.element;
    if (native && conversationId(native.href) === chat.id) { event.preventDefault(); native.click(); }
  }
  async run(action: () => Promise<unknown>) { try { await action(); } catch (error) { this.notifyError(error); } }
  async settings(next: Settings) { this.state.settings = await rpc<Settings>('settings.save', next); this.scan(); }
  toggleFocus() { this.state.focus = !this.state.focus; this.applyAppearance(); this.emitSidebar(); this.emit(); }
  insert(text: string) {
    if (!this.adapter.insertText(text)) { this.notify('尚未识别到可用输入框，请刷新页面后重试'); return false; }
    this.notify('已填入输入框，请检查后发送'); return true;
  }
  async restoreDraft() {
    const draft = this.state.draft; if (!draft) return;
    this.draftRevision = draft.updatedAt; this.conflict = false;
    if (this.insert(draft.text)) { this.state.draft = null; this.emit(); }
  }
  async discardDraft() {
    const draft = this.state.draft; if (!draft) return;
    await rpc('draft.delete',{ id: draft.id, expectedAt: draft.updatedAt });
    this.state.draft = null; this.draftRevision = 0; this.conflict = false;
    const text = this.adapter.getText(); if (text.trim()) await this.saveDraft(this.adapter.draftId(),text); this.emit();
  }
  async bookmark(node?: MessageNode) {
    const chosen = node ? { node, text: node.message.text } : this.selected;
    if (!chosen || !this.state.current) { this.notify('请先选中一条消息的文字，或在目录中点击收藏'); return; }
    const source = this.state.current;
    const bookmark: Bookmark = { id: crypto.randomUUID(), conversationId: source.id, url: source.url, title: source.title,
      messageId: chosen.node.message.id, fingerprint: fingerprint(chosen.node.message.text), text: chosen.text, note: '', createdAt: Date.now() };
    await rpc('bookmark.save',bookmark); this.invalidateLibrary(); this.notify('已加入本地收藏');
  }
  async resume(id: string) {
    await rpc('resume',{ id });
    if (this.state.current?.id === id) { this.pendingArchive = this.state.current; this.flushArchive(); }
    await this.refreshLibrary(); this.notify('已恢复该对话的自动收录');
  }
  async clearData(){
    clearTimeout(this.draftTimer);this.draftTimer=0;this.pendingSend=null;
    this.suppressedDraft={id:this.adapter.draftId(),text:this.adapter.getText()};
    await rpc('clear',{currentId:this.state.current?.id});
    this.draftRevision=0;this.conflict=false;this.state.draft=null;
    await this.refreshLibrary();this.notify('本地数据已清空');
  }
  stop() {
    this.flushArchive(); this.observer?.disconnect();
    this.projectChat.cancel();
    cancelAnimationFrame(this.sidebarFrame);
    for (const timer of [this.scanTimer,this.routeTimer,this.archiveTimer,this.draftTimer,this.noticeTimer]) clearTimeout(timer);
    document.removeEventListener('input',this.onInput,true); document.removeEventListener('compositionstart',this.onCompositionStart,true);
    document.removeEventListener('compositionend',this.onCompositionEnd,true); document.removeEventListener('mouseup',this.onSelection);
    document.removeEventListener('keydown',this.onKey,true); window.removeEventListener('pagehide',this.onPageHide); window.removeEventListener('popstate',this.onHistoryTraversal);
    this.navigation?.removeEventListener('currententrychange', this.onNavigate);
    document.removeEventListener('click',this.onNativeClick,true);
    this.media.removeEventListener('change',this.applyAppearance); chrome.storage.onChanged.removeListener(this.onStorage);
    this.state.active = false;
    this.applyAppearance();
    delete document.documentElement.dataset.mPanel;
    this.readingChrome.stop();
    this.adapter.unmark();
  }
}
