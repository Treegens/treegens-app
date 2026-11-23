// The full export: everything an account holds, in open formats, in one ZIP (research/government.json, G19). No
// lock-in: the data is JSON written to a published schema (docs/schema/growsigning-export-v1.schema.json), every
// file is in it by its SHA-256, and a manifest lists the SHA-256 of every entry. Free, for owners and admins (and an
// admin key), also while the account is closing, paused or unpaid, like the export under Settings (routes-trust.ts).
// A large account is exported in the background: the admin is emailed when it is ready, the link works 7 days.
// The import of such a file into another server is importer.ts; DocuSign's downloads are importer-docusign.ts.
import { ownLoginFile } from './signuprules.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { all, get, run, readBlob, dataDir } from './db.ts';
import { HttpError, bad, id, now, sha256, baseUrl } from './util.ts';
import { zipStream, ZIP_MAX_BYTES, ZIP_MAX_FILES, type ZipEntry } from './zip.ts';
import { loadEnvelope, verifyChain } from './envelopes.ts';
import { customView } from './customfields.ts';
import { threadsOf } from './comments.ts';
import { evidencePack, HASH_HOW } from './evidence.ts';
import { checkSchema, exportSchema } from './jsonschema.ts';
import { sendMail } from './mail.ts';
import { deliver } from './webhooks.ts';
import { record } from './seclog.ts';
import { importedExport } from './importer.ts';
import { EXPORT_SCHEMA_VERSION, EXPORT_SCHEMA_PATH, EXPORT_LINK_DAYS, EXPORT_DIRECT_MAX_ENVELOPES, EXPORT_DIRECT_MAX_BYTES, CHAIN_MEANS } from '../lib/exportfull.ts';
import { dayText } from '../lib/dates.ts';

/** The account's settings that go into an export. Nothing about payments, and nothing secret. */
export const SETTINGS_OUT = ['brand_color', 'brand_logo', 'default_reminder_days', 'default_expire_days', 'default_date_format', 'default_locale', 'two_step_required_at', 'security_alerts_off',
  'security_log_emails', 'retention_days', 'retention_level', 'retention_name', 'retention_code', 'retention_stopped_days', 'cert_impact_off', 'impact_display', 'ai_helper', 'white_label',
  'disclosure_now', 'disclosure_each_visit', 'min_password_length', 'idle_minutes', 'one_session', 'list_days', 'pdfa_on'];
/** What is kept of a recipient. No signing link, security code, access code, signature picture or device fingerprint. */
const RECIPIENT_OUT = ['id', 'role', 'role_name', 'name', 'email', 'routing_order', 'position', 'status', 'sent_at', 'viewed_at', 'consent_at', 'completed_at', 'decline_reason', 'ip', 'user_agent',
  'reassigned_from', 'locale', 'tz', 'group_name', 'witness_for', 'signed_before'];
const FIELD_OUT = ['id', 'document_id', 'recipient_id', 'type', 'page', 'x', 'y', 'w', 'h', 'required', 'label', 'value', 'prefill', 'options', 'group_name', 'validation', 'readonly', 'show_when', 'formula', 'checks', 'calc_num'];

const pick = (row: any, keys: string[]) => Object.fromEntries(keys.filter((k) => row && k in row).map((k) => [k, row[k]]));

type FileNote = { sha256: string; kind: string; name: string; size: number };

/** The account as data (data.json without its "files"), and every file it names. */
export function exportData(account: any, by: { name: string; email: string }) {
  const files = new Map<string, FileNote>();
  const note = (sha: string | null | undefined, kind: string, name: string, size = 0) => {
    if (sha && /^[0-9a-f]{64}$/.test(sha) && !files.has(sha)) files.set(sha, { sha256: sha, kind, name, size });
  };
  const fileOf = (fileId: string) => get('SELECT sha256, size, pages, name, original_sha256 FROM files WHERE id=?', fileId);
  const docs = (e: any) => e.documents.map((d: any) => {
    const f = fileOf(d.file_id);
    note(f?.sha256, 'document', d.name, f?.size);
    note(f?.original_sha256, 'original', `${d.name} (as uploaded)`);
    return { id: d.id, name: d.name, position: d.position, file_sha256: f?.sha256 || null, pages: f?.pages ?? 0, ...(f?.original_sha256 ? { original_sha256: f.original_sha256 } : {}) };
  });
  const fieldsOf = (e: any) => e.fields.map((f: any) => pick(f, FIELD_OUT));
  const userEmail = (uid: string) => get('SELECT name, email FROM users WHERE id=?', uid);

  const settings = pick(account, SETTINGS_OUT);
  const members = all('SELECT u.id user_id, u.name, u.email, m.role, m.created_at joined_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', account.id);

  const templates = all("SELECT id FROM envelopes WHERE account_id=? AND kind='template' ORDER BY created_at", account.id).map(({ id: tid }) => {
    const t = loadEnvelope(tid);
    const chosen = all('SELECT u.email FROM template_members tm JOIN users u ON u.id=tm.user_id WHERE tm.template_id=?', tid).map((r) => r.email);
    return {
      id: t.id, subject: t.subject, message: t.message, folder: t.folder, ordered: !!t.ordered, reminder_days: t.reminder_days, expire_days: t.expire_days, date_format: t.date_format,
      owner_email: userEmail(t.sender_id)?.email || null, created_at: t.created_at, updated_at: t.updated_at,
      rules: { use: t.tpl_use || 'team', change: t.tpl_change || 'owner', locked: !!t.tpl_locked, chosen },
      documents: docs(t), recipients: t.recipients.map((r: any) => pick(r, ['id', 'role', 'role_name', 'name', 'email', 'routing_order', 'note'])), fields: fieldsOf(t),
      custom_fields: customView(t).custom_fields,
    };
  });

  const envelopes = all("SELECT id FROM envelopes WHERE account_id=? AND kind='envelope' ORDER BY created_at", account.id).map(({ id: eid }) => {
    const e = loadEnvelope(eid);
    const chain = verifyChain(eid);
    note(e.final_sha256, 'signed', `${e.subject || 'Untitled'} (signed)`, e.final_size || 0);
    return {
      id: e.id, subject: e.subject, message: e.message, status: e.status, folder: e.folder, sender: userEmail(e.sender_id) || { name: '', email: '' },
      created_at: e.created_at, sent_at: e.sent_at, completed_at: e.completed_at, void_reason: e.void_reason, expires_at: e.expires_at, template_id: e.template_id,
      removed_by_sender_at: e.hidden_at || null, purged_at: e.purged_at || null, purged_sha256: e.purged_sha256 || null, disputed_at: e.disputed_at || null,
      signed_pdf: e.final_sha256 ? { sha256: e.final_sha256, size: e.final_size ?? null, in_export: true, pdfa: e.pdfa || null, seal: e.seal_level || null } : null,
      documents: e.purged_at ? [] : docs(e),
      recipients: e.recipients.map((r: any) => pick(r, RECIPIENT_OUT)),
      fields: e.purged_at ? [] : fieldsOf(e),
      audit: { how: HASH_HOW, chain: { ok: chain.ok, events: chain.events, head: chain.head }, events: all('SELECT seq, at, actor, action, detail, ip, prev_hash, hash, redacted_at FROM audit WHERE envelope_id=? ORDER BY seq', eid) },
      comments: threadsOf(e, { side: 'sender' }),
      custom_fields: customView(e).custom_fields,
      evidence_pack: null as string | null,
    };
  });

  const contacts = all('SELECT id, name, email, company, created_at FROM contacts WHERE account_id=? ORDER BY created_at', account.id);
  const signing_groups = all('SELECT id, name, created_at FROM signing_groups WHERE account_id=? ORDER BY name', account.id)
    .map((g) => ({ ...g, members: all('SELECT name, email FROM signing_group_members WHERE group_id=? ORDER BY position', g.id) }));
  const folders = all("SELECT DISTINCT folder FROM envelopes WHERE account_id=? AND folder IS NOT NULL AND folder != '' ORDER BY folder", account.id).map((r) => r.folder);
  const webhooks = all('SELECT id, url, events, active, created_at FROM webhooks WHERE account_id=? ORDER BY created_at', account.id)
    .map((h) => ({ ...h, events: String(h.events || '*').split(','), active: !!h.active }));
  const clickwraps = all('SELECT id, slug, name, active, created_at FROM clickwraps WHERE account_id=? ORDER BY created_at', account.id).map((cw) => ({
    ...cw, active: !!cw.active,
    versions: all('SELECT number, title, format, body, file_sha256, terms_sha256, checkbox, button, published_at FROM clickwrap_versions WHERE clickwrap_id=? ORDER BY number', cw.id)
      .map((v) => (note(v.file_sha256, 'terms', `${cw.name} version ${v.number}`), v)),
    acceptances: all('SELECT version, terms_sha256, identity, name, email, via, page_url, ip, ua, at FROM clickwrap_acceptances WHERE clickwrap_id=? ORDER BY at', cw.id),
  }));
  const holds = all('SELECT id, envelope_id, folder, reason, matter, set_by, set_at, lifted_at, lifted_by, lift_reason FROM legal_holds WHERE account_id=? ORDER BY set_at', account.id);
  const retention = {
    schedule: account.retention_days ? { days: account.retention_days, level: account.retention_level || null, name: account.retention_name || null, code: account.retention_code || null, stopped_days: account.retention_stopped_days ?? null } : null,
    holds,
  };
  const imported = importedExport(account.id);
  for (const r of imported) for (const f of r.files) note(f.sha256, 'imported', f.name);

  const data = {
    schema: 'growsigning-export', schema_version: EXPORT_SCHEMA_VERSION, made_at: now(),
    // Only who made it: the login row itself holds the password hash and the two-step secret.
    made_by: { name: by.name, email: by.email },
    deployment: { url: baseUrl(), software: 'GrowSigning' },
    account: { id: account.id, name: account.name, plan: account.plan || null, created_at: account.created_at, settings },
    members, templates, contacts, signing_groups, folders, webhooks, clickwraps, retention, envelopes, imported,
    files: [] as { sha256: string; size: number; path: string; kind: string; name: string }[],
    not_included: [] as string[],
  };
  return { data, files };
}

/** How big an export of this account would be, to decide between straight away and in the background. */
export function exportSize(accountId: string): { envelopes: number; bytes: number } {
  const env = get("SELECT COUNT(*) n, COALESCE(SUM(final_size),0) b FROM envelopes WHERE account_id=? AND kind='envelope'", accountId);
  const fil = get('SELECT COALESCE(SUM(size),0) b FROM files WHERE account_id=?', accountId);
  return { envelopes: env.n, bytes: env.b + fil.b };
}

const README = (data: any, left: string[], evidence: number) => [
  `GrowSigning full export of "${data.account.name}", made ${data.made_at} on ${data.deployment.url}.`, '',
  'data.json               everything in the account as data: settings, members and roles, templates with their fields and rules, contacts,',
  '                        signing groups, folders, webhooks (without their secrets), click-to-agree terms and acceptances, the deletion',
  '                        schedule and legal holds, every envelope with its people, fields and values, audit trail and comments, and what',
  '                        the account brought in from elsewhere. No passwords, signing links, security codes, access codes or keys.',
  `schema/                the JSON Schema data.json is written to (version ${EXPORT_SCHEMA_VERSION}, JSON Schema 2020-12). Also at ${data.deployment.url}${EXPORT_SCHEMA_PATH}`,
  'files/<sha256>          every document, signed PDF, original upload and terms file, each named by the SHA-256 of its bytes. data.json says which is which.',
  ...(evidence ? ['evidence/<id>.zip       the evidence pack of each envelope that was sent, as "Download evidence pack" gives it.'] : []),
  'your-login.json         your own login: name, email address and the phone number you gave. Nobody else\'s phone number is in this export.',
  'manifest-sha256.txt     the SHA-256 of every other file in this ZIP, one per line, in the form sha256sum -c reads.', '',
  'Signed PDFs are as they were stored: PDF/A where the account had that switched on and the check passed, and with a digital seal where the',
  'server had one (signed_pdf.pdfa and signed_pdf.seal in data.json say which). Signature pictures are printed in the signed PDFs and are not',
  'repeated in data.json.', '',
  `Each audit trail carries its chain: ${HASH_HOW}`,
  CHAIN_MEANS, '',
  'To move this account to another GrowSigning server, sign in there as an owner or admin and use Settings, Records and data, Bring in documents.',
  'Envelopes that were still out for signature are not brought in there: they finish here, where they were sent.',
  ...(left.length ? ['', 'Not in this export:', ...left.map((l) => `  ${l}`)] : []),
].join('\r\n');

/** The entries of the ZIP, one at a time. `stats` is filled in as it goes. */
export async function* exportEntries(account: any, by: { id?: string; name: string; email: string }, stats: { envelopes: number; bytes: number; problems: string[] } = { envelopes: 0, bytes: 0, problems: [] }): AsyncGenerator<ZipEntry> {
  const { data, files } = exportData(account, by);
  const sums: string[] = [];
  let bytes = 0, count = 0;
  const add = (name: string, buf: Uint8Array): ZipEntry => {
    sums.push(`${sha256(buf)}  ${name}`);
    bytes += buf.length;
    count++;
    return { name, data: buf };
  };
  const left = data.not_included;
  for (const f of files.values()) {
    if (count >= ZIP_MAX_FILES - 10 || bytes + f.size > ZIP_MAX_BYTES) {
      left.push(`${f.name}: it did not fit in one ZIP file (about 4 GB or 60,000 files at most). Its SHA-256 is ${f.sha256}. Export the rest under Settings, Records and data, selecting fewer documents.`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = readBlob(f.sha256);
    } catch (err) {
      if (!(err instanceof HttpError) && !(err as any)?.code) throw err;
      left.push((err as any)?.data?.code === 'file_locked' ? `${f.name}: it is locked with an encryption key this server was not given. It is not damaged and nothing about it was changed. Export again once that key is set. SHA-256 ${f.sha256}.`
        : `${f.name}: its stored copy could not be read or failed its check, so nothing damaged was put in. The people who run this server can put it back from a backup. SHA-256 ${f.sha256}.`);
      continue;
    }
    data.files.push({ sha256: f.sha256, size: buf.length, path: `files/${f.sha256}`, kind: f.kind, name: f.name });
    yield add(`files/${f.sha256}`, buf);
  }
  const inZip = new Set(data.files.map((f) => f.sha256));
  for (const e of data.envelopes) if (e.signed_pdf) e.signed_pdf.in_export = inZip.has(e.signed_pdf.sha256);
  // The evidence pack of every envelope that went out, as the envelope page gives it (evidence.ts).
  let packs = 0;
  for (const e of data.envelopes) {
    if (e.status === 'draft' || e.purged_at || count >= ZIP_MAX_FILES - 10) continue;
    try {
      const { entries } = await evidencePack(loadEnvelope(e.id), `${by.name} <${by.email}>, as part of a full export`);
      const chunks: Uint8Array[] = [];
      const reader = zipStream(entries).getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
      const buf = Buffer.concat(chunks);
      if (bytes + buf.length > ZIP_MAX_BYTES) throw new Error('too large');
      e.evidence_pack = `evidence/${e.id}.zip`;
      packs++;
      yield add(e.evidence_pack, buf);
    } catch {
      left.push(`The evidence pack of "${e.subject || 'Untitled'}" (${e.id}) could not be made into this export. Download it from the envelope's page.`);
    }
  }
  stats.envelopes = data.envelopes.length;
  // Checked against the published schema before it is written. A problem is said in the README, never hidden.
  const problems = checkSchema(exportSchema(), data);
  stats.problems = problems;
  if (problems.length) left.push(`data.json does not fully match its schema (this is a fault in this server, please tell its operators): ${problems.join('; ')}`);
  yield add('data.json', Buffer.from(JSON.stringify(data, null, 2)));
  yield add('schema/growsigning-export-v1.schema.json', Buffer.from(JSON.stringify(exportSchema(), null, 2)));
  // The login of whoever made the export, with its phone number. Nobody else's number is in an export (signuprules.ts).
  if (by.id) yield add('your-login.json', ownLoginFile(by.id));
  yield add('README.txt', Buffer.from(README(data, left, packs)));
  stats.bytes = bytes;
  yield { name: 'manifest-sha256.txt', data: Buffer.from(sums.join('\n') + '\n') };
}

const fileName = () => `growsigning-full-export-${now().slice(0, 10)}.zip`;

// ---- In the background, for a large account -------------------------------------------------------------------

const exportsDir = () => path.join(dataDir(), 'exports');
const jobFile = (jobId: string) => path.join(exportsDir(), `${jobId.replace(/[^\w-]/g, '')}.zip`);
const g = globalThis as any;
const running: Map<string, Promise<void>> = (g.__tsFullExports ??= new Map());
/** Resolves when the export `jobId` has finished one way or the other (for tests and for the timer). */
export const exportDone = (jobId: string) => running.get(jobId) || Promise.resolve();

export function jobView(j: any) {
  return { id: j.id, status: j.status, created_at: j.created_at, ready_at: j.ready_at, expires_at: j.expires_at, bytes: j.bytes, envelopes: j.envelopes, error: j.error,
    download_url: j.status === 'ready' ? `/api/export/full/jobs/${j.id}/download` : null };
}

export function startExportJob(account: any, user: { id: string; name: string; email: string }): any {
  // One at a time per account: a second press while one is being made gets that one.
  const busy = get("SELECT * FROM full_exports WHERE account_id=? AND status='making'", account.id);
  if (busy && running.has(busy.id)) return jobView(busy);
  if (busy) run("UPDATE full_exports SET status='failed', error=? WHERE id=?", 'The server restarted while it was being made. Press Export everything again.', busy.id);
  const jid = id('exp');
  run("INSERT INTO full_exports (id, account_id, user_id, status, created_at) VALUES (?,?,?,'making',?)", jid, account.id, user.id, now());
  running.set(jid, makeJob(jid, account, user).finally(() => running.delete(jid)));
  return jobView(get('SELECT * FROM full_exports WHERE id=?', jid));
}

async function makeJob(jid: string, account: any, user: { id: string; name: string; email: string }) {
  fs.mkdirSync(exportsDir(), { recursive: true });
  const file = jobFile(jid);
  const stats = { envelopes: 0, bytes: 0, problems: [] as string[] };
  const where = `${baseUrl()}/app/settings?tab=data#export`;
  try {
    const out = fs.createWriteStream(`${file}.part`, { mode: 0o600 });
    const reader = zipStream(exportEntries(account, user, stats)).getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) if (!out.write(r.value)) await new Promise((ok) => out.once('drain', ok));
    await new Promise<void>((ok, no) => out.end((err?: any) => (err ? no(err) : ok())));
    fs.renameSync(`${file}.part`, file);
    const at = now();
    const expires = new Date(Date.now() + EXPORT_LINK_DAYS * 864e5).toISOString();
    run("UPDATE full_exports SET status='ready', ready_at=?, expires_at=?, bytes=?, envelopes=? WHERE id=?", at, expires, fs.statSync(file).size, stats.envelopes, jid);
    await sendMail({ to: user.email, subject: 'Your GrowSigning export is ready', heading: 'Your export is ready',
      lines: [`The full export of "${account.name}" is ready: ${stats.envelopes} document${stats.envelopes === 1 ? '' : 's'} and everything else in the account, in one ZIP file.`,
        `Download it from Settings, Records and data, signed in as an owner or admin of the account. It can be downloaded until ${dayText(expires)}, then it is deleted from the server. You can make a new one at any time.`,
        'The link below opens that page. It is not the file itself, so a forwarded copy of this email gives nobody your documents.'],
      cta: { label: 'Open Records and data', url: where }, brief: true }).catch(() => {});
    exportReadyHook(account.id, jid, expires, stats.envelopes);
  } catch (err: any) {
    fs.rmSync(`${file}.part`, { force: true });
    console.error('[export] full export failed', jid, err);
    run("UPDATE full_exports SET status='failed', error=? WHERE id=?", 'Something went wrong on the server while the export was being made. Nothing was changed in the account. Press Export everything again; if it fails again, tell the people who run this server.', jid);
    await sendMail({ to: user.email, subject: 'Your GrowSigning export could not be made', heading: 'The export did not work',
      lines: [`The full export of "${account.name}" could not be made, because something went wrong on the server. Nothing in the account was changed.`, 'Press Export everything again under Settings, Records and data. If it fails again, tell the people who run this server.'],
      cta: { label: 'Open Records and data', url: where }, brief: true }).catch(() => {});
  }
}

/** The 'export.ready' webhook, for webhooks that list it or listen to everything ("*"). */
function exportReadyHook(accountId: string, jobId: string, expires: string, envelopes: number) {
  const hooks = all('SELECT * FROM webhooks WHERE account_id=? AND active=1', accountId).filter((h) => h.events === '*' || String(h.events).split(',').includes('export.ready'));
  const body = JSON.stringify({ id: id('evt'), event: 'export.ready', created_at: now(), export: { id: jobId, envelopes, expires_at: expires, download_url: `${baseUrl()}/api/export/full/jobs/${jobId}/download` }, text: 'A full export is ready to download.' });
  for (const h of hooks) void deliver(h, 'export.ready', null, body).catch(() => {});
}

/** The timer: exports past their 7 days are deleted from the disk, with any file no job row points at. */
export function forgetOldExports(): number {
  let n = 0;
  for (const j of all("SELECT id FROM full_exports WHERE status='ready' AND expires_at < ?", now())) {
    fs.rmSync(jobFile(j.id), { force: true });
    run("UPDATE full_exports SET status='expired' WHERE id=?", j.id);
    n++;
  }
  run("DELETE FROM full_exports WHERE status IN ('expired','failed') AND created_at < ?", new Date(Date.now() - 90 * 864e5).toISOString());
  if (fs.existsSync(exportsDir())) {
    for (const f of fs.readdirSync(exportsDir())) {
      const jid = f.replace(/\.zip(\.part)?$/, '');
      const row = get('SELECT status FROM full_exports WHERE id=?', jid);
      if (!row || (row.status !== 'ready' && !(row.status === 'making' && running.has(jid)))) fs.rmSync(path.join(exportsDir(), f), { force: true });
    }
  }
  return n;
}

// ---- Answers -----------------------------------------------------------------------------------------------

/** GET /export/full: straight away for a small account, else (or with ?background=1) a job and an email. */
export async function fullExport(c: any): Promise<Response | any> {
  const size = exportSize(c.account.id);
  const later = c.q.get('background') === '1' || size.envelopes > EXPORT_DIRECT_MAX_ENVELOPES || size.bytes > EXPORT_DIRECT_MAX_BYTES;
  record('export.made', { c, details: { everything: true, whose: 'account', envelopes: size.envelopes, full: true } });
  if (later) {
    const job = startExportJob(c.account, c.user);
    return new Response(JSON.stringify({ background: true, job, message: `The export is being made. We email ${c.user.email} when it is ready, and it can then be downloaded from Settings, Records and data for ${EXPORT_LINK_DAYS} days.` }), { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response(zipStream(exportEntries(c.account, c.user)), { headers: { 'content-type': 'application/zip', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${fileName()}"` } });
}

export function downloadJob(c: any): Response {
  const j = get('SELECT * FROM full_exports WHERE id=? AND account_id=?', String(c.params.id), c.account.id);
  if (!j) throw bad('We could not find that export. It may be from another account, or older than 90 days. Make a new one under Settings, Records and data.', 404);
  if (j.status === 'making') throw bad('That export is still being made. We email you when it is ready.', 409);
  if (j.status === 'failed') throw bad(j.error || 'That export could not be made. Make a new one under Settings, Records and data.', 410);
  if (j.status !== 'ready' || !fs.existsSync(jobFile(j.id))) throw bad(`That export was deleted from the server ${EXPORT_LINK_DAYS} days after it was made. Make a new one under Settings, Records and data: it is free.`, 410);
  run('UPDATE full_exports SET downloaded_at=? WHERE id=?', now(), j.id);
  const stream = Readable.toWeb(fs.createReadStream(jobFile(j.id))) as unknown as ReadableStream;
  return new Response(stream, { headers: { 'content-type': 'application/zip', 'content-length': String(j.bytes || fs.statSync(jobFile(j.id)).size), 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="growsigning-full-export-${String(j.ready_at || j.created_at).slice(0, 10)}.zip"` } });
}

export const listJobs = (accountId: string) => all('SELECT * FROM full_exports WHERE account_id=? ORDER BY created_at DESC LIMIT 5', accountId).map(jobView);
