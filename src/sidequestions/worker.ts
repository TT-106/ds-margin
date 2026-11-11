import { conversationId } from '../shared/model';
import { rpc } from '../shared/rpc';
import type { SideQuestionWorkerJob } from './execution';
import { sideQuestionMarker } from './marker';
import { observeNativeAnswer } from './native-answer';
import { SideQuestionWeb, watchChatChanges, type SideQuestionControl, type SideQuestionRequest } from './web';

export function claimSideQuestionWorker(): Promise<SideQuestionWorkerJob | null> {
  return rpc('side.worker.claim', { sessionId: crypto.randomUUID() });
}

function promptFor(job: SideQuestionWorkerJob) {
  const source = job.nativeUrl ? '' : [
    '请解释所选文字。所在段落仅供参考。',
    `所选文字：\n${job.quote}`,
    ...(job.context && job.context !== job.quote ? [`所在段落：\n${job.context}`] : []),
  ].join('\n\n') + '\n\n';
  return `${source}${job.question}\n\n${sideQuestionMarker(job.turnId)}`;
}

async function ready(web: SideQuestionWeb, control: SideQuestionControl, job: SideQuestionWorkerJob): Promise<void> {
  const waiting = job.checkpoint.phase === 'sending' || job.checkpoint.phase === 'awaiting';
  const end = Math.min(job.deadline, Date.now() + 30_000);
  const expected = conversationId(job.checkpoint.url ?? job.nativeUrl ?? job.checkpoint.candidateUrl ?? '');
  const changes = watchChatChanges(control.signal);
  try {
    while (Date.now() < end) {
      await control.guard();
      if (/^\/(?:sign[_-]?in|log[_-]?in|auth)(?:\/|$)/i.test(location.pathname))
        throw new Error('请先登录 DeepSeek，再重新发起旁问');
      const error = web.controls.error();
      if (error) throw new Error(error.message);
      const id = web.adapter.id();
      if (web.adapter.composer() && (!expected || id === expected)) {
        if (waiting) return;
        // The native send button waits for session history in the site store.
        // A minimized window may have no rendered history rows.
        if (web.controls.generation() === 'idle') return;
      }
      await changes.wait(400);
    }
  } finally {
    changes.close();
  }
  throw new Error(expected ? '未能加载旁问的原站会话' : 'DeepSeek 聊天控件未就绪，请检查登录或网络状态');
}

export async function runSideQuestionWorker(job: SideQuestionWorkerJob): Promise<void> {
  const web = new SideQuestionWeb();
  const abort = new AbortController();
  const { threadId, turnId, sessionId } = job;
  const scope = { threadId, turnId, sessionId };
  let checkpoint: SideQuestionRequest['checkpoint'] = {
    phase: job.checkpoint.phase === 'queued' ? 'prepared' : job.checkpoint.phase,
    startedAt: Date.now(),
    url: job.checkpoint.url,
    userMessageId: job.checkpoint.userMessageId,
    assistantMessageId: job.checkpoint.assistantMessageId,
  };
  let leaving = false;
  let ownClickNext = false;
  let keepTab = false;
  let humanError = '';
  let candidate = job.checkpoint.candidateUrl;
  let preview = '';
  const stream = job.checkpoint.phase === 'queued' || job.checkpoint.phase === 'prepared'
    ? observeNativeAnswer(turnId, job.nativeUrl) : undefined;
  const pageHide = () => { leaving = true; abort.abort(); };
  const humanInput = (event: Event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!event.isTrusted || (event.target !== web.adapter.composer() && !web.controls.interruptsExecution(event.target) &&
      (!link || !conversationId(link.href)))) return;
    keepTab = true;
    humanError = '检测到对旁问标签页的手动操作，已停止自动发送或读取';
    abort.abort();
  };
  window.addEventListener('pagehide', pageHide, { once: true });
  document.addEventListener('pointerdown', humanInput, true);
  document.addEventListener('input', humanInput, true);
  document.addEventListener('keydown', humanInput, true);
  const control: SideQuestionControl = {
    signal: abort.signal,
    nativeAnswer: stream?.answer,
    guard: async () => {
      if (abort.signal.aborted) throw new DOMException('旁问执行已停止', 'AbortError');
      const requireInactive = checkpoint.phase === 'prepared' || ownClickNext;
      if (!await rpc<boolean>('side.worker.guard', { ...scope, requireInactive }))
        throw new DOMException('旁问执行已失效', 'AbortError');
      if (abort.signal.aborted) throw new DOMException('旁问执行已停止', 'AbortError');
      if (checkpoint.phase === 'sending' && !ownClickNext && !job.nativeUrl && !candidate && web.adapter.id()) {
        const url = location.origin + location.pathname;
        if (await rpc<boolean>('side.worker.candidate', { ...scope, url })) candidate = url;
      }
      ownClickNext = false;
    },
    checkpoint: async (data, firstPreview) => {
      const visible = firstPreview?.slice(0, 24_000);
      const updated = await rpc<SideQuestionWorkerJob['checkpoint'] | null>('side.worker.checkpoint', {
        ...scope, ...data, ...(visible?.trim() && visible !== preview ? { preview: visible } : {}),
      });
      if (!updated || updated.phase === 'queued') throw new DOMException('旁问执行已失效', 'AbortError');
      if (visible?.trim()) preview = visible;
      checkpoint = {
        phase: updated.phase,
        url: updated.url,
        userMessageId: updated.userMessageId,
        assistantMessageId: updated.assistantMessageId,
        startedAt: data.phase === 'sending' ? Date.now() : checkpoint.startedAt,
      };
      ownClickNext = data.phase === 'sending';
      return checkpoint;
    },
    progress: (text: string) => {
      const visible = text.slice(0, 24_000);
      if (visible === preview) return;
      preview = visible;
      void rpc('side.worker.progress', { ...scope, text: visible }).catch(() => {});
    },
  };
  try {
    await ready(web, control, job);
    if (job.checkpoint.phase === 'queued') await control.checkpoint({ phase: 'prepared' });
    const result = await web.run({
      prompt: promptFor(job), search: job.search === true, turnId, checkpoint, deadline: job.deadline,
      existingConversationId: conversationId(job.nativeUrl ?? '') ?? undefined,
    }, control);
    await control.guard();
    await rpc('side.worker.complete', { ...scope, answer: result.text });
  } catch (error) {
    if (!leaving) {
      const reason = humanError || (error instanceof Error ? error.message : '旁问执行失败');
      await rpc('side.worker.fail', { ...scope, error: reason.slice(0, 500), keepTab }).catch(() => {});
    }
  } finally {
    stream?.close();
    window.removeEventListener('pagehide', pageHide);
    document.removeEventListener('pointerdown', humanInput, true);
    document.removeEventListener('input', humanInput, true);
    document.removeEventListener('keydown', humanInput, true);
  }
}
