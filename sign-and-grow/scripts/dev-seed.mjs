// Fills a running dev server with realistic data so screens can be looked at and tested.
//   node scripts/dev-seed.mjs http://localhost:3000
// Needs the dev outbox (no SMTP_URL). Prints the login, the envelopes it made and their signing links as JSON.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const stamp = Date.now().toString(36);
const email = process.env.SEED_EMAIL || `demo-${stamp}@example.org`;
const password = 'plant-more-trees';
let cookie = '';

async function api(path, { method, body, form } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: method || (body || form ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie, origin: BASE },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method || 'GET'} ${path}: ${res.status} ${data.error || ''}`);
  return data;
}

async function pdf(title, pages = 2) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pages; p++) {
    const page = d.addPage([612, 792]);
    page.drawText(p === 0 ? title : 'Signatures', { x: 72, y: 700, size: 22, font: bold });
    const lines = p === 0
      ? ['This agreement is made between the Planting Partner and the Sponsor.', 'The Sponsor agrees to fund the planting and care of mangrove seedlings', 'along the agreed stretch of coastline for a period of three years.', '', 'Number of seedlings pledged: ______________________', '', 'Full name: ______________________     Date: ______________']
      : ['Signature: ______________________', '', 'Name: ______________________', '', 'Date: ______________________', '', 'Initials: ______'];
    lines.forEach((l, i) => page.drawText(l, { x: 72, y: 650 - i * 28, size: 12, font }));
  }
  return new Blob([await d.save()], { type: 'application/pdf' });
}

async function upload(title) {
  const form = new FormData();
  form.append('file', await pdf(title), `${title}.pdf`);
  return api('/files', { form });
}

const outbox = async () => (await api('/dev/outbox')).emails;
const linkFor = async (to, part = '/sign/') => (await outbox()).find((m) => m.to_email === to && m.link?.includes(part))?.link;

await api('/auth/signup', { body: { name: 'Demo Sender', email, password } });
const verify = (await outbox()).find((m) => m.to_email === email && m.link?.includes('verify-email'));
await api('/auth/verify', { body: { token: new URL(verify.link).searchParams.get('token') } });

const out = { base: BASE, login: { email, password }, cookie, envelopes: {} };

async function make(name, recipients, send = true, extra = {}) {
  const file = await upload(name);
  const body = {
    subject: `Please sign: ${name}`, message: 'Thanks for supporting the mangroves.', ...extra,
    documents: [{ id: 'd1', file_id: file.id, name }],
    recipients: recipients.map((r, i) => ({ id: `r${i}`, routing_order: i + 1, role: 'signer', ...r })),
    fields: recipients.flatMap((r, i) => (r.role && r.role !== 'signer' ? [] : [
      { document_id: 'd1', recipient_id: `r${i}`, type: 'text', label: 'Seedlings pledged', page: 0, x: 0.47, y: 0.305 + i * 0.04, w: 0.22, h: 0.028 },
      { document_id: 'd1', recipient_id: `r${i}`, type: 'signature', page: 1, x: 0.25 + i * 0.3, y: 0.15, w: 0.24, h: 0.055 },
      { document_id: 'd1', recipient_id: `r${i}`, type: 'date_signed', page: 1, x: 0.2 + i * 0.3, y: 0.3, w: 0.16, h: 0.028 },
    ])),
  };
  const { envelope } = await api('/envelopes', { body });
  if (send) await api(`/envelopes/${envelope.id}/send`, { method: 'POST' });
  const links = {};
  for (const r of recipients) if (send) links[r.email] = await linkFor(r.email);
  out.envelopes[name] = { id: envelope.id, links };
  return envelope.id;
}

const s = stamp;
// The voided one goes first: voiding hands its signature back, so a new account's free signatures cover the rest.
const steps = [
  async () => {
    const voidId = await make('Voided agreement', [{ name: 'Eve Early', email: `eve-${s}@example.org` }]);
    await api(`/envelopes/${voidId}/void`, { body: { reason: 'Sent the wrong version' } });
  },
  () => make('Draft agreement', [{ name: 'Ada Sponsor', email: `ada-${s}@example.org` }], false),
  () => make('Waiting agreement', [{ name: 'Ada Sponsor', email: `ada-${s}@example.org` }, { name: 'Ben Partner', email: `ben-${s}@example.org` }, { name: 'Cee Copy', email: `cee-${s}@example.org`, role: 'cc' }], true, { ordered: true }),
  () => make('Code agreement', [{ name: 'Dee Careful', email: `dee-${s}@example.org`, access_code: '4242' }]),
];
out.problems = [];
for (const step of steps) await step().catch((e) => out.problems.push(e.message));

console.log(JSON.stringify(out, null, 2));
