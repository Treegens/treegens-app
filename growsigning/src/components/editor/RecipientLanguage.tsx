'use client';
import { useId } from 'react';
import { SOURCE_LOCALE, shippedLocales, t } from '@/lib/i18n';
import { languageLabel } from '../settings/LanguageSettings';

// The editor, under More next to a person: the language our screens are in for them (recipients.locale). Empty means
// their browser decides, then English. It starts with the account's default (Settings, Account). While English is the
// only language switched on there is nothing to choose, and nothing is shown.
const ui = SOURCE_LOCALE;

export function RecipientLanguage({ value, who, onChange }: { value?: string | null; who: string; onChange: (p: { locale: string | null }) => void }) {
  const hint = useId();
  const on = shippedLocales();
  if (on.length < 2) return null;
  // A language set before it was switched off is shown as it is, so the select never claims another one.
  const current = value || '';
  return (
    <div className="ed-lang" style={{ marginTop: 10 }}>
      <label className="f" style={{ margin: 0 }}><span>{t(ui, 'editor.language.label')}</span>
        <select value={current} aria-describedby={hint} aria-label={`${t(ui, 'editor.language.label')}: ${who}`} style={{ minHeight: 44 }} onChange={(e) => onChange({ locale: e.target.value || null })}>
          <option value="">{t(ui, 'language.browser')}</option>
          {on.map((tag) => <option key={tag} value={tag} lang={tag}>{languageLabel(tag)}</option>)}
          {current && !on.includes(current) && <option value={current}>{current}</option>}
        </select>
      </label>
      <p id={hint} className="muted small" style={{ margin: '6px 0 0' }}>{t(ui, 'editor.language.hint')}</p>
    </div>
  );
}
