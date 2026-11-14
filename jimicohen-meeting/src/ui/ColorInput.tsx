import { useEffect, useId, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './util';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function toSix(input: string): string | null {
  const m = HEX.exec(input.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return `#${h}`;
}

export interface ColorInputProps {
  /** `#rrggbb` */
  value: string;
  /** called with a normalised lowercase `#rrggbb` only when the input is a valid colour */
  onChange: (hex: string) => void;
  /** visible label above the control */
  label?: ReactNode;
  /** quick picks shown as small swatches */
  presets?: string[];
  disabled?: boolean;
  invalid?: boolean;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

/** Swatch that opens the system colour picker, plus a hex field for exact values. */
export function ColorInput({ value, onChange, label, presets, disabled = false, invalid = false, id, className, 'aria-label': ariaLabel }: ColorInputProps) {
  const auto = useId();
  const hexId = id ?? `ci${auto}`;
  const current = toSix(value) ?? '#000000';
  const [draft, setDraft] = useState(current);
  const [focused, setFocused] = useState(false);
  const draftValid = toSix(draft) !== null;

  useEffect(() => {
    if (!focused) setDraft(current);
  }, [current, focused]);

  const name = typeof label === 'string' ? label : ariaLabel ?? 'Colour';

  return (
    <div className={cx('ui-color', disabled && 'is-disabled', className)}>
      {label ? (
        <label className="ui-color__label" htmlFor={hexId}>
          {label}
        </label>
      ) : null}
      <div className={cx('ui-color__row', (invalid || (!draftValid && !focused)) && 'is-invalid')}>
        <span className="ui-color__swatch" style={{ '--_c': current } as CSSProperties}>
          <input
            type="color"
            className="ui-color__native"
            value={current}
            disabled={disabled}
            aria-label={`${name}: open the colour picker`}
            onChange={(e) => {
              const next = toSix(e.target.value);
              if (next) {
                setDraft(next);
                onChange(next);
              }
            }}
          />
        </span>
        <input
          id={hexId}
          type="text"
          className="ui-color__hex"
          value={draft}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          maxLength={7}
          inputMode="text"
          aria-label={label ? undefined : `${name}: hex value`}
          aria-invalid={!draftValid || invalid || undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            const next = toSix(draft);
            setDraft(next ?? current);
          }}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^#0-9a-f]/gi, '');
            setDraft(raw);
            const next = toSix(raw);
            if (next && raw.replace('#', '').length === 6 && next !== current) onChange(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const next = toSix(draft);
              if (next && next !== current) onChange(next);
            }
          }}
        />
      </div>
      {presets && presets.length ? (
        <div className="ui-color__presets" role="group" aria-label={`${name}: suggestions`}>
          {presets.map((p) => {
            const six = toSix(p);
            if (!six) return null;
            return (
              <button
                key={six}
                type="button"
                className={cx('ui-color__preset', six === current && 'is-current')}
                style={{ '--_c': six } as CSSProperties}
                aria-label={`Use ${six}`}
                aria-pressed={six === current}
                disabled={disabled}
                onClick={() => {
                  setDraft(six);
                  onChange(six);
                }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
