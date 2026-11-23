// Signing inside a customer's own website, and the sender's screen inside their app.
//
// An admin lists up to 5 https websites under Settings, Developers (embed_origins). Then:
//   - POST /envelopes/{id}/recipient-view with "frame_origin" gives a signing link that only that website may show
//     in a frame (embed_views). src/proxy.ts asks frameAncestors() for the Content-Security-Policy of every signing
//     page: the one website for such a link, our own pages for every other one. Never "*".
//   - POST /envelopes/{id}/sender-view gives a link to the editor of one draft, without the app's menus, that opens
//     once within 5 minutes. Opening it starts a session for that draft alone (Bearer tse_...), which ends after an
//     hour, when the draft is sent or when the screen is closed. Only the listed websites may frame it.
// The signing page tells the website around it what happened (postMessage, to that website only), and the audit
// trail says "Signed inside a frame on <website>".
import { get, all, run } from './db.ts';
import { bad, baseUrl, now, sha256, token, str, HttpError } from './util.ts';
import { audit, signUrl, type Actor } from './envelopes.ts';
import { record } from './seclog.ts';
import type { Ctx } from './router.ts';
import { EMBED_ORIGINS_MAX, SENDER_VIEW_MINUTES, SENDER_SESSION_MINUTES, FRAME_NO_CODES, readOrigin, readTypedOrigin } from '../lib/embed.ts';
import { isCodeCheck } from '../lib/checks.ts';

// ---- The websites ----------------------------------------------------------------------------------------------

// A website on this computer (http://localhost) only counts on a server on this computer. One listed before that rule
// was kept, or on a copy of the database moved to a live server, is never shown, never counted and never frames a page.
const localServer = () => /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl());
const usable = (origin: string) => !String(origin).startsWith('http:') || localServer();
export const originsOf = (accountId: string): string[] => all('SELECT origin FROM embed_origins WHERE account_id=? ORDER BY added_at, origin', accountId).map((r) => r.origin).filter(usable);
/** Rows kept from before that rule, or from a copied database, that do nothing on this server: shown so an admin can remove them. */
export const unusedOriginsOf = (accountId: string): string[] => all('SELECT origin FROM embed_origins WHERE account_id=? ORDER BY added_at, origin', accountId).map((r) => r.origin).filter((o) => !usable(o));
export const isListed = (accountId: string, origin: string) => usable(origin) && !!get('SELECT 1 x FROM embed_origins WHERE account_id=? AND origin=?', accountId, origin);

export function addOrigin(c: Ctx, raw: unknown): string[] {
  const accountId = c.account.id;
  const o = readTypedOrigin(raw);
  if ('why' in o) throw bad(`That website was not added. ${o.why}`);
  // A website on this computer (http://localhost) is for trying it out, so only a server on this computer takes it.
  if (!usable(o.origin)) throw bad('That website was not added. An address that starts with http://localhost is only for trying this out on your own computer. Type the address of your website with https:// in front.');
  if (isListed(accountId, o.origin)) return originsOf(accountId);
  if (originsOf(accountId).length >= EMBED_ORIGINS_MAX) throw bad(`You can list up to ${EMBED_ORIGINS_MAX} websites, and ${EMBED_ORIGINS_MAX} are listed. Remove one first, then add this one.`);
  run('INSERT INTO embed_origins (account_id, origin, added_by, added_at) VALUES (?,?,?,?)', accountId, o.origin, c.actor.name, now());
  record('settings.changed', { c, about: ['embed_origin', o.origin], details: { settings: { embed_origins: { changed: true } }, change: `added ${o.origin}` } });
  return originsOf(accountId);
}

export function removeOrigin(c: Ctx, raw: unknown): string[] {
  const accountId = c.account.id;
  const o = readOrigin(raw);
  const origin = 'origin' in o ? o.origin : String(raw || '');
  if (run('DELETE FROM embed_origins WHERE account_id=? AND origin=?', accountId, origin).changes)
    record('settings.changed', { c, about: ['embed_origin', origin], details: { settings: { embed_origins: { changed: true } }, change: `removed ${origin}` } });
  return originsOf(accountId);
}

/** A website the caller named, which has to be one of the account's list. */
function listedOrigin(accountId: string, raw: unknown, what: string): string {
  const o = readOrigin(raw);
  if ('why' in o) throw bad(`${what}: ${o.why}`);
  if (!isListed(accountId, o.origin)) throw bad(`${o.origin} is not one of the websites that may show your pages. An admin adds it under Settings, Developers, Signing inside your site.`, 403, { code: 'origin_not_listed' });
  return o.origin;
}

// ---- Signing inside a website ------------------------------------------------------------------------------------

/** The signing link of one recipient for a frame on a listed website. */
export function framedLink(e: any, r: any, raw: unknown): string {
  if (r.group_name) throw bad('A group cannot sign inside a frame yet, because each member has a link of their own. Send the group its links by email, or name one person.');
  const origin = listedOrigin(e.account_id, raw, '"frame_origin"');
  // A browser keeps no cookie for a page inside a frame on another website, and that is how the page remembers a
  // code that was typed. The person would type the right code and be asked for it again, so the link is not made.
  const gate = get('SELECT access_code, verify FROM recipients WHERE id=?', r.id);
  if (gate?.access_code || isCodeCheck(gate?.verify)) throw bad(FRAME_NO_CODES, 400, { code: 'frame_with_code' });
  run('INSERT OR IGNORE INTO embed_views (recipient_id, origin, at) VALUES (?,?,?)', r.id, origin, now());
  return `${signUrl(r)}?embed=1&origin=${encodeURIComponent(origin)}`;
}

/** The website a signing page may be framed by, or null: a link handed out for it, on a website still listed. */
function framingSite(tok: string, origin: string | null): string | null {
  if (!origin || !/^[A-Za-z0-9_-]{10,100}$/.test(tok)) return null;
  const r = get('SELECT r.id, e.account_id FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.token=?', tok);
  if (!r) return null;
  return get('SELECT 1 x FROM embed_views WHERE recipient_id=? AND origin=?', r.id, origin) && isListed(r.account_id, origin) ? origin : null;
}

/**
 * The Content-Security-Policy frame-ancestors of a page, for src/proxy.ts. A signing page opened with ?embed=1 and
 * the website it was handed out for may be shown by that website; the sender screen by the website it was made for.
 * Everything else only by our own pages. Null for a page this file does not decide about.
 */
export function frameAncestors(pathname: string, search: URLSearchParams): string | null {
  const sign = /^\/sign\/([^/]+)\/?$/.exec(pathname);
  if (sign) {
    const site = search.get('embed') === '1' ? framingSite(decodeURIComponent(sign[1]), search.get('origin')) : null;
    return site ? `frame-ancestors ${site}` : "frame-ancestors 'self'";
  }
  const send = /^\/embed\/send\/([^/]+)\/?$/.exec(pathname);
  if (send) {
    const v = get('SELECT account_id, origin, ended_at, expires_at, session_expires_at FROM sender_views WHERE id=?', sha256(decodeURIComponent(send[1])));
    const live = v && !v.ended_at && (v.session_expires_at || v.expires_at) > now() && isListed(v.account_id, v.origin);
    return live ? `frame-ancestors ${v.origin}` : "frame-ancestors 'none'";
  }
  return null;
}

/** After Finish: the audit line that says the page was inside a frame, when the page says so and the link was made for it. */
export function noteFramed(e: any, r: any, raw: unknown, actor: Actor, verb = 'Signed') {
  if (raw == null || raw === '') return;
  const o = readOrigin(raw);
  if (!('origin' in o) || !get('SELECT 1 x FROM embed_views WHERE recipient_id=? AND origin=?', r.id, o.origin)) return;
  audit(e.id, actor, `${verb} inside a frame on ${o.origin}`, `${r.name}${r.email ? ` <${r.email}>` : ''}`);
}

// ---- The sender screen inside an app ----------------------------------------------------------------------------

/** A link to the editor of one draft, for a frame on a listed website. It opens once, within 5 minutes. */
export function makeSenderView(e: any, userId: string, body: any): { url: string; expires_at: string } {
  if (e.kind !== 'envelope' || e.status !== 'draft') throw bad('The sender screen is for a draft, and this envelope has been sent already. Make a new draft, or copy this one with POST /envelopes/{id}/clone.', 409);
  let ret: URL;
  try {
    ret = new URL(String(body.return_url || ''));
  } catch {
    throw bad('"return_url" is missing or is not a web address. Send the page of your app the screen goes back to, such as https://portal.example.org/done.');
  }
  const origin = listedOrigin(e.account_id, ret.origin, '"return_url"');
  if (body.frame_origin != null && listedOrigin(e.account_id, body.frame_origin, '"frame_origin"') !== origin) throw bad('"frame_origin" and "return_url" are on different websites. Send a return_url on the website that shows the screen.');
  const ticket = token(32);
  const expires = new Date(Date.now() + SENDER_VIEW_MINUTES * 60_000).toISOString();
  run('INSERT INTO sender_views (id, account_id, user_id, envelope_id, origin, return_url, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)', sha256(ticket), e.account_id, userId, e.id, origin, str(ret.href, 2000), now(), expires);
  return { url: `${baseUrl()}/embed/send/${ticket}`, expires_at: expires };
}

const GONE = 'This link to the sender screen was opened already, or it is more than 5 minutes old. Go back to the app you came from and open the screen again.';

/** Opening the link: once, within its 5 minutes. Answers the session the page uses from then on. */
export function openSenderView(ticket: unknown) {
  const id = sha256(String(ticket || ''));
  const session = `tse_${token(32)}`;
  const until = new Date(Date.now() + SENDER_SESSION_MINUTES * 60_000).toISOString();
  // One statement decides, so two tabs opening the same link at the same moment get one session between them.
  const took = run('UPDATE sender_views SET used_at=?, session_hash=?, session_expires_at=? WHERE id=? AND used_at IS NULL AND expires_at > ?', now(), sha256(session), until, id, now()).changes;
  if (!took) throw bad(GONE, 410, { code: 'sender_view_used' });
  const v = get('SELECT * FROM sender_views WHERE id=?', id);
  const e = get('SELECT status FROM envelopes WHERE id=?', v.envelope_id);
  if (!e || e.status !== 'draft') {
    run('UPDATE sender_views SET ended_at=? WHERE id=?', now(), id);
    throw bad('This draft has been sent or deleted since the link was made, so there is nothing to change here. Go back to the app you came from.', 410, { code: 'sender_view_used' });
  }
  return { session, envelope_id: v.envelope_id, origin: v.origin, return_url: v.return_url, expires_at: until };
}

/** The session of an open sender screen, for authenticate() in auth.ts. Null when it is not one, or has ended. */
export function senderSession(bearer: string) {
  const v = get('SELECT * FROM sender_views WHERE session_hash=? AND ended_at IS NULL AND session_expires_at > ?', sha256(bearer), now());
  if (!v) throw new HttpError(401, 'This sender screen has ended: it was closed, the draft was sent, or an hour went by. Go back to the app you came from and open it again.', { code: 'sender_view_ended' });
  const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', v.account_id, v.user_id);
  if (!m) throw new HttpError(401, 'The person this draft belongs to is no longer in the account, so the sender screen cannot open. Ask an admin of the account.');
  return { user: get('SELECT * FROM users WHERE id=?', v.user_id), account: get('SELECT * FROM accounts WHERE id=?', v.account_id), role: m.role, envelopeId: v.envelope_id as string, viewId: v.id as string };
}

/** Ends the screen: closed or sent. Answers where the page goes back to. */
export function endSenderView(viewId: string) {
  run('UPDATE sender_views SET ended_at=COALESCE(ended_at, ?) WHERE id=?', now(), viewId);
  const v = get('SELECT envelope_id, return_url, origin FROM sender_views WHERE id=?', viewId);
  const e = v && get('SELECT status FROM envelopes WHERE id=?', v.envelope_id);
  return { return_url: v?.return_url, origin: v?.origin, event: e && e.status !== 'draft' ? 'sent' : 'closed' };
}

/** POST /files: a file the sender screen uploaded is one it may read back (assertEmbedRoute). Answers the file. */
export function noteScreenUpload<T extends { id: string }>(c: Ctx, file: T): T {
  if (c.auth?.via === 'embed' && c.auth.viewId) run('INSERT OR IGNORE INTO sender_view_files (view_id, file_id) VALUES (?,?)', c.auth.viewId, file.id);
  return file;
}

/** POST /envelopes/{id}/send from the sender screen: the screen ends with the send, on the server too. */
export function endScreenOnSend(c: Ctx) {
  if (c.auth?.via === 'embed' && c.auth.viewId) run('UPDATE sender_views SET ended_at=COALESCE(ended_at, ?) WHERE id=?', now(), c.auth.viewId);
}

// What the sender screen may do: the editor's own calls for its one draft, and nothing else. A route is named as the
// router names it; ":id" must be the draft's id.
const EMBED_ROUTES = new Set([
  'GET /me', 'GET /contacts', 'GET /groups', 'GET /custom-fields', 'GET /stamps', 'POST /print-check', 'POST /files', 'GET /files/:id/content',
  'GET /envelopes/:id', 'PUT /envelopes/:id', 'POST /envelopes/:id/send', 'GET /envelopes/:id/warnings', 'GET /envelopes/:id/custom-fields', 'POST /embed/sender/close',
]);
const DRAFT_ONLY = new Set(['PUT /envelopes/:id', 'POST /envelopes/:id/send']);

/** Refuses a call of the sender screen that is not about its own draft. For the router. */
export function assertEmbedRoute(auth: { envelopeId?: string; viewId?: string; account?: any }, method: string, path: string, params: Record<string, string>) {
  const what = `${method} ${path}`;
  const refuse = () => new HttpError(403, 'The sender screen can only change the one draft it was opened for. Open the app itself for anything else.', { code: 'sender_view_scope' });
  if (!EMBED_ROUTES.has(what)) throw refuse();
  if (path.startsWith('/envelopes/:id') && params.id !== auth.envelopeId) throw refuse();
  if (what === 'GET /files/:id/content') {
    // A file of this draft, or one this screen uploaded itself. Never a colleague's upload, however new.
    const ok = get('SELECT 1 x FROM documents WHERE envelope_id=? AND file_id=?', auth.envelopeId, params.id)
      || get('SELECT 1 x FROM sender_view_files WHERE view_id=? AND file_id=?', auth.viewId, params.id);
    if (!ok) throw refuse();
  }
  if (DRAFT_ONLY.has(what) && get('SELECT status FROM envelopes WHERE id=?', auth.envelopeId)?.status !== 'draft') throw new HttpError(409, 'This draft was sent already, so the sender screen cannot change it. Go back to the app you came from.', { code: 'sender_view_sent' });
}
