// Conditional fields and formulas on the server. The rules themselves are plain functions in src/lib/logic.ts, which
// the signing page uses too. Here they are checked when a sender saves (a loop, a field of another person, a formula
// that cannot be read are refused in words that name the fields), and worked out again from what is stored whenever
// a signer saves or finishes. The server decides: a hidden field is not required and keeps no answer, and a
// calculated field holds what the server worked out, whatever the browser sent for either.
import { all, run } from './db.ts';
import { bad, str, sha256 } from './util.ts';
import {
  ruleOf, parseFormula, FormulaError, refsOf, renameRefs, workOut, loopsIn, CONDS, CONDS_FOR, NEEDS_VALUE, RULE_VALUE_MAX, ALWAYS_SHOWN,
  readNumber, ruleWords, formulaWords, COND_WORDS, logicKey, longestChain, MAX_CHAIN, canonOf, namesIn,
} from '../lib/logic.ts';

const TYPE_WORD: Record<string, string> = { checkbox: 'tick box', radio: 'radio button', dropdown: 'choice', text: 'text', number: 'number', date: 'date', attachment: 'attachment', company: 'company', title: 'job title', signature: 'signature', initials: 'initials', full_name: 'full name', email: 'email', date_signed: 'date signed', stamp: 'stamp' };
/** A field as people know it: its label, or what it is and where. */
export const nameOf = (f: any): string => (f?.label ? String(f.label) : `${TYPE_WORD[f?.type] || 'unnamed'} field on page ${Number(f?.page || 0) + 1}`);
const fold = (s: any) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

type Entry = { fid: string; f: any; rid: string | null; which: string };

/**
 * Saves the "show_when" and "formula" of every field writeContent (src/server/envelopes.ts) has just written, inside
 * the same transaction, so a refusal saves nothing at all. A field names the one it depends on, and a formula the
 * fields it uses, by the id the request gave that field or by its label. They are stored by the field's own id.
 * Left out, a field has neither. Then everything is worked out again from what is stored (settleLogic).
 */
export function saveLogic(e: any, entries: Entry[]) {
  const stored = new Map<string, Entry>(entries.map((x) => [x.fid, x]));
  const given = new Map<string, Entry>();
  for (const x of entries) if (x.f?.id != null && x.f.id !== '') given.set(String(x.f.id), x);
  const label = (x: Entry) => `'${nameOf({ ...x.f, page: Number(x.f.page) || 0 })}'`;
  // The people as this save wrote them, so someone added in the same request is called by their name.
  let people: Map<string, string> | null = null;
  const who = (rid: string | null) => (people ??= new Map(all('SELECT id, name, role_name FROM recipients WHERE envelope_id=?', e.id).map((r: any) => [r.id, r.name || r.role_name || '']))).get(rid || '') || 'someone';
  const NO = ' Nothing was saved.';
  // A field the request names: by the id it gave, the id it is stored under, or else by its label when exactly one
  // field (of the kind that is allowed there) has it.
  const find = (k: string, ok: (x: Entry) => boolean, what: string, whose: string): Entry => {
    const hit = given.get(k) || stored.get(k);
    if (hit) return hit;
    const named = entries.filter((x) => fold(x.f?.label) === fold(k) && fold(k) !== '');
    const fits = named.filter(ok);
    if (fits.length === 1) return fits[0];
    if (fits.length > 1) throw bad(`${whose} ${what} "${str(k, 80)}", and ${fits.length} fields have that label. Give them different labels, or name the field by its id.${NO}`);
    // A field that was on the envelope and is not in this request: it is named as people know it, not by its id.
    const gone = e.fields?.find?.((f: any) => f.id === k);
    if (gone) throw bad(`${whose} ${what} '${nameOf(gone)}', and that field is no longer on the envelope. Choose another field, or take the rule out.${NO}`);
    throw bad(`${whose} ${what} "${str(k, 80)}", and no field on this envelope has that id or label.${named.length ? ` The field called that is not one that can be used here.` : ''}${NO}`);
  };
  const out = new Map<string, { rule: any; formula: string | null }>();
  for (const x of entries) {
    const { f, which } = x;
    let rule: any = null, formula: string | null = null;
    const w = f?.show_when;
    if (w != null && w !== '' && w !== false) {
      if (typeof w !== 'object' || Array.isArray(w)) throw bad(`${which}: "show_when" must be an object like {"field": "f1", "is": "checked"}, or null for a field that is always shown.${NO}`);
      if (ALWAYS_SHOWN(f.type)) throw bad(`${which} is a ${f.type === 'note' ? 'note' : 'strike-out'}: the sender's own wording, which is always on the page. It cannot have "show_when".${NO}`);
      if (w.field == null || w.field === '') throw bad(`${which}: "show_when" names no field. Say which field of the same person it depends on, in "field".${NO}`);
      const p = find(String(w.field), (y) => y.rid === x.rid && !!CONDS_FOR[y.f?.type], 'is shown when', `${which}`);
      if (p.fid === x.fid) throw bad(`${which} is shown when it has an answer itself, which can never happen. Choose another field.${NO}`);
      if (p.rid !== x.rid) throw bad(`${which} belongs to ${who(x.rid)}, and the field it depends on, ${label(p)}, belongs to ${p.rid ? who(p.rid) : 'nobody'}. A field can only depend on an answer of the same person, because what someone else fills in is not known while they sign.${NO}`);
      const allowed = CONDS_FOR[p.f.type];
      if (!allowed) throw bad(`${which} depends on ${label(p)}, a ${TYPE_WORD[p.f.type] || p.f.type} field. A field can only depend on a tick box, a radio button, a choice, a text, a number, a date or an attachment.${NO}`);
      if (!(CONDS as readonly string[]).includes(w.is) || !allowed.includes(w.is))
        throw bad(`${which}: "is" is ${str(JSON.stringify(w.is ?? null), 40)}, and for ${label(p)}, a ${TYPE_WORD[p.f.type]} field, it can be ${allowed.map((c) => `"${c}" (${COND_WORDS[c](p.f.type)})`).join(', ')}.${NO}`);
      let value: string | null = null;
      if (NEEDS_VALUE.includes(w.is)) {
        if (w.value == null || typeof w.value === 'object' || String(w.value).trim() === '') throw bad(`${which}: "is": "${w.is}" compares ${label(p)} with a value, and "value" is missing.${NO}`);
        value = String(w.value).trim();
        if (value.length > RULE_VALUE_MAX) throw bad(`${which}: the value in "show_when" is ${value.length} characters long, and the most it can be is ${RULE_VALUE_MAX}.${NO}`);
        if (p.f.type === 'number' && !readNumber(value)) throw bad(`${which}: "${str(value, 60)}" is not a number, so ${label(p)} cannot be compared with it. Write it like 1000 or 12.5.${NO}`);
      }
      rule = { field: p.fid, is: w.is, ...(value != null ? { value } : {}) };
    }
    if (f?.formula != null && f.formula !== '') {
      if (typeof f.formula !== 'string') throw bad(`${which}: "formula" must be text, like "{Quantity} * {Unit price}".${NO}`);
      if (f.type !== 'number') throw bad(`${which} is a ${TYPE_WORD[f.type] || f.type} field. Only a number field can be worked out from a formula.${NO}`);
      let ast;
      try {
        ast = parseFormula(f.formula);
      } catch (err: any) {
        if (err instanceof FormulaError) throw bad(`${which}: the formula cannot be read. ${err.message}${NO}`);
        throw err;
      }
      const ids = new Map<string, string>();
      for (const k of refsOf(ast)) {
        const y = find(k, (z) => z.f?.type === 'number', 'is worked out from', `${which}`);
        if (y.f?.type !== 'number') throw bad(`${which} is worked out from ${label(y)}, a ${TYPE_WORD[y.f?.type] || y.f?.type} field. A formula can only use number fields.${NO}`);
        ids.set(k, y.fid);
      }
      formula = renameRefs(f.formula, (k) => ids.get(k) || k).trim();
    }
    out.set(x.fid, { rule, formula });
  }
  // Rules and formulas that go round in a circle could never be shown or worked out. Refused, naming every field.
  const view = entries.map((x) => ({ id: x.fid, type: x.f.type, show_when: out.get(x.fid)!.rule, formula: out.get(x.fid)!.formula }));
  const loops = loopsIn(view);
  if (loops.length) {
    // Each field in the loop depends on the one after it, and the last one on the first.
    const loop = loops[0];
    const said = loop.map((id, i) => {
      const next = loop[(i + 1) % loop.length];
      return `${label(stored.get(id)!)} ${out.get(id)!.rule?.field === next ? 'is shown depending on' : 'is worked out from'} ${label(stored.get(next)!)}`;
    });
    throw bad(`These fields depend on each other in a circle, so none of them could ever be shown or worked out: ${said.join('; ')}. Change one of the rules or formulas so the circle is broken.${NO}`, 400, { code: 'logic_loop', fields: loop });
  }
  // A very long line of fields that each depend on the next would take the signing page (and the server) more steps
  // than it can count at once. Refused in words, so it never becomes an error of ours.
  const chain = longestChain(view);
  if (chain.length > MAX_CHAIN)
    throw bad(`${label(stored.get(chain.id)!)} depends on a line of ${chain.length - 1} other fields, each shown after or worked out from the next, and at most ${MAX_CHAIN} fields can depend on each other in one line. Make the line shorter, for example by adding the lines up at once with sum({Line 1}, {Line 2}).${NO}`, 400, { code: 'logic_chain' });
  for (const [fid, v] of out)
    if (v.rule || v.formula) run('UPDATE fields SET show_when=?, formula=? WHERE id=?', v.rule ? JSON.stringify(v.rule) : null, v.formula, fid);
  // writeContent wrote every field again. A calculated value that was kept (someone who has finished keeps what they
  // signed) keeps the number it stands for, so it is never read again from its shown text (canonOf in logic.ts).
  for (const old of e.fields || [])
    if (old?.calc_num != null && out.get(old.id)?.formula) run('UPDATE fields SET calc_num=? WHERE id=? AND value IS ?', old.calc_num, old.id, old.value ?? null);
  // A calculated field is never typed into, so it is never required, never read only, and holds no wording of the
  // sender's: its value is whatever it works out to.
  run('UPDATE fields SET required=0, readonly=0, prefill=NULL WHERE envelope_id=? AND formula IS NOT NULL', e.id);
  settleLogic(e.id);
}

/** The rule and formula columns of a field read back, for a field as loadEnvelope gives it. */
const fieldsOf = (envelopeId: string) => all('SELECT * FROM fields WHERE envelope_id=?', envelopeId).map((f: any) => ({ ...f, options: f.options ? JSON.parse(f.options) : [], show_when: ruleOf(f) }));

/**
 * Works out again, from what is stored, which fields are shown and what every formula comes to, for everyone who has
 * not finished, and writes it down. A field that is not shown keeps no answer: it goes back to what the sender put
 * there (often nothing), and a signature or a tick in it is taken away. A calculated field holds its result.
 *
 * What someone else fills in only counts for a formula once that person has finished; until then it counts as
 * empty, because it can still change. Someone who has finished keeps exactly what they signed: nothing of theirs is
 * changed here (the statement itself checks, so a save that crosses their Finish cannot either). `acting` is the
 * person saving or finishing right now, who is worked out even though their Finish has just been claimed.
 * Returns the fields of `acting` that are not shown, so the checks at Finish skip them.
 */
export function settleLogic(envelopeId: string, acting?: string | null, fields?: any[]): Set<string> {
  const list = fields || fieldsOf(envelopeId);
  const hiddenMine = new Set<string>();
  if (!list.some((f: any) => f.formula || ruleOf(f))) return hiddenMine;
  const status = new Map<string, string>(all('SELECT id, status FROM recipients WHERE envelope_id=?', envelopeId).map((r: any) => [r.id, r.status]));
  const done = (rid: string | null) => !!rid && status.get(rid) === 'completed';
  const owners = new Set<string>(list.filter((f: any) => f.recipient_id && (f.formula || ruleOf(f))).map((f: any) => f.recipient_id));
  for (const R of owners) {
    if (R !== acting && done(R)) continue;
    const o = workOut(viewFor(list, R, done), { stored: (f) => f.recipient_id !== R, name: nameOf });
    for (const f of list) {
      if (f.recipient_id !== R) continue;
      const hidden = o.hidden.has(f.id);
      if (hidden && R === acting) hiddenMine.add(f.id);
      // A calculated field holds its result twice: as it is shown, and as a plain number for every later reader.
      const calc = !!f.formula && f.type === 'number';
      let next = f.value ?? null, num = calc ? f.calc_num ?? null : null;
      if (calc) (next = hidden ? null : o.calc.get(f.id)?.text ?? null), (num = next == null ? null : o.calc.get(f.id)?.canon ?? null);
      else if (hidden && !f.readonly) next = f.prefill ?? null;
      if ((next ?? null) === (f.value ?? null) && num === (calc ? f.calc_num ?? null : null)) continue;
      f.value = next;
      if (calc) f.calc_num = num;
      // Never over an answer of someone who has finished, unless it is the person finishing in this very moment.
      run(`UPDATE fields SET value=?, calc_num=? WHERE id=?${R === acting ? '' : " AND (SELECT status FROM recipients WHERE id=?)!='completed'"}`, next, num, f.id, ...(R === acting ? [] : [R]));
    }
  }
  return hiddenMine;
}

/**
 * The envelope's fields as they count for recipient R: what someone else filled in is empty until that person has
 * finished, because it can still change; the sender's own values (read only) count from the start. The one view
 * that settleLogic works R out with and that R's screen is given (formulaInputs), so the two never disagree.
 */
function viewFor(list: any[], R: string, done: (rid: string | null) => boolean): any[] {
  return list.map((f: any) => (f.recipient_id && f.recipient_id !== R && !f.readonly && !done(f.recipient_id) ? { ...f, value: null } : f));
}

/**
 * The fields of other people that the formulas of recipient `rid` use (also through another calculated field of
 * theirs), as they count for `rid` right now: a value only once its owner has finished and while it is shown. The
 * signing page works the formulas out with exactly these (src/components/sign/logic.ts), and names them by their
 * labels. `key` stands for all of it: the screen sends it back with Finish (assertInputs), so a Finish from a screen
 * that was given other answers than count now signs nothing.
 */
export function formulaInputs(e: any, rid: string): { key: string | null; fields: any[] } {
  const own = e.fields.filter((f: any) => f.recipient_id === rid && f.formula && f.type === 'number');
  if (!own.length) return { key: null, fields: [] };
  const byId = new Map<string, any>(e.fields.map((f: any) => [f.id, f]));
  const people = new Map<string, any>(e.recipients.map((r: any) => [r.id, r]));
  const done = (x: string | null) => !!x && people.get(x)?.status === 'completed';
  const view = viewFor(e.fields, rid, done);
  const counted = new Map<string, any>(view.map((f: any) => [f.id, f]));
  const hidden = workOut(view, { stored: (f) => f.recipient_id !== rid }).hidden;
  const seen = new Set<string>(), out: any[] = [];
  const todo: string[] = own.map((f: any) => f.id);
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const f = byId.get(id);
    if (!f || f.type !== 'number') continue;
    if (f.recipient_id === rid) {
      if (f.formula) todo.push(...namesIn(f.formula));
      continue;
    }
    const v = counted.get(id), shows = !hidden.has(id) && v.value != null && v.value !== '';
    out.push({ id, type: f.type, label: f.label, by: people.get(f.recipient_id)?.name || people.get(f.recipient_id)?.role_name || null, from: shows ? 'signer' : 'start', value: shows ? String(v.value) : null, num: shows ? canonOf(v) : null, pending: !done(f.recipient_id) });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { key: out.length ? sha256(JSON.stringify(out.map((x) => [x.id, x.value, x.num, x.pending]))).slice(0, 24) : null, fields: out };
}

/**
 * At Finish: the other people's answers that count in this person's formulas must still be the ones their screen
 * was given (GET /sign gives `inputs`, the screen sends it back). When someone has finished in between, their answer
 * now counts and the result changed under the person, so nothing is signed: 409 "changed", and the page loads the
 * document again with the new result. A caller that sends no `inputs` is held to the key the server last gave that
 * person (recipients.seen_inputs, '-' for none), like the content version; one that was never given the document
 * was shown nothing and is not held to anything.
 */
export function assertInputs(e: any, r: any, body: any) {
  const given = body?.inputs !== undefined ? body.inputs ?? null : r.seen_inputs == null ? undefined : r.seen_inputs === '-' ? null : r.seen_inputs;
  if (given === undefined) return;
  const now = formulaInputs(e, r.id);
  if (given === now.key) return;
  const finished = [...new Set(now.fields.filter((x) => !x.pending && x.by).map((x) => x.by))];
  const results = e.fields.filter((f: any) => f.recipient_id === r.id && f.formula && f.type === 'number').map((f: any) => `'${nameOf(f)}'`);
  const who = finished.length ? `${finished.slice(0, 3).join(', ')}${finished.length > 3 ? ' and others' : ''} finished` : 'Someone else on this document finished';
  throw bad(`${who} while you had this document open, and what they filled in counts in ${results.slice(0, 3).join(', ') || 'what is worked out for you'}. Nothing was signed. It is worked out again below with their answers: look at it before you finish.`, 409, { code: 'changed', why: 'inputs', version: e.content_version });
}

/**
 * Radio buttons of one group have one answer. A save or a Finish that chooses two of them at once is refused in
 * words; one that chooses one takes the others of its group off, also those the request leaves out, so two branches
 * that depend on them can never both be shown and printed. Returns the answers to store.
 */
export function oneChoice(mine: any[], values: Record<string, any>): Record<string, any> {
  const groups = new Map<string, any[]>();
  for (const f of mine) if (f.type === 'radio') groups.set(f.group_name || f.id, [...(groups.get(f.group_name || f.id) || []), f]);
  let out = values;
  for (const list of groups.values()) {
    const chosen = list.filter((f) => f.id in values && str(values[f.id], 4000));
    if (chosen.length > 1) throw bad(`Only one option can be chosen for ${list[0].group_name || 'one question'}, and ${chosen.length} were chosen: ${chosen.map((f) => nameOf(f)).join(', ')}. Choose one and try again. Nothing was saved.`);
    if (chosen.length === 1) out = { ...out, ...Object.fromEntries(list.filter((f) => f !== chosen[0]).map((f) => [f.id, ''])) };
  }
  return out;
}

/**
 * The fields that are not shown on pages made of these fields as they stand (the signed PDF, a copy for one person,
 * the sender's progress counts): calculated values are taken as stored, never worked out again.
 */
export function hiddenOf(fields: any[]): Set<string> {
  if (!fields.some((f: any) => ruleOf(f))) return new Set();
  return workOut(fields, { stored: () => true }).hidden;
}

/**
 * The same for one recipient's signing screen: other people's fields as that screen shows them (what someone who has
 * not finished filled in is not shown yet, only what the sender put there).
 */
export function hiddenFor(e: any, viewerId: string): Set<string> {
  const done = new Set<string>(e.recipients.filter((r: any) => r.status === 'completed').map((r: any) => r.id));
  return hiddenOf(e.fields.map((f: any) => (f.recipient_id && f.recipient_id !== viewerId && !done.has(f.recipient_id) && !f.readonly ? { ...f, value: f.prefill ?? null } : f)));
}

/** Copies the rules and formulas onto the fields of a copy (templates, cloning, bulk send, public forms). */
export function copyLogic(src: any, fmap: Map<string, string>, eid: string, values?: Record<string, any> | null) {
  for (const f of src.fields) {
    const w = ruleOf(f);
    if (!w && !f.formula) continue;
    const rule = w && fmap.has(w.field) ? { ...w, field: fmap.get(w.field) } : null;
    const formula = f.formula ? renameRefs(f.formula, (k) => fmap.get(k) || k) : null;
    run('UPDATE fields SET show_when=?, formula=? WHERE id=?', rule ? JSON.stringify(rule) : null, formula, fmap.get(f.id));
  }
  if (values) fillValues(src, fmap, values);
  settleLogic(eid);
}

/**
 * A bulk send row that fills fields of the template (a column named like a field): the value is the sender's, like
 * a prefilled value, so the signer starts with it and a rule that depends on it shows or hides from the first look.
 * `values` is keyed by the template field's id or label. A value for a field that cannot be filled by the sender,
 * or that is the template's own fixed wording, is refused for the row.
 */
function fillValues(src: any, fmap: Map<string, string>, values: Record<string, any>) {
  for (const x of planValues(src, values)) run('UPDATE fields SET value=?, prefill=? WHERE id=?', x.value, x.prefill, fmap.get(x.id));
}

/** What is wrong with a bulk send row's "fields", in words, or null. Asked for every row before anything is sent. */
export function rowFieldProblem(src: any, values: any): string | null {
  if (values == null) return null;
  if (typeof values !== 'object' || Array.isArray(values)) return '"fields" must be an object of field labels and values, like {"Plan": "Gold"}.';
  try {
    planValues(src, values);
    return null;
  } catch (err: any) {
    if (err?.status) return err.message;
    throw err;
  }
}

function planValues(src: any, values: Record<string, any>): { id: string; value: string | null; prefill: string | null }[] {
  const FILLABLE = ['text', 'number', 'date', 'company', 'title', 'checkbox', 'radio', 'dropdown'];
  const out: { id: string; value: string | null; prefill: string | null }[] = [];
  for (const [k, raw] of Object.entries(values)) {
    // A column names a field by its label (or id), or a group of radio buttons by the group's name.
    const group = src.fields.filter((f: any) => f.type === 'radio' && fold(f.group_name) === fold(k) && fold(k) !== '');
    const hits = group.length ? group : src.fields.filter((f: any) => f.id === k || (fold(f.label) === fold(k) && fold(k) !== ''));
    if (!hits.length) throw bad(`The column "${str(k, 80)}" names no field of the template. Use the label of a field the sender fills in, or leave the column out.`);
    if (hits.length > 1 && !group.length) throw bad(`The column "${str(k, 80)}" fits ${hits.length} fields of the template. Give them different labels.`);
    if (group.length && str(raw).trim() && !group.some((f: any) => fold(f.label) === fold(raw))) throw bad(`The column "${str(k, 80)}" holds "${str(raw, 80)}", which is not one of its choices: ${group.map((f: any) => f.label).filter(Boolean).join(', ')}.`);
    for (const f of hits) {
      if (!FILLABLE.includes(f.type) || f.formula) throw bad(`The column "${str(k, 80)}" is for ${nameOf(f)}, which ${f.formula ? 'is worked out by itself' : 'only its signer fills in'}. Leave the column out.`);
      // The template's own wording stays: a read-only value, or any value of a template whose wording is locked for
      // whoever sends the batch (locked_for_rows, set by the bulk send: forRows in tplroles.ts). Its owner and the
      // admins may change it, so for them a column may change it too.
      if (f.value && (f.readonly || (src.locked_for_rows ?? src.tpl_locked))) throw bad(`The column "${str(k, 80)}" is for ${nameOf(f)}, which holds the template's own wording and cannot be changed by a row.`);
      let v = str(raw, 4000).trim();
      if (f.type === 'checkbox') v = /^(1|yes|y|true|x|ticked|checked|ja|oui|si|sí)$/i.test(v) ? '1' : '';
      if (f.type === 'radio') v = group.length ? (fold(v) === fold(f.label) ? '1' : '') : v && !/^(0|no|n|false)$/i.test(v) ? '1' : '';
      if (f.type === 'dropdown' && v && !(f.options || []).includes(v)) throw bad(`The column "${str(k, 80)}" holds "${str(v, 80)}", which is not one of the choices of ${nameOf(f)}: ${(f.options || []).join(', ')}.`);
      if (f.type === 'number' && v && !readNumber(v)) throw bad(`The column "${str(k, 80)}" holds "${str(v, 80)}", which does not read as a number.`);
      out.push({ id: f.id, value: v || null, prefill: f.readonly ? null : v || null });
    }
  }
  return out;
}

/** What a correction changed in the rules and formulas, in words for the audit trail and for the people told. */
export function logicChanges(a: any, b: any): string[] {
  const out: string[] = [];
  const before = new Map<string, any>(a.fields.map((f: any) => [f.id, f]));
  const byB = new Map<string, any>(b.fields.map((f: any) => [f.id, f]));
  const byA = before;
  const rule = (f: any, by: Map<string, any>) => {
    const w = ruleOf(f);
    return w ? ruleWords(w, by.get(w.field), nameOf(by.get(w.field))) : 'Always shown';
  };
  for (const f of b.fields) {
    const o = before.get(f.id);
    if (!o || logicKey(o) === logicKey(f)) continue;
    const where = `'${nameOf(f)}' on page ${f.page + 1}`;
    if (JSON.stringify(ruleOf(o)) !== JSON.stringify(ruleOf(f))) out.push(`When ${where} is shown changed. Before: ${rule(o, byA)}. Now: ${rule(f, byB)}.`);
    if ((o.formula || '') !== (f.formula || '')) out.push(!f.formula ? `${where} is no longer worked out from a formula.` : `${where} is now worked out as ${formulaWords(f.formula, (id) => nameOf(byB.get(id)))}${o.formula ? `, not ${formulaWords(o.formula, (id) => nameOf(byA.get(id)))}` : ''}.`);
  }
  return out;
}
