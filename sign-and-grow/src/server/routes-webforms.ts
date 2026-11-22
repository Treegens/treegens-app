// A public form's questions (ds-web-forms): the answers this browser keeps while it fills the form in, and the whole
// document with those answers in it before the person goes on to sign. Nothing here makes an envelope, sends an
// email or uses a signature: that happens only at POST /public/powerforms/:slug/start (routes-envelopes.ts).
import { route, pdfResponse, type Ctx } from './router.ts';
import { get } from './db.ts';
import { bad, rateLimit, HttpError } from './util.ts';
import { formPageRefusal } from './envelopes.ts';
import { formCustomProblem } from './customfields.ts';
import { powerformTemplate, formClosed } from './routes-envelopes.ts';
import { readDraft, saveDraft, dropDraft, reviewPdf, draftForReview } from './webforms.ts';

/** Saves of form answers one connection may make in an hour: about 60 people answering 10 questions each. */
export const SAVES_PER_HOUR = 600;
/** The same for forms used on a shared device. */
export const SHARED_SAVES_PER_HOUR = 3000;

const CLOSED = 'This form cannot take new signatures right now. Please contact whoever gave you the link.';

// The form a visitor is on, while it takes people: the same tests as the form's page (GET /public/powerforms/:slug).
// A closed form keeps nothing new and shows nothing.
function openForm(c: Ctx) {
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  if (!p) throw bad('This form is not available. Ask whoever gave you the link: it may have been paused or removed.', 404);
  const { tpl, open } = powerformTemplate(p.template_id);
  const account = get('SELECT * FROM accounts WHERE id=?', p.account_id);
  if (formPageRefusal(account, p.name) || formCustomProblem(tpl) || formClosed(p, tpl)) throw bad(CLOSED, 503);
  return { p, tpl, open };
}

// Saving as you go is cheap for an honest person (one save per question) and capped for a script.
// A form used on a shared device (one front desk or school connection, many people an hour) gets its own, larger
// allowance, as its starts do.
function limit(c: Ctx, what: 'save' | 'review', shared = false) {
  const [key, most, mins] = what === 'save' ? (shared ? [`wf-save-shared:${c.ip}`, SHARED_SAVES_PER_HOUR, 60] : [`wf-save:${c.ip}`, SAVES_PER_HOUR, 60]) : [`wf-review:${c.ip}`, 60, 10];
  try {
    rateLimit(key, most, mins * 60_000);
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw bad(what === 'save' ? 'This connection has saved form answers very often in the last hour. Wait a few minutes, then press Next again: what you typed is still on this screen.' : 'The document with your answers has been opened very often from this connection. Wait a few minutes, then open it again.', 429);
    throw e;
  }
}

// A form on a shared device never hands answers back: the next person at the same tablet would see them. Its page
// forgets them when it opens (DELETE below), and keeps them on the server only for the document before signing.
route('GET', '/public/powerforms/:slug/draft', (c) => {
  const { p } = openForm(c);
  return { draft: p.shared_device ? null : readDraft(c, p) };
}, 'public');

route('PUT', '/public/powerforms/:slug/draft', async (c) => {
  const { p, tpl, open } = openForm(c);
  limit(c, 'save', !!p.shared_device);
  return saveDraft(c, p, tpl, open, await c.body());
}, 'public');

route('DELETE', '/public/powerforms/:slug/draft', (c) => {
  const p = get('SELECT * FROM powerforms WHERE slug=?', c.params.slug);
  if (p) dropDraft(c, p);
  return { ok: true };
}, 'public');

// The document as it will be signed, with the answers of the save whose key `k` is given (draftForReview). Its foot
// says it is not signed. Without that key nothing is drawn: not the previous person's answers on a shared tablet, and
// not the bare template for someone who typed no details.
route('GET', '/public/powerforms/:slug/review', async (c) => {
  limit(c, 'review');
  const { p, tpl, open } = openForm(c);
  const draft = draftForReview(c, p, c.q.get('k'));
  if (!draft) throw bad('Your answers have changed since this page saved them, or they are no longer kept. Go back to the questions and press Next on the last one again.', 409);
  return pdfResponse(await reviewPdf(p, tpl, open, draft), p.name, true);
}, 'public');
