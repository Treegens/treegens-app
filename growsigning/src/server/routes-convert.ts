// The original of a file that was turned into a PDF, for the account that uploaded it (src/server/converted.ts keeps
// it). The sender can get it back from a draft or a template too, not only from the evidence pack of a sent envelope.
// It answers exactly who GET /files/:id/content answers, and is always a download, never shown in the browser: an
// original can be a web page.
import { route } from './router.ts';
import { all, get, readBlob } from './db.ts';
import { bad } from './util.ts';
import { fileHeldBack } from './tplroles.ts';
import { mine } from './routes-envelopes.ts';
import { convertedOf } from '../lib/convert.ts';

route('GET', '/files/:id/original', (c) => {
  const f = get('SELECT * FROM files WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!f) throw bad('File not found.', 404);
  const opens = (eid: string) => { try { return !!mine(c, eid); } catch { return false; } };
  if (fileHeldBack(c, f.id) && !all('SELECT DISTINCT envelope_id FROM documents WHERE file_id=?', f.id).some((d) => opens(d.envelope_id))) throw bad('File not found.', 404);
  const kept = convertedOf(f.converted);
  if (!kept || !f.original_sha256) throw bad('This file was uploaded as a PDF or a picture, so there is no other original. Download the file itself instead.', 404, { code: 'no_original' });
  let data: Uint8Array;
  try {
    data = readBlob(f.original_sha256);
  } catch {
    throw bad('The original of this file could not be read from storage. The PDF made from it is still there.', 404, { code: 'original_missing' });
  }
  const name = kept.from.replace(/[^\w .-]+/g, '_').slice(0, 100) || 'original';
  return new Response(Buffer.from(data), {
    headers: { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${name}"`, 'content-security-policy': "default-src 'none'; sandbox" },
  });
});
