// Bringing in what DocuSign lets its customers download, so an agency can keep its archive in one place:
//   - the per-envelope "combined documents with certificate" PDF (the documents, then DocuSign's Certificate Of
//     Completion), found by the envelope ID DocuSign prints on it;
//   - the envelope CSV or report export, which adds the subject, status, sender, dates and recipients;
//   - template JSON, where DocuSign offers it ("Download" on a template), with its documents in base64.
// One upload may hold any of these, or a ZIP of them. Envelopes come in as archived records only (importer.ts,
// storeRecord): the PDF as it was, with DocuSign's certificate inside it, the metadata, and the banner from
// src/lib/exportfull.ts. They are never counted as signed here and never shown on /verify as completed here.
// Templates are mapped to our fields where there is a match; everything else is listed as not imported.
//
// The layouts read here are the documented ones (column names DocuSign's reports use, the envelope ID line on its
// pages, its template JSON). The tests use fixtures made from those descriptions, not real downloads: the owner is to
// provide sample exports from a test account to check them against (research/government.json, G19).
import { bad, now, sha256, str, isEmail, HttpError } from './util.ts';
import { extractPages } from './text.ts';
import { createEnvelope, loadEnvelope, saveDraft } from './envelopes.ts';
import { run, get } from './db.ts';
import { storeUpload } from './routes-envelopes.ts';
import { storeRecord, unzip, type Report } from './importer.ts';
import { looksLikeZip } from './zip.ts';
import { docusignBanner } from '../lib/exportfull.ts';
import { dayText } from '../lib/dates.ts';

const GUID = /([0-9A-F]{8}-?[0-9A-F]{4}-?[0-9A-F]{4}-?[0-9A-F]{4}-?[0-9A-F]{12})/i;
/** DocuSign's envelope ID in a common form: 32 capital hex digits, dashes taken out. */
export const envelopeKey = (s: string) => String(s || '').replace(/-/g, '').toUpperCase();

/** Without its certificate the banner may not point at one, and it may not say the file was signed at all. */
export const NO_CERTIFICATE = (at: string) => `Imported from DocuSign on ${dayText(at)}. Not signed here. No DocuSign certificate was found inside this file, so nothing here shows whether or how it was signed.`;

/** Plain names for the parts of a DocuSign template we have no field for, one and many. */
const PART_NAMES: Record<string, [string, string]> = {
  formulaTabs: ['formula field', 'formula fields'], approveTabs: ['approval field', 'approval fields'], declineTabs: ['decline button', 'decline buttons'],
  noteTabs: ['note', 'notes'], viewTabs: ['view field', 'view fields'], drawTabs: ['drawing field', 'drawing fields'], smartSectionTabs: ['smart section', 'smart sections'],
  editors: ['person who can change the document', 'people who can change the document'], agents: ['person who chooses the next signer', 'people who choose the next signer'],
  intermediaries: ['person who passes it on', 'people who pass it on'], seals: ['electronic seal', 'electronic seals'], notaries: ['notary', 'notaries'],
};

// ---- The CSV ---------------------------------------------------------------------------------------------------

/** Rows of a CSV (RFC 4180: quotes, doubled quotes, line breaks inside quotes), as lists of cells. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLUMNS: Record<string, string[]> = {
  id: ['envelope id', 'envelopeid', 'envelope id (guid)'],
  subject: ['subject', 'email subject', 'envelope subject', 'envelope name'],
  status: ['status', 'envelope status'],
  sender: ['sender name', 'sender', 'from', 'sent by'],
  sender_email: ['sender email', 'sender email address', 'sender e-mail'],
  sent: ['sent on', 'sent date', 'date sent', 'sent date time', 'sent', 'sent (utc)'],
  completed: ['completed on', 'completed date', 'date completed', 'completed date time', 'completed', 'completed (utc)'],
  recipient: ['recipient name', 'recipient', 'signer name'],
  recipient_email: ['recipient email', 'recipient email address', 'signer email'],
  recipient_status: ['recipient status', 'signer status'],
};

export type CsvEnvelope = { id: string; key: string; subject: string; status: string; sender: string; sender_email: string; sent: string; completed: string; recipients: { name: string; email: string; status: string }[] };

/** Envelopes from a DocuSign envelope CSV or report, by their envelope ID. `null` when this is not such a CSV. */
export function readEnvelopeCsv(text: string): Map<string, CsvEnvelope> | null {
  const rows = csvRows(text);
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (k: string) => head.findIndex((h) => COLUMNS[k].includes(h));
  const at = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, col(k)]));
  if (at.id < 0) return null;
  const out = new Map<string, CsvEnvelope>();
  for (const r of rows.slice(1)) {
    const cell = (k: string) => (at[k] >= 0 ? str(r[at[k]], 500).trim() : '');
    const m = GUID.exec(cell('id'));
    if (!m) continue;
    const key = envelopeKey(m[1]);
    const e = out.get(key) || { id: m[1], key, subject: cell('subject'), status: cell('status'), sender: cell('sender'), sender_email: cell('sender_email'), sent: cell('sent'), completed: cell('completed'), recipients: [] };
    // A report has one row per recipient: the envelope's own cells repeat, the people add up.
    if (cell('recipient') || cell('recipient_email')) e.recipients.push({ name: cell('recipient'), email: cell('recipient_email'), status: cell('recipient_status') });
    out.set(key, e);
  }
  return out;
}

// ---- The PDF ---------------------------------------------------------------------------------------------------

export type PdfFacts = { key: string | null; id: string | null; certificate: boolean; subject: string; status: string };

/** What the combined PDF says about itself: its envelope ID, whether DocuSign's certificate is in it, subject, status. */
export async function readCombinedPdf(bytes: Uint8Array): Promise<PdfFacts> {
  const pages = await extractPages(bytes);
  const text = pages.join('\n');
  const idLine = /Envelope\s*I[dD]\s*:?\s*([0-9A-Fa-f-]{32,36})/.exec(text);
  const m = idLine ? GUID.exec(idLine[1]) : null;
  const certificate = /Certificate\s+Of\s+Completion/i.test(text);
  const certText = certificate ? text.slice(text.search(/Certificate\s+Of\s+Completion/i)) : '';
  const subject = (/Subject\s*:\s*(.+?)(?:\s{2,}|\n|Source Envelope|Document Pages|$)/i.exec(certText)?.[1] || '').trim().slice(0, 200);
  const status = (/Status\s*:\s*([A-Za-z]+)/i.exec(certText)?.[1] || '').trim();
  return { key: m ? envelopeKey(m[1]) : null, id: m ? m[1] : null, certificate, subject, status };
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

// ---- Templates -------------------------------------------------------------------------------------------------

const TAB_TYPES: Record<string, string> = {
  signHereTabs: 'signature', initialHereTabs: 'initials', dateSignedTabs: 'date_signed', fullNameTabs: 'full_name', emailAddressTabs: 'email', emailTabs: 'email',
  textTabs: 'text', numberTabs: 'number', numericalTabs: 'number', dateTabs: 'date', companyTabs: 'company', titleTabs: 'title', checkboxTabs: 'checkbox',
  listTabs: 'dropdown', radioGroupTabs: 'radio', signerAttachmentTabs: 'attachment',
};
// Sizes in points where DocuSign gives none: its tabs are placed by their top left corner.
const DEFAULT_SIZE: Record<string, [number, number]> = { signature: [150, 40], initials: [60, 30], checkbox: [14, 14], radio: [14, 14], attachment: [120, 30] };
const ROLE_OF: Record<string, string> = { signers: 'signer', carbonCopies: 'cc', certifiedDeliveries: 'viewer', inPersonSigners: 'inperson', witnesses: 'witness' };

const yes = (v: any) => v === true || v === 'true';
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

export function looksLikeTemplate(j: any): boolean {
  return !!j && typeof j === 'object' && !Array.isArray(j) && !!j.recipients && typeof j.recipients === 'object' && Array.isArray(j.documents);
}

async function storePdf(accountId: string, name: string, data: Buffer): Promise<any> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), `${name || 'Document'}.pdf`);
  return storeUpload({ req: new Request('http://import.local/files', { method: 'POST', body: form }) } as any, accountId);
}

/** A DocuSign template made into one of ours, through the editor's own checks. Returns the new template's id. */
export async function importTemplate(c: any, j: any, rep: Report): Promise<string | null> {
  const name = str(j.name || j.emailSubject || 'DocuSign template', 200);
  const srcId = String(j.envelopeTemplateId || j.templateId || sha256(JSON.stringify(j)).slice(0, 32));
  if (get("SELECT 1 x FROM import_marks WHERE account_id=? AND kind='template' AND source='docusign' AND source_id=?", c.account.id, srcId)) {
    rep.not_imported.push({ what: 'Template', name, why: 'It is here already: it was brought in before.' });
    return null;
  }
  const skipped = new Map<string, { n: number; one: string; many: string }>();
  const skip = (one: string, many = one) => {
    const k = `${one}|${many}`;
    const was = skipped.get(k) || { n: 0, one, many };
    skipped.set(k, { ...was, n: was.n + 1 });
  };
  const named = (key: string, fallback: [string, string]): [string, string] => PART_NAMES[key] || fallback;
  const docs: { id: string; name: string; file: any }[] = [];
  for (const d of j.documents || []) {
    const b64 = typeof d.documentBase64 === 'string' ? Buffer.from(d.documentBase64, 'base64') : null;
    if (!b64 || !isPdf(b64)) {
      rep.not_imported.push({ what: 'Template document', name: `${name}: ${str(d.name, 80) || 'a document'}`, why: 'The file holds no PDF for it (DocuSign leaves documents out of some template downloads). Download the template again with its documents, or add the PDF here by hand.' });
      continue;
    }
    docs.push({ id: String(d.documentId ?? docs.length + 1), name: str(d.name, 200).replace(/\.pdf$/i, '') || 'Document', file: await storePdf(c.account.id, d.name, b64) });
  }
  if (!docs.length) throw bad('it has no document we could read');
  const recipients: any[] = [], fields: any[] = [];
  for (const [group, list] of Object.entries(j.recipients || {})) {
    if (!Array.isArray(list)) continue;
    const role = ROLE_OF[group];
    for (const r of list as any[]) {
      if (!role) {
        skip(...named(group, [`person of the kind "${group}"`, `people of the kind "${group}"`]));
        continue;
      }
      const rid = `rcp_ds${recipients.length + 1}`;
      recipients.push({ id: rid, role, role_name: str(r.roleName, 80) || null, name: str(r.name, 120), email: isEmail(r.email) ? r.email : '', routing_order: Math.min(99, Math.max(1, Math.round(num(r.routingOrder)) || 1)) });
      for (const [kind, tabs] of Object.entries(r.tabs || {})) {
        if (!Array.isArray(tabs)) continue;
        const type = TAB_TYPES[kind];
        for (const t of tabs as any[]) {
          if (!type) {
            skip(...named(kind, [`${kind.replace(/Tabs$/, '')} field`, `${kind.replace(/Tabs$/, '')} fields`]));
            continue;
          }
          const items = type === 'radio' ? (t.radios || []).map((x: any) => ({ ...x, documentId: x.documentId ?? t.documentId, groupName: t.groupName })) : [t];
          for (const x of items) {
            const doc = docs.find((d) => d.id === String(x.documentId ?? docs[0].id));
            const page = Math.round(num(x.pageNumber)) - 1;
            const size = doc?.file.page_sizes?.[page];
            const px = num(x.xPosition), py = num(x.yPosition);
            if (!doc || !size || !Number.isFinite(px) || !Number.isFinite(py)) {
              skip('field placed by anchor text or on a page we could not find', 'fields placed by anchor text or on a page we could not find');
              continue;
            }
            const [dw, dh] = DEFAULT_SIZE[type] || [120, 18];
            const w = (num(x.width) > 0 ? num(x.width) : dw) / size.w, h = (num(x.height) > 0 ? num(x.height) : dh) / size.h;
            if (x.conditionalParentLabel) skip('condition on a field (the field always shows here)', 'conditions on fields (the fields always show here)');
            fields.push({
              id: `fld_ds${fields.length + 1}`, document_id: `doc_ds${docs.indexOf(doc)}`, recipient_id: rid, type, page,
              x: Math.min(1 - w, Math.max(0, px / size.w)), y: Math.min(1 - h, Math.max(0, py / size.h)), w: Math.min(1, w), h: Math.min(1, h),
              required: type === 'checkbox' ? yes(x.required) : !yes(x.optional) && x.required !== 'false' && x.required !== false,
              label: str(x.tabLabel || x.name, 100) || null,
              ...(type === 'dropdown' ? { options: (x.listItems || []).map((li: any) => str(li.text ?? li.value, 100)).filter(Boolean) } : {}),
              ...(type === 'radio' ? { group_name: str(x.groupName, 100) || 'Choice', value: undefined, label: str(x.value, 100) || null } : {}),
              ...(type === 'text' && typeof x.value === 'string' && x.value ? { prefill: str(x.value, 500) } : {}),
            });
          }
        }
      }
    }
  }
  const eid = createEnvelope(c.account, c.user.id, 'template', { subject: name, message: str(j.emailBlurb, 5000) });
  try {
    saveDraft(loadEnvelope(eid), { subject: str(j.emailSubject || name, 200), message: str(j.emailBlurb, 5000), documents: docs.map((d, i) => ({ id: `doc_ds${i}`, name: d.name, file_id: d.file.id })), recipients, fields }, c.account.id);
  } catch (err) {
    run('DELETE FROM envelopes WHERE id=?', eid);
    throw err;
  }
  const at = now();
  run('INSERT OR REPLACE INTO import_marks (account_id, kind, local_id, source, source_deployment, source_id, at, note) VALUES (?,?,?,?,?,?,?,?)', c.account.id, 'template', eid, 'docusign', null, srcId, at, `Imported from DocuSign on ${dayText(at)}.`);
  for (const { n, one, many } of skipped.values()) rep.not_imported.push({ what: 'Part of a template', name: name, why: `${n} ${n === 1 ? one : many}: there is nothing that matches here, so ${n === 1 ? 'it was' : 'they were'} left out. Add what you need in the editor.` });
  return eid;
}

// ---- The import ------------------------------------------------------------------------------------------------

export async function importDocusign(c: any, uploads: { name: string; data: Buffer }[]): Promise<Report> {
  const rep: Report = { imported: {}, settings: [], not_imported: [], refused_out_for_signature: [], ids: [], records: [] };
  const count = (k: string) => (rep.imported[k] = (rep.imported[k] || 0) + 1);
  // A ZIP is opened once; what is inside is read like files chosen one by one. A ZIP inside a ZIP is not opened.
  const files: { name: string; data: Buffer }[] = [];
  for (const u of uploads) if (looksLikeZip(u.data)) files.push(...unzip(u.data).map((z) => ({ name: z.name.split('/').pop() || z.name, data: z.data })));
  else files.push(u);
  const meta = new Map<string, CsvEnvelope>();
  const pdfs: { name: string; data: Buffer }[] = [];
  for (const f of files) {
    if (isPdf(f.data)) pdfs.push(f);
    else if (/\.csv$/i.test(f.name) || /^﻿?"?Envelope/i.test(f.data.subarray(0, 40).toString('utf8'))) {
      const rows = readEnvelopeCsv(f.data.toString('utf8'));
      if (!rows) rep.not_imported.push({ what: 'File', name: f.name, why: 'It is a CSV without an "Envelope ID" column, so it is not one of DocuSign\'s envelope reports. Export the envelope report from DocuSign and bring that in.' });
      else for (const [k, v] of rows) meta.set(k, v);
    } else if (/\.json$/i.test(f.name) || f.data[0] === 0x7b) {
      let j: any = null;
      try {
        j = JSON.parse(f.data.toString('utf8'));
      } catch {
        /* said below */
      }
      const list = Array.isArray(j?.envelopeTemplates) ? j.envelopeTemplates : [j];
      for (const t of list) {
        if (!looksLikeTemplate(t)) {
          rep.not_imported.push({ what: 'File', name: f.name, why: 'It is not a DocuSign template file we can read. On DocuSign, open the template and choose Download, then bring in that file.' });
          continue;
        }
        try {
          const tid = await importTemplate(c, t, rep);
          if (tid) (rep.ids.push({ kind: 'template', from: String(t.envelopeTemplateId || t.templateId || t.name), to: tid }), count('templates'));
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          rep.not_imported.push({ what: 'Template', name: str(t.name || t.emailSubject, 120) || f.name, why: `It could not be brought in: ${err.message}` });
        }
      }
    } else rep.not_imported.push({ what: 'File', name: f.name, why: 'It is not a PDF, a CSV or a template file, so it was left out.' });
  }
  const at = now();
  const used = new Set<string>();
  for (const p of pdfs) {
    const facts = await readCombinedPdf(p.data);
    const m = facts.key ? meta.get(facts.key) : undefined;
    if (facts.key) used.add(facts.key);
    const status = (m?.status || facts.status || '').toLowerCase();
    // Only what was finished there: a document still out on DocuSign has no certificate of a finished signing yet.
    if (status && !/complet/.test(status)) {
      rep.not_imported.push({ what: 'DocuSign envelope', name: m?.subject || facts.subject || p.name, why: `DocuSign says it is "${m?.status || facts.status}", not completed. Only completed envelopes are brought in. Download it again once it is completed there.` });
      continue;
    }
    // A PDF with neither DocuSign's envelope ID nor its certificate shows nothing of DocuSign at all: it is not made
    // into a record, so no file becomes "signed on DocuSign" because someone said so.
    if (!facts.key && !facts.certificate) {
      rep.not_imported.push({ what: 'File', name: p.name, why: 'It shows no DocuSign envelope ID and no DocuSign certificate, so nothing in it shows that it comes from DocuSign. It was not brought in. On DocuSign, download the envelope as "combined documents with certificate" and bring in that PDF.' });
      continue;
    }
    const banner = facts.certificate ? docusignBanner(at) : NO_CERTIFICATE(at);
    const rid = storeRecord(c.account.id, `${c.user.name} <${c.user.email}>`, {
      source: 'docusign', deployment: null, sourceId: facts.key || `file-${sha256(p.data)}`, subject: m?.subject || facts.subject || p.name.replace(/\.pdf$/i, ''), status: /complet/.test(status) ? 'completed' : null,
      sent_at: m?.sent || null, completed_at: m?.completed || null, chain_ok: null, banner,
      data: { docusign_envelope_id: facts.id || m?.id || null, subject: m?.subject || facts.subject || null, status: m?.status || facts.status || null, sender: m ? { name: m.sender, email: m.sender_email } : null,
        sent: m?.sent || null, completed: m?.completed || null, recipients: m?.recipients || [], certificate_in_file: facts.certificate, file_name: p.name, file_sha256: sha256(p.data),
        found_by: facts.key ? (m ? 'The envelope ID printed on the PDF, matched to a row of the CSV.' : 'The envelope ID printed on the PDF. No CSV row had it, so the details are what the PDF says.') : 'No envelope ID was found on the PDF.' },
      files: [{ name: p.name.endsWith('.pdf') ? p.name : `${p.name}.pdf`, data: p.data, kind: 'signed' }],
    });
    if (!rid) {
      rep.not_imported.push({ what: 'DocuSign envelope', name: m?.subject || facts.subject || p.name, why: 'It is here already: it was brought in before.' });
      continue;
    }
    rep.ids.push({ kind: 'docusign_envelope', from: facts.id || p.name, to: rid });
    rep.records.push({ id: rid, subject: m?.subject || facts.subject || p.name, chain_ok: null, banner });
    count('archived_records');
  }
  for (const [k, m] of meta) if (!used.has(k)) rep.not_imported.push({ what: 'DocuSign envelope', name: m.subject || m.id, why: !m.status || /complet/i.test(m.status)
    ? 'Its row is in the CSV, but its PDF was not among the files. Download its "combined documents with certificate" PDF from DocuSign and bring it in.'
    : `It is still "${str(m.status, 40)}" on DocuSign, not completed. Bring it in once it is completed there.` });
  if (!pdfs.length && !rep.imported.templates && !rep.not_imported.length) throw bad('Nothing in what you chose is a DocuSign PDF, envelope report or template file. Nothing was brought in.');
  return rep;
}
