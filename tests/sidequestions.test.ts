import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/background/database';
import { readSideQuestionThread, type SideQuestionBegin } from '../src/sidequestions/model';
import { SideQuestionStore } from '../src/sidequestions/store';

const parentUrl = 'https://chat.deepseek.com/a/chat/s/parent-chat';
const nativeUrl = 'https://chat.deepseek.com/a/chat/s/native-side-chat';

function input(overrides: Partial<SideQuestionBegin> = {}): SideQuestionBegin {
  return {
    id: 'side-thread',
    requestId: 'ask-1',
    parentId: 'parent-chat',
    parentUrl,
    parentTitle: '黑洞',
    anchor: { messageId: '7', fingerprint: 'f1', quote: '吸积盘', start: 5, end: 8 },
    question: '它为什么会发光？',
    ...overrides,
  };
}

async function advance(store: SideQuestionStore, phase: 'sending' | 'awaiting') {
  await store.checkpoint('side-thread', 'ask-1', { phase: 'prepared', workerTabId: 15, workerSessionId: 'session-a' });
  await store.checkpoint('side-thread', 'ask-1', { phase: 'sending' }, 'session-a');
  if (phase === 'awaiting') {
    await store.checkpoint('side-thread', 'ask-1', {
      phase: 'awaiting', url: nativeUrl, userMessageId: '21', assistantMessageId: '22',
    }, 'session-a');
  }
}

describe('旁问存储', () => {
  it('升级旧库时保留历史数据，并按主会话索引找回已经提交的原生回答', async () => {
    const name = `side-test-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('conversations', { keyPath: 'id' }).put({ id: 'legacy', title: '旧记录' });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const db = new Database(name);
    const store = new SideQuestionStore(db);
    expect(await db.get('conversations', 'legacy')).toEqual({ id: 'legacy', title: '旧记录' });
    await store.begin(input());
    await advance(store, 'awaiting');
    await store.complete('side-thread', 'ask-1', '气体受热后发光。', 'session-a');

    const restored = new SideQuestionStore(new Database(name));
    const [thread] = await restored.list('parent-chat');
    expect(thread).toMatchObject({ nativeUrl, turns: [{ answer: '气体受热后发光。', status: 'complete' }] });
    expect(thread.turns[0].checkpoint.workerSessionId).toBeUndefined();
    expect(readSideQuestionThread(thread)).toEqual(thread);
    expect(await restored.list('other-chat')).toEqual([]);
    expect(await restored.counts(['parent-chat'])).toEqual({ parents: { 'parent-chat': 1 }, nativeConversationIds: ['native-side-chat'] });
    expect(await restored.counts(['other-chat'])).toEqual({ parents: {}, nativeConversationIds: ['native-side-chat'] });
  });

  it('原子地去重并发提交，并阻止旧执行页或不同原生消息覆盖回答', async () => {
    const name = `side-test-${crypto.randomUUID()}`;
    const store = new SideQuestionStore(new Database(name));
    const concurrent = new SideQuestionStore(new Database(name));
    const starts = await Promise.all([store.begin(input()), concurrent.begin(input())]);
    expect(starts.filter(({ created }) => created)).toHaveLength(1);
    await expect(concurrent.begin(input({ requestId: 'ask-2' }))).rejects.toThrow('上一条旁问还在生成');
    await advance(store, 'awaiting');
    await concurrent.checkpoint('side-thread', 'ask-1', { workerSessionId: 'session-b' }, 'session-a');
    await expect(store.complete('side-thread', 'ask-1', '旧页答复', 'session-a')).rejects.toThrow('执行页面已变更');
    await expect(concurrent.checkpoint('side-thread', 'ask-1', { assistantMessageId: '23' }, 'session-b')).rejects.toThrow('不同原生消息');
    await concurrent.complete('side-thread', 'ask-1', '已确认回答', 'session-b');
    const { thread } = await store.begin(input({ requestId: 'ask-2', question: '再说具体一点' }));
    expect(thread.nativeUrl).toBe(nativeUrl);
    await store.complete('side-thread', 'ask-1', '迟到答复', 'session-b');
    expect((await store.get('side-thread'))?.turns.map((turn) => turn.answer)).toEqual(['已确认回答', undefined]);
  });

  it('未知发送状态跨刷新保留，并阻止继续发送直到人工核对', async () => {
    const name = `side-test-${crypto.randomUUID()}`;
    const store = new SideQuestionStore(new Database(name));
    await store.begin(input());
    await advance(store, 'sending');
    await store.fail('side-thread', 'ask-1', '执行页断开');
    const reopened = new SideQuestionStore(new Database(name));
    expect((await reopened.list('parent-chat'))[0].turns[0]).toMatchObject({
      status: 'attention', checkpoint: { phase: 'sending' }, error: '执行页断开',
    });
    await expect(reopened.begin(input({ requestId: 'ask-2' }))).rejects.toThrow('可能已经发送');
    expect((await reopened.begin(input())).created).toBe(false);
  });

  it('只清理已删除会话的旁问分支，保留原生子会话的隐藏标记并拒绝迟到写入', async () => {
    const name = `side-test-${crypto.randomUUID()}`;
    const db = new Database(name);
    const store = new SideQuestionStore(db);
    await store.begin(input());
    await advance(store, 'awaiting');
    await store.begin(input({ id: 'nested', requestId: 'ask-nested', parentId: 'native-side-chat', parentUrl: nativeUrl }));
    await store.checkpoint('nested', 'ask-nested', { phase: 'prepared' });
    await store.checkpoint('nested', 'ask-nested', { phase: 'sending' });
    await store.checkpoint('nested', 'ask-nested', {
      phase: 'awaiting', url: 'https://chat.deepseek.com/a/chat/s/nested-native', userMessageId: '1', assistantMessageId: '2',
    });
    await store.begin(input({ id: 'candidate', requestId: 'ask-candidate' }));
    await store.checkpoint('candidate', 'ask-candidate', { phase: 'prepared' });
    await store.checkpoint('candidate', 'ask-candidate', {
      phase: 'sending', candidateUrl: 'https://chat.deepseek.com/a/chat/s/unconfirmed-chat',
    });
    const unrelated = input({
      id: 'unrelated', requestId: 'ask-unrelated', parentId: 'unconfirmed-chat',
      parentUrl: 'https://chat.deepseek.com/a/chat/s/unconfirmed-chat',
    });
    await store.begin(unrelated);

    // Removing a local archive pauses collection and leaves native side questions intact.
    await db.removeConversation('parent-chat');
    expect(await store.list('parent-chat')).toHaveLength(2);
    const deleted = await store.deleteParent('parent-chat');
    expect(deleted.threads.map(thread => thread.id).sort()).toEqual(['candidate', 'nested', 'side-thread']);
    expect(deleted.nativeConversationIds).toEqual(['native-side-chat', 'nested-native']);

    const reopened = new SideQuestionStore(new Database(name));
    expect(await reopened.list('parent-chat')).toEqual([]);
    expect(await reopened.list('native-side-chat')).toEqual([]);
    expect((await reopened.list('unconfirmed-chat')).map(thread => thread.id)).toEqual(['unrelated']);
    expect(await reopened.counts()).toEqual({
      parents: { 'unconfirmed-chat': 1 }, nativeConversationIds: ['native-side-chat', 'nested-native'],
    });
    await expect(reopened.complete('side-thread', 'ask-1', '迟到回答', 'session-a')).rejects.toThrow('旁问不存在');
    await expect(reopened.begin(input())).rejects.toThrow('主会话已删除');
    await expect(reopened.begin(input({ parentId: 'native-side-chat', parentUrl: nativeUrl }))).rejects.toThrow('主会话已删除');
  });

  it('父会话删除与另一数据库连接的开始操作并发时不会留下新旁问', async () => {
    const name = `side-test-${crypto.randomUUID()}`;
    const store = new SideQuestionStore(new Database(name));
    const concurrent = new SideQuestionStore(new Database(name));
    await Promise.all([store.all(), concurrent.all()]);
    const [deleted] = await Promise.allSettled([store.deleteParent('parent-chat'), concurrent.begin(input())]);
    expect(deleted.status).toBe('fulfilled');
    expect(await concurrent.list('parent-chat')).toEqual([]);
    await expect(concurrent.begin(input())).rejects.toThrow('主会话已删除');
  });

  it.each([
    { name: '共享子会话的引用均在子树内时清理整棵子树', external: false },
    { name: '子树外的引用保护对应会话及其共享后代', external: true },
  ])('$name', async ({ external }) => {
    const store = new SideQuestionStore(new Database(`side-test-${crypto.randomUUID()}`));
    const url = (id: string) => 'https://chat.deepseek.com/a/chat/s/' + id;
    const link = async (id: string, parentId: string, childUrl: string) => {
      const requestId = 'ask-' + id;
      await store.begin(input({ id, requestId, parentId, parentUrl: url(parentId) }));
      await store.checkpoint(id, requestId, { phase: 'prepared' });
      await store.checkpoint(id, requestId, { phase: 'sending' });
      await store.checkpoint(id, requestId, {
        phase: 'awaiting', url: childUrl, userMessageId: '1', assistantMessageId: '2',
      });
    };
    await link('root-left', 'root-chat', url('left-chat'));
    await link('root-right', 'root-chat', url('right-chat'));
    await link('left-shared', 'left-chat', url('shared-chat'));
    await link('right-shared', 'right-chat', url('shared-chat'));
    await link('shared-leaf', 'shared-chat', url('leaf-chat'));
    if (external) {
      await link('external-left', 'external-chat', 'https://chat.deepseek.com/chat/left-chat/');
      await link('left-root', 'left-chat', url('root-chat'));
    }

    const deleted = await store.deleteParent('root-chat');
    expect(deleted.threads.map(thread => thread.id).sort()).toEqual(external
      ? ['right-shared', 'root-left', 'root-right']
      : ['left-shared', 'right-shared', 'root-left', 'root-right', 'shared-leaf']);
    expect(deleted.nativeConversationIds).toEqual(external
      ? ['right-chat']
      : ['left-chat', 'right-chat', 'shared-chat', 'leaf-chat']);
    expect((await store.all()).map(thread => thread.id)).toEqual(external
      ? ['external-left', 'left-root', 'left-shared', 'shared-leaf']
      : []);
    expect(await store.isParentDeleted('root-chat')).toBe(true);
    expect(await store.isParentDeleted('shared-chat')).toBe(!external);
    expect(await store.isParentDeleted('leaf-chat')).toBe(!external);
  });

  it('外部归属冲突时只移除被删父会话自己的记录', async () => {
    const store = new SideQuestionStore(new Database(`side-test-${crypto.randomUUID()}`));
    await store.begin(input());
    await advance(store, 'awaiting');
    await store.begin(input({
      id: 'other-thread', requestId: 'ask-other', parentId: 'other-chat',
      parentUrl: 'https://chat.deepseek.com/a/chat/s/other-chat',
    }));
    await store.checkpoint('other-thread', 'ask-other', { phase: 'prepared' });
    await store.checkpoint('other-thread', 'ask-other', { phase: 'sending' });
    await store.checkpoint('other-thread', 'ask-other', {
      phase: 'awaiting', url: 'https://chat.deepseek.com/chat/native-side-chat/', userMessageId: '1', assistantMessageId: '2',
    });
    await store.begin(input({ id: 'shared-nested', requestId: 'ask-shared', parentId: 'native-side-chat', parentUrl: nativeUrl }));

    const deleted = await store.deleteParent('parent-chat');
    expect(deleted.threads.map(thread => thread.id)).toEqual(['side-thread']);
    expect(deleted.nativeConversationIds).toEqual([]);
    expect((await store.list('native-side-chat')).map(thread => thread.id)).toEqual(['shared-nested']);
    expect((await store.list('other-chat')).map(thread => thread.id)).toEqual(['other-thread']);
  });
});
