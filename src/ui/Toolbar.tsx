import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Controller } from '../content/controller';
import type { Panel } from './Command';
import { Icon } from './icons';

export const TITLES: Record<Panel, string> = {
  outline: '目录',
  library: '书库',
  prompts: '提示词',
  bookmarks: '收藏',
  settings: '设置',
  command: '命令',
};

const PRIMARY = [
  ['outline', 'outline'],
  ['library', 'shelf'],
] as const;
const SECONDARY = [
  ['command', 'command'],
  ['prompts', 'prompt'],
  ['bookmarks', 'star'],
] as const;

export function Toolbar({
  c,
  panel,
  suspended,
  onOpen,
}: {
  c: Controller;
  panel: Panel | null;
  suspended: boolean;
  onOpen: (panel: Panel, trigger: HTMLElement) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [panel, suspended, c.state.active]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (nav.current && !event.composedPath().includes(nav.current)) setExpanded(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
    };
  }, [expanded]);

  const show = (name: Panel, from: HTMLElement) => {
    setExpanded(false);
    onOpen(name, from);
  };
  const title = (name: Panel) => {
    if (c.state.settings.shortcuts && name === 'outline') return '目录 · Alt+O';
    if (c.state.settings.shortcuts && name === 'command') return '命令 · Alt+K';
    return TITLES[name];
  };
  const menuItem = (name: Panel, icon: string) => (
    <button
      type="button"
      key={name}
      title={title(name)}
      class={panel === name ? 'selected' : ''}
      aria-label={TITLES[name]}
      aria-expanded={panel === name}
      onClick={() => trigger.current && show(name, trigger.current)}
    >
      <Icon name={icon} size={20} />
      <span>{TITLES[name]}</span>
      {name === 'command' && c.state.settings.shortcuts && <kbd>Alt+K</kbd>}
    </button>
  );

  return (
    <nav
      ref={nav}
      class={`rail ${suspended ? 'rail-suspended' : ''}`}
      aria-label="DS Margin 工具栏"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        trigger.current?.focus();
      }}
    >
      <div class="rail-primary">
        {PRIMARY.map(([name, icon]) => (
          <button
            key={name}
            type="button"
            class={`rail-item ${panel === name ? 'selected' : ''}`}
            aria-label={TITLES[name]}
            title={title(name)}
            aria-expanded={panel === name}
            onClick={(event) => show(name, event.currentTarget)}
          >
            <Icon name={icon} size={20} />
            <span>{TITLES[name]}</span>
          </button>
        ))}
      </div>
      <button
        ref={trigger}
        type="button"
        class="rail-item rail-toggle"
        aria-label="更多工具"
        aria-expanded={expanded}
        aria-controls={expanded ? 'ds-margin-tools' : undefined}
        title={c.state.settings.shortcuts ? '更多工具 · Alt+K 打开命令' : '更多工具'}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (!expanded) setExpanded(true);
          requestAnimationFrame(() => {
            const buttons = Array.from(menu.current?.querySelectorAll('button') ?? []);
            buttons.find((button) => button.getClientRects().length)?.focus();
          });
        }}
      >
        <Icon name="more" size={20} />
        <span class="rail-more-label">更多</span>
        <span class="rail-compact-label">工具</span>
      </button>
      {expanded && (
        <div class="rail-menu" id="ds-margin-tools" role="group" aria-label="更多工具" ref={menu}>
          <div class="rail-compact-tools">{PRIMARY.map(([name, icon]) => menuItem(name, icon))}</div>
          {SECONDARY.map(([name, icon]) => menuItem(name, icon))}
          <button
            type="button"
            class={c.state.focus ? 'selected' : ''}
            aria-label="专注模式"
            aria-pressed={c.state.focus}
            onClick={() => {
              c.toggleFocus();
              setExpanded(false);
              trigger.current?.focus();
            }}
          >
            <Icon name="focus" size={20} />
            <span>{c.state.focus ? '退出专注' : '专注模式'}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        class={`rail-item rail-profile ${panel === 'settings' ? 'selected' : ''}`}
        aria-label="设置"
        aria-describedby="dsm-profile-tip"
        aria-expanded={panel === 'settings'}
        data-generating={c.state.nativeGenerating ? '' : undefined}
        onClick={event => show('settings', event.currentTarget)}
      >
        <i aria-hidden="true">m.</i>
        <span class="rail-tooltip" id="dsm-profile-tip" role="tooltip">
          {c.state.nativeGenerating ? '生成中 · 阅读设置' : '阅读设置'}
        </span>
      </button>
    </nav>
  );
}
