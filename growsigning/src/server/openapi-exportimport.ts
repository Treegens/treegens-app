// The full export and bringing documents in, as part of /api/openapi.json (routes-exportimport.ts). Kept apart so
// the main description stays readable; openapi.ts spreads it into its paths.
import { EXPORT_LINK_DAYS, EXPORT_DIRECT_MAX_ENVELOPES, EXPORT_DIRECT_MAX_BYTES, IMPORT_MAX_BYTES, IMPORTS_PER_HOUR, EXPORTS_DIRECT_PER_HOUR, EXPORT_SCHEMA_PATH } from '../lib/exportfull.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const s = { type: 'string' };
const time = { type: 'string', format: 'date-time' };
const zip = { description: 'A ZIP file', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } };
const job = { type: 'object', properties: { id: s, status: { type: 'string', enum: ['making', 'ready', 'failed', 'expired'] }, created_at: time, ready_at: { ...time, nullable: true }, expires_at: { ...time, nullable: true }, bytes: { type: 'integer', nullable: true }, envelopes: { type: 'integer', nullable: true }, error: { ...s, nullable: true }, download_url: { ...s, nullable: true } } };
const upload = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'array', items: { type: 'string', format: 'binary' } } } } }, 'application/zip': { schema: { type: 'string', format: 'binary' } } } };
const report = {
  type: 'object',
  properties: {
    imported: { type: 'object', additionalProperties: { type: 'integer' }, description: 'How many of each came in: templates, drafts, contacts, signing_groups, archived_records.' },
    settings: { type: 'array', items: s, description: 'The settings taken over, by their names under Settings.' },
    not_imported: { type: 'array', items: { type: 'object', properties: { what: s, name: s, why: s } }, description: 'Everything that did not come in, each with why and what to do.' },
    refused_out_for_signature: { type: 'array', items: { type: 'object', properties: { id: s, subject: s, sent_at: { ...s, nullable: true } } }, description: 'Envelopes still out for signature where they were sent. They finish there; bring them in afterwards.' },
    ids: { type: 'array', items: { type: 'object', properties: { kind: s, from: s, to: s } }, description: 'Each id where it came from and the id it has here.' },
    records: { type: 'array', items: { type: 'object', properties: { id: s, subject: s, chain_ok: { type: 'boolean', nullable: true }, banner: s } } },
  },
};
const record = { type: 'object', properties: { id: s, source: { type: 'string', enum: ['growsigning', 'docusign'] }, source_deployment: { ...s, nullable: true }, source_id: { ...s, nullable: true }, imported_at: time, imported_by: s, subject: s, status: { ...s, nullable: true }, chain_ok: { type: 'boolean', nullable: true, description: 'null for DocuSign: no chain is claimed for it.' }, banner: s, files: { type: 'array', items: { type: 'object', properties: { sha256: s, name: s, kind: s } } }, data: { type: 'object', description: 'With GET /imported/{id} only: everything that came with it, as it came.' } } };
const idParam = { name: 'id', in: 'path', required: true, schema: s };

export const exportImportPaths = () => ({
  [EXPORT_SCHEMA_PATH.replace(/^\/api/, '')]: { get: { summary: 'The JSON Schema of the full export', description: 'JSON Schema 2020-12, version 1, the same as docs/schema/growsigning-export-v1.schema.json. Anyone may read it.', security: [], responses: ok({ type: 'object' }) } },
  '/export/full': { get: {
    summary: 'Everything in the account as one ZIP, in the published format (owners, admins, an admin key)',
    description: `A role the team made needs both "settings" and "see_all" for this, for its jobs, for bringing documents in and for /imported (403 "not_in_role" otherwise), because each holds every document of the account. `+`data.json (validated against the schema before it is written: settings without secrets, members and roles, templates with fields, rules and locks, contacts, signing groups, folders, webhooks without secrets, click-to-agree terms and acceptances, the deletion schedule and legal holds, every envelope with people, fields and values, audit trail with chain values and comments, and records brought in), files/<sha256> for every file, evidence/<id>.zip for each envelope sent, the schema, README.txt and manifest-sha256.txt. Free, also while the account is paused or unpaid. An account with more than ${EXPORT_DIRECT_MAX_ENVELOPES} envelopes or ${EXPORT_DIRECT_MAX_BYTES / 1e6} MB of files, or ?background=1, answers 202 with a job instead: the person is emailed when it is ready, and it can be downloaded for ${EXPORT_LINK_DAYS} days; the "export.ready" webhook fires then. At most ${EXPORTS_DIRECT_PER_HOUR} direct exports an hour per account (429 after that); background ones are made one at a time.`,
    parameters: [{ name: 'background', in: 'query', schema: { type: 'string', enum: ['1'] } }],
    responses: { 200: zip, 202: { description: 'Being made in the background', content: { 'application/json': { schema: { type: 'object', properties: { background: { type: 'boolean' }, job, message: s } } } } }, default: err },
  } },
  '/export/full/jobs': {
    get: { summary: 'The latest full exports made in the background (up to 5)', responses: ok({ type: 'object', properties: { jobs: { type: 'array', items: job } } }) },
    post: { summary: 'Start a full export in the background', description: 'One at a time per account: while one is being made, this answers that one.', responses: ok({ type: 'object', properties: { job } }) },
  },
  '/export/full/jobs/{id}/download': { parameters: [idParam], get: { summary: 'Download a full export made in the background', description: `For an owner or admin of the account that made it. 409 while it is being made, 410 when it failed or is older than ${EXPORT_LINK_DAYS} days, 404 for another account's.`, responses: { 200: zip, default: err } } },
  '/import/full': { post: {
    summary: 'Bring in a full export from another GrowSigning server (owners, admins)',
    description: `The ZIP that GET /export/full made, as the body or as the "file" part of a form, up to ${IMPORT_MAX_BYTES / 1e6} MB; ${IMPORTS_PER_HOUR} imports an hour. Refused, with nothing changed, when its data.json does not match the schema, when a file is not in the manifest or differs from it, or when it is this same account's export. Templates, drafts, contacts, signing groups and plain settings (brand colour, reminders, deadline, date format, language) come in through the same checks as the editor and Settings; rules on a template only ever get stricter. Completed, voided, declined and expired envelopes come in as archived records with their audit chain worked out again; their banner reads "Imported on <date> from an export that says it was made on <host>; chain verified" (or "not verified"). Chain verified means only that the history and files inside the export agree with each other: the server named in the export is what the file says, and anyone with the file could change it and work the chain out again. Records the exporting account had itself brought in come along with a banner written here, never the one in the file, and a DocuSign record never has a chain mark. They are never envelopes here. Envelopes out for signature are refused and listed. A deletion schedule, sign-in rules, team members, webhooks, click-to-agree terms and legal holds are listed in not_imported, with what to do. Bringing the same file in again adds only what is new.`,
    requestBody: upload, responses: ok(report),
  } },
  '/import/docusign': { post: {
    summary: 'Bring in DocuSign downloads (owners, admins)',
    description: 'One or more "file" parts: the per-envelope "combined documents with certificate" PDFs, the envelope report CSV, template JSON, or a ZIP of them. Each PDF that shows DocuSign\'s envelope ID or its Certificate Of Completion becomes an archived record, matched to its CSV row by that envelope ID, with the banner "Imported from DocuSign on <date>. Signed there, not here. Its evidence is DocuSign\'s certificate inside the file." Without a certificate in the file the banner says none was found and nothing shows whether it was signed, and its status is null unless the CSV says completed. A PDF with neither is not brought in and is listed. The server checks none of what the files say. They are never counted as signed here and never shown by POST /public/verify as completed here. Envelopes not completed on DocuSign, and CSV rows without their PDF, are listed. When nothing came in and something is listed, the screen says nothing was brought in and why. Templates are mapped to our fields where there is a match; the rest is listed. The layouts read are DocuSign\'s documented ones; they have not yet been checked against real downloads.',
    requestBody: upload, responses: ok(report),
  } },
  '/imported': { get: { summary: 'Records brought in (owners, admins)', responses: ok({ type: 'object', properties: { records: { type: 'array', items: record } } }) } },
  '/imported/count': { get: { summary: 'How many records were brought in (owners, admins)', responses: ok({ type: 'object', properties: { count: { type: 'integer' } } }) } },
  '/imported/{id}': {
    parameters: [idParam],
    get: { summary: 'One record brought in, with everything that came with it', responses: ok({ type: 'object', properties: { record } }) },
    delete: { summary: 'Delete a record brought in', description: 'For good, with its files once nothing else holds them. It does not touch the document where it was signed.', responses: ok({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
  },
  '/imported/{id}/files/{sha256}': { parameters: [idParam, { name: 'sha256', in: 'path', required: true, schema: s }], get: { summary: 'A file of a record brought in, exactly as it came', responses: { 200: { description: 'The file' }, default: err } } },
});
