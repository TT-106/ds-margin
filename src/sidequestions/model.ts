import { conversationId } from '../shared/model';
import { readId } from '../shared/validation';
import { plainObject, textField } from '../shared/validation-primitives';

export interface SideQuestionAnchor {
  messageId: string;
  fingerprint: string;
  quote: string;
  start: number;
  end: number;
  context?: string;
}

export type SideQuestionPhase = 'queued' | 'prepared' | 'sending' | 'awaiting';
export type SideQuestionStatus = 'pending' | 'complete' | 'attention' | 'failed';

export interface SideQuestionCheckpoint {
  phase: SideQuestionPhase;
  url?: string;
  candidateUrl?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  workerTabId?: number;
  workerSessionId?: string;
}

export interface SideQuestionTurn {
  id: string;
  question: string;
  search?: boolean;
  automatic?: boolean;
  answer?: string;
  status: SideQuestionStatus;
  checkpoint: SideQuestionCheckpoint;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SideQuestionThread {
  id: string;
  parentId: string;
  parentUrl: string;
  parentTitle: string;
  anchor: SideQuestionAnchor;
  turns: SideQuestionTurn[];
  nativeUrl?: string;
  createdAt: number;
  updatedAt: number;
  preview?: { turnId: string; text: string };
}

export interface SideQuestionBegin {
  id?: string;
  requestId: string;
  parentId: string;
  parentUrl: string;
  parentTitle: string;
  anchor: SideQuestionAnchor;
  question: string;
  search?: boolean;
  automatic?: boolean;
}

export interface SideQuestionCounts {
  parents: Record<string, number>;
  nativeConversationIds: string[];
}

export const MAX_SIDE_QUESTION_TURNS = 100;

export function readSideQuestionUrl(value: unknown): string {
  const url = textField(value, 512);
  if (!conversationId(url)) throw new Error('仅接受 DeepSeek 原生对话链接');
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error('对话链接包含无效认证字段');
  return parsed.origin + parsed.pathname;
}

function integer(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`${label}无效`);
  return value;
}

function timestamp(value: unknown): number {
  return integer(value, Number.MAX_SAFE_INTEGER, '时间');
}

function readAnchor(raw: unknown): SideQuestionAnchor {
  const data = plainObject(raw);
  const start = integer(data.start, 1_000_000, '选区起点');
  const end = integer(data.end, 1_000_000, '选区终点');
  if (end <= start) throw new Error('选区为空');
  return {
    messageId: readId(data.messageId),
    fingerprint: textField(data.fingerprint, 32),
    quote: textField(data.quote, 6000),
    start,
    end,
    ...(data.context === undefined ? {} : { context: textField(data.context, 12_000, true) }),
  };
}

function readParent(data: Record<string, unknown>) {
  const parentId = readId(data.parentId);
  const parentUrl = readSideQuestionUrl(data.parentUrl);
  if (conversationId(parentUrl) !== parentId) throw new Error('主会话与链接不一致');
  return { parentId, parentUrl, parentTitle: textField(data.parentTitle, 512), anchor: readAnchor(data.anchor) };
}

export function readSideQuestionBegin(raw: unknown): SideQuestionBegin {
  const data = plainObject(raw);
  return {
    ...readParent(data),
    id: data.id === undefined ? undefined : readId(data.id),
    requestId: readId(data.requestId),
    question: textField(data.question, 12_000),
    ...(data.search === true ? { search: true } : {}),
    ...(data.automatic === true ? { automatic: true } : {}),
  };
}

export function readSideQuestionCheckpoint(raw: unknown): SideQuestionCheckpoint {
  const data = plainObject(raw);
  const phase = data.phase;
  if (phase !== 'queued' && phase !== 'prepared' && phase !== 'sending' && phase !== 'awaiting')
    throw new Error('旁问提交检查点无效');
  const checkpoint: SideQuestionCheckpoint = { phase };
  if (data.url !== undefined) checkpoint.url = readSideQuestionUrl(data.url);
  if (data.candidateUrl !== undefined) checkpoint.candidateUrl = readSideQuestionUrl(data.candidateUrl);
  if (data.userMessageId !== undefined) checkpoint.userMessageId = readId(data.userMessageId);
  if (data.assistantMessageId !== undefined) checkpoint.assistantMessageId = readId(data.assistantMessageId);
  if (data.workerTabId !== undefined) checkpoint.workerTabId = integer(data.workerTabId, Number.MAX_SAFE_INTEGER, '执行页编号');
  if (data.workerSessionId !== undefined) checkpoint.workerSessionId = readId(data.workerSessionId);
  return checkpoint;
}

function readTurn(raw: unknown): SideQuestionTurn {
  const data = plainObject(raw);
  const status = data.status;
  if (status !== 'pending' && status !== 'complete' && status !== 'attention' && status !== 'failed')
    throw new Error('旁问状态无效');
  const checkpoint = readSideQuestionCheckpoint(data.checkpoint);
  if (status === 'complete' && (checkpoint.phase !== 'awaiting' || !checkpoint.url || !checkpoint.userMessageId || !checkpoint.assistantMessageId))
    throw new Error('旁问回答缺少原生消息检查点');
  return {
    id: readId(data.id),
    question: textField(data.question, 12_000),
    ...(data.search === true ? { search: true } : {}),
    ...(data.automatic === true ? { automatic: true } : {}),
    status,
    checkpoint,
    answer: status === 'complete' ? textField(data.answer, 1_000_000) : undefined,
    error: data.error === undefined ? undefined : textField(data.error, 1000),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
  };
}

export function readSideQuestionThread(raw: unknown): SideQuestionThread {
  const data = plainObject(raw);
  const parent = readParent(data);
  if (!Array.isArray(data.turns) || data.turns.length < 1 || data.turns.length > MAX_SIDE_QUESTION_TURNS)
    throw new Error('旁问列表无效');
  const turns = data.turns.map(readTurn);
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length || turns.slice(0, -1).some((turn) => turn.status === 'pending'))
    throw new Error('旁问轮次无效');
  const nativeUrl = data.nativeUrl === undefined ? undefined : readSideQuestionUrl(data.nativeUrl);
  const nativeId = nativeUrl && conversationId(nativeUrl);
  if (nativeId === parent.parentId || turns.some(({ checkpoint }) => {
    const candidate = checkpoint.candidateUrl && conversationId(checkpoint.candidateUrl);
    return (checkpoint.url && conversationId(checkpoint.url) !== nativeId) ||
      (candidate && (candidate === parent.parentId || (nativeId && candidate !== nativeId)));
  }))
    throw new Error('旁问与原生对话关联无效');
  return {
    ...parent,
    id: readId(data.id),
    nativeUrl,
    turns,
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
  };
}
