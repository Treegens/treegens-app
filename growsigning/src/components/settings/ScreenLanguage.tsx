'use client';
import { useState } from 'react';
import { api, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { useST } from '@/components/senderLang';
import { senderLanguages, senderChoiceShown, senderLanguageName, senderLangAttr, senderStatus } from '@/lib/senderlang';
import { languageOf } from '@/lib/i18n';
import { Card, useSaved } from './Frame';

// Settings, Profile: "Language of your screens" (research/ux-notes.json ds-lang-sender), the language of this person's
// own screens and of our emails to them (users.locale, PATCH /me "locale"). Not there at all until a second sender
// language ships: no card, no list with one entry. "The one my browser asks for" is the default and saves nothing.
// A language whose sender screens are a machine's draft says so in the list and under it.

export function ScreenLanguage() {
  const me = useMe();
  const T = useST();
  const [value, setValue] = useState<string>(me.user.locale || '');
  const [said, saved] = useSaved(T('sender.language.saved'));
  if (!senderChoiceShown()) return null;
  const langs = senderLanguages();
  const chosen = value ? languageOf(value) : null;
  // A select saves as soon as it changes, with "Saved" next to it (research/ux-charter.md P5). The hook is given the
  // words in the current language, so once me.reload() has redrawn the screen "Saved" is said in the language chosen.
  const save = (next: string) => {
    const was = value;
    setValue(next);
    api('/me', { method: 'PATCH', body: { locale: next || null } })
      .then(() => { saved(); me.reload(true); })
      .catch((e) => { setValue(was); toast(T.error(e), true); });
  };
  return (
    <section className="card" aria-labelledby="screen-language-h">
      <h2 id="screen-language-h" style={{ marginBottom: 12 }}>{T('sender.language.title')}</h2>
      <label className="f"><span>{T('sender.language.label')}</span>
        <select value={value} aria-describedby="screen-language-hint" style={{ minHeight: 44, maxWidth: '100%' }} onChange={(e) => save(e.target.value)}>
          <option value="">{T('sender.language.browser')}</option>
          {langs.map((l) => <option key={l.tag} value={l.tag} lang={senderLangAttr(l.tag)}>{senderLanguageName(l.tag, T.lang)}</option>)}
        </select>
      </label>
      {said}
      <p id="screen-language-hint" className="muted small">{T('sender.language.hint')}{chosen && senderStatus(chosen) === 'draft' ? ` ${T('sender.language.draft_note')}` : ''}</p>
    </section>
  );
}

/** Profile's card for it, or nothing at all (no empty card) while English is the only sender language. */
export const ScreenLanguageCard = () => (senderChoiceShown() ? <Card><ScreenLanguage /></Card> : null);
