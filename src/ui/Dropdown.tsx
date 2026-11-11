import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { viewportBounds, watchAnchor, watchOutsideInteraction } from './floating';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

export function Dropdown<T extends string>({
  label, value, options, onChange, disabled = false,
}: {
  label: string;
  value: T;
  options: readonly DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const typed = useRef({ text: '', at: 0 });
  const selected = options.findIndex(option => option.value === value);
  const active = Math.min(index, options.length - 1);
  const expanded = open && !disabled && options.length > 0;

  const show = (fallback = 0) => {
    typed.current = { text: '', at: 0 };
    setIndex(selected < 0 ? fallback : selected);
    setOpen(true);
  };
  const choose = (next: number) => {
    const option = options[next];
    if (option && !disabled) onChange(option.value);
    setOpen(false);
  };
  useLayoutEffect(() => {
    const anchor = button.current, list = menu.current;
    if (!expanded || !anchor || !list) return;
    list.showPopover();
    const stop = watchAnchor(anchor, () => {
      const bounds = viewportBounds(), rect = anchor.getBoundingClientRect();
      const width = Math.min(Math.max(144, rect.width), bounds.right - bounds.left - 16);
      const below = bounds.bottom - rect.bottom - 14;
      const above = rect.top - bounds.top - 14;
      const preferBelow = below >= Math.min(list.scrollHeight, 272) || below >= above;
      const left = Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - width - 8));
      list.style.left = `${left}px`;
      list.style.width = `${width}px`;
      list.style.maxHeight = `${Math.max(32, Math.min(272, preferBelow ? below : above))}px`;
      list.style.top = preferBelow ? `${rect.bottom + 6}px` : 'auto';
      list.style.bottom = preferBelow ? 'auto' : `${innerHeight - rect.top + 6}px`;
    });
    const visibility = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setOpen(false);
    });
    visibility.observe(anchor);
    const stopDismissal = watchOutsideInteraction(list, (_event, path) => path.includes(anchor), () => setOpen(false));
    return () => {
      stop();
      stopDismissal();
      visibility.disconnect();
      if (list.matches(':popover-open')) list.hidePopover();
    };
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded) return;
    menu.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active]);

  return <>
    <button ref={button} type="button" class="dropdown-trigger" role="combobox"
      aria-label={label} aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={expanded ? id : undefined} aria-activedescendant={expanded && active >= 0 ? `${id}-${active}` : undefined}
      disabled={disabled || !options.length}
      onClick={() => expanded ? setOpen(false) : show()}
      onKeyDown={event => {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        const { key } = event;
        if (key === 'Tab') { setOpen(false); return; }
        if (key === 'Escape') {
          if (!expanded) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        } else if (key === 'Enter' || key === ' ') {
          event.preventDefault();
          if (expanded) choose(active);
          else show();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
          event.preventDefault();
          if (!expanded) show(key === 'ArrowUp' || key === 'End' ? options.length - 1 : 0);
          else if (key === 'Home') setIndex(0);
          else if (key === 'End') setIndex(options.length - 1);
          else setIndex(Math.max(0, Math.min(options.length - 1, active + (key === 'ArrowDown' ? 1 : -1))));
        } else if (key.length === 1) {
          const now = Date.now();
          const text = (now - typed.current.at < 600 ? typed.current.text + key : key).toLocaleLowerCase();
          const match = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text));
          if (match < 0) return;
          event.preventDefault();
          if (!expanded) show();
          typed.current = { text, at: now };
          setIndex(match);
        }
      }}>
      <span>{options[selected]?.label ?? label}</span><Icon name="chevronDown" size={15}/>
    </button>
    {expanded && <div ref={menu} id={id} role="listbox" aria-label={label} class="dropdown-menu" popover="manual">
      {options.map((option, i) => <div key={option.value} id={`${id}-${i}`} class="dropdown-option" role="option"
        aria-selected={option.value === value} data-active={i === active ? '' : undefined}
        onPointerMove={() => setIndex(i)} onMouseDown={event => event.preventDefault()} onClick={() => choose(i)}>
        <span>{option.label}</span>
        {option.value === value && <Icon name="check" size={14}/>}
      </div>)}
    </div>}
  </>;
}
