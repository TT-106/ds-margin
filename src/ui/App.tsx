import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Controller } from '../content/controller';
import { searchLibrary, type Backup, type Bookmark, type Conversation, type PromptTemplate, type Settings } from '../shared/model';
import { copyText, download, toMarkdown } from '../shared/export';
import { rpc } from '../shared/rpc';
import { readBackup } from '../shared/validation';
import { Icon } from './icons';
import { Command, type Panel } from './Command';
import { TITLES, Toolbar } from './Toolbar';
import { ComposerPrompts } from './ComposerPrompts';
import { Dropdown } from './Dropdown';
import { PromptForm } from './PromptForm';
import { SideQuestionEntry } from '../content/SideQuestionEntry';
import { ProjectWorkspace } from '../content/ProjectWorkspace';

const DOCKED_VIEW = '(width > 1100px)';
const PAGE_CONTROLS = [
  '[data-dsm-owned]', '[data-dsm-composer-box]', 'a[href]', 'button', 'input', 'textarea', 'select', 'label', 'summary',
  'img', 'video', 'canvas', 'svg', '[contenteditable="true"]',
  '[role="button"]', '[role^="menuitem"]', '[role="link"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]', '[role="combobox"]',
].join(',');
function measurePanelScroll(el: HTMLElement) {
  el.toggleAttribute('data-scroll-top', el.scrollTop > 2);
  el.toggleAttribute('data-scroll-bottom', el.scrollTop + el.clientHeight < el.scrollHeight - 2);
}
function hitsText(event: MouseEvent, target: Element) {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  const node = caret?.startContainer;
  if (!caret || !(node instanceof Text) || !target.contains(node)) return false;
  const glyph = document.createRange();
  return [caret.startOffset - 1, caret.startOffset].some(offset => {
    if (offset < 0 || offset >= node.length || !node.data[offset].trim()) return false;
    glyph.setStart(node, offset);
    glyph.setEnd(node, offset + 1);
    return [...glyph.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom);
  });
}
function Empty({ title, children }: { title:string; children:ComponentChildren }) {
  return <div class="empty"><Icon name="book" size={30}/><h3>{title}</h3><p>{children}</p></div>;
}
function Action({ icon, children, onClick, title, className='' }: { icon?:string; children?:ComponentChildren; onClick:()=>void; title?:string; className?:string }) {
  return <button type="button" class={`button ${className}`} title={title} aria-label={title} onClick={onClick}>{icon&&<Icon name={icon}/>} {children}</button>;
}
export function App({ controller:c }: { controller:Controller }) {
  const [,update] = useState(0);
  const [panel,setPanel] = useState<Panel|null>(null);
  const [retracted, setRetracted] = useState(false);
  const [viewed,setViewed] = useState<Conversation|null>(null);
  const [docked, setDocked] = useState(() => matchMedia(DOCKED_VIEW).matches);
  const reading = Boolean(viewed);
  const visiblePanel = retracted ? null : panel;
  const modal = Boolean(visiblePanel && (visiblePanel === 'command' || reading || !docked));
  const sidePanel = Boolean(visiblePanel && visiblePanel !== 'command' && !reading);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement|null>(null);
  const savedConversations = c.state.library.conversations;
  useLayoutEffect(() => c.subscribe(()=>update(n=>n+1)),[c]);
  useLayoutEffect(() => {
    c.setArchiveView(c.state.active && (visiblePanel === 'library' || visiblePanel === 'command' || visiblePanel === 'bookmarks' || visiblePanel === 'settings'));
    return () => c.setArchiveView(false);
  }, [c, visiblePanel, c.state.active]);
  useLayoutEffect(() => {
    if (viewed && !savedConversations.some(item => item.id === viewed.id)) setViewed(null);
  }, [viewed, savedConversations]);
  useLayoutEffect(() => {
    const query = matchMedia(DOCKED_VIEW);
    const change = () => setDocked(query.matches);
    query.addEventListener('change', change);
    change();
    return () => query.removeEventListener('change', change);
  }, []);
  useLayoutEffect(()=>{
    const html=document.documentElement;
    if (sidePanel && c.state.active) html.dataset.mPanel = 'open';
    else delete html.dataset.mPanel;
    return()=>{ delete html.dataset.mPanel; };
  },[sidePanel,c.state.active]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current, content = contentRef.current;
    if (!scroll || !content || retracted) return;
    const refresh = () => measurePanelScroll(scroll);
    const observer = new ResizeObserver(refresh);
    observer.observe(scroll);
    observer.observe(content);
    refresh();
    return () => observer.disconnect();
  }, [panel, reading, retracted, c.state.active]);
  const dismiss = () => {
    setPanel(null);
    setRetracted(false);
    setViewed(null);
  };
  const restoreFocus = () => {
    const previous = lastFocus.current;
    requestAnimationFrame(() => {
      const target = previous?.getClientRects().length ? previous : c.adapter.composer();
      target?.focus({ preventScroll: true });
    });
  };
  const close = () => { dismiss(); restoreFocus(); };
  const open = (next: Panel, trigger?: HTMLElement) => {
    if (visiblePanel === next && !reading) {
      close();
      return;
    }
    if (trigger || !visiblePanel) {
      const root = document.getElementById('ds-margin-root')?.shadowRoot;
      const active = root?.activeElement ?? document.activeElement;
      lastFocus.current = trigger ?? (active instanceof HTMLElement ? active : null);
    }
    setRetracted(false);
    setPanel(next);
    setViewed(null);
  };
  useLayoutEffect(() => {
    c.onCommand = name=>open(name==='command'?'command':'outline');
    return ()=>{ c.onCommand=()=>{}; };
  });
  useLayoutEffect(() => {
    if (!sidePanel || modal || !c.state.active) return;
    const outside = (event: MouseEvent) => {
      if (event.button !== 0 || event.detail === 0 || event.defaultPrevented || !(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest(PAGE_CONTROLS)) return;
      if (document.getSelection()?.isCollapsed === false || hitsText(event, target)) return;
      // Keep the mounted form when an outside click merely retracts the panel.
      setRetracted(true);
    };
    document.addEventListener('click', outside, true);
    return () => document.removeEventListener('click', outside, true);
  }, [sidePanel, modal, c.state.active]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!visiblePanel || !body) return;
    const target = body.querySelector<HTMLElement>('[data-autofocus]') ??
      body.querySelector<HTMLElement>('.panel-header h2');
    target?.focus({ preventScroll: true });
    const root = body.getRootNode() as ShadowRoot;
    const onKey = (event:KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab' && modal) {
        const controls = Array.from(body.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],summary,[tabindex]'))
          .filter((element) => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length);
        const active = root.activeElement;
        const first = controls[0], last = controls.at(-1);
        if (!(active instanceof HTMLElement) || !controls.includes(active) || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    const listener = modal ? document : root;
    listener.addEventListener('keydown', onKey as EventListener);
    return () => listener.removeEventListener('keydown', onKey as EventListener);
  }, [visiblePanel, reading, modal, c.state.active]);
  const s=c.state;
  const run = (action:()=>Promise<unknown>)=>void c.run(action);
  return <div class={`app ${s.settings.reduceMotion?'reduce-motion':''}`}>
    <Toolbar c={c} panel={visiblePanel} suspended={modal} onOpen={open}/>
    {panel&&s.active&&<>
      {modal&&<div class="scrim" onClick={() => {
        if (sidePanel) { setRetracted(true); restoreFocus(); }
        else close();
      }}/>}
      <section ref={bodyRef} hidden={retracted} class={`panel ${modal?'panel-modal':''} ${panel==='command'&&!reading?'command-panel':''} ${reading?'reader-panel':''}`} role={modal?'dialog':'complementary'} aria-modal={modal||undefined} aria-label={viewed?'本地快照':TITLES[panel]}>
        {(panel!=='command'||reading)&&<header class="panel-header"><h2 tabIndex={-1}>{viewed?'本地快照':TITLES[panel]}</h2><button class="icon-button" aria-label="关闭面板" onClick={close}><Icon name="close"/></button></header>}
        <div ref={scrollRef} class="panel-body" onScroll={event=>measurePanelScroll(event.currentTarget)}>
          {panel==='command'&&!reading?<Command c={c} onPanel={setPanel} onView={setViewed} onClose={close}/>:<div ref={contentRef} class="panel-content">
          {viewed?<Snapshot c={c} conversation={viewed} onBack={()=>setViewed(null)}/>:<>
            {panel==='outline'&&<Outline c={c} onLocated={modal ? close : undefined}/>}
            {panel==='library'&&<Library c={c} onView={setViewed}/>}
            {panel==='prompts'&&<Prompts c={c} onInserted={dismiss}/>}
            {panel==='bookmarks'&&<Bookmarks c={c}/>}
            {panel==='settings'&&<Preferences c={c}/>}
          </>}
          </div>}
        </div>
      </section>
    </>}
    <ComposerPrompts c={c} suspended={modal}/>
    <SideQuestionEntry c={c} suspended={modal} renderWorkspace={(hiddenIds, badge) =>
      <ProjectWorkspace c={c} suspended={modal} hiddenIds={hiddenIds} renderSideQuestion={badge} onOpenLibrary={trigger => open('library', trigger)}/>}/>
    {s.draft&&!modal&&<div class="draft-banner" role="status"><Icon name="prompt"/><div><b>未发送的草稿</b><p>{s.draft.text.slice(0,70)}{s.draft.text.length>70?'…':''}</p></div><Action onClick={()=>run(()=>c.restoreDraft())}>插入草稿</Action><button class="icon-button" aria-label="删除恢复草稿" title="删除这份恢复草稿" onClick={()=>run(()=>c.discardDraft())}><Icon name="close"/></button></div>}
    <div class={`toast ${s.notice?'visible':''} ${s.noticeError?'toast-error':''}`} role="status" aria-live="polite">{s.notice&&<><Icon name={s.noticeError?'alert':'check'}/><span>{s.notice}</span></>}</div>
  </div>;
}

function Outline({c,onLocated}:{c:Controller;onLocated?:()=>void}) {
  const [all,setAll]=useState(false),[query,setQuery]=useState('');
  const nodes=c.state.nodes.filter(n=>(all||n.message.role==='user')&&n.message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <label class="search-field"><Icon name="search"/><span class="sr-only">搜索当前消息</span><input data-autofocus value={query} onInput={e=>setQuery(e.currentTarget.value)} placeholder="在当前消息中查找"/></label>
    <div class="segmented"><button aria-pressed={!all} class={!all?'active':''} onClick={()=>setAll(false)}>只看提问</button><button aria-pressed={all} class={all?'active':''} onClick={()=>setAll(true)}>全部消息</button></div>
    <div class="list-caption">当前加载 {c.state.nodes.length} 条消息</div>
    {!nodes.length?<Empty title="暂无消息">加载对话后生成目录。</Empty>:<ol class="outline-list">{nodes.map((node,i)=><li key={node.message.id}>
      <button class="outline-link" onClick={()=>{
        if(c.adapter.locate(node.message.id,node.message.fingerprint)) onLocated?.();
        else c.notify('消息已改变或暂未加载，请刷新目录');
      }}><span class="outline-number">{String(i+1).padStart(2,'0')}</span><span><small>{node.message.role==='user'?'我':'DeepSeek'}</small><b>{node.message.text.slice(0,110)}</b></span></button>
      <button class="icon-button" aria-label={`收藏消息 ${node.message.id}`} title="收藏整条消息" onClick={()=>void c.run(()=>c.bookmark(node))}><Icon name="star" size={16}/></button>
    </li>)}</ol>}
    <Action icon="star" onClick={()=>void c.run(()=>c.bookmark())} className="full">收藏页面中选中的文字</Action>
  </>;
}

function LibraryPending({c,children}:{c:Controller;children:ComponentChildren}) {
  return c.state.libraryStatus === 'error'
    ? <div class="info-box" role="alert">暂时无法读取本地数据。<button class="text-button" onClick={()=>void c.run(()=>c.refreshLibrary())}>重试</button></div>
    : <p class="muted" role="status">{children}</p>;
}

function Library({c,onView}:{c:Controller;onView:(item:Conversation)=>void}) {
  const [query,setQuery]=useState(''),[projectId,setProjectId]=useState(''),[onlyPinned,setPinned]=useState(false),[edit,setEdit]=useState<string|null>(null),[deleting,setDeleting]=useState<string|null>(null);
  const library=c.state.library;
  const projects=c.state.projects?.projects ?? [];
  const activeProject=projects.find(project=>project.id===projectId);
  const folder=activeProject?.name;
  const results=useMemo(()=>searchLibrary(library.conversations,query).filter(r=>(!folder||r.conversation.folder===folder)&&(!onlyPinned||r.conversation.pinned)),[library,query,folder,onlyPinned]);
  const paused = c.state.current&&library.blocked.some(b=>b.id===c.state.current?.id);
  return <>
    <label class="search-field"><Icon name="search"/><span class="sr-only">搜索本地对话</span><input data-autofocus value={query} onInput={e=>setQuery(e.currentTarget.value)} placeholder="搜索标题、正文、标签…"/></label>
    <div class="filter-row">
      <Dropdown label="项目" value={activeProject?.id ?? ''} options={[{value:'',label:'全部项目'},...projects.map(project=>({value:project.id,label:project.name}))]} onChange={setProjectId}/>
      <button class={`chip ${onlyPinned?'active':''}`} aria-pressed={onlyPinned} onClick={()=>setPinned(!onlyPinned)}><Icon name="pin" size={14}/>置顶</button>
    </div>
    {c.state.libraryStatus !== 'ready' ? <LibraryPending c={c}>正在读取本地对话…</LibraryPending> : <>
    {paused&&<div class="info-box">当前对话已暂停收录。<button class="text-button" onClick={()=>void c.run(()=>c.resume(c.state.current!.id))}>恢复收录</button></div>}
    <div class="list-caption">{results.length} 段本地对话 · 已观察内容</div>
    {!results.length?<Empty title={query?'没有匹配结果':'暂无收录'}>{query?'搜索仅覆盖本地已收录内容。':'打开对话后自动保存已加载内容。'}</Empty>:results.map(({conversation:item,snippet})=><article class="library-card" key={item.id}>
      <div class="card-top"><span class="card-date">{new Date(item.capturedAt).toLocaleDateString('zh-CN')}</span>{item.pinned&&<Icon name="pin" size={14}/>}</div>
      <button class="card-title" onClick={()=>onView(item)}>{item.title}</button><p class="card-snippet">{snippet}</p>
      <div class="tags">{item.folder&&<span>{item.folder}</span>}{item.tags.map(t=><span key={t}>#{t}</span>)}<small>{item.messages.length} 条已观察消息</small></div>
      <div class="card-actions"><a href={item.url} class="text-button">打开原对话 <Icon name="external" size={13}/></a><button class="text-button" onClick={()=>setEdit(edit===item.id?null:item.id)}>整理</button><button class="icon-button" aria-label={`删除本地对话 ${item.title}`} title="删除本地归档并暂停收录" onClick={()=>setDeleting(item.id)}><Icon name="trash" size={15}/></button></div>
      {edit===item.id&&c.state.projects&&<Metadata key={item.id} item={item} onSaved={()=>setEdit(null)} c={c}/>}
      {deleting===item.id&&<div class="confirm-box"><p>删除这份本地归档并暂停该对话收录？官网对话保留。</p><Action className="danger" onClick={()=>void c.run(async()=>{await rpc('conversation.delete',{id:item.id});await c.refreshLibrary();setDeleting(null);c.notify('已删除本地归档并暂停收录');})}>确认删除</Action><Action onClick={()=>setDeleting(null)}>取消</Action></div>}
    </article>)}
    </>}
  </>;
}
function Metadata({item,onSaved,c}:{item:Conversation;onSaved:()=>void;c:Controller}) {
  const projects=c.state.projects?.projects ?? [];
  const [projectId,setProjectId]=useState(()=>c.state.projects?.conversations.find(chat=>chat.id===item.id)?.projectId ?? '');
  const [tags,setTags]=useState(item.tags.join('，')),[pinned,setPinned]=useState(item.pinned);
  return <form class="edit-form" onSubmit={e=>{e.preventDefault();void c.run(async()=>{
    await rpc('conversation.meta',{id:item.id,projectId:projectId || null,tags:[...new Set(tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean))],pinned});
    await Promise.all([c.refreshProjects(),c.refreshLibrary()]);
    onSaved();
  });}}>
    <div class="setting-label"><span>所属项目</span><Dropdown label="所属项目" value={projectId} options={[{value:'',label:'未归入项目'},...projects.map(project=>({value:project.id,label:project.name}))]} onChange={setProjectId}/></div>
    <label>标签，用逗号分隔<input value={tags} onInput={e=>setTags(e.currentTarget.value)}/></label>
    <label class="check-label"><input type="checkbox" checked={pinned} onChange={e=>setPinned(e.currentTarget.checked)}/>置顶这段对话</label><button class="button primary" type="submit">保存整理</button>
  </form>;
}
function Snapshot({c,conversation:item,onBack}:{c:Controller;conversation:Conversation;onBack:()=>void}) {
  return <><Action icon="back" onClick={onBack}>返回书库</Action><h3 class="reader-title">{item.title}</h3><div class="info-box">本地已观察内容，可能包含先后浏览过的回答分支。采集于 {new Date(item.capturedAt).toLocaleString('zh-CN')}。</div>
    <div class="export-row"><Action icon="download" onClick={()=>download(`${item.title}.md`,toMarkdown(item))}>Markdown</Action><Action icon="download" onClick={()=>download(`${item.title}.json`,JSON.stringify(item,null,2),'application/json')}>JSON</Action><a class="button" href={item.url}>原对话 <Icon name="external" size={14}/></a></div>
    {item.messages.map(m=><article class="saved-message" key={m.id}><div class="saved-role">{m.role==='user'?'我':'DeepSeek'}<button class="icon-button" aria-label={`复制消息 ${m.id}`} onClick={()=>void c.run(async()=>{await copyText(m.markdown);c.notify('已复制');})}><Icon name="copy" size={14}/></button></div><pre>{m.text}</pre></article>)}
  </>;
}

function Prompts({c,onInserted}:{c:Controller;onInserted:()=>void}) {
  const [chosen,setChosen]=useState<PromptTemplate|null>(null),[editing,setEditing]=useState<PromptTemplate|null>(null),[query,setQuery]=useState('');
  if(editing)return <PromptEditor c={c} initial={editing} onDone={()=>setEditing(null)}/>;
  if(chosen)return <>
    <Action icon="back" onClick={()=>setChosen(null)}>返回提示词</Action><h3 class="reader-title">{chosen.title}</h3>
    <PromptForm key={chosen.id} prompt={chosen} onFill={text=>{if(c.insert(text))onInserted();}}/>
  </>;
  return <>
    <label class="search-field"><Icon name="search"/><span class="sr-only">搜索提示词</span><input data-autofocus value={query} onInput={e=>setQuery(e.currentTarget.value)} placeholder="搜索提示词"/></label>
    <Action icon="plus" className="full dashed" onClick={()=>setEditing({id:crypto.randomUUID(),title:'',body:''})}>新建模板</Action>
    {!c.state.promptsReady&&<p class="muted" role="status">正在读取自定义提示词…</p>}
    <div class="prompt-grid">{c.state.prompts.filter(p=>(p.title+p.body).includes(query)).map((p,i)=><article class="prompt-card" key={p.id}><span class="prompt-index">{String(i+1).padStart(2,'0')}</span><button onClick={()=>setChosen(p)}><h4>{p.title}</h4><p>{p.body.slice(0,70)}</p><span class="prompt-use">使用模板 <Icon name="arrow" size={14}/></span></button><div class="prompt-tools"><button class="text-button" onClick={()=>setEditing({...p,id:crypto.randomUUID()})}>复制编辑</button>{!p.id.startsWith('builtin-')&&<button class="icon-button" aria-label={`删除模板 ${p.title}`} onClick={()=>void c.run(async()=>{await rpc('prompt.delete',{id:p.id});await c.refreshPrompts();})}><Icon name="trash" size={14}/></button>}</div></article>)}</div>
  </>;
}
function PromptEditor({c,initial,onDone}:{c:Controller;initial:PromptTemplate;onDone:()=>void}) {
  const [title,setTitle]=useState(initial.title),[body,setBody]=useState(initial.body);
  return <><Action icon="back" onClick={onDone}>返回提示词</Action><h3 class="reader-title">编辑模板</h3><form class="edit-form" onSubmit={e=>{e.preventDefault();void c.run(async()=>{await rpc('prompt.save',{id:initial.id,title,body});await c.refreshPrompts();onDone();});}}>
    <label>模板名称<input data-autofocus value={title} required maxLength={100} onInput={e=>setTitle(e.currentTarget.value)}/></label><label>模板内容<textarea required rows={10} value={body} maxLength={50_000} onInput={e=>setBody(e.currentTarget.value)} placeholder="用 {{变量名}} 标记每次要填写的内容"/></label><p class="muted">例如：请用三个例子解释「{'{{概念}}'}」。</p><button class="button primary" type="submit">保存模板</button>
  </form></>;
}
function Bookmarks({c}:{c:Controller}) {
  const [query,setQuery]=useState('');
  const items=c.state.library.bookmarks.filter(b=>(b.text+b.title+b.note).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <Action icon="star" className="full primary" onClick={()=>void c.run(()=>c.bookmark())}>收藏选中的文字</Action>
    <label class="search-field"><Icon name="search"/><span class="sr-only">搜索收藏</span><input data-autofocus value={query} onInput={e=>setQuery(e.currentTarget.value)} placeholder="搜索摘录、备注、来源"/></label>
    {c.state.libraryStatus !== 'ready' ? <LibraryPending c={c}>正在读取收藏…</LibraryPending> :
      !items.length?<Empty title="暂无收藏">选中文字后收藏，或在目录中收藏整条消息。</Empty>:items.map(b=><BookmarkCard key={b.id} c={c} item={b}/>)}
  </>;
}
function BookmarkCard({c,item:b}:{c:Controller;item:Bookmark}) {
  const [note,setNote]=useState(b.note),[confirm,setConfirm]=useState(false);
  return <article class="bookmark-card"><blockquote>{b.text}</blockquote><p class="bookmark-source">{b.title}</p><label class="note-field"><span>我的备注</span><textarea rows={2} value={note} maxLength={10_000} onInput={e=>setNote(e.currentTarget.value)} placeholder="为什么想留下这段话…"/></label>
    <div class="card-actions"><button class="text-button" onClick={()=>void c.run(async()=>{await rpc('bookmark.save',{...b,note});await c.refreshLibrary();c.notify('备注已保存');})}>保存备注</button><button class="text-button" onClick={()=>{ if(c.state.current?.id===b.conversationId){if(!c.adapter.locate(b.messageId,b.fingerprint))c.notify('来源消息未加载或已改变，收藏原文仍保留在本地');}else location.assign(`${b.url}#dsm-message=${encodeURIComponent(b.messageId)}&fp=${b.fingerprint}`); }}>定位来源 <Icon name="external" size={13}/></button><button class="icon-button" aria-label="删除这条收藏" onClick={()=>setConfirm(true)}><Icon name="trash" size={15}/></button></div>
    {confirm&&<div class="confirm-box"><p>删除这条本地收藏？</p><Action className="danger" onClick={()=>void c.run(async()=>{await rpc('bookmark.delete',{id:b.id});await c.refreshLibrary();})}>确认删除收藏</Action><Action onClick={()=>setConfirm(false)}>取消</Action></div>}
  </article>;
}

function Preferences({c}:{c:Controller}) {
  const s=c.state.settings;
  const [clearing,setClearing]=useState(false),[incoming,setIncoming]=useState<Backup|null>(null);
  const change=(key:keyof Settings,value:unknown)=>void c.run(()=>c.settings({...s,[key]:value}));
  const current=c.state.current;
  return <>
    <section class="setting-section"><h4>阅读外观</h4><div class="setting-label"><span>主题</span><Dropdown label="主题" value={s.theme}
      options={[{value:'system',label:'跟随系统'},{value:'light',label:'温润书页'},{value:'dark',label:'夜间书房'}]}
      onChange={value=>change('theme',value)}/></div>
      <div class="reading-preview" aria-label="排版预览" style={{fontSize:s.fontSize,lineHeight:s.lineHeight,width:`${Math.round(45+s.contentWidth/24)}%`,marginBottom:s.spacing/2}}>
        <p>查看字形与字号。</p><p>比较两行之间的距离。</p><p>调整适合自己的阅读宽度。</p>
      </div>
      {([{key:'fontSize',label:'正文字号',min:14,max:24,step:1,unit:'px'},{key:'lineHeight',label:'行高',min:1.4,max:2.2,step:.05,unit:''},{key:'contentWidth',label:'内容最大宽度',min:640,max:1200,step:20,unit:'px'},{key:'spacing',label:'消息间距',min:16,max:56,step:2,unit:'px'}] as const).map(field=><label class="range-label" key={field.key}><span>{field.label}<output>{s[field.key]}{field.unit}</output></span><input type="range" min={field.min} max={field.max} step={field.step} value={s[field.key]} onChange={e=>change(field.key,Number(e.currentTarget.value))}/></label>)}
      <Toggle label="减少动态效果" checked={s.reduceMotion} onChange={v=>change('reduceMotion',v)}/>
    </section>
    <section class="setting-section"><h4>本地工具</h4><Toggle label="自动保存已打开对话" description="仅收录已加载正文，可随时关闭" checked={s.autoArchive} onChange={v=>change('autoArchive',v)}/><Toggle label="保存文字草稿" description="按对话保存，恢复时不会覆盖现有输入" checked={s.saveDrafts} onChange={v=>change('saveDrafts',v)}/><Toggle label="启用快捷键" description="Alt+K 命令面板 · Alt+O 目录" checked={s.shortcuts} onChange={v=>change('shortcuts',v)}/></section>
    <section class="setting-section"><h4>导出与备份</h4>
      {c.state.libraryStatus !== 'ready' ? <LibraryPending c={c}>正在读取本地数据…</LibraryPending> :
        <p class="muted">已保存 {c.state.library.conversations.length} 段对话、{c.state.library.bookmarks.length} 条收藏。附件正文和思考过程不在归档范围。</p>}
      <div class="export-row"><Action icon="download" onClick={()=>current?download(`${current.title}.md`,toMarkdown(current)):c.notify('当前没有已加载的对话正文')}>当前页 Markdown</Action><Action icon="download" onClick={()=>current?download(`${current.title}.json`,JSON.stringify(current,null,2),'application/json'):c.notify('当前没有已加载的对话正文')}>当前页 JSON</Action></div>
      <Action icon="download" className="full" onClick={()=>void c.run(async()=>{const b=await rpc<Backup>('backup');download(`DS-Margin-备份-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(b,null,2),'application/json');c.notify('备份已导出，请妥善保存');})}>备份本地数据</Action>
      <label class="import-label button full">导入 DS Margin 备份<input aria-label="导入备份文件" type="file" accept=".json,application/json" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(!file)return;void c.run(async()=>{if(file.size>30_000_000)throw new Error('备份文件不能超过 30MB');setIncoming(readBackup(JSON.parse(await file.text())));});}}/></label>
      {incoming&&<div class="confirm-box"><p>合并导入 {incoming.conversations.length} 段对话、{incoming.bookmarks.length} 条收藏。现有较新记录与当前设置保留。</p><Action className="primary" onClick={()=>void c.run(async()=>{await rpc('import',incoming);await Promise.all([c.refreshLibrary(), c.refreshPrompts()]);setIncoming(null);c.notify('备份合并完成');})}>确认合并导入</Action><Action onClick={()=>setIncoming(null)}>取消</Action></div>}
    </section>
    {c.state.libraryStatus === 'ready'&&<section class="setting-section"><h4>暂停收录的对话</h4>{!c.state.library.blocked.length?<p class="muted">暂时没有暂停的记录。</p>:c.state.library.blocked.map(b=><div class="paused-row" key={b.id}><code>{b.id.slice(0,18)}…</code><button class="text-button" onClick={()=>void c.run(()=>c.resume(b.id))}>恢复收录</button></div>)}</section>}
    <section class="setting-section"><h4>数据与开关</h4><p class="muted">本地库属于当前浏览器配置。切换 DeepSeek 账号不会自动隔离本地记录；共享设备建议使用独立浏览器配置。</p>
      {!clearing?<Action className="full danger" icon="trash" onClick={()=>setClearing(true)}>清空本地数据</Action>:<div class="confirm-box"><p>清空此浏览器中的所有扩展本地数据？已收录对话将暂停自动收录，官网记录仍可在原站查看。</p><Action className="danger" onClick={()=>void c.run(async()=>{await c.clearData();setClearing(false);})}>确认清空本地数据</Action><Action onClick={()=>setClearing(false)}>取消</Action></div>}
      <Action className="full" onClick={()=>void c.run(()=>c.settings({...s,enabled:false}))}>关闭增强，恢复原站外观</Action><p class="hint">可从浏览器工具栏的 DS Margin 图标重新开启。</p>
    </section>
  </>;
}
function Toggle({label,description,checked,onChange}:{label:string;description?:string;checked:boolean;onChange:(value:boolean)=>void}) {
  return <label class="toggle-row"><span><b>{label}</b>{description&&<small>{description}</small>}</span><input class="switch" type="checkbox" role="switch" checked={checked} onChange={e=>onChange(e.currentTarget.checked)}/></label>;
}

