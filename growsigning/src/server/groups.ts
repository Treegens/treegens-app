import { all, get, run, tx } from './db.ts';
import { bad, id, token, now, isEmail, str, baseUrl, checkCode, sha256 } from './util.ts';
import { sendMail, type MailStatus } from './mail.ts';
import { audit, loadEnvelope, notifySender, senderOf, emailRefusal, notOpen, declineRecipient, type Actor } from './envelopes.ts';
import type { Ctx } from './router.ts';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS, GROUPS_PER_ACCOUNT, ACCESS_CODE_MIN, ACCESS_CODE_TRIES } from '../lib/policy.ts';
import { actingName, whoIs, groupInvite, groupDoes, groupDid } from '../lib/groups.ts';
import { isSelf } from './credits.ts';
import { stampText } from '../lib/dates.ts';

// Signing groups: a recipient that is a group of people, any one of whom can act ("HR team", "Accounts payable").
//
// How it is kept. An account keeps named groups (signing_groups, signing_group_members). On an envelope a group is
// ONE row in recipients, so everything that counts recipients sees one: one signature held and used, one place in
// the signing order, one access code, one set of fields. A draft or template only names the group (group_id) and
// follows it. When the envelope is sent the members are written down as they are at that moment
// (recipient_members), each with a link and a security code of their own, and from then on the saved group can
// change or go without changing the envelope.
//
// Who acts. Until someone takes the document on, the row has the group's name and no address, and every member's
// own link opens it. The first member who agrees to the consent screen takes it on: the row then carries that
// person's name, address and link (claimed_by says which member), and is from there an ordinary recipient to
// everything else. The other members' links say who has it. That person can hand it back to the group before
// finishing, and so can the sender. A member who declines does so for the group.
//
// envelopes.ts, routes-sign.ts and a few other files call in here at the places where a recipient is written, sent
// to, opened or named. Nothing in here calls into envelopes.ts while this module is being loaded, which is what lets
// the two files use each other.

type Member = { name: string; email: string };
const SYSTEM: Actor = { name: 'System' };
const ROLE_WORDS: Record<string, string> = { signer: 'signer', approver: 'approver', cc: 'copy recipient', viewer: 'viewer', inperson: 'in-person signer' };
const lower = (s: any) => String(s ?? '').trim().toLowerCase();
const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const listNames = (l: any[], max = 8) => (l.length > max ? `${l.slice(0, max).map((m) => m.name).join(', ')} and ${l.length - max} more` : l.map((m) => m.name).join(', '));
const brandOf = (accountId: string) => {
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', accountId);
  return { name: a?.name, color: a?.brand_color, logo: a?.brand_logo };
};
const ts = (s: any) => stampText(s);

// The members of a group recipient who are on it now, in their order, with their links.
const active = (recipientId: string): any[] => all('SELECT * FROM recipient_members WHERE recipient_id=? AND removed_at IS NULL ORDER BY position, id', recipientId);
const linkOf = (m: any) => `${baseUrl()}/sign/${m.token}`;

// A member who marked our email as spam, or who reported the document, is emailed nothing more about it. The spam
// mark is kept for the account (mail_complaints, see routes-bounces.ts), like anyone's, so it holds for this
// account's other documents too and is read from there, whatever the member's place in the group is now. A report
// holds for this envelope (recipient_members.reported_at). Only the member can undo either, on their own signing
// page with a code sent to their own address (mail-again in routes-bounces.ts).
const stopOf = (mid: string): { complained: string | null; reported: string | null } =>
  get(`SELECT c.at complained, m.reported_at reported FROM recipient_members m JOIN envelopes e ON e.id=m.envelope_id
    LEFT JOIN mail_complaints c ON c.account_id=e.account_id AND c.email=m.email WHERE m.id=?`, mid) || { complained: null, reported: null };
/** Why nothing is emailed about this envelope to this member, or to the member who has the group's document, or null. */
export function memberMailStop(r: any): 'complaint' | 'report' | null {
  const mid = r?.member?.id || (r?.group_name ? r.claimed_by : null);
  if (!mid) return null;
  const s = stopOf(mid);
  return s.complained ? 'complaint' : s.reported ? 'report' : null;
}
const STOP_WHY = { complaint: 'marked an earlier email from this account as spam', report: 'reported this document' };
// One line in the record for the members a notice did not go to because of such a mark, so nobody is left out
// without the sender being able to see why.
function noteStopped(e: any, group: string, list: any[], what: string) {
  if (list.length) audit(e.id, SYSTEM, 'Not emailed', `${list.map((m) => `${m.name} <${m.email}>, of ${group}, ${STOP_WHY[m.stop as 'complaint' | 'report']}`).join('; ')}. So ${what} was not emailed to them. Their link works, and only they can start our emails again, on their signing page.`);
}
// One member, seen as a recipient: the group's row with this person's name, address, link and security code, and
// their own marks (a group's row has no address of its own, so its marks say nothing about a member).
const memberAs = (r: any, m: any) => {
  const s = stopOf(m.id);
  return { ...r, name: m.name, email: m.email, token: m.token, check_code: m.check_code, muted: m.muted, member: m, complained_at: s.complained, reported_at: s.reported };
};
// The members a notice can go to, and the ones it cannot because of their own mark (`stop`).
const reachable = (r: any, list: any[]) => {
  const all = list.map((m) => {
    const x = memberAs(r, m);
    return { ...m, stop: x.complained_at ? 'complaint' : x.reported_at ? 'report' : null };
  });
  return { to: all.filter((m) => !m.stop), stopped: all.filter((m) => m.stop) };
};

// ---- The groups an account keeps ---------------------------------------------------------------------------

// The members a request names. Nothing is dropped or cut short without a word: a member without a name or with an
// address that is not one, an address that is there twice, and a group that is too small or too large are refused,
// and the answer says which. `what` starts the sentence.
function readMembers(list: any, what: string): Member[] {
  if (!Array.isArray(list)) throw bad(`${what}: "members" must be a list of people, each with a name and an email address. Nothing was saved.`);
  const out: Member[] = [];
  const seen = new Set<string>();
  list.forEach((m: any, i: number) => {
    const name = str(m?.name, 500).trim().replace(/\s+/g, ' '), email = str(m?.email, 500).trim();
    if (!name) throw bad(`${what}: member ${i + 1}${email ? ` (${str(email, 120)})` : ''} needs a name. Nothing was saved.`);
    if (name.length > 120) throw bad(`${what}: the name of member ${i + 1} is ${name.length} characters long, and the most that fits is 120. Nothing was saved.`);
    if (!isEmail(email)) throw bad(`${what}: ${name} needs a valid email address${email ? `, and "${str(email, 120)}" is not one` : ''}. Nothing was saved.`);
    if (seen.has(lower(email))) throw bad(`${what}: ${email} is in the group twice. Every member gets a link of their own, so each needs an address of their own. Nothing was saved.`);
    seen.add(lower(email));
    out.push({ name, email });
  });
  if (out.length < GROUP_MIN_MEMBERS) throw bad(`${what}: a group needs at least ${GROUP_MIN_MEMBERS} members, and this would leave ${out.length}. To send to one person, name that person as the recipient instead of a group. Nothing was saved.`);
  if (out.length > GROUP_MAX_MEMBERS) throw bad(`${what}: a group can have up to ${GROUP_MAX_MEMBERS} members, and this would make ${out.length}. Take some out, or make a second group. Nothing was saved.`);
  return out;
}

/** Every group of an account with its members, and how many drafts and templates name it (used_by). */
export function listGroups(accountId: string): any[] {
  const groups = all('SELECT id, name, created_at, updated_at FROM signing_groups WHERE account_id=? ORDER BY name COLLATE NOCASE', accountId);
  for (const g of groups) {
    g.members = all('SELECT id, name, email FROM signing_group_members WHERE group_id=? ORDER BY position, id', g.id);
    g.used_by = get("SELECT COUNT(DISTINCT e.id) n FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.group_id=? AND e.account_id=? AND e.status='draft'", g.id, accountId).n;
  }
  return groups;
}

/** Makes a group, or replaces the name and the members of one (`groupId`). Envelopes that are out are not touched. */
export function saveGroup(accountId: string, body: any, groupId?: string): any {
  const name = str(body?.name, 500).trim().replace(/\s+/g, ' ');
  if (!name) throw bad('Give the group a name, such as "HR team". Nothing was saved.');
  if (name.length > 80) throw bad(`The name of a group can be up to 80 characters long, and this one has ${name.length}. Shorten it and save again. Nothing was saved.`);
  const members = readMembers(body?.members, `The group "${name}"`);
  return tx(() => {
    if (get('SELECT 1 x FROM signing_groups WHERE account_id=? AND name=? AND id IS NOT ?', accountId, name, groupId ?? null))
      throw bad(`There is already a group called "${name}". Give this one another name, or change that one. Nothing was saved.`, 409);
    const t = now();
    let gid = groupId;
    if (gid) {
      if (!run('UPDATE signing_groups SET name=?, updated_at=? WHERE id=? AND account_id=?', name, t, gid, accountId).changes) throw bad('We could not find that group. It may have been deleted. Nothing was saved.', 404);
    } else {
      if (get('SELECT COUNT(*) n FROM signing_groups WHERE account_id=?', accountId).n >= GROUPS_PER_ACCOUNT)
        throw bad(`An account can keep up to ${GROUPS_PER_ACCOUNT} groups, and this one has that many. Delete one you no longer use, then add this one. Nothing was saved.`);
      gid = id('grp');
      run('INSERT INTO signing_groups (id, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', gid, accountId, name, t, t);
    }
    run('DELETE FROM signing_group_members WHERE group_id=?', gid);
    members.forEach((m, i) => run('INSERT INTO signing_group_members (id, group_id, name, email, position) VALUES (?,?,?,?,?)', id('gmb'), gid, m.name, m.email, i));
    return listGroups(accountId).find((g) => g.id === gid);
  });
}

/** Deletes a group. Envelopes that were sent to it keep the members they went out with. */
export function deleteGroup(accountId: string, groupId: string) {
  if (!run('DELETE FROM signing_groups WHERE id=? AND account_id=?', groupId, accountId).changes) throw bad('We could not find that group. It may have been deleted already.', 404);
}

// ---- A recipient that is a group: loading, saving and copying -----------------------------------------------

/**
 * Called by loadEnvelope(). Every group recipient gets "members": on a draft or a template the saved group as it
 * is now (with the group's present name, and group_missing when it was deleted), on an envelope that went out the
 * members it went out with. No link and no security code is put on them, so nothing that passes an envelope on can
 * give one away.
 */
export function attachGroups(e: any) {
  for (const r of e.recipients) {
    if (!r.group_name && !r.group_id) continue;
    if (e.status === 'draft') {
      const g = get('SELECT id, name FROM signing_groups WHERE id=? AND account_id=?', r.group_id, e.account_id);
      r.group_missing = !g;
      if (g) (r.name = g.name), (r.group_name = g.name);
      r.members = g ? all('SELECT id, name, email FROM signing_group_members WHERE group_id=? ORDER BY position, id', g.id) : [];
    } else
      // mail_stop: 'complaint' when this member marked our email as spam, 'report' when they reported this document.
      // Either way nothing more is emailed to them about it (memberMailStop below), and the envelope page says so.
      r.members = all(`SELECT m.id, m.name, m.email, m.sent_at, m.viewed_at, m.muted, CASE WHEN c.at IS NOT NULL THEN 'complaint' WHEN m.reported_at IS NOT NULL THEN 'report' END mail_stop
        FROM recipient_members m LEFT JOIN mail_complaints c ON c.account_id=? AND c.email=m.email WHERE m.recipient_id=? AND m.removed_at IS NULL ORDER BY m.position, m.id`, e.account_id, r.id);
  }
}

// What a request says this recipient is: the id of a group, null for a person, and what it was when the request
// does not say (like every other part of a recipient that is left out).
const groupAsked = (r: any, old: any): string | null => (r?.group_id === undefined ? (old?.group_name ? old.group_id : null) : str(r.group_id, 60).trim() || null);

/**
 * Called by writeContent() for every recipient of a save, before the row is written. For a group ("group_id") the
 * name and the address on the row are not the caller's to choose: they are the group's name and no address, or, on
 * an envelope that is out, whatever the row holds (the member who took it on). Whatever the body carries for them
 * is replaced here, so an editor that was opened before someone took the document on cannot undo that.
 */
export function groupNames(r: any, old: any, accountId: string, correcting: boolean, i: number): any {
  const gid = groupAsked(r, old);
  if (!gid) return r;
  const same = !!old?.group_name && old.group_id === gid;
  const g = get('SELECT id, name FROM signing_groups WHERE id=? AND account_id=?', gid, accountId);
  // A draft may still name a group that was deleted since, like a half-typed address: it is checked before sending.
  if (!g && !same) throw bad(`Recipient ${i + 1} names a group ("${str(gid, 60)}") that does not exist in this account. Use the id of one of your groups (they are under Contacts, and in GET /groups), or name a person. Nothing was saved.`);
  if (r.role === 'inperson') throw bad(`Recipient ${i + 1} (${g?.name || old.group_name}) is a group, and signing in person is for one named person on your own device. Choose signer, approver, viewer or copy for the group, or name the person who signs in person. Nothing was saved.`);
  if (same && correcting) return { ...r, name: old.name, email: old.email };
  return { ...r, name: g?.name ?? old.name, email: '' };
}

const NO_CHECK = 'A one-time code and a text message go to one person, and a group is several people. For a group, use an access code (one for the whole group, which you give them yourself), or name one person instead.';

// Takes the document back from the member who had it, on the row alone. Used inside a correction: the correction
// then treats the row like one whose person changed (the answers are cleared and the group is asked afresh).
// Whether its signature is paid for goes back to what it is for the group: a sender who had it free no longer has it.
const unclaimRow = (rid: string) => run(`UPDATE recipients SET claimed_by=NULL, claimed_at=NULL, name=group_name, email='', free=CASE WHEN ${PAID_HERE} THEN 1 ELSE 0 END WHERE id=?`, rid);

function insertMembers(rid: string, envelopeId: string, list: Member[], from = 0) {
  list.forEach((m, i) => run('INSERT INTO recipient_members (id, recipient_id, envelope_id, name, email, position) VALUES (?,?,?,?,?,?)', id('rmb'), rid, envelopeId, m.name, m.email, from + i));
}

/**
 * Called by writeContent() once the recipients of a save are written, inside its transaction. On a draft a group
 * recipient only names its group. On an envelope that is out (`correcting`) a group that is added gets its members
 * written down now, and "members" on a group that is already there changes who can act: someone added gets a link,
 * someone taken out loses theirs, and if that was the person who had taken the document on, the group is asked
 * again. A group that has finished keeps its members as they were.
 */
export function saveGroups(e: any, asked: { rid: string; r: any; i: number }[], before: Map<string, any>, correcting: boolean) {
  for (const { rid, r, i } of asked) {
    const old = before.get(rid);
    const gid = groupAsked(r, old);
    const row = get('SELECT * FROM recipients WHERE id=?', rid);
    if (!row) continue;
    if (!gid) {
      if (!old?.group_name) continue;
      // The sender put a person where the group was. The members' links say they are no longer on the document.
      run('UPDATE recipients SET group_id=NULL, group_name=NULL, claimed_by=NULL, claimed_at=NULL WHERE id=?', rid);
      if (correcting) run('UPDATE recipient_members SET removed_at=? WHERE recipient_id=? AND removed_at IS NULL', now(), rid);
      else run('DELETE FROM recipient_members WHERE recipient_id=?', rid);
      continue;
    }
    const same = !!old?.group_name && old.group_id === gid;
    const g = get('SELECT id, name FROM signing_groups WHERE id=? AND account_id=?', gid, e.account_id);
    const name = g?.name ?? old.group_name;
    const whom = `Recipient ${i + 1} (${name})`;
    if (row.verify || row.text_link) throw bad(`${whom} is a group. ${NO_CHECK} Nothing was saved.`);
    if (!correcting) {
      run('UPDATE recipients SET group_id=?, group_name=?, claimed_by=NULL, claimed_at=NULL WHERE id=?', gid, name, rid);
      run('DELETE FROM recipient_members WHERE recipient_id=?', rid);
      continue;
    }
    if (!same) {
      // A group that is added to an envelope that is out, or put in the place of a person or of another group.
      run('UPDATE recipient_members SET removed_at=? WHERE recipient_id=? AND removed_at IS NULL', now(), rid);
      run('UPDATE recipients SET group_id=?, group_name=?, claimed_by=NULL, claimed_at=NULL WHERE id=?', gid, name, rid);
      const list = r.members !== undefined ? readMembers(r.members, whom) : readMembers(all('SELECT name, email FROM signing_group_members WHERE group_id=? ORDER BY position, id', gid), whom);
      insertMembers(rid, e.id, list);
      continue;
    }
    // A different job is asked of the whole group afresh, like a person whose role changes.
    if (old.claimed_by && old.role !== row.role) unclaimRow(rid);
    if (r.members === undefined) continue;
    const want = readMembers(r.members, whom);
    const have = active(rid);
    const wanted = new Map(want.map((m) => [lower(m.email), m]));
    const had = new Map(have.map((m: any) => [lower(m.email), m]));
    const gone = have.filter((m: any) => !wanted.has(lower(m.email)));
    const fresh = want.filter((m) => !had.has(lower(m.email)));
    const renamed = have.filter((m: any) => wanted.has(lower(m.email)) && wanted.get(lower(m.email))!.name !== m.name);
    if (!gone.length && !fresh.length && !renamed.length) continue;
    // What a group signed stands under the people it had. The list is not rewritten afterwards.
    if (old.status === 'completed' && old.role !== 'cc')
      throw bad(`${old.group_name} has already finished: ${old.name} ${groupDid(old.role)} for it. Its members can no longer be changed, because the record names the group as it was. Nothing was saved. If someone else should sign as well, add them as a recipient of their own.`, 409);
    const t = now();
    for (const m of gone) run('UPDATE recipient_members SET removed_at=? WHERE id=?', t, m.id);
    for (const m of renamed) run('UPDATE recipient_members SET name=? WHERE id=?', wanted.get(lower(m.email))!.name, m.id);
    insertMembers(rid, e.id, fresh, have.reduce((n: number, m: any) => Math.max(n, m.position + 1), 0));
    const cur = get('SELECT claimed_by FROM recipients WHERE id=?', rid);
    // The person who had taken it on was taken out of the group: nobody has it now, and the group is asked again.
    if (cur.claimed_by && gone.some((m: any) => m.id === cur.claimed_by)) unclaimRow(rid);
    // A member's name that the sender put right is the name they act under from here on.
    else if (cur.claimed_by && renamed.some((m: any) => m.id === cur.claimed_by)) run('UPDATE recipients SET name=? WHERE id=?', wanted.get(lower(have.find((m: any) => m.id === cur.claimed_by).email))!.name, rid);
  }
}

/** Called by copyEnvelope(): a copy of a group recipient is the group again, whoever acted for it on the original. */
export function copyGroup(from: any, newId: string) {
  if (!from.group_name && !from.group_id) return;
  run("UPDATE recipients SET group_id=?, group_name=?, name=?, email='' WHERE id=?", from.group_id, from.group_name, from.group_name || from.name, newId);
}

// ---- Sending ---------------------------------------------------------------------------------------------------

/** Before a draft goes out: every group on it still exists, has members, and asks nothing a group cannot do. */
export function assertGroups(e: any) {
  for (const r of e.recipients) {
    if (!r.group_name && !r.group_id) continue;
    const name = r.group_name || r.name || 'A group';
    if (r.group_missing) throw bad(`The group "${name}" no longer exists, so this cannot be sent to it. Open the envelope, take that recipient off and choose another group or a person.`);
    const n = (r.members || []).length;
    if (n < GROUP_MIN_MEMBERS || n > GROUP_MAX_MEMBERS) throw bad(`The group "${name}" has ${many(n, 'member')}, and a group needs from ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS}. Change the group under Contacts, or choose another recipient.`);
    if (r.role === 'inperson') throw bad(`"${name}" is a group, and signing in person is for one named person. Choose another role for the group, or name the person.`);
    if (r.verify || r.text_link) throw bad(`"${name}" is a group. ${NO_CHECK}`);
  }
}

/**
 * Before a template is used (POST /envelopes with "template_id", POST /bulk). A row, or the "recipients" of the call,
 * that names a person for a role the template gives to a group is refused: the group's members get it, and the
 * person named would never be emailed. When the call sends, a group the template names that was deleted since, or
 * that is too small or too large now, refuses the whole call before anything is made, in words that point at the
 * template, because no envelope is left behind to mend.
 */
export function assertTemplateGroups(tpl: any, fills: any[], sending: boolean, rows = false) {
  for (const r of tpl.recipients || []) {
    if (!r.group_name && !r.group_id) continue;
    const name = r.group_name || r.name || 'a group';
    const role = r.role_name || r.id;
    const named = (f: any) => { const v = f && typeof f === 'object' ? f[role] ?? f[r.id] : null; return !!v && !!(str(v?.name, 500).trim() || str(v?.email, 500).trim()); };
    const i = fills.findIndex(named);
    if (i >= 0) throw bad(`${rows ? `Row ${i + 1}: t` : 'T'}he role "${role}" is the group "${name}" in this template, so its members get the document and nobody can be named for it. Leave "${role}" out, or change the template to name a person for that role. Nothing was sent.`);
    if (!sending) continue;
    if (r.group_missing) throw bad(`This template names the group "${name}" for "${role}", and that group no longer exists, so nothing was sent and nothing was made. Change the template: choose another group or a person for that role, then send again.`);
    const n = (r.members || []).length;
    if (n < GROUP_MIN_MEMBERS || n > GROUP_MAX_MEMBERS) throw bad(`This template names the group "${name}", which has ${many(n, 'member')}, and a group needs from ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS}. Change the group under Contacts, or choose another recipient in the template. Nothing was sent.`);
  }
}

/** Everyone an envelope's groups would email: each member counts as a person reached, like any recipient. */
export const groupReach = (e: any): string[] => (e.recipients || []).flatMap((r: any) => (r.group_name ? (r.members || []).map((m: any) => m.email) : []));

/** The members a correction adds: in a group that is new on the envelope, or new in a group that was there. */
export function groupReachNew(before: any, after: any): string[] {
  const was = new Map<string, any>(before.recipients.map((r: any) => [r.id, r]));
  return after.recipients.flatMap((r: any) => {
    if (!r.group_name) return [];
    const had = new Set<string>((was.get(r.id)?.group_name ? was.get(r.id).members || [] : []).map((m: any) => lower(m.email)));
    return (r.members || []).filter((m: any) => !had.has(lower(m.email))).map((m: any) => m.email);
  });
}

/**
 * Called by sendEnvelope() inside the transaction that sends. The members of every group are written down as they
 * are now, each with a link and a security code of their own. The group's own row gets no link: until one member
 * takes the document on there is no link that is "the group's", so nobody can act without it being known who.
 */
export function snapshotGroups(e: any) {
  for (const r of e.recipients) {
    if (!r.group_name) continue;
    run('DELETE FROM recipient_members WHERE recipient_id=?', r.id);
    insertMembers(r.id, e.id, r.members || []);
    run("UPDATE recipients SET name=?, email='', group_name=?, claimed_by=NULL, claimed_at=NULL WHERE id=?", r.group_name, r.group_name, r.id);
  }
  settleGroups(e.id);
}

/**
 * Called at the end of every transaction that sends or corrects an envelope. Keeps three things true: every member
 * has a link and a security code; a group nobody has taken on has no link of its own, and one that somebody has
 * taken on carries that member's; and a group whose signature has been used once never needs a second one, whoever
 * of its members signs after a change (one group recipient is one signature).
 */
export function settleGroups(envelopeId: string) {
  for (const m of all('SELECT id FROM recipient_members WHERE envelope_id=? AND token IS NULL', envelopeId)) run('UPDATE recipient_members SET token=?, check_code=? WHERE id=?', token(), checkCode(), m.id);
  run('UPDATE recipients SET token=NULL, check_code=NULL WHERE envelope_id=? AND group_name IS NOT NULL AND claimed_by IS NULL', envelopeId);
  run(`UPDATE recipients SET token=(SELECT token FROM recipient_members WHERE id=recipients.claimed_by), check_code=(SELECT check_code FROM recipient_members WHERE id=recipients.claimed_by)
    WHERE envelope_id=? AND group_name IS NOT NULL AND claimed_by IS NOT NULL AND token IS NOT (SELECT token FROM recipient_members WHERE id=recipients.claimed_by)`, envelopeId);
  run(`UPDATE recipients SET free=1 WHERE envelope_id=? AND group_name IS NOT NULL AND COALESCE(free, 0)=0 AND ${PAID_HERE}`, envelopeId);
}

// A signature used on this row by a member of the group it has now: the ledger line names the row, the address of
// whoever signed and the row's person_gen (sigRef in credits.ts). Putting another group, or a person, in a group's
// place moves person_gen on (writeContent in envelopes.ts), so what an earlier group or person paid for never makes
// the next one's signature free.
const PAID_HERE = `EXISTS (SELECT 1 FROM credits c WHERE c.reason='signature' AND substr(c.ref, 1, length(recipients.id) + 1) = recipients.id || '|'
    AND CASE WHEN COALESCE(recipients.person_gen, 0) = 0 THEN instr(substr(c.ref, length(recipients.id) + 2), '|') = 0
      ELSE substr(c.ref, -length('|' || recipients.person_gen)) = '|' || recipients.person_gen END)`;

/**
 * The people to write to about a recipient who have been written to before: the recipient themselves, or, for a
 * group nobody has taken on, every member who was sent the document. For notices: voided, declined, completed, no
 * longer needed, not your turn yet.
 */
export function groupPeople(r: any): any[] {
  if (!r?.group_name || r.member) return [r];
  // A member who reported the document is written to about it no more, also once they have it. (A spam mark is on
  // the row, and on each member below, as complained_at: every caller already leaves those out, and says so.)
  if (r.claimed_by) return memberMailStop(r) === 'report' ? [] : [r];
  const rows = active(r.id);
  // A group that was just taken off the envelope has no lines left. The members it was loaded with are used.
  return (rows.length ? rows : r.members || []).filter((m: any) => m.sent_at).map((m: any) => memberAs(r, m)).filter((x: any) => !x.reported_at);
}

/**
 * Called by notifyRecipient() for a group nobody has taken on: every member who can still act gets their own email
 * with their own link, written by `send` (notifyRecipient itself) as for any recipient. A member who turned
 * reminders off gets no reminder. Answers what became of the emails, the best news first, or false when none was
 * written.
 */
export async function notifyMembers(e: any, r: any, kind: string, send: (e: any, r: any, kind: any) => Promise<false | MailStatus>): Promise<false | MailStatus> {
  let out: false | MailStatus = false;
  const { to, stopped } = reachable(r, active(r.id));
  // A member who marked our email as spam or reported the document gets nothing, of any kind. When the document goes
  // out to them the record says why; for a reminder, the answer to the sender names them (remind in routes-envelopes.ts).
  if (kind === 'new' || kind === 'again') noteStopped(e, r.group_name, stopped, 'the document');
  for (const m of to) {
    // Like a person whose email came back: no reminder and no "expires soon" to a member's address that bounced.
    // It would only come back again. The sender was told which member it was and how to fix it (bouncedMember).
    if ((kind === 'reminder' || kind === 'expiring') && get("SELECT 1 x FROM emails WHERE envelope_id=? AND recipient_id=? AND to_email=? COLLATE NOCASE AND bounce_kind='hard'", e.id, r.id, m.email)) continue;
    // Someone who was never emailed this document (added by a correction, or left out before because of a mark of
    // their own) is first sent the document itself, never a reminder or "it was changed" as their first email. After
    // a correction, groupsCorrected sends it, with its line in the record, so "updated" leaves them out here.
    const first = !m.sent_at && kind !== 'new' && kind !== 'again' && kind !== 'resent';
    if (first && kind === 'updated') continue;
    const how = await send(e, memberAs(r, m), first ? 'new' : kind);
    if (!how) continue;
    if (first && how !== 'failed') audit(e.id, SYSTEM, how === 'outbox' ? 'Not emailed' : 'Sent to recipient', `${m.name} <${m.email}>, of ${r.group_name}, who had not been emailed the document before${how === 'outbox' ? '. No mail server is set up, so no email went out' : ''}`);
    if (!m.sent_at) run('UPDATE recipient_members SET sent_at=? WHERE id=?', now(), m.id);
    if (how === 'sent' || (how === 'outbox' && out !== 'sent') || !out) out = how;
  }
  return out;
}

/**
 * For POST /envelopes/:id/remind: the members of these group recipients that a reminder does not go to because of
 * their own mark, so the answer names them like anyone else who is left out ("why" as there, plus 'reported'). A
 * member who turned reminders off is not named, like any person who did.
 */
export function membersNotReminded(e: any, rows: any[]): { recipient_id: string; member_id: string; name: string; why: string }[] {
  const out: { recipient_id: string; member_id: string; name: string; why: string }[] = [];
  for (const r of rows) {
    if (!r.group_name) continue;
    if (r.claimed_by) {
      if (memberMailStop(r) === 'report') out.push({ recipient_id: r.id, member_id: r.claimed_by, name: r.name, why: 'reported' });
      continue;
    }
    for (const m of active(r.id)) {
      const x = memberAs(r, m);
      const why = x.complained_at ? 'marked_as_spam' : x.reported_at ? 'reported'
        : get("SELECT 1 x FROM emails WHERE envelope_id=? AND recipient_id=? AND to_email=? COLLATE NOCASE AND bounce_kind='hard'", e.id, r.id, m.email) ? 'email_bounced' : null;
      if (why) out.push({ recipient_id: r.id, member_id: m.id, name: m.name, why });
    }
  }
  return out;
}

/** The line every email to a member carries: that this went to a group, and how that works. */
export const groupLine = (r: any): string[] => {
  if (!r?.member || !r.group_name) return [];
  const n = get('SELECT COUNT(*) n FROM recipient_members WHERE recipient_id=? AND removed_at IS NULL', r.id).n;
  return [groupInvite(r.group_name, n, r.role)];
};

/** Group names and member names are words a sender wrote that reach other people, so the fake-notice filter reads them. */
export const groupWords = (e: any): string[] => (e.recipients || []).filter((r: any) => r.group_name).flatMap((r: any) => [r.group_name, ...(r.members || []).map((m: any) => m.name)]);

/**
 * What a correction did to a recipient that is, was or became a group, as sentences for the audit trail (see
 * describeCorrection in envelopes.ts). `o` is the recipient before and `r` after, each with its members.
 */
export function groupChange(o: any, r: any, ordered: boolean): string[] {
  if (!o.group_name) return [`${whoIs(o)} was replaced by the group ${whoIs(r)}.`];
  if (!r.group_name) return [`The group ${whoIs(o)} was replaced by ${whoIs(r)}.`];
  if (o.group_id !== r.group_id) return [`The group ${whoIs(o)} was replaced by the group ${whoIs(r)}.`];
  const bits: string[] = [];
  const was = new Map<string, any>((o.members || []).map((m: any) => [lower(m.email), m]));
  const is = new Map<string, any>((r.members || []).map((m: any) => [lower(m.email), m]));
  for (const m of r.members || []) {
    const before = was.get(lower(m.email));
    if (!before) bits.push(`${m.name} <${m.email}> added to the group`);
    else if (before.name !== m.name) bits.push(`the name of ${before.name} <${m.email}> is now written "${m.name}"`);
  }
  for (const m of o.members || []) if (!is.has(lower(m.email))) bits.push(`${m.name} <${m.email}> taken out of the group`);
  if (o.claimed_by && !r.claimed_by) bits.push(`${o.name} <${o.email}> had taken the document on and no longer has it, so the whole group is asked again and what ${o.name} had filled in was cleared`);
  if (o.role !== r.role) bits.push(`role changed from ${ROLE_WORDS[o.role]} to ${ROLE_WORDS[r.role]}`);
  if (o.routing_order !== r.routing_order && ordered) bits.push(`place in the signing order changed from ${o.routing_order} to ${r.routing_order}`);
  if ((o.access_code || '') !== (r.access_code || '')) bits.push(!r.access_code ? 'access code removed' : o.access_code ? 'access code changed' : 'access code added');
  if ((o.note || '') !== (r.note || '')) bits.push('private note changed');
  return bits.length ? [`${r.group_name} (a group): ${bits.join(', ')}.`] : [];
}

/**
 * Called by correctEnvelope() after its transaction, before the next people are asked. A member who was added to a
 * group that has the document, and that nobody has taken on, is emailed their link now. A member who was taken out
 * and had been sent the document is told that there is nothing more to do. While sending is paused on the account
 * nobody is emailed about a change, and the record says so.
 */
export async function groupsCorrected(before: any, write: (e: any, r: any, kind: any) => Promise<false | MailStatus>) {
  const e = loadEnvelope(before.id);
  if (!e || e.status !== 'sent') return;
  const quiet = !!get('SELECT suspended_at s FROM accounts WHERE id=?', e.account_id)?.s;
  const sender = senderOf(e);
  for (const r of e.recipients) {
    const was = before.recipients.find((x: any) => x.id === r.id);
    if (!was?.group_name) continue;
    const still = new Set<string>(active(r.id).map((m: any) => m.id));
    const told = reachable(was, (was.members || []).filter((m: any) => !still.has(m.id) && m.sent_at));
    const gone = told.to;
    if (gone.length && quiet) audit(e.id, SYSTEM, 'Change not emailed', `Sending is paused on the account, so nobody was emailed about being taken out of ${was.group_name}: ${listNames(gone)}. Their links say so.`);
    noteStopped(e, was.group_name, told.stopped, 'that they were taken out of the group');
    for (const m of quiet ? [] : gone)
      await sendMail({ to: m.email, subject: `No longer needed: ${e.subject}`, heading: 'You no longer need to look at this',
        lines: [`${sender?.name || 'The sender'} changed who can act for ${was.group_name} on this document, and you are no longer one of them. There is nothing more for you to do. The link you were sent now says the same.`],
        envelopeId: e.id, recipientId: r.id, brand: brandOf(e.account_id), replyTo: sender?.email, fromName: sender?.name });
    if (!r.group_name || r.claimed_by || !(r.status === 'sent' || r.status === 'viewed' || (r.role === 'cc' && r.status === 'completed'))) continue;
    const asked = reachable(r, active(r.id).filter((x: any) => !x.sent_at));
    // Said once, for someone this correction added: a member left out before was written down then.
    noteStopped(e, r.group_name, asked.stopped.filter((m: any) => !(was.members || []).some((x: any) => x.id === m.id)), 'the document');
    for (const m of asked.to) {
      const how = await write(e, memberAs(r, m), 'new');
      if (!how) continue;
      run('UPDATE recipient_members SET sent_at=? WHERE id=?', now(), m.id);
      if (how === 'outbox') audit(e.id, SYSTEM, 'Not emailed', `${m.name} <${m.email}>, added to ${r.group_name}. No mail server is set up, so no email went out. The sender can pass on their signing link.`);
      else if (how !== 'failed') audit(e.id, SYSTEM, r.role === 'cc' ? 'Copy sent' : 'Sent to recipient', `${m.name} <${m.email}>, added to ${r.group_name}`);
    }
  }
}

// ---- The link of one member -------------------------------------------------------------------------------------

/** The member a signing link belongs to, or null when it is not a member's link. */
export const memberOf = (tok: string): any => get('SELECT * FROM recipient_members WHERE token=?', tok);

// What each state of a member's link may do. Everything else is refused in words.
//   open:    nobody has taken the document on. Reading it and agreeing (which takes it on) are open to every member.
//   copy:    the group only gets a copy. Every member reads it with their own link.
//   taken:   a colleague has it. This link shows who, and can ask the sender to give it back to the group.
//   removed: the sender took this member out of the group, or put a person where the group was.
// 'mail-again' is how a member who marked our email as spam, or reported the document, asks for our emails again.
const MAY: Record<string, string[]> = {
  open: ['', 'doc', 'download', 'consent', 'decline', 'ask', 'comments', 'request-extension', 'unlock', 'ask-code', 'mute', 'report', 'mail-again'],
  copy: ['', 'doc', 'download', 'ask', 'comments', 'unlock', 'ask-code', 'mute', 'report', 'mail-again'],
  taken: ['', 'take-over', 'unlock', 'ask-code', 'mute', 'report', 'mail-again'],
  removed: ['', 'report'],
};

const contact = (e: any) => {
  const s = senderOf(e);
  return s ? `${s.name}${s.email ? ` (${s.email})` : ''}` : 'the sender';
};
/** Said to the other members once one of them has the document, on their screen and to anything they try. */
export function takenText(e: any, row: any): string {
  return row.status === 'completed'
    ? `${row.name} from ${row.group_name} has ${groupDid(row.role)} this, so there is nothing left to do with this link.`
    : `${row.name} from ${row.group_name} has taken this on, so this link no longer opens the document. If you should ${groupDoes(row.role)} it instead, ask ${contact(e)} to give it back to the group.`;
}

/**
 * Called by look() in routes-sign.ts for a link that belongs to a member of a group. The member who took the
 * document on is from there the recipient like any other, named with the group in the record. Every other member
 * is given the group's row under their own name and address, and only what MAY allows for the state of their link.
 */
export function asMember(c: Ctx, out: { e: any; r: any; locked: boolean; gate: any; actor: Actor }, m: any) {
  const row = out.r;
  // This person's own marks: a spam mark (kept for the account) or a report of this document. Nothing more is
  // emailed to them about it, their page says so, and they alone can undo it there (mail-again).
  const s = stopOf(m.id);
  if (row.group_name && row.claimed_by === m.id && !m.removed_at) return { ...out, r: { ...row, complained_at: row.complained_at || s.complained, reported_at: s.reported }, actor: { ...out.actor, name: `${actingName(row)} <${row.email}>` } };
  const state = m.removed_at || !row.group_name ? 'removed' : row.role === 'cc' ? 'copy' : row.claimed_by ? 'taken' : 'open';
  const what = c.url.pathname.replace(/^\/api/, '').split('/')[3] || '';
  if (!MAY[state].includes(what)) {
    if (state === 'removed') throw bad(`You are no longer one of the people who can act on this document${row.group_name ? ` for ${row.group_name}` : ''}: ${senderOf(out.e)?.name || 'the sender'} changed that. There is nothing for you to do.`, 403, { code: 'removed' });
    if (state === 'taken') throw bad(takenText(out.e, row), 409, { code: 'taken' });
    if (state === 'copy') throw bad(`This link is for reading the copy that was sent to ${row.group_name}. There is nothing to sign or fill in with it.`, 409, { code: 'copy' });
    throw bad(`Agree to ${groupDoes(row.role)} first. This document was sent to ${row.group_name}, and the first member who agrees takes it on. Until then nothing can be filled in or saved through this link.`, 409, { code: 'not_taken' });
  }
  // code_frozen_at: the group's code is frozen, or (for a member who cannot act) this member's own link is (memberWrongCode).
  const r = { ...row, name: m.name, email: m.email, token: m.token, check_code: m.check_code, muted: m.muted, member: m, group_state: state, complained_at: s.complained, reported_at: s.reported,
    code_frozen_at: row.code_frozen_at || ((state === 'taken' || state === 'copy') && frozenAlone(row, m) ? now() : null) };
  // "member of": someone who only looks, mutes or asks has not acted for the group. "for" is kept for the one who
  // takes it on (takeOn below), so the record and the certificate never read as if everyone who looked acted.
  const actor = { ...out.actor, name: `${m.name}${row.group_name ? `, member of ${row.group_name}` : ''} <${m.email}>` };
  // Someone who is no longer on the document is told so at once: there is nothing behind the access code for them.
  return state === 'removed' ? { ...out, r, actor, locked: false, gate: null } : { ...out, r, actor };
}

/**
 * What the signing screen of a group's document has to know, or null for a recipient that is no group: the group,
 * how many people it is, what this link is to it ("open", "mine", "taken", "copy" or "removed"), who has the
 * document and since when, and what this link can still ask for.
 */
export function groupFacts(e: any, r: any): any {
  if (!r?.group_name && !r?.member) return null;
  const size = r.group_name ? get('SELECT COUNT(*) n FROM recipient_members WHERE recipient_id=? AND removed_at IS NULL', r.id).n : 0;
  const state: string = r.member ? r.group_state : r.claimed_by ? 'mine' : 'open';
  const row = r.member ? get('SELECT name, status, claimed_at, completed_at FROM recipients WHERE id=?', r.id) : r;
  const out = e.status === 'sent' && (row.status === 'sent' || row.status === 'viewed');
  return {
    name: r.group_name || null, size, state, away: state === 'taken' || state === 'removed',
    by: state === 'taken' ? row.name : null, at: state === 'taken' || state === 'mine' ? row.claimed_at : null,
    done: state === 'taken' && row.status === 'completed', done_at: state === 'taken' ? row.completed_at : null,
    can_hand_back: state === 'mine' && out, can_ask: state === 'taken' && e.status === 'sent' && row.status !== 'completed' && row.status !== 'declined',
  };
}

/** The first time a member opens the document it is written down, so the record says who looked, not only who signed. */
export function memberOpened(e: any, r: any, actor: Actor) {
  const m = r?.member;
  if (!m || m.viewed_at || e.status !== 'sent' || !run('UPDATE recipient_members SET viewed_at=? WHERE id=? AND viewed_at IS NULL', now(), m.id).changes) return;
  // markViewed has just written the line for the first member who opened it. Every later one gets a line here.
  if (r.status !== 'sent') audit(e.id, actor, 'Viewed', `${m.name} opened the envelope`);
}

/**
 * Called after a member of a group (or the member who has its document) reports it, on their signing page or with the
 * security code of an email. Nothing more is emailed to that person about this envelope, the record says so, and
 * the answer tells them. The other members are not affected. Answers null for a recipient that is no group member.
 */
export function memberReported(e: any, r: any, actor: Actor): { ok: true; mail_stopped: true } | null {
  const mid = r?.member?.id || (r?.group_name ? r.claimed_by : null);
  if (!mid) return null;
  const m = get('SELECT * FROM recipient_members WHERE id=?', mid);
  if (!m) return null;
  if (run('UPDATE recipient_members SET reported_at=? WHERE id=? AND reported_at IS NULL', now(), m.id).changes)
    audit(e.id, actor, 'Emails stopped', `${m.name} <${m.email}>, of ${r.group_name}, reported this document, so nothing more is emailed to them about it: no reminders, no notices and no copy. The other members of ${r.group_name} are not affected. Their link still works, and only they can start our emails again, on their signing page.`);
  return { ok: true, mail_stopped: true };
}

/** A member asked for our emails again with the code sent to their address: their report of this envelope no longer stops them. */
export function memberWantsMail(r: any) {
  const mid = r?.member?.id || (r?.group_name ? r.claimed_by : null);
  if (mid) run('UPDATE recipient_members SET reported_at=NULL WHERE id=?', mid);
}

/**
 * For a spam mark the mail provider reports about an address that is on this envelope only as a member of a group
 * (routes-bounces.ts): who it is, and what the sender is told. The mark itself is kept for the account like anyone's,
 * which is what stops our emails to them (memberMailStop). Null when the address is no member's.
 */
export function complainedMember(e: any, email: string): { name: string; audit: string; lines: string[] } | null {
  const m = get(`SELECT m.name, m.email, r.group_name FROM recipient_members m JOIN recipients r ON r.id=m.recipient_id
    WHERE m.envelope_id=? AND m.email=? COLLATE NOCASE AND r.group_name IS NOT NULL ORDER BY m.removed_at IS NOT NULL, m.position LIMIT 1`, e.id, email);
  if (!m) return null;
  const who = `${m.name} <${m.email}>, a member of ${m.group_name},`;
  return {
    name: m.name,
    audit: `${who} marked the email "${str(e.subject, 200)}" as spam in their mail program. Nothing more is emailed to them about this account's documents unless they ask for it themselves on a signing page. The other members of ${m.group_name} are not affected.`,
    lines: [
      `${who} marked the email "${e.subject}" as spam in their mail program. So we no longer email ${m.name} about documents from your account: no reminders, no notice when you change one, no notice when the document comes back to the group, and no copy when one is completed. That holds for this envelope, for any other that is out to them, and for new ones.`,
      `The other members of ${m.group_name} are not affected: they still get their emails, and any of them can still act. ${m.name}'s own link still works too.`,
      `Only ${m.name} can undo that: their signing page has a button that starts our emails to them again. While nobody has taken the document on, you can still give them their link yourself: open the envelope and choose Copy link next to ${m.name} under ${m.group_name}.`,
    ],
  };
}

// ---- The access code, for a member who cannot act -------------------------------------------------------------
// A group has one access code, and while nobody has taken the document on every member's wrong tries count towards
// freezing it, as one person's would. Once a colleague has it ('taken'), or when the group only gets a copy ('copy'),
// a member's wrong tries are counted for that member alone: their own link freezes, and the code of the person who
// is signing (and of every other member) keeps working. A new code from the sender starts every count again.
const codeFor = (r: any) => sha256(`member-code:${r.id}:${r.access_code || ''}`).slice(0, 24);
const countsAlone = (r: any) => !!r?.member && (r.group_state === 'taken' || r.group_state === 'copy');
const frozenAlone = (r: any, m: any) => !!r.access_code && (m.code_fails || 0) >= ACCESS_CODE_TRIES && m.code_for === codeFor(r);

/**
 * Called by POST /sign/:token/unlock for a wrong code. Answers how many tries are left for this link, or null when
 * the member's tries count for the group (then wrongAccessCode in envelopes.ts counts them, as before).
 */
export async function memberWrongCode(e: any, r: any, actor: Actor): Promise<number | null> {
  if (!countsAlone(r)) return null;
  const m = r.member, mark = codeFor(r);
  audit(e.id, actor, 'Access code failed', `${m.name}, of ${r.group_name}. Counted for ${m.name}'s own link only, because ${r.group_state === 'copy' ? 'the group only gets a copy' : 'a colleague has taken the document on'}.`);
  run('UPDATE recipient_members SET code_fails=CASE WHEN code_for=? THEN code_fails+1 ELSE 1 END, code_for=? WHERE id=?', mark, mark, m.id);
  const fails = get('SELECT code_fails n FROM recipient_members WHERE id=?', m.id).n;
  if (fails === ACCESS_CODE_TRIES) {
    audit(e.id, SYSTEM, 'Access code frozen', `For ${m.name}'s link only (${r.group_name}): ${ACCESS_CODE_TRIES} wrong tries. The code still opens the document for everyone else.`);
    await notifySender(e, 'always', `Access code frozen for one link: ${e.subject}`, `The access code no longer opens ${m.name}'s link`,
      [`It was entered wrongly ${ACCESS_CODE_TRIES} times on the link of ${m.name}, a member of ${r.group_name}, so it no longer opens that one link. That keeps it from being guessed.`,
        `It still works for everyone else in ${r.group_name}${r.group_state === 'taken' ? `, ${get('SELECT name FROM recipients WHERE id=?', r.id)?.name} who has the document included` : ''}. If ${m.name} should get in, set a new code with "Access code" next to ${r.group_name} on the envelope page and give it to them yourself. Everyone then needs the new code.`]);
  }
  return Math.max(0, ACCESS_CODE_TRIES - fails);
}

/** One member turns reminders off for themselves. The others keep getting theirs. */
export function muteMember(e: any, r: any, actor: Actor) {
  if (!run('UPDATE recipient_members SET muted=1 WHERE id=? AND muted=0', r.member.id).changes) return;
  audit(e.id, actor, 'Reminders stopped', `${r.member.name}${r.group_name ? ` (${r.group_name})` : ''} asked not to be reminded again`);
}

// ---- Taking it on, handing it back, declining -------------------------------------------------------------------

/**
 * Called where a member agrees to the consent screen (and before a member declines). One statement takes the
 * document on for whoever is first, and only while nobody has it and it is still open. Whoever comes second
 * changes nothing and is told who has it. From here on the row is this person's: their name, their address, their
 * own link and the security code of their own emails. `why` finishes the sentence in the record.
 */
export function takeOn<T extends { e: any; r: any; actor: Actor }>(x: T, why = ''): T {
  const m = x.r?.member;
  if (!m || x.r.group_state !== 'open') return x;
  const t = now();
  // Money: the sender who takes a group's document on under their own name and address signs their own document,
  // which is free, as it is when they sign it directly (isSelf in credits.ts). So the signature held for the group
  // is let go. A group whose signature was used once stays free whoever signs (settleGroups). Handing it back puts
  // the hold back (unclaim).
  const own = isSelf({ role: x.r.role, name: m.name, email: m.email }, senderOf(x.e) || '') ? 1 : 0;
  const got = run(`UPDATE recipients SET claimed_by=?, claimed_at=?, name=?, email=?, token=?, check_code=?, muted=?, viewed_at=?, ip=?, user_agent=?, sender_name=NULL, self_name=NULL,
        free=CASE WHEN COALESCE(free, 0)=1 THEN 1 ELSE ? END
      WHERE id=? AND group_name IS NOT NULL AND claimed_by IS NULL AND status IN ('sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent'`,
    m.id, t, m.name, m.email, m.token, m.check_code, m.muted ? 1 : 0, m.viewed_at || t, x.actor.ip || null, (x.actor.ua || '').slice(0, 300) || null, own, x.r.id).changes;
  if (!got) {
    const cur = get('SELECT * FROM recipients WHERE id=?', x.r.id);
    if (cur?.claimed_by && cur.claimed_by !== m.id) throw bad(takenText(x.e, cur), 409, { code: 'taken' });
    throw notOpen(x.e, cur || x.r);
  }
  const others = active(x.r.id).filter((o: any) => o.id !== m.id);
  // From here this person acts for the group, and the record says so.
  const actor = { ...x.actor, name: `${m.name}, for ${x.r.group_name} <${m.email}>` };
  audit(x.e.id, actor, 'Taken on for a group', `${m.name} <${m.email}> took this on for ${x.r.group_name}${why || `, by agreeing to ${groupDoes(x.r.role)} it`}. The links of the other members now say so: ${others.map((o: any) => `${o.name} <${o.email}>`).join(', ') || 'nobody else'}.`);
  const e = loadEnvelope(x.e.id);
  return { ...x, e, r: e.recipients.find((y: any) => y.id === x.r.id), actor };
}

// Nobody has the document any more: the row is the group's again, with no link of its own, and nothing the person
// who had it typed, ticked, uploaded or drew stays in its fields. A row that waits for its turn keeps waiting.
// One statement decides, so two requests at the same moment do it once. Answers whether it was done.
function unclaim(r: any, alsoWaiting: boolean): boolean {
  const t = now();
  return tx(() => {
    // The time zone the member's device reported goes with them, like their answers: the next member reports their own.
    const done = run(`UPDATE recipients SET claimed_by=NULL, claimed_at=NULL, name=group_name, email='', token=NULL, check_code=NULL, consent_at=NULL, viewed_at=NULL, muted=0, tz=NULL, reminder_held_at=NULL,
        sent_at=CASE WHEN status='pending' THEN NULL ELSE ? END, status=CASE WHEN status='pending' THEN 'pending' ELSE 'sent' END,
        unopened_alerted_at=NULL, dead_link_alerted_at=NULL, sender_name=NULL, self_name=NULL, signature_png=NULL, initials_png=NULL, ip=NULL, user_agent=NULL, seen_version=NULL, signed_before=NULL,
        free=CASE WHEN ${PAID_HERE} THEN 1 ELSE 0 END
      WHERE id=? AND group_name IS NOT NULL AND claimed_by IS NOT NULL AND status IN (${alsoWaiting ? "'pending'," : ''}'sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent'`, t, r.id).changes;
    if (done) run("UPDATE fields SET value=prefill WHERE recipient_id=? AND readonly=0 AND type!='note'", r.id);
    return !!done;
  });
}

// Tells the members that the document is with the whole group again, each with their own link. It is news, not a
// reminder, so it also goes to someone who turned reminders off. While the sender is paused, or the envelope reads
// like a fake notice, nobody is emailed in the sender's name: the links work all the same, and the record says so.
// Answers how many were emailed and how many were not (for a mark of their own, or because sending is held back),
// so whoever is told about it afterwards is told the truth.
type Told = { emailed: number; not: number; outbox?: number };
async function tellGroup(e: any, r: any, said: string, skip?: string): Promise<Told> {
  const size = active(r.id).length;
  const { to: members, stopped } = reachable(r, active(r.id).filter((m: any) => m.id !== skip));
  if (r.status === 'pending') return { emailed: 0, not: 0 };
  noteStopped(e, r.group_name, stopped, 'that the document is with the group again');
  if (!members.length) return { emailed: 0, not: stopped.length };
  if (emailRefusal(e)) return (audit(e.id, SYSTEM, 'Change not emailed', `Emails in the sender's name are held back on this account or for this envelope, so the members of ${r.group_name} were not emailed that the document is with the group again: ${listNames(members)}. Their links work.`), { emailed: 0, not: members.length + stopped.length });
  const sender = senderOf(e);
  let outbox = 0; // with no mail server set up, nothing leaves this server, and that is said as such
  for (const m of members) {
    if ((await sendMail({
      to: m.email, subject: `Back with ${r.group_name}: ${e.subject}`, heading: `This document is with ${r.group_name} again`,
      lines: [said, groupInvite(r.group_name, size, r.role),
        ...(r.access_code ? [`You will need an access code to open it. ${sender?.name || 'The sender'} will give it to you separately. It is not in this email.`] : []),
        `Sent by ${sender?.name} (${sender?.email}). Reply to this email to reach them directly.`],
      cta: { label: r.role === 'approver' ? 'Review and approve' : r.role === 'viewer' ? 'View document' : 'Review and sign', url: linkOf(m) },
      envelopeId: e.id, recipientId: r.id, brand: brandOf(e.account_id), replyTo: sender?.email, fromName: sender?.name, code: m.check_code, askForPdf: sender?.name,
    })) === 'outbox') outbox++;
    if (!m.sent_at) run('UPDATE recipient_members SET sent_at=? WHERE id=?', now(), m.id);
  }
  return { emailed: members.length - outbox, not: stopped.length, outbox };
}
// What the sender is told about that, in one sentence.
const toldText = (t: Told) =>
  !t.emailed && t.outbox ? 'No mail server is set up here, so no email went out. Copy their links from the envelope page and send them yourself.'
  : !t.emailed ? 'Nobody was emailed about it (the envelope\'s record says why), so if it is urgent, copy their links from the envelope page and send them yourself.'
    : `${many(t.emailed, 'member')} ${t.emailed === 1 ? 'was' : 'were'} emailed their link${t.not ? `, and ${many(t.not, 'other')} ${t.not === 1 ? 'was' : 'were'} not (the envelope's record says why)` : ''}.`;

/**
 * The member who took a group's document on hands it back to the group, before finishing. Nothing they filled in
 * goes with it. Every other member is emailed, the sender is told whatever their settings (who signs is the
 * sender's business), and their own link is a member's link again.
 */
export async function handBack(e: any, r: any, reason: any, actor: Actor): Promise<void> {
  if (!r?.group_name || !r.claimed_by) throw bad('This document was not sent to a group, so there is no group to hand it back to. To pass it to another person, choose "Pass to someone else".');
  if (r.status === 'completed') throw bad('You have already finished this document, so it can no longer be handed back.', 409);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  const why = str(reason, 300).trim();
  if (!unclaim(r, false)) throw bad('This document is no longer yours to hand back. Open your link again to see where it stands.', 409);
  audit(e.id, actor, 'Handed back to the group', `${r.name} <${r.email}> handed this back to ${r.group_name}${why ? `: ${why}${/[.!?]$/.test(why) ? '' : '.'}` : '.'} Nothing that ${r.name} had filled in or signed was passed on. Any member can take it on again.`);
  const fresh = loadEnvelope(e.id);
  const row = fresh.recipients.find((x: any) => x.id === r.id);
  // The note is a stranger's words as far as the other members' inboxes go (anyone holding a member's link can type
  // it), so it goes to the sender and into the record only, never into the email the group gets in the sender's name.
  const told = await tellGroup(fresh, row, `${r.name} had taken this on and has handed it back to ${r.group_name}. Nothing ${r.name} filled in was kept.`, r.claimed_by);
  await notifySender(e, 'always', `Handed back: ${e.subject}`, `${r.name} handed this back to ${r.group_name}`,
    [`${r.name} <${r.email}> had taken "${e.subject}" on for ${r.group_name} and has handed it back${why ? `, with this note for you: ${why}` : ''}.`,
      `Every member of ${r.group_name} can take it on again. ${toldText(told)}${told.emailed && why ? ' The note was not passed on to them.' : ''} Nothing ${r.name} had filled in was kept. You do not have to do anything.`]);
}

/**
 * The sender gives a group's document back to the whole group: the answer to a member who asked to take over, or to
 * a colleague who took it on and is away. Works while the person who has it has not finished.
 */
export async function releaseGroup(e: any, recipientId: string, actor: Actor): Promise<{ ok: true; emailed: number; not_emailed: number; told: string }> {
  const r = e.recipients.find((x: any) => x.id === recipientId);
  if (!r) throw bad('Recipient not found.', 404);
  if (!r.group_name) throw bad(`${r.name} is one person, not a group, so there is no group to give this back to. To send it to someone else, choose Correct next to their name.`);
  if (e.status !== 'sent') throw bad('Only an envelope that is out for signature can be given back to a group.');
  if (r.status === 'completed') throw bad(`${r.name} has already ${groupDid(r.role)} for ${r.group_name}, so it can no longer be given back. Nothing was changed.`, 409);
  if (!r.claimed_by) throw bad(`Nobody from ${r.group_name} has taken this on yet, so every member can already open it. Nothing was changed.`, 409);
  if (!unclaim(r, true)) throw bad('This changed while you were looking at it. Load the envelope again to see where it stands. Nothing was changed.', 409);
  audit(e.id, actor, 'Given back to the group', `The sender took this back from ${r.name} <${r.email}> and gave it to all of ${r.group_name}. Nothing that ${r.name} had filled in or signed was kept. Any member can take it on.`);
  const fresh = loadEnvelope(e.id);
  const sender = senderOf(e);
  const row = fresh.recipients.find((x: any) => x.id === r.id);
  const t = await tellGroup(fresh, row, `${sender?.name || 'The sender'} gave this back to all of ${r.group_name}. ${r.name} had taken it on before, and what ${r.name} had filled in was not kept.`);
  // The screen says what became of the emails (GroupMembers.tsx), never more than happened: while sending is paused,
  // or for members who stopped our emails, nobody is emailed.
  return { ok: true, emailed: t.emailed, not_emailed: t.not + (t.outbox || 0), told: row.status === 'pending' ? `It is not the turn of ${r.group_name} yet: every member is emailed their link when it is.` : toldText(t) };
}

/** A member whose colleague has the document asks the sender to give it back to the group. Only the sender can. */
export async function askTakeOver(e: any, r: any, actor: Actor): Promise<void> {
  const m = r?.member;
  const row = m && get('SELECT * FROM recipients WHERE id=?', r.id);
  if (!m || r.group_state !== 'taken' || !row?.claimed_by) throw bad('Nobody else has taken this document on, so there is nothing to ask for. Open your link again to see where it stands.', 409);
  if (e.status !== 'sent' || row.status === 'completed' || row.status === 'declined') throw bad(row.status === 'completed' ? takenText(e, row) : 'This document is no longer open, so it cannot be taken over.', 409);
  audit(e.id, actor, 'Take-over asked for', `${m.name} <${m.email}> asked the sender to give this back to ${row.group_name}. ${row.name} <${row.email}> took it on on ${ts(row.claimed_at)}.`);
  await notifySender(e, 'always', `Asked to take over: ${e.subject}`, `${m.name} asks to take this over from ${row.name}`,
    [`"${e.subject}" was sent to ${row.group_name}. ${row.name} took it on on ${ts(row.claimed_at)} and has not finished. ${m.name} <${m.email}>, also in ${row.group_name}, asks to do it instead.`,
      `If you agree, open the envelope and choose "Give back to the group" next to ${row.group_name}. Every member can then take it on, and what ${row.name} had filled in is cleared. If you do nothing, it stays with ${row.name}.`]);
}

/**
 * One member declining declines for the group, and the screen says so before they do. A member who had not taken
 * the document on is first put on record as the person who acted. The other members who were sent it are told.
 */
export async function declineForGroup(e: any, r: any, reason: string, actor: Actor, told?: (x: { e: any; r: any }) => Promise<void>): Promise<void> {
  let x = { e, r, actor };
  if (r.member) {
    // Checked before anyone is put on record for it: a decline that is going to be refused takes nothing on.
    if (r.role !== 'signer' && r.role !== 'approver') throw bad('Only signers and approvers can decline.');
    if (!reason.trim()) throw bad('Please tell the sender why you are declining.');
    x = takeOn(x, ', in order to decline it');
  }
  await declineRecipient(x.e, x.r, reason, x.actor, told);
  const row = x.r;
  const { to: others, stopped } = reachable(row, active(row.id).filter((m: any) => m.id !== row.claimed_by && m.sent_at));
  noteStopped(x.e, row.group_name, stopped, 'that it was declined');
  if (!others.length || emailRefusal(x.e)) return;
  const sender = senderOf(x.e);
  for (const m of others)
    await sendMail({ to: m.email, subject: `Declined: ${e.subject}`, heading: 'This document was declined',
      lines: [`${row.name} declined it for ${row.group_name}, so the document is closed for everyone. There is nothing more for you to do.`],
      envelopeId: e.id, recipientId: row.id, brand: brandOf(e.account_id), replyTo: sender?.email, fromName: sender?.name });
}

// ---- Finding documents, checking an email, the sender's copy of a link ----------------------------------------

/**
 * For "Find my documents": what is waiting for a group this address belongs to, and the copies a group got, each
 * with this member's own link. A document this person took on themselves is found like any other recipient's.
 */
export function memberLinks(email: string): { label: string; url: string; note: string }[] {
  return all(`SELECT m.token, r.group_name, r.role, e.subject, u.name sender
      FROM recipient_members m JOIN recipients r ON r.id=m.recipient_id JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
     WHERE m.email=? AND m.removed_at IS NULL AND m.token IS NOT NULL AND m.sent_at IS NOT NULL AND e.kind='envelope' AND r.group_name IS NOT NULL AND r.claimed_by IS NULL
       AND ((e.status='sent' AND r.status IN ('sent','viewed')) OR (r.role='cc' AND r.status='completed' AND e.status IN ('sent','completed')))
     ORDER BY e.updated_at DESC, m.position LIMIT 50`, email)
    .map((x) => ({ label: x.subject, url: `${baseUrl()}/sign/${x.token}`, note: `from ${x.sender} · ${x.role === 'cc' ? `a copy for ${x.group_name}` : `waiting for ${x.group_name}: any one of you can ${groupDoes(x.role)} it`}` }));
}

/**
 * For an email that came back (routes-bounces.ts): the member of a group on this envelope whose address it was, with
 * the sentence that tells the sender what that means. Null when the address is no member's. The group's own row is
 * not marked as bounced, because the other members can still be reached.
 */
export function bouncedMember(envelopeId: string, email: string): { name: string; line: string } | null {
  const m = get(`SELECT m.name, r.group_name FROM recipient_members m JOIN recipients r ON r.id=m.recipient_id
    WHERE m.envelope_id=? AND m.email=? COLLATE NOCASE AND m.removed_at IS NULL AND r.group_name IS NOT NULL ORDER BY m.position LIMIT 1`, envelopeId, email);
  return m ? { name: m.name, line: `This address belongs to ${m.name}, a member of ${m.group_name}. The other members of ${m.group_name} were emailed separately and are not affected, and any of them can still act. No reminders go to this address. To fix it, open the document, choose Edit, take ${m.name} out of the group and add them again with the right address: they are emailed a new link when you save. Or copy their link from the document's page and send it to them yourself.` } : null;
}

/**
 * For an email that came back from the member who has taken a group's document on (routes-bounces.ts): what the
 * sender can do about it. "Correct" changes one person's address and is refused for a group, so it is not offered.
 * Null for a recipient that is no such member.
 */
export function holderBounceLine(r: any): string | null {
  if (!r?.group_name || !r.claimed_by) return null;
  return `${r.name} took this on for ${r.group_name}, and no reminders go to this address now. If the address is wrong, open the document and choose "Give back to the group", so that another member of ${r.group_name} can act; or choose Edit, take ${r.name} out of ${r.group_name} and add them again with the right address, and they are emailed a new link when you save. If the address is right and the mailbox works again, choose "Try again" next to ${r.name}.`;
}

/** The same for the list of documents sent to someone who is signed in (GET /inbox). */
export function memberInbox(email: string): any[] {
  return all(`SELECT e.id, e.subject, e.status, e.sent_at, e.completed_at, u.name sender, r.role, r.status my_status, m.token, r.group_name "group"
      FROM recipient_members m JOIN recipients r ON r.id=m.recipient_id JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
     WHERE m.email=? AND m.removed_at IS NULL AND m.token IS NOT NULL AND m.sent_at IS NOT NULL AND e.kind='envelope' AND r.group_name IS NOT NULL AND r.claimed_by IS NULL
       AND ((e.status='sent' AND r.status IN ('sent','viewed')) OR (r.role='cc' AND r.status='completed' AND e.status IN ('sent','completed')))
     ORDER BY e.updated_at DESC LIMIT 100`, email);
}

/**
 * For the check page: the security code of an email to a member, as the recipient it was sent to. Every member's
 * emails carry a code of their own, so the page names the right person and opens the right link.
 */
export function memberForCode(code: string): any {
  const m = get('SELECT * FROM recipient_members WHERE check_code=?', code);
  const r = m && get('SELECT * FROM recipients WHERE id=?', m.recipient_id);
  return r ? { ...r, name: m.name, email: m.email, token: m.token, check_code: m.check_code, sent_at: m.sent_at || r.sent_at, member: m } : null;
}

/**
 * For the check page, when the code is that of a member the sender took out of the group: the email was genuine,
 * and its link no longer opens the document, said like any other replaced link (why "removed"), with no link.
 */
export function removedMemberCheck(r: any): any {
  const e = get('SELECT subject, status, sender_id, account_id FROM envelopes WHERE id=?', r.envelope_id);
  const account = e && get('SELECT name, suspended_at FROM accounts WHERE id=?', e.account_id);
  return { genuine: true, replaced: true, why: 'removed', replaced_at: r.member.removed_at, for_name: r.member.name, sender: e ? get('SELECT name, email FROM users WHERE id=?', e.sender_id) : null,
    account: account?.name, paused: !!account?.suspended_at, subject: e?.subject || null, status: e?.status || null };
}

/**
 * For POST /envelopes/:id/recipient-view: the link of one member of a group, named by "member_id". Null when the
 * recipient is no group, or is the member who took the document on (then the recipient's own link is theirs).
 * Like every link that is handed out, it is written to the record, once a day at most for each member.
 */
export function memberLink(e: any, recipientId: string, memberId: any, actor: Actor): { url: string } | null {
  const r = e.recipients.find((x: any) => x.id === recipientId);
  if (!r?.group_name || e.status === 'draft') return null;
  const mid = str(memberId, 60).trim();
  if (r.claimed_by && (!mid || mid === r.claimed_by)) return null;
  if (!mid) throw bad(`${r.group_name} is a group, and every member has a link of their own. Send "member_id" with the id of one member (they are listed under "members" on the recipient) to get that person's link.`);
  const m = get('SELECT * FROM recipient_members WHERE id=? AND recipient_id=? AND removed_at IS NULL', mid, r.id);
  if (!m?.token) throw bad(`That member is not in ${r.group_name} on this envelope. The members are listed under "members" on the recipient.`, 404);
  if (run('UPDATE recipient_members SET link_issued_at=? WHERE id=? AND (link_issued_at IS NULL OR link_issued_at < ?)', now(), m.id, new Date(Date.now() - 864e5).toISOString()).changes)
    audit(e.id, actor, 'Signing link issued', `${m.name} <${m.email}>, for ${r.group_name}`);
  return { url: linkOf(m) };
}

/** A one-time code or a text message goes to one person. Asked of a group in the quick correction, it is refused. */
export function assertNoGroupCheck(e: any, recipientId: string, patch: any) {
  const r = e?.recipients?.find((x: any) => x.id === recipientId);
  if (!r?.group_name) return;
  const on = (v: any) => v === true || v === 1 || v === '1' || v === 'true';
  if ((patch?.verify != null && patch.verify !== '' && patch.verify !== 'none') || on(patch?.text_link) || String(patch?.phone ?? '').trim())
    throw bad(`${r.group_name} is a group. ${NO_CHECK} Nothing was changed.`);
}

/** The quick correction of one recipient changes a name or an address. A group has neither: only its access code can be set there. */
export function assertGroupCorrection(r: any, patch: { name?: string; email?: string }) {
  if (!r?.group_name) return;
  const name = patch.name === undefined ? r.name : str(patch.name, 500).trim(), email = patch.email === undefined ? r.email : str(patch.email, 500).trim();
  if (name !== r.name || lower(email) !== lower(r.email))
    throw bad(`${r.claimed_by ? `${r.name} acts for ${r.group_name}, which is a group` : `${r.group_name} is a group`}, so there is no single name or address to correct here. Nothing was changed. To change who is in the group, edit the document itself (Edit on its page in the app, or PUT /envelopes/{id} with "members"). To take the document back from the person who has it, choose "Give back to the group". The access code can be changed here: it needs at least ${ACCESS_CODE_MIN} characters.`);
}
