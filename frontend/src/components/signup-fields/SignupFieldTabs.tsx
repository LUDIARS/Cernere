import type { SignupFieldValue, SignupFieldView } from '../../lib/signup-fields-api';

/** A declared selector rendered as keyboard-accessible segmented tabs. */
export function SignupFieldTabs({ field, value, disabled, onChange }: {
  field: SignupFieldView;
  value: SignupFieldValue;
  disabled?: boolean;
  onChange: (value: SignupFieldValue) => void;
}) {
  const options = field.options ?? [];
  return <div id={`signup-field-${field.column}`} role="radiogroup"
    aria-labelledby={`signup-field-${field.column}-label`}
    style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio"
      disabled={disabled} aria-checked={value === option.value}
      tabIndex={value === option.value || (!options.some((item) => item.value === value) && index === 0) ? 0 : -1}
      onClick={() => onChange(option.value)}
      onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % options.length
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + options.length - 1) % options.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        onChange(options[next].value);
        (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
      }}
      style={{ flex: 1, padding: '0.65rem', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
        border: value === option.value ? '2px solid currentColor' : '1px solid var(--border)',
        background: 'var(--bg)', color: 'var(--text)', fontWeight: value === option.value ? 700 : 400 }}>
      {option.label}
    </button>)}
  </div>;
}
