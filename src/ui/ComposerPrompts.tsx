import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Controller } from '../content/controller';
import { currentSlash, readSlash, replaceSlash, type SlashInvocation } from '../content/composer-slash';
import { variables, type PromptTemplate } from '../shared/model';
import { Icon } from './icons';
import { PromptForm } from './PromptForm';
import { viewportBounds, watchAnchor, watchOutsideInteraction } from './floating';

export function ComposerPrompts({ c, suspended }: { c: Controller; suspended: boolean }) {
  const [invocation, setInvocation] = useState<SlashInvocation | null>(null);
  const [chosen, setChosen] = useState<PromptTemplate | null>(null);
  const [index, setIndex] = useState(0);
  const popup = useRef<HTMLElement>(null);
  const composingEditor = useRef<HTMLElement | null>(null);
  const applying = useRef(false);
  const enabled = !suspended && c.state.active;
  const editor = invocation?.editor;
  const { prompts, promptsReady } = c.state;
  const rows = useMemo(() => {
    if (!invocation) return [];
    const terms = invocation.query.trim().toLocaleLowerCase().split(/\s+/);
    return prompts.filter(prompt => {
      const text = `${prompt.title} ${prompt.id.startsWith('builtin-') ? prompt.id.slice(8) : ''}`.toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
  }, [invocation, prompts]);
  const active = Math.min(index, rows.length - 1);

  const close = (restoreFocus = false) => {
    setInvocation(null);
    setChosen(null);
    if (restoreFocus && invocation && currentSlash(c.adapter, invocation))
      invocation.editor.focus({ preventScroll: true });
  };
  const fill = (text: string) => {
    let filled = false;
    if (invocation && enabled && c.state.active) {
      applying.current = true;
      try {
        filled = replaceSlash(c.adapter, invocation, text);
      } finally {
        applying.current = false;
      }
    }
    close();
    c.notify(filled ? '已填入输入框，请检查后发送' : '无法填入当前输入框，请重新选择提示词', !filled);
  };
  const choose = (prompt: PromptTemplate) => {
    if (variables(prompt.body).length) setChosen(prompt);
    else fill(prompt.body);
  };

  useLayoutEffect(() => {
    if (!enabled) { setInvocation(null); setChosen(null); return; }
    const refresh = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || target !== c.adapter.composer() || !c.state.active) return;
      setInvocation(readSlash(c.adapter, target));
      setChosen(null);
      setIndex(0);
    };
    const input = (event: Event) => {
      if (applying.current) return;
      const target = event.target;
      if (target === composingEditor.current || (event instanceof InputEvent && event.isComposing)) return;
      if (!event.isTrusted || (event instanceof InputEvent && /^(insertFromPaste|insertFromDrop|history)/.test(event.inputType))) {
        if (target === c.adapter.composer()) { setInvocation(null); setChosen(null); }
        return;
      }
      refresh(target);
    };
    const start = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target === c.adapter.composer())
        composingEditor.current = event.target;
    };
    const end = (event: Event) => {
      if (event.target !== composingEditor.current) return;
      composingEditor.current = null;
      if (event.isTrusted) refresh(event.target);
    };
    document.addEventListener('input', input, true);
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    return () => {
      composingEditor.current = null;
      document.removeEventListener('input', input, true);
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
    };
  }, [c, enabled]);

  useLayoutEffect(() => {
    if (invocation && !currentSlash(c.adapter, invocation)) close();
  });
  useLayoutEffect(() => {
    if (!enabled || !editor || !popup.current) return;
    const layer = popup.current;
    const anchor = editor.closest<HTMLElement>('[data-dsm-composer-box]') ?? editor;
    const stop = watchAnchor(anchor, () => {
      const bounds = viewportBounds(), rect = anchor.getBoundingClientRect();
      const width = Math.min(456, rect.width, bounds.right - bounds.left - 16);
      const left = Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - width - 8));
      const above = Math.min(rect.top, bounds.bottom) - bounds.top - 16;
      const below = bounds.bottom - Math.max(rect.bottom, bounds.top) - 16;
      const placeBelow = above < 132 && below > above;
      const overlap = Math.max(above, below) < 108;
      layer.style.left = `${left}px`;
      layer.style.width = `${width}px`;
      layer.style.maxHeight = `${Math.min(470, overlap ? bounds.bottom - bounds.top - 16 : placeBelow ? below : above)}px`;
      layer.style.top = placeBelow && !overlap ? `${Math.max(rect.bottom, bounds.top) + 8}px` : 'auto';
      layer.style.bottom = placeBelow && !overlap ? 'auto' : `${innerHeight - (overlap ? bounds.bottom : Math.min(rect.top, bounds.bottom)) + 8}px`;
    });
    const stopDismissal = watchOutsideInteraction(layer, (event, path) => event.type === 'focusin' && path.includes(editor), () => {
      setInvocation(null);
      setChosen(null);
    });
    return () => {
      stop();
      stopDismissal();
    };
  }, [editor, enabled]);

  useLayoutEffect(() => {
    if (!enabled || !invocation || chosen) return;
    popup.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== editor || event.isComposing || composingEditor.current === editor || event.keyCode === 229) return;
      if (event.key === 'Tab' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        close();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      if (!rows.length && event.key !== 'Escape' && (promptsReady || event.key !== 'Enter')) {
        if (event.key === 'Enter') close();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!c.state.active || !currentSlash(c.adapter, invocation)) { close(); return; }
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter') { if (rows[active]) choose(rows[active]); }
      else if (rows.length) setIndex((active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    };
    // Handle choice before the native page and draft tracker can treat Enter as Send.
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [enabled, invocation, editor, chosen, rows, active, promptsReady]);

  if (!enabled || !invocation) return null;
  return <section class="composer-popup" ref={popup} aria-label={chosen ? chosen.title : '输入栏提示词'}
    role={chosen ? 'dialog' : 'region'} onKeyDown={event => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    }}>
    <header class="composer-popup-head">
      <Icon name="prompt" size={18}/>
      <span>提示词</span>
      <button type="button" class="icon-button" aria-label="关闭输入栏提示词" onClick={() => close(true)}><Icon name="close" size={16}/></button>
    </header>
    {chosen ? <div class="composer-prompt-details">
      <h3>{chosen.title}</h3>
      <PromptForm key={chosen.id} prompt={chosen} onFill={fill} compact/>
    </div> : <>
      <div class="sr-only" role="status">{rows[active] ? `${rows[active].title}，${active + 1}/${rows.length}` :
        promptsReady ? '没有匹配的提示词' : '正在读取自定义提示词…'}</div>
      <div class="composer-prompt-list" role="listbox" aria-label="可用提示词">
        {rows.map((prompt, i) => {
          const keys = variables(prompt.body);
          return <button key={prompt.id} type="button" role="option" tabIndex={-1} aria-selected={i === active}
            class="composer-prompt-option" onPointerMove={() => setIndex(i)}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(prompt)}>
            <span>{prompt.title}</span>
            {keys.length > 0 && <small>{keys.join('、')}</small>}
          </button>;
        })}
        {!rows.length && <p class="composer-prompt-empty">{promptsReady ? '没有匹配的提示词' : '正在读取自定义提示词…'}</p>}
      </div>
      <footer class="composer-popup-footer">{rows.length ? '继续输入以筛选 · ↑↓ 选择 · Enter 确认' : '继续输入以筛选 · Esc 关闭'}</footer>
    </>}
  </section>;
}
