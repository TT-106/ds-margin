import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, closeContext, extensionPopup, call, poll, root, output } from './browser-utils.mjs';

const origin = 'https://chat.deepseek.com';
const parentId = 'ordinary-notes';
const parentUrl = `${origin}/a/chat/s/${parentId}`;
const quote = '玻璃会折射光';
const body = `我们观察到${quote}，这是旁问的来源。`;
const unrelated = '主线中无关的私有内容';
const streamRecoveryId = 'native-side-9';
const completionPath = '/api/v0/chat/completion';
const historyPath = '/api/v0/chat/history_messages';
const streamFixturePath = '/__fixture__/completion-worker.js';
const firstDelta = '原站流的第一段正文';
const secondDelta = '与第二段增量';
const hiddenThought = '这段思考不能出现在浮层';
const streamAnswer = firstDelta + secondDelta;
const followUpDelta = '追问原站流的第一段正文';
const followUpMore = '与追问第二段**增量**';
const followUpAnswer = followUpDelta + followUpMore;
const streamFixture = `
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  const frame = (event, data) => (event ? 'event: ' + event + '\\n' : '') + 'data: ' + JSON.stringify(data) + '\\n\\n';
  self.addEventListener('fetch', event => {
    if (new URL(event.request.url).pathname !== '${completionPath}' || event.request.method !== 'POST') return;
    event.respondWith((async () => {
      const input = await event.request.json();
      if (input.chat_session_id !== '${streamRecoveryId}') return new Response(null, { status: 400 });
      const followUp = input.parent_message_id === 2;
      const userId = followUp ? 3 : 1;
      const assistantId = followUp ? 4 : 2;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          const push = (event, data) => controller.enqueue(encoder.encode(frame(event, data)));
          push('ready', { request_message_id: userId, response_message_id: assistantId });
          push(null, { v: { response: { message_id: assistantId, parent_id: userId, fragments: [
            { type: 'THINK', content: '${hiddenThought}' },
            { type: 'RESPONSE', content: followUp ? '${followUpDelta}' : '${firstDelta}' },
          ] } } });
          setTimeout(() => push(null, { p: 'response/fragments/-1/content', o: 'APPEND', v: followUp ? '${followUpMore}' : '${secondDelta}' }), 1100);
          setTimeout(() => { push('finish', {}); controller.close(); }, 4400);
        },
      }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    })());
  });`;
const fixture = (await readFile(join(root, 'tests', 'side-question-fixture.html'), 'utf8'))
  .replace('const mode = { think: false, search: false };', 'const mode = { think: true, search: true };')
  .replace(/(data-native-mode="(?:think|search)" aria-pressed=")false/g, '$1true')
  .replace('let revision = 0;', 'let revision = 0; const openedAtRoot = location.pathname === "/";')
  .replace('function addMessage(key, role, text, thinking) {', `const hidesHistory = !openedAtRoot && id() === '${streamRecoveryId}';
    let historyLoaded = !hidesHistory;
    function addMessage(key, role, text, thinking) {`)
  .replace('send.disabled = running || !input.value.trim();', 'send.disabled = running || !historyLoaded || !input.value.trim();')
  .replace('function render(state) {', `let questionRevealed = false;
    const scroll = messages.closest('main');
    scroll.addEventListener('scroll', () => {
      if (id() === '${streamRecoveryId}' || questionRevealed || !messages.querySelector('[data-virtual-gap]') || scroll.scrollTop > 1800) return;
      questionRevealed = true;
      render(JSON.parse(last), true);
    });
    function render(state, force = false) {`)
  .replace('if (JSON.stringify(state) === last) return;', 'if (!force && JSON.stringify(state) === last) return;')
  .replace("encodeURIComponent(id()));", "encodeURIComponent(id()) + '&revealed=' + questionRevealed);")
  .replace('body.textContent = text;', `body.textContent = text;
      if (role === 'assistant' && text === '受控旁问回答 8') {
        body.insertAdjacentHTML('beforeend', '<p>行内 <span class="katex"><annotation encoding="application/x-tex">g_{00}</annotation></span></p>' +
          '<span class="katex-display"><span class="katex"><annotation encoding="application/x-tex">\\\\frac{1}{2}</annotation></span></span>' +
          '<ol><li><strong>并列结构决定含义</strong>：第一点</li><li>第二点</li></ol>');
      }`)
  .replace("if (state.prompt) addMessage('1', 'user', state.prompt, false);\n      if (state.answer || state.running) addMessage('2', 'assistant', state.answer, state.think);", `state.turns.forEach((turn, index) => {
        if (hidesHistory) return;
        const temp = openedAtRoot && id() !== '${parentId}';
        const virtualized = id() === '${streamRecoveryId}' || (temp && id() === 'native-side-1' && !questionRevealed);
        if (virtualized) {
          const gap = document.createElement('div');
          gap.dataset.virtualGap = '';
          gap.style.height = '1900px';
          messages.append(gap);
        } else {
          addMessage(String(temp ? -2 - index * 2 : index * 2 + 1), 'user', turn.prompt, false);
        }
        addMessage(String(temp ? -3 - index * 2 : index * 2 + 2), 'assistant', turn.answer, false);
        if (virtualized) {
          messages.lastElementChild.style.minHeight = '1700px';
          scroll.scrollTop = scroll.scrollHeight;
        }
      });`)
  .replace('JSON.stringify({ prompt, mode })', 'JSON.stringify({ prompt, mode, conversationId: id(), theme: document.documentElement.dataset.dsmTheme, composerFocused: document.activeElement === input })')
  .replace('const result = await response.json();', `const result = await response.json();
      if (result.streamFixture) {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '${completionPath}');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ chat_session_id: result.id, parent_message_id: result.parentMessageId, prompt }));
      }`)
  .replace("input.addEventListener('input', updateButtons);", `input.addEventListener('input', updateButtons);
    if (hidesHistory) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '${historyPath}?chat_session_id=' + encodeURIComponent(id()));
      xhr.responseType = 'json';
      xhr.onload = () => {
        historyLoaded = xhr.status === 200 && xhr.response?.data?.biz_data?.chat_messages?.length > 0;
        updateButtons();
      };
      xhr.send();
    }`);

// A forced Playwright viewport restores newly attached Chromium windows.
const context = await launch({ viewport: null });
const sessions = new Map([[parentId, [{ prompt: unrelated, answer: body, endsAt: 0 }]]]);
const sends = [];
const errors = [];
const results = [];
const streamRecoveryUrl = `${origin}/a/chat/s/${streamRecoveryId}`;
const completionRequests = [];
let completionFinished = 0;
let historyFetches = 0;
const isRunning = turn => Boolean(turn && Date.now() < turn.endsAt);
let responseDelay = 8000;
let deletionAccepted = false;
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
context.on('request', request => {
  if (request.url() === origin + completionPath) completionRequests.push(request.postDataJSON());
});
context.on('requestfinished', request => {
  if (request.url() === origin + completionPath) completionFinished++;
});
await context.route(`${origin}/**`, async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/v0/chat_session/delete')
    return route.fulfill({ json: { code: 0, data: { biz_code: deletionAccepted ? 0 : 1 } } });
  if (url.pathname === streamFixturePath) {
    return route.fulfill({ headers: { 'Service-Worker-Allowed': '/' }, contentType: 'text/javascript', body: streamFixture });
  }
  if (url.pathname === completionPath) return route.abort();
  if (url.pathname === historyPath) {
    const id = url.searchParams.get('chat_session_id');
    const turns = sessions.get(id);
    if (id !== streamRecoveryId || !turns?.length || route.request().method() !== 'GET') return route.abort();
    historyFetches++;
    await new Promise(resolve => setTimeout(resolve, 650));
    return route.fulfill({ json: { code: 0, data: { biz_code: 0, biz_data: {
      chat_messages: [
        { message_id: 1, role: 'USER', content: turns[0].prompt },
        { message_id: 2, parent_id: 1, role: 'ASSISTANT', content: streamAnswer },
      ],
    } } } });
  }
  if (url.pathname === '/__fixture__/send') {
    const input = route.request().postDataJSON();
    const id = input.conversationId || `native-side-${sends.length + 1}`;
    const turns = sessions.get(id) ?? [];
    const turn = { ...input, id, answer: `受控旁问回答 ${sends.length + 1}`, endsAt: Date.now() + responseDelay };
    sends.push(turn);
    turns.push(turn);
    sessions.set(id, turns);
    return route.fulfill({ json: { id, streamFixture: id === streamRecoveryId, parentMessageId: (turns.length - 1) * 2 || null } });
  }
  if (url.pathname === '/__fixture__/state') {
    const id = url.searchParams.get('id');
    const turns = sessions.get(id) ?? [];
    if (id === 'native-side-1' && turns.length && url.searchParams.get('revealed') === 'true')
      turns[0].secondChunkAt ??= Date.now() + 1250;
    const history = [...sessions.keys()].filter(key => key !== parentId).map(key => ({ id: key, title: key }));
    return route.fulfill({ json: {
      turns: turns.map(turn => ({ prompt: turn.prompt, answer: isRunning(turn)
        ? '隔离页生成中的部分文本' + (Date.now() >= turn.secondChunkAt ? '和第二段流式增量' : '') : turn.answer })),
      running: isRunning(turns.at(-1)), history,
    } });
  }
  return route.fulfill({ status: 200, contentType: 'text/html', body: fixture,
    headers: { "content-security-policy": "script-src 'self' 'unsafe-inline'" },
  });
});

try {
  const popup = await extensionPopup(context);
  const settings = await call(popup, 'settings');
  await call(popup, 'settings.save', { ...settings, theme: 'dark' });
  const page = await context.newPage();
  const debuggerSession = await context.newCDPSession(page);
  let mathModuleParses = 0;
  debuggerSession.on('Debugger.scriptParsed', ({ url }) => {
    if (url.endsWith('/side-question-katex.js')) mathModuleParses++;
  });
  await debuggerSession.send('Debugger.enable');
  await page.bringToFront();
  await page.goto(origin);
  await page.waitForSelector('html.dsm-enabled');
  await page.evaluate(url => history.pushState(null, '', url), parentUrl);
  const mainInput = page.locator('textarea.ds-textarea__textarea');
  await mainInput.fill('留在主线的草稿');
  const source = page.locator('[data-dsm-message]').filter({ hasText: body });
  await source.waitFor();
  const background = context.serviceWorkers()[0];
  const mainWindow = await background.evaluate(async () => {
    const w = await chrome.windows.getLastFocused({ populate: true });
    await chrome.windows.update(w.id, { width: 1440, height: 1000, left: 0, top: 0 });
    return { id: w.id, tabs: w.tabs.map(tab => [tab.id, tab.active]) };
  });
  const layout = () => source.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map(rect => [rect.x, rect.y, rect.width, rect.height]);
  });
  const originalLayout = await layout();
  const selectSource = () => source.evaluate((element, selected) => {
    const node = element.firstChild;
    const index = node.textContent.indexOf(selected);
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + selected.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, quote);
  await selectSource();
  await page.getByRole('button', { name: '旁问', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '旁问', exact: true });
  const readMarks = () => page.evaluate(() => [...(CSS.highlights.get('dsm-side-question-references') ?? [])]
    .filter(range => range.startContainer.isConnected && range.endContainer.isConnected).map(range => range.toString()));
  const waitForMark = selected => poll(readMarks, marks => marks.includes(selected));
  const markBox = selected => page.evaluate(selected => {
    const range = [...(CSS.highlights.get('dsm-side-question-references') ?? [])]
      .find(range => range.startContainer.isConnected && range.toString() === selected);
    const box = range?.getBoundingClientRect();
    return box && { x: box.x, y: box.y, width: box.width, height: box.height };
  }, selected);
  const clickMark = async selected => {
    await waitForMark(selected);
    const box = await markBox(selected);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const sideInput = sheet.getByRole('textbox', { name: '旁问输入框', exact: true });
  const send = sheet.getByRole('button', { name: '发送旁问', exact: true });
  const grip = await sheet.getByRole('button', { name: /移动旁问浮层/ }).boundingBox();
  assert.equal(await sideInput.isVisible(), false, '点击旁问应直接开始讲解，首答前不要求输入');
  assert.equal(await sheet.locator('.sq-eyebrow').count(), 0, '旁问顶部不显示主会话标题');
  const position = await sheet.boundingBox();
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  const dx = position.x > 120 ? -90 : 90;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + 48, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs((await sheet.boundingBox()).x - position.x) >= 40, '拖动后浮层应移动');
  assert.deepEqual(await layout(), originalLayout);
  const latest = async () => (await call(popup, 'side.list', { parentId }))[0];
  const awaitTurn = (index, match) => poll(async () => {
    const thread = await latest();
    const turn = thread?.turns[index];
    if (turn?.status === 'failed' && !match(turn)) throw new Error(turn.error);
    if (!thread && await sheet.getByRole('alert').count()) throw new Error(await sheet.getByRole('alert').innerText());
    return thread ?? null;
  }, thread => match(thread?.turns[index]), 20_000);
  const reopen = async () => {
    const row = page.locator(`a[data-dsm-sidebar-row][href$="/${parentId}"]`);
    const before = await row.boundingBox();
    await page.getByRole('button', { name: /公开资料核查笔记 · 旁问 1/ }).click();
    const flyout = page.getByRole('navigation', { name: /的旁问$/ });
    const layer = await flyout.boundingBox();
    assert.ok(layer.x >= before.x + before.width - 1, '旁问列表应浮在主会话行右侧');
    assert.deepEqual(await row.boundingBox(), before);
    const entry = flyout.getByRole('button', { name: new RegExp(quote) });
    if (sends.length === 1) {
      await entry.waitFor();
      await page.screenshot({ path: join(output, 'side-question-flyout.png') });
    }
    await entry.click();
  };

  await sheet.getByText('隔离页生成中的部分文本', { exact: true }).waitFor({ timeout: 7000 });
  await sheet.getByText('隔离页生成中的部分文本和第二段流式增量', { exact: true }).waitFor({ timeout: 7000 });
  const first = await awaitTurn(0, turn => turn?.checkpoint.phase === 'awaiting');
  assert.equal(page.url(), parentUrl);
  assert.equal(await mainInput.inputValue(), '留在主线的草稿');
  assert.equal(sends.length, 1);
  const executionWindow = await background.evaluate(async ({ tabId, mainId }) => {
    const tab = await chrome.tabs.get(tabId);
    const exec = await chrome.windows.get(tab.windowId);
    const main = await chrome.windows.get(mainId, { populate: true });
    return { workerId: exec.id, minimized: exec.state === 'minimized', focused: exec.focused, tabActive: tab.active,
      mainFocused: main.focused, mainTabs: main.tabs.map(item => [item.id, item.active]) };
  }, { tabId: first.turns[0].checkpoint.workerTabId, mainId: mainWindow.id });
  assert.notEqual(executionWindow.workerId, mainWindow.id, '执行页不得在主窗口新增标签');
  assert.equal(executionWindow.minimized, true);
  assert.equal(executionWindow.focused, false);
  assert.equal(executionWindow.tabActive, true, '在独立窗口内 active 的标签仍应允许后台发送');
  assert.equal(executionWindow.mainFocused, true);
  assert.deepEqual(executionWindow.mainTabs, mainWindow.tabs);
  results.push('执行窗口独立、最小化且未聚焦，主窗口标签与焦点保持不变');
  console.log(`PASS ${results.at(-1)}`);
  assert.equal(sends[0].theme, 'dark');
  assert.equal(sends[0].composerFocused, false);
  assert.equal(sends[0].conversationId, '');
  assert.deepEqual(sends[0].mode, { think: false, search: false }, '旁问不得继承网页的深度思考或搜索开关');
  assert.match(sends[0].prompt, new RegExp(quote));
  assert.match(sends[0].prompt, /先给结论/);
  assert.match(sends[0].prompt, /\[DS Margin 旁问编号：[\w:-]+；用于识别本次旁问，请勿复述。\]/);
  assert.ok(!sends[0].prompt.includes(unrelated));
  await sheet.getByText('隔离页生成中的部分文本', { exact: false }).waitFor();
  assert.equal(first.turns[0].checkpoint.userMessageId, '-2');
  assert.ok(isRunning(sends[0]), '最终回答完成前应已看到正在生成的正文');

  const worker = context.pages().find(item => item.url() === first.nativeUrl);
  assert.ok(worker, '应存在最小化窗口里的独立执行页');
  await page.mouse.click(1250, 620);
  await sheet.waitFor({ state: 'hidden' });
  await waitForMark(quote);
  assert.equal(await source.textContent(), body, '旁问点状标记不能进入原站正文');
  assert.equal(await page.locator('[data-dsm-side-reference]').count(), 0, '正文不再显示编号');
  await worker.reload();
  await page.reload();
  const firstDone = await awaitTurn(0, turn => turn?.status === 'complete');
  assert.equal(firstDone.turns[0].answer, '受控旁问回答 1');
  assert.equal(firstDone.turns[0].checkpoint.userMessageId, '1');
  assert.equal(firstDone.turns[0].checkpoint.assistantMessageId, '2');
  assert.equal(firstDone.nativeUrl, first.nativeUrl);
  assert.equal(sends.length, 1);
  await poll(async () => background.evaluate(id => chrome.windows.get(id).then(() => false, () => true), executionWindow.workerId), Boolean);
  await clickMark(quote);
  await sheet.getByText('受控旁问回答 1', { exact: true }).waitFor();
  await poll(() => sideInput.evaluate(element => element.getRootNode().activeElement === element), Boolean);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await source.evaluate(element => document.activeElement === element), true);
  results.push('收起及刷新后原词点状标记保留，点击原词打开旁问，Esc 收起并回到正文');
  console.log(`PASS ${results.at(-1)}`);
  await reopen();
  await sheet.getByText('受控旁问回答 1', { exact: false }).waitFor();
  await sideInput.focus();
  assert.equal(await sideInput.evaluate(el => getComputedStyle(el.parentElement).boxShadow), 'none');
  assert.equal(await sheet.locator('.sq-asked').count(), 0, '自动首问不作为用户气泡显示');
  await page.screenshot({ path: join(output, 'side-question-reply.png') });
  results.push('找回虚拟列表未渲染的提问，生成完成前呈现两个正文增量，刷新后安全换绑');
  console.log(`PASS ${results.at(-1)}`);

  responseDelay = 500;
  await sheet.getByRole('button', { name: '联网搜索', exact: true }).click();
  await sideInput.fill('换个说法。');
  await send.click();
  const secondDone = await awaitTurn(1, turn => turn?.status === 'complete');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].mode, { think: false, search: true }, '联网追问也必须关闭深度思考');
  assert.equal(sends[1].conversationId, new URL(firstDone.nativeUrl).pathname.split('/').at(-1));
  assert.ok(!sends[1].prompt.includes(quote));
  assert.equal(secondDone.nativeUrl, firstDone.nativeUrl);
  assert.deepEqual(secondDone.turns.map(turn => turn.answer), ['受控旁问回答 1', '受控旁问回答 2']);
  results.push('按需联网追问且深度思考关闭，沿用同一个 DeepSeek 原生会话');
  console.log(`PASS ${results.at(-1)}`);

  responseDelay = 5500;
  await sheet.getByText('受控旁问回答 2', { exact: false }).waitFor();
  await sideInput.fill('关闭标签页前的旁问。');
  await send.click();
  const third = await awaitTurn(2, turn => turn?.checkpoint.phase === 'awaiting');
  const interrupted = context.pages().find(item => item.url() === third.nativeUrl);
  assert.ok(interrupted);
  await interrupted.close();
  await awaitTurn(2, turn => turn?.status === 'attention');
  await page.reload();
  await reopen();
  await sheet.getByRole('alert').waitFor();
  assert.equal(await send.isDisabled(), true);
  const draftWhileRecovering = '已输入的后续问题';
  await sideInput.fill(draftWhileRecovering);
  assert.equal(sends.length, 3);
  // The original conversation may predate the new side-question marker.
  const oldNativeId = new URL(third.nativeUrl).pathname.split('/').at(-1);
  const nativeTurns = sessions.get(oldNativeId);
  const oldTurn = nativeTurns.at(-1);
  sessions.set(oldNativeId, [...nativeTurns.slice(0, -1), {
    ...oldTurn, prompt: oldTurn.prompt.replace('DS Margin 旁问编号', 'DS Margin 任务编号'),
  }]);
  const recovery = await context.newPage();
  await recovery.goto(third.nativeUrl);
  const recovered = await awaitTurn(2, turn => turn?.status === 'complete');
  assert.equal(recovered.turns[2].answer, '受控旁问回答 3');
  assert.equal(sends.length, 3);
  assert.equal(await sideInput.inputValue(), draftWhileRecovering);
  await poll(() => send.isEnabled(), Boolean);
  results.push('关闭执行页保留需核对状态，打开带旧编号的原生会话可找回回复，无重复发送');
  console.log(`PASS ${results.at(-1)}`);

  await recovery.close();
  await page.bringToFront();
  await sheet.getByRole('button', { name: '收起旁问', exact: true }).click();
  responseDelay = 500;
  await selectSource();
  await page.getByRole('button', { name: '联网旁问', exact: true }).click();
  await sheet.getByText('受控旁问回答 4', { exact: false }).waitFor();
  assert.equal(sends.length, 4);
  assert.deepEqual(sends[3].mode, { think: false, search: true });
  assert.equal(sends[3].conversationId, '');
  results.push('联网旁问首答只启用搜索，独立于上一条旁问');
  console.log(`PASS ${results.at(-1)}`);

  const closeSheet = () => sheet.getByRole('button', { name: '收起旁问', exact: true }).click();
  await closeSheet();
  await poll(readMarks, marks => marks.filter(mark => mark === quote).length === 2);
  const beforeRemount = await markBox(quote);
  await source.evaluate(element => {
    const replacement = element.cloneNode(true);
    replacement.style.transform = 'translateX(24px)';
    element.replaceWith(replacement);
  });
  await poll(() => markBox(quote), box => box && Math.abs(box.x - beforeRemount.x - 24) < 1);
  await source.evaluate(element => {
    const button = document.createElement('button');
    button.dataset.dsmOwned = '';
    button.textContent = '复制';
    element.append(button);
    button.textContent = '已复制';
    element.style.transform = 'translateX(36px)';
  });
  await poll(() => markBox(quote), box => box && Math.abs(box.x - beforeRemount.x - 36) < 1);
  await source.locator('[data-dsm-owned]').evaluate(button => button.remove());
  await source.evaluate(element => { element.style.transform = 'translate(36px, 2000px)'; });
  await poll(() => markBox(quote), box => box?.y > 1500);
  await source.evaluate(element => {
    element.firstChild.replaceWith(document.createTextNode(element.firstChild.textContent));
    element.style.transform = 'translateX(36px)';
  });
  await waitForMark(quote);
  await page.getByRole('button', { name: /公开资料核查笔记 · 旁问 2/ }).click();
  await page.locator('[data-dsm-side-list] [data-dsm-side-thread]').nth(1).click();
  await sheet.getByText('受控旁问回答 1', { exact: true }).waitFor();
  await closeSheet();
  await clickMark(quote);
  await sheet.getByText('受控旁问回答 4', { exact: true }).waitFor();
  await closeSheet();
  results.push('原词打开最新旁问，侧栏可打开旧记录，正文重挂载、平移和扩展控件更新后点状标记仍准确');
  console.log(`PASS ${results.at(-1)}`);
  const windowsBefore = await background.evaluate(async () => (await chrome.windows.getAll()).map(win => win.id));
  // Simulate Chrome restoring the window just before native send.
  await background.evaluate(async () => {
    globalThis.originalWindowGet = chrome.windows.get;
    chrome.windows.get = async (id, options) => {
      const win = await globalThis.originalWindowGet(id, options);
      return options?.populate ? win : { ...win, state: 'normal' };
    };
  });
  try {
    await selectSource();
    await page.getByRole('button', { name: '旁问', exact: true }).click();
    await sheet.getByRole('alert').filter({ hasText: '此次尚未提交' }).waitFor();
    assert.equal(sends.length, 4);
  } finally {
    await background.evaluate(() => {
      chrome.windows.get = globalThis.originalWindowGet;
      delete globalThis.originalWindowGet;
    });
  }
  const retained = await background.evaluate(async ids => (await chrome.windows.getAll())
    .filter(win => !ids.includes(win.id)).map(win => win.id), windowsBefore);
  for (const id of retained) await background.evaluate(id => chrome.windows.remove(id), id);
  await sheet.getByRole('button', { name: '重试', exact: true }).click();
  await sheet.getByText('受控旁问回答 5', { exact: false }).waitFor();
  assert.equal(sends.length, 5);
  assert.deepEqual(sends[4].mode, { think: false, search: false });
  const afterRetry = await background.evaluate(async id => {
    const win = await chrome.windows.get(id, { populate: true });
    return { focused: win.focused, tabs: win.tabs.map(tab => [tab.id, tab.active]) };
  }, mainWindow.id);
  assert.deepEqual(afterRetry, { focused: true, tabs: mainWindow.tabs });
  results.push('发送前发现执行窗口恢复时安全停止，重试只发送一次且保留主窗口焦点');
  console.log(`PASS ${results.at(-1)}`);

  const selectExcerpt = (locator, excerpt) => locator.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error('测试页找不到指定选区');
  }, excerpt);
  const askExcerpt = async (locator, excerpt) => {
    await selectExcerpt(locator, excerpt);
    await page.getByRole('button', { name: '旁问', exact: true }).click();
  };
  const secondQuote = '这是旁问的来源';
  await askExcerpt(source, secondQuote);
  const next = await poll(async () => (await call(popup, 'side.list', { parentId }))
    .find(thread => thread.anchor.quote === secondQuote), thread => thread?.turns[0]?.answer === '受控旁问回答 6', 20_000);
  assert.equal(next.anchor.quote, secondQuote);
  assert.equal(sends.length, 6);
  assert.equal(sends[5].conversationId, '');
  assert.ok(sends[5].prompt.includes(secondQuote));
  assert.notEqual(next.nativeUrl, firstDone.nativeUrl);

  const nextDraft = '请再给一个例子。';
  await sideInput.fill(nextDraft);
  await send.click();
  const nextFollowUp = await awaitTurn(1, turn => turn?.answer === '受控旁问回答 7');
  assert.equal(sends.length, 7);
  assert.equal(nextFollowUp.turns[1].question, nextDraft);
  assert.equal(nextFollowUp.nativeUrl, next.nativeUrl);
  results.push('无需先收起浮层即可换词另问，首答后可直接提交追问');
  console.log(`PASS ${results.at(-1)}`);

  await page.goto(next.nativeUrl);
  const nativeId = new URL(next.nativeUrl).pathname.split('/').at(-1);
  const nativeAnswer = page.locator('[data-dsm-message=assistant]').filter({ hasText: '受控旁问回答 7' });
  const nestedQuote = '旁问回答 7';
  assert.equal(mathModuleParses, 0, '首屏和纯文本旁问均不加载 KaTeX');
  await askExcerpt(nativeAnswer, nestedQuote);
  const nested = await poll(async () => (await call(popup, 'side.list', { parentId: nativeId }))[0],
    thread => thread?.turns[0]?.status === 'complete', 20_000);
  assert.equal(nested.anchor.quote, nestedQuote);
  assert.equal(nested.parentUrl, next.nativeUrl);
  assert.equal(sends.length, 8);
  assert.equal(sends[7].conversationId, '');
  assert.equal(page.url(), next.nativeUrl);
  results.push('在手动打开的原生旁问页再次划词，归档在当前页');
  console.log(`PASS ${results.at(-1)}`);
  assert.match(nested.turns[0].answer, /^受控旁问回答 8/);
  assert.ok(nested.turns[0].answer.includes(String.raw`\(g_{00}\)`));
  assert.ok(nested.turns[0].answer.includes(String.raw`\[\frac{1}{2}\]`));
  const inlineMath = sheet.locator('math').filter({ has: page.locator('msub') });
  const displayMath = sheet.locator('math[display="block"]').filter({ has: page.locator('mfrac') });
  await inlineMath.waitFor();
  await displayMath.waitFor();
  assert.equal(mathModuleParses, 1, '首个完整公式只加载一次 KaTeX');
  await debuggerSession.detach();
  assert.equal(await displayMath.evaluate(node => node.namespaceURI), 'http://www.w3.org/1998/Math/MathML');
  await sheet.locator('ol > li strong').filter({ hasText: '并列结构决定含义' }).waitFor();
  assert.equal(await sheet.locator('ol > li').count(), 2);
  assert.match(nested.turns[0].answer, /1\. \*\*并列结构决定含义\*\*/);
  await sheet.screenshot({ path: join(output, 'side-question-math.png') });
  results.push('纯文本旁问不加载 KaTeX，首次遇到公式只加载一次并保留原生 Markdown 列表');
  console.log(`PASS ${results.at(-1)}`);

  await closeSheet();
  await nativeAnswer.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await waitForMark(nestedQuote);
  assert.deepEqual(await readMarks(), [nestedQuote], '切换会话后只能标记当前会话的旁问原词');

  await page.goto(parentUrl);
  await source.waitFor();
  await page.evaluate(async path => {
    const controlled = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await navigator.serviceWorker.register(path, { scope: '/' });
    if (!navigator.serviceWorker.controller) await controlled;
  }, streamFixturePath);
  responseDelay = 3500;
  const recoveryQuote = '我们观察到';
  await askExcerpt(source, recoveryQuote);
  await sheet.getByText(firstDelta, { exact: true }).waitFor({ timeout: 9_000 });
  assert.equal(completionFinished, 0, '首段须在原站 SSE 响应结束前出现');
  await sheet.getByText(streamAnswer, { exact: true }).waitFor({ timeout: 9_000 });
  assert.equal(completionFinished, 0, '增量须在原站 SSE 响应结束前出现');
  assert.equal(await sheet.getByText(hiddenThought, { exact: false }).count(), 0);
  const streamedThread = await poll(async () => (await call(popup, 'side.list', { parentId }))
    .find(thread => thread.anchor.quote === recoveryQuote), thread => thread?.turns[0]?.status === 'complete', 12_000);
  assert.equal(streamedThread.nativeUrl, streamRecoveryUrl);
  assert.equal(streamedThread.turns[0].answer, streamAnswer);
  assert.equal(completionRequests.length, 1, '只发出一次原站 completion 请求');
  assert.equal(completionRequests[0].chat_session_id, streamRecoveryId);
  assert.equal(completionRequests[0].prompt, sends[8].prompt);
  assert.equal(sends.length, 9, '夹具发送处理器只触发一次');
  const afterRecovery = await background.evaluate(async id => {
    const win = await chrome.windows.get(id, { populate: true });
    return { focused: win.focused, tabs: win.tabs.map(tab => [tab.id, tab.active]) };
  }, mainWindow.id);
  assert.deepEqual(afterRecovery, { focused: true, tabs: mainWindow.tabs });
  results.push('原站提问持续未渲染时，跟随同源 SSE 首段及增量，正确归档，无重发或抢焦点');
  console.log(`PASS ${results.at(-1)}`);

  await poll(() => completionFinished, count => count === 1);
  const streamFollowUp = '再解释原句中的词义。';
  await sideInput.fill(streamFollowUp);
  await send.click();
  await sheet.getByText(followUpDelta, { exact: true }).waitFor({ timeout: 9_000 });
  assert.equal(completionFinished, 1, '追问首段须在原站 SSE 响应结束前出现');
  await sheet.getByText(followUpAnswer.replaceAll('**', ''), { exact: true }).waitFor({ timeout: 9_000 });
  await sheet.locator('strong').filter({ hasText: '增量' }).waitFor();
  assert.equal(completionFinished, 1, '追问增量须在原站 SSE 响应结束前出现');
  const streamedFollowUp = await poll(() => call(popup, 'side.get', { id: streamedThread.id }),
    thread => thread?.turns[1]?.status === 'complete', 12_000);
  assert.equal(streamedFollowUp.nativeUrl, streamRecoveryUrl);
  assert.deepEqual(streamedFollowUp.turns.map(turn => turn.answer), [streamAnswer, followUpAnswer]);
  assert.equal(streamedFollowUp.turns[1].question, streamFollowUp);
  assert.equal(streamedFollowUp.turns[1].checkpoint.userMessageId, '3');
  assert.equal(streamedFollowUp.turns[1].checkpoint.assistantMessageId, '4');
  assert.equal(historyFetches, 1, '后台页应在历史加载后发送');
  assert.equal(sends.length, 10, '追问只触发一次原站发送');
  assert.equal(completionRequests.length, 2, '追问只产生一次原站 completion');
  assert.equal(completionRequests[1].chat_session_id, streamRecoveryId);
  assert.equal(completionRequests[1].parent_message_id, 2);
  assert.equal(completionRequests[1].prompt, sends[9].prompt);
  assert.equal(sends[9].conversationId, streamRecoveryId);
  results.push('历史已加载但从不渲染时，同一浮层沿用原会话追问，逐段渲染 Markdown 且仅发送一次');
  console.log(`PASS ${results.at(-1)}`);

  const deleteNative = (transport) => page.evaluate(async ({ id, transport }) => {
    const endpoint = '/api/v0/chat_session/delete';
    const body = JSON.stringify({ chat_session_ids: [id] });
    if (transport === 'fetch') return fetch(endpoint, { method: 'POST', body }).then(response => response.json());
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.responseType = 'json';
      xhr.onload = () => resolve(xhr.response);
      xhr.onerror = reject;
      xhr.send(body);
    });
  }, { id: parentId, transport });
  const beforeDelete = await call(popup, 'side.list', { parentId });
  assert.ok(beforeDelete.length > 1);
  assert.equal((await deleteNative('fetch')).data.biz_code, 1);
  assert.deepEqual((await call(popup, 'side.list', { parentId })).map(thread => thread.id), beforeDelete.map(thread => thread.id));
  deletionAccepted = true;
  assert.equal((await deleteNative('xhr')).data.biz_code, 0);
  await poll(() => call(popup, 'side.list', { parentId }), rows => rows.length === 0);
  assert.equal((await call(popup, 'side.list', { parentId: nativeId })).length, 0);
  assert.equal((await call(popup, 'side.summary')).nativeConversationIds.includes(nativeId), true);
  await sheet.waitFor({ state: 'hidden' });
  await poll(readMarks, marks => marks.length === 0);
  assert.equal(sends.length, 10);
  results.push('原站拒绝删除时保留旁问，确认成功后清理子树、关闭浮层且不重新发送');
  console.log(`PASS ${results.at(-1)}`);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'side-question-results.json'), JSON.stringify({ environment: '隔离网页夹具', passed: true, results, totalSends: sends.length, errors }, null, 2));
} finally {
  await closeContext(context);
}
