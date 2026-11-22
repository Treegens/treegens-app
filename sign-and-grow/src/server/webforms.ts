// A form as questions (ds-web-forms; the shared rules are in src/lib/webforms.ts). A visitor of a public form answers
// the questions of its open role, sees the whole document with those answers in it, and then signs on the normal
// signing page. Until they go on to sign nothing is made: no envelope, no email, no signature used. What they typed
// is kept in their own browser and, for the time an unfinished start is kept (a day; the minutes of a shared-device
// form), on the server for that one browser, found by a random id in its cookie. Starting (POST
// /public/powerforms/:slug/start in routes-envelopes.ts) checks every answer again and puts them into the envelope it
// makes, as the visitor's own answers.
import { all, get, run } from './db.ts';
import { bad, now, str, token, hmac, safeEqual } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { applyValues, audit, emailRefusal, loadEnvelope } from './envelopes.ts';
import { renderEnvelopePdf } from './pdf.ts';
import { workOut } from '../lib/logic.ts';
import { questionsOf, firstProblem, answersToKeep, withAnswers, DRAFTS_PER_CONNECTION, DRAFT_MAX_CHARS, type Question } from '../lib/webforms.ts';
import { powerformIdleHours, powerformSharedIdleMinutes } from '../lib/policy.ts';
import type { Ctx } from './router.ts';

/** The questions of a form's template for its open role. */
export const formQuestions = (tpl: any, open: any): Question[] => questionsOf(tpl.fields, tpl.documents, open.id);

/**
 * What the form page needs: the questions, and the fields their checks and "Only show when" rules read (the open
 * role's own, and the fields of others its rules point at, with only what the sender put in them).
 */
export function formView(tpl: any, open: any) {
  const questions = formQuestions(tpl, open);
  if (!questions.length) return { questions };
  const need = new Set<string>(tpl.fields.filter((f: any) => f.recipient_id === open.id).map((f: any) => f.id));
  for (const f of tpl.fields) if (need.has(f.id) && f.show_when?.field) need.add(f.show_when.field);
  const fields = tpl.fields.filter((f: any) => need.has(f.id)).map((f: any) => ({
    id: f.id, type: f.type, recipient_id: f.recipient_id === open.id ? open.id : null, label: f.label, required: f.required, value: f.recipient_id === open.id || !f.recipient_id ? f.value : f.prefill ?? null,
    options: f.options, group_name: f.group_name, validation: f.validation, readonly: f.readonly, show_when: f.show_when, formula: f.formula, w: f.w, h: f.h,
  }));
  return { questions, fields, date_format: tpl.date_format, me: open.id };
}

/** How long the answers of one visitor of form `p` are kept, in milliseconds: as long as an unfinished start is. */
export const draftLife = (p: any): number => (p?.shared_device ? powerformSharedIdleMinutes() * 60_000 : powerformIdleHours() * 3600_000);

const jar = (p: any) => `ts_wf_${p.id}`;

/** This browser's id for form `p`, from its cookie, or null when it has none (or one that was not ours). */
function browserOf(c: Ctx, p: any): string | null {
  const [b, seal] = (readCookie(c.req, jar(p)) || '').split('.');
  return b && seal && safeEqual(seal, hmac(`wf:${p.id}:${b}`)) ? b : null;
}

/** Answers older than their form allows go, for every form. Called on every visit and by the timer (cron.ts). */
export function purgeDrafts(): number {
  let n = 0;
  const shared = new Date(Date.now() - powerformSharedIdleMinutes() * 60_000).toISOString();
  const day = new Date(Date.now() - powerformIdleHours() * 3600_000).toISOString();
  n += run('DELETE FROM form_drafts WHERE updated_at < ? AND powerform_id IN (SELECT id FROM powerforms WHERE shared_device=1)', shared).changes;
  n += run('DELETE FROM form_drafts WHERE updated_at < ?', day).changes;
  return n;
}

/** The answers this browser keeps for form `p`, or null. */
export function readDraft(c: Ctx, p: any): { name: string; email: string; answers: Record<string, string>; updated_at: string } | null {
  purgeDrafts();
  const b = browserOf(c, p);
  const d = b ? get('SELECT name, email, answers, updated_at FROM form_drafts WHERE powerform_id=? AND browser=?', p.id, b) : null;
  if (!d) return null;
  let answers: Record<string, string> = {};
  try {
    answers = JSON.parse(d.answers) || {};
  } catch {
    answers = {};
  }
  return { name: d.name || '', email: d.email || '', answers, updated_at: d.updated_at };
}

/**
 * Keeps what this browser typed into form `p` so far. Only answers to the form's own questions are kept, each no
 * longer than its field takes. One internet connection keeps at most DRAFTS_PER_CONNECTION sets at a time: a new one
 * pushes out its oldest, so a person at a shared connection is never refused for it.
 */
export function saveDraft(c: Ctx, p: any, tpl: any, open: any, body: any) {
  purgeDrafts();
  const questions = formQuestions(tpl, open);
  const asked = new Set(questions.flatMap((q) => q.fields));
  const raw = body?.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (asked.has(k)) answers[k] = str(v, 4000);
  const text = JSON.stringify(answers);
  if (text.length > DRAFT_MAX_CHARS) throw bad('These answers are longer than a form keeps. Make the longest ones shorter, then go on.', 413);
  let b = browserOf(c, p);
  if (!b) b = token(16);
  // The cookie lasts as long as the answers do, and goes with them.
  c.cookies.push(cookie(jar(p), `${b}.${hmac(`wf:${p.id}:${b}`)}`, Math.ceil(draftLife(p) / 1000), c.secure));
  const t = now();
  run(`INSERT INTO form_drafts (powerform_id, browser, ip, name, email, answers, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(powerform_id, browser) DO UPDATE SET ip=excluded.ip, name=excluded.name, email=excluded.email, answers=excluded.answers, updated_at=excluded.updated_at`,
  p.id, b, c.ip, str(body?.name, 120), str(body?.email, 254), text, t);
  if (c.ip !== 'unknown') {
    const extra = all('SELECT powerform_id, browser FROM form_drafts WHERE ip=? ORDER BY updated_at DESC LIMIT -1 OFFSET ?', c.ip, DRAFTS_PER_CONNECTION);
    for (const x of extra) run('DELETE FROM form_drafts WHERE powerform_id=? AND browser=?', x.powerform_id, x.browser);
  }
  return { saved: true, kept_until: new Date(Date.parse(t) + draftLife(p)).toISOString(), review: reviewKey(p, b, t) };
}

/** Forgets this browser's answers to form `p` (it signed, or the person chose to start again). */
export function dropDraft(c: Ctx, p: any) {
  const b = browserOf(c, p);
  if (b) run('DELETE FROM form_drafts WHERE powerform_id=? AND browser=?', p.id, b);
  c.cookies.push(cookie(jar(p), '', 0, c.secure));
}

/**
 * Checks `answers` (keyed by the template's field ids) against the form's questions, as the form page did: every shown
 * required question answered, every format and limit kept. Returns what to keep, or throws with what to do. Also
 * reads them with the fake-notice filter, because the person whose address was typed is shown them under the form's
 * name. `answers` that are missing or empty on a form with no questions are fine.
 */
export function checkAnswers(p: any, tpl: any, open: any, answers: any): Record<string, string> | null {
  if (answers == null) return null;
  if (typeof answers !== 'object' || Array.isArray(answers)) throw bad('The answers could not be read. Go back to the questions and press Next again.');
  const questions = formQuestions(tpl, open);
  if (!questions.length) return null;
  const typed: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) typed[k] = str(v, 8000);
  const problem = firstProblem(questions, tpl.fields, typed, tpl.date_format);
  if (problem) throw bad(`${problem.question.label}: ${problem.text}`);
  const keep = answersToKeep(questions, tpl.fields, typed);
  const no = emailRefusal({ ...tpl, subject: p.name }, [], { pause: false, extra: Object.values(keep).filter((v) => v && v !== '1') } as any);
  if (no) throw bad(`${no.message} Nothing was sent.`, no.status);
  return keep;
}

// Which field of a copy of `tpl` is which field of `tpl`: same file, page, place, size and kind.
const placeKey = (f: any, docs: Map<string, number>) => [docs.get(f.document_id), f.page, f.x, f.y, f.w, f.h, f.type, f.label || ''].join('|');

/**
 * Puts the checked answers into the envelope `eid` just made from `tpl` for the visitor `visitorId`, as that
 * visitor's own answers (as a "save as you go" would), and notes it on the envelope's history.
 */
export function fillAnswers(eid: string, tpl: any, visitorId: string, keep: Record<string, string> | null, again = false) {
  if (!keep || !Object.keys(keep).length) return;
  const e = loadEnvelope(eid);
  const r = e.recipients.find((x: any) => x.id === visitorId);
  if (!r) return;
  const tdocs = new Map<string, number>(tpl.documents.map((d: any) => [d.id, d.position]));
  const edocs = new Map<string, number>(e.documents.map((d: any) => [d.id, d.position]));
  const byPlace = new Map<string, string>(e.fields.filter((f: any) => f.recipient_id === visitorId).map((f: any) => [placeKey(f, edocs), f.id]));
  const values: Record<string, string> = {};
  for (const f of tpl.fields) if (f.id in keep && byPlace.has(placeKey(f, tdocs))) values[byPlace.get(placeKey(f, tdocs))!] = keep[f.id];
  applyValues(e, r, values, false);
  const n = Object.keys(values).length;
  if (again) return audit(eid, { name: r.name }, 'Form answered again', `${r.name} went back to the form, changed the answers and saw the document with the new answers in it. The new answers replaced the earlier ones before the document opened for signing again.`);
  audit(eid, { name: r.name }, 'Form answered', `${r.name} answered the form's questions first (${n} field${n === 1 ? '' : 's'}) and saw the document with those answers in it. The answers were put into the document before it opened for signing. They can still be changed there until ${r.name} finishes.`);
}

/**
 * The same browser started this form before and comes back with the same name and address, so it picks up that start
 * (POST /public/powerforms/:slug/start). The answers it brings now are the ones it checked in the document, so they
 * replace the earlier ones: every question's field is set to the new answer, or emptied when there is none.
 */
export function resumeAnswers(eid: string, tpl: any, open: any, visitorId: string, keep: Record<string, string>) {
  const all: Record<string, string> = {};
  for (const q of formQuestions(tpl, open)) for (const id of q.fields) all[id] = '';
  fillAnswers(eid, tpl, visitorId, { ...all, ...keep }, true);
}

/**
 * The key that opens the document with this browser's answers (GET /public/powerforms/:slug/review?k=). It is given
 * only to the page that saved those answers, and only that save opens it: a later save, from this page or another
 * window, makes a new one. So the next person at a shared tablet, or someone who types the address, sees nothing.
 */
export const reviewKey = (p: any, browser: string, updatedAt: string) => hmac(`wf-review:${p.id}:${browser}:${updatedAt}`);

/** The answers the key `k` opens, or null when it opens nothing (not this browser's, or the answers changed since). */
export function draftForReview(c: Ctx, p: any, k: unknown): { name: string; email: string; answers: Record<string, string> } | null {
  const b = browserOf(c, p);
  const d = b ? readDraft(c, p) : null;
  return d && typeof k === 'string' && k && safeEqual(k, reviewKey(p, b!, d.updated_at)) ? d : null;
}

/**
 * The whole document with this visitor's answers in it, drawn as the signed copy will draw them. The pages are not
 * covered with the "not completed" mark, so the answers can be read; the foot of every page says that this copy has
 * no envelope yet and is not signed. Nothing is stored.
 */
export async function reviewPdf(p: any, tpl: any, open: any, draft: { name: string; email: string; answers: Record<string, string> } | null): Promise<Uint8Array> {
  const questions = formQuestions(tpl, open);
  const keep = draft ? answersToKeep(questions, tpl.fields, draft.answers) : {};
  let fields = withAnswers(tpl.fields, keep, questions);
  // A worked-out number prints what it comes to with these answers.
  const { calc } = workOut(fields);
  fields = fields.map((f: any) => (calc.has(f.id) ? { ...f, value: calc.get(f.id)!.text ?? null } : f));
  const recipients = tpl.recipients.map((r: any) => (r.id === open.id ? { ...r, name: draft?.name || r.role_name || 'You', email: draft?.email || '', status: 'sent' } : { ...r, status: 'pending' }));
  const e = { ...tpl, id: 'none yet, this copy is not signed', subject: p.name, status: 'sent', recipients, fields };
  return renderEnvelopePdf(e, [], { certificate: false, viewer: open.id, unfinished: false });
}
