import { Marked, type MarkedToken, type Token } from 'marked';

const delimiters: Record<string, string> = { '\\(': '\\)', '\\[': '\\]', '$': '$', '$$': '$$' };
const inlineBoundary = /\\[[(]|\$\$|\$|(?<![a-zA-Z\u0370-\u03ff\d_])[a-zA-Z\u0370-\u03ff][_^]\{[0-9a-zA-Z\u0370-\u03ff+−=, -]{1,16}\}/;
const inlineStart = new RegExp(`^(?:${inlineBoundary.source})`);
const displayStart = /^ {0,3}(\\\[|\$\$)/;

interface FormulaToken {
  type: 'sideQuestionFormula';
  raw: string;
  source: string;
  display: boolean;
}

export type SideQuestionToken = MarkedToken | FormulaToken;

function findClosing(text: string, start: number, closer: string) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (closer === '$' && (char === '\n' || char === '\r' || text.startsWith('$$', index))) return -1;
    if (depth === 0 && text.startsWith(closer, index)) {
      if (closer === '$' && (/\s/.test(text[index - 1]) || /\d/.test(text[index + 1] ?? ''))) return -1;
      return index;
    }
    if (char === '\\') index++;
    else if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
  }
  return -1;
}

function tokenizeFormula(src: string, marker: string): FormulaToken | undefined {
  const closer = delimiters[marker];
  if (marker === '$' && /\s/.test(src[1] ?? '')) return;
  const display = marker === '\\[' || marker === '$$';
  if (!closer) return { type: 'sideQuestionFormula', raw: marker, source: marker, display };
  const end = findClosing(src, marker.length, closer);
  if (end < 0) {
    if (marker !== '$') return { type: 'sideQuestionFormula', raw: src, source: '', display };
    return;
  }
  return {
    type: 'sideQuestionFormula',
    raw: src.slice(0, end + closer.length),
    source: src.slice(marker.length, end).trim(),
    display,
  };
}

const markdown = new Marked({
  extensions: [{
    name: 'sideQuestionFormulaBlock',
    level: 'block',
    start(src) {
      const nextLine = /\n(?= {0,3}(?:\\\[|\$\$))/.exec(src);
      if (nextLine) return nextLine.index + 1;
    },
    tokenizer(src) {
      const match = displayStart.exec(src);
      if (!match) return;
      const indent = match[0].length - match[1].length;
      const formula = tokenizeFormula(src.slice(indent), match[1]);
      if (!formula) return;
      const raw = src.slice(0, indent) + formula.raw;
      const followingLine = /^[ \t]*(?:\n|$)/.exec(src.slice(raw.length));
      if (followingLine) return { ...formula, raw: raw + followingLine[0] };
    },
  }, {
    name: 'sideQuestionFormula',
    level: 'inline',
    start(src) {
      return inlineBoundary.exec(src)?.index;
    },
    tokenizer(src, tokens) {
      const marker = inlineStart.exec(src)?.[0];
      if (!marker) return;
      if (!delimiters[marker] && /[a-zA-Z\u0370-\u03ff\d_]$/.test(tokens.at(-1)?.raw ?? '')) return;
      return tokenizeFormula(src, marker);
    },
  }],
});

export function lexSideQuestionMarkdown(text: string): Token[] {
  return markdown.lexer(text);
}
