import type { Conversation } from './model';
export function toMarkdown(c: Conversation): string {
  return `# ${c.title.replace(/[\r\n]+/g, ' ')}\n\n` +
    `> 来源：${c.url}\n> 范围：本地已观察到的消息，可能包含先后访问过的不同回答分支；不代表完整历史。\n> 采集时间：${new Date(c.capturedAt).toISOString()}\n\n` +
    c.messages.map((m, index) => `## ${index + 1}. ${m.role === 'user' ? '我' : 'DeepSeek'}\n\n${m.markdown}\n`).join('\n---\n\n');
}
export function download(name: string, body: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 140);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch {
    const previous = document.activeElement;
    const el = document.createElement('textarea');
    el.value = text; el.style.cssText = 'position:fixed;left:-9999px'; document.body.append(el);
    el.select(); const ok = document.execCommand('copy'); el.remove();
    if (previous instanceof HTMLElement) previous.focus();
    if (!ok) throw new Error('浏览器拒绝复制，请手动选择文字复制');
  }
}
