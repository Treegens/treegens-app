// Bringing a full export (exportfull.ts) from another GrowSigning server into this account: moving between
// deployments. Templates, drafts, contacts, signing groups and a few plain settings come in as working things.
// Completed, voided, declined and expired envelopes come in as archived records (imported_records), never as
// envelopes: they were signed there, and nothing here re-signs, counts or verifies them as completed here. Envelopes
// still out for signature are refused with a list: they finish where they started. Every audit chain is worked out
// again on the way in, and every record says where the export says it came from, when, and whether its chain held.
//
// An import never invents evidence: what came in is kept as it came, and what could not be checked says so. Nothing
// in an export proves where it came from (its server is named in data.json, and the chain has no secret in it), so
// every mark says "an export that says it was made on <host>", and a banner is always written here from a fixed form,
// never taken from the file.
// importer-docusign.ts brings in DocuSign's own downloads the same way, through storeRecord below.
import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { bad, id, now, sha256, str, isEmail, baseUrl, HttpError } from './util.ts';
import { readZip, looksLikeZip, type ZipFile } from './zip.ts';
import { checkSchema, exportSchema } from './jsonschema.ts';
import { createEnvelope, loadEnvelope, saveDraft } from './envelopes.ts';
import { saveGroup } from './groups.ts';
import { storeUpload } from './routes-envelopes.ts';
import { removeUnusedBlobs } from './routes-trust.ts';
import { exportBanner, carriedBanner, IMPORT_MAX_BYTES, IMPORTS_PER_HOUR } from '../lib/exportfull.ts';
import { DATE_FORMATS } from '../lib/dates.ts';
import { shippedLocales } from '../lib/i18n.ts';

export type Skipped = { what: string; name: string; why: string };
export type Report = {
  imported: Record<string, number>;
  settings: string[];
  not_imported: Skipped[];
  refused_out_for_signature: { id: string; subject: string; sent_at: string | null }[];
  ids: { kind: string; from: string; to: string }[];
  records: { id: string; subject: string; chain_ok: boolean | null; banner: string }[];
};
const emptyReport = (): Report => ({ imported: {}, settings: [], not_imported: [], refused_out_for_signature: [], ids: [], records: [] });
const count = (r: Report, k: string) => (r.imported[k] = (r.imported[k] || 0) + 1);

// ---- Reading what was sent ---------------------------------------------------------------------------------------

const TOO_LARGE = `That file is larger than ${IMPORT_MAX_BYTES / 1e6} MB, the most that can be brought in at once. Nothing was brought in. Make the export in parts (select fewer documents under Settings, Records and data on the other server), or ask the people who run this server to bring it in for you.`;

/**
 * The body, read piece by piece and stopped as soon as it is larger than an import may be, also when the sender gave no
 * Content-Length (a chunked body): nothing larger is ever held in memory.
 */
export async function readCapped(req: Request, max = IMPORT_MAX_BYTES + 1_000_000): Promise<Buffer> {
  if (Number(req.headers.get('content-length') || 0) > max) throw bad(TOO_LARGE, 413);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    n += r.value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw bad(TOO_LARGE, 413);
    }
    parts.push(r.value);
  }
  return Buffer.concat(parts);
}

/** The bytes of the upload: a raw body, or every "file" part of a form. Refused while reading when too large. */
export async function uploadedFiles(req: Request): Promise<{ name: string; data: Buffer }[]> {
  const type = req.headers.get('content-type') || '';
  const body = await readCapped(req);
  let out: { name: string; data: Buffer }[];
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData().catch(() => null);
    const parts = (form?.getAll('file') || []).filter((f): f is File => typeof f !== 'string');
    out = await Promise.all(parts.map(async (f) => ({ name: str(f.name, 200) || 'file', data: Buffer.from(await f.arrayBuffer()) })));
  } else {
    out = body.length ? [{ name: 'upload.zip', data: body }] : [];
  }
  if (!out.length) throw bad('Choose the file to bring in. Nothing was brought in.');
  if (out.reduce((n, f) => n + f.data.length, 0) > IMPORT_MAX_BYTES) throw bad(TOO_LARGE, 413);
  return out;
}

const DAMAGED = 'That file could not be opened as a ZIP file: it looks damaged or cut short, or it unpacks to far more than its size. Nothing was brought in. Download the export again and bring in the new file.';
export const unzip = (data: Buffer): ZipFile[] => readZip(data, { damaged: () => bad(DAMAGED), maxUnpacked: IMPORT_MAX_BYTES * 2 });

// ---- Checking a full export -----------------------------------------------------------------------------------------

/** The export's data and files, after checking its schema, its manifest and the name of every file. */
export function openExport(zip: ZipFile[]): { data: any; files: Map<string, Buffer> } {
  const by = new Map(zip.map((z) => [z.name, z.data]));
  const raw = by.get('data.json');
  if (!raw) throw bad('This ZIP is not a GrowSigning full export: it has no data.json. Make one on the other server under Settings, Records and data, Export everything, and bring in that file. To bring in documents signed with DocuSign, choose "From DocuSign" instead. Nothing was brought in.');
  let data: any;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw bad('The data.json in this ZIP cannot be read: it is not valid JSON. Nothing was brought in. Download the export again.');
  }
  const problems = checkSchema(exportSchema(), data, 8);
  if (problems.length) throw bad(`This export does not match the published schema, so it was not brought in. Nothing was changed. What does not match: ${problems.join('; ')}.`, 400, { problems });
  const manifest = by.get('manifest-sha256.txt');
  if (!manifest) throw bad('This export has no manifest-sha256.txt, so there is no way to tell whether its files are the ones it was made with. Nothing was brought in. Download the export again.');
  const listed = new Map<string, string>();
  for (const line of manifest.toString('utf8').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
    if (m) listed.set(m[2], m[1]);
  }
  const wrong: string[] = [];
  for (const z of zip) {
    if (z.name === 'manifest-sha256.txt') continue;
    const want = listed.get(z.name);
    if (!want) wrong.push(`${z.name} is not in the manifest`);
    else if (sha256(z.data) !== want) wrong.push(`${z.name} has changed since the export was made`);
  }
  for (const name of listed.keys()) if (!by.has(name)) wrong.push(`${name} is in the manifest and missing from the ZIP`);
  if (wrong.length) throw bad(`Some files in this export are not the ones it was made with, so nothing was brought in: ${wrong.slice(0, 8).join('; ')}${wrong.length > 8 ? `, and ${wrong.length - 8} more` : ''}. Download the export again.`, 400, { changed: wrong });
  const files = new Map<string, Buffer>();
  for (const z of zip) {
    const m = /^files\/([0-9a-f]{64})$/.exec(z.name);
    if (!m) continue;
    if (sha256(z.data) !== m[1]) throw bad(`${z.name} is not the file its name says it is. Nothing was brought in. Download the export again.`);
    files.set(m[1], z.data);
  }
  return { data, files };
}

/** The chain of one exported envelope, worked out again from its lines as evidence.ts writes them (HASH_HOW). */
export function chainHolds(e: any): { ok: boolean; why: string } {
  const lines: any[] = e?.audit?.events || [];
  if (!lines.length) return { ok: false, why: 'It has no history lines to check.' };
  let prev = '';
  for (const a of lines) {
    if (a.prev_hash !== prev) return { ok: false, why: `Line ${a.seq} does not follow from the line before it.` };
    // A line whose details a deletion schedule took out keeps its place in the chain; only that place is checked. It
    // counts as such only when the line really shows the removal (records.ts writes "Removed on <day>" in its place).
    if (a.redacted_at && e.purged_at && a.redacted_at === e.purged_at && [a.detail, a.actor, a.ip].some((v) => /^Removed on \d{4}-\d{2}-\d{2}$/.test(String(v ?? '')))) {
      prev = a.hash;
      continue;
    }
    const h = sha256(JSON.stringify([prev, e.id, a.at, a.actor, a.action, a.detail, a.ip || '']));
    if (h !== a.hash) return { ok: false, why: `Line ${a.seq} ("${str(a.action, 60)}") was changed after it was written.` };
    prev = h;
  }
  if (e.audit?.chain?.head && e.audit.chain.head !== prev) return { ok: false, why: 'The last line is not the one the export names as the end of the chain.' };
  return { ok: true, why: '' };
}

// ---- Storing an archived record -------------------------------------------------------------------------------------

/** Keeps an archived record and its files. `null` when the same record from the same place is here already. */
export function storeRecord(accountId: string, by: string, r: { source: 'growsigning' | 'docusign'; deployment: string | null; sourceId: string; subject: string; status: string | null; sent_at?: string | null; completed_at?: string | null; chain_ok: boolean | null; banner: string; data: any; files: { name: string; data: Buffer; kind: string }[] }): string | null {
  if (get('SELECT 1 x FROM imported_records WHERE account_id=? AND source=? AND source_deployment IS ? AND source_id=?', accountId, r.source, r.deployment, r.sourceId)) return null;
  const shas = r.files.map((f) => ({ ...f, sha: saveBlob(f.data) }));
  const rid = id('imp');
  const at = now();
  tx(() => {
    run('INSERT INTO imported_records (id, account_id, source, source_deployment, source_id, imported_at, imported_by, subject, status, sent_at, completed_at, chain_ok, banner, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      rid, accountId, r.source, r.deployment, r.sourceId, at, by, str(r.subject, 300) || 'Untitled', r.status, r.sent_at || null, r.completed_at || null, r.chain_ok == null ? null : r.chain_ok ? 1 : 0, r.banner, JSON.stringify(r.data));
    for (const f of shas) {
      run('INSERT OR IGNORE INTO imported_files (record_id, sha256, name, kind) VALUES (?,?,?,?)', rid, f.sha, str(f.name, 200), f.kind);
      run('INSERT OR IGNORE INTO imported_shas (sha256, at) VALUES (?,?)', f.sha, at);
    }
  });
  return rid;
}

/** Only the host of a web address, never other words a file put there. */
const hostOf = (url: string) => {
  try {
    const u = new URL(String(url));
    if ((u.protocol === 'https:' || u.protocol === 'http:') && /^[a-z0-9.:[\]-]{1,100}$/i.test(u.host)) return u.host.toLowerCase();
  } catch {
    /* said below */
  }
  return 'a server it does not name';
};

/** A document's file, stored as an upload is, so a template or draft brought in is like any other. */
async function storeDocument(accountId: string, name: string, data: Buffer): Promise<any> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), `${name || 'Document'}.pdf`);
  return storeUpload({ req: new Request('http://import.local/files', { method: 'POST', body: form }) } as any, accountId);
}

/** A template or a draft from the export, through the same checks as one saved in the editor (saveDraft). */
export async function importDraft(c: any, t: any, kind: 'template' | 'envelope', files: Map<string, Buffer>, rep: Report): Promise<string | null> {
  const fileIds = new Map<string, string>();
  for (const d of t.documents || []) {
    const buf = d.file_sha256 ? files.get(d.file_sha256) : null;
    if (!buf) throw bad(`its document "${str(d.name, 80)}" is not in the export`);
    if (!fileIds.has(d.file_sha256)) fileIds.set(d.file_sha256, (await storeDocument(c.account.id, d.name, buf)).id);
  }
  const eid = createEnvelope(c.account, c.user.id, kind, { subject: t.subject, message: t.message });
  try {
    const e = loadEnvelope(eid);
    saveDraft(e, {
      subject: t.subject, message: t.message, ordered: !!t.ordered, reminder_days: t.reminder_days, expire_days: t.expire_days, date_format: t.date_format || undefined,
      documents: (t.documents || []).map((d: any) => ({ id: d.id, name: d.name, file_id: fileIds.get(d.file_sha256) })),
      // Only who a person is: no access code, and a stamp of the other account is not brought along.
      recipients: (t.recipients || []).map((r: any) => ({ id: r.id, role: r.role, role_name: r.role_name, name: r.name || '', email: r.email || '', routing_order: r.routing_order, note: r.note })),
      fields: (t.fields || []).filter((f: any) => f.type !== 'stamp').map(({ stamp_id: _s, ...f }: any) => f),
    }, c.account.id);
    if (t.folder) run('UPDATE envelopes SET folder=? WHERE id=?', str(t.folder, 100), eid);
    if ((t.fields || []).some((f: any) => f.type === 'stamp')) rep.not_imported.push({ what: kind === 'template' ? 'Stamp field' : 'Stamp field in a draft', name: t.subject || 'Untitled', why: 'Stamps belong to the account they were made in. Add your own stamp under Settings, Stamps and seals, then place the field again.' });
    if (kind === 'template' && t.rules) {
      // Rules come in only as tight or tighter: a template for chosen people becomes one for admins, because the
      // people it named have no login here yet. Nothing is ever opened up by an import.
      const use = t.rules.use === 'admins' || t.rules.use === 'chosen' ? 'admins' : null;
      run('UPDATE envelopes SET tpl_use=?, tpl_locked=? WHERE id=?', use, t.rules.locked ? 1 : 0, eid);
      if (t.rules.use === 'chosen' || t.rules.change === 'chosen' || t.rules.change === 'team')
        rep.not_imported.push({ what: 'Who may use or change a template', name: t.subject || 'Untitled', why: `It was set for ${t.rules.use === 'chosen' ? 'chosen people' : 'the team'} there. Here it is for admins${t.rules.use === 'chosen' ? '' : ' to change'} until you choose people again on the template.` });
    }
    return eid;
  } catch (err) {
    run('DELETE FROM envelopes WHERE id=?', eid);
    throw err;
  }
}

const mark = (accountId: string, kind: string, localId: string, source: string, deployment: string | null, sourceId: string, note: string) =>
  run('INSERT OR REPLACE INTO import_marks (account_id, kind, local_id, source, source_deployment, source_id, at, note) VALUES (?,?,?,?,?,?,?,?)', accountId, kind, localId, source, deployment, sourceId, now(), note);
const marked = (accountId: string, kind: string, source: string, deployment: string | null, sourceId: string) =>
  get('SELECT local_id FROM import_marks WHERE account_id=? AND kind=? AND source=? AND source_deployment IS ? AND source_id=?', accountId, kind, source, deployment, sourceId);

/** The settings an import may change, each with its check. The rest are listed for a person to set again. */
const SETTINGS_IN: Record<string, (v: any) => boolean> = {
  brand_color: (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v),
  default_reminder_days: (v) => Number.isInteger(v) && v >= 0 && v <= 60,
  default_expire_days: (v) => Number.isInteger(v) && v >= 1 && v <= 365,
  default_date_format: (v) => (DATE_FORMATS as readonly string[]).includes(v),
  default_locale: (v) => shippedLocales().includes(v),
};
const SETTING_NAMES: Record<string, string> = {
  brand_color: 'Brand colour', default_reminder_days: 'Reminders', default_expire_days: 'Deadline', default_date_format: 'Date format', default_locale: 'Language',
  retention_days: 'Deletion schedule', min_password_length: 'Password length', idle_minutes: 'Sign out when idle', two_step_required_at: 'Two-step login for everyone',
  pdfa_on: 'Archive format (PDF/A)', brand_logo: 'Logo', disclosure_now: 'Consent wording', list_days: 'How long saved lists are kept',
};

// ---- The import -------------------------------------------------------------------------------------------------

export async function importExport(c: any, zip: ZipFile[]): Promise<Report> {
  const { data, files } = openExport(zip);
  if (data.account?.id === c.account.id && hostOf(data.deployment?.url) === hostOf(baseUrl()))
    throw bad('This is an export of this same account, so everything in it is here already. Nothing was brought in. To move it, bring it in on the other server.');
  const from = hostOf(data.deployment.url);
  const deployment = data.deployment.url;
  const at = now();
  const by = `${c.user.name} <${c.user.email}>`;
  const rep = emptyReport();
  const mine = c.account.id;

  // Settings: only plain ones, each checked. The ones that change who can sign in or what is deleted are listed.
  const set: string[] = [];
  for (const [k, v] of Object.entries(data.account.settings || {})) {
    if (v == null || v === '' || v === 0) continue;
    if (SETTINGS_IN[k]?.(v)) {
      run(`UPDATE accounts SET ${k}=? WHERE id=?`, v, mine);
      set.push(SETTING_NAMES[k] || k);
    } else if (SETTING_NAMES[k]) rep.not_imported.push({ what: 'Setting', name: SETTING_NAMES[k], why: k === 'retention_days' ? 'A deletion schedule is never switched on by an import. Set it again under Settings, Records and data if you want it here.' : 'It decides who can sign in or what is kept, so a person sets it again here under Settings.' });
  }
  rep.settings = set;

  for (const ct of data.contacts || []) {
    if (!isEmail(ct.email)) continue;
    const res = run('INSERT OR IGNORE INTO contacts (id, account_id, name, email, company, created_at) VALUES (?,?,?,?,?,?)', id('ctc'), mine, str(ct.name, 120) || ct.email, ct.email, ct.company ? str(ct.company, 120) : null, now());
    if (res.changes) {
      const local = get('SELECT id FROM contacts WHERE account_id=? AND email=?', mine, ct.email).id;
      mark(mine, 'contact', local, 'growsigning', deployment, ct.id || ct.email, exportBanner(from, at, null).replace(/; chain not verified\.$/, '.'));
      rep.ids.push({ kind: 'contact', from: ct.id || ct.email, to: local });
      count(rep, 'contacts');
    }
  }

  for (const gr of data.signing_groups || []) {
    if (marked(mine, 'group', 'growsigning', deployment, gr.id || gr.name)) continue;
    try {
      const made = saveGroup(mine, { name: gr.name, members: gr.members });
      mark(mine, 'group', made.id, 'growsigning', deployment, gr.id || gr.name, `Imported from ${from}.`);
      rep.ids.push({ kind: 'signing_group', from: gr.id || gr.name, to: made.id });
      count(rep, 'signing_groups');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      rep.not_imported.push({ what: 'Signing group', name: gr.name, why: err.message });
    }
  }

  for (const t of data.templates || []) {
    if (marked(mine, 'template', 'growsigning', deployment, t.id)) continue;
    try {
      const local = await importDraft(c, t, 'template', files, rep);
      if (!local) continue;
      mark(mine, 'template', local, 'growsigning', deployment, t.id, `Imported from ${from} on ${at.slice(0, 10)}.`);
      rep.ids.push({ kind: 'template', from: t.id, to: local });
      count(rep, 'templates');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      rep.not_imported.push({ what: 'Template', name: t.subject || 'Untitled', why: `It could not be brought in: ${err.message}` });
    }
  }

  for (const e of data.envelopes || []) {
    if (e.status === 'sent') {
      rep.refused_out_for_signature.push({ id: e.id, subject: e.subject || 'Untitled', sent_at: e.sent_at || null });
      continue;
    }
    if (e.status === 'draft') {
      if (marked(mine, 'draft', 'growsigning', deployment, e.id)) continue;
      try {
        const local = await importDraft(c, e, 'envelope', files, rep);
        if (!local) continue;
        mark(mine, 'draft', local, 'growsigning', deployment, e.id, `Imported from ${from} on ${at.slice(0, 10)}.`);
        rep.ids.push({ kind: 'draft', from: e.id, to: local });
        count(rep, 'drafts');
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        rep.not_imported.push({ what: 'Draft', name: e.subject || 'Untitled', why: `It could not be brought in: ${err.message}` });
      }
      continue;
    }
    // Completed, voided, declined, expired: an archived record, with its chain worked out again here.
    const chain = chainHolds(e);
    const pdf = e.signed_pdf?.sha256 ? files.get(e.signed_pdf.sha256) : null;
    const missing = e.status === 'completed' && !pdf && !e.purged_at;
    const ok = chain.ok && !missing;
    const keep = [
      ...(pdf ? [{ name: `${e.subject || 'Signed document'}.pdf`, data: pdf, kind: 'signed' }] : []),
      ...(e.documents || []).filter((d: any) => d.file_sha256 && files.has(d.file_sha256) && d.file_sha256 !== e.signed_pdf?.sha256).map((d: any) => ({ name: `${d.name || 'Document'}.pdf`, data: files.get(d.file_sha256)!, kind: 'document' })),
    ];
    const packName = e.evidence_pack ? zip.find((z) => z.name === e.evidence_pack) : null;
    if (packName) keep.push({ name: `Full record for disputes ${e.id}.zip`, data: packName.data, kind: 'evidence' });
    const why = !chain.ok ? chain.why : missing ? 'Its signed PDF is not in the export.' : '';
    const rid = storeRecord(mine, by, {
      source: 'growsigning', deployment, sourceId: e.id, subject: e.subject, status: e.status, sent_at: e.sent_at, completed_at: e.completed_at,
      chain_ok: ok, banner: exportBanner(from, at, ok), data: { ...e, chain_check: { ok, why, at } }, files: keep,
    });
    if (!rid) continue;
    rep.ids.push({ kind: 'envelope', from: e.id, to: rid });
    rep.records.push({ id: rid, subject: e.subject || 'Untitled', chain_ok: ok, banner: exportBanner(from, at, ok) });
    count(rep, 'archived_records');
  }

  // What that account had brought in itself (from DocuSign, say) comes along, saying so. Its banner and its chain mark
  // are the file's words, so neither is taken: the banner is written here from a fixed form, a DocuSign record never
  // has a chain, and the chain of one from another export is worked out again from its own history.
  for (const r of data.imported || []) {
    if (r.source !== 'growsigning' && r.source !== 'docusign') {
      rep.not_imported.push({ what: 'Record brought in there', name: str(r.subject, 120) || 'Untitled', why: 'The export does not say where it came from in a way we can read, so it was left out.' });
      continue;
    }
    const keep = (r.files || []).filter((f: any) => files.has(f.sha256)).map((f: any) => ({ name: str(f.name, 200) || 'File', data: files.get(f.sha256)!, kind: ['signed', 'document', 'evidence'].includes(f.kind) ? f.kind : 'document' }));
    const chainOk = r.source === 'docusign' ? null : !!r.data?.audit?.events?.length && chainHolds(r.data).ok && keep.some((f: any) => f.kind === 'signed');
    const banner = carriedBanner(r.source, from, at, chainOk);
    const rid = storeRecord(mine, by, {
      source: r.source, deployment: r.source_deployment ?? null, sourceId: r.source_id || r.id, subject: r.subject, status: typeof r.status === 'string' ? str(r.status, 40) : null,
      chain_ok: chainOk, banner, data: r.data || {}, files: keep,
    });
    if (rid) (rep.ids.push({ kind: 'imported_record', from: r.id, to: rid }), count(rep, 'archived_records'));
  }

  // Everything else, said by name with what to do.
  for (const m of data.members || []) if (m.email !== c.user.email) rep.not_imported.push({ what: 'Team member', name: `${m.name} <${m.email}> (${m.role})`, why: 'People are never added to a team without being asked. Invite them under Settings, Team.' });
  for (const h of data.webhooks || []) rep.not_imported.push({ what: 'Webhook', name: h.url, why: 'Each webhook here needs a new signing secret. Add it again under Settings, API and webhooks.' });
  for (const cw of data.clickwraps || []) rep.not_imported.push({ what: 'Click-to-agree terms', name: cw.name, why: `Its versions and ${cw.acceptances?.length || 0} acceptance(s) stay in the export file, which is their record. Publish the terms again here for new acceptances.` });
  for (const h of (data.retention?.holds || []).filter((x: any) => !x.lifted_at)) rep.not_imported.push({ what: 'Legal hold', name: h.matter || h.reason, why: 'Holds apply to envelopes on the server that holds them. Archived records brought in are not deleted by a schedule here.' });
  return rep;
}

// ---- Reading records brought in --------------------------------------------------------------------------------------

const recordView = (r: any, withData = false) => ({
  id: r.id, source: r.source, source_deployment: r.source_deployment, source_id: r.source_id, imported_at: r.imported_at, imported_by: r.imported_by,
  subject: r.subject, status: r.status, sent_at: r.sent_at, completed_at: r.completed_at, chain_ok: r.chain_ok == null ? null : !!r.chain_ok, banner: r.banner,
  files: all('SELECT sha256, name, kind FROM imported_files WHERE record_id=? ORDER BY kind DESC, name', r.id),
  ...(withData ? { data: JSON.parse(r.data || '{}') } : {}),
});

export const countImported = (accountId: string): number => get('SELECT COUNT(*) n FROM imported_records WHERE account_id=?', accountId).n;
export const listImported = (accountId: string, limit = 200) => all('SELECT * FROM imported_records WHERE account_id=? ORDER BY imported_at DESC, subject LIMIT ?', accountId, limit).map((r) => recordView(r));
export function oneImported(accountId: string, rid: string) {
  const r = get('SELECT * FROM imported_records WHERE id=? AND account_id=?', rid, accountId);
  if (!r) throw bad('We could not find that record. It may have been deleted, or it belongs to another account.', 404);
  return recordView(r, true);
}
/** For the full export of this account: what it brought in, as it was brought in. */
export const importedExport = (accountId: string) => all('SELECT * FROM imported_records WHERE account_id=? ORDER BY imported_at', accountId).map((r) => recordView(r, true));

export function importedFile(accountId: string, rid: string, sha: string): { name: string; data: Buffer } {
  const f = get('SELECT f.name, f.sha256 FROM imported_files f JOIN imported_records r ON r.id=f.record_id WHERE r.id=? AND r.account_id=? AND f.sha256=?', rid, accountId, sha);
  if (!f) throw bad('We could not find that file.', 404);
  return { name: f.name, data: readBlob(f.sha256) };
}

export function deleteImported(accountId: string, rid: string) {
  const shas = all('SELECT f.sha256 FROM imported_files f JOIN imported_records r ON r.id=f.record_id WHERE r.id=? AND r.account_id=?', rid, accountId).map((x) => x.sha256);
  if (!run('DELETE FROM imported_records WHERE id=? AND account_id=?', rid, accountId).changes) throw bad('We could not find that record. It may have been deleted already.', 404);
  removeUnusedBlobs(shas);
  return { ok: true };
}

/** The timer: files no record names any more (a record or its account was deleted) leave the disk. */
export function forgetImportedFiles(): number {
  const gone = all('SELECT sha256 FROM imported_shas WHERE sha256 NOT IN (SELECT sha256 FROM imported_files)').map((r) => r.sha256);
  if (gone.length) {
    removeUnusedBlobs(gone);
    for (const s of gone) run('DELETE FROM imported_shas WHERE sha256=?', s);
  }
  return gone.length;
}

/**
 * For /verify, when a file matches no document completed here: whether it is a file an account brought in. Only
 * where it came from and when, never which account or who is in it, and never "completed here".
 */
export function importedForVerify(sha: string): null | { source: 'growsigning' | 'docusign'; from: string | null; imported_at: string; completed_at: string | null } {
  const r = get("SELECT r.source, r.source_deployment, r.imported_at, r.chain_ok, r.completed_at FROM imported_files f JOIN imported_records r ON r.id=f.record_id WHERE f.sha256=? AND f.kind IN ('signed','document') ORDER BY r.imported_at LIMIT 1", sha);
  if (!r) return null;
  // Only what the upload said it was, and when. No chain mark: nothing in an uploaded file shows that it is genuine.
  return { source: r.source, from: r.source === 'growsigning' ? hostOf(r.source_deployment || '') : null, imported_at: r.imported_at, completed_at: r.completed_at };
}

/** Marks on templates, drafts, contacts and groups an import made, by local id, for screens that list them. */
export const importMarks = (accountId: string, kind: string): Record<string, string> =>
  Object.fromEntries(all('SELECT local_id, note FROM import_marks WHERE account_id=? AND kind=?', accountId, kind).map((m) => [m.local_id, m.note]));

export { looksLikeZip, IMPORTS_PER_HOUR };
