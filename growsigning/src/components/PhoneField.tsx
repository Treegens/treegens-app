'use client';
// The phone number of a login: a country picker that starts on the country of the browser's language, and one box
// for the number as people write it at home. Used on the sign-up form, on the "One more thing" screen and under
// Settings. What is a plausible number, and the words for what is wrong, are in src/lib/signup.ts, the same rules
// the server checks with, so the page never accepts what the server refuses.
import { useEffect, useId, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { PHONE_COUNTRIES, PHONE_EXAMPLES, countryName, guessCountry, parsePhone, phoneProblemText } from '@/lib/signup';

export type PhoneValue = { country: string; number: string };
type Say = (key: string, vars?: Record<string, string | number>) => string;

/** The picker starts empty on the server and takes the browser's country once the page runs in it. */
export function usePhone(): [PhoneValue, (v: PhoneValue) => void] {
  const [v, setV] = useState<PhoneValue>({ country: 'US', number: '' });
  useEffect(() => {
    const guess = guessCountry(navigator.languages?.length ? navigator.languages : navigator.language);
    setV((s) => (s.number ? s : { ...s, country: guess }));
  }, []);
  return [v, setV];
}
/** What to send: { phone, phone_country }. */
export const phoneBody = (v: PhoneValue) => ({ phone: v.number.trim(), phone_country: v.country });
/** What is wrong with what was typed, in words, or '' when it reads as a number. */
export const phoneProblem = (v: PhoneValue, lang = 'en'): string => {
  const r = parsePhone(v.number, v.country);
  return r.ok ? '' : phoneProblemText(r.why, r.iso || v.country, lang);
};

export function PhoneField({ T, value, onChange, lang = 'en', autoFocus = false, why = true }: { T: Say; value: PhoneValue; onChange: (v: PhoneValue) => void; lang?: string; autoFocus?: boolean; why?: boolean }) {
  const id = useId();
  // Said once the person leaves the box, or at once for letters: nobody is told "too short" while still typing.
  const [left, setLeft] = useState(false);
  const [all, setAll] = useState(false);
  const fill = () => { if (!all) flushSync(() => setAll(true)); };
  const countries = useMemo(() => PHONE_COUNTRIES.map((c) => ({ ...c, name: countryName(c.iso, lang) })).sort((a, b) => a.name.localeCompare(b.name, lang)), [lang]);
  const r = value.number.trim() ? parsePhone(value.number, value.country) : null;
  const wrong = r && !r.ok && (left || r.why === 'letters') ? phoneProblemText(r.why, r.iso || value.country, lang) : '';
  // A number typed with + says its own country: the picker follows it, so the two never disagree on screen.
  useEffect(() => {
    if (r?.ok && r.iso !== value.country && value.number.trim().startsWith('+')) onChange({ ...value, country: r.iso });
  }, [r?.ok && r.iso]);
  return (
    <div className="phone-f">
      <label htmlFor={`${id}-n`}>{T('phone.label')}</label>
      <div className="phone-row">
        {/* Closed, the picker holds the chosen country only: a page with 200 country names in it reads as 600 words to a
            screen reader's "read all" and to anything that counts words. The list is filled the moment it is touched. */}
        <select aria-label={T('phone.country')} value={value.country} onChange={(e) => onChange({ ...value, country: e.target.value })} autoComplete="tel-country-code"
          onPointerDown={fill} onFocus={fill} onKeyDown={fill}>
          {(all ? countries : countries.filter((c) => c.iso === value.country)).map((c) => <option key={c.iso} value={c.iso}>{c.name} (+{c.dial})</option>)}
        </select>
        <input id={`${id}-n`} type="tel" inputMode="tel" autoComplete="tel-national" required autoFocus={autoFocus} maxLength={32} value={value.number} placeholder={PHONE_EXAMPLES[value.country] || ''}
          onChange={(e) => onChange({ ...value, number: e.target.value })} onBlur={() => setLeft(true)} aria-invalid={!!wrong} aria-describedby={`${id}-w ${id}-e`} />
      </div>
      <p className="phone-err" id={`${id}-e`} role="alert">{wrong}</p>
      {why && <p className="phone-why" id={`${id}-w`}>{T('phone.why')}</p>}
    </div>
  );
}
