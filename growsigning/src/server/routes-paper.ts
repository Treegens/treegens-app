// Signed on paper (src/server/paper.ts): the print and the upload on the signing link, the sender's decision on the
// envelope, and the admins' switch in Settings, Sending.
import { route, pdfResponse } from './router.ts';
import { bad, rateLimit } from './util.ts';
import { readBlob } from './db.ts';
import { record } from './seclog.ts';
import { find, look } from './routes-sign.ts';
import { mine, storeUpload } from './routes-envelopes.ts';
import { notOpen } from './envelopes.ts';
import { paperOn, setPaperOn, paperWay, printPdf, keepScan, acceptScan, askAgain, scansView, scanFile } from './paper.ts';
import { delegateLinkOf } from './delegation.ts';
import { listName } from '../lib/docname.ts';

const offered = (c: any, e: any, r: any) => {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  if (!paperWay(e, r) || delegateLinkOf(c.params.token)) throw bad('Signing on paper is not offered for this document. Sign on screen, or ask the sender.', 409, { code: 'paper_not_offered' });
};

// The print: the cover page with how to send it back, then the document with this person's places marked.
route('GET', '/sign/:token/paper/print', async (c) => {
  const { e, r } = find(c);
  offered(c, e, r);
  rateLimit(`paper-print:${r.id}`, 60, 3600_000);
  return pdfResponse(await printPdf(e, r), `To sign on paper - ${listName(e.subject || 'document')}`);
}, 'public');

// The photos or the scan, as multipart "file" parts: a PDF, or JPEG and PNG pictures that become one document.
route('POST', '/sign/:token/paper', async (c) => {
  const first = find(c);
  offered(c, first.e, first.r);
  rateLimit(`paper-upload:${first.r.id}`, 10, 3600_000);
  const file = await storeUpload(c, null);
  // Looked up again after the upload was read: the document may have closed or changed meanwhile.
  const { e, r, actor } = look(c);
  offered(c, e, r);
  return keepScan(e, r, file, actor);
}, 'public');

route('GET', '/account/paper', (c) => ({ on: paperOn(c.account.id) }), 'admin');

route('PUT', '/account/paper', async (c) => {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change this setting. That needs an owner or an admin signed in to the app, under Settings, Sending. Nothing was changed.', 403);
  const b = await c.body();
  if (typeof b?.on !== 'boolean') throw bad('Send "on": true or false. Nothing was changed.');
  if (setPaperOn(c.account.id, b.on)) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: { paper_sign: b.on } } });
  return { on: paperOn(c.account.id) };
}, 'admin');

route('GET', '/envelopes/:id/paper', (c) => ({ scans: scansView(mine(c, c.params.id, 'envelope')) }));

route('GET', '/envelopes/:id/recipients/:rid/paper/scan', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  const s = scanFile(e, c.params.rid, c.q.get('scan'));
  const f = { sha256: s.sha256 };
  const r = e.recipients.find((x: any) => x.id === c.params.rid);
  return pdfResponse(readBlob(f.sha256), `Scan signed on paper - ${listName(r?.name || 'signer')}`, true);
});

route('POST', '/envelopes/:id/recipients/:rid/paper/accept', async (c) => {
  await c.body();
  return acceptScan(mine(c, c.params.id, 'envelope'), c.params.rid, c.actor);
});

route('POST', '/envelopes/:id/recipients/:rid/paper/reject', async (c) => {
  const b = await c.body();
  return askAgain(mine(c, c.params.id, 'envelope'), c.params.rid, b?.reason, c.actor);
});
