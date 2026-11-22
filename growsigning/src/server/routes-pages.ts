// POST /envelopes/:id/documents/:doc/pages: remove, turn and move pages of one document (src/server/pages.ts).
// For drafts and templates it is saved at once. On an envelope that is out for signature it goes through the
// correction (correctEnvelope), with the same sign-again choice: someone who finished is only asked to sign again
// when the sender says so ("resign": true). With "save": false only the new file is made, and nothing on the envelope
// changes: the editor uses that, moves its own fields (src/lib/pages.ts) and saves the envelope the way it always does.
import { route } from './router.ts';
import { bad } from './util.ts';
import { pagesWaitCheck, pagesCount } from './pagelimit.ts';
import { loadEnvelope, publicEnvelope, saveDraft, correctEnvelope } from './envelopes.ts';
import { mine, assertMayChange } from './routes-envelopes.ts';
import { assertWordingKept, wordingLock, fileHeldBack } from './tplroles.ts';
import { assertNotHeld } from './records.ts';
import { remakeFile } from './pages.ts';
import { moveFields, fieldWords, planPages } from '../lib/pages.ts';
import { yesNo } from './envelopes.ts';

const STATUS_WORDS: Record<string, string> = { completed: 'completed', declined: 'declined', voided: 'cancelled', expired: 'expired' };

route('POST', '/envelopes/:id/documents/:doc/pages', async (c) => {
  const b = (await c.body()) || {};
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  const out = e.kind === 'envelope' && e.status === 'sent';
  if (e.status !== 'draft' && !out)
    throw bad(`This document is ${STATUS_WORDS[e.status] || e.status}, so its pages can no longer be changed. Copy it to send a new version.`, 409);
  const doc = e.documents.find((d: any) => d.id === c.params.doc);
  if (!doc) throw bad('That document is not in this envelope. Use the id of one of its documents (GET /envelopes/:id).', 404);
  // Started from a template whose wording is locked for this person: its documents stay as they are (tplroles.ts).
  if (wordingLock(c, e)) assertWordingKept(c, e, { documents: e.documents.map((d: any) => ({ id: d.id, name: d.name, file_id: d.id === doc.id ? '' : d.file_id })) });
  if (e.kind === 'envelope' && e.status === 'draft') assertNotHeld([e.id], c.actor.name, 'change its pages');
  const save = yesNo(b.save, true, '"save"');
  const dropFields = yesNo(b.drop_fields, false, '"drop_fields"');
  // Every request that stores a new file is counted, 120 an hour for an account. A request refused for a mistake in
  // it stores nothing and is not counted (src/server/pagelimit.ts).
  pagesWaitCheck(c.account.id);

  // The fields on pages that would go: refused with their list, unless the caller says they go too. Checked before
  // the file is made, from the operations alone.
  const planned = planPages(doc.pages, b.ops);
  if (save && !('error' in planned)) {
    const { dropped } = moveFields(e.fields, doc.id, planned.plan);
    if (dropped.length && !dropFields) {
      const owner = (f: any) => e.recipients.find((r: any) => r.id === f.recipient_id)?.name || null;
      const list = dropped.map((f: any) => fieldWords(f, owner(f)));
      throw bad(`The page${new Set(dropped.map((f: any) => f.page)).size === 1 ? ' you are removing has' : 's you are removing have'} ${dropped.length === 1 ? 'a field' : `${dropped.length} fields`}: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ` and ${list.length - 12} more` : ''}. Nothing was changed. To remove ${dropped.length === 1 ? 'it' : 'them'} with the page, send the same request with "drop_fields": true, or move ${dropped.length === 1 ? 'it' : 'them'} to another page first.`,
        409, { code: 'page_fields', fields: dropped.map((f: any) => ({ id: f.id, type: f.type, label: f.label || null, page: f.page, recipient: owner(f) })) });
    }
  }

  // The editor keeps its changes until it saves, so it may change the pages of a file it has and has not saved yet
  // ("file_id"): one it made a moment ago, or one it just uploaded with Replace. A file of a template that is not for
  // this person is never taken (tplroles.ts), and a file of another account is not found (remakeFile).
  const from = !save && b.file_id != null ? String(b.file_id) : doc.file_id;
  // A file other than the document's own is checked every time, also one made from it: a template's owner may have
  // changed its pages since, and that copy is held back from this person like the template.
  if (from !== doc.file_id && fileHeldBack(c, from)) throw bad('That file is not one you can use here. Upload it again and change its pages then.', 404);
  pagesCount(c.account.id, from, b.ops);
  const made = await remakeFile(c.account.id, from, b.ops);
  if (!save) return { file: made.file, plan: made.plan, said: made.said };

  // Read again: making the file took a moment, and the envelope is saved from what it is now.
  const fresh = loadEnvelope(e.id);
  const now = fresh.documents.find((d: any) => d.id === doc.id);
  if (!now || now.file_id !== doc.file_id || fresh.status !== e.status) throw bad('This document changed while its pages were being changed, so nothing was saved. Load it again and make the change again.', 409);
  const { fields } = moveFields(fresh.fields, doc.id, made.plan, now.page_sizes);
  const body = {
    documents: fresh.documents.map((d: any) => ({ id: d.id, name: d.name, file_id: d.id === doc.id ? made.file.id : d.file_id })),
    fields,
    ...(b.edit_version != null ? { edit_version: b.edit_version } : {}),
    ...(out && b.resign === true ? { resign: true } : {}),
  };
  if (out) await correctEnvelope(fresh, body, c.account.id, c.actor);
  else saveDraft(fresh, body, c.account.id, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(e.id)), file: made.file, said: made.said, removed_fields: moveFields(fresh.fields, doc.id, made.plan).dropped.length };
});
