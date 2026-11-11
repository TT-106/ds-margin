import type { SideQuestionThread } from '../sidequestions/model';
import type { Project, ProjectConversation } from './projects';
export interface Settings {
  enabled: boolean;
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  spacing: number;
  autoArchive: boolean;
  saveDrafts: boolean;
  shortcuts: boolean;
  reduceMotion: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  enabled: true, theme: 'system', fontSize: 16, lineHeight: 1.85,
  contentWidth: 840, spacing: 28, autoArchive: true, saveDrafts: true,
  shortcuts: true, reduceMotion: false,
};
export type Role = 'user' | 'assistant';
export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  markdown: string;
  fingerprint: string;
}
export interface Conversation {
  id: string;
  url: string;
  title: string;
  messages: ChatMessage[];
  capturedAt: number;
  scope: 'observed';
  pinned: boolean;
  folder: string;
  tags: string[];
}
export interface Bookmark {
  id: string;
  conversationId: string;
  url: string;
  title: string;
  messageId: string;
  fingerprint: string;
  text: string;
  note: string;
  createdAt: number;
}
export interface PromptTemplate { id: string; title: string; body: string; }
export interface Draft { id: string; text: string; updatedAt: number; }
export interface Backup {
  format: 'ds-margin'; version: 1|2|3|4; exportedAt: number;
  conversations: Conversation[]; bookmarks: Bookmark[];
  prompts: PromptTemplate[]; drafts: Draft[]; blocked: { id: string }[];
  settings: Settings;
  sideQuestions?: SideQuestionThread[];
  projects?: Project[];
  projectConversations?: ProjectConversation[];
}
export interface Library {
  conversations: Conversation[]; bookmarks: Bookmark[]; prompts: PromptTemplate[];
  blocked: { id: string }[];
}
export const LIBRARY_EPOCH_KEY = 'ds-margin:libraryEpoch';
export const PROMPTS_EPOCH_KEY = 'ds-margin:promptsEpoch';
export const BUILTIN_PROMPTS: PromptTemplate[] = [
  { id: 'builtin-explain', title: '解释一个概念', body: '请用中文解释「{{概念}}」。先给直观解释，再给具体例子，最后说明常见误解和适用边界。' },
  { id: 'builtin-summary', title: '总结长文', body: '请总结下面的内容，区分原文事实、作者观点与尚待核实的信息。输出核心观点、论据和待回答的问题。\n\n{{原文}}' },
  { id: 'builtin-polish', title: '润色文本', body: '请润色下面的文字，保留原意与语气，使表达清晰、自然、简洁。不要增加未经提供的事实。\n\n{{文本}}' },
  { id: 'builtin-translate', title: '中英翻译', body: '请将下面的内容翻译成{{目标语言}}，保留术语、公式和代码的含义。存在歧义时指出，不要自行补全事实。\n\n{{文本}}' },
  { id: 'builtin-code', title: '代码审查', body: '请审查以下代码，优先检查正确性和边界条件。对每项发现给出触发条件、影响和修复建议；不确定的地方明确标注。\n\n{{代码}}' },
  { id: 'builtin-task', title: '拆解任务', body: '请将「{{任务}}」拆解成可执行步骤，列出输入、交付物、依赖和验收条件。先指出会改变方案的关键未知信息。' },
  { id: 'builtin-compare', title: '对比方案', body: '请比较以下方案：\n{{方案}}\n\n围绕{{目标与约束}}，比较收益、成本、风险与失败条件，并给出有条件的建议。' },
  { id: 'builtin-challenge', title: '寻找论证漏洞', body: '请对下面的论证进行对抗性分析：区分前提、证据和推论，寻找反例、替代解释与不可证伪之处，并说明什么证据会改变结论。\n\n{{论证}}' },
];
const clamp = (x: unknown, min: number, max: number, fallback: number) =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
export function normalizeSettings(value: unknown): Settings {
  const s = value && typeof value === 'object' ? value as Partial<Settings> : {};
  return {
    enabled: s.enabled !== false,
    theme: s.theme === 'dark' || s.theme === 'light' ? s.theme : 'system',
    fontSize: clamp(s.fontSize, 14, 24, 16),
    lineHeight: clamp(s.lineHeight, 1.4, 2.2, 1.85),
    contentWidth: clamp(s.contentWidth, 640, 1200, 840),
    spacing: clamp(s.spacing, 16, 56, 28),
    autoArchive: s.autoArchive !== false, saveDrafts: s.saveDrafts !== false,
    shortcuts: s.shortcuts !== false, reduceMotion: s.reduceMotion === true,
  };
}
export function fingerprint(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
export function conversationId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://chat.deepseek.com') return null;
    return u.pathname.match(/^\/(?:a\/)?chat\/(?:s\/)?([A-Za-z0-9_-]{4,128})\/?$/)?.[1] ?? null;
  } catch { return null; }
}
export function variables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{([^{}\n]{1,40})\}\}/g)].map(x => x[1].trim()))];
}
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{([^{}\n]{1,40})\}\}/g, (original, key: string) => values[key.trim()] ?? original);
}
export function mergeSnapshot(old: Conversation | undefined, next: Conversation): Conversation {
  // A virtual list only exposes a moving window. Keep previously observed messages,
  // replacing a message only when its native stable ID is observed again.
  const messages = new Map((old?.messages ?? []).map(m => [m.id, m]));
  for (const m of next.messages) messages.set(m.id, m);
  const ordered = [...messages.values()];
  if (ordered.every(m => /^\d+$/.test(m.id))) ordered.sort((a, b) => Number(a.id) - Number(b.id));
  return { ...next, messages: ordered, pinned: old?.pinned ?? next.pinned, folder: old?.folder ?? next.folder, tags: old?.tags ?? next.tags };
}
export function searchLibrary(items: Conversation[], query: string): { conversation: Conversation; snippet: string }[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items.map(conversation => ({ conversation, snippet: `${conversation.messages.length} 条已观察消息` }));
  return items.flatMap(conversation => {
    const body = conversation.messages.map(m => m.text).join('\n');
    const haystack = [conversation.title, conversation.folder, ...conversation.tags, body].join('\n').toLocaleLowerCase();
    if (!terms.every(term => haystack.includes(term))) return [];
    const index = body.toLocaleLowerCase().indexOf(terms[0]);
    return [{ conversation, snippet: index >= 0 ? body.slice(Math.max(0, index - 35), index + 150) : body.slice(0, 160) }];
  });
}
