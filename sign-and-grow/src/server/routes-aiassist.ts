// AI help when sending and signing (src/server/aiassist.ts). Every route answers 403 when the account's AI is off,
// so with no model on the server nothing here sends anything anywhere.
//   GET  /ai/assist                 what the screens may offer, and to whom the text goes
//   PUT  /account/ai-read           { read: 'on' | 'off' }: "Let the AI read document text", admins in a browser
//   POST /ai/fields                 suggested fields for pages where nothing was found (needs the read switch)
//   POST /ai/draft                  a subject and a message to edit (the document text only with the read switch)
//   GET  /envelopes/:id/ai-summary  whether this envelope offers signers a summary, and whether it may
//   PUT  /envelopes/:id/ai-summary  { on: boolean }, the sender's choice for this envelope
//   POST /sign/:token/summary       the summary of each file, for the person signing (written once per file), until they finish
import { route } from './router.ts';
import { bad } from './util.ts';
import { run } from './db.ts';
import { record } from './seclog.ts';
import { mine } from './routes-envelopes.ts';
import { find, assertViewable } from './routes-sign.ts';
import { assistInfo, assistOn, setRead, suggestFields, cleanDraftIn, draftMessage, envelopeText, mayRead, summaryOffered, summariesFor, noteSummaryShown } from './aiassist.ts';
import { SUMMARY_WARNING, SUMMARY_DOWN, SUMMARY_AFTER, SUMMARY_AFTER_YOU, NOT_ALLOWED } from '../lib/aiassist.ts';

route('GET', '/ai/assist', (c) => assistInfo(c.account.id));

route('PUT', '/account/ai-read', async (c) => {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change this setting. That needs an owner or an admin signed in to the app, under Settings, Account. Nothing was changed.', 403);
  const b = await c.body();
  if (b.read !== 'on' && b.read !== 'off') throw bad('Send "read" as "on" or "off". Nothing was changed.');
  // Switching it on where no model may answer for this account would be a switch that does nothing. Off is always allowed.
  if (b.read === 'on' && !assistOn(c.account.id)) throw bad(`${NOT_ALLOWED} Nothing was changed.`, 409);
  const ch = setRead(c.account.id, b.read === 'on');
  if (ch.from !== ch.to || ch.keyDatesStopped) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: {
    ...(ch.from !== ch.to ? { ai_reads_document_text: { from: ch.from, to: ch.to } } : {}),
    ...(ch.keyDatesStopped ? { ai_key_dates: { from: 'on', to: 'off' } } : {}),
  } } });
  return { ...assistInfo(c.account.id), ...(ch.keyDatesStopped ? { key_dates_stopped: true } : {}) };
}, 'admin');

route('POST', '/ai/fields', async (c) => {
  const b = await c.body();
  const signers = Math.min(50, Math.max(1, Math.floor(Number(b.signers) || 1)));
  return suggestFields({ ip: c.ip, account: c.account.id }, b.pages, signers);
});

route('POST', '/ai/draft', async (c) => {
  const b = await c.body();
  const input = cleanDraftIn(b);
  // The document text, only from an envelope this person may open, and only with the read switch on.
  const text = input.envelopeId && mayRead(c.account.id) ? envelopeText(mine(c, input.envelopeId)) : '';
  return draftMessage({ ip: c.ip, account: c.account.id, senderName: c.user.name, accountName: c.account.name || '' }, input, text);
});

route('GET', '/envelopes/:id/ai-summary', (c) => {
  const e = mine(c, c.params.id);
  return { on: !!e.ai_summary, may: mayRead(c.account.id) && e.kind === 'envelope' };
});

route('PUT', '/envelopes/:id/ai-summary', async (c) => {
  const b = await c.body();
  if (typeof b.on !== 'boolean') throw bad('Send "on" as true or false. Nothing was changed.');
  const e = mine(c, c.params.id);
  if (e.kind !== 'envelope') throw bad('A summary is chosen for each document you send, not for a template. Nothing was changed.');
  if (['completed', 'voided', 'declined', 'expired'].includes(e.status)) throw bad('This document is closed, so nobody will sign it any more. Nothing was changed.', 409);
  if (b.on && !mayRead(c.account.id)) throw bad('A summary needs "Let the AI read document text", which is off on this account. An admin can turn it on in Settings, Account. Nothing was changed.', 403, { code: 'read_off' });
  run('UPDATE envelopes SET ai_summary=? WHERE id=?', b.on ? 1 : 0, e.id);
  return { on: b.on, may: true };
});

route('POST', '/sign/:token/summary', async (c) => {
  const first = find(c);
  assertViewable(first.e, first.r);
  // Only before this person finished: a record line after their signature could be read as shown before it.
  if (first.r.status === 'completed' || first.e.status === 'completed') throw bad(first.e.status === 'completed' ? SUMMARY_AFTER : SUMMARY_AFTER_YOU, 409, { code: 'finished' });
  if (!summaryOffered(first.e)) throw bad('There is no summary for this document. Read the document itself; it is all you need to sign.', 404);
  const documents = await summariesFor(first.e, { ip: c.ip, link: first.r.id });
  // Looked up again after the wait: the sender may have changed the documents meanwhile (routes-sign.ts checkedBody).
  const { e, r, actor } = find(c);
  const now = e.documents.map((d: any) => d.id).join(',');
  if (now !== documents.map((d) => d.id).join(',')) throw bad('The sender changed this document a moment ago. Open the summary again.', 409);
  const shown = documents.some((d) => d.text);
  if (shown) noteSummaryShown(e, r, actor);
  return { warning: SUMMARY_WARNING, documents, ...(documents.some((d) => !d.text && !d.none) ? { note: SUMMARY_DOWN } : {}) };
}, 'public');
