import { render } from 'preact';
import { Controller } from './controller';
import { isAuthRoute } from './adapter';
import { App } from '../ui/App';
import { rpc } from '../shared/rpc';
import { conversationId, normalizeSettings } from '../shared/model';
import pageCss from './page.css?inline';
import uiCss from '../ui/ui.css?inline';
import { claimSideQuestionWorker, runSideQuestionWorker } from '../sidequestions/worker';

const html=document.documentElement;
if (window.top === window) {
  document.addEventListener('ds-margin:native-conversations-deleted', event => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string' || event.detail.length > 65_536) return;
    try {
      const ids: unknown = JSON.parse(event.detail);
      if (!Array.isArray(ids) || ids.length > 500) return;
      for (const parentId of new Set(ids)) if (typeof parentId === 'string' &&
          conversationId(location.origin + '/a/chat/s/' + parentId) === parentId) {
        void rpc('side.parent.deleted', { parentId }).catch(() => {});
      }
    } catch { /* Ignore invalid page messages. */ }
  });
}
const sideWorker = claimSideQuestionWorker().catch(() => null);
const revealPage=()=>{html.dataset.dsmStartup='ready';};
const settingsKey = 'ds-margin:settings';
const savedSettings = chrome.storage.local.get(settingsKey).then(values => {
  const value = values[settingsKey];
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof raw.reduceMotion === 'boolean') return normalizeSettings(raw);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  void rpc('settings.bootstrap', { reduced }).catch(() => {});
  return normalizeSettings({ ...raw, reduceMotion: reduced });
}).then(settings=>{
  if (html.dataset.dsmStartup!=='ready') html.dataset.dsmStartup=settings.enabled ? settings.theme : 'ready';
  return settings;
}, () => { revealPage(); return null; });

function installPageStyle() {
  const pageStyle=document.createElement('style');
  pageStyle.id='ds-margin-page-style'; pageStyle.dataset.dsmOwned='';
  pageStyle.textContent=__DS_FONT_CSS__.replaceAll('__FONT_BASE__',chrome.runtime.getURL('fonts/'))+'\n'+pageCss;
  html.append(pageStyle);
  return pageStyle;
}

async function start() {
  if (window.top!==window || document.getElementById('ds-margin-root')) return;
  const worker = await sideWorker;
  if (worker) {
    // The original chat still needs to finish parsing before the worker observes it.
    if (document.readyState === 'loading') {
      await new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
    }
    const settings = await savedSettings;
    if (settings?.enabled && !isAuthRoute()) {
      installPageStyle();
      html.dataset.dsmTheme = settings.theme === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        : settings.theme;
      html.classList.add('dsm-enabled');
      html.classList.toggle('dsm-reduced', settings.reduceMotion);
      html.style.setProperty('--dsm-font-size', `${settings.fontSize}px`);
      html.style.setProperty('--dsm-leading', String(settings.lineHeight));
      html.style.setProperty('--dsm-spacing', `${settings.spacing}px`);
    }
    revealPage();
    await runSideQuestionWorker(worker);
    return;
  }
  const pageStyle = installPageStyle();
  const host=document.createElement('div'); host.id='ds-margin-root';host.dataset.dsmOwned='';host.hidden=true;
  host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483000';
  const shadow=host.attachShadow({mode:'open'}),style=document.createElement('style'),mount=document.createElement('div');
  style.textContent=uiCss;shadow.append(style,mount);document.documentElement.append(host);
  const controller=new Controller(host);
  render(<App controller={controller}/>,mount);
  void savedSettings.then(settings => {
    if (!settings) throw new Error('暂时无法读取扩展设置');
    return controller.start(settings);
  }).catch(error=>{
    revealPage();
    controller.stop();render(null,mount);host.remove();pageStyle.remove();
    console.error('[DS Margin] 启动失败，已保留原站界面',error instanceof Error?error.message:'未知错误');
  });
}
if (document.body) void start();
else {
  // Start the toolbar as soon as the chat body can exist, even if a later script stalls parsing.
  const waitForBody = new MutationObserver(() => {
    if (!document.body) return;
    waitForBody.disconnect();
    void start();
  });
  waitForBody.observe(html, { childList: true });
}
