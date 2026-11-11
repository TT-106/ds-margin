import type { lexSideQuestionMarkdown } from './side-question-markdown';

type MarkdownLexer = typeof lexSideQuestionMarkdown;
let pending: Promise<MarkdownLexer> | undefined;

export async function loadSideQuestionMarkdown(): Promise<MarkdownLexer> {
  pending ??= import(/* @vite-ignore */ chrome.runtime.getURL('side-question-markdown.js'))
    .then((module: { lexSideQuestionMarkdown?: MarkdownLexer }) => {
      if (typeof module.lexSideQuestionMarkdown !== 'function') throw new Error('扩展 Markdown 资源缺少词法解析函数');
      return module.lexSideQuestionMarkdown;
    }).catch(error => {
      pending = undefined;
      throw error;
    });
  return pending;
}
