import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cx, useFieldControl } from '../../ui';
import { formatAsYouType, listCountries, loadPhoneLib, phoneLibIfLoaded } from '../lib/phone';
import type { CountryOption } from '../lib/phone';

export interface PhoneFieldProps {
  /** what the visitor typed (national or international) */
  value: string;
  /** ISO country the national number is read in */
  country: string;
  onChange: (value: string, country: string) => void;
  onBlur?: () => void;
  locale: string;
  placeholder?: string;
}

/**
 * Phone input with a country calling code picker. The number library arrives lazily:
 * until it does this is a plain tel field, afterwards it formats as you type and the
 * picker lists every country. Use inside <Field>.
 */
export function PhoneField({ value, country, onChange, onBlur, locale, placeholder }: PhoneFieldProps) {
  const field = useFieldControl();
  const [ready, setReady] = useState(() => !!phoneLibIfLoaded());

  useEffect(() => {
    if (ready) return;
    let alive = true;
    loadPhoneLib().then(
      () => alive && setReady(true),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [ready]);

  const countries = useMemo<CountryOption[]>(() => {
    const lib = phoneLibIfLoaded();
    return ready && lib ? listCountries(lib, locale) : [];
  }, [ready, locale]);

  const current = countries.find((c) => c.code === country);
  const international = value.trim().startsWith('+');

  const handleInput = (raw: string, caretAtEnd: boolean) => {
    // Reformatting moves the caret to the end, so only do it while typing at the end.
    if (!ready || !caretAtEnd) {
      onChange(raw, country);
      return;
    }
    const deleting = raw.length < value.length;
    const formatted = deleting ? { text: raw, country: undefined } : formatAsYouType(raw, country);
    onChange(formatted.text, formatted.country ?? country);
  };

  return (
    <div className={cx('ui-input bw-phone', field.invalid && 'is-invalid')}>
      {countries.length ? (
        <label className={cx('bw-phone__country', international && 'is-muted')}>
          <span className="u-vh">Country calling code</span>
          <span className="bw-phone__code" aria-hidden="true">
            <span className="bw-phone__iso">{country}</span>
            <span>+{current?.callingCode ?? ''}</span>
            <ChevronDown size={14} />
          </span>
          <select
            className="bw-phone__select"
            value={current ? country : ''}
            autoComplete="tel-country-code"
            onChange={(e) => onChange(international ? '' : value, e.target.value)}
          >
            {current ? null : <option value="">Choose a country</option>}
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} (+{c.callingCode})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <input
        id={field.id}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        className="ui-input__el bw-phone__input"
        value={value}
        placeholder={placeholder}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        required={field.required}
        onChange={(e) => handleInput(e.target.value, e.target.selectionStart === null || e.target.selectionStart === e.target.value.length)}
        onBlur={onBlur}
      />
    </div>
  );
}
