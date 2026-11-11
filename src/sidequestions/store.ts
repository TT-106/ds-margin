import { Database, type SideDeletedConversation } from '../background/database';
import { conversationId } from '../shared/model';
import { readId } from '../shared/validation';
import { plainObject, textField } from '../shared/validation-primitives';
import {
  MAX_SIDE_QUESTION_TURNS,
  readSideQuestionBegin,
  readSideQuestionCheckpoint,
  readSideQuestionUrl,
  type SideQuestionCounts,
  type SideQuestionPhase,
  type SideQuestionThread,
  type SideQuestionTurn,
} from './model';

const STORE = 'sideQuestions';
const DELETED = 'sideDeletedConversations';
const NEXT_PHASE: Record<SideQuestionPhase, SideQuestionPhase> = {
  queued: 'prepared',
  prepared: 'sending',
  sending: 'awaiting',
  awaiting: 'awaiting',
};
const stableReplacement = (previous: string | undefined, next: string) =>
  !previous || previous === next || (/^-\d+$/.test(previous) && /^[1-9]\d*$/.test(next));

export class SideQuestionStore {
  constructor(private db: Database, private now = () => Date.now()) {}

  all(): Promise<SideQuestionThread[]> {
    return this.db.all(STORE);
  }

  get(id: unknown): Promise<SideQuestionThread | undefined> {
    return this.db.get(STORE, readId(id));
  }

  async list(parentId: unknown): Promise<SideQuestionThread[]> {
    const threads = await this.db.byIndex<SideQuestionThread>(STORE, 'parentId', readId(parentId));
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteParent(parentId: unknown) {
    return this.db.deleteSideQuestionTree(readId(parentId));
  }

  isParentDeleted(parentId: string): Promise<boolean> {
    return this.db.get(DELETED, parentId).then(Boolean);
  }

  async counts(parentIds?: unknown): Promise<SideQuestionCounts> {
    if (parentIds !== undefined && (!Array.isArray(parentIds) || parentIds.length > 5000))
      throw new Error('主会话列表无效');
    const selected = parentIds === undefined ? undefined : new Set(parentIds.map(readId));
    const [parentKeys, nativeKeys, deleted] = await Promise.all([
      this.db.indexKeys(STORE, 'parentId'),
      this.db.indexKeys(STORE, 'nativeUrl', true),
      this.db.all<SideDeletedConversation>(DELETED),
    ]);
    const parents: Record<string, number> = Object.create(null);
    for (const id of parentKeys) {
      if (typeof id === 'string' && (!selected || selected.has(id))) parents[id] = (parents[id] ?? 0) + 1;
    }
    const nativeConversationIds = new Set(nativeKeys.flatMap((url) => {
      const id = typeof url === 'string' ? conversationId(url) : null;
      return id ? [id] : [];
    }));
    for (const { id, hidden } of deleted) if (hidden) nativeConversationIds.add(id);
    return { parents, nativeConversationIds: [...nativeConversationIds] };
  }

  async begin(raw: unknown): Promise<{ thread: SideQuestionThread; turn: SideQuestionTurn; created: boolean }> {
    const input = readSideQuestionBegin(raw);
    const id = input.id ?? input.requestId;
    return this.db.update<SideQuestionThread, { thread: SideQuestionThread; turn: SideQuestionTurn; created: boolean }>(STORE, id, (current) => {
      if (current && current.parentId !== input.parentId) throw new Error('旁问不属于当前主会话');
      const prior = current?.turns.find((turn) => turn.id === input.requestId);
      if (current && prior) {
        if (prior.question !== input.question || Boolean(prior.search) !== Boolean(input.search))
          throw new Error('请求编号已用于另一条旁问');
        return { result: { thread: current, turn: prior, created: false } };
      }
      const latest = current?.turns.at(-1);
      if (latest?.status === 'pending') throw new Error('上一条旁问还在生成，请等待回答');
      if (latest?.status === 'attention') throw new Error('上一条旁问可能已经发送，请先在原生对话中核对');
      if (current && current.turns.length >= MAX_SIDE_QUESTION_TURNS) throw new Error('此旁问已达到轮次上限，请另开旁问');
      const now = this.now();
      const turn: SideQuestionTurn = {
        id: input.requestId,
        question: input.question,
        ...(input.search ? { search: true } : {}),
        ...(input.automatic ? { automatic: true } : {}),
        status: 'pending',
        checkpoint: { phase: 'queued' },
        createdAt: now,
        updatedAt: now,
      };
      const thread: SideQuestionThread = current ?? {
        id,
        parentId: input.parentId,
        parentUrl: input.parentUrl,
        parentTitle: input.parentTitle,
        anchor: input.anchor,
        turns: [],
        createdAt: now,
        updatedAt: now,
      };
      thread.turns.push(turn);
      thread.parentTitle = input.parentTitle;
      thread.updatedAt = now;
      return { put: thread, result: { thread, turn, created: true } };
    }, { store: DELETED, id: input.parentId, message: '主会话已删除' });
  }

  checkpoint(id: unknown, turnId: unknown, patch: unknown, expectedSessionId?: string, verifiedPair = false): Promise<SideQuestionThread> {
    const fields = Object.fromEntries(Object.entries(plainObject(patch)).filter(([, value]) => value !== undefined));
    return this.updateTurn(id, turnId, expectedSessionId, false, (thread, turn) => {
      const previous = turn.checkpoint;
      const next = readSideQuestionCheckpoint({ ...previous, ...fields });
      if (next.phase !== previous.phase && next.phase !== NEXT_PHASE[previous.phase]) throw new Error('旁问提交状态已变更');
      if (previous.workerTabId !== undefined && next.workerTabId !== previous.workerTabId)
        throw new Error('旁问执行标签页已变更');
      const canRebind = verifiedPair && expectedSessionId && previous.phase === 'awaiting' && next.phase === 'awaiting' &&
        previous.url && previous.url === next.url && next.userMessageId && next.assistantMessageId &&
        stableReplacement(previous.userMessageId, next.userMessageId) &&
        stableReplacement(previous.assistantMessageId, next.assistantMessageId);
      if (!canRebind && ((previous.userMessageId && next.userMessageId !== previous.userMessageId) ||
        (previous.assistantMessageId && next.assistantMessageId !== previous.assistantMessageId)))
        throw new Error('旁问已关联不同原生消息');
      if (next.candidateUrl && (conversationId(next.candidateUrl) === thread.parentId ||
        (thread.nativeUrl && conversationId(thread.nativeUrl) !== conversationId(next.candidateUrl))))
        throw new Error('旁问候选地址与执行会话不一致');
      if (next.phase === 'awaiting' && (!next.url || !next.userMessageId)) throw new Error('未能定位已发送的旁问');
      if (next.url) {
        const nativeId = conversationId(next.url);
        if (nativeId === thread.parentId || (thread.nativeUrl && conversationId(thread.nativeUrl) !== nativeId))
          throw new Error('旁问已关联不同原生对话');
        thread.nativeUrl = next.url;
      }
      turn.checkpoint = next;
    });
  }

  complete(id: unknown, turnId: unknown, answer: unknown, expectedSessionId?: string): Promise<SideQuestionThread> {
    return this.updateTurn(id, turnId, expectedSessionId, true, (_thread, turn) => {
      const checkpoint = turn.checkpoint;
      if (checkpoint.phase !== 'awaiting' || !checkpoint.url || !checkpoint.userMessageId || !checkpoint.assistantMessageId)
        throw new Error('未能确认旁问对应的原生回答');
      turn.answer = textField(answer, 1_000_000);
      turn.status = 'complete';
      this.release(turn);
    });
  }

  fail(id: unknown, turnId: unknown, error: unknown, expectedSessionId?: string, verifiedNotSent = false): Promise<SideQuestionThread> {
    return this.updateTurn(id, turnId, expectedSessionId, true, (_thread, turn) => {
      turn.error = textField(error, 1000);
      turn.status = turn.checkpoint.phase === 'awaiting' || (turn.checkpoint.phase === 'sending' && !verifiedNotSent) ? 'attention' : 'failed';
      this.release(turn);
    });
  }

  async recover(raw: unknown): Promise<boolean> {
    const data = plainObject(raw);
    const turnId = readId(data.turnId);
    const url = readSideQuestionUrl(data.url);
    const nativeId = conversationId(url);
    const userMessageId = readId(data.userMessageId);
    const assistantMessageId = readId(data.assistantMessageId);
    const answer = textField(data.answer, 120_000);
    if (userMessageId === assistantMessageId) return false;
    const matches = (await this.all()).filter(thread => thread.turns.at(-1)?.id === turnId);
    if (matches.length !== 1) return false;
    return this.db.update<SideQuestionThread, boolean>(STORE, matches[0].id, thread => {
      const turn = thread?.turns.at(-1);
      if (!thread || !turn || turn.id !== turnId || turn.status !== 'attention' || thread.parentId === nativeId)
        return { result: false };
      const knownUrl = thread.nativeUrl ?? turn.checkpoint.url ?? turn.checkpoint.candidateUrl;
      if ((knownUrl && conversationId(knownUrl) !== nativeId) ||
        !stableReplacement(turn.checkpoint.userMessageId, userMessageId) ||
        !stableReplacement(turn.checkpoint.assistantMessageId, assistantMessageId)) return { result: false };
      thread.nativeUrl = url;
      turn.checkpoint = { phase: 'awaiting', url, userMessageId, assistantMessageId };
      turn.answer = answer;
      turn.status = 'complete';
      delete turn.error;
      thread.updatedAt = turn.updatedAt = this.now();
      return { put: thread, result: true };
    });
  }

  private release(turn: SideQuestionTurn) {
    delete turn.checkpoint.workerSessionId;
    delete turn.checkpoint.workerTabId;
  }

  private updateTurn(
    id: unknown,
    turnId: unknown,
    expectedSessionId: string | undefined,
    terminalIsNoop: boolean,
    mutate: (thread: SideQuestionThread, turn: SideQuestionTurn) => void,
  ): Promise<SideQuestionThread> {
    const requestId = readId(turnId);
    return this.db.update<SideQuestionThread, SideQuestionThread>(STORE, readId(id), (thread) => {
      const turn = thread?.turns.find((item) => item.id === requestId);
      if (!thread || !turn) throw new Error('旁问不存在');
      if (terminalIsNoop && turn.status !== 'pending') return { result: thread };
      if (turn.status !== 'pending' || thread.turns.at(-1) !== turn) throw new Error('旁问已结束或轮次已变更');
      if (expectedSessionId !== undefined && turn.checkpoint.workerSessionId !== expectedSessionId)
        throw new Error('旁问执行页面已变更');
      mutate(thread, turn);
      turn.updatedAt = thread.updatedAt = this.now();
      return { put: thread, result: thread };
    });
  }
}
