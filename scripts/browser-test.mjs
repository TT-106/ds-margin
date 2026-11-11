import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch,closeContext,extensionPopup,call,chooseDropdown,poll,root,output } from './browser-utils.mjs';
const fixture=await readFile(join(root,'tests','fixture.html'),'utf8');
const interfaceFixture=await readFile(join(root,'tests','interface-fixture.html'),'utf8');
const results=[],errors=[];
const context=await launch();
let page,popup;
const url='https://chat.deepseek.com/a/chat/s/test-chat-001';
async function test(name,fn){const start=Date.now();try{await fn();results.push({name,passed:true,ms:Date.now()-start});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,error:String(error)});console.error(`FAIL ${name}: ${error}`);throw error;}}
try{
  await context.route('https://chat.deepseek.com/**',route=>route.fulfill({status:200,contentType:'text/html',
    body:new URL(route.request().url()).pathname.endsWith('/solid-state-battery')?interfaceFixture:fixture,
    headers:{'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' chrome-extension:; img-src 'self' data:"}}));
  popup=await extensionPopup(context);
  await test('网页解析期间先绘制纸色，输入框就绪后工具栏可点击', async () => {
    const startup = await context.newPage();
    const entry = 'https://chat.deepseek.com/?first-paint';
    const blocker = 'https://chat.deepseek.com/hold-startup.js';
    let finishParsing;
    const parsingGate = new Promise(resolve => { finishParsing = resolve; });
    await startup.emulateMedia({colorScheme:'light', reducedMotion:'reduce'});
    await startup.route(entry, route => route.fulfill({contentType:'text/html', body:`<!doctype html>
      <style>html,body,#root{margin:0;min-height:100vh;background:#2454f5}#root{position:relative;z-index:2147483647}</style>
      <div id="root"></div>
      <script>
        requestAnimationFrame(() => {
          const html = document.documentElement;
          window.startupFrame = {
            stage: document.readyState,
            foreground: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName,
            color: getComputedStyle(html, '::after').backgroundColor,
          };
          const composer = document.createElement('textarea');
          composer.className = 'ds-textarea__textarea';
          composer.placeholder = 'Message DeepSeek';
          const root = document.getElementById('root');
          root.style.zIndex = 'auto';
          root.append(composer);
        });
      </script><script src="${blocker}"></script>`}));
    await startup.route(blocker, async route => {
      await parsingGate;
      await route.fulfill({contentType:'application/javascript', body:''});
    });
    try {
      await startup.goto(entry, {waitUntil:'commit'});
      await startup.waitForFunction(() => window.startupFrame);
      assert.deepEqual(await startup.evaluate(() => window.startupFrame), {
        stage:'loading', foreground:'HTML', color:'rgb(245, 242, 234)',
      });
      const startupToolbar = startup.getByRole('navigation', {name:'DS Margin 工具栏'});
      await startupToolbar.getByRole('button', {name:'设置',exact:true}).click();
      await startup.getByRole('complementary', {name:'设置',exact:true}).waitFor();
      assert.equal(await startup.evaluate(() => document.readyState), 'loading');
      await startup.getByRole('button', {name:'关闭面板',exact:true}).click();
      finishParsing();
      assert.deepEqual(await startup.evaluate(() => ({
        cover: getComputedStyle(document.documentElement, '::after').content,
        color: getComputedStyle(document.documentElement).backgroundColor,
        chat: getComputedStyle(document.getElementById('root')).backgroundColor,
      })), {cover:'none', color:'rgb(245, 242, 234)', chat:'rgba(0, 0, 0, 0)'});
      await startup.getByRole('textbox').click();
    } finally {
      finishParsing();
      await startup.close();
    }
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const fontDenials=[];
  page.on('console',message=>{
    if (/^Denying load of chrome-extension:\/\/[^/]+\/fonts\//.test(message.text())) fontDenials.push(message.text());
  });
  await page.goto(url);await page.waitForSelector('html.dsm-enabled');
  const toolbar=page.getByRole('navigation',{name:'DS Margin 工具栏'});
  const nativeInput=page.getByRole('textbox',{name:'给 DeepSeek 发送消息'});
  const more=toolbar.getByRole('button',{name:'更多工具',exact:true});
  async function openTool(name) {
    const button=toolbar.getByRole('button',{name,exact:true});
    if(!await button.isVisible()) await more.click();
    await button.click();
  }
  await test('真实 MV3 扩展加载、原生输入框保留、打包中文衬线字体可加载',async()=>{
    await toolbar.waitFor();assert.equal(await nativeInput.count(),1);
    const font=await page.evaluate(async()=>{await document.fonts.load('16px "Noto Serif SC Variable"','给思考留一点余白');return {family:getComputedStyle(document.querySelector('textarea')).fontFamily,loaded:document.fonts.check('16px "Noto Serif SC Variable"','留白')};});
    assert.match(font.family,/Noto Serif SC Variable/);assert.equal(font.loaded,true);
    assert.match(font.family,/Lora Variable/);
    await openTool('设置');
    assert.match(await page.locator('.panel').evaluate(el=>getComputedStyle(el).backdropFilter),/blur/);
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  });
  await test('旧任务入口和后台指令已移除，原生会话链接仍可见',async()=>{
    assert.equal(await toolbar.getByRole('button',{name:'任务',exact:true}).count(),0);
    assert.equal(await page.locator('[data-dsm-task-history]').count(),0);
    await assert.rejects(call(popup,'task.list'),/未知操作/);
    assert.ok(await page.locator('a[data-dsm-sidebar-row]').first().isVisible());
  });
  await test('DeepSeek 页面可加载注入 CSS 引用的所有字体文件',async()=>{
    const fonts=await page.evaluate(async()=>{
      const css=document.querySelector('#ds-margin-page-style').textContent;
      const urls=[...new Set([...css.matchAll(/chrome-extension:\/\/[^"'\s)]+\/fonts\/[^"'\s)]+/g)].map(match=>match[0]))];
      const results=await Promise.allSettled(urls.map((url,index)=>new FontFace(`dsm-font-check-${index}`,`url("${url}")`).load()));
      return {count:urls.length,blocked:urls.filter((_,index)=>results[index].status==='rejected')};
    });
    assert.ok(fonts.count>0,'页面样式应引用本地字体');
    assert.deepEqual(fonts.blocked,[]);
    assert.deepEqual(fontDenials,[]);
  });
  await test('常驻工具栏和阅读设置共用一条轴线，更多菜单支持键盘和焦点返回',async()=>{
    assert.equal(await toolbar.getByRole('button').count(),4);
    const [dock, profile] = await Promise.all([toolbar.boundingBox(), toolbar.getByRole('button',{name:'设置',exact:true}).boundingBox()]);
    assert.ok(dock.height<270);
    assert.ok(Math.abs(dock.x+dock.width/2-profile.x-profile.width/2)<1);
    await more.focus();
    await page.keyboard.press('Enter');
    const menu=toolbar.getByRole('group',{name:'更多工具'});
    await menu.waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await menu.getByRole('button',{name:'命令',exact:true}).evaluate(el=>el.getRootNode().activeElement===el),true);
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'detached'});
    assert.equal(await more.evaluate(el=>el.getRootNode().activeElement===el),true);
    await more.click();
    await nativeInput.click();
    await menu.waitFor({state:'detached'});
    await more.click();
    await toolbar.getByRole('button',{name:'命令',exact:true}).click();
    await page.keyboard.press('Escape');
    await poll(()=>more.evaluate(el=>el.getRootNode().activeElement===el),x=>x===true);
  });
  await test('自动归档用户正文和最终回答，排除思考过程',async()=>{
    const lib=await poll(()=>call(popup,'library'),x=>x.conversations[0]?.messages.length===4);
    assert.ok(!JSON.stringify(lib.conversations).includes('这段思考过程'));assert.equal(lib.conversations[0].scope,'observed');
  });
  await test('目录定位与收藏整条消息',async()=>{
    await openTool('目录');
    assert.equal(await page.locator('.outline-list li').count(),2);
    await page.getByRole('button',{name:'全部消息',exact:true}).click();
    await page.getByRole('button',{name:'收藏消息 2',exact:true}).click();
    await poll(()=>call(popup,'library'),x=>x.bookmarks.length===1);
    await page.screenshot({path:join(output,'reading-light.png')});
  });
  await test('提示词变量填入原生输入框，不自动发送',async()=>{
    await openTool('提示词');
    await page.locator('.prompt-card').filter({hasText:'解释一个概念'}).locator('button').first().click();
    await page.getByLabel('概念',{exact:true}).fill('第一性原理');
    await page.getByRole('button',{name:'填入输入框',exact:true}).click();
    assert.match(await nativeInput.inputValue(),/第一性原理/);assert.equal(await page.evaluate(()=>window.fixture.sent),0);
    assert.ok(await page.evaluate(()=>window.fixture.inputEvents)>0);
    await poll(()=>nativeInput.evaluate(el=>document.activeElement===el),x=>x===true);
  });
  await test('自定义提示词创建、复制与删除入口',async()=>{
    await openTool('提示词');
    await page.getByRole('button',{name:'新建模板',exact:true}).click();
    await page.getByLabel('模板名称',{exact:true}).fill('测试模板');await page.getByLabel('模板内容',{exact:true}).fill('解释 {{对象}} 的限制');
    await page.getByRole('button',{name:'保存模板',exact:true}).click();
    await poll(()=>call(popup,'library'),x=>x.prompts.some(p=>p.title==='测试模板'));
    await page.getByRole('button',{name:'删除模板 测试模板',exact:true}).click();
    await poll(()=>call(popup,'library'),x=>!x.prompts.some(p=>p.title==='测试模板'));
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  });
  await test('草稿持久化与刷新恢复，原有输入不会被自动覆盖',async()=>{
    await nativeInput.fill('一份将在刷新后恢复的草稿');
    await poll(()=>call(popup,'draft.get',{id:'test-chat-001'}),x=>x?.text==='一份将在刷新后恢复的草稿');
    await page.reload();await page.locator('.draft-banner').waitFor();assert.equal(await nativeInput.inputValue(),'');
    await nativeInput.fill('现在已输入：');await page.getByRole('button',{name:'插入草稿',exact:true}).click();
    assert.equal(await nativeInput.inputValue(),'现在已输入：一份将在刷新后恢复的草稿');
    await poll(()=>call(popup,'draft.get',{id:'test-chat-001'}),x=>x?.text==='现在已输入：一份将在刷新后恢复的草稿');
  });
  await test('中文输入法组合期间不保存半成品、不触发 Alt 快捷键',async()=>{
    const before=await call(popup,'draft.get',{id:'test-chat-001'});
    await nativeInput.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='正在拼写的中文';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,altKey:true,key:'k',isComposing:true}));});
    await new Promise(r=>setTimeout(r,850));assert.equal((await call(popup,'draft.get',{id:'test-chat-001'})).text,before.text);
    assert.equal(await page.locator('.command-panel').count(),0);
    await nativeInput.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
    await poll(()=>call(popup,'draft.get',{id:'test-chat-001'}),x=>x?.text==='正在拼写的中文');
  });
  await test('原站发送、流式输出及发送后草稿清理',async()=>{
    await nativeInput.fill('请测试流式输出');await new Promise(r=>setTimeout(r,750));
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-virtual-list-item-key="6"]')?.textContent?.includes('均保持正常。'));
    const lib=await poll(()=>call(popup,'library'),x=>x.conversations[0]?.messages.length===6);
    assert.match(lib.conversations[0].messages.at(-1).text,/流式输出已完成/);assert.equal(await page.evaluate(()=>window.fixture.sent),1);
    await poll(()=>call(popup,'draft.get',{id:'test-chat-001'}),x=>x===null);
  });
  await test('收藏备注保存、消息改变时拒绝错误定位',async()=>{
    await openTool('收藏');
    await page.getByLabel('我的备注',{exact:true}).fill('这一段适合之后重读');await page.getByRole('button',{name:'保存备注',exact:true}).click();
    await poll(()=>call(popup,'library'),x=>x.bookmarks[0]?.note==='这一段适合之后重读');
    await page.evaluate(()=>window.fixture.replace('2','已经修改的回答正文'));
    await new Promise(r=>setTimeout(r,850));await page.getByRole('button',{name:'定位来源',exact:true}).click();
    await poll(()=>page.locator('.toast').innerText(),x=>x.includes('已改变'));
    assert.match((await call(popup,'library')).bookmarks[0].text,/呼吸的空间/);
  });
  await test('本地检索、项目、标签和置顶可持久化',async()=>{
    await call(popup,'project.create',{name:'阅读实验'});
    await openTool('书库');
    await page.getByLabel('搜索本地对话',{exact:true}).fill('代码例子');assert.equal(await page.locator('.library-card').count(),1);
    await page.getByRole('button',{name:'整理',exact:true}).click();
    await chooseDropdown(page,'所属项目','阅读实验');
    await page.getByLabel('标签，用逗号分隔',{exact:true}).fill('衬线，测试');await page.getByLabel('置顶这段对话',{exact:true}).check();
    await page.getByRole('button',{name:'保存整理',exact:true}).click();
    const lib=await poll(()=>call(popup,'library'),x=>x.conversations[0]?.folder==='阅读实验');assert.equal(lib.conversations[0].pinned,true);
    assert.deepEqual(lib.conversations[0].tags,['衬线','测试']);
  });
  await test('原生虚拟列表移除消息后，本地归档不会丢失已观察内容',async()=>{
    await page.evaluate(()=>window.fixture.hideFirst());await new Promise(r=>setTimeout(r,3000));
    const lib=await call(popup,'library');assert.equal(lib.conversations[0].messages.length,6);assert.equal(lib.conversations[0].folder,'阅读实验');
  });
  await test('删除本地对话后不自动重建，手动恢复收录生效',async()=>{
    await page.getByRole('button',{name:/删除本地对话 /}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await poll(()=>call(popup,'library'),x=>x.conversations.length===0&&x.blocked.length===1);
    await page.evaluate(()=>window.fixture.replace('4','删除后仍在继续变化的消息'));await new Promise(r=>setTimeout(r,3000));assert.equal((await call(popup,'library')).conversations.length,0);
    await page.getByRole('button',{name:'恢复收录',exact:true}).click();await poll(()=>call(popup,'library'),x=>x.conversations.length===1&&x.blocked.length===0);
  });
  await test('当前页 Markdown / JSON 导出与完整备份下载',async()=>{
    await openTool('设置');
    const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'当前页 Markdown',exact:true}).click();
    const file=await downloadEvent;const content=await readFile(await file.path(),'utf8');assert.match(content,/不代表完整历史/);assert.ok(file.suggestedFilename().endsWith('.md'));
    const jsonEvent=page.waitForEvent('download');await page.getByRole('button',{name:'当前页 JSON',exact:true}).click();
    const jsonFile=await jsonEvent,json=JSON.parse(await readFile(await jsonFile.path(),'utf8'));assert.equal(json.id,'test-chat-001');assert.equal(json.scope,'observed');assert.ok(Array.isArray(json.messages));
    const backupEvent=page.waitForEvent('download');await page.getByRole('button',{name:'备份本地数据',exact:true}).click();
    const backupFile=await backupEvent,backup=JSON.parse(await readFile(await backupFile.path(),'utf8'));assert.equal(backup.format,'ds-margin');assert.equal(backup.bookmarks.length,1);
  });
  await test('主题切换、衬线设置和深色界面',async()=>{
    await chooseDropdown(page,'主题','夜间书房');await page.waitForSelector('html[data-dsm-theme="dark"]');
    await openTool('提示词');await page.screenshot({path:join(output,'prompts-dark.png'),animations:'disabled'});
    assert.match(await nativeInput.evaluate(el=>getComputedStyle(el).fontFamily),/Noto Serif/);
  });
  await test('命令面板键盘入口、Escape 关闭与专注模式',async()=>{
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();await page.keyboard.press('Alt+k');await page.locator('.command-panel').waitFor();
    await page.getByLabel('搜索命令与本地对话',{exact:true}).fill('专注');await page.getByRole('option',{name:'开启专注模式',exact:true}).click();
    assert.ok(await page.locator('html.dsm-focus').count());await openTool('专注模式');
    await page.keyboard.press('Alt+k');await page.locator('.command-panel').waitFor();await page.keyboard.press('Escape');await page.locator('.command-panel').waitFor({state:'detached'});
  });
  await test('加载与草稿同文的旧提问不会误删未发送草稿',async()=>{
    await call(popup,'draft.save',{id:'test-chat-001',text:'我想让聊天界面更适合长时间阅读。应该从哪里开始？',updatedAt:Date.now(),expectedAt:0});
    await page.reload();await page.locator('.draft-banner').waitFor();await new Promise(r=>setTimeout(r,900));
    assert.ok((await call(popup,'draft.get',{id:'test-chat-001'}))?.text);
    await page.getByRole('button',{name:'删除恢复草稿',exact:true}).click();
    await poll(()=>call(popup,'draft.get',{id:'test-chat-001'}),x=>x===null);
  });
  await test('两标签页草稿冲突不静默覆盖',async()=>{
    await call(popup,'draft.delete',{id:'test-chat-001'});await page.reload();await page.waitForSelector('html.dsm-enabled');
    const second=await context.newPage();await second.goto(url);await second.waitForSelector('html.dsm-enabled');await new Promise(r=>setTimeout(r,500));
    await nativeInput.fill('标签页 A 的草稿');await poll(()=>call(popup,'draft.get',{id:'test-chat-001'}),x=>x?.text==='标签页 A 的草稿');
    const secondInput=second.getByRole('textbox',{name:'给 DeepSeek 发送消息'});await secondInput.fill('标签页 B 的不同草稿');
    await second.locator('.draft-banner').waitFor();assert.equal(await secondInput.inputValue(),'标签页 B 的不同草稿');assert.equal((await call(popup,'draft.get',{id:'test-chat-001'})).text,'标签页 A 的草稿');await second.close();
  });
  await test('按会话恢复草稿，切换对话不串用',async()=>{
    await page.goto('https://chat.deepseek.com/a/chat/s/test-chat-002');await page.waitForSelector('html.dsm-enabled');await new Promise(r=>setTimeout(r,800));
    assert.equal(await nativeInput.inputValue(),'');assert.equal(await page.locator('.draft-banner').count(),0);
  });
  await test('非法备份全量拒绝，合法备份合并不覆盖当前设置',async()=>{
    const b=await call(popup,'backup'),before=(await call(popup,'library')).conversations.length;
    const corrupt=structuredClone(b);corrupt.conversations[0].url='https://evil.example/chat/fake';
    await assert.rejects(()=>call(popup,'import',corrupt));assert.equal((await call(popup,'library')).conversations.length,before);
    b.settings.theme='light';await call(popup,'import',b);assert.equal((await call(popup,'settings')).theme,'dark');
  });
  await test('宽屏停靠、窄屏满宽弹层、目录定位和减少动画',async()=>{
    await call(popup,'settings.save',{...await call(popup,'settings'),theme:'light',reduceMotion:true});
    await openTool('目录');
    for (const [width,height] of [[1440,900],[1320,900],[1280,900],[1101,900],[1100,900],[1024,900],[768,900],[390,760],[375,760],[667,375]]){
      await page.setViewportSize({width,height});
      await page.getByRole(width>1100?'complementary':'dialog',{name:'目录',exact:true}).waitFor();
      const bounds=await page.locator('.panel').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,overflow:el.scrollWidth>el.clientWidth+1}));
      assert.ok(bounds.left>=0&&bounds.right<=width);assert.equal(bounds.overflow,false);
      if(width>1100){
        const nativeRight=await page.locator('#root').evaluate(el=>el.getBoundingClientRect().right);
        assert.ok(nativeRight<=bounds.left+1,'宽屏工具面板不应覆盖原生聊天区');
      }else assert.equal(await toolbar.isVisible(),false);
      if(width<=719) assert.ok(bounds.right-bounds.left>=width-17);
    }
    await page.setViewportSize({width:375,height:760});
    await page.screenshot({path:join(output,'reading-narrow.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await toolbar.waitFor();
    assert.equal(await toolbar.getByRole('button').count(),2);
    await openTool('目录');
    const narrow=page.getByRole('dialog',{name:'目录',exact:true});
    await narrow.locator('.outline-link').first().click();
    await narrow.waitFor({state:'detached'});
    await page.locator('[data-dsm-highlight]').waitFor();
    await poll(()=>more.evaluate(el=>el.getRootNode().activeElement===el),x=>x===true);
    await page.setViewportSize({width:1440,height:1000});
  });
  await test('正文与输入区对齐，发送键在宽窄屏均可点击',async()=>{
    assert.equal(await page.getByRole('button',{name:'关闭面板',exact:true}).count(),0);
    for (const width of [1440,1280,768,390,375]) {
      await page.setViewportSize({width,height:760});
      const position=await page.evaluate(()=>{
        const column=document.querySelector('[data-dsm-reading-column]').getBoundingClientRect();
        const composer=document.querySelector('[data-dsm-composer-aligned]').getBoundingClientRect();
        const native=document.querySelector('#send');
        const {x,y,width,height}=native.getBoundingClientRect();
        return {aligned:Math.abs(column.left-composer.left)<2&&Math.abs(column.right-composer.right)<2,hit:native.contains(document.elementFromPoint(x+width/2,y+height/2))};
      });
      assert.deepEqual(position,{aligned:true,hit:true});
    }
    await page.setViewportSize({width:1440,height:1000});
  });
  await test('原生停止生成按钮仍能中断流式内容',async()=>{
    await nativeInput.fill('中途停止生成的测试');await page.getByRole('button',{name:'发送',exact:true}).click();
    const stop=page.getByRole('button',{name:'停止生成',exact:true});await stop.waitFor();await stop.click();
    const body=page.locator('[data-virtual-list-item-key="6"] .ds-assistant-message-main-content');
    const stopped=await body.innerText();await new Promise(r=>setTimeout(r,900));assert.equal(await body.innerText(),stopped);assert.ok(!stopped.includes('均保持正常。'));
  });
  await test('扩展开关恢复原站，重新启用不重复挂载',async()=>{
    await popup.getByLabel('启用界面增强').uncheck();await page.waitForFunction(()=>!document.documentElement.classList.contains('dsm-enabled'));
    assert.equal(await toolbar.isVisible(),false);assert.equal(await page.locator('[data-dsm-message]').count(),0);assert.equal(await nativeInput.count(),1);
    await popup.getByLabel('启用界面增强').check();await page.waitForSelector('html.dsm-enabled');assert.equal(await page.locator('#ds-margin-root').count(),1);
  });
  await test('清空本地数据后，当前页和另一标签页不会在离开时重建旧草稿',async()=>{
    const other=await context.newPage();await other.goto('https://chat.deepseek.com/a/chat/s/test-chat-003');await other.waitForSelector('html.dsm-enabled');
    await other.getByRole('textbox',{name:'给 DeepSeek 发送消息'}).fill('应当清除的跨标签页草稿');
    await poll(()=>call(popup,'draft.get',{id:'test-chat-003'}),x=>!!x?.text);
    await nativeInput.fill('应当清除的当前页草稿');await poll(()=>call(popup,'draft.get',{id:'test-chat-002'}),x=>!!x?.text);
    await openTool('设置');await page.getByRole('button',{name:'清空本地数据',exact:true}).click();await page.getByRole('button',{name:'确认清空本地数据',exact:true}).click();
    await poll(()=>call(popup,'library'),x=>x.conversations.length===0&&x.bookmarks.length===0);
    await other.goto('about:blank');await page.goto('about:blank');await new Promise(r=>setTimeout(r,800));
    const backup=await call(popup,'backup');assert.equal(backup.drafts.length,0);assert.equal(backup.conversations.length,0);await other.close();
  });
  await test('登录路由不接管、不美化密码框',async()=>{
    const login=await context.newPage();await login.goto('https://chat.deepseek.com/sign_in');await new Promise(r=>setTimeout(r,1000));assert.equal(await login.locator('html.dsm-enabled').count(),0);assert.equal(await login.getByRole('navigation',{name:'DS Margin 工具栏'}).isVisible(),false);await login.close();
  });
  await test('停靠书库、侧栏 hover 和编辑器聚焦同屏，无内容或发送键被覆盖',async()=>{
    await call(popup,'settings.save',{...await call(popup,'settings'),theme:'light',reduceMotion:false});
    await page.goto('https://chat.deepseek.com/a/chat/s/solid-state-battery');
    await page.locator('[data-dsm-project-sidebar]').getByRole('button',{name:'原站历史',exact:true}).click();
    await openTool('书库');
    await page.getByRole('complementary',{name:'书库',exact:true}).waitFor();
    const row=page.getByRole('link',{name:'从中试到量产：验证清单',exact:true});
    await nativeInput.focus();
    await row.hover();
    const metrics=await poll(()=>page.evaluate(()=>{
      const rect = sel => document.querySelector(sel).getBoundingClientRect().toJSON();
      const panel = document.getElementById('ds-margin-root').shadowRoot.querySelector('.panel');
      const rail = panel.parentElement.querySelector('.rail');
      const focus = getComputedStyle(document.querySelector('[data-dsm-composer-box]')).boxShadow;
      const hover = getComputedStyle(document.querySelector('[data-dsm-sidebar-row]:hover')).backgroundColor;
      return { root:rect('#root'), input:rect('[data-dsm-composer-box]'), panel:panel.getBoundingClientRect().toJSON(),
        rail:rail.getBoundingClientRect().toJSON(), focus, hover,
        title: getComputedStyle(document.querySelector('[data-native-chat-title]')).opacity };
    }),r=>Math.abs(r.rail.left-r.panel.right-8)<1&&r.root.right<r.panel.left-15);
    assert.ok(Math.abs(metrics.panel.width - 360) < .5, `面板宽度应为 360px，实际为 ${metrics.panel.width}px`);
    assert.equal(metrics.panel.top,12);
    assert.equal(metrics.panel.bottom,988);
    assert.ok(metrics.input.right<metrics.panel.left);
    assert.doesNotMatch(metrics.focus,/0px 0px 0px 3px/);
    assert.notEqual(metrics.hover,'rgba(0, 0, 0, 0)');
    assert.equal(await nativeInput.evaluate(el=>el===document.activeElement),true);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-native-chat-title]')).opacity==='0');
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:join(output,'ui-review-hover-focus-library.png'),animations:'disabled'});
    await writeFile(join(output,'ui-review-layout.json'),JSON.stringify(metrics,null,2));
  });
  await test('标题、语义高亮、短文本复制和回到底部可用；导出与归档保留直引号',async()=>{
    const css=await page.locator('.ds-assistant-message-main-content').evaluate(el=>({
      h1:getComputedStyle(el.querySelector('h1')).fontSize,h2:getComputedStyle(el.querySelector('h2')).fontSize,
      h3:getComputedStyle(el.querySelector('h3')).fontSize,keyword:getComputedStyle(el.querySelector('.token.keyword')).color,
      text:getComputedStyle(el.querySelector('.language-text')).fontFamily,
      script:getComputedStyle(el.querySelector('.language-typescript')).fontFamily,
    }));
    assert.equal(css.h1,'28px');
    assert.equal(css.h2,'21.6px');
    assert.equal(css.h3,'17.92px');
    assert.equal(css.keyword,'rgb(138, 75, 99)');
    assert.match(css.text,/Noto Serif/);
    assert.match(css.script,/Cascadia Mono/);
    assert.match(await page.locator('.ds-assistant-message-main-content').innerText(),/“量产”/);
    const saved=await poll(()=>call(popup,'library'),lib=>lib.conversations.some(c=>c.id==='solid-state-battery'));
    assert.match(saved.conversations.find(c=>c.id==='solid-state-battery').messages[1].text,/"量产"/);
    const short=page.locator('[data-dsm-short-text]');
    assert.equal(await short.locator('.md-code-block-banner-wrap').isVisible(),false);
    const copy=short.getByRole('button',{name:'复制文本片段',exact:true});
    await copy.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.interfaceFixture.copies),1);
    const button=page.getByRole('button',{name:'回到底部',exact:true});
    await page.locator('[data-dsm-scroll]').evaluate(el=>el.scrollTo(0,0));
    await button.waitFor();
    const pos=await button.evaluate(el=>{
      const r=el.getBoundingClientRect(), composer=document.querySelector('[data-dsm-composer-box]').getBoundingClientRect();
      return {mid:r.left+r.width/2,composerMid:composer.left+composer.width/2, top:r.top,
        scrollBottom:document.querySelector('[data-dsm-scroll]').getBoundingClientRect().bottom,
        gap:composer.top-r.bottom};
    });
    assert.ok(Math.abs(pos.mid-pos.composerMid)<1);
    assert.ok(pos.top>=pos.scrollBottom-1);
    assert.ok(Math.abs(pos.gap-16)<1);
    await button.click();
    await button.waitFor({state:'hidden'});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-native-chat-title]')).opacity==='1');
  });
  await test('原站开关状态可更新，书库窄屏弹层有遮罩且固定输入框随宽屏让位',async()=>{
    const panel=page.getByRole('complementary',{name:'书库',exact:true});
    const search=page.locator('[data-native-mode="search"]'),think=page.locator('[data-native-mode="think"]');
    assert.equal(await search.getAttribute('data-dsm-mode-state'),'on');
    assert.equal(await think.getAttribute('data-dsm-mode-state'),'off');
    await search.click();
    await poll(()=>search.getAttribute('data-dsm-mode-state'),x=>x==='off');
    await page.goto('https://chat.deepseek.com/a/chat/s/solid-state-battery?fixed=1');
    await page.setViewportSize({width:1280,height:900});
    await openTool('书库');
    await page.locator('[data-dsm-fixed-composer]').waitFor();
    const docked=await poll(async()=>{
      const [native, side]=await Promise.all([page.locator('[data-dsm-fixed-composer]').boundingBox(),panel.boundingBox()]);
      return native&&side?{right:native.x+native.width,side:side.x}:null;
    },x=>x&&x.right<=x.side-15);
    assert.ok(docked.right<docked.side);
    await page.setViewportSize({width:1100,height:900});
    await page.getByRole('dialog',{name:'书库',exact:true}).waitFor();
    assert.equal(await page.locator('.scrim').isVisible(),true);
    assert.equal(await toolbar.isVisible(),false);
    await page.setViewportSize({width:390,height:760});
    await page.screenshot({path:join(output,'ui-review-library-narrow.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await page.getByRole('dialog',{name:'书库',exact:true}).waitFor({state:'detached'});
    await page.setViewportSize({width:1440,height:1000});
  });
  await test('书库下拉使用自绘菜单，Esc 只关闭下拉，点击原网页空白收回侧栏', async () => {
    await page.goto('https://chat.deepseek.com/a/chat/s/solid-state-battery');
    await page.waitForSelector('html.dsm-enabled');
    await openTool('书库');
    const panel = page.getByRole('complementary',{name:'书库',exact:true});
    const folder = page.getByRole('combobox',{name:'项目',exact:true});
    await folder.press('Enter');
    const list = page.getByRole('listbox',{name:'项目',exact:true});
    const selected = list.getByRole('option',{name:'全部项目',exact:true});
    await selected.waitFor();
    assert.equal(await selected.getAttribute('aria-selected'),'true');
    assert.equal(await folder.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
    assert.equal(await list.evaluate(el=>el.matches(':popover-open')),true);
    await page.screenshot({path:join(output,'ui-library-dropdown.png'),animations:'disabled'});
    await folder.press('Escape');
    await list.waitFor({state:'detached'});
    assert.equal(await panel.isVisible(),true);
    await folder.press('Enter');
    await list.waitFor();
    await panel.getByRole('button',{name:'关闭面板',exact:true}).focus();
    await list.waitFor({state:'detached'});
    await nativeInput.click();
    assert.equal(await panel.isVisible(),true);
    const heading=page.locator('.ds-assistant-message-main-content h1');
    const headingBounds=await heading.boundingBox();
    await heading.click({position:{x:12,y:headingBounds.height/2}});
    assert.equal(await panel.isVisible(),true);
    await heading.click({position:{x:headingBounds.width-12,y:headingBounds.height/2}});
    await panel.waitFor({state:'detached'});
    assert.equal(await page.locator('html[data-m-panel]').count(),0);
    const popupTheme = popup.getByRole('combobox',{name:'阅读主题',exact:true});
    await popupTheme.click();
    await popup.getByRole('listbox',{name:'阅读主题',exact:true}).waitFor();
    await popupTheme.press('Escape');
    assert.equal(await popup.locator('select').count(),0);
    assert.equal(await page.locator('select').count(),0);
  });
  await test('空白处收起提示词面板，重开后保留未保存的表单', async () => {
    await openTool('提示词');
    const panel=page.getByRole('complementary',{name:'提示词',exact:true});
    await panel.getByRole('button',{name:'新建模板',exact:true}).click();
    const name=panel.getByLabel('模板名称',{exact:true}), body=panel.getByLabel('模板内容',{exact:true});
    await name.fill('未保存的模板');
    await body.fill('请分析 {{概念}} 的背景。');
    await page.locator('[data-dsm-header]').click({position:{x:10,y:10}});
    await panel.waitFor({state:'detached'});
    await openTool('提示词');
    assert.equal(await name.inputValue(),'未保存的模板');
    assert.equal(await body.inputValue(),'请分析 {{概念}} 的背景。');
    await panel.getByRole('button',{name:'关闭面板',exact:true}).click();
  });
  await test('输入 / 后从原生输入框键盘选择提示词，只替换斜杠命令并保留前后草稿', async () => {
    await page.goto(url);
    await page.waitForSelector('html.dsm-enabled');
    const prefix = '保留前文\n', suffix = '\n保留后文';
    await nativeInput.fill(prefix+suffix);
    await nativeInput.evaluate((el,caret)=>el.setSelectionRange(caret,caret),prefix.length);
    await page.keyboard.insertText('/');
    const menu = page.getByRole('listbox',{name:'可用提示词',exact:true});
    await menu.waitFor();
    await page.keyboard.insertText('概念');
    const option = menu.getByRole('option',{name:/解释一个概念/});
    await option.waitFor();
    assert.equal(await menu.getByRole('option').count(),1);
    await nativeInput.press('Enter');
    const form = page.getByRole('dialog',{name:'解释一个概念',exact:true});
    const concept = form.getByLabel('概念',{exact:true});
    await concept.waitFor();
    assert.equal(await concept.evaluate(el=>el.getRootNode().activeElement===el),true);
    assert.equal(await nativeInput.inputValue(),prefix+'/概念'+suffix);
    assert.equal(await page.evaluate(()=>window.fixture.sent),0);
    await concept.press('Escape');
    await form.waitFor({state:'detached'});
    assert.equal(await nativeInput.inputValue(),prefix+'/概念'+suffix);
    await page.keyboard.insertText(' ');
    await menu.getByRole('option',{name:/解释一个概念/}).click();
    await concept.fill('分布偏移');
    await form.getByRole('button',{name:'填入输入框',exact:true}).click();
    assert.match(await nativeInput.inputValue(),/^保留前文\n请用中文解释「分布偏移」。[^\n]+\n保留后文$/);
    assert.equal(await nativeInput.evaluate(el=>document.activeElement===el),true);
    assert.equal(await page.evaluate(()=>window.fixture.sent),0);
    await nativeInput.press('Control+z');
    assert.equal(await nativeInput.inputValue(),prefix+'/概念 '+suffix);
  });
  await test('直接填入无变量提示词，取消时保留输入，普通路径与中文组词期间不误触发', async () => {
    await call(popup,'prompt.save',{id:'quick-check',title:'简要核对',body:'请列出三个需要查证的前提。'});
    await page.reload();
    await page.waitForSelector('html.dsm-enabled');
    const menu = page.getByRole('listbox',{name:'可用提示词',exact:true});
    await nativeInput.fill('/api/v1');
    assert.equal(await menu.count(),0);
    await nativeInput.evaluate(el=>{
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      el.value='／概';
      el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
    });
    assert.equal(await menu.count(),0);
    await nativeInput.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
    await nativeInput.fill('／简要');
    await menu.getByRole('option',{name:'简要核对',exact:true}).waitFor();
    await nativeInput.press('Escape');
    assert.equal(await nativeInput.inputValue(),'／简要');
    await nativeInput.fill('/简要核对');
    await nativeInput.press('Enter');
    assert.equal(await nativeInput.inputValue(),'请列出三个需要查证的前提。');
    assert.equal(await page.evaluate(()=>window.fixture.sent),0);
    await nativeInput.fill('/tmp');
    await menu.getByText('没有匹配的提示词',{exact:true}).waitFor();
    await nativeInput.press('Enter');
    assert.equal(await page.evaluate(()=>window.fixture.sent),1);
  });
  await test('提示词表单绑定原对话，切换地址后不把内容填进新对话', async () => {
    await page.goto(url);
    await page.waitForSelector('html.dsm-enabled');
    await nativeInput.fill('/');
    await page.getByRole('listbox',{name:'可用提示词',exact:true}).waitFor();
    await nativeInput.evaluate(el=>{
      history.pushState({},'','/a/chat/s/other-after-picker');
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    });
    assert.equal(await nativeInput.inputValue(),'/');
    assert.equal(await page.evaluate(()=>window.fixture.sent),0);
    await page.goto(url);
    await page.waitForSelector('html.dsm-enabled');
    await nativeInput.fill('/概念');
    const menu = page.getByRole('listbox',{name:'可用提示词',exact:true});
    await menu.getByRole('option',{name:/解释一个概念/}).click();
    const form = page.getByRole('dialog',{name:'解释一个概念',exact:true});
    await form.getByLabel('概念',{exact:true}).fill('需要保留在原对话的词');
    await page.evaluate(()=>{
      history.pushState({},'','/a/chat/s/other-after-prompt');
      document.getElementById('ds-margin-root').shadowRoot.querySelector('.composer-popup button[type="submit"]').click();
    });
    assert.equal(await nativeInput.inputValue(),'/概念');
    assert.equal(await page.evaluate(()=>window.fixture.sent),0);
    await form.waitFor({state:'detached'});
  });
  await test('富文本输入框的第二行可选提示词，裸输入框有浅色焦点', async () => {
    await page.goto(url);
    await page.waitForSelector('html.dsm-enabled');
    await page.evaluate(()=>{
      const editable=document.createElement('div');
      editable.contentEditable='true';
      editable.setAttribute('role','textbox');
      editable.setAttribute('aria-label','给 DeepSeek 发送消息');
      editable.innerHTML='保留首行<div><br></div>';
      editable.style.cssText='min-height:65px;padding:8px;border:1px solid #ddd';
      document.querySelector('[data-dsm-composer-box]').replaceWith(editable);
    });
    const editor=page.locator('[data-dsm-composer][contenteditable="true"]');
    await editor.focus();
    assert.equal(await editor.evaluate(el=>getComputedStyle(el).outlineWidth),'1px');
    await editor.evaluate(el=>{
      const range=document.createRange();
      range.setStart(el.lastElementChild,0);
      range.collapse(true);
      const selection=document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.insertText('/概念');
    await page.getByRole('option',{name:/解释一个概念/}).click();
    const form=page.getByRole('dialog',{name:'解释一个概念',exact:true});
    await form.getByLabel('概念',{exact:true}).fill('迭代');
    await form.getByRole('button',{name:'填入输入框',exact:true}).click();
    assert.match(await editor.innerText(),/^保留首行\n请用中文解释「迭代」/);
  });
  await test('输入栏菜单和概念表单在浅色、窄屏均在可视范围内', async () => {
    await page.goto('https://chat.deepseek.com/a/chat/s/solid-state-battery');
    await nativeInput.fill('/');
    const menu = page.getByRole('listbox',{name:'可用提示词',exact:true});
    await menu.waitFor();
    await page.screenshot({path:join(output,'ui-composer-skills.png'),animations:'disabled'});
    await menu.getByRole('option',{name:/解释一个概念/}).click();
    const form = page.getByRole('dialog',{name:'解释一个概念',exact:true});
    const concept = form.getByLabel('概念',{exact:true});
    await concept.fill('电化学稳定窗口');
    await page.screenshot({path:join(output,'ui-composer-skill-fields.png'),animations:'disabled'});
    for(const width of [390,375]){
      await page.setViewportSize({width,height:760});
      await poll(async()=>{
        const [floating, editor] = await Promise.all([form.boundingBox(),nativeInput.boundingBox()]);
        return floating && editor && floating.x>=0 && floating.x+floating.width<=width &&
          floating.y>=0 && floating.y+floating.height<editor.y;
      },Boolean);
    }
    await form.getByRole('button',{name:'填入输入框',exact:true}).click();
    assert.match(await nativeInput.inputValue(),/电化学稳定窗口/);
    await page.setViewportSize({width:1440,height:1000});
  });
  await test('扩展运行过程无页面脚本异常',async()=>assert.deepEqual(errors,[]));
}catch(error){
  process.exitCode=1;if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
}finally{
  await writeFile(join(output,'browser-results.json'),JSON.stringify({environment:'Chromium + real MV3 extension + controlled DeepSeek DOM fixture; no real messages sent',time:new Date().toISOString(),passed:results.filter(r=>r.passed).length,total:results.length,results,errors},null,2));
  await closeContext(context);
}
