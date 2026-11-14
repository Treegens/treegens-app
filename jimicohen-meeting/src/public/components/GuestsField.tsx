import { useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cx, useFieldControl } from '../../ui';
import { EMAIL_RE } from '../lib/text';

export interface GuestsFieldProps {
  value: string[];
  onChange: (guests: string[]) => void;
  max: number;
  /** the invitee's own address: adding it again makes no sense */
  ownEmail?: string;
  /** reports a problem with what is being typed ('' clears it) */
  onProblem: (message: string) => void;
}

const SPLIT = /[\s,;]+/;

/**
 * Guest emails as chips. Enter, comma, space or leaving the field turns what was typed into a
 * chip. Backspace in an empty field removes the last one. Pasting a list adds them all.
 * Use inside <Field>.
 */
export function GuestsField({ value, onChange, max, ownEmail, onProblem }: GuestsFieldProps) {
  const field = useFieldControl();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const full = value.length >= max;

  const add = (raw: string): boolean => {
    const parts = raw
      .split(SPLIT)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return true;
    const next = value.slice();
    let problem = '';
    const rejected: string[] = [];
    for (const part of parts) {
      if (!EMAIL_RE.test(part)) {
        problem = `"${part}" does not look like an email address.`;
        rejected.push(part);
      } else if (next.includes(part)) {
        continue;
      } else if (ownEmail && part === ownEmail.trim().toLowerCase()) {
        problem = 'That is your own address. You are already invited.';
      } else if (next.length >= max) {
        problem = `You can add up to ${max} ${max === 1 ? 'guest' : 'guests'}.`;
        rejected.push(part);
      } else {
        next.push(part);
      }
    }
    if (next.length !== value.length) onChange(next);
    setDraft(rejected.join(', '));
    onProblem(problem);
    return !problem;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === ' ' && draft.trim())) {
      if (draft.trim()) {
        e.preventDefault();
        add(draft);
      } else if (e.key !== 'Enter') {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
      onProblem('');
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (SPLIT.test(text.trim())) {
      e.preventDefault();
      add(`${draft} ${text}`);
    }
  };

  const remove = (email: string) => {
    onChange(value.filter((g) => g !== email));
    onProblem('');
    inputRef.current?.focus();
  };

  return (
    <div
      className={cx('ui-input bw-guests', field.invalid && 'is-invalid')}
      onClick={(e) => {
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}
    >
      {value.length ? (
        <ul role="list" className="bw-guests__chips" aria-label="Guests added">
          {value.map((email) => (
            <li key={email} className="bw-guest">
              <span className="bw-guest__email">{email}</span>
              <button type="button" className="bw-guest__remove" aria-label={`Remove ${email}`} onClick={() => remove(email)}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        id={field.id}
        type="text"
        inputMode="email"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="ui-input__el bw-guests__input"
        value={draft}
        placeholder={full ? 'Guest list is full' : value.length ? 'Add another' : 'name@example.com'}
        disabled={full && !draft}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        onChange={(e) => {
          setDraft(e.target.value);
          if (field.invalid) onProblem('');
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (draft.trim()) add(draft);
        }}
      />
    </div>
  );
}
