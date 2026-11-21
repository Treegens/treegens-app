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

/** The language a public form's visitor starts in: what their browser asks for among the languages switched on, else none. */
export const visitorLocale = (req?: Request): string | null => browserLocale(header(req));

/**
 * The editor and the API save each recipient's "locale". Left out, a recipient keeps the one they had (a new one gets
 * none, so their browser decides, unless the account sets a default: see `defaultFor`). Called by writeContent in
 * envelopes.ts inside its transaction, so a refusal saves nothing.
 */
export function saveLocales(asked: { rid: string; r: any; i: number }[], before: Map<string, any>, accountId: string) {
  const account = get('SELECT default_locale FROM accounts WHERE id=?', accountId);
  for (const { rid, r, i } of asked) {
    const want = askedOf(r);
    const whom = `The language ("${want.word}") of recipient ${i + 1}${r?.name ? ` (${str(r.name, 120)})` : ''}`;
    const old = before.get(rid);
    // A language stored before it was switched off is kept when the editor sends it back unchanged, so a draft
    // never stops saving because of it. Only a new choice has to be a language that is switched on.
    const same = old?.locale && want.value != null && normalizeLocale(want.value) === old.locale;
    // A row whose address changed is another person: the language chosen for the one before is not theirs, so with
    // nothing said they start as a new recipient does. (The editor always says, so its row keeps what it shows.)
    const kept = old && (!old.email || sameAddress(old.email, r?.email));
    const value = want.value === undefined ? (kept ? old.locale ?? null : defaultFor(account)) : same ? old.locale : chosenLocale(want.value, whom);
    if (!old || (old.locale ?? null) !== value) run('UPDATE recipients SET locale=? WHERE id=?', value, rid);
  }
}

const sameAddress = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
/**
 * What a recipient in a request says about their language. The field is "locale"; "language" (the word bulk rows and
 * template fills use) is read as the same thing, so neither spelling is ever dropped without a word. Both, saying
 * different things, is refused.
 */
function askedOf(r: any): { value: unknown; word: 'locale' | 'language' } {
  if (!r || typeof r !== 'object') return { value: undefined, word: 'locale' };
  const { locale, language } = r;
  if (locale !== undefined && language !== undefined && (normalizeLocale(locale) || locale || null) !== (normalizeLocale(language) || language || null))
    throw bad(`${r.name ? `${str(r.name, 120)} has` : 'A recipient has'} both "locale" (${str(JSON.stringify(locale) ?? '', 40)}) and "language" (${str(JSON.stringify(language) ?? '', 40)}), and they say different things. Send one of them. Nothing was saved.`);
  return locale !== undefined ? { value: locale, word: 'locale' } : { value: language, word: 'language' };
}

/**
 * POST /envelopes/:id/correct and the language. Call it before the correction: it checks "locale" (or "language"), so
 * a language that is not switched on refuses the whole call. `only` is true when the call asks for nothing but the
 * language. Call `apply` after the correction: it saves the language asked for, or, when nothing was said and the
 * place now belongs to another person (another address, or another name at the same one), clears the language
 * chosen for the one before, so the new person's browser decides. Returns what changed, for the record, or ''.
 */
export function correctionLocale(e: any, recipientId: string, b: any): { only: boolean; apply: () => string } {
  const r = e.recipients.find((x: any) => x.id === recipientId);
  const want = askedOf(b);
  const said = want.value !== undefined;
  const value = said ? chosenLocale(want.value, `The language ("${want.word}")${r?.name ? ` of ${str(r.name, 120)}` : ''}`, 'Nothing was changed.') : null;
  const only = said && !['name', 'email', 'access_code', 'verify', 'phone', 'text_link', 'number_confirmed', 'members'].some((k) => b?.[k] !== undefined);
  if (only) {
    if (!r) throw bad('Recipient not found.', 404);
    if (e.status !== 'sent' || r.status === 'completed') throw bad(`The language can be changed for someone who has not finished, on an envelope that is out for signature. ${e.status !== 'sent' ? 'This envelope is not.' : `${r.name} has finished.`} Nothing was changed.`);
  }
  return {
    only,
    apply: () => {
      const now = get('SELECT locale, person_gen, email FROM recipients WHERE id=?', recipientId);
      if (!now) return '';
      const other = !said && (Number(now.person_gen) || 0) !== (Number(r?.person_gen) || 0) || (!said && !sameAddress(now.email, r?.email));
      const next = said ? value : other ? null : now.locale ?? null;
      if ((now.locale ?? null) === next) return '';
      run('UPDATE recipients SET locale=? WHERE id=?', next, recipientId);
      return said ? `the language of our screens for them is now ${next ? languageWords(next) : 'the one their browser asks for'}` : '';
    },
  };
}

/** The language a new recipient starts in when the request names none: the account's default, if it is still switched on. */
export const defaultFor = (account: any): string | null => (account?.default_locale && isShipped(account.default_locale) ? normalizeLocale(account.default_locale) : null);

/**
 * A recipient copied into a new envelope (a template used, a copy, a bulk row, a public form) keeps their language.
 * What the copy is given for that person comes first: a bulk row's "language", the "locale" of a role filled in
 * through the API, or the language a form visitor's browser asked for. One that is not switched on is refused, inside
 * copyEnvelope's transaction, so nothing is made. (Bulk rows are all checked before the first is sent: rowLanguageRefusal.)
 */
export function copyLocale(r: any, newId: string, fill: any) {
  // undefined: nothing said, the original's language goes with the copy. null or "": their browser decides.
  const asked = !fill || typeof fill !== 'object' ? undefined : fill.locale !== undefined ? fill.locale : fill.language;
  const value = asked === undefined ? r.locale || null : chosenLocale(asked, `The language for ${str(r.role_name || r.name || 'a recipient', 80)}`, 'Nothing was made.');
  if (value) run('UPDATE recipients SET locale=? WHERE id=?', value, newId);
}

/**
 * A bulk send's rows may say a language for a role: {"Client": {"name": ..., "email": ..., "language": "en"}}. Every
 * row is checked before anything is sent: a language that is not switched on refuses the whole batch, in the words
 * POST /bulk/check gives too. null when every row is fine.
 */
export function rowLanguageRefusal(rows: any[], open: any[]): { status: number; message: string } | null {
  try {
    rows.forEach((row, i) => {
      for (const r of open) {
        const v = row?.[r.role_name || r.id];
        if (v && typeof v === 'object' && v.language != null && v.language !== '') chosenLocale(v.language, `Row ${i + 1}: the "language" of "${r.role_name || 'Recipient'}"`, 'Nothing was sent.');
      }
    });
    return null;
  } catch (e: any) {
    return { status: e.status || 400, message: e.message };
  }
}
export function assertRowLanguages(rows: any[], open: any[]) {
  const no = rowLanguageRefusal(rows, open);
  if (no) throw bad(no.message, no.status);
}

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
