// Shared test plumbing: a throwaway database, an in-process HTTP client, and a few fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-'));
process.env.APP_URL = 'http://test.local';

export type Server = {
  db: typeof import('../src/server/db.ts');
  env: typeof import('../src/server/envelopes.ts');
  billing: typeof import('../src/server/routes-billing.ts');
  cron: typeof import('../src/server/cron.ts');
};
let handle: (req: Request) => Promise<Response>;
let server: Server;

export async function boot(): Promise<Server> {
  await import('../src/server/routes-account.ts');
  await import('../src/server/routes-signin.ts');
  await import('../src/server/routes-envelopes.ts');
  await import('../src/server/routes-sign.ts');
  await import('../src/server/routes-signercode.ts');
  await import('../src/server/routes-groups.ts');
  await import('../src/server/routes-bounces.ts');
  await import('../src/server/routes-trust.ts');
  await import('../src/server/routes-support.ts');
  await import('../src/server/routes-paylink.ts');
  await import('../src/server/routes-templates.ts');
  await import('../src/server/routes-evidence.ts');
  await import('../src/server/routes-witness.ts');
  await import('../src/server/routes-comments.ts');
  await import('../src/server/routes-twostep.ts');
  await import('../src/server/routes-clickwrap.ts');
  await import('../src/server/routes-stamps.ts');
  await import('../src/server/routes-chat.ts');
  await import('../src/server/routes-seclog.ts');
  await import('../src/server/routes-retention.ts');
  await import('../src/server/routes-selfhost.ts');
  await import('../src/server/routes-archive.ts');
  await import('../src/server/routes-customfields.ts');
  await import('../src/server/routes-seal.ts');
  await import('../src/server/routes-impact.ts');
  await import('../src/server/routes-convert.ts');
  await import('../src/server/openapi.ts');
  const billing = await import('../src/server/routes-billing.ts');
  handle = (await import('../src/server/router.ts')).handle;
  server = { db: await import('../src/server/db.ts'), env: await import('../src/server/envelopes.ts'), billing, cron: await import('../src/server/cron.ts') };
  return server;
}

export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class Client {
  cookies: Record<string, string> = {};
  ip = '203.0.113.9';
  async call(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
    const init: any = { method, headers: { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': this.ip, ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) (init.body = JSON.stringify(body)), (init.headers['content-type'] = 'application/json');
    const res = await handle(new Request(`http://test.local/api${url}`, init));
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) } as { status: number; data: any };
  }
  get = (u: string) => this.call('GET', u);
  post = (u: string, b: any = {}) => this.call('POST', u, b);
  put = (u: string, b: any = {}) => this.call('PUT', u, b);
}

// A signed-up user whose email is confirmed, ready to send.
export async function signUp(name: string, email: string, ip?: string): Promise<Client> {
  const c = new Client();
  if (ip) c.ip = ip; // sign-ups are limited per address; tests that make many people give each their own
  const r = await c.post('/auth/signup', { name, email, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = server.db.get('SELECT verify_token t FROM users WHERE email=?', email).t;
  // In the browser that signed up: the link confirms nothing for a browser that is not signed in to the login.
  assert.equal((await c.post('/auth/verify', { token: t })).status, 200);
  return c;
}

export async function samplePdf(pages = 2) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([612, 792]).drawText(`Agreement page ${i + 1}`, { x: 72, y: 700 });
  return d.save();
}

export async function upload(c: Client, pages = 2) {
  const f = new FormData();
  f.append('file', new Blob([await samplePdf(pages)], { type: 'application/pdf' }), 'Agreement.pdf');
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

export const tokenFor = (envelopeId: string, email: string) => server.db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', envelopeId, email).token;
export const mailTo = (email: string) => server.db.all('SELECT subject, html, link FROM emails WHERE to_email=? ORDER BY id', email);

// Two signers in order (the second behind an access code) and someone who gets a copy.
export async function draft(c: Client, over: any = {}) {
  const file = await upload(c);
  const body = {
    subject: 'Tree planting agreement', message: 'Please sign.', ordered: true,
    documents: [{ id: 'd1', file_id: file.id, name: 'Agreement' }],
    recipients: [
      { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada@example.com', routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben@example.com', routing_order: 2, access_code: '4242' },
      { id: 'r3', role: 'cc', name: 'Cee Copy', email: 'cee@example.com', routing_order: 3 },
    ],
    fields: [
      { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'f2', document_id: 'd1', recipient_id: 'r1', type: 'text', label: 'Trees pledged', page: 0, x: 0.1, y: 0.7, w: 0.25, h: 0.03 },
      { id: 'f3', document_id: 'd1', recipient_id: 'r1', type: 'date_signed', page: 0, x: 0.4, y: 0.8, w: 0.2, h: 0.03 },
      { id: 'f4', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'f5', document_id: 'd1', recipient_id: 'r2', type: 'checkbox', page: 1, x: 0.1, y: 0.7, w: 0.03, h: 0.02, required: false },
    ],
    ...over,
  };
  const r = await c.post('/envelopes', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

// One signer, one signature. The smallest thing that can be sent.
export async function simple(c: Client, email = 'sam@example.com', over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Simple agreement',
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

export async function signAll(envelopeId: string, email: string, extra: Record<string, string> = {}) {
  const c = new Client();
  const tok = tokenFor(envelopeId, email);
  await c.post(`/sign/${tok}/consent`);
  const v = (await c.get(`/sign/${tok}`)).data;
  const values: Record<string, string> = { ...extra };
  // A date field takes a real day written year-month-day (isDateValue in src/lib/dates.ts).
  for (const f of v.fields || []) if (!(f.id in values)) values[f.id] = f.type === 'text' ? 'filled in' : f.type === 'date' ? '2026-01-15' : '1';
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG });
}
