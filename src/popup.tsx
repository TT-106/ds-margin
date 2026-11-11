import { render } from 'preact';
import { useEffect,useState } from 'preact/hooks';
import { DEFAULT_SETTINGS,normalizeSettings,type Settings } from './shared/model';
import { rpc } from './shared/rpc';
import { Icon } from './ui/icons';
import { Dropdown } from './ui/Dropdown';
import themeCss from './ui/theme.css?inline';
import dropdownCss from './ui/dropdown.css?inline';
const style=document.createElement('style');
document.documentElement.classList.add('dsm-popup');
style.textContent=__DS_FONT_CSS__.replaceAll('__FONT_BASE__',chrome.runtime.getURL('fonts/'))+'\n'+themeCss+`
*{box-sizing:border-box}
body{margin:0;width:320px;padding:24px;background:var(--dsm-paper);color:var(--dsm-ink);font:13px/1.7 var(--dsm-font-ui)}
input{font:inherit;color:inherit}
header{display:flex;align-items:center;gap:11px;border-bottom:1px solid var(--dsm-line);padding-bottom:15px}
header i{color:var(--dsm-accent);font:italic 600 23px/1 var(--dsm-font-read)}
h1{font:600 21px/1.2 var(--dsm-font-read);margin:0}
label,.popup-setting{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0}
.popup-setting .dropdown-trigger{width:148px}
input{accent-color:var(--dsm-accent);width:17px;height:17px}
a{display:block;text-align:center;text-decoration:none;padding:9px;border-radius:var(--dsm-radius-control);background:var(--dsm-accent);color:var(--dsm-on-accent);margin-top:20px}
a:hover{background:color-mix(in srgb,var(--dsm-accent) 88%,var(--dsm-ink))}
footer{color:var(--dsm-muted);font-size:12px;margin-top:12px}
:is(a,input):focus-visible{outline:2px solid var(--dsm-focus-line);outline-offset:2px}
.error{display:flex;align-items:flex-start;gap:6px;padding:9px;color:var(--dsm-error);background:color-mix(in srgb,var(--dsm-error) 8%,var(--dsm-surface));border-radius:var(--dsm-radius-control)}
`+'\n'+dropdownCss;
document.head.append(style);
function Popup(){
  const [s,setS]=useState<Settings>(DEFAULT_SETTINGS),[ready,setReady]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    void rpc<Settings>('settings').then(value=>{setS(value);setReady(true);}).catch(e=>setError(String(e.message)));
    const listener=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='local'&&changes['ds-margin:settings'])setS(normalizeSettings(changes['ds-margin:settings'].newValue));};
    chrome.storage.onChanged.addListener(listener);return()=>chrome.storage.onChanged.removeListener(listener);
  },[]);
  useEffect(()=>{
    const media=matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{document.documentElement.dataset.dsmTheme=s.theme==='system'?(media.matches?'dark':'light'):s.theme;};
    apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);
  },[s.theme]);
  const save=async(next:Settings)=>{try{setS(await rpc<Settings>('settings.save',next));setError('');}catch(e){setError(e instanceof Error?e.message:'保存失败');}};
  return <>
    <header><i aria-hidden="true">m.</i><h1>DS Margin</h1></header>
    <label>启用界面增强<input type="checkbox" checked={s.enabled} disabled={!ready} onChange={e=>void save({...s,enabled:e.currentTarget.checked})}/></label>
    <div class="popup-setting"><span>阅读主题</span><Dropdown<Settings['theme']> label="阅读主题" value={s.theme} disabled={!ready}
      onChange={theme=>void save({...s,theme})} options={[
        {value:'system',label:'跟随系统'},{value:'light',label:'温润书页'},{value:'dark',label:'夜间书房'},
      ]}/></div>
    <label>自动保存已打开对话<input type="checkbox" checked={s.autoArchive} disabled={!ready} onChange={e=>void save({...s,autoArchive:e.currentTarget.checked})}/></label>
    {error&&<p role="alert" class="error"><Icon name="alert" size={15}/>{error}</p>}
    <a href="https://chat.deepseek.com/" target="_blank" rel="noreferrer">打开 DeepSeek ↗</a>
    <footer>工具位于聊天页右侧。扩展数据保存在本地。<br/>更新扩展后请刷新聊天页。 · {chrome.runtime.getManifest().version}</footer>
  </>;
}
render(<Popup/>,document.getElementById('app')!);
