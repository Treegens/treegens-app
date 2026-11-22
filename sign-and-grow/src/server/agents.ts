// People who change the envelope on their turn instead of signing it (rules and words in src/lib/recipienttypes.ts):
//   - "Can change the document" ('editor'): replaces files, changes, adds or takes off the people after them, and
//     (through the API) the fields of those people. Every change goes through correctEnvelope, so the sender's own
//     Edit rules hold: someone who finished is asked to sign again only with "resign": true, and is told.
//   - "Chooses who comes next" ('agent'): fills in the name and address of a place the sender left open, or changes
//     the name and address of someone after them who has not started.
// Neither changes the subject or the message, nor anyone at or before their own place in the order. Both finish their
// step with POST /sign/:token/step/finish, and the record and the certificate name who did what.
import { get, all, run } from './db.ts';
import { bad, str, isEmail, token, checkCode, now, rateLimit } from './util.ts';
import {
  loadEnvelope, audit, correctEnvelope, correctRecipient, emailRefusal, noteReached, notifySender, advance, newerVersion, senderOf, notOpen, ROLES,
  type Actor,
} from './envelopes.ts';
import { fireWebhooks } from './webhooks.ts';
import { isSelf, sameEmail } from './credits.ts';
import { whoIs } from '../lib/groups.ts';
import { notAsked } from './routing.ts';
import { assertEditorKeepsLockedParts } from './tplcombine.ts';
import { isStepRole, isOpenPlace, openPlaceName, namedLine, stepRoleProblem, STEP_ROLE_WORDS, STEP_DONE, STEP_MAX_PEOPLE, STEP_SAVES_PER_HOUR, type StepRole } from '../lib/recipienttypes.ts';

// Characters nobody sees have no place in a name on a certificate (as for a witness and "Fix my name").
const cleanName = (v: any) => str(v, 120).replace(/[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu, ' ').trim().replace(/\s+/g, ' ');
const listSome = (l: string[], max = 6) => (l.length > max ? `${l.slice(0, max).join(', ')} and ${l.length - max} more` : l.join(', '));
// The roles someone who changes the document may give a person they add or change. Not in person (the sender's own
// device), not a witness (that follows a signer), and not one of these two roles (no chains of people changing it).
const GIVEABLE = ['signer', 'approver', 'cc', 'viewer'];

/** What stops this envelope from going out because of these roles, or null (assertSendable). */
export const stepProblem = (e: any): string | null => stepRoleProblem(e.recipients || [], e.fields || [], !!e.ordered, { form: !!e.powerform_id, bulk: !!e.bulk_id });

/** A template with these roles cannot be a public form or a Send to many: said where those are made. */
export function assertNoStepRoles(tpl: any, what: 'form' | 'bulk') {
  const no = stepRoleProblem(tpl.recipients || [], [], true, what === 'form' ? { form: true } : { bulk: true });
  if (no) throw bad(`${no} Nothing was ${what === 'form' ? 'made' : 'sent'}.`);
}

/**
 * At sending: a place left open for the person who chooses who comes next gets a name to be listed under until then
 * (its template role, or "Chosen by Mia Chen"). Changes `e` in place as well as the rows.
 */
export function nameOpenPlaces(e: any) {
  for (const r of e.recipients) {
    if (!isOpenPlace(r, e.recipients, !!e.ordered)) continue;
    const chooser = e.recipients.filter((x: any) => x.role === 'agent' && Number(x.routing_order) < Number(r.routing_order)).pop();
    const name = String(r.name || '').trim() || openPlaceName(chooser?.name, r.role_name);
    run('UPDATE recipients SET name=?, place_open=1 WHERE id=?', name, r.id);
    Object.assign(r, { name, place_open: 1 });
  }
}

const isLater = (me: any, x: any) => x.id !== me.id && Number(x.routing_order) > Number(me.routing_order);

/** The name of the person who "Can change the document" whose change asked `rid` to sign again, or null (the sender). */
export const changedBy = (eid: string, rid: string): string | null =>
  get('SELECT changed_by FROM earlier_signatures WHERE envelope_id=? AND recipient_id=? ORDER BY id DESC LIMIT 1', eid, rid)?.changed_by || null;

/**
 * For the page of someone who "Can change the document" and waits again after their own change: the people asked to
 * sign again before them, so the page says who and why (GET /sign/:token, recipient.step_wait). Null otherwise.
 */
export function stepWait(e: any, r: any): { again: string[] } | null {
  if (r.role !== 'editor' || r.status !== 'pending' || e.status !== 'sent') return null;
  const again = e.recipients.filter((x: any) => x.id !== r.id && x.signed_before && x.status !== 'completed' && Number(x.routing_order) <= Number(r.routing_order) && changedBy(e.id, x.id) === r.name);
  return again.length ? { again: again.map((x: any) => x.name) } : null;
}

function assertTurn(e: any, r: any, role?: StepRole) {
  if (!isStepRole(r.role) || (role && r.role !== role))
    throw bad(role === 'agent' ? 'Only the person who chooses who comes next can do this.' : role === 'editor' ? 'Only the person who can change the document can do this.' : 'This link is for someone who signs. There is nothing here to change.', 403);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw r.status === 'completed' ? bad('You have already finished your step. Nothing was changed.', 409, { code: 'already_finished' }) : notOpen(e, r);
  if (!r.consent_at) throw bad('Please agree to use electronic records first.', 400, { code: 'consent_first' });
}

/** Why a later person cannot be changed by `me`, or '' when they can. */
function lockedWhy(e: any, me: any, x: any): string {
  if (x.role === 'witness') return `${x.name} is a witness, and the person they witness names or changes them.`;
  if (x.group_id || x.group_name) return `${x.name} is a group, and its members are changed by ${senderOf(e)?.name || 'the sender'}.`;
  if (notAsked(x)) return `${x.name} is not asked, because the rule for them was not met.`;
  // Handing the power to change the document, or to choose people, to another address is the sender's choice alone.
  if (isStepRole(x.role)) return `${x.name} ${STEP_ROLE_WORDS[x.role as StepRole].toLowerCase()}, and only ${senderOf(e)?.name || 'the sender'} changes who that is.`;
  if (x.status === 'completed') return `${x.name} has already finished.`;
  if (x.status !== 'pending') return `${x.name} already has the document.`;
  if (me.role === 'agent' && x.link_by_sender && !x.email) return `${senderOf(e)?.name || 'The sender'} sends ${x.name} their link.`;
  return '';
}

/** What the step screen shows: the people after them, and for an editor the files (GET /sign/:token/step). */
export function stepView(e: any, r: any) {
  if (!isStepRole(r.role)) throw bad('This link is for someone who signs. There is nothing here to change.', 403);
  const sender = senderOf(e);
  const people = e.recipients.filter((x: any) => isLater(r, x)).map((x: any) => {
    const open = !String(x.email || '').trim() && !x.link_by_sender && !x.group_id;
    return {
      id: x.id, role: x.role, role_name: x.role_name || null,
      // A place waiting to be named shows empty boxes, not the name it is listed under.
      name: open && x.place_open ? '' : x.name, email: x.email || '', place: x.role_name || (open && x.place_open ? x.name : null),
      open, why_not: lockedWhy(e, r, x) || null, chosen_by: x.chosen_by || null,
    };
  });
  return {
    role: r.role, role_words: STEP_ROLE_WORDS[r.role as StepRole], sender: { name: sender?.name || '', email: sender?.email || '' },
    people, open_left: people.filter((p: any) => p.open && !p.why_not).length,
    documents: r.role === 'editor' ? e.documents.map((d: any) => ({ id: d.id, name: d.name, pages: d.pages, file_id: d.file_id })) : undefined,
    edit_version: e.edit_version, finished: r.status === 'completed',
  };
}

/** A file uploaded through an editor's link is theirs to use on this envelope only. */
export function noteStepUpload(fileId: string, r: any) {
  run('UPDATE files SET step_upload_by=? WHERE id=?', r.id, fileId);
}

/**
 * "Chooses who comes next" (POST /sign/:token/step/people): { people: [{ id, name, email }] } for people after them.
 * A place left open gets its first person; someone already named is changed like the sender's Correct does it.
 */
export async function nameNext(e: any, r: any, body: any, actor: Actor) {
  assertTurn(e, r, 'agent');
  rateLimit(`step:${r.id}`, STEP_SAVES_PER_HOUR, 3600_000);
  const asked: any[] = Array.isArray(body?.people) ? body.people : [];
  if (!asked.length) throw bad('Type the name and email address of at least one person. Nothing was changed.');
  if (asked.length > STEP_MAX_PEOPLE) throw bad(`You can name up to ${STEP_MAX_PEOPLE} people at once. Nothing was changed.`);
  const from = senderOf(e)?.name || 'the sender';
  const seen = new Set<string>();
  // Everything is checked first, so a mistake in the third line changes nothing in the first two.
  const plan: { x: any; name: string; email: string }[] = [];
  for (const p of asked) {
    const x = e.recipients.find((y: any) => y.id === str(p?.id, 80));
    if (!x || !isLater(r, x)) throw bad(x ? `${x.name} comes before you or is you, and you can only choose the people after you. Nothing was changed.` : 'That person is not on this document. Load the page again. Nothing was changed.', x ? 403 : 404);
    if (seen.has(x.id)) throw bad(`${x.name} is in the list twice. Nothing was changed.`);
    seen.add(x.id);
    const why = lockedWhy(e, r, x);
    if (why) throw bad(`${why} So you cannot change them here. Nothing was changed.`, 409);
    const name = cleanName(p?.name);
    const email = str(p?.email, 254).trim();
    const place = x.role_name || (x.place_open ? x.name : x.name);
    if (name.length < 2 || !isEmail(email)) throw bad(`Type the full name and the email address of the person for ${place}. Nothing was changed.`);
    if (name === x.name && sameEmail(email, x.email)) continue;
    plan.push({ x, name, email });
  }
  if (!plan.length) return stepView(e, r);
  // Everyone named is a new person emailed in the sender's name later on: not while paused, read by the fake-notice
  // filter (names too), and counted towards the daily limit, as when the sender adds them.
  const fresh = plan.filter((p) => !sameEmail(p.email, p.x.email)).map((p) => p.email);
  const no = emailRefusal(e, fresh, { extra: plan.map((p) => p.name) });
  // The reason is the sender's business (their account, their checks): the person here is told what they can do.
  if (no) throw bad(`We cannot add these people to the document right now. Nothing was changed. Reply to the email you got and ask ${from} to add them.`, no.status);
  const sender = senderOf(e) || { email: '', name: '' };
  for (const { x, name, email } of plan) {
    const before = String(x.email || '').trim() ? { name: x.name, email: x.email } : null;
    if (!before) {
      // A place nobody was in yet: no link was ever sent, so it simply gets its person.
      run('UPDATE recipients SET name=?, email=?, place_open=0, token=?, check_code=?, free=?, chosen_by=?, chosen_at=? WHERE id=?',
        name, email, token(), checkCode(), isSelf({ ...x, name, email }, sender) ? 1 : 0, whoIs(r), now(), x.id);
      noteReached(e, [email]);
    } else {
      // Someone the sender named: changed exactly as the sender's Correct changes them (link, answers, money).
      await correctRecipient(loadEnvelope(e.id), x.id, { name, email }, actor);
      run('UPDATE recipients SET place_open=0, chosen_by=?, chosen_at=? WHERE id=?', whoIs(r), now(), x.id);
    }
    audit(e.id, actor, 'Person chosen', namedLine(r.name, { name, email }, x, before));
  }
  newerVersion(e.id, actor, `chose ${listSome(plan.map((p) => p.name))} as the people after them`);
  return stepView(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
}

/**
 * "Can change the document" (POST /sign/:token/step/change). The body says what they want, never more:
 *   documents: the whole list of files [{ id?, file_id, name? }] (an id that is on the envelope keeps its fields);
 *   people: the whole list of people after them [{ id?, name, email, role?, routing_order? }] (left out: taken off);
 *   fields: the fields of the people after them (and the sender's own notes), in the editor's format;
 *   resign: true to save a change that asks someone who finished to sign again.
 * Anything about the people at or before their place, the subject and the message stays as it is.
 */
export async function editorChange(e: any, r: any, body: any, actor: Actor) {
  assertTurn(e, r, 'editor');
  rateLimit(`step:${r.id}`, STEP_SAVES_PER_HOUR, 3600_000);
  const mine = Number(r.routing_order);
  const before = e.recipients.filter((x: any) => !isLater(r, x));
  const out: any = { resign: body?.resign === true, ...(body?.edit_version != null ? { edit_version: body.edit_version } : {}) };
  let rows = e.recipients;
  if (body?.people !== undefined) {
    if (!Array.isArray(body.people)) throw bad('"people" must be a list of the people after you. Nothing was changed.');
    if (body.people.length > STEP_MAX_PEOPLE) throw bad(`You can list up to ${STEP_MAX_PEOPLE} people. Nothing was changed.`);
    const byId = new Map<string, any>(e.recipients.map((x: any) => [x.id, x]));
    const kept: any[] = [];
    const seen = new Set<string>();
    const last = Math.max(mine, ...e.recipients.map((x: any) => Number(x.routing_order)));
    for (const [i, p] of body.people.entries()) {
      const pid = str(p?.id, 80);
      const old = pid ? byId.get(pid) : null;
      if (pid && !old) throw bad(`Person ${i + 1} is not on this document. Leave the id out to add someone new. Nothing was changed.`, 404);
      if (old && !isLater(r, old)) throw bad(`${old.name} comes before you or is you, and you can only change the people after you. Nothing was changed.`, 403);
      if (old && seen.has(old.id)) throw bad(`${old.name} is in the list twice. Nothing was changed.`);
      if (old) seen.add(old.id);
      const role = p?.role == null || p.role === '' ? old?.role || 'signer' : str(p.role, 20);
      if (!ROLES.includes(role) || (!GIVEABLE.includes(role) && role !== old?.role)) throw bad(`Person ${i + 1} can be given one of these roles: Needs to sign, Needs to approve, Gets a copy, Must open it. Nothing was changed.`);
      const order = p?.routing_order == null || p.routing_order === '' ? old?.routing_order ?? last + 1 : Number(p.routing_order);
      if (!Number.isInteger(order) || order <= mine || order > 99) throw bad(`Everyone you add or move has to come after you in the signing order, so their place is a whole number above ${mine}. Nothing was changed.`);
      const name = p?.name === undefined && old ? old.name : cleanName(p?.name);
      const email = p?.email === undefined && old ? old.email : str(p?.email, 254).trim();
      if (old && (old.role === 'witness' || old.group_id || isStepRole(old.role)) && (name !== old.name || !sameEmail(email, old.email) || role !== old.role))
        throw bad(`${lockedWhy(e, r, old)} So you cannot change them here. Nothing was changed.`, 409);
      if (name.length < 2 || !isEmail(email)) throw bad(`Type the full name and the email address of person ${i + 1}${old ? ` (${old.name})` : ''}. Nothing was changed.`);
      kept.push(old ? { ...old, name, email, role, routing_order: order } : { role, name, email, routing_order: order });
    }
    // Witnesses of the people who stay stay with them, whatever the list says.
    for (const x of e.recipients) if (isLater(r, x) && x.role === 'witness' && !seen.has(x.id)) kept.push(x);
    rows = [...before, ...kept];
    // Someone has to come after them: said to them, about the people on their own screen, with what they can do.
    if (!kept.some((x: any) => x.role !== 'witness')) {
      const last = e.recipients.filter((x: any) => isLater(r, x) && x.role !== 'witness').map((x: any) => x.name);
      throw bad(`Someone has to sign after you, so ${last.length ? listSome(last) : 'everyone after you'} cannot ${last.length === 1 ? 'be' : 'all be'} taken off. Press Keep, or ask ${senderOf(e)?.name || 'the sender'} in Questions and comments. Nothing was changed.`, 409, { code: 'nobody_after' });
    }
    out.recipients = rows;
  }
  const gone = new Set<string>(e.recipients.filter((x: any) => !rows.some((y: any) => y.id === x.id)).map((x: any) => x.id));
  let docIds = new Set<string>(e.documents.map((d: any) => d.id));
  if (body?.documents !== undefined) {
    if (!Array.isArray(body.documents) || !body.documents.length) throw bad('"documents" must be the list of files on the envelope, with at least one. Nothing was changed.');
    if (body.documents.length > 30) throw bad('An envelope can hold up to 30 documents. Nothing was changed.');
    const onIt = new Set<string>(e.documents.map((d: any) => d.file_id));
    out.documents = body.documents.map((d: any, i: number) => {
      const fid = str(d?.file_id, 80);
      // Only the files on this envelope, and files uploaded through this link: never another document of the account.
      if (!onIt.has(fid) && !get('SELECT 1 x FROM files WHERE id=? AND account_id=? AND step_upload_by=?', fid, e.account_id, r.id))
        throw bad(`Document ${i + 1}: upload the file through this page first (Replace). Nothing was changed.`);
      const old = e.documents.find((x: any) => x.id === str(d?.id, 80));
      // A replaced file keeps the document's name: nobody asked for a rename, so nobody is told about one.
      return old ? { ...old, file_id: fid, name: str(d?.name, 200) || old.name } : { file_id: fid, name: str(d?.name, 200) || undefined, supplemental: null };
    });
    docIds = new Set<string>(out.documents.map((d: any) => d.id).filter(Boolean));
    // A file taken off that someone before them has fields on cannot go: replacing it can.
    for (const d of e.documents) {
      if (docIds.has(d.id)) continue;
      const theirs = e.fields.find((f: any) => f.document_id === d.id && f.recipient_id && !isLater(r, e.recipients.find((x: any) => x.id === f.recipient_id) || { routing_order: 0 }));
      if (theirs) throw bad(`${e.recipients.find((x: any) => x.id === theirs.recipient_id)?.name || 'Someone before you'} has fields on "${d.name}", so it cannot be taken off. You can replace it instead. Nothing was changed.`, 409);
    }
  }
  const laterIds = new Set<string>(rows.filter((x: any) => isLater(r, x)).map((x: any) => x.id));
  // The fields of the people at or before their place stay exactly as they are.
  const stays = (f: any) => f.recipient_id && !laterIds.has(f.recipient_id) && !gone.has(f.recipient_id);
  if (body?.fields !== undefined) {
    if (!Array.isArray(body.fields)) throw bad('"fields" must be a list. Nothing was changed.');
    for (const f of body.fields) if (f?.recipient_id && !laterIds.has(f.recipient_id) && rows.some((x: any) => x.id === f.recipient_id)) throw bad('You can place fields only for the people after you. The fields of everyone else stay as they are. Nothing was changed.', 403);
    out.fields = [...e.fields.filter(stays), ...body.fields];
  } else if (gone.size || body?.documents !== undefined) {
    // People taken off take their fields with them, and a file taken off takes the later people's fields on it.
    out.fields = e.fields.filter((f: any) => !gone.has(f.recipient_id) && (docIds.has(f.document_id) || stays(f)));
  }
  if (out.recipients === undefined && out.documents === undefined && out.fields === undefined) throw bad('There is no change to save. Nothing was changed.');
  // Made from several templates: a part whose wording is locked stays as it is (tplcombine.ts).
  assertEditorKeepsLockedParts(e, r, out, senderOf(e)?.name || 'the sender');
  const by: Actor = { ...actor, editor: true, editor_id: r.id, editor_name: r.name };
  await correctEnvelope(e, out, e.account_id, by);
  audit(e.id, by, 'Changed on their turn', `${whoIs(r)} made the change above on their turn. ${senderOf(e)?.name || 'The sender'} gave them the role "${STEP_ROLE_WORDS.editor}". The subject, the message and the people before them were not changed.`);
  return stepView(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
}

/** Either role finishes their step (POST /sign/:token/step/finish). Nobody signs: the record says what they did. */
export async function finishStep(e: any, r: any, actor: Actor) {
  assertTurn(e, r);
  if (r.role === 'agent') {
    const open = e.recipients.filter((x: any) => isLater(r, x) && !String(x.email || '').trim() && !x.link_by_sender && !x.group_id && x.role !== 'witness' && !notAsked(x));
    if (open.length) throw bad(`Name ${open.length === 1 ? 'the person' : 'everyone'} still open first: ${listSome(open.map((x: any) => x.role_name || x.name))}. Type a name and an email address for ${open.length === 1 ? 'it' : 'each'}, then finish.`, 409, { code: 'open_places' });
  }
  const t = now();
  const claimed = run("UPDATE recipients SET status='completed', completed_at=?, viewed_at=COALESCE(viewed_at, ?), ip=?, user_agent=? WHERE id=? AND status IN ('sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent'",
    t, t, actor.ip || null, (actor.ua || '').slice(0, 300), r.id).changes;
  if (!claimed) throw bad('You have already finished your step, or the document is no longer open.', 409, { code: 'already_finished' });
  const did = all("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND actor=? AND action IN ('Person chosen','Changed on their turn')", e.id, actor.name)[0]?.n || 0;
  // The sender reads every person they chose, a copy recipient too, in the email itself, not only in the history.
  const named = all("SELECT detail FROM audit WHERE envelope_id=? AND actor=? AND action='Person chosen' ORDER BY seq", e.id, actor.name).map((a: any) => String(a.detail));
  audit(e.id, actor, STEP_DONE[r.role as StepRole], `${whoIs(r)}, who ${r.role === 'agent' ? 'chooses who comes next' : 'can change the document'}, finished their step${did ? '' : ' without changing anything'}. They do not sign.`);
  fireWebhooks(e.account_id, 'recipient.completed', e.id, { recipient_id: r.id });
  const left = e.recipients.filter((x: any) => x.id !== r.id && x.status !== 'completed' && x.role !== 'cc' && !notAsked(x));
  await notifySender(e, 'signed', `Step finished: ${e.subject}`, `${r.name} finished their step on your document`,
    [did ? (r.role === 'agent' ? `${r.name} chose who comes next.` : `${r.name} changed the document. Its history says what changed.`) : `${r.name} changed nothing.`, ...named.slice(0, 20), ...(named.length > 20 ? [`And ${named.length - 20} more. The document's history lists them all.`] : []), ...(left.length ? [`Next: ${listSome(left.map((x: any) => x.name))}.`] : [])]);
  await advance(e.id);
}
