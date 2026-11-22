// One document started from two or more templates ("Add another template" in the Use dialog, "template_ids" on
// POST /envelopes). The documents come one after the other, in the order the templates were given. A role with the
// same name in more than one template becomes one person, with all of their fields. Everything else of each
// template comes too, the way one template's copy does (copyEnvelope in envelopes.ts): checks, notes, groups,
// waits, details, "Only when...", and the rest.
//
// Each template's own rules still hold for its own part:
//   who can use it   every template is checked (mine() refuses one this person may not use), so combining is no way
//                    round "admins only" or "chosen members".
//   locked wording   a part whose template is locked for this person keeps its documents, its fields and fixed
//                    wording, and its people (envelopes.wording_parts). The other parts can be changed as usual.
//                    The message and the signing order belong to the whole document, so they stay as soon as one
//                    part is locked. assertWordingKept (tplroles.ts) looks only at the locked parts (lockedPartsOnly).
import type { Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, str } from './util.ts';
import { copyEnvelope } from './envelopes.ts';
import { ruleOf, mayChange, mayUse, copyIsTheirs, assertMessageKept, askWho } from './tplroles.ts';
import { can } from './perm.ts';
import { MAX_COMBINED, roleKey, combinedName } from '../lib/tplcombine.ts';

/** One template's part: its template, its documents and its people on the envelope, and l: 1 when its wording was locked. */
export type Part = { t: string; docs: string[]; people: string[]; l?: 1 };

const ROLE_SAID: Record<string, string> = { signer: 'signs', approver: 'approves', cc: 'gets a copy', viewer: 'must open it', inperson: 'signs in person', witness: 'is a witness', editor: 'can change the document', agent: 'chooses who comes next' };

/** The template ids of a body's "template_ids", checked. Two to MAX_COMBINED, each once. */
export function readTemplateIds(b: any): string[] {
  const v = b.template_ids;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))
    throw bad('"template_ids" must be a list of template ids, written as text in quotes, like ["tpl_a", "tpl_b"]. Nothing was created.');
  const ids = v.map((x: string) => x.trim());
  if (new Set(ids).size !== ids.length) throw bad('"template_ids" names the same template twice. Name each template once. Nothing was created.');
  if (ids.length < 2) throw bad('"template_ids" needs two templates or more. For one template, send "template_id" instead. Nothing was created.');
  if (ids.length > MAX_COMBINED) throw bad(`One document can start from up to ${MAX_COMBINED} templates, and this asks for ${ids.length}. Send the rest as a document of their own. Nothing was created.`);
  if (b.template_id) throw bad('Send "template_id" for one template or "template_ids" for several, not both. Nothing was created.');
  if (b.kind === 'template') throw bad('Several templates make a document to send, not a new template. Leave "kind" out. Nothing was created.');
  return ids;
}

/**
 * Makes the envelope. `tpls` are the templates, already loaded through mine() (so each was checked for this person).
 * Returns its id. Refused, with nothing made, when two templates give the same role two different jobs or people.
 */
export function combineTemplates(c: Ctx, tpls: any[], o: { senderId: string; subject?: any; message?: any; fill?: Record<string, any> }): string {
  // A locked template keeps its own message for whoever may not change it: one message of their own is refused.
  for (const t of tpls) assertMessageKept(c, t, o.message);
  assertRolesFit(tpls, o.fill);
  const lockedFirst = tpls.find((t) => ruleOf(t).locked && !mayChange(c, t));
  const subject = o.subject != null && String(o.subject).trim() ? String(o.subject) : combinedName(tpls.map((t) => t.subject));
  // The message of the first locked template, so its wording is what is sent; otherwise the first template's.
  const message = o.message ?? (lockedFirst || tpls[0]).message;
  // copyEnvelope writes each copy in a transaction of its own, so this cannot be one: whatever was made is taken
  // away again when anything after it is refused, and nothing is left behind.
  const made: string[] = [];
  try {
    const eid = copyEnvelope(tpls[0], { accountId: c.account.id, senderId: o.senderId, kind: 'envelope', subject, message, fill: o.fill });
    made.push(eid);
    const parts: Part[] = [partOf(tpls[0], eid)];
    let fixed: string[] = listOf(get('SELECT wording_fixed FROM envelopes WHERE id=?', eid)?.wording_fixed);
    const people: Record<string, any> = mapOf(get('SELECT wording_people FROM envelopes WHERE id=?', eid)?.wording_people);
    for (const t of tpls.slice(1)) {
      const tmp = copyEnvelope(t, { accountId: c.account.id, senderId: o.senderId, kind: 'envelope', fill: o.fill });
      made.push(tmp);
      const row = get('SELECT wording_fixed, wording_people, ordered, own_docs FROM envelopes WHERE id=?', tmp);
      const part = partOf(t, tmp);
      const merged = tx(() => {
        const m = mergeInto(eid, tmp);
        // Rows still on the temporary envelope are this part's documents, fields and people: they move over whole.
        moveAll(tmp, eid);
        run('DELETE FROM audit WHERE envelope_id=?', tmp);
        run('DELETE FROM envelopes WHERE id=?', tmp);
        // Signing in order, and "each person sees only their files", belong to the whole document: on when any part has them.
        if (row?.ordered) run('UPDATE envelopes SET ordered=1 WHERE id=?', eid);
        if (row?.own_docs) run('UPDATE envelopes SET own_docs=1 WHERE id=?', eid);
        return m;
      });
      made.pop();
      // The people of this part as they are now: one merged with a person already on it is that person.
      part.people = [...new Set(part.people.map((r) => merged.get(r) || r))];
      parts.push(part);
      fixed = [...fixed, ...listOf(row?.wording_fixed)];
      for (const [rid, k] of Object.entries(mapOf(row?.wording_people))) {
        const to = merged.get(rid) || rid;
        people[to] = { ...(people[to] || {}), ...(k as any) };
      }
    }
    const locked = tpls.filter((t) => ruleOf(t).locked);
    // The parts are written even when none is locked: a copy, or a template made from it, has to know every template
    // it came from and its rules, not only the first one's (combinedCloneOwner).
    if (locked.length) run('UPDATE envelopes SET wording_from=?, wording_fixed=?, wording_people=?, wording_parts=? WHERE id=?', locked[0].id, JSON.stringify([...new Set(fixed)]), JSON.stringify(people), JSON.stringify(parts), eid);
    else run('UPDATE envelopes SET wording_from=NULL, wording_fixed=NULL, wording_people=NULL, wording_parts=? WHERE id=?', JSON.stringify(parts), eid);
    return eid;
  } catch (e) {
    for (const x of made) run('DELETE FROM envelopes WHERE id=?', x);
    throw e;
  }
}

/** The documents and people of one template's part, by the ids they have on the envelope `eid`. */
function partOf(t: any, eid: string): Part {
  return {
    t: t.id,
    ...(ruleOf(t).locked ? { l: 1 as const } : {}),
    docs: all('SELECT id FROM documents WHERE envelope_id=? ORDER BY position', eid).map((d) => d.id),
    people: all('SELECT id FROM recipients WHERE envelope_id=? ORDER BY rowid', eid).map((r) => r.id),
  };
}

/**
 * The people of `tmp` whose role has the same name as one on `eid` become that person: their fields, the witnesses
 * of their signature and the "Only when..." that names them point at the person on `eid`, and they go. Their documents
 * follow the ones already there. Returns which person of `tmp` became which.
 */
function mergeInto(eid: string, tmp: string): Map<string, string> {
  const merged = new Map<string, string>();
  const have = all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY rowid', eid);
  const byRole = new Map<string, any>();
  for (const r of have) if (roleKey(r.role_name) && !byRole.has(roleKey(r.role_name))) byRole.set(roleKey(r.role_name), r);
  const pos = get('SELECT COALESCE(MAX(position), -1) p FROM recipients WHERE envelope_id=?', eid).p as number;
  for (const r of all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY rowid', tmp)) {
    const keep = byRole.get(roleKey(r.role_name));
    if (!keep) {
      run('UPDATE recipients SET position=position+? WHERE id=?', pos + 1, r.id);
      continue;
    }
    merged.set(r.id, keep.id);
    // A template that names the person (the other one leaves the role open) gives the name and address.
    if (!keep.email && r.email) run('UPDATE recipients SET name=?, email=? WHERE id=?', r.name, r.email, keep.id);
    run('UPDATE fields SET recipient_id=? WHERE recipient_id=?', keep.id, r.id);
    run('UPDATE recipients SET witness_for=? WHERE witness_for=?', keep.id, r.id);
    for (const x of all("SELECT id, only_when FROM recipients WHERE envelope_id IN (?,?) AND only_when LIKE '%' || ? || '%'", eid, tmp, r.id))
      run('UPDATE recipients SET only_when=? WHERE id=?', String(x.only_when).split(r.id).join(keep.id), x.id);
    run('DELETE FROM recipients WHERE id=?', r.id);
  }
  const docPos = get('SELECT COALESCE(MAX(position), -1) p FROM documents WHERE envelope_id=?', eid).p as number;
  run('UPDATE documents SET position=position+? WHERE envelope_id=?', docPos + 1, tmp);
  return merged;
}

// The tables whose rows belong to one envelope and go with it (a foreign key to envelopes, deleted with it). Looked up
// once from the database itself, so a table someone adds later moves too.
let owned: string[] | null = null;
function ownedTables(): string[] {
  if (owned) return owned;
  const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name as string);
  owned = tables.filter((t) => t !== 'idempotency_keys' && all(`PRAGMA foreign_key_list(${t})`).some((k) => k.table === 'envelopes' && k.from === 'envelope_id'));
  return owned;
}
/** Everything of `tmp` becomes `eid`'s. A row `eid` already has the same of (one per envelope) stays `eid`'s own. */
function moveAll(tmp: string, eid: string) {
  for (const t of ownedTables()) run(`UPDATE OR IGNORE ${t} SET envelope_id=? WHERE envelope_id=?`, eid, tmp);
}

/**
 * Two templates with a role of the same name: one person, so the role must do the same in both, and be the same
 * person when both name one. Said before anything is made.
 */
function assertRolesFit(tpls: any[], fill?: Record<string, any>) {
  const seen = new Map<string, { r: any; t: any }>();
  const filled = (r: any) => String((fill?.[r.id] || (r.role_name ? fill?.[r.role_name] : undefined))?.email ?? r.email ?? '').trim().toLowerCase();
  for (const t of tpls) {
    const mineHere = new Set<string>();
    for (const r of t.recipients || []) {
      const k = roleKey(r.role_name);
      if (!k || mineHere.has(k)) continue;
      mineHere.add(k);
      const first = seen.get(k);
      if (!first) {
        seen.set(k, { r, t });
        continue;
      }
      const role = str(String(first.r.role_name).trim(), 80);
      const a = `"${str(first.t.subject || 'Untitled template', 80)}"`, b = `"${str(t.subject || 'Untitled template', 80)}"`;
      if (first.r.role !== r.role)
        throw bad(`Both ${a} and ${b} have a role called ${role}, and a role is one person. In ${a} ${role} ${ROLE_SAID[first.r.role] || first.r.role} and in ${b} ${role} ${ROLE_SAID[r.role] || r.role}. Give the role the same job in both templates, or a different name in one of them. Nothing was created.`, 400, { code: 'roles_differ', role });
      if (!!first.r.group_id !== !!r.group_id || (first.r.group_id && first.r.group_id !== r.group_id))
        throw bad(`Both ${a} and ${b} have a role called ${role}, and in one of them it is a group of people. A role is one person or one group in both. Give it a different name in one of the templates. Nothing was created.`, 400, { code: 'roles_differ', role });
      const e1 = filled(first.r), e2 = filled(r);
      if (e1 && e2 && e1 !== e2)
        throw bad(`Both ${a} and ${b} have a role called ${role}, and each template names a different person for it. A role is one person. Fill in the person yourself, or give the role a different name in one of the templates. Nothing was created.`, 400, { code: 'roles_differ', role });
      if (!!first.r.witness_for !== !!r.witness_for)
        throw bad(`Both ${a} and ${b} have a role called ${role}, and in only one of them it is a witness. Give it a different name in one of the templates. Nothing was created.`, 400, { code: 'roles_differ', role });
    }
  }
}

const listOf = (v: any): string[] => {
  try {
    const l = JSON.parse(v || '[]');
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    return [];
  }
};
const mapOf = (v: any): Record<string, any> => {
  try {
    const m = JSON.parse(v || '{}');
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
};

// ---- The lock, part by part ---------------------------------------------------------------------------------------

export function partsOf(e: any): Part[] | null {
  if (!e?.wording_parts) return null;
  try {
    const l = JSON.parse(e.wording_parts);
    return Array.isArray(l) ? l.filter((p) => p && typeof p.t === 'string').map((p) => ({ t: p.t, docs: (p.docs || []).map(String), people: (p.people || []).map(String), ...(p.l ? { l: 1 as const } : {}) })) : null;
  } catch {
    return null;
  }
}

/**
 * Whether one part is locked for this person: its template was locked when the document was made (p.l), still is, and
 * they may not change it. A deleted template stays locked, except for the person it belonged to. As with one
 * template, a part started before its template was locked is not locked.
 */
function lockedFor(c: Ctx, e: any, p: Part): boolean {
  if (!p.l) return false;
  const t = get("SELECT id, sender_id, tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id=? AND kind='template'", p.t);
  if (t) return ruleOf(t).locked && !mayChange(c, t);
  return !!p.l && e.wording_owner !== c.user.id;
}

/** The template the lock of a combined envelope is named after, for this person: the first locked part. null when none is locked for them. */
export function partLockFrom(c: Ctx, e: any): string | null {
  const parts = partsOf(e);
  if (!parts) return e?.wording_from || null;
  return parts.find((p) => lockedFor(c, e, p))?.t ?? null;
}

/**
 * The envelope and the body of a save, cut down to the locked parts for this person, for assertWordingKept to check
 * as it checks a whole envelope. A document, a field or a person of an open part is not looked at; one of a locked
 * part that is missing, moved or changed is still refused.
 */
export function lockedPartsOnly(c: Ctx, e: any, b: any): { e: any; b: any } {
  const parts = partsOf(e);
  if (!parts) return { e, b };
  const locked = parts.filter((p) => lockedFor(c, e, p));
  const docs = new Set(locked.flatMap((p) => p.docs));
  const people = new Set(locked.flatMap((p) => p.people));
  const ev = { ...e, documents: e.documents.filter((d: any) => docs.has(d.id)), recipients: e.recipients.filter((r: any) => people.has(r.id)), fields: e.fields.filter((f: any) => docs.has(f.document_id)) };
  const bv = { ...b };
  if (Array.isArray(b.documents)) bv.documents = b.documents.filter((d: any) => docs.has(String(d?.id)));
  if (Array.isArray(b.recipients)) bv.recipients = b.recipients.filter((r: any) => people.has(String(r?.id)));
  if (Array.isArray(b.fields)) {
    const were = new Set(ev.fields.map((f: any) => f.id));
    bv.fields = b.fields.filter((f: any) => were.has(String(f?.id)) || docs.has(String(f?.document_id)));
  }
  return { e: ev, b: bv };
}

/** The templates a combined envelope was made from, by name, for its history. */
export function combinedLine(tpls: any[]): string {
  return `Started from ${tpls.length} templates, one after the other: ${tpls.map((t) => `"${str(t.subject || 'Untitled template', 120)}"`).join(', ')}. Roles with the same name are one person.${tpls.some((t) => ruleOf(t).locked) ? ` The wording of ${tpls.filter((t) => ruleOf(t).locked).map((t) => `"${str(t.subject || 'Untitled template', 80)}"`).join(', ')} is locked for its own part. To change that part, ask ${askWho(tpls.find((t) => ruleOf(t).locked))}.` : ''}`;
}

// ---- Copies, templates made from it, and people who change it on their turn ---------------------------------------

const named = (t: any) => `"${str(t?.subject || 'Untitled template', 120)}"`;
const AGAIN = 'To send these again, go to Templates, choose Use on the first one and then Add another template.';

/**
 * cloneOwner (tplroles.ts) for a document made from several templates. A copy to send keeps every part's lock
 * (carryParts). A template made from it is one template with one set of rules, so it would no longer hold each part's
 * own rules: it is made only when this person may set the rules of every template it came from that holds something
 * back (not for everyone, or locked), and may still use each of them. Otherwise nothing is made, and they are told how
 * to send the same templates together again.
 */
export function combinedCloneOwner(c: Ctx, e: any, parts: Part[], kind: 'envelope' | 'template'): string {
  for (const p of parts) {
    const t = get("SELECT * FROM envelopes WHERE id=? AND kind='template' AND account_id=?", p.t, e.account_id);
    if (!t) {
      if (p.l && !can(c, 'edit_any_template') && e.wording_owner !== c.user.id)
        throw bad(`This document was made from several templates, and one whose wording was locked has been deleted. A copy would no longer be locked, so no copy was made. Ask ${askWho(null)}.`, 403, { code: 'wording_locked' });
      continue;
    }
    if (kind === 'envelope') {
      // As with one template: a part started before its template was locked is not locked, and a copy made now would not be either.
      if (!p.l && ruleOf(t).locked && !mayChange(c, t))
        throw bad(`This document was made from several templates, and the wording of ${named(t)} was locked after it was made, so its part is not locked and a copy made now would not be either. So no copy was made. ${AGAIN} Ask ${askWho(t)} if it needs to change.`, 403, { code: 'wording_locked', template_id: t.id });
      continue;
    }
    if (!mayUse(c, t))
      throw bad(`This document was made from several templates, and you can no longer use ${named(t)}, so a template made from it was not made. Ask ${askWho(t)} if you need it.`, 403, { code: 'template_not_for_you', template_id: t.id });
    if (!copyIsTheirs(c, t))
      throw bad(`This document was made from several templates, and ${named(t)} ${ruleOf(t).locked ? 'has locked wording' : 'is not for everyone on the team'}. One template made from all of them could not keep that rule for its own part, so it was not made. ${AGAIN} Ask ${askWho(t)} if you need one template.`, 403, { code: ruleOf(t).locked ? 'wording_locked' : 'template_not_for_you', template_id: t.id });
  }
  return c.user.id;
}

/**
 * carryRules (tplroles.ts), a copy of a document made from several templates: its parts, by the ids the copy's
 * documents and people have, so each part stays locked as it was. `eid` is the copy, written by copyEnvelope in the
 * order of src.documents and src.recipients.
 */
export function carryParts(src: any, eid: string) {
  const parts = partsOf(src);
  if (!parts) return;
  const dids: string[] = all('SELECT id FROM documents WHERE envelope_id=? ORDER BY rowid', eid).map((d) => d.id);
  const rids: string[] = all('SELECT id FROM recipients WHERE envelope_id=? ORDER BY rowid', eid).map((r) => r.id);
  const dtwin = new Map<string, string>((src.documents || []).map((d: any, i: number) => [d.id, dids[i]]));
  const rtwin = new Map<string, string>((src.recipients || []).map((r: any, i: number) => [r.id, rids[i]]));
  const moved = parts.map((p) => ({ ...p, docs: p.docs.map((d) => dtwin.get(d)).filter(Boolean), people: p.people.map((r) => rtwin.get(r)).filter(Boolean) }));
  run('UPDATE envelopes SET wording_parts=? WHERE id=?', JSON.stringify(moved), eid);
}

/** A template made from it (kind 'template'): locked when any template it came from was. */
export const anyPartLocked = (src: any) => !!partsOf(src)?.some((p) => p.l);

/**
 * "Can change the document" on their turn (editorChange in agents.ts), on a document made from several templates:
 * the documents, fields and people of a part whose wording is locked stay as they are, unless the person changing it
 * is one of that part's own people (its template gave them the role). `out` is what editorChange is about to save.
 */
export function assertEditorKeepsLockedParts(e: any, r: any, out: { documents?: any[]; recipients?: any[]; fields?: any[] }, asker: string) {
  const parts = partsOf(e)?.filter((p) => p.l && !p.people.includes(r.id));
  if (!parts?.length) return;
  for (const p of parts) {
    const t = get("SELECT id, subject, tpl_locked FROM envelopes WHERE id=? AND kind='template'", p.t);
    if (t && !ruleOf(t).locked) continue;
    const docs = new Set(p.docs);
    const no = (what: string) => {
      throw bad(`${what} It comes from the template ${t ? named(t) : 'that was used'}, whose wording is locked, so it cannot be changed on your turn. Nothing was changed. If it needs to change, ask ${asker} in Questions and comments.`, 403, { code: 'wording_locked', ...(t ? { template_id: t.id } : {}) });
    };
    if (out.documents) {
      for (const d of e.documents.filter((x: any) => docs.has(x.id))) {
        const now = out.documents.find((x: any) => x.id === d.id);
        if (!now || now.file_id !== d.file_id || (now.name || d.name) !== d.name) no(`"${str(d.name, 80)}" cannot be replaced, renamed or taken off.`);
      }
    }
    if (out.recipients) {
      for (const x of e.recipients.filter((y: any) => p.people.includes(y.id))) {
        const now = out.recipients.find((y: any) => y.id === x.id);
        if (!now || now.role !== x.role || Number(now.routing_order) !== Number(x.routing_order)) no(`${str(x.name || x.role_name || 'One person', 80)} cannot be taken off, moved or given another role. Their name and address can be changed.`);
      }
    }
    if (out.fields) {
      const key = (f: any) => [f.document_id, f.recipient_id || '', f.type, Number(f.page) || 0, ...[f.x, f.y, f.w, f.h].map((v) => Number(v).toFixed(5)), f.value ?? ''].join('|');
      const was = e.fields.filter((f: any) => docs.has(f.document_id)).map(key).sort();
      const will = out.fields.filter((f: any) => docs.has(String(f?.document_id))).map(key).sort();
      if (JSON.stringify(was) !== JSON.stringify(will)) no(`The fields and notes on "${str(e.documents.find((d: any) => docs.has(d.id))?.name || 'its document', 80)}" cannot be added, moved or changed.`);
    }
  }
}
