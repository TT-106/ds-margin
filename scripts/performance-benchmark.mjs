import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [extensionArg, runsArg = '12', delayArg = '0'] = process.argv.slice(2);
const runs = Number(runsArg), parserDelayMs = Number(delayArg);
assert(extensionArg && Number.isInteger(runs) && runs > 0 && runs <= 40 &&
  Number.isInteger(parserDelayMs) && parserDelayMs >= 0 && parserDelayMs < 2000,
  '用法：node scripts/performance-benchmark.mjs <扩展目录> [轮数 1–40] [解析暂停毫秒 0–1999]');
const extension = resolve(extensionArg);
const { version } = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
const origin = 'https://chat.deepseek.com';
const parentPrefix = 'perf-parent-';
const quote = '这段文字用于测量旁问界面';
const segments = ['旁问基准：首问的首段。', '旁问基准：追问的首段。'];
const ending = '夹具随后返回最后一段。';
const answerTailDelayMs = 1000;
const fixture = await readFile(new URL('../tests/side-question-fixture.html', import.meta.url), 'utf8');
function replaceFixture(body, marker, replacement) {
  assert(body.includes(marker), `夹具标记不存在：${marker}`);
  return body.replace(marker, replacement);
}
const rawFixture = [
  ["const input = document.querySelector('textarea');", `
    const input = document.querySelector('textarea');
    const fixtureTime = () => performance.timeOrigin + performance.now();
    const fixturePageId = crypto.randomUUID();
    const seenSegments = new Set();
    const reportTiming = fields => fetch('/__fixture__/timing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: fixturePageId, ...fields }),
    });
    if (window.__dsmBenchmark) window.__dsmBenchmark.nativeInputInDomMs = performance.now();
    else document.addEventListener('DOMContentLoaded', () => void reportTiming({ domReadyAt: fixtureTime() }), { once: true });`],
  ["if (state.prompt) addMessage('1', 'user', state.prompt, false);", `
      state.turns?.forEach((turn, index) => {
        addMessage(String(index * 2 + 1), 'user', turn.prompt, false);
        if (!turn.answer) return;
        addMessage(String(index * 2 + 2), 'assistant', turn.answer, false);
        if (turn.key !== undefined && !seenSegments.has(turn.key)) {
          seenSegments.add(turn.key);
          void reportTiming({ key: turn.key, segmentAt: fixtureTime(), publishedText: turn.answer });
        }
      });
      if (state.prompt) addMessage('1', 'user', state.prompt, false);`],
  ["      revision++;\n      const prompt = input.value;", `
      const submitAt = fixtureTime();
      revision++;
      const prompt = input.value;`],
  ['JSON.stringify({ prompt, mode })', `JSON.stringify({ prompt, mode, submitAt, pageId: fixturePageId,
        conversationId: id(), controlsReadyAt })`],
  ["input.addEventListener('input', updateButtons);", `
    input.addEventListener('input', updateButtons);
    const controlsReadyAt = fixtureTime();`],
].reduce((body, [marker, replacement]) => replaceFixture(body, marker, replacement), fixture.replace(/\r\n/g, '\n'));
const delayedFixture = replaceFixture(rawFixture, '</body>', '<script src="/__fixture__/parser-block.js"></script></body>');

let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const candidates = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  executablePath = candidates.map(name => join(cache, name, 'chrome-win64', 'chrome.exe')).find(existsSync);
}
assert(executablePath, '未找到 Playwright Chromium');

function instrument({ origin, parentPrefix, segments }) {
  if (location.origin !== origin || !location.pathname.startsWith(`/a/chat/s/${parentPrefix}`)) return;
  const results = window.__dsmBenchmark = {};
  const turns = window.__dsmBenchmarkTurns = [];
  const toolbarButton = 'nav[aria-label="DS Margin 工具栏"] button[aria-label="目录"]';
  const inShadow = selector => document.getElementById('ds-margin-root')?.shadowRoot?.querySelector(selector);
  const renderable = element => element?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  function canClick(element) {
    if (!renderable(element) || element.disabled) return false;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || hit === inner) break;
      hit = inner;
    }
    return element.contains(hit);
  }
  document.addEventListener('DOMContentLoaded', () => { results.domReadyMs = performance.now(); }, { once: true });
  function sampleStartup() {
    const nativeInput = document.querySelector('textarea.ds-textarea__textarea');
    const button = inShadow(toolbarButton);
    if (button) results.toolbarInDomMs ??= performance.now();
    if (canClick(nativeInput)) results.nativeInputHitMs ??= performance.now();
    if (canClick(button)) results.toolbarHitMs ??= performance.now();
    if (results.toolbarHitMs === undefined || results.nativeInputHitMs === undefined)
      requestAnimationFrame(sampleStartup);
  }
  requestAnimationFrame(sampleStartup);

  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const button = event.composedPath().find(element => element instanceof HTMLButtonElement);
    if (!button) return;
    const isToolbarClick = button.matches(toolbarButton);
    const isSideQuestionClick = button.closest('[aria-label="划词旁问"]') && button.textContent.trim() === '旁问';
    const isFollowUpClick = button.getAttribute('aria-label') === '发送旁问';
    if (!isToolbarClick && !isSideQuestionClick && !isFollowUpClick) return;
    const started = performance.now();
    const turn = isToolbarClick ? undefined : { clickAt: performance.timeOrigin + started };
    const turnIndex = isFollowUpClick ? 1 : 0;
    if (turn) turns[turnIndex] = turn;
    else results.toolbarClickAtMs = started;
    function sampleClick() {
      if (isToolbarClick && renderable(inShadow('.panel[aria-label="目录"]'))) {
        results.toolbarClickToPanelMs = performance.now() - started;
        return;
      }
      const sheet = inShadow('[role="dialog"][aria-label="旁问"]');
      if (turn && renderable(sheet)) {
        if (isSideQuestionClick) results.sideQuestionClickToSheetMs ??= performance.now() - started;
        const paragraph = [...sheet.querySelectorAll('.sq-replied p')]
          .find(element => element.textContent.startsWith(segments[turnIndex]) && renderable(element));
        if (paragraph) {
          turn.firstVisibleAt = performance.timeOrigin + performance.now();
          turn.partialVisible = paragraph.textContent === segments[turnIndex];
          return;
        }
      }
      if (performance.now() - started < 12_000) requestAnimationFrame(sampleClick);
    }
    requestAnimationFrame(sampleClick);
  }, true);
}

const profile = await mkdtemp(join(tmpdir(), 'dsm-performance-'));
assert(dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('dsm-performance-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--screen-info={1600x1200}', '--window-size=1440,1000'],
  });
  await context.addInitScript(instrument, { origin, parentPrefix, segments });
  const conversations = new Map();
  const sentTurns = [];
  const timingByDocument = new Map();
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/__fixture__/parser-block.js') {
      await new Promise(resolve => setTimeout(resolve, parserDelayMs));
      return route.fulfill({ contentType: 'application/javascript', body: '' });
    }
    if (url.pathname === '/__fixture__/state') {
      const id = url.searchParams.get('id');
      if (id?.startsWith(parentPrefix)) return route.fulfill({ json: {
        prompt: '请读这段文字。', answer: `举例来说，${quote}。`, history: [], running: false,
      } });
      const now = Date.now();
      const turns = conversations.get(id) ?? [];
      return route.fulfill({ json: { turns: turns.map(turn => ({
        key: turn.key, prompt: turn.prompt, answer: turn.segment + (now >= turn.endsAt ? ending : ''),
      })), history: [], running: turns.length > 0 && now < turns.at(-1).endsAt } });
    }
    if (url.pathname === '/__fixture__/send') {
      const { prompt, conversationId, submitAt, pageId, controlsReadyAt } = route.request().postDataJSON();
      const id = conversationId || `perf-native-${conversations.size + 1}`;
      const turns = conversations.get(id) ?? [];
      assert(turns.length < segments.length);
      const turn = { key: sentTurns.length, id, pageId, prompt, submitAt, controlsReadyAt,
        segment: segments[turns.length], endsAt: Date.now() + answerTailDelayMs };
      sentTurns.push(turn);
      turns.push(turn);
      conversations.set(id, turns);
      return route.fulfill({ json: { id } });
    }
    if (url.pathname === '/__fixture__/timing') {
      const { pageId, key, domReadyAt, segmentAt, publishedText } = route.request().postDataJSON();
      if (domReadyAt !== undefined) timingByDocument.set(pageId, domReadyAt);
      if (segmentAt !== undefined && sentTurns[key]) {
        const turn = sentTurns[key];
        turn.segmentAt ??= segmentAt;
        turn.publishedText ??= publishedText;
      }
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/' || /^\/a\/chat\/s\/(perf-parent-|perf-native-)/.test(url.pathname)) {
      const delayed = parserDelayMs && !url.pathname.startsWith(`/a/chat/s/${parentPrefix}`);
      return route.fulfill({ contentType: 'text/html', body: delayed ? delayedFixture : rawFixture });
    }
    return route.abort();
  });
  const samples = [];
  let screen;
  for (let i = 0; i <= runs; i++) {
    const page = await context.newPage();
    try {
      page.setDefaultTimeout(12_000);
      await page.bringToFront();
      await page.goto(`${origin}/a/chat/s/${parentPrefix}${i}`, { waitUntil: 'commit' });
      await page.waitForFunction(() => window.__dsmBenchmark?.toolbarHitMs !== undefined);
      const currentScreen = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
        userAgent: navigator.userAgent }));
      if (screen) assert.deepEqual(currentScreen, screen);
      else screen = currentScreen;
      const toolbar = page.getByRole('navigation', { name: 'DS Margin 工具栏' });
      await toolbar.getByRole('button', { name: '目录', exact: true }).click();
      const panel = page.getByRole(screen.width > 1100 ? 'complementary' : 'dialog', { name: '目录', exact: true });
      await panel.waitFor();
      await page.waitForFunction(() => window.__dsmBenchmark.toolbarClickToPanelMs !== undefined);
      await panel.getByRole('button', { name: '关闭面板' }).click();
      await page.waitForFunction(() => window.__dsmBenchmark.nativeInputHitMs !== undefined);
      const source = page.locator('.ds-assistant-message-main-content[data-dsm-message]').filter({ hasText: quote });
      await source.waitFor();
      await source.evaluate((element, quote) => {
        const node = element.firstChild;
        const start = node.textContent.indexOf(quote);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + quote.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, quote);
      const priorSends = sentTurns.length;
      await page.getByRole('button', { name: '旁问', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: '旁问', exact: true });
      await sheet.waitFor();
      await page.waitForFunction(() => window.__dsmBenchmark.sideQuestionClickToSheetMs !== undefined);
      await sheet.getByText(segments[0] + ending, { exact: true }).waitFor();
      const followUp = sheet.getByRole('textbox', { name: '旁问输入框' });
      await followUp.fill('继续解释这一点。');
      await sheet.getByRole('button', { name: '发送旁问' }).click();
      await sheet.getByText(segments[1] + ending, { exact: true }).waitFor();
      await page.waitForFunction(() => window.__dsmBenchmarkTurns[1]?.firstVisibleAt !== undefined);
      const { sample, displayTurns } = await page.evaluate(() => ({
        sample: window.__dsmBenchmark, displayTurns: window.__dsmBenchmarkTurns,
      }));
      const fixtureTurns = sentTurns.slice(priorSends);
      assert.equal(fixtureTurns.length, 2);
      assert.equal(fixtureTurns[0].id, fixtureTurns[1].id, '追问应复用首问原站会话');
      for (const [index, label] of ['first', 'followUp'].entries()) {
        const { pageId, controlsReadyAt, submitAt, segmentAt, segment, publishedText } = fixtureTurns[index];
        const { clickAt, firstVisibleAt, partialVisible } = displayTurns[index];
        const domReadyAt = timingByDocument.get(pageId);
        assert(Number.isFinite(domReadyAt), `缺少${label}原站 DOMContentLoaded 时钟`);
        assert.equal(publishedText, segment, `夹具${label}首次发布的应为首段`);
        assert(partialVisible, `浮层应在${label}完整回答之前展示首段`);
        assert(clickAt <= submitAt && submitAt <= segmentAt && segmentAt <= firstVisibleAt, `无效的${label}跨页面时钟`);
        sample[`${label}ClickToNativeSubmitMs`] = submitAt - clickAt;
        sample[`${label}NativeControlsReadyToSubmitMs`] = submitAt - controlsReadyAt;
        sample[`${label}NativeDomReadyToSubmitMs`] = submitAt - domReadyAt;
        sample[`${label}NativeSubmitToSegmentMs`] = segmentAt - submitAt;
        sample[`${label}NativeSegmentToSheetMs`] = firstVisibleAt - segmentAt;
        sample[`${label}ClickToFirstSegmentInSheetMs`] = firstVisibleAt - clickAt;
      }
      samples.push(sample);
      console.error(`${version} ${i ? `${i}/${runs}` : '预热'}：首问点击→提交 ${sample.firstClickToNativeSubmitMs.toFixed(1)} ms，追问 ${sample.followUpClickToNativeSubmitMs.toFixed(1)} ms`);
    } finally {
      await page.close();
    }
  }
  function round(sample) {
    return Object.fromEntries(Object.entries(sample).map(([name, value]) => [name, Number(value.toFixed(2))]));
  }
  const [warmup, ...measured] = samples;
  const mediansMs = Object.fromEntries(Object.keys(warmup).map(name => {
    const values = measured.map(sample => sample[name]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return [name, values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2];
  }));
  console.log(JSON.stringify({ version, environment: '隔离的无头 Chromium 和拦截页面，未连接真实 DeepSeek',
    workerParserDelayMs: parserDelayMs, answerTailDelayMs, screen,
    mediansMs: round(mediansMs), warmup: round(warmup), samples: measured.map(round) }, null, 2));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
