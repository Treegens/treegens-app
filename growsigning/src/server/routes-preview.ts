// "See what each person sees": making a preview link, and the signing page's calls while it shows one (preview.ts).
// Every call under /preview/:token answers without writing anything: the view and the files are read, consent and
// "save as you go" answer as if they went through, and everything else is refused with PREVIEW_NOTHING.
import { route, pdfResponse, type Ctx } from './router.ts';
import { readBlob } from './db.ts';
import { rateLimit, bad } from './util.ts';
import { mine } from './routes-envelopes.ts';
import { signView } from './routes-sign.ts';
import { makePreview, openPreview, previewView, previewRefusal } from './preview.ts';
import { CONSENT_VERSION } from '../lib/policy.ts';
import { buildPdf } from './envelopes.ts';
import { listName } from '../lib/docname.ts';

function make(c: Ctx, kind: 'envelope' | 'template') {
  rateLimit(`preview-make:${c.user.id}`, 120, 600_000);
  return c.body().then((b) => makePreview(c, mine(c, c.params.id, kind), b.recipient_id));
}
route('POST', '/envelopes/:id/recipient-preview', (c) => make(c, 'envelope'));
route('POST', '/templates/:id/recipient-preview', (c) => make(c, 'template'));

// The preview's own reading rule: the envelope or template as its maker may open it now, whichever kind it is.
const readable = (c: Ctx, id: string) => mine(c, id);
const opened = (c: Ctx) => {
  rateLimit(`preview:${c.ip}`, 2000, 600_000);
  return openPreview(c, readable);
};

route('GET', '/preview/:token', (c) => previewView(c, opened(c), signView), 'public');

route('GET', '/preview/:token/doc/:doc', (c) => {
  const { e } = opened(c);
  const d = e.documents.find((x: any) => x.id === c.params.doc && !x.supplemental);
  if (!d) throw bad('That file is not on this document.', 404);
  return pdfResponse(readBlob(d.sha256), d.name, true);
}, 'public');

route('GET', '/preview/:token/supplements/:doc', (c) => {
  const { e } = opened(c);
  const d = e.documents.find((x: any) => x.id === c.params.doc && x.supplemental);
  if (!d) throw bad('That file is not on this document.', 404);
  return pdfResponse(readBlob(d.sha256), d.name, c.q.get('download') !== '1');
}, 'public');

// "Download or print": the copy made for this person, as their own download is while the document is out.
route('GET', '/preview/:token/download', async (c) => {
  const { e, r } = opened(c);
  return pdfResponse(await buildPdf(e, false, r.id), listName(e.subject) || 'document', c.q.get('inline') === '1');
}, 'public');

// Agreeing on the consent screen opens the document in the preview, and nothing is written: the real person agrees
// for themselves when they open their own link.
route('POST', '/preview/:token/consent', (c) => {
  const { e } = opened(c);
  return { ok: true, version: e.content_version ?? null, wording: CONSENT_VERSION, preview: true };
}, 'public');
// "Saves as you go" on the page: kept in this tab only.
route('POST', '/preview/:token/save', (c) => (opened(c), { ok: true, preview: true }), 'public');
// The check of characters before Finish: nothing to check, because nothing is signed.
route('POST', '/preview/:token/print-check', (c) => (opened(c), { problems: [], preview: true }), 'public');

// Everything else the page could ask: refused, after the link itself is checked, so an ended preview says so.
const refuse = (c: Ctx) => {
  opened(c);
  throw previewRefusal();
};
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  route(method, '/preview/:token/:a', refuse, 'public');
  route(method, '/preview/:token/:a/:b', refuse, 'public');
  route(method, '/preview/:token/:a/:b/:c', refuse, 'public');
}
