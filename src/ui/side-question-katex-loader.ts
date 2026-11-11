export type FormulaRenderer = typeof import('katex').renderToString;

export async function loadFormulaRenderer(): Promise<FormulaRenderer> {
  const url = chrome.runtime.getURL('side-question-katex.js');
  const { renderToString } = await import(/* @vite-ignore */ url) as { renderToString?: FormulaRenderer };
  if (typeof renderToString !== 'function') throw new Error('扩展公式资源缺少渲染函数');
  return renderToString;
}
