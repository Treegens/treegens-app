import { useId } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import type { Question } from '../../../shared/types';
import { Checkbox, Field, Input, RadioGroup, Select, Textarea, cx } from '../../ui';
import { isWebUrl } from '../lib/text';

export type AnswerValue = string | string[] | boolean;

export interface QuestionFieldProps {
  question: Question;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
  onBlur?: () => void;
  error?: string;
}

/** Validation message for one answer, or '' when it is fine. */
export function validateAnswer(q: Question, value: AnswerValue | undefined): string {
  const empty = value === undefined || value === '' || value === false || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && !value.trim());
  if (empty) {
    if (!q.required) return '';
    if (q.type === 'checkbox' && !q.options?.length) return 'Please tick this box to continue.';
    if (q.type === 'select' || q.type === 'radio') return 'Please choose an option.';
    if (q.type === 'checkbox') return 'Please choose at least one.';
    return 'Please answer this question.';
  }
  if (q.type === 'url' && typeof value === 'string') {
    const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    if (!isWebUrl(candidate) || !candidate.includes('.')) return 'Please enter a link, like https://example.com';
  }
  if (q.type === 'number' && typeof value === 'string' && !/^-?\d+([.,]\d+)?$/.test(value.trim())) return 'Please enter a number.';
  if (typeof value === 'string' && value.length > 2000) return 'That is a little long. Please keep it under 2,000 characters.';
  return '';
}

/** A group of choices with a visible legend and an error line, announced as one field. */
function ChoiceGroup({ label, required, error, children, id }: { label: string; required: boolean; error?: string; children: ReactNode; id: string }) {
  const errorId = `${id}-error`;
  return (
    <div className={cx('ui-field bw-group', error && 'is-invalid')} role="group" aria-labelledby={`${id}-label`} aria-describedby={error ? errorId : undefined}>
      <p className="ui-field__label" id={`${id}-label`}>
        {label}
        {required ? (
          <span className="ui-field__req" aria-hidden="true">
            *
          </span>
        ) : (
          <>
            {' '}
            <span className="ui-field__optional">Optional</span>
          </>
        )}
      </p>
      {children}
      {error ? (
        <p className="ui-field__error" id={errorId} role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Renders one custom question in the control that fits its type. */
export function QuestionField({ question: q, value, onChange, onBlur, error }: QuestionFieldProps) {
  const auto = useId();
  const id = `q${auto}`;
  const text = typeof value === 'string' ? value : '';
  const options = (q.options ?? []).filter(Boolean);

  if (q.type === 'radio' && options.length) {
    return (
      <ChoiceGroup id={id} label={q.label} required={q.required} error={error}>
        <RadioGroup
          aria-label={q.label}
          name={`answer-${q.id}`}
          value={text || null}
          onChange={(v) => onChange(v)}
          options={options.map((o) => ({ value: o, label: o }))}
          invalid={!!error}
          required={q.required}
          className="bw-group__choices"
        />
      </ChoiceGroup>
    );
  }

  if (q.type === 'checkbox') {
    if (!options.length) {
      return (
        <div className={cx('ui-field bw-group', error && 'is-invalid')}>
          <Checkbox id={id} checked={value === true} onChange={(c) => onChange(c)} label={q.label} required={q.required} invalid={!!error} />
          {error ? (
            <p className="ui-field__error" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      );
    }
    const chosen = Array.isArray(value) ? value : [];
    return (
      <ChoiceGroup id={id} label={q.label} required={q.required} error={error}>
        <div className="bw-group__choices bw-group__checks">
          {options.map((o) => (
            <Checkbox
              key={o}
              checked={chosen.includes(o)}
              onChange={(c) => onChange(c ? [...chosen, o] : chosen.filter((x) => x !== o))}
              label={o}
              name={`answer-${q.id}`}
              value={o}
              invalid={!!error}
            />
          ))}
        </div>
      </ChoiceGroup>
    );
  }

  return (
    <Field label={q.label} required={q.required} optional={!q.required} error={error || undefined} htmlFor={id}>
      {q.type === 'textarea' ? (
        <Textarea value={text} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={q.placeholder} rows={3} autoGrow maxRows={8} maxLength={2000} />
      ) : q.type === 'select' || (q.type === 'radio' && !options.length) ? (
        <Select value={text} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={q.placeholder || 'Choose one'} options={options.map((o) => ({ value: o, label: o }))} />
      ) : (
        <Input
          type={q.type === 'url' ? 'url' : 'text'}
          inputMode={q.type === 'number' ? 'decimal' : q.type === 'url' ? 'url' : undefined}
          autoCapitalize={q.type === 'url' ? 'none' : undefined}
          spellCheck={q.type === 'url' || q.type === 'number' ? false : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={q.placeholder}
          maxLength={q.type === 'number' ? 24 : 500}
        />
      )}
    </Field>
  );
}
