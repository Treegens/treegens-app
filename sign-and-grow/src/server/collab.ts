// Fields anyone on the document can fill in (the rules and the words are in src/lib/collab.ts).
//
// Such a field is stored like any other, with a recipient_id: the person it starts with (someone who signs), whose
// fields it sits with. fields.shared says that everyone who signs may fill it in or change it. Nothing else of that
// person changes: a shared field is never required, and their own answers are written by applyValues
// (envelopes.ts), which leaves shared fields alone. Every change goes through takeShared below, so it is always on
// the record.
//
// What decides a change:
// - The person's screen was given a value for the field (recipients.shared_shown, set when the page loads). A value
//   sent back that is still that one is no change of theirs: a screen that is out of date never undoes someone
//   else's change. A different value while someone else has changed it since is refused, and the page loads again.
// - Once anyone has finished, a change is refused, unless the sender allowed changes after that (shared_after). Then
//   it goes ahead only with "sign_again": true, and everyone who had finished is asked to sign again: their first
//   signature is set aside and kept, a copy of what they signed is kept, and they are emailed (the same sign-again
//   rule a sender's change uses, see correctEnvelope).
// - Finish is refused while the screen shows a value someone else has changed since, so nobody finishes on a value
//   they did not see.
import { all, get, run, tx, saveBlob } from './db.ts';
import { bad, now, str } from './util.ts';
import { seal, sealField } from './colcrypt.ts';
import { audit, buildPdf, advance, okImage, setAside, senderOf, type Actor } from './envelopes.ts';
import { assertLimits } from './fieldchecks.ts';
import { assertCanStore } from './filestore.ts';
import { settleWitnesses, witnessesSetAside } from './witness.ts';
import { isStepRole } from '../lib/recipienttypes.ts';
import { isHidden } from '../lib/fieldrules.ts';
import { dayText } from '../lib/dates.ts';
import { isShareable, isShared, canShare, listNames, saidValue, ANYONE } from '../lib/collab.ts';

const NO = ' Nothing was saved.';
type Entry = { fid: string; f: any; rid: string | null; which: string };
const label = (f: any) => (f?.label ? `"${String(f.label).slice(0, 60)}"` : `the ${f?.type === 'checkbox' ? 'tick box' : f?.type === 'radio' ? 'choice' : f?.type === 'dropdown' ? 'dropdown' : 'text field'} on page ${Number(f?.page || 0) + 1}`);
const yes = (v: any, which: string, key: string): boolean => {
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0' || v == null || v === '') return false;
  throw bad(`${which}: "${key}" is true or false.${NO}`);
};
const parse = (s: any): Record<string, string> => {
  try {
    const v = typeof s === 'string' ? JSON.parse(s) : s;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const at = (s: string | null | undefined) => (s ? `${dayText(s)} ${s.slice(11, 16)} UTC` : '');

/**
 * writeContent (envelopes.ts): saves "shared", "shared_initials" and "shared_after" of every field it has just written,
 * in the same transaction, so a refusal saves nothing. A field sent without them keeps what it had. Called after the
 * rules, formulas and kinds are in, because a field that hides, works itself out or copies another cannot be shared.
 */
export function saveShared(e: any, entries: Entry[]) {
  const old = new Map<string, any>((e.fields || []).map((f: any) => [f.id, f]));
  const people = new Map<string, any>(all('SELECT id, role, name FROM recipients WHERE envelope_id=?', e.id).map((r: any) => [r.id, r]));
  const radios = new Map<string, boolean[]>();
  for (const { fid, f, rid, which } of entries) {
    const o = old.get(fid);
    const shared = f?.shared !== undefined ? yes(f.shared, which, 'shared') : !!o?.shared;
    if (!shared) continue;
    if (!isShareable(f.type)) throw bad(`${which} is a ${String(f.type).replace('_', ' ')} field. Only text, choice, dropdown and tick-box fields can be filled in by anyone on the document. Give it to one person, or use one of those kinds.${NO}`);
    const p = people.get(rid || '');
    if (!p || !canShare(p.role)) throw bad(`${which} is for anyone on the document, so it has to start with someone who signs. ${p ? `${p.name || 'That person'} does not sign.` : 'It has no person.'} Choose someone who signs in "Assigned to".${NO}`);
    const row = get('SELECT readonly, show_when, formula, link, date_from, validation FROM fields WHERE id=?', fid) || {};
    const why = row.readonly ? 'is read only, so nobody can fill it in' : row.show_when ? 'is only shown when another answer is given' : row.formula ? 'is worked out from other fields' : row.link ? 'shares an answer with other fields ("Same answer as")' : row.date_from ? 'is worked out from another date' : isHidden({ type: f.type, validation: row.validation }) ? 'hides its value from the others' : '';
    if (why) throw bad(`${which} is for anyone on the document, and it ${why}. A field everyone fills in has to be seen and typed into by everyone. Change one of the two.${NO}`);
    const ini = f.shared_initials !== undefined ? yes(f.shared_initials, which, 'shared_initials') : !!o?.shared_initials;
    const after = f.shared_after !== undefined ? yes(f.shared_after, which, 'shared_after') : !!o?.shared_after;
    run('UPDATE fields SET shared=1, shared_initials=?, shared_after=?, required=0 WHERE id=?', ini ? 1 : 0, after ? 1 : 0, fid);
    if (f.type === 'radio') radios.set(`${rid}\u0000${f.group_name || fid}`, [...(radios.get(`${rid}\u0000${f.group_name || fid}`) || []), true]);
  }
  // A group of choices is one answer: all of it is for anyone, or none of it.
  for (const x of entries) {
    if (x.f?.type !== 'radio') continue;
    const k = `${x.rid}\u0000${x.f.group_name || x.fid}`;
    if (radios.has(k) && !get('SELECT shared FROM fields WHERE id=?', x.fid)?.shared)
      throw bad(`${x.which} is a choice in the group "${str(x.f.group_name, 60)}", and other choices of that group are for anyone on the document. Make the whole group for anyone, or none of it.${NO}`);
  }
}

/** copyEnvelope (envelopes.ts): templates, bulk sends, forms and clones keep who may fill each field in. */
export function copyShared(src: any, fmap: Map<string, string>) {
  for (const f of src.fields || []) if (f.shared && fmap.get(f.id)) run('UPDATE fields SET shared=1, shared_initials=?, shared_after=?, required=0 WHERE id=?', f.shared_initials ? 1 : 0, f.shared_after ? 1 : 0, fmap.get(f.id));
}

/** The people who finished and whose agreement a change would touch: everyone but the changer, cc and step roles. */
const finishedOthers = (e: any, r: any) => e.recipients.filter((x: any) => x.id !== r.id && x.status === 'completed' && x.role !== 'cc' && !isStepRole(x.role));

/** The last change of each shared field: who and when. */
function lastChanges(envelopeId: string): Map<string, { name: string; at: string }> {
  const m = new Map<string, { name: string; at: string }>();
  for (const c of all('SELECT field_id, name, at FROM shared_changes WHERE envelope_id=? ORDER BY id', envelopeId)) m.set(c.field_id, { name: c.name, at: c.at });
  return m;
}

/** Whether `f` is a field `r` fills in as one of anyone on the document (not their own one). */
export const sharesWith = (f: any, r: any): boolean => isShared(f) && canShare(r?.role) && f.recipient_id !== r.id;

/**
 * signView (routes-sign.ts): what the signing page is told about each shared field it lists. Only for someone who
 * signs; others see the field as part of the page.
 */
export function sharedProps(e: any, r: any, f: any): any {
  if (!isShared(f) || !canShare(r.role)) return f;
  const last = lastChanges(e.id).get(f.id);
  const done = finishedOthers(e, r).map((x: any) => x.name);
  const locked = done.length > 0 && !f.shared_after;
  return {
    ...f, shared: true, required: 0, initials_on_change: !!f.shared_initials,
    last_by: last?.name || null, last_at: last?.at || null,
    ...(locked ? { readonly: 1, locked_by: done } : done.length ? { sign_again: done } : {}),
  };
}

/** signView (routes-sign.ts): keeps what this person's screen is given for the shared fields. */
export function noteSharedShown(e: any, r: any) {
  const shared = e.status === 'sent' && canShare(r.role) ? e.fields.filter(isShared) : [];
  if (!shared.length) return;
  run('UPDATE recipients SET shared_shown=? WHERE id=?', seal('recipients.shared_shown', JSON.stringify(Object.fromEntries(shared.map((f: any) => [f.id, f.value ?? ''])))), r.id);
}

const asStored = (f: any, v: any): string => {
  let s = str(v, 4000);
  if (f.type === 'checkbox' || f.type === 'radio') s = s ? '1' : '';
  if (f.type === 'dropdown' && s && !(f.options || []).includes(s)) s = '';
  return s;
};

/**
 * Applies what `r` changed in shared fields from `body.values`, with the checks at the top of this file, and asks the
 * people who finished to sign again when the sender allowed that. Everything is decided and written before the first
 * wait, so a caller can call it between looking the link up and acting on it. `finishing`: called by Finish
 * (completeRecipient), which is also refused while the screen shows a value someone changed since.
 */
export async function takeShared(e: any, r: any, body: any, actor: Actor, finishing = false): Promise<{ changed: number; sign_again: string[] }> {
  const { later, ...out } = sharedNow(e, r, body, actor, finishing);
  if (later) await later();
  return out;
}

/**
 * The part of takeShared that decides and writes, without waiting for anything, so Finish (completeRecipient) can
 * call it between its checks and its claim with nothing else getting in between. `later` is what is left to wait for
 * (the copies of what people signed and their emails), only when someone is asked to sign again.
 */
export function sharedNow(e: any, r: any, body: any, actor: Actor, finishing = false): { changed: number; sign_again: string[]; later: (() => Promise<void>) | null } {
  const shared = (e.fields || []).filter(isShared);
  const none = { changed: 0, sign_again: [] as string[], later: null };
  if (!shared.length || !canShare(r.role)) return none;
  const values = body?.values && typeof body.values === 'object' ? body.values : {};
  const shown = parse(get('SELECT shared_shown s FROM recipients WHERE id=?', r.id)?.s);
  const last = lastChanges(e.id);
  const byOther = (f: any) => last.get(f.id)?.name || senderOf(e)?.name || 'Someone';
  const stale = (f: any) =>
    bad(`${byOther(f)} changed ${label(f)} while you had the document open. It now says ${saidValue(f.type, f.value)}. Look at it again${finishing ? ' before you finish' : ', then change it if you need to'}. Nothing was ${finishing ? 'signed' : 'saved'}.`, 409, { code: 'changed', why: 'shared', field_id: f.id });
  if (finishing) for (const f of shared) if (f.id in shown && (shown[f.id] ?? '') !== (f.value ?? '')) throw stale(f);
  const changes: { f: any; before: string; after: string }[] = [];
  for (const f of shared) {
    if (!(f.id in values)) continue;
    const v = asStored(f, values[f.id]);
    const stored = f.value ?? '';
    if (v === stored) continue;
    const base = f.id in shown ? shown[f.id] ?? '' : stored;
    // What the screen was given, sent back: no change of this person's, whatever happened since.
    if (v === base) continue;
    if (base !== stored) throw stale(f);
    changes.push({ f, before: stored, after: v });
  }
  // A choice taken takes the others of its group off, as one change of the group.
  for (const c of [...changes]) {
    if (c.f.type !== 'radio' || c.after !== '1') continue;
    for (const g of shared) if (g.id !== c.f.id && g.type === 'radio' && g.recipient_id === c.f.recipient_id && (g.group_name || g.id) === (c.f.group_name || c.f.id) && g.value === '1' && !changes.some((x) => x.f.id === g.id)) changes.push({ f: g, before: '1', after: '' });
  }
  if (!changes.length) return none;
  assertLimits(changes.map((c) => c.f), Object.fromEntries(changes.map((c) => [c.f.id, c.after])));
  const done = finishedOthers(e, r);
  const names = listNames(done.map((x: any) => x.name));
  if (done.length) {
    const c = changes.find((x) => !x.f.shared_after);
    if (c) throw bad(`${names} already finished, so ${label(c.f)} can no longer be changed.${NO} If it is wrong, tell ${senderOf(e)?.name || 'the sender'}, who can change the document.`, 409, { code: 'shared_locked', field_id: c.f.id });
    if (body?.sign_again !== true)
      throw bad(`${names} already finished. Changing ${label(changes[0].f)} now asks ${done.length === 1 ? names : 'them'} to sign again, and what they signed first stays on record.${NO} To go ahead, send the change again with "sign_again": true.`, 409, { code: 'shared_sign_again', field_id: changes[0].f.id, sign_again: done.map((x: any) => x.name) });
    assertCanStore();
  }
  const ask = changes.find((c) => c.f.shared_initials);
  const initials = okImage(body?.initials_png) ? body.initials_png : okImage(r.initials_png) ? r.initials_png : null;
  if (ask && !initials) throw bad(`Add your initials to change ${label(ask.f)}. The sender asks for initials whenever it changes.${NO}`, 400, { code: 'initials_for_change', field_id: ask.f.id });
  const who = r.name || 'Someone';
  const told = changes.filter((c) => c.after !== '' || c.f.type !== 'radio').map((c) => `${label(c.f)} on page ${Number(c.f.page) + 1} from ${saidValue(c.f.type, c.before)} to ${saidValue(c.f.type, c.after)}`);
  const changer: Actor = { ...actor, name: who, editor: true, editor_id: r.id, editor_name: who };
  const t = now();
  tx(() => {
    for (const c of changes) {
      run('UPDATE fields SET value=? WHERE id=?', sealField(c.f.type, c.after || null), c.f.id);
      const img = c.f.shared_initials ? initials : null;
      run('INSERT INTO shared_changes (envelope_id, field_id, recipient_id, name, before, after, initials_png, sign_again, at) VALUES (?,?,?,?,?,?,?,?,?)',
        e.id, c.f.id, r.id, who, seal('shared_changes.before', c.before || null), seal('shared_changes.after', c.after || null), img ? seal('shared_changes.initials_png', img) : null, done.length ? names : null, t);
      if (c.f.type === 'radio' && c.after === '') continue;
      audit(e.id, actor, 'Field changed by anyone on the document', `${who} changed ${label(c.f)} on page ${Number(c.f.page) + 1}, a field ${ANYONE.toLowerCase()} can fill in. Before: ${saidValue(c.f.type, c.before)}. After: ${saidValue(c.f.type, c.after)}.${img ? ' They added their initials to the change.' : ''}${done.length ? ` ${names} had already finished and ${done.length === 1 ? 'is' : 'are'} asked to sign again.` : ''}`);
    }
    // This person's screen now shows what they changed it to.
    run('UPDATE recipients SET shared_shown=? WHERE id=?', seal('recipients.shared_shown', JSON.stringify({ ...shown, ...Object.fromEntries(changes.map((c) => [c.f.id, c.after])) })), r.id);
    if (!done.length) return;
    // The same sign-again rule a sender's change uses (correctEnvelope): each first signature is set aside and kept,
    // the person goes back in the queue and is emailed when it is their turn, and signing again costs nothing more.
    const byId = new Map<string, any>(e.recipients.map((x: any) => [x.id, x]));
    for (const o of done) {
      setAside(e, o, changer, o);
      run("UPDATE recipients SET status='pending', completed_at=NULL, sent_at=NULL, viewed_at=NULL, unopened_alerted_at=NULL, signed_before=?, free=1 WHERE id=?",
        [o.signed_before, o.completed_at].filter(Boolean).join('\n'), o.id);
      run("UPDATE fields SET value=NULL WHERE recipient_id=? AND type IN ('signature','initials','stamp')", o.id);
    }
    witnessesSetAside(e, done, byId, changer);
    settleWitnesses(e.id);
    run('UPDATE envelopes SET last_change=? WHERE id=?', `${who} changed ${told.join('; ')}.`.slice(0, 2000), e.id);
  });
  // A copy of what each of them signed, from the envelope as it was before this change (see correctEnvelope).
  const later = !done.length ? null : async () => {
    for (const o of done) {
      try {
        const pdf = await buildPdf(e, false, o.id, undefined, false);
        run('UPDATE earlier_signatures SET copy_sha256=? WHERE id=(SELECT MAX(id) FROM earlier_signatures WHERE envelope_id=? AND recipient_id=?)', saveBlob(pdf), e.id, o.id);
      } catch (err: any) {
        console.error('[pdf] could not keep a copy of what was signed before a shared field changed', e.id, err?.message);
      }
    }
    await advance(e.id);
  };
  return { changed: changes.length, sign_again: done.map((x: any) => x.name), later };
}

/** The certificate: every field anyone could fill in that someone changed, with each change. */
export function sharedCertLines(e: any): [string, string][] {
  const out: [string, string][] = [];
  const fields = new Map<string, any>((e.fields || []).filter(isShared).map((f: any) => [f.id, f]));
  if (!fields.size) return out;
  const rows = all('SELECT field_id, name, before, after, initials_png, sign_again, at FROM shared_changes WHERE envelope_id=? ORDER BY id', e.id);
  for (const [fid, f] of fields) {
    const mine = rows.filter((c: any) => c.field_id === fid && !(f.type === 'radio' && !c.after));
    if (!mine.length) continue;
    const said = mine.slice(-20).map((c: any) => `${c.name} on ${at(c.at)}: ${saidValue(f.type, c.before)} to ${saidValue(f.type, c.after)}${c.initials_png ? ', with initials' : ''}${c.sign_again ? `; ${c.sign_again} asked to sign again` : ''}`);
    out.push([`Changed by anyone: ${label(f)}`, `${mine.length > 20 ? `${mine.length} changes, the last 20 here and all in the audit trail. ` : ''}${said.join('. ')}. Printed: ${saidValue(f.type, f.value)}.`]);
  }
  return out;
}

/** records.ts, deleting the values of an envelope: what shared fields said before and after goes too. Answers the
 *  quoted values, so the audit trail loses them as well. */
export function sharedValuesGone(envelopeId: string): string[] {
  const texts: string[] = [];
  for (const c of all('SELECT before, after FROM shared_changes WHERE envelope_id=?', envelopeId))
    for (const v of [c.before, c.after]) if (v && v !== '1') texts.push(`"${String(v).length > 300 ? `${String(v).slice(0, 300)}...` : v}"`);
  run('UPDATE shared_changes SET before=NULL, after=NULL, initials_png=NULL WHERE envelope_id=?', envelopeId);
  run('UPDATE recipients SET shared_shown=NULL WHERE envelope_id=?', envelopeId);
  return [...new Set(texts)];
}
