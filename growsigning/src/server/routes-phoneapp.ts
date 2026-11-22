// GrowSigning saved to a phone's home screen (src/lib/phoneapp.ts). Two routes:
//  - POST /share-target: a PDF or photos shared into GrowSigning from another app on Android become a new draft,
//    and the browser is sent on to its editor. Only for a person signed in on that phone. The page that Android
//    opens is src/app/share-target/route.ts, which hands the request to this route.
//  - POST /files/:id/undo-cleanup: a document made from photos that the browser cleaned is made again from the
//    photos the browser sent before cleaning them (scanphotos.ts). Asked again, it gives the same new file back.
import { route, type Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, HttpError } from './util.ts';
import { storeUpload, mine } from './routes-envelopes.ts';
import { createEnvelope, loadEnvelope, saveDraft } from './envelopes.ts';
import { scanPhotosOf } from './scanphotos.ts';
import { SHARE_FIELD, MAX_SHARED_DOCUMENTS, SHARE_FROM_ELSEWHERE } from '../lib/phoneapp.ts';
import { MAX_PHOTOS_PER_DOCUMENT } from '../lib/policy.ts';

const isPictureName = (f: File) => /^image\/(png|jpe?g)$/i.test(f.type) || /\.(png|jpe?g)$/i.test(f.name);

/** The same upload as POST /files, made from the parts given, so every check of an upload applies to each one. */
function uploadOf(c: Ctx, parts: { name: string; data: Blob }[]) {
  const form = new FormData();
  for (const p of parts) form.append('file', p.data, p.name);
  return storeUpload({ ...c, req: new Request(c.url, { method: 'POST', body: form }) }, c.account.id);
}

route('POST', '/share-target', async (c) => {
  // A share comes from the phone itself (Sec-Fetch-Site "none") or from our own pages. Another website posting a
  // file here in the person's name is refused, whether or not the browser sent the cookie.
  const site = (c.req.headers.get('sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') throw new HttpError(403, SHARE_FROM_ELSEWHERE);
  const form = await c.req.formData().catch(() => null);
  const files = (form?.getAll(SHARE_FIELD) || []).filter((f): f is File => typeof f !== 'string' && f.size > 0);
  if (!files.length) throw bad('Nothing that GrowSigning can use was shared. Share a PDF, PNG or JPEG file.');
  // Pictures shared together are most often the pages of one paper document: one document, a page each, in the
  // order they came. Every other file is a document of its own. The editor can split, remove or reorder them.
  const pictures = files.filter(isPictureName);
  const others = files.filter((f) => !isPictureName(f));
  const groups: File[][] = [...others.map((f) => [f]), ...(pictures.length ? [pictures] : [])];
  if (groups.length > MAX_SHARED_DOCUMENTS) throw bad(`Up to ${MAX_SHARED_DOCUMENTS} files can be shared at once, and this share has ${groups.length}. Share fewer at a time.`);
  if (pictures.length > MAX_PHOTOS_PER_DOCUMENT) throw bad(`Up to ${MAX_PHOTOS_PER_DOCUMENT} photos can be shared at once, and this share has ${pictures.length}. Share fewer at a time.`);
  const made: any[] = [];
  for (const g of groups) {
    try {
      made.push(await uploadOf(c, g.map((f) => ({ name: f.name || 'Shared file', data: f }))));
    } catch (e: any) {
      if (!(e instanceof HttpError)) throw e;
      const what = g.length > 1 ? 'The shared photos' : `"${(g[0].name || 'The shared file').slice(0, 100)}"`;
      throw new HttpError(e.status, `${what} could not be added. ${e.message}`);
    }
  }
  const first = made[0].name;
  const eid = createEnvelope(c.account, c.user.id, 'envelope', { subject: `Please sign: ${first}`.slice(0, 200) });
  saveDraft(loadEnvelope(eid), { documents: made.map((f) => ({ file_id: f.id, name: f.name })) }, c.account.id);
  // 303: the browser opens the editor with GET, so going back does not share the file a second time.
  return new Response(null, { status: 303, headers: { location: `/app/envelopes/${eid}/edit`, 'cache-control': 'no-store' } });
});

route('POST', '/files/:id/undo-cleanup', async (c) => {
  const f = get('SELECT id, name, pages, page_ops, undone_to FROM files WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!f) throw bad('File not found.', 404);
  // A file in a document is undone by someone who may open that document, and only while it is a draft.
  for (const d of all('SELECT DISTINCT envelope_id FROM documents WHERE file_id=?', f.id)) {
    const e = mine(c, d.envelope_id);
    if (e.status !== 'draft') throw bad('This document has been sent, so its pages can no longer be changed. Correct the envelope to replace the file.', 409);
  }
  // Undone before: the same file again, so pressing it twice (or a script calling it in a loop) makes no more files.
  const before = (() => { try { return f.undone_to ? JSON.parse(f.undone_to) : null; } catch { return null; } })();
  if (before?.id && get('SELECT 1 x FROM files WHERE id=? AND account_id=?', before.id, c.account.id)) return { file: { ...before, name: f.name } };
  const photos = f.page_ops ? null : scanPhotosOf(f.id, f.pages);
  if (!photos) throw bad('The photos this document was made from are not kept with it any more, so the cleanup cannot be undone here. Use Replace file with your photo instead.', 409);
  const made = await uploadOf(c, photos.map((p, i) => ({ name: p.name || `${f.name} page ${i + 1}.jpg`, data: new Blob([new Uint8Array(p.data)]) })));
  run('UPDATE files SET undone_to=? WHERE id=?', JSON.stringify(made), f.id);
  return { file: { ...made, name: f.name } };
});
