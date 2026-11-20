// Which language each person sees, and the record of the language they agreed in. The rules themselves are plain
// functions in src/lib/i18n.ts, shared with the pages; this file applies them to recipients, accounts and requests.
//
// recipients.locale  the language the sender set for that person (the editor, the API, a template, a bulk row), or
//                    for a public form the language the visitor's browser asked for when they started. NULL: their
//                    browser decides when they open the page, then English.
// accounts.default_locale  the language the editor starts each new recipient with. NULL: their browser decides.
// A language that is not switched on is refused with a 400 that names the ones that are. Nothing a sender writes
// (subject, message, documents, notes) is ever translated, here or anywhere else.
import { get, run } from './db.ts';
import { bad, str } from './util.ts';
import { chooseLocale, dir, isShipped, normalizeLocale, shippedLocales, browserLocale, languageWords, SOURCE_LOCALE } from '../lib/i18n.ts';
import { CONSENT_VERSION, consentAuditNote, isConsentLanguage, isConsentVersion } from '../lib/policy.ts';

const header = (req: Request | undefined) => req?.headers.get('accept-language') || '';

/** The languages a sender can choose, in words, for an answer that refuses another one. */
const offered = () => shippedLocales().map((t) => languageWords(t)).join(', ');

/**
 * A language a sender asked for, as it is stored: null for "their browser decides", the tag for one that is switched
 * on. Anything else is refused out loud, never swapped for another language or dropped. `what` names the field.
 */
export function chosenLocale(v: unknown, what: string, nothing = 'Nothing was saved.'): string | null {
  if (v == null || v === '') return null;
  const tag = normalizeLocale(v);
  if (tag && isShipped(tag)) return tag;
  const shown = typeof v === 'string' ? `"${str(v, 40)}"` : str(JSON.stringify(v), 40);
  throw bad(tag
    ? `${what} is ${shown}, and that language is not available yet: our screens have not been translated into it and checked by a person. Use one of: ${offered()}, or leave it out so the person's browser decides. ${nothing}`
    : `${what} is ${shown}, which is not a language code. Use a code like "en", one of: ${offered()}, or leave it out so the person's browser decides. ${nothing}`);
}

/** The language and the direction of writing of one person's screens right now: see chooseLocale. */
export function signerLanguage(r: any, req?: Request): { locale: string; dir: 'rtl' | 'ltr'; set_by: 'sender' | 'browser' | 'default' } {
  const locale = chooseLocale({ chosen: r?.locale, acceptLanguage: header(req) });
  const setBy = r?.locale && isShipped(r.locale) && locale === normalizeLocale(r.locale) ? 'sender' : browserLocale(header(req)) === locale ? 'browser' : 'default';
  return { locale, dir: dir(locale), set_by: setBy };
}

/** The language a public form's visitor starts in: what their browser asks for among the languages switched on. */
export const visitorLocale = (req?: Request, fallback?: unknown): string | null =>
  browserLocale(header(req)) || (isShipped(fallback) ? normalizeLocale(fallback) : null);

/**
 * The editor and the API save each recipient's "locale". Left out, a recipient keeps the one they had (a new one gets
 * none, so their browser decides, unless the account sets a default: see `defaultFor`). Called by writeContent in
 * envelopes.ts inside its transaction, so a refusal saves nothing.
 */
export function saveLocales(asked: { rid: string; r: any; i: number }[], before: Map<string, any>, accountId: string) {
  const account = get('SELECT default_locale FROM accounts WHERE id=?', accountId);
  for (const { rid, r, i } of asked) {
    const whom = `The language ("locale") of recipient ${i + 1}${r?.name ? ` (${str(r.name, 120)})` : ''}`;
    const old = before.get(rid);
    const value = r?.locale === undefined ? (old ? old.locale ?? null : defaultFor(account)) : chosenLocale(r.locale, whom);
    if (!old || (old.locale ?? null) !== value) run('UPDATE recipients SET locale=? WHERE id=?', value, rid);
  }
}

/** The language a new recipient starts in when the request names none: the account's default, if it is still switched on. */
export const defaultFor = (account: any): string | null => (account?.default_locale && isShipped(account.default_locale) ? normalizeLocale(account.default_locale) : null);

/**
 * A recipient copied into a new envelope (a template used, a copy, a bulk row, a public form) keeps their language.
 * A bulk row's "language" column, or the language a form visitor's browser asked for, comes first.
 */
export function copyLocale(r: any, newId: string, fill: any) {
  const own = fill && Object.hasOwn(fill, 'locale') ? fill.locale : r.locale;
  const value = own && isShipped(own) ? normalizeLocale(own) : null;
  if (value) run('UPDATE recipients SET locale=? WHERE id=?', value, newId);
}

/**
 * A bulk send's rows may say a language for a role: {"Client": {"name": ..., "email": ..., "language": "en"}}. Every
 * row is checked before anything is sent, and a language that is not switched on refuses the whole batch.
 */
export function assertRowLanguages(rows: any[], open: any[]) {
  rows.forEach((row, i) => {
    for (const r of open) {
      const v = row?.[r.role_name || r.id];
      if (v && typeof v === 'object' && v.language != null && v.language !== '') chosenLocale(v.language, `Row ${i + 1}: the "language" of "${r.role_name || 'Recipient'}"`, 'Nothing was sent.');
    }
  });
}
/** What copyEnvelope is given for a bulk row's person: their name and email, and their language when the row has one. */
export const rowFill = (v: any) => (v && typeof v === 'object' && v.language != null && v.language !== '' ? { ...v, locale: normalizeLocale(v.language) } : v);

/**
 * The audit line for agreeing, after the person's name. The screen says which wording it showed ("wording") and in
 * which language ("language"). A screen that names no language is one that only shows English (every screen before
 * languages, and today's signing page), so English is written. A language this wording does not exist in is said to
 * be one, and the English wording is named.
 */
export function consentLine(b: any): string {
  const stated = isConsentVersion(b?.wording);
  const version = stated ? b.wording : CONSENT_VERSION;
  const asked = b?.language == null || b.language === '' ? null : b.language;
  const held = asked != null && isConsentLanguage(version, asked);
  return consentAuditNote(version, stated, held ? normalizeLocale(asked)! : SOURCE_LOCALE, asked == null || held);
}
