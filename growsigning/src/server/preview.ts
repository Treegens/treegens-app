// "See what each person sees" (README, What is in it). The sender opens the signing page as one person on a draft, an
// envelope that is out, or a template, in a new tab. Nothing there is recorded or sent: no audit line, no "viewed",
// no consent, no signature used, no email or text, and not one row of the database changes.
//
// The link carries a token that holds everything it needs and is signed with the server's secret, so making and
// opening one writes nothing either. It names one envelope or template and one person on it, the login that made it
// and, when it was made in a browser, that browser's session. It opens only for that login, signed in, in that
// browser (a key's maker in any browser of theirs), and only for PREVIEW_MINUTES. The person switch in the page's
// band hands out links for the others with the same end, so switching never makes a preview last longer.
//
// The view itself is the signing page's own (signView in routes-sign.ts, with quiet set), so a preview shows exactly
// what that person would be given: their documents, their fields, the others' values, notes, the consent text in
// their language. The check before the document opens (an access code, a one-time code) is described, not asked.
import type { Ctx } from './router.ts';
import { hmac, safeEqual, bad, baseUrl, HttpError } from './util.ts';
import { twoStepGate } from './twostep.ts';
import { rulesGate } from './secpolicy.ts';
import { loadEnvelope } from './envelopes.ts';
import { limitForLink } from './visibility.ts';
import { PREVIEW_MINUTES, PREVIEW_PREFIX, PREVIEW_NOTHING } from '../lib/preview.ts';
import { t, chooseLocale, shippedLocales } from '../lib/i18n.ts';
import { labelOf } from '../lib/bysender.ts';

type Claim = { e: string; r: string; u: string; s: string; x: number };

const sessionTag = (sessionId: string) => hmac(`preview-session:${sessionId}`).slice(0, 24);
const sign = (body: string) => hmac(`preview:${body}`).slice(0, 43);

function tokenFor(claim: Claim): string {
  const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${PREVIEW_PREFIX}${body}.${sign(body)}`;
}

function readToken(t: string): Claim | null {
  if (typeof t !== 'string' || !t.startsWith(PREVIEW_PREFIX) || t.length > 600) return null;
  const [body, mac] = t.slice(PREVIEW_PREFIX.length).split('.');
  if (!body || !mac || !safeEqual(mac, sign(body))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return c && typeof c.e === 'string' && typeof c.r === 'string' && typeof c.u === 'string' && typeof c.s === 'string' && typeof c.x === 'number' ? c : null;
  } catch {
    return null;
  }
}

const OPEN = (e: any) => e.kind === 'template' || e.status === 'draft' || e.status === 'sent';
const closedWords = (e: any) => `This document is ${e.status}, so there is nothing left to preview. Its page has where it stands and the copy to download.`;

/** The preview link for one person, for whoever may open the envelope or template `e` (the caller checked that). */
export function makePreview(c: Ctx, e: any, recipientId: unknown) {
  if (!OPEN(e)) throw bad(closedWords(e), 409, { code: 'preview_closed' });
  if (typeof recipientId !== 'string' || !recipientId) throw bad('Say whose view to show: "recipient_id", the id of one person on it.');
  const r = e.recipients.find((x: any) => x.id === recipientId);
  if (!r) throw bad('That person is not on this document. If you just added them, wait a moment for the draft to save and try again.', 404);
  const x = Date.now() + PREVIEW_MINUTES * 60_000;
  const claim: Claim = { e: e.id, r: r.id, u: c.user.id, s: c.auth?.via === 'session' && c.auth.sessionId ? sessionTag(c.auth.sessionId) : '', x };
  return { url: `${baseUrl()}/sign/${tokenFor(claim)}`, expires_at: new Date(x).toISOString(), recipient_id: r.id };
}

/**
 * The envelope and person a preview link stands for, after every check, or a refusal in words that say what to do.
 * `mine` is routes-envelopes.ts's own reading rule, so a login that lost the right to the document loses the preview.
 */
export function openPreview(c: Ctx, mine: (c: Ctx, id: string) => any): { e: any; r: any; claim: Claim } {
  const claim = readToken(c.params.token);
  if (!claim) throw bad('This preview link is not complete. Open a new one from the review step with "See what each person sees".', 404, { code: 'preview_unknown' });
  if (claim.x <= Date.now()) throw bad(`This preview has ended. A preview lasts ${PREVIEW_MINUTES} minutes. Open a new one from the review step with "See what each person sees".`, 410, { code: 'preview_expired' });
  const auth = c.auth;
  const notYours = () => bad('This preview opens only for the person who made it, signed in, in the browser they made it in. If you were asked to sign, use the link in the email you were sent.', 403, { code: 'preview_not_yours' });
  if (!auth || auth.via !== 'session' || auth.user?.id !== claim.u) throw notYours();
  if (claim.s && !(auth.sessionId && safeEqual(claim.s, sessionTag(auth.sessionId)))) throw notYours();
  // The same gates as every signed-in page: a team that asks for two-step login, a password the account asks to be longer.
  twoStepGate(auth, 'GET /preview/:token');
  rulesGate(auth, 'GET /preview/:token');
  let e: any;
  try {
    e = mine(c, claim.e);
  } catch (err: any) {
    if (err instanceof HttpError && err.status === 404) throw notYours();
    throw err;
  }
  if (!OPEN(e)) throw bad(closedWords(e), 409, { code: 'preview_closed' });
  const r = e.recipients.find((x: any) => x.id === claim.r);
  if (!r) throw bad('That person is no longer on this document. Open a new preview from the review step.', 404, { code: 'preview_gone' });
  return { e, r, claim };
}

// A draft and a template were never sent, so nobody on them has a turn yet. In the preview each person is shown as on
// the day it is their turn: open to sign, and someone who gets a copy has it. An envelope that is out shows everyone
// as they stand, except that someone still waiting for their turn is shown as when it comes.
function asTheirTurn(e: any): any {
  const unsent = e.kind === 'template' || e.status === 'draft';
  const recipients = e.recipients.map((x: any) => {
    if (x.status !== 'pending' && !unsent) return x;
    const status = x.role === 'cc' ? 'completed' : x.status === 'pending' || unsent ? 'sent' : x.status;
    return { ...x, status, name: x.name || x.role_name || '', ...(unsent ? { consent_at: null, signature_png: null, initials_png: null } : {}) };
  }).map((x: any) => (x.status === 'completed' && !unsent ? x
    // A signature or initials a person adopted but did not put on the document yet are theirs alone: the sender's own
    // API never shows them (publicEnvelope), so neither does the preview.
    : { ...x, signature_png: null, initials_png: null }));
  return { ...e, status: unsent ? 'sent' : e.status, recipients };
}

/**
 * What the preview's band says about this person: their role, the check before the document opens, their turn. In the
 * sender's language (the language of the browser that opened the preview), because the band speaks to the sender.
 * Someone who gets a copy is never asked for anything, so they have no turn line.
 */
function about(e: any, r: any, lang: string) {
  const checks: string[] = [];
  // "on this document", not "you set": an admin who sees all may preview a member's envelope (the member set it).
  if (r.access_code) checks.push(t(lang, 'preview.check.access_code'));
  if (r.verify === 'email_code') checks.push(t(lang, 'preview.check.email_code'));
  if (r.verify === 'sms_code') checks.push(t(lang, 'preview.check.sms_code'));
  const check = checks.length ? t(lang, 'preview.check.before', { checks: checks.reduce((a, b) => t(lang, 'preview.check.then', { a, b })) }) : null;
  const earlier = e.ordered && r.role !== 'cc' ? e.recipients.filter((x: any) => x.id !== r.id && x.role !== 'cc' && x.routing_order < r.routing_order) : [];
  const turn = !earlier.length ? null
    : earlier.length === 1 ? t(lang, 'preview.turn.one', { name: earlier[0].name || earlier[0].role_name || t(lang, 'preview.turn.before_them') })
    : t(lang, 'preview.turn.many');
  const does = t(lang, `preview.role.${r.role}`) || t(lang, 'preview.role.signer');
  // With more than one language shipped, a person with none set sees their own browser's, which the sender cannot know.
  const language = !r.locale && shippedLocales().length > 1 ? t(lang, 'preview.band.language') : null;
  return { check, turn, does, language };
}

const nameOf = (x: any, i: number) => x.name || x.role_name || labelOf(x) || `Person ${i + 1}`;

/** The preview's view: the signing page's own, made quietly, with the band's facts and links for the person switch. */
export function previewView(c: Ctx, opened: { e: any; r: any; claim: Claim }, signView: (c: Ctx, found: any, quiet: boolean) => any) {
  const { claim } = opened;
  // Only the files this person is shown, as their own link would (visibility.ts).
  const e = limitForLink(asTheirTurn(opened.e), opened.r.id);
  const r = e.recipients.find((x: any) => x.id === opened.r.id);
  // The sender's browser language is not the person's: the view is made without it, so a person with no language set
  // is shown in the default, never in the sender's (the band says they may see their own browser's language).
  const senderLang = chooseLocale({ acceptLanguage: c.req?.headers?.get?.('accept-language') });
  const headers = new Headers(c.req?.headers);
  headers.delete('accept-language');
  const req = c.req ? new Request(c.req.url, { method: 'GET', headers }) : c.req;
  const view = signView({ ...c, req } as Ctx, { e, r, locked: false, gate: null, actor: { name: 'Preview', ip: c.ip, ua: c.ua } }, true);
  // A stamp picture goes by the sender's own route: the preview token is no signing link (stamps.ts).
  const tokenPart = `/api/sign/${c.params.token}/stamp-image/`;
  for (const o of view.others || []) if (typeof o.image === 'string' && o.image.startsWith(tokenPart)) o.image = `/api/envelopes/${e.id}/stamp-image/${o.image.slice(tokenPart.length)}`;
  // Nothing on a preview checks the link again after a break: there is nothing to keep safe in it (sign/away.ts).
  delete view.away_minutes;
  delete view.help_code;
  const people = [...e.recipients].sort((a: any, b: any) => (a.routing_order - b.routing_order) || (a.position - b.position)).map((x: any, i: number) => ({
    id: x.id, name: nameOf(x, i), role: x.role,
    token: x.id === r.id ? c.params.token : tokenFor({ ...claim, r: x.id }),
  }));
  return {
    ...view,
    preview: {
      expires_at: new Date(claim.x).toISOString(),
      kind: opened.e.kind === 'template' ? 'template' : opened.e.status === 'draft' ? 'draft' : 'envelope',
      envelope_id: e.id,
      person: { id: r.id, name: nameOf(r, e.recipients.indexOf(r)), role: r.role },
      ...about(e, r, senderLang),
      people,
      nothing: PREVIEW_NOTHING,
    },
  };
}

/** The answer to anything on a preview that would change something. */
export const previewRefusal = () => bad(PREVIEW_NOTHING, 403, { code: 'preview' });
