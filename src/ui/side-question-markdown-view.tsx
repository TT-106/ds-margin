import type { ComponentChildren } from 'preact';
import type { Token } from 'marked';
import type { SideQuestionToken } from './side-question-markdown';

type FormulaToken = Extract<SideQuestionToken, { type: 'sideQuestionFormula' }>;
type RenderFormula = (token: FormulaToken, key: number) => ComponentChildren;
const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* Leave invalid or relative destinations as plain text. */ }
}

export function renderSideQuestionMarkdown(tokens: Token[], formula: RenderFormula): ComponentChildren {
  const children = (nested: Token[]) => renderSideQuestionMarkdown(nested, formula);
  return tokens.map((value, key) => {
    const token = value as SideQuestionToken;
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'text': return token.tokens ? children(token.tokens) : token.text;
      case 'escape': return token.text;
      case 'html': return token.raw;
      case 'paragraph': return <p key={key}>{children(token.tokens)}</p>;
      case 'heading': {
        const Heading = headings[token.depth - 1];
        return <Heading key={key}>{children(token.tokens)}</Heading>;
      }
      case 'strong': return <strong key={key}>{children(token.tokens)}</strong>;
      case 'em': return <em key={key}>{children(token.tokens)}</em>;
      case 'del': return <del key={key}>{children(token.tokens)}</del>;
      case 'br': return <br key={key}/>;
      case 'hr': return <hr key={key}/>;
      case 'code': return <pre key={key}><code>{token.text}</code></pre>;
      case 'codespan': return <code key={key}>{token.text}</code>;
      case 'blockquote': return <blockquote key={key}>{children(token.tokens)}</blockquote>;
      case 'list': {
        const List = token.ordered ? 'ol' : 'ul';
        return <List key={key} start={typeof token.start === 'number' ? token.start : undefined}>
          {token.items.map((item, index) => <li key={index}>{children(item.tokens)}</li>)}
        </List>;
      }
      case 'table': return <div key={key} class="sq-table-scroll"><table>
        <thead><tr>{token.header.map((cell, index) => <th key={index} scope="col">{children(cell.tokens)}</th>)}</tr></thead>
        <tbody>{token.rows.map((row, index) => <tr key={index}>
          {row.map((cell, column) => <td key={column}>{children(cell.tokens)}</td>)}
        </tr>)}</tbody>
      </table></div>;
      case 'link': {
        const href = safeHref(token.href);
        const label = children(token.tokens);
        return href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : label;
      }
      case 'image': return token.text || token.raw;
      case 'sideQuestionFormula': return formula(token, key);
      default: return value.raw;
    }
  });
}
