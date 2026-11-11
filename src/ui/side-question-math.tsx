import { memo } from 'preact/compat';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { loadFormulaRenderer, type FormulaRenderer } from './side-question-katex-loader';
import { loadSideQuestionMarkdown } from './side-question-markdown-loader';
import { renderSideQuestionMarkdown } from './side-question-markdown-view';
import type { lexSideQuestionMarkdown } from './side-question-markdown';

const maxFormulaLength = 4000;
let loadedMarkdown: typeof lexSideQuestionMarkdown | undefined;
let loadedRenderer: FormulaRenderer | undefined;
let loadingRenderer: Promise<void> | undefined;
const rendererListeners = new Set<(renderer: FormulaRenderer) => void>();

function requestRenderer() {
  if (loadingRenderer) return;
  loadingRenderer = loadFormulaRenderer().then(renderer => {
    loadedRenderer = renderer;
    for (const notify of rendererListeners) notify(renderer);
    rendererListeners.clear();
  }).catch(() => {
    // Keep the raw formula visible. A newly mounted answer or formula can retry.
  }).finally(() => {
    loadingRenderer = undefined;
  });
}

const Formula = memo(function Formula({ source, raw, display, renderer }: {
  source: string; raw: string; display: boolean; renderer?: FormulaRenderer;
}) {
  try {
    if (renderer) {
      const markup = renderer(source, {
        output: 'mathml', displayMode: display, trust: false, maxSize: 32, maxExpand: 500, strict: 'ignore',
      });
      return <span class={display ? 'sq-math-display' : 'sq-math-inline'} dangerouslySetInnerHTML={{ __html: markup }}/>;
    }
  } catch { /* Incomplete or unsupported TeX remains readable and selectable. */ }
  return <span class="sq-math-raw">{raw}</span>;
});

export const SideQuestionAnswer = memo(function SideQuestionAnswer({ text }: { text: string }) {
  const [renderer, setRenderer] = useState(() => loadedRenderer);
  const [lexer, setLexer] = useState(() => loadedMarkdown);
  const hasText = Boolean(text.trim());

  useEffect(() => {
    if (!hasText || lexer) return;
    let active = true;
    void loadSideQuestionMarkdown().then(ready => {
      loadedMarkdown = ready;
      if (active) setLexer(() => ready);
    }, () => { /* Keep readable text if the extension resource fails to load. */ });
    return () => { active = false; };
  }, [hasText, lexer]);

  const tokens = useMemo(() => {
    try { return lexer?.(text); } catch { /* Preserve the source on a malformed input. */ }
  }, [lexer, text]);
  let formulaCount = 0;
  const content = tokens && renderSideQuestionMarkdown(tokens, ({ source, raw, display }, key) => {
    if (!source || source.length > maxFormulaLength) return <span key={key} class="sq-math-raw">{raw}</span>;
    formulaCount++;
    return <Formula key={key} source={source} raw={raw} display={display} renderer={renderer}/>;
  });

  useEffect(() => {
    if (!formulaCount || renderer) return;
    const onReady = (ready: FormulaRenderer) => setRenderer(() => ready);
    if (loadedRenderer) {
      onReady(loadedRenderer);
      return;
    }
    rendererListeners.add(onReady);
    requestRenderer();
    return () => { rendererListeners.delete(onReady); };
  }, [formulaCount, renderer]);

  return <>{content ?? (hasText && text.trim().split(/\r?\n(?:[ \t]*\r?\n)+/).map((part, key) => <p key={key}>{part}</p>))}</>;
});
