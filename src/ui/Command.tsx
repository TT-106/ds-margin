import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Controller } from '../content/controller';
import { download, toMarkdown } from '../shared/export';
import { searchLibrary, type Conversation } from '../shared/model';
import { Icon } from './icons';

export type Panel = 'outline' | 'library' | 'prompts' | 'bookmarks' | 'settings' | 'command';

interface Row {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  run: () => void;
}

export function Command({
  c,
  onPanel,
  onView,
  onClose,
}: {
  c: Controller;
  onPanel: (name: Panel) => void;
  onView: (item: Conversation) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const actions: Row[] = [
    { id: 'library', label: '书库', icon: 'shelf', run: () => onPanel('library') },
    {
      id: 'outline',
      label: '目录',
      icon: 'outline',
      hint: c.state.settings.shortcuts ? 'Alt+O' : undefined,
      run: () => onPanel('outline'),
    },
    { id: 'prompts', label: '提示词', icon: 'prompt', run: () => onPanel('prompts') },
    { id: 'bookmarks', label: '收藏', icon: 'star', run: () => onPanel('bookmarks') },
    {
      id: 'export',
      label: '导出当前页 Markdown',
      icon: 'download',
      run: () => {
        const current = c.state.current;
        if (current) download(`${current.title}.md`, toMarkdown(current));
        else c.notify('当前没有对话正文');
        onClose();
      },
    },
    { id: 'settings', label: '设置', icon: 'settings', run: () => onPanel('settings') },
  ];
  const display: Row[] = [
    {
      id: 'focus',
      label: c.state.focus ? '退出专注模式' : '开启专注模式',
      icon: 'focus',
      run: () => {
        c.toggleFocus();
        onClose();
      },
    },
    {
      id: 'theme',
      label: '切换明暗主题',
      icon: 'sun',
      hint: { system: '跟随系统', light: '浅色', dark: '深色' }[c.state.settings.theme],
      run: () => {
        const theme = document.documentElement.dataset.dsmTheme === 'dark' ? 'light' : 'dark';
        void c.run(() => c.settings({ ...c.state.settings, theme }));
        onClose();
      },
    },
  ];
  const conversations = c.state.library.conversations;
  const chronological = useMemo(() => [...conversations].sort((a, b) => b.capturedAt - a.capturedAt), [conversations]);
  const matching = useMemo(() => searchLibrary(chronological, term).slice(0, term ? 6 : 3), [chronological, term]);
  const recent = matching
    .map(
      ({ conversation }): Row => ({
        id: `chat-${conversation.id}`,
        label: conversation.title,
        icon: 'book',
        run: () => onView(conversation),
      }),
    );
  const matches = (row: Row) => row.label.toLocaleLowerCase().includes(term);
  const groups = [
    { label: term ? '本地对话' : '最近对话', rows: recent },
    { label: '操作', rows: actions.filter(matches) },
    { label: '显示', rows: display.filter(matches) },
  ];
  const rows = groups.flatMap((group) => group.rows);
  const currentIndex = Math.max(0, rows.findIndex(row => row.id === selected));
  const current = rows[currentIndex];
  const currentId = current?.id;
  const optionId = (row: Row) => `dsm-command-${row.id}`;
  useLayoutEffect(() => {
    if (currentId && selected !== currentId) setSelected(currentId);
  }, [currentId, selected]);
  useLayoutEffect(() => {
    if (currentId)
      listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [currentId, currentIndex]);

  return (
    <>
      <div class="command-top">
        <label class="command-input">
          <Icon name="search" size={20} />
          <span class="sr-only">搜索命令与本地对话</span>
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls="dsm-command-list"
            aria-activedescendant={current ? optionId(current) : undefined}
            autoComplete="off"
            value={query}
            placeholder="搜索命令与本地对话"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setSelected(undefined);
            }}
            onKeyDown={(event) => {
              if (event.isComposing || !rows.length) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected(rows[(currentIndex + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].id);
              }
              if (event.key === 'Enter' && current) {
                event.preventDefault();
                current.run();
              }
            }}
          />
        </label>
        <button class="icon-button" aria-label="关闭面板" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div ref={listRef} id="dsm-command-list" role="listbox" class="command-results" aria-label="可执行操作">
        {groups
          .filter((group) => group.rows.length)
          .map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div class="command-group-label" aria-hidden="true">
                {group.label}
              </div>
              {group.rows.map((row) => (
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={current?.id === row.id}
                  aria-label={row.label}
                  id={optionId(row)}
                  key={row.id}
                  class="command-row"
                  onMouseMove={() => setSelected(row.id)}
                  onClick={row.run}
                >
                  <Icon name={row.icon} />
                  <span>{row.label}</span>
                  {current?.id === row.id ? (
                    <kbd aria-hidden="true">↵</kbd>
                  ) : (
                    row.hint && <kbd aria-hidden="true">{row.hint}</kbd>
                  )}
                </button>
              ))}
            </div>
          ))}
        {!rows.length && c.state.libraryStatus === 'ready' && <p class="command-empty">没有匹配项</p>}
      </div>
      {c.state.libraryStatus !== 'ready' && <p class="command-empty" role="status">
        {c.state.libraryStatus === 'loading' ? '正在读取本地对话…' : '暂时无法读取本地对话'}
      </p>}
      <div class="command-footer">
        <span>
          <kbd>↑↓</kbd> 选择
        </span>
        <span>
          <kbd>↵</kbd> 执行
        </span>
        <span>
          <kbd>Esc</kbd> 关闭
        </span>
      </div>
    </>
  );
}
