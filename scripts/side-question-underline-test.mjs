import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, closeContext, extensionPopup, call, poll, root, output } from './browser-utils.mjs';

const parentId = 'ordinary-notes';
const parentUrl = `https://chat.deepseek.com/a/chat/s/${parentId}`;
const quote = '费马大定理';
const text = `问题：${quote}的一个“远亲”——Mordell 方程`;
const start = text.indexOf(quote);
let hash = 2166136261;
for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
const at = 1_700_000_000_000;
const thread = {
  id: 'fermat-side-question', parentId, parentUrl, parentTitle: '数论笔记',
  nativeUrl: 'https://chat.deepseek.com/a/chat/s/fermat-branch',
  anchor: { messageId: 'fermat', fingerprint: (hash >>> 0).toString(36), quote, start, end: start + quote.length },
  turns: [{ id: 'fermat-turn', question: '解释费马大定理', answer: '费马大定理研究整数方程。',
    status: 'complete', checkpoint: { phase: 'awaiting', url: 'https://chat.deepseek.com/a/chat/s/fermat-branch',
      userMessageId: '1', assistantMessageId: '2' }, createdAt: at, updatedAt: at }],
  createdAt: at, updatedAt: at,
};
const fixture = (await readFile(join(root, 'tests', 'side-question-fixture.html'), 'utf8'))
  .replace(/<script>[\s\S]*?<\/script>/, '')
  .replace('<div id="messages"></div>', `<div id="messages"><div data-virtual-list-item-key="fermat"><div class="ds-message">
    <div class="ds-markdown ds-assistant-message-main-content"><h2>${text}</h2></div>
    </div></div><p>考虑方程 y² = x³ + k。</p></div>`);
const context = await launch();
const errors = [];
try {
  await context.route('https://chat.deepseek.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const popup = await extensionPopup(context);
  const settings = await call(popup, 'settings');
  await call(popup, 'settings.save', { ...settings, theme: 'light' });
  await call(popup, 'import', { format: 'ds-margin', version: 3, exportedAt: at,
    conversations: [], bookmarks: [], prompts: [], drafts: [], blocked: [], sideQuestions: [thread] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(parentUrl);
  const source = page.locator('[data-dsm-message=assistant]');
  const readUnderline = () => page.evaluate(() => [...(CSS.highlights.get('dsm-side-question-references') ?? [])].map(range => range.toString()));
  const checkUnderline = async () => {
    await poll(readUnderline, ranges => ranges.length === 1 && ranges[0] === quote);
    assert.equal(await source.textContent(), text, '点状标记不得改写正文');
    assert.equal(await page.locator('[data-dsm-side-reference]').count(), 0, '正文不显示数字编号');
    assert.equal(await source.evaluate(element => getComputedStyle(element, '::highlight(dsm-side-question-references)').textDecorationStyle), 'dotted');
  };
  await checkUnderline();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, 'fermat-dots-closed.png') });
  const bounds = await source.boundingBox();
  await page.screenshot({ path: join(output, 'fermat-dots-detail.png'), clip: {
    x: bounds.x - 10, y: bounds.y - 10, width: bounds.width + 20, height: bounds.height + 30,
  } });
  const point = await page.evaluate(() => {
    const range = [...CSS.highlights.get('dsm-side-question-references')][0];
    const box = range.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const sheet = page.getByRole('dialog', { name: '旁问', exact: true });
  await sheet.waitFor();
  await checkUnderline();
  await sheet.getByRole('button', { name: '收起旁问', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
  await checkUnderline();
  await page.reload();
  await checkUnderline();
  await source.evaluate(element => element.replaceWith(element.cloneNode(true)));
  await poll(readUnderline, ranges => ranges.length === 1 && ranges[0] === quote);
  await checkUnderline();
  await call(popup, 'settings.save', { ...settings, theme: 'dark' });
  await page.waitForSelector('html[data-dsm-theme=dark]');
  await checkUnderline();
  await page.screenshot({ path: join(output, 'fermat-dots-dark.png') });
  await call(popup, 'clear', { currentId: parentId });
  await poll(readUnderline, ranges => ranges.length === 0);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'fermat-dots-results.json'), JSON.stringify({ passed: true,
    checks: ['原词常驻点状标记', '正文无数字编号', '点击原词打开旁问', '打开及收起均保留', '刷新恢复', '正文重挂载恢复', '深色主题保留', '清库移除'], errors }, null, 2));
  console.log('PASS 费马大定理显示点状标记且无编号，点击可打开，收起/刷新/重挂载后保留，清库后移除');
} finally {
  await closeContext(context);
}
