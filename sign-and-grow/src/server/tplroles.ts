// Who may use and change a template, and the lock on its wording. Teams asked for templates for HR only, templates
// a few people may change, and contracts nobody can send altered. Three settings on each template, set by the person
// it belongs to and by admins (never by the people they chose):
//   tpl_use     'team' (also empty: everyone, as before), 'admins' (admins only) or 'chosen' (chosen members)
//   tpl_change  'owner' (also empty: the person it belongs to and admins, as before), 'chosen' or 'team'
//   tpl_locked  1: an envelope started from it by someone who may not change it keeps its documents, fields, fixed
//               wording, message and signing order. Names, addresses and the fields left empty can be filled in.
// The chosen members are lines in template_members (can_change for the ones who may also change it). Admins and the
// owner of the account can always use and change everything, so nothing is ever locked away from the people who
// are responsible for the account. A person who may change a template may always use it.
// The routes are in routes-templates.ts. This file reads the database only, so envelopes.ts can call it.
import type { Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, str } from './util.ts';
import { TPL_USES, TPL_CHANGES, LOCK_MEANS, type TplUse, type TplChange, type TplAccess } from '../lib/tplroles.ts';

export type Rule = { use: TplUse; change: TplChange; locked: boolean };
export const ruleOf = (t: any): Rule => ({
  use: (TPL_USES as readonly string[]).includes(t?.tpl_use) ? t.tpl_use : 'team',
  change: (TPL_CHANGES as readonly string[]).includes(t?.tpl_change) ? t.tpl_change : 'owner',
  locked: !!t?.tpl_locked,
});
const lineOf = (t: any, userId: string) => get('SELECT can_change FROM template_members WHERE template_id=? AND user_id=?', t.id, userId);
export const ownerName = (t: any): string => get('SELECT name FROM users WHERE id=?', t?.sender_id)?.name || 'a colleague';
/** Who to ask, for the end of a refusal: "Maya Lopez or an admin of your team". */
export const askWho = (t: any) => (t ? `${ownerName(t)} or an admin of your team` : 'an admin of your team');

/** The person it belongs to and admins: the only ones who set the rules, and who can delete it. */
export const maySetRules = (c: Ctx, t: any) => c.admin || t.sender_id === c.user.id;

export function mayChange(c: Ctx, t: any): boolean {
  if (maySetRules(c, t)) return true;
  const r = ruleOf(t);
  return r.change === 'team' || (r.change === 'chosen' && !!lineOf(t, c.user.id)?.can_change);
}

export function mayUse(c: Ctx, t: any): boolean {
  if (mayChange(c, t)) return true;
  const r = ruleOf(t);
  return r.use === 'team' || (r.use === 'chosen' && !!lineOf(t, c.user.id));
}

/**
 * The same rule as mayUse, as SQL for the list of templates (alias e), with its parameters. Empty for admins. A
 * template someone may not use is not listed, and neither is its folder: a folder name can say a lot by itself.
 */
export function usableSql(c: Ctx): [string, any[]] {
  if (c.admin) return ['', []];
  return [`(e.sender_id=? OR COALESCE(e.tpl_use,'team') NOT IN ('admins','chosen') OR e.tpl_change='team'
    OR EXISTS (SELECT 1 FROM template_members tm WHERE tm.template_id=e.id AND tm.user_id=? AND (e.tpl_use='chosen' OR (tm.can_change=1 AND e.tpl_change='chosen'))))`, [c.user.id, c.user.id]];
}

/** Refused when someone opens, uses, copies or sends from a template that is not for them. Says who to ask. */
export function assertMayUse(c: Ctx, t: any) {
  if (mayUse(c, t)) return;
  const r = ruleOf(t);
  throw bad(r.use === 'admins'
    ? `This template is for the admins of your team only, so you cannot open or use it. Ask ${askWho(t)} if you need it.`
    : `This template is for chosen members of your team, and you are not one of them, so you cannot open or use it. Ask ${askWho(t)} to add you if you need it.`, 403, { code: 'template_not_for_you' });
}

/** Refused when someone who may use a template changes, moves or deletes it. The usual words when the rule is the usual one. */
export function changeRefusal(c: Ctx, t: any, deleting = false) {
  const owner = ownerName(t);
  const r = ruleOf(t);
  const tail = r.locked ? ' Its wording is locked, and a copy of it is locked in the same way.' : ' To make your own version, copy it and change the copy.';
  // Someone who may change it, and is asked to delete it: deleting takes it away from everyone, so it stays with
  // the person it belongs to and the admins, like the rules themselves.
  if (deleting && mayChange(c, t))
    return bad(`You may change this template, but only ${owner} or an admin of your team can delete it, because deleting takes it away from everyone on the team for good. Nothing was deleted. Ask ${askWho(t)}.`, 403, { code: 'template_not_yours' });
  if (r.change === 'chosen')
    return bad(`This template belongs to ${owner}. You can use it, but only ${owner}, an admin of your team or a member they chose can change it, and only ${owner} or an admin can delete it. Ask ${askWho(t)} if it needs a change.${tail}`, 403, { code: 'template_not_yours' });
  return bad(`This template belongs to ${owner}. You can use it and copy it, but only ${owner} or an admin of your team can change or delete it.${r.locked ? ` Ask them if it needs a change.${tail}` : tail}`, 403, { code: 'template_not_yours' });
}

/**
 * What one person may do with each template of a list, for the page to show the right buttons and marks, in one
 * query for the whole page. Sets may_change (kept for the callers that read it) and access on every row.
 */
export function markList(c: Ctx, rows: any[]) {
  if (!rows.length) return;
  const ids = rows.map((e) => e.id);
  const marks = ids.map(() => '?').join(',');
  const rules = new Map(all(`SELECT id, sender_id, tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id IN (${marks})`, ...ids).map((t) => [t.id, t]));
  const lines = new Map(all(`SELECT template_id, can_change FROM template_members WHERE user_id=? AND template_id IN (${marks})`, c.user.id, ...ids).map((l) => [l.template_id, l]));
  for (const e of rows) {
    const t = rules.get(e.id) || e;
    const r = ruleOf(t);
    const line = lines.get(e.id);
    const set = maySetRules(c, t);
    const change = set || r.change === 'team' || (r.change === 'chosen' && !!line?.can_change);
    e.may_change = change;
    e.access = { ...r, may_use: true, may_change: change, may_delete: set, may_set: set };
  }
}

/** Everything the template page needs to show and change the rule: the rule, the sentence parts and the team. */
export function accessOf(c: Ctx, t: any) {
  const r = ruleOf(t);
  const lines = all('SELECT tm.user_id, tm.can_change, u.name FROM template_members tm JOIN users u ON u.id=tm.user_id WHERE tm.template_id=? ORDER BY u.name', t.id);
  const out: TplAccess & Record<string, any> = {
    ...r, owner: ownerName(t), owner_id: t.sender_id,
    chosen_use: r.use === 'chosen' ? lines.map((l) => l.name) : [], chosen_change: r.change === 'chosen' ? lines.filter((l) => l.can_change).map((l) => l.name) : [],
    may_use: mayUse(c, t), may_change: mayChange(c, t), may_delete: maySetRules(c, t), may_set: maySetRules(c, t),
  };
  // The team, so the people who set the rule can pick members. Only for them: who else is on the team, and who
  // was chosen, is theirs to see. Admins and the owner of the account are listed as always able.
  if (out.may_set) {
    const chosen = new Map(lines.map((l) => [l.user_id, l]));
    out.members = all('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY u.name', t.account_id)
      .map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, always: m.role !== 'member' || m.id === t.sender_id, chosen: chosen.has(m.id), can_change: !!chosen.get(m.id)?.can_change }));
  }
  return out;
}

// ---- Copies -----------------------------------------------------------------------------------------------------

const fixedOf = (e: any): string[] => {
  try {
    const l = JSON.parse(e?.wording_fixed || '[]');
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Called by copyEnvelope() for every copy it makes, after the copy is written. copyEnvelope writes the fields of the
 * copy in the order of src.fields, so the n-th field of the copy (by the order it was written in) is the copy of
 * the n-th field of the source.
 *   template to envelope   a locked template marks the envelope (wording_from), with its fields that carry the
 *                          template's own wording: a note, a strike-out, and every field the template filled in.
 *   envelope to envelope   a clone of a locked envelope is locked in the same way.
 *   to a template          the copy has the same rules and the same chosen people as the template it came from,
 *                          so a copy is never a way to reach more people or to get round the lock. Who it belongs
 *                          to is decided by the clone route (cloneOwner).
 */
export function carryRules(src: any, eid: string, kind: 'envelope' | 'template') {
  const ids: string[] = all('SELECT id FROM fields WHERE envelope_id=? ORDER BY rowid', eid).map((f) => f.id);
  const twin = new Map<string, string>((src.fields || []).map((f: any, i: number) => [f.id, ids[i]]));
  const mark = (from: string, fixed: string[]) => run('UPDATE envelopes SET wording_from=?, wording_fixed=? WHERE id=?', from, JSON.stringify(fixed.filter(Boolean)), eid);
  if (kind === 'envelope' && src.kind === 'template') {
    if (ruleOf(src).locked) mark(src.id, src.fields.filter((f: any) => f.type === 'note' || f.type === 'strike' || (f.value != null && f.value !== '')).map((f: any) => twin.get(f.id)!));
    return;
  }
  if (kind === 'envelope') {
    if (src.wording_from) mark(src.wording_from, fixedOf(src).map((fid) => twin.get(fid)!));
    return;
  }
  const from = src.kind === 'template' ? src : src.template_id ? get("SELECT * FROM envelopes WHERE id=? AND kind='template'", src.template_id) : null;
  if (!from) return;
  run('UPDATE envelopes SET tpl_use=?, tpl_change=?, tpl_locked=? WHERE id=?', from.tpl_use ?? null, from.tpl_change ?? null, from.tpl_locked ? 1 : 0, eid);
  run('INSERT OR IGNORE INTO template_members (template_id, account_id, user_id, can_change) SELECT ?, account_id, user_id, can_change FROM template_members WHERE template_id=?', eid, from.id);
}

/**
 * Who a copy that becomes a template belongs to. Normally the person who copies. A copy of a template whose wording
 * is locked, made by someone who may not change it, stays with the person the template belongs to: the same people
 * keep the say over it, and the lock holds on the copy too. An envelope whose locked template was deleted cannot be
 * made into a template by someone other than an admin, because that would end the lock.
 */
export function cloneOwner(c: Ctx, e: any, kind: 'envelope' | 'template'): string {
  if (kind !== 'template') return c.user.id;
  const from = e.kind === 'template' ? e : e.template_id ? get("SELECT * FROM envelopes WHERE id=? AND kind='template' AND account_id=?", e.template_id, e.account_id) : null;
  if (!from) {
    if (e.wording_from && !c.admin) throw bad(`This envelope was started from a template whose wording was locked, and that template has been deleted. A template made from it would no longer be locked, so it was not made. Ask ${askWho(null)}.`, 403, { code: 'wording_locked' });
    return c.user.id;
  }
  return ruleOf(from).locked && !mayChange(c, from) ? from.sender_id : c.user.id;
}

// ---- The lock on an envelope's wording ---------------------------------------------------------------------------

/** Whether the wording of this envelope is locked for this person, and what the editor needs to say so. */
export function wordingLock(c: Ctx, e: any): null | { template_id: string; template: string | null; ask: string; fixed: string[] } {
  if (e?.kind !== 'envelope' || !e.wording_from || c.admin) return null;
  const t = get("SELECT id, subject, sender_id, tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id=? AND kind='template'", e.wording_from);
  // Unlocking the template, or being given the right to change it, unlocks the envelopes already started from it.
  // A template that was deleted keeps its envelopes locked for everyone but admins.
  if (t && (!ruleOf(t).locked || mayChange(c, t))) return null;
  return { template_id: e.wording_from, template: t ? t.subject || 'Untitled template' : null, ask: askWho(t), fixed: fixedOf(e) };
}

const near = (a: any, b: any) => Math.abs(Number(a) - Number(b)) < 1e-7;
const text = (v: any) => (v == null ? '' : String(v));
const yes = (v: any, d: boolean) => (v == null || v === '' ? d : v === true || v === 1 ? true : v === false || v === 0 ? false : v);

/**
 * A save (PUT /envelopes/:id, a draft or a correction once it is out) of an envelope whose wording is locked for
 * this person. Whatever the body leaves out stays as it is, as with every save. What it sends must leave the locked
 * parts exactly as they are; anything else is refused with what was changed, and nothing is saved. Names, email
 * addresses, access codes, notes, checks, reminders, the deadline, the subject and the values of the fields the
 * template left empty can be changed.
 */
export function assertWordingKept(c: Ctx, e: any, b: any) {
  const lock = wordingLock(c, e);
  if (!lock) return;
  const no = (what: string) => {
    throw bad(`${what} ${lock.template ? `This envelope was started from the template "${lock.template}", whose wording is locked.` : 'This envelope was started from a template whose wording was locked.'} ${LOCK_MEANS} Nothing was saved. If it needs to change, ask ${lock.ask} to change the template.`, 403, { code: 'wording_locked', template_id: lock.template_id });
  };
  if (b.message !== undefined && text(b.message) !== text(e.message)) no('The message cannot be changed.');
  if (typeof yes(b.ordered, !!e.ordered) === 'boolean' && yes(b.ordered, !!e.ordered) !== !!e.ordered) no('Whether people sign in order cannot be changed.');
  if (b.documents !== undefined) {
    const d: any[] = Array.isArray(b.documents) ? b.documents : [];
    if (d.length !== e.documents.length) no(`The documents cannot be changed: it has ${e.documents.length} and the request has ${d.length}.`);
    d.forEach((x, i) => {
      const was = e.documents[i];
      const name = x?.name || get('SELECT name FROM files WHERE id=?', x?.file_id)?.name;
      if (text(x?.id) !== was.id || text(x?.file_id) !== was.file_id || text(name) !== was.name) no(`Document ${i + 1} ("${str(was.name, 60)}") cannot be changed, renamed or moved. Send the documents as they are, with their ids.`);
    });
  }
  if (b.recipients !== undefined) {
    const list: any[] = Array.isArray(b.recipients) ? b.recipients : [];
    if (list.length !== e.recipients.length) no(`People cannot be added or taken off: it has ${e.recipients.length} and the request has ${list.length}. Fill in the names and addresses of the people who are on it.`);
    const by = new Map<string, any>(e.recipients.map((r: any) => [r.id, r]));
    list.forEach((x, i) => {
      const was = by.get(text(x?.id));
      const role = x?.role == null || x.role === '' ? 'signer' : x.role;
      const order = x?.routing_order == null || x.routing_order === '' ? 1 : Number(x.routing_order);
      if (!was) no(`Recipient ${i + 1} is not one of the people on it. Send each person with the id they have.`);
      else if (role !== was.role || text(x.role_name) !== text(was.role_name) || order !== was.routing_order)
        no(`What ${str(was.name || was.role_name || `recipient ${i + 1}`, 120)} does, and their place in the order, cannot be changed. Their name and address can.`);
    });
  }
  if (b.fields !== undefined) {
    const list: any[] = Array.isArray(b.fields) ? b.fields : [];
    if (list.length !== e.fields.length) no(`Fields cannot be added or removed: it has ${e.fields.length} and the request has ${list.length}.`);
    const by = new Map<string, any>(e.fields.map((f: any) => [f.id, f]));
    const fixed = new Set(lock.fixed);
    list.forEach((f, i) => {
      const was = by.get(text(f?.id));
      const which = was?.type === 'note' ? `The note "${str(was.value, 60)}" on page ${was.page + 1}` : `Field ${i + 1}${was?.label ? ` ("${str(was.label, 60)}")` : ''}`;
      if (!was) return no(`${which} is not one of its fields. Send the fields with the ids they have.`);
      const mark = was.type === 'note' || was.type === 'strike';
      const same = f.type === was.type && text(f.document_id) === was.document_id && text(f.recipient_id) === text(was.recipient_id) && (Number(f.page) || 0) === was.page
        && near(f.x, was.x) && near(f.y, was.y) && near(f.w, was.w) && near(f.h, was.h) && yes(f.required, true) === !!was.required && text(f.label) === text(was.label)
        && JSON.stringify(f.options || []) === JSON.stringify(was.options || []) && text(f.group_name) === text(was.group_name) && text(f.validation) === text(was.validation)
        && (yes(f.readonly, false) === true || mark) === !!was.readonly;
      if (!same) no(`${which} cannot be moved, resized or changed.`);
      // The template's own wording stays: a value left out would empty it, so it counts as a change. Once the envelope
      // is out, a field its signer may change holds their answer in value and the template's wording in prefill;
      // the editor sends back either, and the save keeps the signer's answer whatever it is sent.
      const kept = text(f.value) === text(was.value) || (text(was.prefill) !== '' && text(f.value) === text(was.prefill));
      if (fixed.has(was.id) && !kept) no(`${which} holds wording from the template, and it cannot be changed.`);
    });
  }
}

/** Anything else that is part of what the template says: the message when it is used, and the payment link. */
export function assertNotLocked(c: Ctx, e: any, what: string) {
  const lock = wordingLock(c, e);
  if (lock) throw bad(`${what} ${lock.template ? `This envelope was started from the template "${lock.template}", whose wording is locked.` : 'This envelope was started from a template whose wording was locked.'} Nothing was saved. Ask ${lock.ask} if it needs to change.`, 403, { code: 'wording_locked', template_id: lock.template_id });
}

/** POST /envelopes with a template_id and a "message" of its own, from someone the template is locked for. */
export function assertMessageKept(c: Ctx, t: any, message: any) {
  if (message == null || text(message) === text(t.message) || !ruleOf(t).locked || mayChange(c, t)) return;
  throw bad(`The message cannot be changed: the wording of this template is locked. ${LOCK_MEANS} Nothing was created. Leave "message" out, or ask ${askWho(t)} to change the template.`, 403, { code: 'wording_locked', template_id: t.id });
}

/** A member who leaves the team or is removed is no longer one of the chosen people of any of its templates. */
export function forgetChosen(accountId: string, userId: string) {
  run('DELETE FROM template_members WHERE account_id=? AND user_id=?', accountId, userId);
}
