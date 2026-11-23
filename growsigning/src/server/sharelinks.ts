// Share links: growsigning.com/<name>, a short address a sender can put in a chat, on a poster or say out loud.
//
//   An envelope's link opens "Who are you?": the person picks their name among the people whose turn it is (names
//   only, never an address), we send a 6-digit code to the address the sender gave for that name, and the right code
//   takes them to their own signing page. The link alone signs nothing: without the mailbox nobody gets in. The code
//   is the one-time code of signercode.ts, with all of its limits and its line in the record.
//   A public form's link is the same form as /f/<slug>, under a name that can be read.
//
// The rules for a name are in src/lib/sharename.ts; this file adds what needs the database and the fake-notice
// filter. A name belongs to one envelope or form. Renamed away, it stays kept for that same envelope or form, so an
// old address says plainly that it stopped and can never start opening somebody else's document.
import { get, all, run, tx } from './db.ts';
import { bad, baseUrl, hmac, now, HttpError } from './util.ts';
import { posesAs, lureIn } from './fakenotice.ts';
import { audit, senderOf, formPageRefusal, type Actor } from './envelopes.ts';
import { requestCode, checkCode, passCookie } from './signercode.ts';
import { showsTrees } from './tenantpolicy.ts';
import { treesInInvite } from './impact.ts';
import { listName } from '../lib/docname.ts';
import { isShareName, shareNameFrom, shareNameProblem, nextFreeName, tidyShareName, type ShareState } from '../lib/sharename.ts';
import { SIGNER_CODE_DIGITS, SIGNER_CODE_MINUTES } from '../lib/policy.ts';

export type ShareKind = 'envelope' | 'form';
export type ShareLink = { name: string; url: string; active: boolean };

/** SHARE_LINKS_AUTO=1: every sent envelope gets a share link by itself, the first time its sender opens its page. */
export const shareLinksAuto = () => process.env.SHARE_LINKS_AUTO === '1';

const urlOf = (name: string) => `${baseUrl()}/${name}`;
const view = (row: any): ShareLink => ({ name: row.name, url: urlOf(row.name), active: !!row.active });
const targetLives = (row: any): boolean => !!get(row.kind === 'form' ? 'SELECT 1 x FROM powerforms WHERE id=?' : "SELECT 1 x FROM envelopes WHERE id=? AND kind='envelope'", row.target_id);

/** The link of an envelope or a form as it stands: working, or switched off by its sender. null when it has none. */
export function shareLinkOf(kind: ShareKind, targetId: string): ShareLink | null {
  const row = get('SELECT * FROM share_links WHERE kind=? AND target_id=? AND ended_at IS NULL', kind, targetId);
  return row ? view(row) : null;
}

/** Why this name cannot be given out, whoever asks: its form, a page of ours, or a name that reads as a brand's notice. */
export function shareNameRefusal(name: string): string | null {
  const problem = shareNameProblem(name);
  if (problem) return problem;
  const words = name.replace(/-/g, ' ');
  const brand = posesAs(words) || lureIn([words])?.brand;
  return brand ? `"${name}" reads as a page of ${brand}. A share link is named after your own document.` : null;
}

// Whether `name` can be taken for this envelope or form: nobody has it, or it is one of its own (an old name of the
// same document may be taken back), or it points at something that no longer exists.
function freeFor(name: string, kind: ShareKind, targetId: string): boolean {
  const row = get('SELECT * FROM share_links WHERE name=?', name);
  if (!row) return true;
  if (row.kind === kind && row.target_id === targetId) return true;
  return !targetLives(row);
}

/** A name for this envelope or form that could be saved right now, made from its title. */
export function suggestShareName(kind: ShareKind, targetId: string, title: string): string {
  let base = shareNameFrom(listName(title));
  if (base.length < 3 || shareNameRefusal(base)) {
    const longer = base ? shareNameFrom(`${base} ${kind === 'form' ? 'form' : 'document'}`) : '';
    base = longer && !shareNameRefusal(longer) ? longer : kind === 'form' ? 'form-to-sign' : 'document-to-sign';
  }
  return nextFreeName(base, (c) => !shareNameRefusal(c) && freeFor(c, kind, targetId)) || base;
}

/**
 * Gives the envelope or form this name, switches its link on or off, or both. A new name retires the one before: the
 * old address stops, says so to whoever opens it, and stays kept for this same document. Answers the link as it now
 * stands. A name somebody else has is refused with the next free one in "suggestion".
 */
export function saveShareLink(kind: ShareKind, targetId: string, accountId: string, title: string, change: { name?: unknown; active?: unknown }): ShareLink {
  const has = get('SELECT * FROM share_links WHERE kind=? AND target_id=? AND ended_at IS NULL', kind, targetId);
  const wanted = change.name === undefined || change.name === null || change.name === '' ? (has?.name ?? suggestShareName(kind, targetId, title)) : tidyShareName(change.name);
  const active = change.active === undefined ? (has ? !!has.active : true) : !!change.active;
  if (!has || wanted !== has.name) {
    const no = shareNameRefusal(wanted);
    if (no) throw bad(no, 422, { code: 'share_name', suggestion: suggestShareName(kind, targetId, title) });
  }
  return tx(() => {
    if (has && wanted === has.name) {
      run('UPDATE share_links SET active=? WHERE name=?', active ? 1 : 0, has.name);
      return view({ ...has, active });
    }
    if (!freeFor(wanted, kind, targetId)) {
      const next = nextFreeName(wanted, (c) => !shareNameRefusal(c) && freeFor(c, kind, targetId));
      throw bad(`"${wanted}" is taken by another document.${next ? ` "${next}" is free.` : ''}`, 409, { code: 'share_name_taken', suggestion: next });
    }
    const t = now();
    if (has) run("UPDATE share_links SET active=0, ended_at=?, ended_why='renamed' WHERE name=?", t, has.name);
    // Its own old name taken back, or a name left behind by something deleted: the row is written again.
    run('DELETE FROM share_links WHERE name=?', wanted);
    run('INSERT INTO share_links (name, kind, target_id, account_id, active, created_at) VALUES (?,?,?,?,?,?)', wanted, kind, targetId, accountId, active ? 1 : 0, t);
    return view({ name: wanted, active });
  });
}

/** A link for something just made, when a free name comes out of its title. Never fails the making itself. */
export function autoShareLink(kind: ShareKind, targetId: string, accountId: string, title: string): ShareLink | null {
  try {
    return shareLinkOf(kind, targetId) || saveShareLink(kind, targetId, accountId, title, {});
  } catch {
    return null;
  }
}

/** Every name of something that is being deleted is let go. */
export const dropShareLinks = (kind: ShareKind, targetId: string) => run('DELETE FROM share_links WHERE kind=? AND target_id=?', kind, targetId);

// ---- What the page at /<name> is told ------------------------------------------------------------------------------

// The people who can come in through the link now: it is their turn, they sign, approve or view by themselves, and
// the sender gave an address for them. Someone signing in person, a group, a witness named by a signer and a person
// whose link the sender passes on are not offered: they have no mailbox of their own on this document to prove
// themselves with.
const canPick = (r: any) => (r.status === 'sent' || r.status === 'viewed') && !!r.email && !!r.token && r.role !== 'cc' && r.role !== 'inperson' && !r.group_id && !r.delegate_link_id;
const laterOnes = (r: any) => r.status === 'pending' && r.role !== 'cc';
// What the page calls a person: a key that says nothing about the row behind it and differs from link to link.
const personKey = (name: string, r: any) => hmac(`share-person:${name}:${r.id}:${r.token}`).slice(0, 20);

export type SharePage =
  | { state: 'none' }
  | { state: 'renamed' | 'off' }
  | { state: 'form'; slug: string; title: string }
  | { state: Exclude<ShareState, 'renamed' | 'off'>; title: string | null; sender: string | null; people: { key: string; name: string }[]; later: number; plants: number };

// Trees a signature here plants, for the line at the top of the page: said only when it holds for every person who
// can be picked, and only for an account that shows trees to its signers (as on the signing page itself).
function plantsFor(e: any, people: any[]): number {
  if (!people.length || !showsTrees(e.account_id)) return 0;
  const each = people.map((r) => treesInInvite(r));
  return each.every((n) => n === each[0]) ? each[0] : 0;
}

const closedState = (e: any): ShareState | null =>
  e.status === 'completed' ? 'completed' : e.status === 'voided' ? 'voided' : e.status === 'declined' ? 'declined' : e.status === 'expired' ? 'expired'
    : e.status !== 'sent' ? 'unavailable' : e.paused_at ? 'paused' : null;

function envelopeBehind(name: string): { row: any; e: any } | null {
  if (!isShareName(name)) return null;
  const row = get("SELECT * FROM share_links WHERE name=? AND kind='envelope'", name);
  if (!row) return null;
  const e = get("SELECT * FROM envelopes WHERE id=? AND kind='envelope'", row.target_id);
  return e && !e.hidden_at && !e.purged_at ? { row, e } : null;
}

/** What the page shows for this name. The same answer for a name nobody has and for one that is not written like a name. */
export function sharePage(name: string): SharePage {
  if (!isShareName(name)) return { state: 'none' };
  const row = get('SELECT * FROM share_links WHERE name=?', name);
  if (!row) return { state: 'none' };
  if (row.ended_at) return targetLives(row) ? { state: 'renamed' } : { state: 'none' };
  if (!row.active) return targetLives(row) ? { state: 'off' } : { state: 'none' };
  if (row.kind === 'form') {
    const p = get('SELECT slug, name FROM powerforms WHERE id=?', row.target_id);
    return p ? { state: 'form', slug: p.slug, title: p.name } : { state: 'none' };
  }
  const found = envelopeBehind(name);
  if (!found) return { state: 'none' };
  const { e } = found;
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  const title = listName(e.subject) || 'Untitled';
  const sender = senderOf(e)?.name || null;
  const nobody = { people: [], later: 0, plants: 0 };
  // A paused account, a document we hold back, or a name that would print a fake notice under our address: closed,
  // and neither the document's name nor the sender's is printed (as on a public form, formPageRefusal).
  if (!account || account.suspended_at || e.held_at || formPageRefusal(account, `${title} ${sender || ''}`)) return { state: 'unavailable', title: null, sender: null, ...nobody };
  const closed = closedState(e);
  if (closed) return { state: closed, title, sender, ...nobody };
  const rs = all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
  return {
    state: 'open', title, sender,
    people: rs.filter(canPick).map((r) => ({ key: personKey(name, r), name: r.name })),
    later: rs.filter(laterOnes).length,
    plants: plantsFor(e, rs.filter(canPick)),
  };
}

// The person a visitor picked, on a link that is open. One answer for every way this can fail, so asking tells
// nothing about which names or people exist.
const NOT_OPEN = 'This link is not open for signing right now. Use the link in the email you were sent, or ask whoever sent you the document.';
function picked(name: string, key: unknown): { e: any; r: any } {
  const found = envelopeBehind(name);
  const page = found ? sharePage(name) : null;
  if (!found || !page || page.state !== 'open') throw bad(NOT_OPEN, 409, { code: 'share_closed' });
  const r = all('SELECT * FROM recipients WHERE envelope_id=?', found.e.id).filter(canPick).find((x) => personKey(name, x) === String(key || ''));
  if (!r) throw bad('Choose your name from the list first. If it is not there, it is not your turn yet, or you have already finished.', 409, { code: 'share_person' });
  return { e: found.e, r };
}
// The code of signercode.ts, asked for through the share link: for the address the sender gave, whatever check the
// sender chose for the signing page itself. Kept apart from that check by its stamp, so neither ends the other's code.
const viaLink = (r: any) => ({ ...r, verify: 'email_code' });

/** Sends the picked person a code, to the address the sender gave. The answer never holds the code or the address. */
export async function shareCode(name: string, key: unknown, actor: Actor) {
  const { e, r } = picked(name, key);
  const sender = senderOf(e)?.name || 'the sender';
  try {
    await requestCode(e, viaLink(r), actor);
  } catch (err: any) {
    if (!(err instanceof HttpError)) throw err;
    // signercode.ts words its refusals for someone who holds the person's own link and names the masked address.
    // Here nothing about the address is said: when to try again, and the way that always works.
    const wait = Number(err.data?.resend_in) || 0;
    if (err.data?.code === 'wait' && wait) throw bad(`A code was sent a moment ago. You can ask for a new one in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}. The newest code you were sent may still work.`, 429, { code: 'wait', resend_in: wait });
    if (err.status === 429) throw bad(`Too many codes were asked for. Wait a while and try again, or use the link in the email ${sender} sent you.`, 429, { code: 'wait_long' });
    throw bad(`We cannot send a code right now. That is nothing you did. Use the link in the email ${sender} sent you, or ask ${sender} to send it again.`, 503, { code: 'unavailable' });
  }
  audit(e.id, actor, 'Share link: code asked for', `${r.name}: someone opened share link /${name}, chose this name and asked for the code. It went to the address on this document.`);
  return { sent: true, digits: SIGNER_CODE_DIGITS, minutes: SIGNER_CODE_MINUTES, resend_in: 60 };
}

/** Checks the code. Right: the address of that person's own signing page, and what their browser is given. */
export async function shareCheck(name: string, key: unknown, typed: unknown, actor: Actor, secure: boolean): Promise<{ url: string; cookies: string[] }> {
  const { e, r } = picked(name, key);
  await checkCode(e, viaLink(r), typed, actor);
  audit(e.id, actor, 'Share link: opened', `${r.name} came in through share link /${name} with the code sent to their address.`);
  // Someone the sender also asks for a one-time code by email on the signing page has just typed one from that
  // same mailbox: this browser is not asked a second time.
  return { url: `/sign/${r.token}`, cookies: r.verify === 'email_code' ? [passCookie(r, secure)] : [] };
}
