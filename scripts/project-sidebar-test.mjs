import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, closeContext, extensionPopup, launch, output, poll, root } from './browser-utils.mjs';

const origin = 'https://chat.deepseek.com';
const chatUrl = id => `${origin}/a/chat/s/${id}`;
const fixture = await readFile(join(root, 'tests', 'project-sidebar-fixture.html'), 'utf8');
const sameTitle = '同名的调查笔记';
const legacyName = '旧书库项目';
const alphaName = '科研核验';
const betaName = '扩展开发';
const legacyA = 'legacy-note-a';
const legacyB = 'legacy-note-b';
const olderId = 'older-history';
const olderTitle = '旧历史里的验证清单';
const branchId = 'native-branch-only';
const quote = '核对两个公开来源';
const sideAnswer = '这是同名笔记甲的旁问答案。';
const timestamp = 1700000000000;
const sessions = new Map([
  [legacyA, { id: legacyA, title: sameTitle, turns: [{ prompt: '笔记甲的原站消息', answer: quote }] }],
  [legacyB, { id: legacyB, title: sameTitle, turns: [{ prompt: '笔记乙的原站消息', answer: '阅读笔记乙' }] }],
  [branchId, { id: branchId, title: '旁问原站副本', turns: [{ prompt: quote, answer: sideAnswer }] }],
  [olderId, { id: olderId, title: olderTitle, turns: [{ prompt: '早于已加载历史的提问', answer: '旧清单正文' }] }],
]);
const results = [];
const errors = [];
const requests = [];
const nativeDeletions = [];
let deletionAccepted = false;

function snapshot(id, pinned) {
  return {
    id, url: chatUrl(id), title: sameTitle, scope: 'observed', folder: legacyName, pinned,
    capturedAt: timestamp + (pinned ? 0 : 1000), tags: [pinned ? '甲的标签' : '乙的标签'],
    messages: sessions.get(id).turns.flatMap(({ prompt, answer }) => [
      { id: '1', role: 'user', text: prompt, markdown: prompt },
      { id: '2', role: 'assistant', text: answer, markdown: answer },
    ]),
  };
}

const sidebar = page => page.locator('[data-dsm-project-sidebar]');
const nativeHistory = page => page.getByRole('navigation', { name: '对话历史', exact: true });
const projectRow = (page, id) => sidebar(page).locator(`[data-dsm-project-conversation="${id}"]`);
const sidebarButton = (page, name) => sidebar(page).getByRole('button', { name, exact: true });
const input = page => page.getByRole('textbox', { name: '给 DeepSeek 发送消息', exact: true });

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, ms: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    console.error(`FAIL ${name}: ${error}`);
    throw error;
  }
}

async function createProject(page, name) {
  await sidebarButton(page, '创建项目').click();
  await sidebar(page).getByRole('textbox', { name: '项目名称', exact: true }).fill(name);
  await sidebarButton(page, '创建').click();
  await sidebarButton(page, name).waitFor();
}

async function selectProject(page, name) {
  const button = sidebarButton(page, name);
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await poll(() => button.getAttribute('aria-expanded'), expanded => expanded === 'true');
}

async function startInProject(page, name) {
  await selectProject(page, name);
  await sidebarButton(page, '新建对话').click();
  await page.waitForURL(`${origin}/`);
  await page.getByText(new RegExp(`将归入.*${name}`)).waitFor();
}

async function submit(page, prompt, { viaKeyboard = false } = {}) {
  await input(page).fill(prompt);
  if (viaKeyboard) await input(page).press('Enter');
  else await page.getByRole('button', { name: '发送', exact: true }).click();
  const { sessionId } = await poll(() => requests.find(request => request.prompt === prompt), Boolean);
  await page.waitForURL(chatUrl(sessionId));
  await page.locator('[data-dsm-message="user"]').filter({ hasText: prompt }).first().waitFor();
  return sessionId;
}

const context = await launch();
context.on('page', page => {
  page.setDefaultTimeout(6500);
  page.on('pageerror', error => errors.push(error.message));
});
try {
  await context.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fixture__/project-state') {
      const history = [...sessions.values()].filter(session => session.id !== olderId || url.searchParams.get('older') === 'true');
      return route.fulfill({ json: { session: sessions.get(url.searchParams.get('id')), history } });
    }
    if (url.pathname === '/__fixture__/project-send') {
      const { id, prompt } = route.request().postDataJSON();
      const sessionId = id || `project-chat-${requests.length + 1}`;
      requests.push({ originalId: id, sessionId, prompt });
      const session = sessions.get(sessionId) ?? { id: sessionId, title: prompt, turns: [] };
      session.turns.push({ prompt, answer: '受控网页的回复。' });
      sessions.set(sessionId, session);
      return route.fulfill({ json: { id: sessionId } });
    }
    if (url.pathname === '/api/v0/chat_session/delete') {
      const ids = route.request().postDataJSON().chat_session_ids;
      nativeDeletions.push(ids);
      if (deletionAccepted) ids.forEach(id => sessions.delete(id));
      return route.fulfill({ json: { code: 0, data: { biz_code: deletionAccepted ? 0 : 1 } } });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
  });

  const popup = await extensionPopup(context);
  const projects = () => call(popup, 'projects');
  const member = async id => (await projects()).conversations.find(row => row.id === id);
  const project = async name => (await projects()).projects.find(row => row.name === name);
  const first = await context.newPage();
  await call(popup, 'settings.save', { ...await call(popup, 'settings'), autoArchive: false, reduceMotion: true });
  await first.goto(chatUrl(legacyA));
  await first.locator('html.dsm-enabled').waitFor();

  await test('空项目默认保留官网历史，v3 备份的同名会话迁移为两个独立项目行', async () => {
    await nativeHistory(first).getByRole('link', { name: sameTitle, exact: true }).first().waitFor();
    await call(popup, 'import', {
      format: 'ds-margin', version: 3, exportedAt: timestamp,
      settings: await call(popup, 'settings'),
      conversations: [snapshot(legacyA, true), snapshot(legacyB, false)],
      bookmarks: [], prompts: [], drafts: [], blocked: [],
      sideQuestions: [{
        id: 'imported-side-question', parentId: legacyA, parentUrl: chatUrl(legacyA), parentTitle: sameTitle,
        nativeUrl: chatUrl(branchId), createdAt: timestamp, updatedAt: timestamp,
        anchor: { messageId: '2', fingerprint: 'fixture', quote, start: 0, end: quote.length },
        turns: [{
          id: 'side-turn', question: '可以怎样核对？', status: 'complete', answer: sideAnswer,
          checkpoint: { phase: 'awaiting', url: chatUrl(branchId), userMessageId: '1', assistantMessageId: '2' },
          createdAt: timestamp, updatedAt: timestamp,
        }],
      }],
    });
    const acknowledgement = sidebarButton(first, '知道了');
    await acknowledgement.click();
    await selectProject(first, legacyName);
    const migrated = await project(legacyName);
    assert.equal((await member(legacyA)).projectId, migrated.id);
    assert.equal((await member(legacyB)).projectId, migrated.id);
    const visible = sidebar(first).locator('[data-dsm-project-conversation]');
    assert.deepEqual(await visible.evaluateAll(nodes => nodes.map(node => node.dataset.dsmProjectConversation)), [legacyA, legacyB]);
    const library = await call(popup, 'library');
    assert.deepEqual(library.conversations.find(row => row.id === legacyA).tags, ['甲的标签']);
    const backup = await call(popup, 'backup');
    assert.equal(backup.version, 4);
    assert.ok(backup.projects.some(row => row.id === migrated.id));
    assert.ok(backup.projectConversations.some(row => row.id === legacyA && row.pinned));
  });

  let second;
  await test('关闭正文收录后，两标签页分别通过 Enter 和按钮首发，归组并刷新续聊', async () => {
    await createProject(first, alphaName);
    await createProject(first, betaName);
    await selectProject(first, alphaName);
    second = await context.newPage();
    await second.goto(chatUrl(legacyB));
    await Promise.all([startInProject(first, alphaName), startInProject(second, betaName)]);

    const promptA = '研究项目里的首轮问题';
    const promptB = '开发项目里的首轮问题';
    const [idA, idB] = await Promise.all([submit(first, promptA, { viaKeyboard: true }), submit(second, promptB)]);
    const [alpha, beta] = await Promise.all([project(alphaName), project(betaName)]);
    await poll(() => member(idA), row => row?.projectId === alpha.id);
    await poll(() => member(idB), row => row?.projectId === beta.id);
    assert.deepEqual(requests.map(request => request.originalId), ['', '']);
    assert.ok(!(await call(popup, 'library')).conversations.some(row => row.id === idA || row.id === idB));

    await Promise.all([first.reload(), second.reload()]);
    await projectRow(first, idA).getByRole('link', { name: promptA, exact: true }).waitFor();
    await projectRow(second, idB).getByRole('link', { name: promptB, exact: true }).waitFor();
    assert.equal(await projectRow(first, idB).isVisible(), false);
    assert.equal(await projectRow(second, idA).isVisible(), false);
    await first.goto(chatUrl(legacyA));
    await projectRow(first, idA).getByRole('link', { name: promptA, exact: true }).click();
    await first.waitForURL(chatUrl(idA));
    await first.locator('[data-dsm-message="user"]').filter({ hasText: promptA }).waitFor();
  });

  await test('刷新空白原站对话会取消项目归组意图，首发后仍可手动移入', async () => {
    await startInProject(first, alphaName);
    await first.reload();
    await sidebarButton(first, alphaName).waitFor();
    assert.equal(await first.getByText(new RegExp(`将归入.*${alphaName}`)).count(), 0);
    const prompt = '刷新后重新写的普通问题';
    const id = await submit(first, prompt);
    assert.equal(await member(id), undefined);

    await sidebarButton(first, '原站历史').click();
    await projectRow(first, id).getByRole('button', { name: `对话选项：${prompt}`, exact: true }).click();
    await sidebarButton(first, `移入项目：${alphaName}`).click();
    const alpha = await project(alphaName);
    await poll(() => member(id), row => row?.projectId === alpha.id);
    await selectProject(first, alphaName);
  });

  await test('搜索只覆盖已加载标题，原站历史可加载旧会话并手动归组', async () => {
    await sidebarButton(first, '搜索会话').click();
    assert.equal(await sidebarButton(first, '当前项目').getAttribute('aria-pressed'), 'true');
    await sidebarButton(first, '项目与已加载历史').click();
    const query = sidebar(first).getByRole('textbox', { name: '搜索会话', exact: true });
    await query.fill(sameTitle);
    await projectRow(first, legacyA).waitFor();
    await projectRow(first, legacyB).waitFor();
    assert.match(await projectRow(first, legacyA).innerText(), /旧书库项目.*已加载历史/);
    assert.equal(await sidebar(first).getByRole('link', { name: sameTitle, exact: true }).count(), 2);
    await query.fill(olderTitle);
    await sidebar(first).getByText(/此范围未找到对话/).waitFor();
    assert.equal(await projectRow(first, olderId).count(), 0);
    await sidebarButton(first, '原站历史').click();
    await nativeHistory(first).getByRole('button', { name: '加载更早对话', exact: true }).click();
    await nativeHistory(first).getByRole('link', { name: olderTitle, exact: true }).click();
    await first.waitForURL(chatUrl(olderId));

    await sidebarButton(first, '搜索会话').click();
    await sidebarButton(first, '项目与已加载历史').click();
    await query.fill(olderTitle);
    await projectRow(first, olderId).getByRole('button', { name: `对话选项：${olderTitle}`, exact: true }).click();
    await sidebarButton(first, `移入项目：${alphaName}`).click();
    const alpha = await project(alphaName);
    await poll(() => member(olderId), row => row?.projectId === alpha.id);
    await first.keyboard.press('Escape');
    await selectProject(first, alphaName);
    await projectRow(first, olderId).waitFor();
  });

  await test('同名会话的置顶和旁问按 ID 隔离，删除快照后仍可继续原对话', async () => {
    await first.goto(chatUrl(legacyA));
    await selectProject(first, legacyName);
    await first.screenshot({ path: join(output, 'project-sidebar-desktop.png'), animations: 'disabled' });
    await projectRow(first, legacyA).getByRole('button', { name: /旁问.*1/ }).click();
    const sideList = first.locator('[data-dsm-side-list]');
    await sideList.getByText(quote, { exact: true }).click();
    const sidePanel = first.getByRole('dialog', { name: '旁问', exact: true });
    await sidePanel.getByText(sideAnswer, { exact: true }).waitFor();
    await sidePanel.getByRole('button', { name: '收起旁问', exact: true }).click();
    assert.equal(await projectRow(first, legacyB).getByRole('button', { name: /旁问.*1/ }).count(), 0);
    await projectRow(first, legacyA).getByRole('button', { name: `对话选项：${sameTitle}`, exact: true }).click();
    await sidebarButton(first, '取消置顶').click();
    await poll(() => member(legacyA), row => row?.pinned === false);
    assert.equal((await member(legacyB)).pinned, false);

    await first.getByRole('navigation', { name: 'DS Margin 工具栏' }).getByRole('button', { name: '书库', exact: true }).click();
    const library = first.getByRole('complementary', { name: '书库', exact: true });
    const card = library.locator('.library-card').filter({ hasText: '#甲的标签' });
    await card.getByRole('button', { name: `删除本地对话 ${sameTitle}`, exact: true }).click();
    await card.getByRole('button', { name: '确认删除', exact: true }).click();
    await poll(() => call(popup, 'library'), value => !value.conversations.some(row => row.id === legacyA));
    assert.ok((await member(legacyA)).projectId);
    await library.getByRole('button', { name: '关闭面板', exact: true }).click();
    await projectRow(first, legacyA).getByRole('link', { name: sameTitle, exact: true }).waitFor();
  });

  await test('官网业务失败保留项目索引与旁问，官网确认后只删除匹配 ID', async () => {
    await sidebarButton(first, '原站历史').click();
    const nativeDelete = nativeHistory(first).getByRole('button', { name: `原站删除 ${legacyA}`, exact: true });
    await nativeDelete.click();
    await first.getByText('原站删除失败', { exact: true }).waitFor();
    assert.ok(await member(legacyA));
    assert.equal((await call(popup, 'side.list', { parentId: legacyA })).length, 1);
    deletionAccepted = true;
    await nativeDelete.click();
    await first.getByText('原站确认删除', { exact: true }).waitFor();
    await poll(() => member(legacyA), row => row === undefined);
    assert.ok((await member(legacyB)).projectId);
    assert.equal((await call(popup, 'side.list', { parentId: legacyA })).length, 0);
    assert.deepEqual(nativeDeletions, [[legacyA], [legacyA]]);
    await selectProject(first, legacyName);
    await projectRow(first, legacyB).waitFor();
    await projectRow(first, legacyA).waitFor({ state: 'detached' });
  });

  await test('窄屏项目抽屉可键盘收起，删除项目只移出归属并保留原站会话', async () => {
    await first.setViewportSize({ width: 390, height: 760 });
    const show = first.getByRole('button', { name: /^打开会话(?:侧栏|项目)$/ });
    await show.click();
    await projectRow(first, legacyB).waitFor();
    await first.screenshot({ path: join(output, 'project-sidebar-narrow.png'), animations: 'disabled' });
    await first.keyboard.press('Escape');
    await projectRow(first, legacyB).waitFor({ state: 'hidden' });
    await poll(() => show.evaluate(el => el.getRootNode().activeElement === el), Boolean);
    await input(first).click();

    await first.setViewportSize({ width: 1440, height: 1000 });
    await selectProject(first, legacyName);
    await sidebarButton(first, `项目选项：${legacyName}`).click();
    await sidebarButton(first, '删除项目').click();
    await sidebar(first).getByRole('region', { name: '删除项目确认', exact: true })
      .getByRole('button', { name: '删除项目', exact: true }).click();
    await poll(() => project(legacyName), row => row === undefined);
    assert.equal((await member(legacyB))?.projectId ?? null, null);
    await sidebarButton(first, '原站历史').click();
    await nativeHistory(first).getByRole('link', { name: sameTitle, exact: true }).click();
    await first.waitForURL(chatUrl(legacyB));
    assert.deepEqual(nativeDeletions, [[legacyA], [legacyA]]);
  });

  await test('冷启动窄屏时，原站隐藏的侧栏仍可在项目中调用新建对话', async () => {
    const narrow = await context.newPage();
    await narrow.setViewportSize({ width: 390, height: 760 });
    await narrow.goto(chatUrl(legacyB));
    await narrow.locator('html.dsm-enabled').waitFor();
    assert.equal(await narrow.locator('aside').isVisible(), false);
    await narrow.getByRole('button', { name: /^打开会话(?:侧栏|项目)$/ }).click();
    await startInProject(narrow, alphaName);
    await input(narrow).click();
    await narrow.close();
  });

  await test('原站历史复用同一行时，旁问标题忽略隐藏文案并切换到正确会话', async () => {
    const threads = [legacyB, olderId].map((id, index) => ({
      id: `sidebar-reuse-${index}`, parentId: id, parentUrl: chatUrl(id), parentTitle: sessions.get(id).title,
      createdAt: timestamp, updatedAt: timestamp,
      anchor: { messageId: '2', fingerprint: 'fixture', quote: `行复用引用 ${index}`, start: 0, end: 7 },
      turns: [{ id: `sidebar-reuse-turn-${index}`, question: '核对引用', status: 'failed', checkpoint: { phase: 'queued' },
        createdAt: timestamp, updatedAt: timestamp }],
    }));
    await call(popup, 'import', { format: 'ds-margin', version: 3, exportedAt: timestamp,
      settings: await call(popup, 'settings'), conversations: [], bookmarks: [], prompts: [], drafts: [], blocked: [], sideQuestions: threads });
    const row = nativeHistory(first).locator(`a[href$="/${legacyB}"]`);
    await row.evaluate(link => {
      delete link.dataset.nativeSessionTitle;
      const hidden = document.createElement('span');
      hidden.hidden = true;
      hidden.textContent = '隐藏的工具文案';
      link.append(hidden);
    });
    await first.getByRole('button', { name: `${sameTitle} · 旁问 1`, exact: true }).click();
    const list = first.locator('[data-dsm-side-list]');
    await list.getByText(threads[0].anchor.quote, { exact: true }).waitFor();
    await row.evaluate((link, { id, title }) => {
      link.href = `/a/chat/s/${id}`;
      link.firstChild.textContent = title;
    }, { id: olderId, title: olderTitle });
    await list.waitFor({ state: 'detached' });
    await first.getByRole('button', { name: `${olderTitle} · 旁问 1`, exact: true }).click();
    await list.getByText(threads[1].anchor.quote, { exact: true }).waitFor();
  });

  assert.deepEqual(errors, []);
} finally {
  await writeFile(join(output, 'project-sidebar-results.json'), JSON.stringify({ results, errors }, null, 2));
  await closeContext(context);
}
