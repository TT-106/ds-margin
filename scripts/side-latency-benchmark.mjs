import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [baselineArg, candidateArg, outputArg, sampleArg = '12'] = process.argv.slice(2);
const sampleCount = Number(sampleArg);
assert(baselineArg && candidateArg && outputArg && Number.isInteger(sampleCount) &&
  sampleCount >= 2 && sampleCount <= 40 && sampleCount % 2 === 0,
  '用法：node scripts/side-latency-benchmark.mjs <基线扩展> <候选扩展> <输出目录> [偶数样本数，默认12]');
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const origin = 'https://chat.deepseek.com';
const parentPrefix = 'side-perf-parent-';
const nativePrefix = 'side-perf-native-';
const completionPath = '/api/v0/chat/completion';
const serviceWorkerPath = '/__fixture__/side-latency-worker.js';
const quote = '旁问延迟基准中的所选文字';
const segments = ['基准首问首段。', '基准追问首段。'];
const ending = '最终增量。';
const answerTailDelayMs = 1000;
const fixtureSource = (await readFile(new URL('../tests/side-question-fixture.html', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n');

function replace(source, marker, replacement) {
  assert(source.includes(marker), `夹具标记不存在：${marker}`);
  return source.replace(marker, replacement);
}

function fixtureFor(mode) {
  let fixture = replace(fixtureSource, "const input = document.querySelector('textarea');", `
    const input = document.querySelector('textarea');
    const benchmarkMode = ${JSON.stringify(mode)};
    const fixtureTime = () => performance.timeOrigin + performance.now();
    const fixturePageId = crypto.randomUUID();
    const seenSegments = new Set();
    const reportTiming = fields => fetch('/__fixture__/timing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: fixturePageId, ...fields }),
    });`);
  fixture = replace(fixture,
    "if (state.prompt) addMessage('1', 'user', state.prompt, false);\n      if (state.answer || state.running) addMessage('2', 'assistant', state.answer, state.think);", `
      if (state.prompt) addMessage('1', 'user', state.prompt, false);
      if (state.answer) addMessage('2', 'assistant', state.answer, false);
      if (benchmarkMode === 'dom') state.turns?.forEach((turn, index) => {
        addMessage(String(index * 2 + 1), 'user', turn.prompt, false);
        if (!turn.answer) return;
        addMessage(String(index * 2 + 2), 'assistant', turn.answer, false);
        if (!seenSegments.has(turn.key)) {
          seenSegments.add(turn.key);
          void reportTiming({ key: turn.key, segmentAt: fixtureTime(), text: turn.answer });
        }
      });`);
  fixture = replace(fixture, '      revision++;\n      const prompt = input.value;', `
      const submitAt = fixtureTime();
      revision++;
      const prompt = input.value;`);
  fixture = replace(fixture, 'JSON.stringify({ prompt, mode })', `JSON.stringify({ prompt, mode,
        conversationId: id(), submitAt, pageId: fixturePageId })`);
  fixture = replace(fixture, 'const result = await response.json();', `
      const result = await response.json();
      if (benchmarkMode === 'sse') {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '${completionPath}');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ chat_session_id: result.id,
          parent_message_id: result.parentMessageId, prompt, benchmarkKey: result.key }));
      }`);
  return fixture;
}

const fixtures = { dom: fixtureFor('dom'), sse: fixtureFor('sse') };
const serviceWorkerSource = `
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  const segments = ${JSON.stringify(segments)};
  self.__sideBenchmarkTimings = [];
  const frame = (event, data) => (event ? 'event: ' + event + '\\n' : '') +
    'data: ' + JSON.stringify(data) + '\\n\\n';
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.pathname !== '${completionPath}' || event.request.method !== 'POST') return;
    event.respondWith((async () => {
      const input = await event.request.json();
      const followUp = input.parent_message_id === 2;
      const userId = followUp ? 3 : 1;
      const assistantId = followUp ? 4 : 2;
      const text = segments[followUp ? 1 : 0];
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        const push = (event, data) => controller.enqueue(encoder.encode(frame(event, data)));
        push('ready', { request_message_id: userId, response_message_id: assistantId });
        const segmentAt = performance.timeOrigin + performance.now();
        push(null, { v: { response: { message_id: assistantId, parent_id: userId, fragments: [
          { type: 'THINK', content: '不应出现在旁问中的思考文本' },
          { type: 'RESPONSE', content: text },
        ] } } });
        self.__sideBenchmarkTimings.push({ key: input.benchmarkKey, segmentAt, text });
        setTimeout(() => {
          push(null, { p: 'response/fragments/-1/content', o: 'APPEND', v: ${JSON.stringify(ending)} });
          push('finish', {});
          controller.close();
        }, ${answerTailDelayMs});
      } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    })());
  });`;

function instrumentMain({ origin, parentPrefix, segments }) {
  if (location.origin !== origin || !location.pathname.startsWith(`/a/chat/s/${parentPrefix}`)) return;
  const turns = window.__sideLatencyTurns = [];
  const root = () => document.getElementById('ds-margin-root')?.shadowRoot;
  const visible = element => element && element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const button = event.composedPath().find(element => element instanceof HTMLButtonElement);
    if (!button) return;
    const first = button.closest('[aria-label="划词旁问"]') && button.textContent.trim() === '旁问';
    const followUp = button.getAttribute('aria-label') === '发送旁问';
    if (!first && !followUp) return;
    const index = followUp ? 1 : 0;
    const turn = turns[index] = { clickAt: performance.timeOrigin + performance.now() };
    function sample() {
      const sheet = root()?.querySelector('[role="dialog"][aria-label="旁问"]');
      if (visible(sheet)) {
        turn.sheetAt ??= performance.timeOrigin + performance.now();
        const paragraph = [...sheet.querySelectorAll('.sq-replied p')].find(element =>
          element.textContent.startsWith(segments[index]) && visible(element));
        if (paragraph) {
          turn.firstVisibleAt = performance.timeOrigin + performance.now();
          turn.partialVisible = paragraph.textContent === segments[index];
          return;
        }
      }
      if (performance.timeOrigin + performance.now() - turn.clickAt < 12_000) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, true);
}

let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const installed = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  executablePath = installed.map(name => join(cache, name, 'chrome-win64', 'chrome.exe')).find(existsSync);
}
assert(executablePath, '未找到 Playwright Chromium');
const hash = source => createHash('sha256').update(source).digest('hex');
const builds = [];
for (const [label, argument] of [['baseline', baselineArg], ['candidate', candidateArg]]) {
  const directory = resolve(argument);
  const files = await Promise.all(['manifest.json', 'background.js', 'content.js', 'native-stream.js']
    .map(async name => [name, await readFile(join(directory, name))]));
  builds.push({ label, directory, version: JSON.parse(files[0][1]).version,
    sha256: Object.fromEntries(files.map(([name, source]) => [name, hash(source)])) });
}

const metricNames = ['clickToSubmitMs', 'nativeSegmentToSheetMs', 'clickToFirstSegmentMs', 'clickToSheetMs'];
const round = value => Number(value.toFixed(3));
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}
function summarize(samples) {
  return Object.fromEntries(['first', 'followUp'].map(kind => [kind,
    Object.fromEntries(metricNames.map(name => {
      const values = samples.map(sample => sample[kind][name]);
      return [name, { median: round(percentile(values, .5)), p95: round(percentile(values, .95)),
        min: round(Math.min(...values)), max: round(Math.max(...values)) }];
    }))]));
}

async function runBatch(build, mode, count, batch, diagnostics = false) {
  const profile = await mkdtemp(join(tmpdir(), 'dsm-side-latency-'));
  assert(dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('dsm-side-latency-'));
  const sessions = new Map();
  const sent = [];
  const pageErrors = [];
  const samples = [];
  let context;
  let extensionWorker;
  let siteWorker;
  let browserVersion;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: null,
      args: [`--disable-extensions-except=${build.directory}`, `--load-extension=${build.directory}`,
        '--screen-info={1600x1200}', '--window-size=1440,1000'],
    });
    context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
    await context.addInitScript(instrumentMain, { origin, parentPrefix, segments });
    await context.route(/^https?:\/\//, async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === serviceWorkerPath) return route.fulfill({ contentType: 'text/javascript',
        headers: { 'Service-Worker-Allowed': '/' }, body: serviceWorkerSource });
      if (url.pathname === '/__fixture__/register') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>计时夹具注册</title>' });
      if (url.pathname === '/__fixture__/send') {
        const { prompt, conversationId, submitAt, pageId } = request.postDataJSON();
        const id = conversationId || nativePrefix + sessions.size;
        const turns = sessions.get(id) ?? [];
        assert(turns.length < 2, '同一原生会话最多两问');
        const turn = { key: sent.length, id, pageId, prompt, submitAt,
          segment: segments[turns.length], endsAt: Date.now() + answerTailDelayMs };
        sent.push(turn);
        turns.push(turn);
        sessions.set(id, turns);
        return route.fulfill({ json: { id, key: turn.key, parentMessageId: (turns.length - 1) * 2 || null } });
      }
      if (url.pathname === '/__fixture__/timing') {
        const timing = request.postDataJSON();
        assert(sent[timing.key], 'DOM首段时钟必须对应已发送请求');
        sent[timing.key].segmentAt ??= timing.segmentAt;
        sent[timing.key].publishedText ??= timing.text;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === '/__fixture__/state') {
        const id = url.searchParams.get('id');
        if (id?.startsWith(parentPrefix)) return route.fulfill({ json: {
          prompt: '阅读这段文字。', answer: `例如，${quote}。`, history: [], running: false,
        } });
        const now = Date.now();
        const turns = sessions.get(id) ?? [];
        return route.fulfill({ json: { turns: turns.map(turn => ({ key: turn.key, prompt: turn.prompt,
          answer: turn.segment + (now >= turn.endsAt ? ending : '') })),
          history: [], running: turns.length > 0 && now < turns.at(-1).endsAt } });
      }
      if (url.pathname === '/' || url.pathname.startsWith(`/a/chat/s/${parentPrefix}`) ||
          url.pathname.startsWith(`/a/chat/s/${nativePrefix}`))
        return route.fulfill({ contentType: 'text/html', body: fixtures[mode] });
      return route.abort();
    });
    extensionWorker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://')) ??
      await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith('chrome-extension://') });
    const extensionId = new URL(extensionWorker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const settings = await popup.evaluate(async () => chrome.runtime.sendMessage({ source: 'ds-margin', action: 'settings' }));
    assert(settings.ok);
    await popup.evaluate(async value => chrome.runtime.sendMessage({ source: 'ds-margin', action: 'settings.save',
      data: { ...value, autoArchive: false, reduceMotion: true } }), settings.value);
    browserVersion = await extensionWorker.evaluate(() => navigator.userAgent);
    if (mode === 'sse') {
      const setup = await context.newPage();
      await setup.goto(origin + '/__fixture__/register');
      await setup.evaluate(async script => {
        await navigator.serviceWorker.register(script, { scope: '/' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }, serviceWorkerPath);
      siteWorker = context.serviceWorkers().find(worker => worker.url() === origin + serviceWorkerPath);
      assert(siteWorker, '原生流夹具Service Worker已注册');
      await setup.close();
    }
    if (diagnostics) await extensionWorker.evaluate(() => {
      const set = chrome.storage.local.set;
      globalThis.__sideEpochWrites = [];
      chrome.storage.local.set = function (...args) {
        if (args[0] && 'ds-margin:sideEpoch' in args[0])
          globalThis.__sideEpochWrites.push({ at: performance.timeOrigin + performance.now() });
        return Reflect.apply(set, this, args);
      };
    });
    for (let index = 0; index <= count; index++) {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      let session;
      let contentContext;
      try {
        if (diagnostics) {
          session = await context.newCDPSession(page);
          const contexts = [];
          session.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
          await session.send('Runtime.enable');
          contentContext = contexts;
        }
        await page.bringToFront();
        await page.goto(`${origin}/a/chat/s/${parentPrefix}${batch}-${index}`);
        const source = page.locator('.ds-assistant-message-main-content[data-dsm-message]').filter({ hasText: quote });
        await source.waitFor();
        if (diagnostics) {
          const world = contentContext.find(world => world.origin === `chrome-extension://${extensionId}`);
          assert(world, '找不到内容脚本世界');
          contentContext = world.id;
          const result = await session.send('Runtime.evaluate', { contextId: contentContext, expression: `(() => {
            const send = chrome.runtime.sendMessage;
            globalThis.__sideReadCalls = [];
            chrome.runtime.sendMessage = function (...args) {
              const action = args[0]?.action;
              if (['side.summary','side.get','side.list'].includes(action))
                globalThis.__sideReadCalls.push({ action, at: performance.timeOrigin + performance.now() });
              return Reflect.apply(send, this, args);
            };
          })()` });
          assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        }
        await source.evaluate((element, selected) => {
          const node = element.firstChild;
          const offset = node.textContent.indexOf(selected);
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + selected.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }, quote);
        const sentBefore = sent.length;
        await page.getByRole('button', { name: '旁问', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: '旁问', exact: true });
        const followUpInput = sheet.getByRole('textbox', { name: '旁问输入框' });
        await sheet.getByText(segments[0] + ending, { exact: true }).waitFor();
        await followUpInput.waitFor();
        await page.waitForFunction(() => !document.getElementById('ds-margin-root').shadowRoot.querySelector('.sq-status'));
        assert.equal(await sheet.getByRole('alert').count(), 0, '首问完成后不应出现失败或需核对状态');
        assert(await sheet.getByText(segments[0] + ending, { exact: true }).isVisible());
        const firstCompleteAt = await page.evaluate(() => performance.timeOrigin + performance.now());
        await followUpInput.fill('继续解释。');
        await sheet.getByRole('button', { name: '发送旁问', exact: true }).click();
        await sheet.getByText(segments[1] + ending, { exact: true }).waitFor();
        await page.waitForFunction(() => !document.getElementById('ds-margin-root').shadowRoot.querySelector('.sq-status'));
        assert.equal(await sheet.getByRole('alert').count(), 0, '追问完成后不应出现失败或需核对状态');
        assert(await sheet.getByText(segments[1] + ending, { exact: true }).isVisible());
        await page.waitForFunction(() => window.__sideLatencyTurns[1]?.firstVisibleAt !== undefined);
        const completedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
        const stored = await popup.evaluate(async parentId => chrome.runtime.sendMessage({
          source: 'ds-margin', action: 'side.list', data: { parentId },
        }), parentPrefix + batch + '-' + index);
        assert(stored.ok && stored.value?.length === 1, '每个主会话只应保存一个旁问线程');
        assert.equal(stored.value[0].turns.length, 2, '旁问线程须包含首问与追问');
        for (const [turnIndex, turn] of stored.value[0].turns.entries()) {
          assert.equal(turn.status, 'complete', '旁问最终状态必须为complete');
          assert.equal(turn.answer, segments[turnIndex] + ending, '旁问最终答案须完整且精确匹配');
        }
        const displayed = await page.evaluate(() => window.__sideLatencyTurns);
        const nativeTurns = sent.slice(sentBefore);
        assert.equal(nativeTurns.length, 2, '每轮必须只提交两次');
        assert.equal(nativeTurns[0].id, nativeTurns[1].id, '追问必须复用同一原生会话');
        if (mode === 'sse') {
          const timings = await siteWorker.evaluate(() => globalThis.__sideBenchmarkTimings);
          for (const turn of nativeTurns) {
            const timing = timings.find(value => value.key === turn.key);
            assert(timing, '缺少原生流首段发布时间');
            Object.assign(turn, { segmentAt: timing.segmentAt, publishedText: timing.text });
          }
        }
        const sample = { batch, index, warmup: index === 0 };
        for (const [offset, kind] of ['first', 'followUp'].entries()) {
          const native = nativeTurns[offset];
          const display = displayed[offset];
          assert(display.partialVisible, `${kind}必须在结束前显示首段`);
          assert.equal(native.publishedText, segments[offset]);
          assert(display.clickAt <= native.submitAt && native.submitAt <= native.segmentAt &&
            native.segmentAt <= display.firstVisibleAt, `${kind}跨页面时钟顺序错误`);
          sample[kind] = {
            clickToSubmitMs: round(native.submitAt - display.clickAt),
            nativeSegmentToSheetMs: round(display.firstVisibleAt - native.segmentAt),
            clickToFirstSegmentMs: round(display.firstVisibleAt - display.clickAt),
            clickToSheetMs: round(display.sheetAt - display.clickAt),
            timestamps: { ...display, submitAt: native.submitAt, segmentAt: native.segmentAt,
              completeAt: offset === 0 ? firstCompleteAt : completedAt },
          };
        }
        if (diagnostics) {
          const epochs = await extensionWorker.evaluate(() => globalThis.__sideEpochWrites);
          const response = await session.send('Runtime.evaluate', { contextId: contentContext,
            expression: 'globalThis.__sideReadCalls', returnByValue: true });
          assert(!response.exceptionDetails);
          const reads = response.result.value;
          sample.diagnostics = {};
          for (const kind of ['first', 'followUp']) {
            const { clickAt, submitAt, completeAt } = sample[kind].timestamps;
            const countWindow = end => ({
              sideEpochWrites: epochs.filter(value => value.at >= clickAt && value.at <= end).length,
              reads: Object.fromEntries(['side.summary', 'side.get', 'side.list'].map(action =>
                [action, reads.filter(value => value.action === action && value.at >= clickAt && value.at <= end).length])),
            });
            sample.diagnostics[kind] = { beforeSubmit: countWindow(submitAt), wholeTurn: countWindow(completeAt) };
          }
        }
        samples.push(sample);
        console.error(`${mode} ${build.label} 批次${batch} ${index === 0 ? '预热' : `${index}/${count}`}：` +
          `首问提交 ${sample.first.clickToSubmitMs} ms，追问提交 ${sample.followUp.clickToSubmitMs} ms`);
      } finally {
        await session?.detach().catch(() => {});
        await page.close();
      }
    }
    assert.deepEqual(pageErrors, [], '夹具无页面脚本异常');
    return { build, mode, batch, diagnostics, browserVersion, samples, sentTurns: sent.length,
      errors: pageErrors };
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

const report = { environment: 'Windows、隔离无头 Chromium、受控 DeepSeek 网页夹具',
  clock: 'performance.timeOrigin + performance.now；DOM 首段取原站DOM发布，SSE首段取原生Response enqueue',
  submitDefinition: '受控原站send.onclick处理函数入口，之后夹具/send返回会话编号，SSE场景再发起原生XHR',
  counts: '独立运行；side.get整轮包含650ms补偿轮询，提交前与整轮分开报告',
  sampleCountPerBuildAndMode: sampleCount, warmupPerBatch: 1, order: ['baseline', 'candidate', 'candidate', 'baseline'],
  answerTailDelayMs, builds, modes: {}, diagnostics: {} };
await writeFile(join(output, 'builds.json'), JSON.stringify(builds, null, 2));
for (const mode of ['dom', 'sse']) {
  const batches = [];
  for (const [index, buildIndex] of [0, 1, 1, 0].entries()) {
    const batch = await runBatch(builds[buildIndex], mode, sampleCount / 2, index + 1);
    batches.push(batch);
    await writeFile(join(output, `${mode}-${builds[buildIndex].label}-batch-${index + 1}.json`), JSON.stringify(batch, null, 2));
  }
  report.modes[mode] = Object.fromEntries(builds.map(build => {
    const samples = batches.filter(batch => batch.build.label === build.label)
      .flatMap(batch => batch.samples.filter(sample => !sample.warmup));
    assert.equal(samples.length, sampleCount);
    return [build.label, { summary: summarize(samples), samples }];
  }));
  report.diagnostics[mode] = {};
  for (const build of builds) {
    const batch = await runBatch(build, mode, 1, 'counts', true);
    report.diagnostics[mode][build.label] = batch.samples.find(sample => !sample.warmup).diagnostics;
    await writeFile(join(output, `${mode}-${build.label}-counts.json`), JSON.stringify(batch, null, 2));
  }
  for (const kind of ['first', 'followUp']) {
    const baseline = report.diagnostics[mode].baseline[kind];
    const candidate = report.diagnostics[mode].candidate[kind];
    assert.equal(baseline.beforeSubmit.sideEpochWrites - candidate.beforeSubmit.sideEpochWrites, 2,
      `${mode}/${kind}提交前应减少两次prepared/sending通知`);
    assert.equal(baseline.wholeTurn.sideEpochWrites - candidate.wholeTurn.sideEpochWrites, 2,
      `${mode}/${kind}整轮应减少两次通知`);
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
}
for (const build of builds) for (const [name, expected] of Object.entries(build.sha256)) {
  assert.equal(hash(await readFile(join(build.directory, name))), expected, `${build.label}/${name}实验期间被修改`);
}
report.buildHashesVerifiedAtEnd = true;
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, builds, modes: Object.fromEntries(Object.entries(report.modes)
  .map(([mode, builds]) => [mode, Object.fromEntries(Object.entries(builds).map(([label, data]) => [label, data.summary]))])),
  diagnostics: report.diagnostics }, null, 2));
