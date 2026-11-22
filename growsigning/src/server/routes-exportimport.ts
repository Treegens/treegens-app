// The routes of the full export and of bringing documents in (exportfull.ts, importer.ts, importer-docusign.ts).
// All are for owners and admins (an admin key too), apart from the published schema, which anyone may read.
import { route, json } from './router.ts';
import { bad, rateLimit, HttpError } from './util.ts';
import { exportSchema } from './jsonschema.ts';
import { fullExport, startExportJob, listJobs, downloadJob } from './exportfull.ts';
import { uploadedFiles, unzip, importExport, listImported, countImported, oneImported, importedFile, deleteImported, looksLikeZip } from './importer.ts';
import { importDocusign } from './importer-docusign.ts';
import { IMPORTS_PER_HOUR, EXPORTS_DIRECT_PER_HOUR } from '../lib/exportfull.ts';

route('GET', '/public/export-schema/v1', () => json(exportSchema(), 200, { 'cache-control': 'public, max-age=3600' }), 'public');

// Each direct export builds every record for disputes again, so an account can ask for one only so often. A large
// account, or ?background=1, makes one in the background instead, one at a time.
route('GET', '/export/full', (c) => {
  try {
    rateLimit(`export-full:${c.account.id}`, EXPORTS_DIRECT_PER_HOUR, 3600_000);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) throw bad(`This account has made ${EXPORTS_DIRECT_PER_HOUR} full exports in the last hour, the most at once. Nothing was changed. Try again in an hour, or press Export everything under Settings, Records and data: it makes one in the background and emails you when it is ready.`, 429);
    throw err;
  }
  return fullExport(c);
}, 'admin');
route('POST', '/export/full/jobs', (c) => ({ job: startExportJob(c.account, c.user) }), 'admin');
route('GET', '/export/full/jobs', (c) => ({ jobs: listJobs(c.account.id) }), 'admin');
route('GET', '/export/full/jobs/:id/download', (c) => downloadJob(c), 'admin');

// Nothing new starts in an account that is closing (routes-trust.ts), and that includes bringing things in.
const assertOpen = (c: any) => {
  if (c.account.closing_at) throw bad('This account is closing, so nothing new can be brought into it. Sign in again to keep the account, then bring the documents in.', 409);
  rateLimit(`import:${c.account.id}`, IMPORTS_PER_HOUR, 3600_000);
};

route('POST', '/import/full', async (c) => {
  assertOpen(c);
  const files = await uploadedFiles(c.req);
  if (files.length !== 1 || !looksLikeZip(files[0].data)) throw bad('Choose the one ZIP file that Export everything made on the other server. Nothing was brought in.');
  return importExport(c, unzip(files[0].data));
}, 'admin');

route('POST', '/import/docusign', async (c) => {
  assertOpen(c);
  return importDocusign(c, await uploadedFiles(c.req));
}, 'admin');

route('GET', '/imported', (c) => ({ records: listImported(c.account.id) }), 'admin');
// Only how many, for the Documents list: its link to them appears once there are any.
route('GET', '/imported/count', (c) => ({ count: countImported(c.account.id) }), 'admin');
route('GET', '/imported/:id', (c) => ({ record: oneImported(c.account.id, c.params.id) }), 'admin');
route('GET', '/imported/:id/files/:sha256', (c) => {
  const f = importedFile(c.account.id, c.params.id, c.params.sha256);
  const type = /\.zip$/i.test(f.name) ? 'application/zip' : 'application/pdf';
  return new Response(new Uint8Array(f.data), { headers: { 'content-type': type, 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${f.name.replace(/[^\w .()-]+/g, '_').slice(0, 120) || 'file'}"` } });
}, 'admin');
route('DELETE', '/imported/:id', (c) => deleteImported(c.account.id, c.params.id), 'admin');
