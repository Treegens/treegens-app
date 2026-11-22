'use client';
import { useState } from 'react';
import { api, oops, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { languageOf, shippedLocales } from '@/lib/i18n';
import { senderT as t } from '@/lib/senderlang';
import { useSenderLangHere } from '@/components/senderLang';

// Settings, Account: the language each new recipient starts in (accounts.default_locale, src/server/locales.ts). The
// sender can change it for one person in the editor. While English is the only language switched on there is nothing
// to choose, so nothing is shown at all: no card, no list with one entry, no button that does nothing. The card
// appears for admins once a second language is switched on.

/** How a language is listed for a sender, whose screens are in English: its own name, and the English one after it. */
export const languageLabel = (tag: string): string => {
  const l = languageOf(tag);
  return !l ? tag : l.own === l.english ? l.own : `${l.own} (${l.english})`;
};

export function LanguageSettings() {
  const ui = useSenderLangHere();
  const me = useMe();
  const on = shippedLocales();
  const [value, setValue] = useState<string>(me.account?.default_locale || '');
  const [busy, setBusy] = useState(false);
  // Account() above tells a member that only admins change these settings.
  if (me.role === 'member' || on.length < 2) return null;
  const save = () => {
    setBusy(true);
    api('/account', { method: 'PATCH', body: { default_locale: value || null } })
      .then(() => (toast(t(ui, 'settings.language.saved', { language: value ? languageLabel(value) : t(ui, 'language.browser') })), me.reload()))
      .catch(oops)
      .finally(() => setBusy(false));
  };
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="set-language-h">
      <h2 id="set-language-h" style={{ marginBottom: 12 }}>{t(ui, 'settings.language.title')}</h2>
      <label className="f"><span>{t(ui, 'settings.language.label')}</span>
        <select value={value} aria-describedby="set-language" style={{ minHeight: 44, maxWidth: '100%' }} onChange={(e) => setValue(e.target.value)}>
          <option value="">{t(ui, 'language.browser')}</option>
          {on.map((tag) => <option key={tag} value={tag} lang={tag}>{languageLabel(tag)}</option>)}
        </select>
      </label>
      <p id="set-language" className="muted small">{t(ui, 'settings.language.hint')}</p>
      <button type="button" className="btn primary" style={{ minHeight: 44 }} disabled={busy || value === (me.account?.default_locale || '')} onClick={save}>{t(ui, 'settings.language.button')}</button>
    </section>
  );
}
