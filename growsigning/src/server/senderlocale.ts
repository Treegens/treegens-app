// The sender's language on the server (research/docusign-gaps.json, batch "lang-sender"): the choice under Settings,
// Profile (users.locale, PATCH /me "locale"), the browser's language noted when the app is opened (users.seen_locale),
// and the emails to senders written in it. The rules are src/lib/senderlang.ts.
//
// An email is in one language. Only an email whose every line of ours comes from en.json is written in the sender's
// language (tellSender below and the callers that use senderMailLocale); every other email to a sender stays English
// as a whole. The sender's own words (the subject, a reason a signer typed, a comment) are never translated.
import { get, run } from './db.ts';
import { bad, str, baseUrl } from './util.ts';
// Used only when an email is sent, so the two files may import each other.
import { notifySender, type NotifyKey } from './envelopes.ts';
import { mt, listIn } from './maillang.ts';
import { normalizeLocale, SOURCE_LOCALE, languageWords } from '../lib/i18n.ts';
import { isPseudo } from '../lib/signlang.ts';
import { isSenderLanguage, senderBrowserLocale, senderMailLocale, senderTags, senderChoiceShown } from '../lib/senderlang.ts';

/**
 * PATCH /me "locale": null or "" for "my browser decides", a sender language as its tag. Anything else is refused in
 * words, with nothing saved, never swapped for another language. undefined: not asked, nothing changes.
 */
export function askedSenderLocale(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v == null || v === '') return null;
  const tag = normalizeLocale(v);
  if (tag && isSenderLanguage(tag)) return tag;
  // A browser's regional tag ("en-US") is taken as its language ("en") when that one is a sender language. Never for a
  // test language (en-XA, ar-XB): those stay refused, so a production server never saves one.
  const base = tag && !isPseudo(tag) ? tag.split('-')[0] : null;
  if (base && base !== tag && isSenderLanguage(base)) return base;
  const offered = senderTags().map((t) => languageWords(t)).join(', ');
  const shown = typeof v === 'string' ? `"${str(v, 40)}"` : str(JSON.stringify(v), 40);
  throw bad(tag
    ? `The language of your screens ("locale") is ${shown}, and our screens are not available in that language yet. Use one of: ${offered}, or leave it empty so your browser decides. Nothing was changed.`
    : `The language of your screens ("locale") is ${shown}, which is not a language code. Use a code like "en", one of: ${offered}, or leave it empty so your browser decides. Nothing was changed.`, 400, { code: 'sender_locale' });
}

/**
 * GET /me: the sender language the browser asks for, kept for the emails to this person while they chose none. Only
 * written when it changes, and nothing at all while English is the only sender language.
 */
export function noteSeenLocale(u: any, req: Request) {
  if (!u?.id || !senderChoiceShown()) return;
  const seen = senderBrowserLocale(req.headers.get('accept-language') || '');
  const value = seen && seen !== SOURCE_LOCALE ? seen : null;
  if ((u.seen_locale ?? null) !== value) run('UPDATE users SET seen_locale=? WHERE id=?', value, u.id);
}

/** The language of an email to the sender of envelope `e` (see senderMailLocale). */
export const senderLocaleOf = (e: any): string => senderMailLocale(e?.sender_id ? get('SELECT locale, seen_locale FROM users WHERE id=?', e.sender_id) : null);
/** The language of an email to login `userId`. */
export const userMailLocale = (userId: string | null | undefined): string => senderMailLocale(userId ? get('SELECT locale, seen_locale FROM users WHERE id=?', userId) : null);

/** The words of `key` in an email to a sender, in `L`. */
export const st = mt;

/**
 * Names in a sentence of an email to a sender. English keeps the words these emails always had ("A and B",
 * "A, B and C", or "A, B, C" with `commas`), so an English email reads word for word as before; another language
 * gets its own way of listing (Intl.ListFormat).
 */
export function namesIn(L: string, list: string[], commas = false): string {
  if (L === SOURCE_LOCALE) return commas || list.length < 3 ? list.join(commas ? ', ' : ' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return listIn(L, list);
}

export type SenderMail = { subject: string; heading: string; lines: string[]; cta?: { label: string; url: string } };

/**
 * notifySender (envelopes.ts) with every word of ours in the sender's language: `build` is given the language and
 * returns the email from en.json keys. The button is "Open envelope" in that language unless `build` names another.
 */
export async function tellSender(e: any, key: NotifyKey | 'always', build: (L: string) => SenderMail, more?: { onPaper?: boolean }) {
  const L = senderLocaleOf(e);
  const m = build(L);
  await notifySender(e, key, m.subject, m.heading, m.lines, m.cta || { label: st(L, 'mail.sender.open'), url: `${baseUrl()}/app/envelopes/${e.id}` }, { ...more, locale: L });
}

/**
 * The sender's own "Your document is complete" email (finish in envelopes.ts), every line from en.json: in English it
 * reads word for word as it always has. `impact` is left out for an account that switched the paper estimate off.
 */
export function senderCompletedMail(L: string, e: any, o: { ready: boolean; copy: 'attached' | 'too-large' | 'not-ready'; impact: { sheets: number; litresWater: number } | null; trees?: number }): SenderMail {
  const lines = [st(L, o.ready ? 'mail.sender.complete.ready' : 'mail.sender.complete.preparing')];
  // What the signatures of this document plant: the same sentence as completedMailLine in src/lib/impactwords.ts. 0 says nothing.
  if (Number(o.trees) >= 1) lines.push(st(L, 'mail.sender.complete.trees', { count: Number(o.trees) }));
  if (o.copy !== 'not-ready' && e.final_sha256)
    lines.push(st(L, o.copy === 'attached' ? 'mail.sender.complete.fingerprint_attached' : 'mail.sender.complete.fingerprint_link', { sha: e.final_sha256, url: `${baseUrl()}/verify`, id: e.id }));
  if (o.impact) lines.push(st(L, 'mail.sender.complete.paper', { count: o.impact.sheets, litres: Math.round(o.impact.litresWater), url: `${baseUrl()}/impact` }));
  const own = (e?.recipients || []).filter((r: any) => r.link_by_sender);
  if (own.length) lines.push(st(L, 'mail.sender.complete.no_address', { names: namesIn(L, own.map((r: any) => r.name)), count: own.length }));
  return { subject: st(L, 'mail.sender.complete.subject', { subject: e.subject }), heading: st(L, 'mail.sender.complete.heading'), lines, cta: { label: st(L, 'mail.sender.open'), url: `${baseUrl()}/app/envelopes/${e.id}` } };
}

/**
 * Where on the document a comment is pinned, in `L`: "page 2, near the top on the left", with the document's name in
 * front when there is more than one (pinWords in src/lib/comments.ts says the same in English).
 */
export function pinIn(L: string, pin: { document_id?: string | null; document?: string | null; page: number; x?: number | null; y?: number | null }, documents = 1): string {
  const page = st(L, 'sender.pin.page', { page: String(pin.page + 1) });
  const spot = pin.x == null || pin.y == null ? '' : `${pin.y < 1 / 3 ? 'top' : pin.y < 2 / 3 ? 'middle' : 'bottom'}${pin.x < 1 / 3 ? '_left' : pin.x < 2 / 3 ? '' : '_right'}`;
  const place = spot ? st(L, `sender.pin.${spot}`, { page }) : page;
  return documents > 1 && pin.document ? st(L, 'sender.pin.in_document', { document: pin.document, place }) : place;
}
