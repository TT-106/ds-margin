import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { fillTemplate, variables, type PromptTemplate } from '../shared/model';
import { Icon } from './icons';

export function PromptForm({ prompt, onFill, compact = false }: {
  prompt: PromptTemplate;
  onFill: (text: string) => void;
  compact?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState(-1);
  const firstField = useRef<HTMLTextAreaElement>(null);
  const keys = variables(prompt.body);
  const errorId = useId();
  useLayoutEffect(() => { firstField.current?.focus({ preventScroll: true }); }, []);
  return <form noValidate class={`edit-form prompt-form ${compact ? 'prompt-form-compact' : ''}`} onSubmit={event => {
    event.preventDefault();
    const missing = keys.findIndex(key => !Object.hasOwn(values, key) || !values[key].trim());
    setInvalid(missing);
    if (missing >= 0) {
      const field = event.currentTarget.elements.namedItem(`variable-${missing}`);
      if (field instanceof HTMLTextAreaElement) field.focus();
      return;
    }
    onFill(fillTemplate(prompt.body, values));
  }}>
    {keys.map((key, i) => {
      const label = key || '未命名变量';
      const long = /文本|原文|代码|方案|论证|内容/.test(key);
      return <label key={key}>
        {label}
        <textarea ref={i === 0 ? firstField : undefined} name={`variable-${i}`} required aria-label={label}
          aria-invalid={invalid === i || undefined} aria-describedby={invalid === i ? errorId : undefined}
          rows={long ? (compact ? 4 : 5) : (compact ? 2 : 3)}
          placeholder={compact ? `输入${label}` : undefined}
          value={Object.hasOwn(values, key) ? values[key] : ''}
          onInput={event => {
            const field = event.currentTarget;
            if (invalid === i) setInvalid(-1);
            setValues(previous => ({ ...previous, [key]: field.value }));
          }}/>
        {invalid === i && <small id={errorId} class="prompt-field-error" role="status">请填写这一项</small>}
      </label>;
    })}
    <details class="template-preview"><summary>查看模板原文</summary><pre>{prompt.body}</pre></details>
    <button class="button primary full" type="submit"><Icon name="arrow" size={16}/>填入输入框</button>
  </form>;
}
