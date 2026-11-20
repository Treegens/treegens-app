import { run } from './db.ts';
import { esc, now, baseUrl, fmtCode } from './util.ts';
import { PRICING } from '../lib/impact.ts';

export type Mail = {
  to: string;
  subject: string;
  heading: string;
  lines: string[]; // plain text paragraphs, escaped here
  cta?: { label: string; url: string };
  links?: { label: string; url: string; note?: string }[]; // a list of documents, each with its own link
  envelopeId?: string;
  brand?: { name?: string; color?: string | null; logo?: string | null };
  footnote?: string;
  attachments?: { filename: string; content: Buffer }[];
  replyTo?: string; // replies go to a person, never to a dead no-reply box
  fromName?: string; // shown as "<name> via Sign&Grow"
  code?: string; // security code the recipient can type into /check
};

const g = globalThis as any;

async function transport() {
  if (!process.env.SMTP_URL) return null;
  if (!g.__tsmail) {
    const nodemailer = (await import('nodemailer')).default;
    g.__tsmail = nodemailer.createTransport(process.env.SMTP_URL);
  }
  return g.__tsmail;
}

// "Ada Lovelace via Sign&Grow" <sign@example.com>: recipients see who it is from before they open it.
function fromHeader(name?: string): string {
  const base = process.env.MAIL_FROM || '"Sign&Grow" <no-reply@localhost>';
  if (!name) return base;
  const address = /<([^>]+)>/.exec(base)?.[1] || base.trim();
  return `"${name.replace(/["\\\r\n<>]/g, '')} via Sign&Grow" <${address}>`;
}

export function renderMail(m: Mail): string {
  const color = /^#[0-9a-f]{6}$/i.test(m.brand?.color || '') ? m.brand!.color! : '#1f6f43';
  const logo = m.brand?.logo?.startsWith('data:image/')
    ? `<img src="${esc(m.brand.logo)}" alt="${esc(m.brand?.name || '')}" style="max-height:40px;max-width:200px">`
    : `<span style="font-size:18px;font-weight:700;color:${color}">${esc(m.brand?.name || 'Sign&Grow')}</span>`;
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2a22">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="padding:0 4px 16px">${logo}</div>
  <div style="background:#fff;border-radius:14px;padding:32px;border:1px solid #e4dfd3">
    <h1 style="font-size:20px;margin:0 0 16px;line-height:1.3">${esc(m.heading)}</h1>
    ${m.lines.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;white-space:pre-wrap">${esc(l)}</p>`).join('')}
    ${(m.links || []).map((l) => `<p style="font-size:15px;line-height:1.45;margin:0 0 12px"><a href="${esc(l.url)}" style="color:${color};font-weight:600">${esc(l.label)}</a>${l.note ? `<br><span style="font-size:13px;color:#6b776f">${esc(l.note)}</span>` : ''}</p>`).join('')}
    ${m.cta ? `<p style="margin:24px 0 8px"><a href="${esc(m.cta.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:10px;font-size:15px">${esc(m.cta.label)}</a></p>` : ''}
    ${m.footnote ? `<p style="font-size:12px;color:#6b776f;margin:18px 0 0;line-height:1.5">${esc(m.footnote)}</p>` : ''}
  </div>
  ${m.code ? `<div style="background:#fff;border:1px solid #e4dfd3;border-radius:14px;padding:16px 20px;margin-top:12px;font-size:13px;line-height:1.55;color:#1c2a22">
    <b>Not sure this email is real?</b> Do not click anything. Type <b>${esc(baseUrl().replace(/^https?:\/\//, ''))}/check</b> into your browser yourself and enter this security code:
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;letter-spacing:1px;font-weight:700;margin:8px 0 4px">${esc(fmtCode(m.code))}</div>
    We will tell you who sent it and open the document for you. Sign&amp;Grow never asks for a password, a card number or a payment by email.
  </div>` : ''}
  <p style="font-size:12px;color:#6b776f;line-height:1.6;padding:16px 4px 0">
    Signed digitally, so no paper, no printer and no courier. Sent with Sign&amp;Grow, where every dollar plants ${PRICING.treesPerUsd} mangrove trees with Treegens.
    ${m.cta ? `<br>If the button does not work, copy this link: ${esc(m.cta.url)}` : ''}
    ${m.code ? '<br>Do not forward this email. The link is personal to you.' : ''}
    <br>Need a hand? ${esc(baseUrl())}/help
  </p>
</div></body></html>`;
}

// Every message is recorded. With SMTP_URL set it is also delivered; without it, it shows up in the dev outbox.
export async function sendMail(m: Mail): Promise<void> {
  const html = renderMail(m);
  const r = run(
    'INSERT INTO emails (to_email, subject, html, link, envelope_id, status, at) VALUES (?,?,?,?,?,?,?)',
    m.to, m.subject, html, m.cta?.url ?? null, m.envelopeId ?? null, 'queued', now(),
  );
  try {
    const t = await transport();
    if (!t) {
      run("UPDATE emails SET status='outbox' WHERE id=?", r.lastInsertRowid);
      return;
    }
    await t.sendMail({
      from: fromHeader(m.fromName),
      replyTo: m.replyTo || process.env.SUPPORT_EMAIL || undefined,
      to: m.to,
      subject: m.subject,
      html,
      text: [m.heading, ...m.lines, ...(m.links || []).map((l) => `${l.label}${l.note ? ` (${l.note})` : ''}: ${l.url}`), m.cta ? `${m.cta.label}: ${m.cta.url}` : '', m.footnote || '',
        m.code ? `Not sure this email is real? Go to ${baseUrl()}/check and enter the security code ${fmtCode(m.code)}.` : ''].filter(Boolean).join('\n\n'),
      attachments: m.attachments,
    });
    run("UPDATE emails SET status='sent' WHERE id=?", r.lastInsertRowid);
  } catch (e: any) {
    run("UPDATE emails SET status='failed', error=? WHERE id=?", String(e?.message || e).slice(0, 500), r.lastInsertRowid);
    console.error('[mail] failed', m.to, e?.message);
  }
}
