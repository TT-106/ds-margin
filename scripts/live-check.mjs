import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch,closeContext,extensionPopup,call,output } from './browser-utils.mjs';
const context=await launch();
let result;
try{
  const popup=await extensionPopup(context);
  const page=await context.newPage();await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForTimeout(3500);
  result=await page.evaluate(()=>({url:location.origin+location.pathname,title:document.title,adapterActive:document.documentElement.classList.contains('dsm-enabled'),nativeComposerCount:document.querySelectorAll('textarea.ds-textarea__textarea').length,observedMessages:document.querySelectorAll('[data-dsm-message]').length,extensionRootCount:document.querySelectorAll('#ds-margin-root').length}));
  result.savedConversations=(await call(popup,'library')).conversations.length;
  result.authenticatedChatVerified=false;
  result.note='只读检查真实官网；未登录、未发送消息、未修改账号数据。登录后的完整对话流程另需实际账号验收。';
  await page.screenshot({path:join(output,'live-entry.png')});
}catch(error){result={error:String(error),authenticatedChatVerified:false,note:'真实官网访问检查未完成；不能据此声明登录后聊天适配通过。'};process.exitCode=1;}
finally{await writeFile(join(output,'live-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await closeContext(context);}
