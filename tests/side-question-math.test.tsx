// @vitest-environment jsdom
import { renderToString } from 'katex';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFormulaRenderer, type FormulaRenderer } from '../src/ui/side-question-katex-loader';
import { lexSideQuestionMarkdown } from '../src/ui/side-question-markdown';
import { loadSideQuestionMarkdown } from '../src/ui/side-question-markdown-loader';

vi.mock('../src/ui/side-question-katex-loader', () => ({ loadFormulaRenderer: vi.fn() }));
vi.mock('../src/ui/side-question-markdown-loader', () => ({ loadSideQuestionMarkdown: vi.fn() }));

let SideQuestionAnswer: typeof import('../src/ui/side-question-math').SideQuestionAnswer;
const roots = new Set<HTMLElement>();

beforeEach(async () => {
  vi.resetModules();
  vi.mocked(loadFormulaRenderer).mockReset().mockResolvedValue(renderToString);
  vi.mocked(loadSideQuestionMarkdown).mockReset().mockResolvedValue(lexSideQuestionMarkdown);
  ({ SideQuestionAnswer } = await import('../src/ui/side-question-math'));
});

afterEach(() => {
  act(() => {
    for (const root of roots) render(null, root);
  });
  roots.clear();
});

async function mount(text: string, root = document.createElement('div')) {
  roots.add(root);
  await act(async () => { render(<SideQuestionAnswer text={text}/>, root); });
  await act(async () => {});
  return root;
}

describe('旁问公式', () => {
  it('将行内和独立公式渲染为 MathML，也兼容旧记录的裸上下标', async () => {
    const root = await mount(String.raw`旧记录 g_{00}，正文 \(x^2\)，另有 $y^3$。
\[\frac{1}{2}

+1\]

$$\sqrt{3}$$`);
    expect(root.querySelectorAll('math')).toHaveLength(5);
    expect(root.querySelectorAll('math[display="block"]')).toHaveLength(2);
    expect(root.querySelector('math msub')).toBeTruthy();
    expect(root.querySelector('math[display="block"] mfrac')).toBeTruthy();
    expect(root.querySelector('math[display="block"] msqrt')).toBeTruthy();
    expect(root.querySelector('math mfrac')?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML');
  });

  it('保留流式输出中未闭合的公式，闭合后即排版', async () => {
    const text = String.raw`已出 \(x^2\)，还在 \[\frac{1}{`;
    const root = await mount(text);
    const first = root.querySelector('math');
    expect(root.querySelectorAll('math')).toHaveLength(1);
    expect(root.textContent).toContain(String.raw`\[\frac{1}{`);
    await mount(text + String.raw`2}\]`, root);
    expect(root.querySelectorAll('math')).toHaveLength(2);
    expect(root.querySelector('math')).toBe(first);
    expect(root.querySelector('math[display="block"] annotation')?.textContent).toBe(String.raw`\frac{1}{2}`);
  });

  it('保留金额、代码和不支持的表达式，禁止公式创建链接', async () => {
    const code = '`g_{12}`';
    const root = await mount(String.raw`价格 $5 和 $10，代码 ${code}。可算 $x^2$，错误 \(\notACommand{x}\)。
链接 \(\href{https://example.com}{x}\)`);
    expect(root.textContent).toContain('$5 和 $10');
    expect(root.querySelector('code')?.textContent).toBe('g_{12}');
    expect(root.textContent).toContain(String.raw`\(\notACommand{x}\)`);
    expect(root.querySelectorAll('math msup')).toHaveLength(1);
    expect(root.querySelector('a, [href]')).toBeNull();
  });

  it('普通文本、未闭合公式和超长公式不启动加载', async () => {
    const root = await mount('先读文字，金额 $12。');
    expect(root.textContent).toBe('先读文字，金额 $12。');
    const oversized = '\\(' + 'x'.repeat(4001) + '\\)';
    await mount(oversized, root);
    expect(root.textContent).toBe(oversized);
    await mount(String.raw`正在输出 \[\frac{1}{`, root);
    expect(root.textContent).toContain(String.raw`\[\frac{1}{`);
    expect(loadFormulaRenderer).not.toHaveBeenCalled();
    await mount(String.raw`正在输出 \[\frac{1}{2}\]`, root);
    expect(loadFormulaRenderer).toHaveBeenCalledTimes(1);
    expect(root.querySelector('math mfrac')).toBeTruthy();
  });

  it('等待加载时公式原文可读，多个回答共用一次加载', async () => {
    let finish!: (renderer: FormulaRenderer) => void;
    vi.mocked(loadFormulaRenderer).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = await mount(String.raw`一个公式 \(x^2\)`);
    const second = await mount(String.raw`另一个公式 \[\sqrt{3}\]`);
    expect(first.textContent).toContain(String.raw`\(x^2\)`);
    expect(second.textContent).toContain(String.raw`\[\sqrt{3}\]`);
    expect(loadFormulaRenderer).toHaveBeenCalledTimes(1);
    await act(async () => { finish(renderToString); });
    expect(first.querySelector('math msup')).toBeTruthy();
    expect(second.querySelector('math msqrt')).toBeTruthy();
  });

  it('加载失败时保留原文，下一个完整公式可重试并排版已有公式', async () => {
    vi.mocked(loadFormulaRenderer).mockRejectedValueOnce(new Error('读取扩展资源失败'));
    const text = String.raw`一个公式 \(x^2\)`;
    const root = await mount(text);
    expect(root.textContent).toContain(String.raw`\(x^2\)`);
    expect(root.querySelector('math')).toBeNull();
    await mount(text + String.raw`，再来 \[\sqrt{3}\]`, root);
    expect(loadFormulaRenderer).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll('math')).toHaveLength(2);
  });

  it('使用同一回答渲染标题、粗体、列表、引用、表格与安全链接', async () => {
    const root = await mount([
      '### 结果', '',
      '**第一性原理** 与 *反证*', '',
      '3. 原理', '4. 例子', '   - 子项', '',
      '> 注意', '',
      '[说明](https://example.com/guide)', '',
      '| 名称 | 说明 |', '| --- | --- |', '| 甲 | **测试** |',
    ].join('\n'));
    expect(root.querySelector('h3')?.textContent).toBe('结果');
    expect(root.querySelector('strong')?.textContent).toBe('第一性原理');
    expect(root.querySelector('em')?.textContent).toBe('反证');
    expect(root.querySelector('ol')?.start).toBe(3);
    expect(root.querySelectorAll('ol > li')).toHaveLength(2);
    expect(root.querySelector('ul > li')?.textContent).toBe('子项');
    expect(root.querySelector('blockquote')?.textContent).toBe('注意');
    expect(root.querySelector('a')?.href).toBe('https://example.com/guide');
    expect(root.querySelector('tbody td strong')?.textContent).toBe('测试');
  });

  it('Markdown 资源到位前展示原文，原生 HTML 和危险链接只呈现文字', async () => {
    let finish!: (lexer: typeof lexSideQuestionMarkdown) => void;
    vi.mocked(loadSideQuestionMarkdown).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const text = [
      '**可见** [坏链接](javascript:alert%281%29) [编码](jav&#x61;script:alert%281%29)',
      '![远程图片](https://example.com/pixel) <img src="https://example.com/other">', '',
      '<iframe src="https://example.com/frame"></iframe>',
    ].join('\n');
    const root = await mount(text);
    expect(root.textContent).toContain('**可见**');
    await act(async () => { finish(lexSideQuestionMarkdown); });
    expect(root.querySelector('strong')?.textContent).toBe('可见');
    expect(root.querySelector('a, img, iframe')).toBeNull();
    expect(root.textContent).toContain('坏链接');
    expect(root.textContent).toContain('远程图片');
  });

  it('保留代码中的公式原文，在列表和强调内排版真正的公式', async () => {
    const fenced = ['~~~tex', String.raw`\(z^2\)`, '~~~'].join('\n');
    const root = await mount(fenced);
    expect(root.querySelector('pre code')?.textContent).toContain(String.raw`\(z^2\)`);
    expect(loadFormulaRenderer).not.toHaveBeenCalled();
    await mount(fenced + '\n\n' + String.raw`1. **公式 \(x^2\)**`, root);
    expect(root.querySelector('ol li strong math msup')).toBeTruthy();
    expect(loadFormulaRenderer).toHaveBeenCalledTimes(1);
  });
});
