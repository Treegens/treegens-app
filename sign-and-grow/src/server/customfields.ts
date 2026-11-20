// Custom fields: an account's own references on its envelopes (a case number, a cost centre, a grant, a ward), so a
// public body or a charity can find, filter and export by them. Admins define up to MAX_CUSTOM_FIELDS of them for
// the account (custom_field_defs). Each envelope and template keeps its own values (custom_values), with the name
// and the "on the certificate" choice the field had. A draft and a template follow later changes to a field; an
// envelope that was sent keeps what it was sent with, and keeps its values when the field is deleted.
// Documents carry name and value pairs of their own too (documents[].fields, API only), kept in the same table with
// their document id. The rules and limits are in src/lib/customfields.ts. Values are never on the signing page.
import { all, get, run, tx } from './db.ts';
import { bad, id, now, str } from './util.ts';
import { audit, yesNo, emailRefusal, type Actor } from './envelopes.ts';
import { record } from './seclog.ts';
import type { Ctx } from './router.ts';
import {
  MAX_CUSTOM_FIELDS, CUSTOM_CHOICES_MAX, CUSTOM_VALUE_MAX, DOC_FIELDS_MAX, CUSTOM_KINDS, CERT_HEADING, CERT_NOTE,
  customKey, lineProblem, nameProblem, readValue, type CustomDef,
} from '../lib/customfields.ts';

export type Def = CustomDef & { account_id: string; name_key: string; position: number };
type Row = { def_id: string | null; name: string; name_key: string; value: string; on_certificate: boolean; position: number };

const toDef = (r: any): Def => ({ ...r, kind: r.kind === 'list' ? 'list' : 'text', choices: r.choices ? JSON.parse(r.choices) : [], required: !!r.required, on_certificate: !!r.on_certificate });
export const defsOf = (accountId: string): Def[] => all('SELECT * FROM custom_field_defs WHERE account_id=? ORDER BY position, created_at', accountId).map(toDef);
export const defView = (d: Def) => ({ id: d.id, name: d.name, kind: d.kind, choices: d.kind === 'list' ? d.choices : [], required: d.required, on_certificate: d.on_certificate });
const listWords = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
const quoted = (l: string[]) => listWords(l.map((n) => `"${n}"`));
// Drafts and templates (a template is always a draft): the envelopes that follow a change to a field.
const OPEN = "SELECT id FROM envelopes WHERE status='draft'";

// ---- Definitions -------------------------------------------------------------------------------------------------

// What a create or a change asks for, checked in full before anything is written. Left out, a part keeps what it
// was (or the default for a new field: text, optional, on the certificate).
function readDef(accountId: string, b: any, old?: Def) {
  const name = b.name === undefined && old ? old.name : b.name;
  if (typeof name !== 'string') throw bad('"name" has to be text, such as "Case number". Nothing was saved.');
  const clean = name.trim();
  const wrong = nameProblem(clean);
  if (wrong) throw bad(`${wrong} Nothing was saved.`);
  const taken = defsOf(accountId).find((d) => d.name_key === customKey(clean) && d.id !== old?.id);
  if (taken) throw bad(`There is already a custom field called "${taken.name}". Give this one another name, or change that one. Nothing was saved.`, 409);
  const kind = b.kind === undefined || b.kind === null || b.kind === '' ? old?.kind ?? 'text' : b.kind;
  if (!(CUSTOM_KINDS as readonly string[]).includes(kind)) throw bad(`"kind" is "${str(kind, 40)}", and it has to be "text" or "list". Nothing was saved.`);
  let choices: string[] = old?.kind === 'list' ? old.choices : [];
  if (b.choices !== undefined && b.choices !== null) {
    if (!Array.isArray(b.choices)) throw bad('"choices" has to be a list of words, written with square brackets. Nothing was saved.');
    if (kind !== 'list' && b.choices.length) throw bad('Choices are only for a field of the kind "list". Send "kind": "list", or leave "choices" out. Nothing was saved.');
    choices = [];
    for (const [i, c] of b.choices.entries()) {
      if (c == null || (typeof c !== 'string' && typeof c !== 'number')) throw bad(`Choice ${i + 1} has to be text. Nothing was saved.`);
      const v = String(c).trim();
      if (!v) continue;
      const no = lineProblem(v, CUSTOM_VALUE_MAX, `Choice ${i + 1}`);
      if (no) throw bad(`${no} Nothing was saved.`);
      if (choices.some((x) => customKey(x) === customKey(v))) throw bad(`"${v}" is in the list twice. Give each choice once. Nothing was saved.`);
      choices.push(v);
    }
    if (choices.length > CUSTOM_CHOICES_MAX) throw bad(`A list can offer up to ${CUSTOM_CHOICES_MAX} choices, and this one has ${choices.length}. Nothing was saved.`);
  }
  if (kind === 'list' && !choices.length) throw bad('A list needs at least one choice. Type the choices, one on each line. Nothing was saved.');
  return {
    name: clean, name_key: customKey(clean), kind: kind as Def['kind'], choices: kind === 'list' ? choices : [],
    required: yesNo(b.required, old?.required ?? false, '"required"'), on_certificate: yesNo(b.on_certificate, old?.on_certificate ?? true, '"on_certificate"'),
  };
}

// Templates of public forms that have no value for a field that is required: their forms take nobody until there is
// one, so whoever makes the field required is told which.
function formsWithout(accountId: string, defId: string): string[] {
  return all(`SELECT p.name FROM powerforms p WHERE p.account_id=? AND p.active=1 AND NOT EXISTS (SELECT 1 FROM custom_values v WHERE v.envelope_id=p.template_id AND v.document_id='' AND v.def_id=?)`, accountId, defId).map((p) => p.name as string);
}
// Drafts and templates whose value no longer fits the field (a choice that was taken out, text where a list is now).
const misfits = (d: Def): number =>
  all(`SELECT value FROM custom_values WHERE def_id=? AND document_id='' AND envelope_id IN (${OPEN})`, d.id).filter((r) => 'problem' in readValue(d, r.value)).length;
function notesAfter(d: Def): string[] {
  const notes: string[] = [];
  const forms = d.required ? formsWithout(d.account_id, d.id) : [];
  if (forms.length) notes.push(`${forms.length === 1 ? 'The public form' : 'The public forms'} ${quoted(forms)} ${forms.length === 1 ? 'has' : 'have'} no value for "${d.name}" in ${forms.length === 1 ? 'its template' : 'their templates'}, so ${forms.length === 1 ? 'it takes' : 'they take'} nobody until one is filled in there, on the last step of the template's editor.`);
  const off = misfits(d);
  if (off) notes.push(`${off === 1 ? 'One draft or template holds' : `${off} drafts and templates hold`} a value for "${d.name}" that is not one of its choices now. ${off === 1 ? 'It' : 'Each'} can be sent once someone picks one.`);
  return notes;
}

export function createDef(c: Ctx, b: any) {
  const have = defsOf(c.account.id);
  if (have.length >= MAX_CUSTOM_FIELDS) throw bad(`An account can have up to ${MAX_CUSTOM_FIELDS} custom fields, and this one has ${have.length}. Delete one you no longer use first. Envelopes that were sent keep their values.`);
  const d = readDef(c.account.id, b);
  const fid = id('cfd');
  const t = now();
  run('INSERT INTO custom_field_defs (id, account_id, name, name_key, kind, choices, required, on_certificate, position, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    fid, c.account.id, d.name, d.name_key, d.kind, d.kind === 'list' ? JSON.stringify(d.choices) : null, d.required ? 1 : 0, d.on_certificate ? 1 : 0, Math.max(-1, ...have.map((x) => x.position)) + 1, c.user.id, t, c.user.id, t);
  record('settings.changed', { c, about: ['custom_field', fid], details: { custom_field: 'added', settings: { custom_fields: { changed: true } } } });
  const made = toDef(get('SELECT * FROM custom_field_defs WHERE id=?', fid));
  return { field: defView(made), notes: notesAfter(made) };
}

function mineDef(c: Ctx, defId: string): Def {
  const r = get('SELECT * FROM custom_field_defs WHERE id=? AND account_id=?', defId, c.account.id);
  if (!r) throw bad('That custom field does not exist any more. Someone may have deleted it. Reload the page to see the fields as they are now.', 404);
  return toDef(r);
}

// A change follows into drafts and templates (their values carry the new name and choice), and never into an
// envelope that was sent: that keeps the name and the certificate choice it went out with.
export function updateDef(c: Ctx, defId: string, b: any) {
  const old = mineDef(c, defId);
  const d = readDef(c.account.id, b, old);
  tx(() => {
    run('UPDATE custom_field_defs SET name=?, name_key=?, kind=?, choices=?, required=?, on_certificate=?, updated_by=?, updated_at=? WHERE id=?',
      d.name, d.name_key, d.kind, d.kind === 'list' ? JSON.stringify(d.choices) : null, d.required ? 1 : 0, d.on_certificate ? 1 : 0, c.user.id, now(), defId);
    run(`UPDATE custom_values SET name=?, name_key=?, on_certificate=? WHERE def_id=? AND document_id='' AND envelope_id IN (${OPEN})`, d.name, d.name_key, d.on_certificate ? 1 : 0, defId);
  });
  record('settings.changed', { c, about: ['custom_field', defId], details: { custom_field: 'changed', settings: { custom_fields: { changed: true } } } });
  const now_ = toDef(get('SELECT * FROM custom_field_defs WHERE id=?', defId));
  return { field: defView(now_), notes: notesAfter(now_) };
}

// Deleting a field takes its value off drafts and templates. Envelopes that were sent keep theirs, under the name
// they were sent with: they can still be found, filtered and exported by it, and their certificate is unchanged.
export function deleteDef(c: Ctx, defId: string) {
  const d = mineDef(c, defId);
  const kept = get(`SELECT COUNT(*) n FROM custom_values WHERE def_id=? AND document_id='' AND envelope_id NOT IN (${OPEN})`, defId).n;
  const cleared = tx(() => {
    const n = run(`DELETE FROM custom_values WHERE def_id=? AND document_id='' AND envelope_id IN (${OPEN})`, defId).changes;
    run('DELETE FROM custom_field_defs WHERE id=?', defId);
    return n;
  });
  record('settings.changed', { c, about: ['custom_field', defId], details: { custom_field: 'deleted', settings: { custom_fields: { changed: true } } } });
  return { ok: true, name: d.name, drafts_cleared: Number(cleared), sent_kept: Number(kept) };
}

/** The names a list can be filtered by: the fields there are, then names only older envelopes carry. */
export function filterNames(accountId: string): { fields: ReturnType<typeof defView>[]; past_names: string[] } {
  const defs = defsOf(accountId);
  const known = new Set(defs.map((d) => d.name_key));
  const past = all("SELECT v.name, v.name_key FROM custom_values v JOIN envelopes e ON e.id=v.envelope_id WHERE e.account_id=? AND v.document_id='' AND e.kind='envelope' GROUP BY v.name_key ORDER BY MIN(v.name)", accountId)
    .filter((r) => !known.has(r.name_key)).map((r) => r.name as string);
  return { fields: defs.map(defView), past_names: past };
}

// ---- Values on envelopes, templates and documents ----------------------------------------------------------------

const rowsOf = (envelopeId: string): Row[] =>
  all("SELECT def_id, name, name_key, value, on_certificate, position FROM custom_values WHERE envelope_id=? AND document_id='' ORDER BY position, name", envelopeId).map((r) => ({ ...r, on_certificate: !!r.on_certificate }));
const docRowsOf = (envelopeId: string) => all("SELECT document_id, name, value FROM custom_values WHERE envelope_id=? AND document_id!='' ORDER BY document_id, position", envelopeId);

/** The values of an envelope or template, as the API gives them. */
export const valuesOf = (envelopeId: string) => rowsOf(envelopeId).map((r) => ({ name: r.name, value: r.value, on_certificate: r.on_certificate }));

/** For publicEnvelope: the envelope's custom fields, and each document with its own name and value pairs. */
export function customView(e: any): { custom_fields: { name: string; value: string; on_certificate: boolean }[]; documents: any[] } {
  const byDoc = new Map<string, { name: string; value: string }[]>();
  for (const r of docRowsOf(e.id)) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) || []), { name: r.name, value: r.value }]);
  return { custom_fields: valuesOf(e.id), documents: (e.documents || []).map((d: any) => ({ ...d, fields: byDoc.get(d.id) || [] })) };
}

/** What a webhook delivery carries about an envelope. */
export function webhookCustom(envelopeId: string) {
  return {
    custom_fields: rowsOf(envelopeId).map((r) => ({ name: r.name, value: r.value })),
    document_fields: docRowsOf(envelopeId).map((r) => ({ document_id: r.document_id, name: r.name, value: r.value })),
  };
}

export type Plan = { values?: Row[]; merge: boolean; clear: string[]; docs?: ({ name: string; value: string }[] | undefined)[]; changes: string[] };

// One name and value pair a request sent, as the list of the request holds it.
const pairOf = (x: any, i: number, where: string): { name: string; value: any } => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.name !== 'string') throw bad(`${where}: item ${i + 1} has to be an object with a "name" and a "value", like {"name": "Case number", "value": "2026/114"}. Nothing was saved.`);
  return { name: x.name, value: x.value };
};
const asPairs = (v: any, where: string): { name: string; value: any }[] => {
  if (Array.isArray(v)) return v.map((x, i) => pairOf(x, i, where));
  // A bulk row may name them as an object, column name to value, the way a spreadsheet gives them.
  if (v && typeof v === 'object') return Object.entries(v).map(([name, value]) => ({ name, value }));
  throw bad(`${where} has to be a list of {"name", "value"} objects, written with square brackets. Nothing was saved.`);
};

/**
 * Reads "custom_fields" and "documents[].fields" from a request, checks every one of them, and answers what to
 * write, or nothing when the request names neither. Call it before anything is saved, and writeCustom() after, so
 * a refusal leaves everything as it was. `e` is the envelope as it is stored (null for a new one): a value that is
 * exactly what it holds already is kept even when the field changed since (a choice taken out), so a draft opened
 * before that change can still be saved. `merge`: the names given are set and the rest are kept (a template that
 * is used); without it the list replaces what there was, like "recipients" and "fields" do.
 */
export function readCustom(accountId: string, e: any | null, b: any, o: { merge?: boolean; where?: string } = {}): Plan | null {
  const where = o.where || '"custom_fields"';
  const plan: Plan = { merge: !!o.merge, clear: [], changes: [] };
  if (b?.custom_fields !== undefined && b.custom_fields !== null) {
    const defs = defsOf(accountId);
    const stored = new Map((e ? rowsOf(e.id) : []).map((r) => [r.name_key, r]));
    const seen = new Set<string>();
    const out: Row[] = [];
    const problems: string[] = [];
    for (const p of asPairs(b.custom_fields, where)) {
      const key = customKey(p.name);
      if (seen.has(key)) throw bad(`${where} names "${str(p.name, 60)}" twice. Give each field once. Nothing was saved.`);
      seen.add(key);
      const def = defs.find((d) => d.name_key === key);
      const was = stored.get(key);
      const same = was && p.value != null && typeof p.value !== 'object' && String(p.value).trim() === was.value;
      if (same) {
        out.push(was);
        continue;
      }
      if (!def) {
        problems.push(`There is no custom field called "${str(p.name, 60)}" in this account. An admin can add it under Settings, Account, or it may have been deleted a moment ago: reload to see the fields as they are now.`);
        continue;
      }
      const v = readValue(def, p.value);
      if ('problem' in v) problems.push(v.problem);
      else if (v.value) out.push({ def_id: def.id, name: def.name, name_key: def.name_key, value: v.value, on_certificate: def.on_certificate, position: def.position });
      else plan.clear.push(key);
    }
    if (problems.length) throw bad(`${problems.join(' ')} Nothing was saved.`);
    plan.values = out;
    // What would change on an envelope that is out, for its audit trail and for the check below.
    const after = new Map(out.map((r) => [r.name_key, r]));
    const gone = [...stored.values()].filter((r) => (plan.merge ? plan.clear.includes(r.name_key) : !after.has(r.name_key)));
    for (const r of out) {
      const w = stored.get(r.name_key);
      if (!w || w.value !== r.value) plan.changes.push(!r.on_certificate ? `The value of "${r.name}" (not printed on the certificate) was ${w ? 'changed' : 'added'}.` : w ? `${r.name}: "${w.value}" became "${r.value}".` : `${r.name}: "${r.value}" added.`);
    }
    for (const r of gone) plan.changes.push(r.on_certificate ? `${r.name}: "${r.value}" taken off.` : `The value of "${r.name}" (not printed on the certificate) was taken off.`);
    if (e && plan.changes.length) {
      if (e.status === 'completed') throw bad('This envelope is completed, so its custom fields are fixed: they are part of its record and its certificate. Nothing was changed.', 409);
      if (e.status !== 'draft' && e.status !== 'sent') throw bad(`This envelope is ${e.status}, so its custom fields can no longer be changed. Nothing was changed.`, 409);
      // On an envelope that is out, new words for the certificate go through the same filter as anything else the
      // sender adds to what recipients get (fakeNotice in envelopes.ts), for the accounts it applies to.
      if (e.status === 'sent') {
        const no = emailRefusal(e, [], { pause: false, extra: out.filter((r) => r.on_certificate).flatMap((r) => [r.name, r.value]) });
        if (no) throw bad(`${no.message} Nothing was changed.`, no.status);
      }
    }
  }
  if (Array.isArray(b?.documents) && b.documents.some((d: any) => d && typeof d === 'object' && d.fields !== undefined)) {
    plan.docs = b.documents.map((d: any, i: number) => {
      if (!d || typeof d !== 'object' || d.fields === undefined || d.fields === null) return undefined;
      const doc = `Document ${i + 1}${typeof d.name === 'string' && d.name ? ` ("${str(d.name, 60)}")` : ''}`;
      const pairs = asPairs(d.fields, `${doc}: "fields"`);
      const out: { name: string; value: string }[] = [];
      for (const p of pairs) {
        const name = p.name.trim();
        const value = p.value == null ? '' : typeof p.value === 'object' || typeof p.value === 'boolean' ? null : String(p.value).trim();
        if (value === null) throw bad(`${doc}: the value of "${str(name, 60)}" has to be text. Nothing was saved.`);
        const wrong = nameProblem(name) || lineProblem(value, CUSTOM_VALUE_MAX, `${doc}: the value of "${str(name, 60)}"`);
        if (wrong) throw bad(`${doc}: ${wrong} Nothing was saved.`);
        if (out.some((x) => customKey(x.name) === customKey(name))) throw bad(`${doc} names "${str(name, 60)}" twice in its "fields". Give each name once. Nothing was saved.`);
        if (value) out.push({ name, value });
      }
      if (out.length > DOC_FIELDS_MAX) throw bad(`${doc} has ${out.length} name and value pairs in its "fields", and the most is ${DOC_FIELDS_MAX}. Nothing was saved.`);
      return out;
    });
  }
  return plan.values || plan.docs ? plan : null;
}

/** Writes what readCustom() answered. On an envelope that is out, every change is a line in its audit trail. */
export function writeCustom(envelopeId: string, plan: Plan | null, by?: Actor) {
  if (!plan) return;
  tx(() => {
    const e = get('SELECT id, status FROM envelopes WHERE id=?', envelopeId);
    if (!e) return;
    if (plan.values) {
      // The envelope can have closed while the request was being worked on (a correction emails people first).
      if (plan.changes.length && e.status !== 'draft' && e.status !== 'sent')
        throw bad(`This envelope was ${e.status} in the moment your change arrived, so its custom fields were not changed. Everything else you saved stays saved.`, 409);
      if (!plan.merge) run("DELETE FROM custom_values WHERE envelope_id=? AND document_id=''", envelopeId);
      for (const k of plan.clear) run("DELETE FROM custom_values WHERE envelope_id=? AND document_id='' AND name_key=?", envelopeId, k);
      for (const r of plan.values) putRow(envelopeId, '', r);
      if (e.status === 'sent' && plan.changes.length) audit(envelopeId, by || { name: 'API' }, 'Custom fields changed', plan.changes.join(' '));
    }
    if (plan.docs) {
      const docs = all('SELECT id FROM documents WHERE envelope_id=? ORDER BY position', envelopeId).map((d) => d.id as string);
      plan.docs.forEach((pairs, i) => {
        const did = docs[i];
        if (!did || !pairs) return;
        run('DELETE FROM custom_values WHERE envelope_id=? AND document_id=?', envelopeId, did);
        pairs.forEach((p, n) => putRow(envelopeId, did, { def_id: null, name: p.name, name_key: customKey(p.name), value: p.value, on_certificate: false, position: n }));
      });
    }
    pruneDocs(envelopeId);
  });
}

const putRow = (envelopeId: string, documentId: string, r: Row) =>
  run('INSERT OR REPLACE INTO custom_values (envelope_id, document_id, def_id, name, name_key, value, value_key, on_certificate, position) VALUES (?,?,?,?,?,?,?,?,?)',
    envelopeId, documentId, r.def_id, r.name, r.name_key, r.value, customKey(r.value), r.on_certificate ? 1 : 0, r.position);
// The pairs of a document that is no longer on the envelope go with it.
const pruneDocs = (envelopeId: string) => run("DELETE FROM custom_values WHERE envelope_id=? AND document_id!='' AND document_id NOT IN (SELECT id FROM documents WHERE envelope_id=?)", envelopeId, envelopeId);

/** After a save that may have changed which documents an envelope has (PUT /envelopes/:id). */
export const customAfterSave = (envelopeId: string) => pruneDocs(envelopeId);

/**
 * Called by copyEnvelope(): a template's values are the starting values of what is made from it, and a copy keeps
 * the values of what it was copied from. A value of a field that was deleted since is not copied, and one that is
 * copied takes the field as it is now. Each document's own pairs go with its copy (dmap: old id to new id).
 */
export function copyCustom(src: any, eid: string, dmap: Map<string, string>) {
  const defs = new Map(defsOf(src.account_id).map((d) => [d.id, d]));
  for (const r of rowsOf(src.id)) {
    const d = r.def_id ? defs.get(r.def_id) : null;
    if (d) putRow(eid, '', { def_id: d.id, name: d.name, name_key: d.name_key, value: r.value, on_certificate: d.on_certificate, position: d.position });
  }
  for (const r of all("SELECT * FROM custom_values WHERE envelope_id=? AND document_id!=''", src.id)) {
    const did = dmap.get(r.document_id);
    if (did) putRow(eid, did, { ...r, on_certificate: false });
  }
}

// What stands in the way of sending, read against the fields as they are now: a required one without a value, and a
// value that no longer fits its field. Settles a draft's values on the fields as they are (name, certificate
// choice, place), so what goes out is exactly what the account's fields say at this moment.
// `over`: what a bulk row sets or empties in place of the template's own value.
function sendProblems(e: any, over?: { set: Map<string, string>; clear: string[] }): { missing: string[]; misfit: string[] } {
  const defs = defsOf(e.account_id);
  const rows = rowsOf(e.id);
  const replaced = (key: string) => !!over && (over.set.has(key) || over.clear.includes(key));
  const misfit: string[] = [];
  for (const r of rows) {
    const d = r.def_id ? defs.find((x) => x.id === r.def_id) : null;
    if (!d || replaced(d.name_key)) continue;
    const v = readValue(d, r.value);
    if ('problem' in v) misfit.push(v.problem);
  }
  const has = (d: Def) => (replaced(d.name_key) ? !!over!.set.get(d.name_key) : rows.some((r) => r.def_id === d.id || r.name_key === d.name_key));
  const missing = defs.filter((d) => d.required && !has(d)).map((d) => d.name);
  return { missing, misfit };
}
const missingText = (missing: string[], how: string) =>
  `Your account asks for ${missing.length === 1 ? 'the custom field' : 'the custom fields'} ${quoted(missing)} on every envelope, and ${missing.length === 1 ? 'it has' : 'they have'} no value here. ${how}`;
const EDITOR_HOW = 'Fill it in on the last step of the editor, under Details for your records (in the API: "custom_fields"), then send again.';

/** Called by sendEnvelope(), before anything is sent. */
export function assertCustomFields(e: any) {
  const { missing, misfit } = sendProblems(e);
  if (missing.length || misfit.length) throw bad([...(missing.length ? [missingText(missing, EDITOR_HOW)] : []), ...misfit].join(' '));
  const defs = new Map(defsOf(e.account_id).map((d) => [d.id, d]));
  for (const r of rowsOf(e.id)) {
    const d = r.def_id ? defs.get(r.def_id) : null;
    if (d) run("UPDATE custom_values SET name=?, name_key=?, on_certificate=?, position=? WHERE envelope_id=? AND document_id='' AND def_id=?", d.name, d.name_key, d.on_certificate ? 1 : 0, d.position, e.id, d.id);
  }
}

/** The words a recipient can be shown: the names and values printed on the certificate. Read by fakeNotice. */
export const customWords = (e: any): string[] => rowsOf(e.id).filter((r) => r.on_certificate).flatMap((r) => [r.name, r.value]);

// ---- Public forms and bulk send ----------------------------------------------------------------------------------

/** Why a public form on this template cannot take anyone: a required field the template has no value for. */
export function formCustomProblem(tpl: any): string | null {
  const { missing, misfit } = sendProblems(tpl);
  if (!missing.length && !misfit.length) return null;
  return [...(missing.length ? [missingText(missing, 'A visitor of a public form cannot fill custom fields in, so the template needs a value for each: open the template, and fill it in on the last step of its editor.')] : []), ...misfit].join(' ');
}

/** A bulk row's own values ("custom_fields": {"Case number": "2026/114"}), checked; a column named like a field fills it. */
function rowPlan(accountId: string, tpl: any, row: any, i: number): Plan | null {
  if (row?.custom_fields === undefined || row.custom_fields === null) return null;
  try {
    return readCustom(accountId, tpl, { custom_fields: row.custom_fields }, { merge: true, where: `Row ${i + 1}: "custom_fields"` });
  } catch (err: any) {
    throw bad(`Row ${i + 1}: ${String(err.message).replace(/ Nothing was saved\.$/, '')} Nothing was sent.`);
  }
}
/** Why a bulk send of these rows would be refused for its custom fields, or null. Writes nothing. */
export function bulkCustomRefusal(accountId: string, tpl: any, rows: any[]): string | null {
  try {
    assertBulkCustom(accountId, tpl, rows);
    return null;
  } catch (err: any) {
    return String(err?.message || err);
  }
}
/** Every row is checked before anything is sent, so a batch never stops half way for a custom field. */
export function assertBulkCustom(accountId: string, tpl: any, rows: any[]) {
  rows.forEach((row, i) => {
    const plan = rowPlan(accountId, tpl, row, i);
    // A row's own value takes the place of the template's, also one that no longer fits its field.
    const { missing, misfit } = sendProblems(tpl, { set: new Map((plan?.values || []).map((r) => [r.name_key, r.value])), clear: plan?.clear || [] });
    if (missing.length || misfit.length)
      throw bad(`Row ${i + 1}: ${[...(missing.length ? [missingText(missing, 'Add a column named like the field to the list, or give the template a value for it on the last step of its editor.')] : []), ...misfit].join(' ')} Nothing was sent.`);
  });
}
/** Called after a bulk row's envelope was made from the template: the row's own values take the template's place. */
export function applyRowCustom(accountId: string, tpl: any, envelopeId: string, row: any) {
  const plan = rowPlan(accountId, tpl, row, 0);
  if (plan) writeCustom(envelopeId, { ...plan, changes: [] });
}

// ---- The list, its export and the certificate --------------------------------------------------------------------

/** GET /envelopes?field=Case%20number&value=2026/114: only envelopes with that value (any value when it is empty). */
export function customFilter(q: URLSearchParams, where: string[], p: any[]) {
  const field = customKey(q.get('field'));
  if (!field) return;
  const value = customKey(q.get('value'));
  where.push("EXISTS (SELECT 1 FROM custom_values v WHERE v.envelope_id=e.id AND v.document_id='' AND v.name_key=? AND (?='' OR v.value_key=?))");
  p.push(field, value, value);
}

/** Puts each row's custom fields on it, for the list and its column. */
export function attachCustom(rows: any[]) {
  if (!rows.length) return;
  const by = new Map<string, { name: string; value: string }[]>();
  for (const r of all("SELECT envelope_id, name, value FROM custom_values WHERE document_id='' AND envelope_id IN (SELECT value FROM json_each(?)) ORDER BY position, name", JSON.stringify(rows.map((x) => x.id))))
    by.set(r.envelope_id, [...(by.get(r.envelope_id) || []), { name: r.name, value: r.value }]);
  for (const row of rows) row.custom_fields = by.get(row.id) || [];
}

// A spreadsheet runs a cell that starts with =, +, - or @ as a formula: such a value gets a ' in front.
const safeCell = (v: string) => v.replace(/^[=+\-@\t\r]/, "'$&");
/**
 * Columns for envelopes.csv in the export: one for each custom field any of these envelopes has, in the order of the
 * account's fields and then by name. A name that is the same as one of the export's own columns gets "custom: ".
 */
export function customCsv(envelopeIds: string[], taken: string[]): { head: string[]; cells: (envelopeId: string) => string[] } {
  const rows = envelopeIds.length ? all("SELECT envelope_id, name, name_key, value, position FROM custom_values WHERE document_id='' AND envelope_id IN (SELECT value FROM json_each(?))", JSON.stringify(envelopeIds)) : [];
  const names = new Map<string, { name: string; position: number }>();
  for (const r of rows) if (!names.has(r.name_key) || r.position < names.get(r.name_key)!.position) names.set(r.name_key, { name: r.name, position: r.position });
  const keys = [...names.keys()].sort((a, b) => names.get(a)!.position - names.get(b)!.position || names.get(a)!.name.localeCompare(names.get(b)!.name));
  const own = new Set(taken.map(customKey));
  const values = new Map<string, Map<string, string>>();
  for (const r of rows) values.set(r.envelope_id, (values.get(r.envelope_id) || new Map()).set(r.name_key, r.value));
  return {
    head: keys.map((k) => (own.has(k) ? `custom: ${names.get(k)!.name}` : names.get(k)!.name)),
    cells: (eid) => keys.map((k) => safeCell(values.get(eid)?.get(k) || '')),
  };
}

type Sheetish = { h2: (s: string) => void; text: (s: string, o?: any) => void };
/**
 * The block on the certificate of completion, called by drawCertificate in pdf.ts: the values of the fields marked
 * "show on the certificate", in the sender's words, as they were when the envelope went out (or were changed since,
 * which its audit trail says). Nothing when there are none.
 */
export function drawSenderDetails(s: Sheetish, e: any, iso: (x: any) => string, muted?: any) {
  const rows = rowsOf(e.id).filter((r) => r.on_certificate);
  if (!rows.length) return;
  s.h2(CERT_HEADING);
  for (const r of rows) s.text(`${iso(r.name)}: ${iso(r.value)}`, { size: 9 });
  s.text(CERT_NOTE, { size: 7.5, color: muted, gap: 4 });
}
