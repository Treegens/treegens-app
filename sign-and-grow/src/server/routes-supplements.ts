// The files given to read with a document, on the signing page (src/server/supplements.ts):
//   GET  /sign/:token/supplements/:doc              the file, to show or save. The first time this person's link
//                                                   fetches it while they still have to finish, "Opened <name>" goes
//                                                   in the audit trail. Opened, never read.
//   POST /sign/:token/supplements/:doc/acknowledge  the tick "I have been given <name>", for a file whose rule asks
//                                                   for it: "Acknowledged receiving <name>" in the audit trail.
// Authorised by the signing link like everything else on that page (find and look in routes-sign.ts).
import { route, pdfResponse } from './router.ts';
import { readBlob } from './db.ts';
import { rateLimit } from './util.ts';
import { audit, notOpen } from './envelopes.ts';
import { find, look, assertViewable } from './routes-sign.ts';
import { refuse } from './signlang.ts';
import { isSupplement, mark, missingFor, openedNow, OPENED_DETAIL } from './supplements.ts';
import { meetsRules, OPENED_ACTION, ACKNOWLEDGED_ACTION } from '../lib/supplements.ts';

const stillToFinish = (e: any, r: any) => e.status === 'sent' && (r.status === 'sent' || r.status === 'viewed');

const fileOf = (e: any, docId: string) => {
  const d = e.documents.find((x: any) => x.id === docId);
  if (!d || !isSupplement(d)) throw refuse('supplement_not_found', 404);
  return d;
};

route('GET', '/sign/:token/supplements/:doc', (c) => {
  const { e, r, actor } = find(c);
  assertViewable(e, r);
  const d = fileOf(e, c.params.doc);
  // Counted only after the person agreed to electronic records (the list is shown after that), and only once.
  if (openedNow(e, r, d)) audit(e.id, actor, OPENED_ACTION(d.name), OPENED_DETAIL);
  return pdfResponse(readBlob(d.sha256), d.name, c.url.searchParams.get('download') !== '1');
}, 'public');

route('POST', '/sign/:token/supplements/:doc/acknowledge', async (c) => {
  find(c);
  await c.body().catch(() => ({}));
  // Looked up again after the body is in, like every change on the signing page (checkedBody in routes-sign.ts).
  const { e, r, actor } = look(c);
  const d = fileOf(e, c.params.doc);
  if (!stillToFinish(e, r)) throw notOpen(e, r);
  if (!r.consent_at) throw refuse('consent_first', 400);
  if (d.supplemental.rule !== 'acknowledge' || !meetsRules(r.role)) throw refuse('supplement_no_tick', 400);
  rateLimit(`supplement:${r.id}`, 60, 3600_000);
  if (mark(e, r, d, 'acknowledged')) audit(e.id, actor, ACKNOWLEDGED_ACTION(d.name), `${r.name} ticked "I have been given ${d.name}".`);
  return { ok: true, missing: missingFor(e, r) };
}, 'public');
