import { copyText } from '../shared/export';
import { SITE_SELECTORS, shapeProseQuotes, type MessageNode, type SiteLayout } from './adapter';

function owned<K extends keyof HTMLElementTagNameMap>(tag: K, name: string) {
  const el = document.createElement(tag);
  el.setAttribute('data-dsm-owned', '');
  el.setAttribute(`data-dsm-${name}`, '');
  return el;
}

const normalizedTitle = (text: string | null | undefined) =>
  (text ?? '').normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');

export class ReadingChrome {
  private layout?: SiteLayout;
  private observed?: IntersectionObserver;
  private heading?: HTMLElement;
  private title?: HTMLElement;
  private resize?: ResizeObserver;
  private geometryFrame = 0;
  private topButton?: HTMLButtonElement;
  private fade?: HTMLDivElement;
  private nativeBottom?: HTMLElement;
  private shortBlocks = new Map<HTMLElement, HTMLButtonElement>();

  update(layout: SiteLayout | undefined, nodes: MessageNode[]) {
    const previous = this.layout;
    this.layout = layout;
    if (layout?.scroll !== previous?.scroll || layout?.column !== previous?.column || layout?.composerBox !== previous?.composerBox) {
      previous?.scroll?.removeEventListener('scroll', this.scheduleGeometry);
      this.resize?.disconnect();
      if (layout) {
        layout.scroll?.addEventListener('scroll', this.scheduleGeometry, { passive: true });
        this.resize = new ResizeObserver(this.scheduleGeometry);
        for (const el of [layout.scroll, layout.column, layout.composerBox]) if (el) this.resize.observe(el);
      }
    }
    this.updateTitle(nodes);
    this.updateProse(nodes);
    this.scheduleGeometry();
  }

  private updateTitle(nodes: MessageNode[]) {
    const header = this.layout?.header;
    const heading = nodes.find(n => n.message.role === 'assistant' && n.element.querySelector('h1'))?.element.querySelector<HTMLElement>('h1') ?? undefined;
    const text = normalizedTitle(heading?.textContent);
    const title = header && text ? (
      [...header.querySelectorAll<HTMLElement>(`${SITE_SELECTORS.headerTitle},span,div,h1,h2`)]
        .find(el => !el.childElementCount && !el.closest('button,a,[role="button"]') && normalizedTitle(el.textContent) === text)
        ?? (!header.childElementCount && normalizedTitle(header.textContent) === text ? header : undefined)
    ) : undefined;
    if (this.heading === heading && this.title === title) return;
    this.observed?.disconnect();
    this.title?.removeAttribute('data-dsm-title');
    this.heading = heading;
    this.title = title;
    if (!heading || !title) return;
    title.dataset.dsmTitle = 'visible';
    this.observed = new IntersectionObserver(([entry]) => {
      if (this.title === title) title.dataset.dsmTitle = entry.isIntersecting && entry.intersectionRatio > 0 ? 'duplicate' : 'visible';
    }, { root: this.layout?.scroll ?? null });
    this.observed.observe(heading);
  }

  private updateProse(nodes: MessageNode[]) {
    const found = new Set<HTMLElement>();
    for (const { element, message } of nodes) {
      if (message.role !== 'assistant') continue;
      shapeProseQuotes(element);
      for (const pre of element.querySelectorAll<HTMLPreElement>('pre')) {
        const block = pre.closest<HTMLElement>(SITE_SELECTORS.codeBlock) ?? pre;
        const language = block.querySelector(SITE_SELECTORS.codeLabel)?.textContent?.trim().toLowerCase();
        const text = (pre.querySelector('code') ?? pre).textContent ?? '';
        if (!(pre.matches('.language-text') || pre.querySelector('.language-text') || language === 'text')
          || !text.trim() || text.trimEnd().split(/\r?\n/).length > 3) continue;
        found.add(block);
        if (this.shortBlocks.has(block)) continue;
        const button = owned('button', 'short-copy');
        button.type = 'button';
        button.textContent = '复制';
        button.setAttribute('aria-label', '复制文本片段');
        button.addEventListener('click', () => {
          const native = block.querySelector<HTMLElement>('.ds-markdown-code-copy-button,[data-native-copy]');
          if (native) {
            native.click();
            button.textContent = '已复制';
          } else {
            void copyText((pre.querySelector('code') ?? pre).textContent ?? '')
              .then(() => { button.textContent = '已复制'; }, () => { button.textContent = '复制失败'; });
          }
        });
        block.dataset.dsmShortText = '';
        // A bare <pre> cannot contain the button: native code readers need its exact text.
        if (block === pre) pre.before(button);
        else block.append(button);
        this.shortBlocks.set(block, button);
      }
    }
    for (const [block, button] of this.shortBlocks) {
      if (!found.has(block)) {
        block.removeAttribute('data-dsm-short-text');
        button.remove();
        this.shortBlocks.delete(block);
      }
    }
  }

  private scheduleGeometry = () => {
    if (!this.geometryFrame) this.geometryFrame = requestAnimationFrame(this.updateGeometry);
  };

  private updateGeometry = () => {
    this.geometryFrame = 0;
    const layout = this.layout;
    if (!layout?.scroll || !layout.scrollShell || !layout.scroll.isConnected || !layout.composerBox.isConnected) {
      this.clearGeometry();
      return;
    }
    const { scroll, composerBox, scrollShell, fixedComposer, nativeBottom } = layout;
    const html = document.documentElement;
    const view = scroll.getBoundingClientRect();
    const editor = composerBox.getBoundingClientRect();
    const set = (name: string, number: number) => {
      const value = `${Math.round(number * 10) / 10}px`;
      if (html.style.getPropertyValue(name) !== value) html.style.setProperty(name, value);
    };
    set('--dsm-composer-h', Math.max(0, innerHeight - editor.top));
    if (fixedComposer) set('--dsm-fixed-start', scrollShell.getBoundingClientRect().left);
    if (editor.width < 36 || view.height < 32) { this.clearGeometry(false); return; }
    const distance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
    set('--dsm-composer-mid', editor.left + editor.width / 2);
    const fits = editor.top - 52 >= view.bottom - 1;
    if (!this.topButton) {
      const button = owned('button', 'back-bottom');
      button.type = 'button';
      button.setAttribute('aria-label', '回到底部');
      button.title = '回到底部';
      button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v15m-6-6 6 6 6-6"/></svg>';
      button.addEventListener('click', () => {
        const source = this.nativeBottom;
        if (source?.isConnected) {
          const target = source.matches('button,[role="button"]') ? source : source.querySelector<HTMLElement>('button,[role="button"]');
          if (target) target.click();
          else this.scrollBottom();
        } else this.scrollBottom();
        if (document.activeElement === button) this.layout?.composerBox.querySelector<HTMLElement>('textarea,[contenteditable]')?.focus({ preventScroll: true });
      });
      document.documentElement.append(button);
      this.topButton = button;
    }
    this.topButton.toggleAttribute('data-visible', fits && distance > 160);
    this.topButton.tabIndex = fits && distance > 160 ? 0 : -1;
    const source = fits ? nativeBottom : undefined;
    if (source !== this.nativeBottom) {
      this.nativeBottom?.removeAttribute('data-dsm-bottom-source');
      this.nativeBottom = source;
      if (source) source.dataset.dsmBottomSource = '';
    }
    if (!this.fade) {
      this.fade = owned('div', 'reading-fade');
      this.fade.setAttribute('aria-hidden', 'true');
      document.documentElement.append(this.fade);
    }
    this.fade.toggleAttribute('data-visible', distance > 3);
    const height = Math.min(56, view.height / 3);
    this.fade.style.cssText = `left:${view.left}px;top:${view.bottom - height}px;width:${view.width}px;height:${height}px`;
  };

  private scrollBottom() {
    const scroll = this.layout?.scroll;
    if (!scroll) return;
    const reduced = document.documentElement.classList.contains('dsm-reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: reduced ? 'instant' : 'smooth' });
  }

  private clearGeometry(clearVariables = true) {
    this.topButton?.remove();
    this.topButton = undefined;
    this.fade?.remove();
    this.fade = undefined;
    this.nativeBottom?.removeAttribute('data-dsm-bottom-source');
    this.nativeBottom = undefined;
    if (clearVariables) {
      for (const name of ['--dsm-composer-h','--dsm-composer-mid','--dsm-fixed-start']) document.documentElement.style.removeProperty(name);
    }
  }

  stop() {
    this.layout?.scroll?.removeEventListener('scroll', this.scheduleGeometry);
    this.layout = undefined;
    this.resize?.disconnect();
    this.observed?.disconnect();
    this.title?.removeAttribute('data-dsm-title');
    this.heading = this.title = undefined;
    cancelAnimationFrame(this.geometryFrame);
    this.geometryFrame = 0;
    this.clearGeometry();
    this.updateProse([]);
  }
}
