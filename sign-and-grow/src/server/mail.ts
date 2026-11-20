import { run, get, all, saveBlob, readBlob } from './db.ts';
import { esc, now, baseUrl, fmtCode } from './util.ts';
import { PRICING } from '../lib/impact.ts';
import { cannotOpenLine } from '../lib/policy.ts';

export type Mail = {
  to: string;
  subject: string;
  heading: string;
  lines: string[]; // plain text paragraphs, escaped here
  cta?: { label: string; url: string };
  links?: { label: string; url: string; note?: string }[]; // a list of documents, each with its own link
  envelopeId?: string;
  recipientId?: string; // which recipient this was for, so two people sharing an address are not mixed up
  about?: string | null; // the login (user id) this email to somebody else is about; our copy goes when that login does
  brand?: { name?: string; color?: string | null; logo?: string | null };
  footnote?: string;
  attachments?: { filename: string; content: Buffer }[];
  replyTo?: string; // replies go to a person, never to a dead no-reply box
  fromName?: string; // shown as "<name> via Sign&Grow"
  code?: string; // security code the recipient can type into /check
  // The sender's name, on an email that asks someone to open a signing page and whose replies reach that sender.
  // The footer then says what to do when the page will not open where the reader is: ask the sender for a PDF.
  askForPdf?: string;
  expiresAt?: string; // when a one-time link or code in it stops working. It is never sent again after that.
};

// What became of an email at hand-over: the mail server took it, there is no mail server (it sits in the outbox
// and nobody receives it), or the mail server would not take it (it is tried again by the timer).
export type MailStatus = 'sent' | 'outbox' | 'failed';

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

// "Report this email": the check page with the security code filled in. Reporting from there needs no signing link.
const reportUrl = (code: string) => `${baseUrl()}/check?code=${fmtCode(code)}&report=1`;

// A line of an email may hold a word with nowhere to break, such as a SHA-256 fingerprint or a long address. Lines
// wrap anywhere (overflow-wrap), so the email never becomes wider than the phone it is read on.
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
    ${m.lines.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">${esc(l)}</p>`).join('')}
    ${(m.links || []).map((l) => `<p style="font-size:15px;line-height:1.45;margin:0 0 12px"><a href="${esc(l.url)}" style="color:${color};font-weight:600">${esc(l.label)}</a>${l.note ? `<br><span style="font-size:13px;color:#6b776f">${esc(l.note)}</span>` : ''}</p>`).join('')}
    ${m.cta ? `<p style="margin:24px 0 8px"><a href="${esc(m.cta.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:10px;font-size:15px">${esc(m.cta.label)}</a></p>` : ''}
    ${m.footnote ? `<p style="font-size:12px;color:#6b776f;margin:18px 0 0;line-height:1.5">${esc(m.footnote)}</p>` : ''}
  </div>
  ${m.code ? `<div style="background:#fff;border:1px solid #e4dfd3;border-radius:14px;padding:16px 20px;margin-top:12px;font-size:13px;line-height:1.55;color:#1c2a22">
    <b>Not sure this email is real?</b> Do not click anything. Type <b>${esc(baseUrl().replace(/^https?:\/\//, ''))}/check</b> into your browser yourself and enter this security code:
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;letter-spacing:1px;font-weight:700;margin:8px 0 4px">${esc(fmtCode(m.code))}</div>
    We will tell you who sent it and open the document for you. Sign&amp;Grow never asks for a password, a card number or a payment by email.
    <div style="margin-top:8px">Did not expect this, or does it look wrong? <a href="${esc(reportUrl(m.code))}" style="color:#1c2a22;font-weight:600">Report this email</a>. That opens our check page with this code filled in. You do not have to open the document to report it.</div>
  </div>` : ''}
  <p style="font-size:12px;color:#6b776f;line-height:1.6;padding:16px 4px 0">
    ${m.envelopeId || m.links
    // Emails about a document go to people who only came to sign. The pages promise them no marketing, so these end
    // with where the email came from and nothing that sells. Emails to an account's own people keep the full line.
    ? 'Signed digitally, so no paper, no printer and no courier. Sent with Sign&amp;Grow.'
    : `Signed digitally, so no paper, no printer and no courier. Sent with Sign&amp;Grow, where every dollar plants ${PRICING.treesPerUsd} mangrove trees with Treegens.`}
    ${m.cta ? `<br>If the button does not work, copy this link: ${esc(m.cta.url)}` : ''}
    ${m.askForPdf ? `<br>${esc(cannotOpenLine(m.askForPdf))}` : ''}
    ${m.code ? '<br>Do not forward this email. The link is personal to you.' : ''}
    <br>Need a hand? ${esc(baseUrl())}/help
  </p>
</div></body></html>`;
}

// ---- Sending, and trying again ---------------------------------------------------------------
//
// An email the mail server would not take is not lost and not called sent. It stays 'failed' with the server's
// answer and is tried again by the timer with growing gaps. After the last try nobody tries again, and whoever
// listens (see onMailOutcome) is told, so a person can reach the recipient another way.

/** Minutes to wait before each further try. Six tries in all, the last about a day and a half after the first. */
export const MAIL_RETRY_MINUTES = [5, 30, 120, 360, 1440];
// An email is never sent more than two days late: by then what it says (a deadline, a reminder) may be wrong.
const MAIL_MAX_AGE_MS = 2 * 864e5;
// A row still 'queued' after this long was left by a process that stopped while sending it.
const MAIL_STUCK_MS = 15 * 60_000;

/** 'delayed': the first try failed and more follow. 'sent': a later try went through. 'gave_up': no more tries. */
export type MailOutcome = 'delayed' | 'sent' | 'gave_up';
type MailListener = (email: any, what: MailOutcome) => void | Promise<void>;
// Kept on globalThis under a name, so a module that is loaded twice (a dev server reloading) listens once.
const listeners: Record<string, MailListener> = (g.__tsmailListeners ??= {});
/** Lets the code that owns an email's subject matter (an envelope, say) record what became of it. */
export const onMailOutcome = (name: string, fn: MailListener) => void (listeners[name] = fn);
async function tell(id: number | bigint, what: MailOutcome) {
  const email = get('SELECT id, to_email, subject, envelope_id, recipient_id, status, error, tries, at FROM emails WHERE id=?', id);
  for (const fn of Object.values(listeners)) {
    try {
      await fn(email, what);
    } catch (e: any) {
      console.error('[mail] could not record what happened to an email', e?.message);
    }
  }
}

// One try at handing a recorded email to the mail server. Everything it needs is on the row. `again` is a try made
// by the timer: when that one goes through, whoever listens hears that the email left after all.
async function deliver(id: number | bigint, again = false): Promise<MailStatus> {
  const row = get('SELECT * FROM emails WHERE id=?', id);
  try {
    const t = await transport();
    if (!t) {
      run("UPDATE emails SET status='outbox' WHERE id=?", id);
      return 'outbox';
    }
    const p = JSON.parse(row.payload || '{}');
    await t.sendMail({
      from: p.from || fromHeader(), replyTo: p.replyTo || undefined, to: row.to_email, subject: row.subject, html: row.html, text: p.text || undefined,
      attachments: (p.attachments || []).map((a: any) => ({ filename: a.filename, content: readBlob(a.sha256) })),
    });
    run("UPDATE emails SET status='sent', error=NULL, tries=tries+1, tried_at=?, next_try_at=NULL WHERE id=?", now(), id);
    if (again) await tell(id, 'sent');
    return 'sent';
  } catch (e: any) {
    const tries = row.tries + 1;
    const wait = MAIL_RETRY_MINUTES[tries - 1];
    run("UPDATE emails SET status='failed', error=?, tries=?, tried_at=?, next_try_at=? WHERE id=?", String(e?.message || e).slice(0, 500), tries, now(), wait ? new Date(Date.now() + wait * 60_000).toISOString() : null, id);
    console.error('[mail] failed', row.to_email, e?.message);
    if (!wait) await tell(id, 'gave_up');
    else if (tries === 1) await tell(id, 'delayed');
    return 'failed';
  }
}

// Every message is recorded. With SMTP_URL set it is also delivered; without it, it shows up in the dev outbox.
// The answer says which, so nothing has to claim an email was sent when it was not.
export async function sendMail(m: Mail): Promise<MailStatus> {
  const html = renderMail(m);
  // What a later try needs besides the html. Attachments go to the file store (a signed PDF is there already) and
  // the row only names them.
  const payload = {
    from: fromHeader(m.fromName), replyTo: m.replyTo || process.env.SUPPORT_EMAIL || null,
    text: [m.heading, ...m.lines, ...(m.links || []).map((l) => `${l.label}${l.note ? ` (${l.note})` : ''}: ${l.url}`), m.cta ? `${m.cta.label}: ${m.cta.url}` : '', m.footnote || '',
      m.askForPdf ? cannotOpenLine(m.askForPdf) : '',
      m.code ? `Not sure this email is real? Go to ${baseUrl()}/check and enter the security code ${fmtCode(m.code)}.` : '',
      m.code ? `Did not expect this, or does it look wrong? Report this email: ${reportUrl(m.code)}` : ''].filter(Boolean).join('\n\n'),
    attachments: process.env.SMTP_URL ? (m.attachments || []).map((a) => ({ filename: a.filename, sha256: saveBlob(a.content) })) : [],
  };
  const r = run(
    'INSERT INTO emails (to_email, subject, html, link, envelope_id, recipient_id, status, at, payload, expires_at, about_user) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    m.to, m.subject, html, m.cta?.url ?? null, m.envelopeId ?? null, m.recipientId ?? null, 'queued', now(), JSON.stringify(payload), m.expiresAt ?? null, m.about ?? null,
  );
  return deliver(r.lastInsertRowid);
}

// Why an email that is waiting for another try must not go out any more, or null when it may. `quiet` is for an email
// that something newer has made pointless: nobody needs to hear that it was dropped.
function tooLate(row: any): { why: string; quiet: boolean } | null {
  // A row from before emails were tried again holds nothing to send it with. It is left as it was found.
  if (!row.payload) return { why: 'Not sent again: it was recorded before emails could be tried again.', quiet: true };
  // A one-time link or code that has run out would only lead to an error page (a password reset, say).
  if (row.expires_at && row.expires_at <= now()) return { why: 'Not sent again: the link or code in it had expired by then.', quiet: true };
  // A signing link is only worth sending while it still opens the document. If the address or the person was
  // changed since, a newer email has gone to the right place. If the envelope was voided or ran out of time,
  // everyone was told that instead.
  const signing = /\/sign\/([\w-]+)/.exec(row.link || '')?.[1];
  if (signing && !['sent', 'completed'].includes(get('SELECT e.status FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.token=?', signing)?.status))
    return { why: 'Not sent again: its link no longer opens the document.', quiet: true };
  if (Date.now() - Date.parse(row.at) > MAIL_MAX_AGE_MS) return { why: 'Not sent again: it would have arrived more than two days late.', quiet: false };
  return null;
}

/**
 * Called by the timer (see cron.ts). Tries every email again whose next try is due, and picks up emails that were
 * left 'queued' because the process stopped while sending them. Returns what it did.
 */
export async function retryMail(): Promise<{ sent: number; failed: number; dropped: number }> {
  const done = { sent: 0, failed: 0, dropped: 0 };
  const t = now(), stuck = new Date(Date.now() - MAIL_STUCK_MS).toISOString();
  const isDue = "((status='failed' AND next_try_at IS NOT NULL AND next_try_at <= ?) OR (status='queued' AND COALESCE(tried_at, at) < ?))";
  for (const { id } of all(`SELECT id FROM emails WHERE ${isDue} ORDER BY id LIMIT 200`, t, stuck)) {
    // The timer can run twice at once (the built-in one and a scheduler calling /api/cron). Each email is claimed
    // by one statement before it is tried, so the other run passes it over and nobody gets it twice.
    const lease = new Date(Date.now() + MAIL_STUCK_MS).toISOString();
    if (!run(`UPDATE emails SET tried_at=?, next_try_at=CASE WHEN status='failed' THEN ? ELSE next_try_at END WHERE id=? AND ${isDue}`, t, lease, id, t, stuck).changes) continue;
    const no = tooLate(get('SELECT * FROM emails WHERE id=?', id));
    if (no) {
      run("UPDATE emails SET status='failed', next_try_at=NULL, error=COALESCE(error || ' ', '') || ? WHERE id=?", no.why, id);
      if (!no.quiet) await tell(id, 'gave_up');
      done.dropped++;
      continue;
    }
    const how = await deliver(id, true);
    if (how === 'sent') done.sent++;
    else if (how === 'failed') done.failed++;
  }
  return done;
}
