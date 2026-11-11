import { conversationId, fingerprint, normalizeSettings, type Backup, type Bookmark, type ChatMessage, type Conversation, type Draft, type PromptTemplate } from './model';
import { readSideQuestionThread } from '../sidequestions/model';
import type { ConversationLink, Project, ProjectConversation } from './projects';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据对象无效');
  return value as Record<string, unknown>;
}
function str(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('文字字段无效或过长');
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('时间字段无效');
  return value;
}
function array<T>(value: unknown, limit: number, read: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('列表无效或超过容量限制');
  return value.map(read);
}
export function readId(v: unknown): string {
  const s = str(v, 180); if (!/^[\w:-]+$/.test(s)) throw new Error('记录 ID 无效'); return s;
}
function safeUrl(v: unknown): string {
  const url = str(v, 512); if (!conversationId(url)) throw new Error('仅接受 DeepSeek 对话链接');
  const u = new URL(url); return u.origin + u.pathname;
}
export function readConversationLink(value: unknown): ConversationLink {
  const v = object(value), url = safeUrl(v.url), id = readId(v.id);
  if (conversationId(url) !== id) throw new Error('会话 ID 与链接不匹配');
  return { id, url, title: str(v.title, 512).trim() };
}
export function readProjectName(value: unknown): string {
  return str(value, 80).trim();
}
function readProject(value: unknown): Project {
  const v = object(value);
  return { id: readId(v.id), name: readProjectName(v.name), createdAt: time(v.createdAt) };
}
function readProjectConversation(value: unknown): ProjectConversation {
  const v = object(value);
  return {
    ...readConversationLink(v), projectId: v.projectId === null ? null : readId(v.projectId),
    pinned: v.pinned === true, joinedAt: time(v.joinedAt),
  };
}
export function readMessage(value: unknown): ChatMessage {
  const v = object(value), text = str(v.text, 1_000_000, true);
  if (v.role !== 'user' && v.role !== 'assistant') throw new Error('消息角色无效');
  return { id: readId(v.id), role: v.role, text, markdown: str(v.markdown, 1_500_000, true), fingerprint: fingerprint(text) };
}
export function readConversation(value: unknown): Conversation {
  const v = object(value), url = safeUrl(v.url), id = readId(v.id);
  if (conversationId(url) !== id) throw new Error('会话 ID 与链接不匹配');
  return {
    id, url, title: str(v.title, 512), messages: array(v.messages, 10_000, readMessage),
    capturedAt: time(v.capturedAt), scope: 'observed', pinned: v.pinned === true,
    folder: str(v.folder ?? '', 80, true), tags: array(v.tags ?? [], 20, x => str(x, 40)),
  };
}
export function readBookmark(value: unknown): Bookmark {
  const v = object(value), url = safeUrl(v.url), conversation = readId(v.conversationId);
  if (conversationId(url) !== conversation) throw new Error('收藏来源无效');
  return {
    id: readId(v.id), conversationId: conversation, url, title: str(v.title, 512),
    messageId: readId(v.messageId), fingerprint: str(v.fingerprint, 32),
    text: str(v.text, 1_000_000), note: str(v.note ?? '', 10_000, true), createdAt: time(v.createdAt),
  };
}
export function readPrompt(value: unknown): PromptTemplate {
  const v = object(value); return { id: readId(v.id), title: str(v.title, 100), body: str(v.body, 50_000) };
}
export function readDraft(value: unknown): Draft {
  const v = object(value); return { id: readId(v.id), text: str(v.text, 100_000, true), updatedAt: time(v.updatedAt) };
}
export function readBackup(value: unknown): Backup {
  const v = object(value);
  if (v.format !== 'ds-margin' || (v.version !== 1 && v.version !== 2 && v.version !== 3 && v.version !== 4)) throw new Error('不支持的备份格式或版本');
  const projects = v.version === 4 ? array(v.projects, 5000, readProject) : undefined;
  const projectConversations = v.version === 4 ? array(v.projectConversations, 20000, readProjectConversation) : undefined;
  if (projects && projectConversations) {
    const ids = new Set(projects.map(project => project.id));
    if (ids.size !== projects.length || new Set(projectConversations.map(row => row.id)).size !== projectConversations.length)
      throw new Error('项目备份包含重复记录');
    if (projectConversations.some(row => row.projectId !== null && !ids.has(row.projectId)))
      throw new Error('项目备份的会话归属无效');
  }
  return {
    format: 'ds-margin', version: v.version, exportedAt: time(v.exportedAt), settings: normalizeSettings(v.settings),
    conversations: array(v.conversations, 5000, readConversation),
    bookmarks: array(v.bookmarks, 20_000, readBookmark), prompts: array(v.prompts, 1000, readPrompt),
    drafts: array(v.drafts, 5000, readDraft), blocked: array(v.blocked, 5000, x => ({ id: readId(object(x).id) })),
    ...(v.version >= 3 ? { sideQuestions: array(v.sideQuestions ?? [], 5000, readSideQuestionThread) } : {}),
    ...(projects && projectConversations ? { projects, projectConversations } : {}),
  };
}
