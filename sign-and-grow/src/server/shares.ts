import { get, run, all, tx } from './db.ts';
import { bad, id, now, str, isEmail } from './util.ts';
import { audit, type Actor } from './envelopes.ts';
import { record } from './seclog.ts';
import { can } from './perm.ts';
import type { Ctx } from './router.ts';
import { todayIn } from '../lib/delegation.ts';
import { isShareLevel, levelCovers, levelRefusal, shareDatesProblem, forActor, movedLine, LEVEL_WORDS, type ShareLevel } from '../lib/shares.ts';

// Working for a colleague: shared access, moving documents, and sending for someone.
//
// Sharing. A member shares the envelopes they send with one colleague in the same account (shares), at a level:
// 'see' (open them and read their history), 'manage' (also remind, correct, give more time, pause, send an email
// again, cancel, download) or 'send' (also make, change and send drafts and templates in their name). From a start
// day to an optional end day, in the owner's own time zone. The owner, the colleague and an admin of the team can end
// it, at once: the very next request is refused. A share stops by itself when either person leaves the account.
// Never across accounts.
//
// How it is held. Every route that opens one envelope goes through mine() in routes-envelopes.ts. When the envelope
// is not the person's own and they cannot see the whole account, mine() asks shareFor() here, which finds an active
// share and decides from the request (NEEDS below) which level it needs. Anything not on that list is refused for a
// colleague, so a route added later is closed to them until someone decides otherwise.
//
// Naming. While a request works through a share, c.actor reads "Ana Silva <ana@x> for Ben Okoro", so every audit line
// it writes names both, and the security record gets a "for" detail (seclog.ts reads c.actingFor).
//
// Sending for someone. POST /envelopes with "on_behalf_of" (a member's id or address) makes the envelope theirs:
// with a 'send' share from them, or from an API key with the admin scope. envelopes.sent_by_id keeps who pressed
// Send, so recipients read "Ben Okoro (sent by Ana Silva)" in emails (sentfor.ts), on the signing page and on the
// certificate. Nobody can send so that who pressed Send is hidden.
//
// Moving. The person an envelope or a template belongs to, or an admin, moves it to another member. The audit trail
// says "Moved from Ben to Ana by <who>"; original_sender_id keeps the first sender for the certificate.

const lower = (s: any) => String(s ?? '').trim().toLowerCase();
const nameOf = (userId: string) => get('SELECT name, email FROM users WHERE id=?', userId) || { name: 'A former member', email: '' };
const memberOf = (accountId: string, userId: string) => !!get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', accountId, userId);
const ownToday = (userId: string) => todayIn(get('SELECT tz FROM users WHERE id=?', userId)?.tz);

/** When this person joined the account this time, or null when they are not in it. */
const joinedAt = (accountId: string, userId: string): string | null => get('SELECT created_at FROM memberships WHERE account_id=? AND user_id=?', accountId, userId)?.created_at || null;

/**
 * Whether a share is in force today: not ended, its days have come and not gone, and both people still in the account
 * on the same membership they had when it was given. Someone who left and was invited back joined again later than
 * the share, so an old share never comes back with them (leaving also ends it: endSharesOf, from handOver).
 */
export function isActive(s: any): boolean {
  if (!s || s.ended_at) return false;
  const today = ownToday(s.owner_id);
  if (s.starts_on > today || (s.ends_on && s.ends_on < today)) return false;
  const o = joinedAt(s.account_id, s.owner_id), g = joinedAt(s.account_id, s.grantee_id);
  return !!o && !!g && o <= s.created_at && g <= s.created_at;
}

/**
 * The drafts a colleague made and handed to the owner with "Send for", not sent and not set to go later, go back to
 * whoever made them when the share between the two ends. Otherwise the maker could no longer open their own work.
 */
function returnDrafts(accountId: string, ownerId: string, granteeId: string) {
  run("UPDATE envelopes SET sender_id=made_for_by, made_for_by=NULL, sent_by_id=NULL, updated_at=? WHERE account_id=? AND sender_id=? AND made_for_by=? AND kind='envelope' AND status='draft' AND send_at IS NULL",
    now(), accountId, ownerId, granteeId);
}

/** A draft this person made in a colleague's name (POST /envelopes with on_behalf_of): theirs to take back. */
export function noteMadeFor(c: Ctx, envelopeId: string) {
  if (c.user) run("UPDATE envelopes SET made_for_by=? WHERE id=? AND status='draft' AND sender_id!=?", c.user.id, envelopeId, c.user.id);
}

/**
 * Someone leaves the account (removed, left, or closed their login): every share they gave or received there ends
 * now, for good. Called by handOver in routes-trust.ts, inside its transaction, before their documents move on.
 */
export function endSharesOf(accountId: string, userId: string) {
  const open = all('SELECT * FROM shares WHERE account_id=? AND (owner_id=? OR grantee_id=?) AND ended_at IS NULL', accountId, userId, userId);
  if (!open.length) return;
  const at = now();
  for (const s of open) {
    returnDrafts(accountId, s.owner_id, s.grantee_id);
    run('UPDATE shares SET ended_at=?, ended_by=NULL WHERE id=? AND ended_at IS NULL', at, s.id);
    record('share.ended', { accounts: accountId, about: ['user', s.grantee_id], details: { shared_by: nameOf(s.owner_id).name, shared_with: nameOf(s.grantee_id).name, level: LEVEL_WORDS[s.level as ShareLevel]?.name || s.level, why: 'left the account' } });
  }
}

/** The share from owner to grantee in an account that is not ended (it may not have started yet), or null. */
const openShare = (accountId: string, ownerId: string, granteeId: string) =>
  get('SELECT * FROM shares WHERE account_id=? AND owner_id=? AND grantee_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', accountId, ownerId, granteeId);

/** The ids of the people who share their documents with this person today, at least at `need`. */
export function ownersSharingWith(c: Ctx, need: ShareLevel = 'see'): string[] {
  return all('SELECT * FROM shares WHERE account_id=? AND grantee_id=? AND ended_at IS NULL', c.account.id, c.user.id)
    .filter((s) => isActive(s) && levelCovers(s.level, need)).map((s) => s.owner_id as string);
}

/** Each colleague who shares their documents with this person today, and at which level: for the Documents list. */
export function shareLevelsWith(c: Ctx): Record<string, ShareLevel> {
  const out: Record<string, ShareLevel> = {};
  for (const s of all('SELECT * FROM shares WHERE account_id=? AND grantee_id=? AND ended_at IS NULL', c.account.id, c.user.id)) if (isActive(s)) out[s.owner_id] = s.level;
  return out;
}

// What each request needs of a share. Matched on the method and the path as the caller sent it. Not listed: refused.
const NEEDS: [RegExp, ShareLevel][] = [
  // What shows the document's contents: the files, a summary of them, a stamp's picture. Not at 'see'.
  [/^GET \/envelopes\/[^/]+\/(download|evidence|ai-summary|stamp-image\/[^/]+)$/, 'manage'],
  [/^GET \/envelopes\/[^/]+(\/[^/]+)*$/, 'see'],
  // The file itself, like a download: not at 'see', which follows the document without opening it.
  [/^GET \/files\/[^/]+\/content$/, 'manage'],
  [/^POST \/envelopes\/[^/]+\/recipient-preview$/, 'see'],
  [/^POST \/envelopes\/[^/]+\/(remind|correct|void|extend|try-again|pause|resume|comments)$/, 'manage'],
  [/^POST \/envelopes\/[^/]+\/comments\/[^/]+\/settle$/, 'manage'],
  [/^POST \/envelopes\/[^/]+\/(send|send-later)$/, 'send'],
  [/^DELETE \/envelopes\/[^/]+\/send-later$/, 'send'],
  [/^PUT \/envelopes\/[^/]+$/, 'send'],
  [/^PUT \/envelopes\/[^/]+\/(custom-fields|only-named)$/, 'send'],
  [/^POST \/envelopes\/[^/]+\/documents\/[^/]+\/pages$/, 'send'],
  // A retry of POST /envelopes with the same Idempotency-Key finds the envelope it made for the colleague.
  [/^POST \/envelopes$/, 'send'],
];
const pathOf = (c: Ctx) => c.url.pathname.replace(/^\/api/, '') || '/';
function needOf(c: Ctx, e: any): ShareLevel | null {
  const what = `${c.req.method} ${pathOf(c)}`;
  const hit = NEEDS.find(([re]) => re.test(what));
  if (!hit) return null;
  // Saving a sent envelope is a correction: that is managing it, not sending.
  if (hit[1] === 'send' && c.req.method === 'PUT' && e.status !== 'draft') return 'manage';
  return hit[1];
}

/** Marks the request as done for `owner`: the audit trail and the security record name both people from here on. */
function actFor(c: Ctx, ownerId: string, level: ShareLevel | 'key') {
  const o = nameOf(ownerId);
  const x = c as any;
  x.actingFor = o.name;
  x.share = { owner_id: ownerId, owner: o.name, level };
  c.actor = { ...c.actor, name: forActor(`${c.user.name} <${c.user.email}>`, o.name) };
}

/**
 * Called by mine() for an envelope that is not this person's own and that they cannot see as an admin. True when a
 * share lets this request through (and the request is then marked as done for its owner); false when there is no
 * share, so mine() answers "not found" as before; refused in words when a share exists but its level is too low.
 */
export function shareFor(c: Ctx, e: any): boolean {
  if (!c.user || e.kind !== 'envelope' || c.auth?.via === 'embed') return false;
  const s = openShare(c.account.id, e.sender_id, c.user.id);
  if (!s || !isActive(s)) return false;
  const need = needOf(c, e);
  const owner = nameOf(e.sender_id).name;
  if (!need) throw bad(`${owner} shared their documents with you, but this is something only ${owner} or an admin can do. Ask ${owner} to do it, or ask an admin.`, 403, { code: 'not_in_share' });
  if (!levelCovers(s.level, need)) throw bad(levelRefusal(owner, s.level, need), 403, { code: 'share_level', level: s.level, needs: need });
  actFor(c, e.sender_id, s.level);
  return true;
}

/** What the envelope page needs to know: whose it is when it came through a share, and who sent it for whom. */
export function shareFacts(c: Ctx, e: any) {
  const x = (c as any).share;
  const by = e.sent_by_id && e.sent_by_id !== e.sender_id ? nameOf(e.sent_by_id).name : null;
  const first = e.original_sender_id && e.original_sender_id !== e.sender_id ? nameOf(e.original_sender_id).name : null;
  return {
    ...(x && x.level !== 'key' ? { shared: { owner: x.owner, level: x.level } } : {}),
    ...(by ? { sent_by_name: by, sent_for_name: nameOf(e.sender_id).name } : {}),
    ...(first ? { first_sender_name: first } : {}),
  };
}

// ---- Sending for someone ----------------------------------------------------------------------------------------

/**
 * "on_behalf_of" on POST /envelopes: the id or the address of the member the new envelope or template belongs to.
 * Answers that member's id, or null when the body does not ask. Refused when the caller may not send for them.
 */
export function sendForOf(c: Ctx, b: any): string | null {
  const v = str(b?.on_behalf_of, 200).trim();
  if (!v) return null;
  const m = get(`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND (u.id=? OR lower(u.email)=?)`, c.account.id, v, isEmail(v) ? lower(v) : '');
  if (!m) throw bad(`"on_behalf_of" is "${str(v, 80)}", which is nobody in this account. Use the id or the email address of a member. Nothing was created.`);
  if (m.id === c.user.id) return null;
  const key = c.auth?.via === 'api_key' && c.auth.scope === 'admin';
  if (key) {
    actFor(c, m.id, 'key');
    return m.id;
  }
  const s = openShare(c.account.id, m.id, c.user.id);
  if (!s || !isActive(s) || !levelCovers(s.level, 'send')) {
    throw bad(`${m.name} has not shared sending with you${s && isActive(s) ? ` (they shared their documents with you to ${LEVEL_WORDS[s.level as ShareLevel].name.toLowerCase()})` : ''}, so you cannot send in their name. Ask ${m.name} to share their documents with you as "Send for me". Nothing was created.`, 403, { code: 'not_shared' });
  }
  actFor(c, m.id, 'send');
  return m.id;
}

/** Who pressed Send, kept on the envelope just before it is sent. NULL when it is the person it belongs to. */
export function noteSentBy(c: Ctx, envelopeId: string) {
  if (!c.user) return;
  run('UPDATE envelopes SET sent_by_id=CASE WHEN sender_id=? THEN NULL ELSE ? END, sent_for_id=CASE WHEN sender_id=? THEN NULL ELSE sender_id END WHERE id=?', c.user.id, c.user.id, c.user.id, envelopeId);
}

// ---- Sharing ----------------------------------------------------------------------------------------------------

const view = (s: any) => {
  const o = nameOf(s.owner_id), g = nameOf(s.grantee_id);
  return {
    id: s.id, owner: { id: s.owner_id, name: o.name, email: o.email }, grantee: { id: s.grantee_id, name: g.name, email: g.email },
    level: s.level, starts_on: s.starts_on, ends_on: s.ends_on || null, created_at: s.created_at,
    active: isActive(s), waiting: !s.ended_at && s.starts_on > ownToday(s.owner_id),
  };
};

/** The shares this person gave and received in this account, and, for an admin of the team, every share in it. */
export function sharesOf(c: Ctx) {
  const open = all('SELECT * FROM shares WHERE account_id=? AND ended_at IS NULL ORDER BY created_at DESC', c.account.id)
    .filter((s) => !s.ends_on || s.ends_on >= ownToday(s.owner_id));
  const members = all('SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.id!=? ORDER BY u.name', c.account.id, c.user.id);
  return {
    given: open.filter((s) => s.owner_id === c.user.id).map(view),
    received: open.filter((s) => s.grantee_id === c.user.id).map(view),
    ...(can(c, 'team') ? { all: open.map(view) } : {}),
    colleagues: members,
  };
}

/** A member shares their documents with a colleague. A share to the same colleague that is still open is replaced. */
export function giveShare(c: Ctx, b: any) {
  const to = str(b?.grantee, 200).trim();
  const g = to && get('SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND (u.id=? OR lower(u.email)=?)', c.account.id, to, lower(to));
  if (!g) throw bad('Choose a colleague from this account to share with. Sharing works only inside one account. Nothing was shared.');
  if (g.id === c.user.id) throw bad('That is you. Choose a colleague to share with. Nothing was shared.');
  if (!isShareLevel(b?.level)) throw bad('Choose what they may do: "see", "manage" or "send". Nothing was shared.');
  if (!get('SELECT email_verified v FROM users WHERE id=?', c.user.id)?.v) throw bad('Confirm your email address first: we sent you a link. Then share again. Nothing was shared.', 403);
  const today = ownToday(c.user.id);
  const from = b?.starts_on == null || b.starts_on === '' ? today : str(b.starts_on, 20);
  const until = b?.ends_on == null || b.ends_on === '' ? null : str(b.ends_on, 20);
  const problem = shareDatesProblem(from, until, today);
  if (problem) throw bad(`${problem} Nothing was shared.`);
  const s = { id: id('shr'), account_id: c.account.id, owner_id: c.user.id, grantee_id: g.id, level: b.level as ShareLevel, starts_on: from, ends_on: until, created_at: now(), created_by: c.user.id };
  tx(() => {
    run('UPDATE shares SET ended_at=?, ended_by=? WHERE account_id=? AND owner_id=? AND grantee_id=? AND ended_at IS NULL', now(), c.user.id, c.account.id, c.user.id, g.id);
    run('INSERT INTO shares (id, account_id, owner_id, grantee_id, level, starts_on, ends_on, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      s.id, s.account_id, s.owner_id, s.grantee_id, s.level, s.starts_on, s.ends_on, s.created_at, s.created_by);
    record('share.given', { c, about: ['user', g.id], details: { shared_with: g.name, level: LEVEL_WORDS[s.level].name, starts: s.starts_on, ends: s.ends_on || 'when ended' } });
  });
  return { share: view(s) };
}

/** Ends a share at once: for the person who shared, the colleague who received it, and an admin of the team. */
export function endShare(c: Ctx, shareId: string) {
  const s = get('SELECT * FROM shares WHERE id=? AND account_id=?', shareId, c.account.id);
  if (!s || (s.owner_id !== c.user.id && s.grantee_id !== c.user.id && !can(c, 'team'))) throw bad('That share was not found. It may have been ended already. Open Settings again to see the shares there are.', 404);
  if (s.ended_at) return { ok: true, ended_at: s.ended_at };
  const at = now();
  tx(() => {
    run('UPDATE shares SET ended_at=?, ended_by=? WHERE id=? AND ended_at IS NULL', at, c.user.id, s.id);
    returnDrafts(c.account.id, s.owner_id, s.grantee_id);
  });
  record('share.ended', { c, about: ['user', s.grantee_id], details: { shared_by: nameOf(s.owner_id).name, shared_with: nameOf(s.grantee_id).name, level: LEVEL_WORDS[s.level as ShareLevel]?.name || s.level } });
  return { ok: true, ended_at: at };
}

// ---- Moving ---------------------------------------------------------------------------------------------------

/**
 * Moves envelopes and templates to another member. Each must be in this account, and the caller must be the person
 * it belongs to or an admin who sees every document (for a template: who may change any template). All or nothing:
 * one that may not be moved stops the whole call, and the answer names it.
 */
export function moveEnvelopes(c: Ctx, ids: unknown, toWho: unknown, max = 500): { moved: number } {
  const actor: Actor = c.actor;
  const list = Array.isArray(ids) ? [...new Set(ids.map((x) => str(x, 80)).filter(Boolean))] : [];
  if (!list.length) throw bad('Choose at least one document or template to move. Nothing was moved.');
  if (list.length > max) throw bad('That is more than 500 at once. Move them in smaller groups. Nothing was moved.');
  const to = str(toWho, 200).trim();
  const target = to && get('SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND (u.id=? OR lower(u.email)=?)', c.account.id, to, lower(to));
  if (!target) throw bad('Choose a member of this account to move them to. Nothing was moved.');
  const rows = list.map((eid) => get('SELECT id, kind, status, subject, sender_id, original_sender_id, hidden_at FROM envelopes WHERE id=? AND account_id=?', eid, c.account.id));
  for (const [i, e] of rows.entries()) {
    if (!e) throw bad(`Document ${list[i]} was not found in this account. Nothing was moved.`, 404);
    const own = e.sender_id === c.user.id;
    const admin = e.kind === 'template' ? can(c, 'edit_any_template') : can(c, 'see_all');
    // Said without its subject: someone who may not see it learns nothing about it here.
    // Deleted by its sender after somebody signed (hidden_at): gone for them, so only an admin may still move it.
    if ((!own && !admin) || (e.hidden_at && !can(c, 'see_all'))) throw bad(`Document ${e.id} was not found among yours. Only the person it belongs to, or an admin, can move it. Nothing was moved.`, 404);
    if (e.sender_id === target.id) throw bad(`"${e.subject || 'Untitled'}" already belongs to ${target.name}. Leave it out and try again. Nothing was moved.`);
  }
  tx(() => {
    for (const e of rows) {
      const from = nameOf(e.sender_id);
      run('UPDATE envelopes SET original_sender_id=COALESCE(original_sender_id, sender_id), sender_id=?, updated_at=? WHERE id=?', target.id, now(), e.id);
      if (e.kind === 'envelope') audit(e.id, actor, 'Moved', movedLine(`${from.name} <${from.email}>`, `${target.name} <${target.email}>`, actor.name));
      record('envelope.moved', { c, about: [e.kind === 'template' ? 'template' : 'envelope', e.id], details: { from: from.name, to: target.name } });
    }
  });
  return { moved: rows.length };
}

/** What "Move a member's documents" would move, counted, so the admin is asked with the numbers first. */
export function moveCountOf(c: Ctx, memberId: string) {
  if (!memberOf(c.account.id, memberId)) throw bad('That person is not a member of this account. Nothing was moved.', 404);
  const n = (kind: string) => get('SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND sender_id=? AND kind=?', c.account.id, memberId, kind).n as number;
  return { documents: n('envelope'), templates: n('template') };
}

/** Settings, Team: every document and template of one member, moved to another. For admins of the team. */
export function moveAllOf(c: Ctx, memberId: string, toWho: unknown) {
  if (!memberOf(c.account.id, memberId)) throw bad('That person is not a member of this account. Nothing was moved.', 404);
  const ids = all("SELECT id FROM envelopes WHERE account_id=? AND sender_id=? AND kind IN ('envelope','template')", c.account.id, memberId).map((r) => r.id);
  if (!ids.length) return { moved: 0 };
  return moveEnvelopes(c, ids, toWho, Infinity);
}

/** The colleagues who share sending with this person today: step 3's "Send for <name>" lists them. */
export const sendsFor = (c: Ctx) => ownersSharingWith(c, 'send').map((id) => ({ id, name: nameOf(id).name }));

/**
 * Step 3's "Send for <name>" on a draft this person made: the draft becomes the colleague's, and who made it is kept
 * (sent_by_id). "on_behalf_of" empty takes it back. Only on a draft, and only by whoever made it.
 */
export function setSendFor(c: Ctx, envelopeId: string, b: any) {
  const e = get("SELECT id, kind, status, sender_id, made_for_by, account_id FROM envelopes WHERE id=? AND account_id=?", envelopeId, c.account.id);
  // Who made it: a colleague who handed it over (made_for_by), else its owner. Never whoever last pressed Send on it
  // (sent_by_id): a failed Send on a colleague's own draft must not make it theirs to take.
  const maker = e && (e.made_for_by || e.sender_id);
  if (!e || e.kind !== 'envelope' || maker !== c.user.id) throw bad('That draft was not found among yours. Only the person who made a draft can choose whom it is sent for. Nothing was changed.', 404);
  if (e.status !== 'draft') throw bad('It has been sent already, so whom it is from stays as it is. Copy it to send a new one for someone else.', 409);
  const forId = str(b?.on_behalf_of, 200).trim() ? sendForOf(c, b) : null;
  const owner = forId || c.user.id;
  if (owner === e.sender_id) return { sender_id: owner };
  run('UPDATE envelopes SET sender_id=?, sent_by_id=?, made_for_by=?, updated_at=? WHERE id=?', owner, forId ? c.user.id : null, forId ? c.user.id : null, now(), e.id);
  return { sender_id: owner };
}
