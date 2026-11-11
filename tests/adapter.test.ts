// @vitest-environment jsdom
import { beforeEach,describe,expect,it } from 'vitest';
import { domToMarkdown,domToText,SiteAdapter } from '../src/content/adapter';
beforeEach(()=>{document.body.innerHTML='';});
describe('observed DeepSeek markup',()=>{
  it('extracts current official user bubbles and final answers, excluding thinking and controls',()=>{
    document.body.innerHTML=`<div data-virtual-list-item-key="1"><div class="ds-message d29f3d7d"><div class="fbb737a4">用户正文<button>展开</button></div></div></div><div data-virtual-list-item-key="2"><div class="ds-think-content"><div class="ds-markdown">不应保存的思考</div></div><div class="ds-assistant-message-main-content ds-markdown"><p>最终回答</p><button>复制</button></div></div>`;
    const nodes=new SiteAdapter().messages();expect(nodes.map(n=>n.message.role)).toEqual(['user','assistant']);
    expect(nodes.map(n=>n.message.text)).toEqual(['用户正文','最终回答']);
  });
  it('fails closed when stable IDs are missing instead of guessing roles or indexes',()=>{
    document.body.innerHTML='<div class="ds-message d29f3d7d"><div class="fbb737a4">没有 ID</div></div><div class="ds-assistant-message-main-content">也没有 ID</div>';
    expect(new SiteAdapter().messages()).toHaveLength(0);
  });
  it('does not mutate the native composer subtree while inserting',()=>{
    const el=document.createElement('textarea');el.className='ds-textarea__textarea';el.placeholder='给 DeepSeek 发送消息';document.body.append(el);
    el.getBoundingClientRect=()=>({width:600} as DOMRect);el.value='前后';el.setSelectionRange(1,1);
    let changes=0;el.addEventListener('input',()=>changes++);
    expect(new SiteAdapter().insertText('新增')).toBe(true);expect(el.value).toBe('前新增后');expect(changes).toBe(1);
  });
});
describe('Markdown conversion',()=>{
  it('keeps paragraph breaks in searchable text without duplicating KaTeX rendering',()=>{
    const el=document.createElement('div');el.innerHTML='<p>第一段</p><p>第二段 <span class="katex"><span>渲染文字</span><annotation encoding="application/x-tex">x^2</annotation></span></p>';
    const text=domToText(el);expect(text).toMatch(/第一段\n+第二段/);expect(text).toContain('x^2');expect(text).not.toContain('渲染文字');
  });
  it('preserves code fences, math source, headings and safe links',()=>{
    const el=document.createElement('div');el.innerHTML='<h2>标题</h2><pre><code class="language-js">const s = "```";</code></pre><span class="katex"><span>x</span><annotation encoding="application/x-tex">x^2</annotation></span><a href="https://example.org/a">来源</a><a href="javascript:alert(1)">危险链接</a>';
    const result=domToMarkdown(el);expect(result).toContain('## 标题');expect(result).toContain('````js');expect(result).toContain('$x^2$');expect(result).toContain('[来源](https://example.org/a)');expect(result).not.toContain('javascript:');
  });
  it('escapes literal markdown and produces a table',()=>{
    const el=document.createElement('div');el.innerHTML='<p>*文字*</p><table><tr><th>列 A</th><th>列 B</th></tr><tr><td>1|2</td><td>3</td></tr></table>';
    expect(domToMarkdown(el)).toContain('\\*文字\\*');expect(domToMarkdown(el)).toContain('| --- | --- |');expect(domToMarkdown(el)).toContain('1\\|2');
  });
});
