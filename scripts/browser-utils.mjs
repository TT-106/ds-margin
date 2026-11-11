import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { readFile,readdir,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join,resolve,dirname,basename } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
export const output=join(root,'output','playwright',version,process.env.DS_MARGIN_TEST_LABEL==='edge'?'edge':'');
const profiles=new WeakMap();
export async function launch({ viewport = {width:1440,height:1000} } = {}) {
  await mkdir(output,{recursive:true});
  let executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!existsSync(executable)) {
    const cache=join(process.env.LOCALAPPDATA??'','ms-playwright');
    const candidates=(await readdir(cache).catch(()=>[])).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
    for (const dir of candidates) {
      const path=join(cache,dir,'chrome-win64','chrome.exe');
      if (existsSync(path)) {executable=path;break;}
    }
  }
  if (!existsSync(executable)) throw new Error('未找到 Chromium；请运行 npx playwright install chromium');
  const profile=await mkdtemp(join(output,'profile-'));
  const context=await chromium.launchPersistentContext(profile,{executablePath:executable,headless:true,viewport,
    ...(viewport ? {deviceScaleFactor:1} : {}),
    args:[`--disable-extensions-except=${join(root,'dist')}`,`--load-extension=${join(root,'dist')}`,...(viewport ? [] : ['--screen-info={1600x1200}'])]});
  profiles.set(context,profile);return context;
}
export async function closeContext(context){
  await context.close();
  const profile=profiles.get(context);
  if(!profile)return;
  if(dirname(resolve(profile))!==resolve(output)||!basename(profile).startsWith('profile-'))throw new Error('拒绝清理未经验证的测试目录');
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});profiles.delete(context);
}
export async function extensionPopup(context) {
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host,popup=await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByLabel('启用界面增强').waitFor();
  return popup;
}
export async function call(popup,action,data) {
  const result=await popup.evaluate(async({action,data})=>chrome.runtime.sendMessage({source:'ds-margin',action,data}),{action,data});
  if (!result?.ok)throw new Error(result?.error??'RPC failed');return result.value;
}
export async function chooseDropdown(page, label, option) {
  await page.getByRole('combobox',{name:label,exact:true}).click();
  await page.getByRole('listbox',{name:label,exact:true}).getByRole('option',{name:option,exact:true}).click();
}
export async function poll(fn,predicate,timeout=10000) {
  const end=Date.now()+timeout;let result;
  while(Date.now()<end){result=await fn();if(predicate(result))return result;await new Promise(resolve=>setTimeout(resolve,140));}
  throw new Error(`等待条件超时，最后结果：${JSON.stringify(result).slice(0,500)}`);
}
