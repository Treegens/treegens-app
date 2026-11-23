// The signing page in the signer's language, on the server's side: refusals the page shows carry a code, and the
// language each person read the page in is kept for the certificate. The words themselves are in src/locales/en.json
// and the rules in src/lib/signlang.ts and src/lib/i18n.ts.
import { bad } from './util.ts';
import { run } from './db.ts';
import { signT, errorKey } from '../lib/signlang.ts';
import { isShipped, normalizeLocale, uiLocale, languageWords, SOURCE_LOCALE } from '../lib/i18n.ts';
import { consentLanguageOf } from '../lib/policy.ts';
import type { Vars } from '../lib/i18n.ts';

/**
 * A refusal the signing page shows: the English sentence from en.json for the API (and any program reading it), and
 * with it its code and the facts in it, so the page says the same thing in the signer's language
 * (shownError in src/lib/signlang.ts). Every code has the text "sign.error.<code>" in en.json.
 */
export function refuse(code: string, status = 400, vars: Vars = {}, textCode = code) {
  const text = signT(SOURCE_LOCALE, errorKey(textCode), vars);
  // `textCode`: one refusal said in two ways (the same code, with "Nothing was sent." where something was being sent).
  const data: Record<string, any> = textCode === code ? { code } : { code, text: textCode };
  for (const [k, v] of Object.entries(vars)) if (v != null) data[k] = v;
  return bad(text || 'Something went wrong on our side. Try again in a minute.', status, data);
}

/**
 * The language a signing screen said it was in, as it is kept: one that is switched on, or the switched-on language
 * that page's words actually came from (a test language reads as English). null when nothing usable was said.
 */
export function pageLanguage(v: unknown): string | null {
  const tag = normalizeLocale(v);
  if (!tag) return null;
  return isShipped(tag) ? tag : uiLocale(tag);
}

/**
 * Keeps the language this person read the page in (when they agree, or choose one in the menu). Only until they
 * finish: the certificate names the language they signed in, so nothing said afterwards changes it.
 */
export function notePageLanguage(recipientId: string, v: unknown) {
  const tag = pageLanguage(v);
  if (tag) run('UPDATE recipients SET page_locale=? WHERE id=? AND completed_at IS NULL AND (page_locale IS NULL OR page_locale<>?)', tag, recipientId, tag);
}

/**
 * The certificate's line on languages for one person: the language of the signing page, and the language of the
 * consent wording they agreed to (read from their consent line in the audit trail, which says it). A person who
 * never agreed has only the page; one from before languages were recorded says so rather than guessing.
 */
export function certLanguageLine(r: any, audit: any[]): string | null {
  const page = r?.page_locale ? languageWords(r.page_locale) : null;
  const line = [...(audit || [])].reverse().find((a) => a?.action === 'Agreed to electronic records and signatures' && String(a.detail || '').startsWith(`${r?.name}.`))
    || [...(audit || [])].reverse().find((a) => a?.action === 'Agreed to electronic records and signatures' && a.actor === r?.name);
  const consent = line ? languageWords(consentLanguageOf(line.detail)) : null;
  if (!page && !consent) return null;
  return `${page ? `Signing page in ${page}` : 'Signing page language not recorded'}${consent ? `; consent wording in ${consent}` : ''}`;
}

