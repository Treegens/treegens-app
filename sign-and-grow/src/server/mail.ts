import { run, get, all, saveBlob, readBlob } from './db.ts';
import { esc, now, baseUrl, fmtCode, sha256, token, HttpError } from './util.ts';
import { PRICING } from '../lib/impact.ts';
import { cannotOpenLine } from '../lib/policy.ts';
// Copies for the account's archive addresses (archivemail.ts) and the rule that an email is not handed over unencrypted.
import { archiveDraft, takeArchiveCopies, markArchiveRow, archiveCheck, noteArchiveSent, ARCHIVE_NOT_WAITING } from './archivemail.ts';
import { smtpRequireTls, tlsRefusal } from '../lib/mailtls.ts';
// Our words in the reader's language (lang-mail): the footer below and the lines of the text part.
import { mt, mailHtml, mailLangAttrs, listIn, storedLocale, mailLine, unquote } from './maillang.ts';
import { withSentBy } from './sentfor.ts';
import { seal } from './colcrypt.ts';

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
  fromName?: string; // shown as "<name> via GrowSigning"
  code?: string; // security code the recipient can type into /check
  // The sender's name, on an email that asks someone to open a signing page and whose replies reach that sender.
  // The footer then says what to do when the page will not open where the reader is: ask the sender for a PDF.
  askForPdf?: string;
  expiresAt?: string; // when a one-time link or code in it stops working. It is never sent again after that.
  // True on an email that asks its recipient (recipientId) to do something: sign, approve, look again. A later try
  // does not deliver it once that person has finished or declined.
  untilDone?: boolean;
  // An email about a help request (src/server/routes-support.ts). It is about no document, and it often goes to
  // someone who only came to sign, so it ends with where it came from and nothing about signing or selling.
  help?: boolean;
  // A short email to someone about their own login, such as the confirmation code: the footer is the help address
  // only, without the line about paper and trees or the copy of the button's link.
  brief?: boolean;
  // An email that asks its reader to send something on paper ("Sign on paper instead", src/server/disclosure.ts):
  // the footer leaves out its line about no paper, no printer and no courier.
  onPaper?: boolean;
  // The language of our own words in it (the footer and whatever the caller wrote from en.json), for a recipient:
  // mailLocale in maillang.ts. Left out, English. Kept on the row, so a later try is the same email.
  locale?: string;
};

// What became of an email at hand-over: the mail server took it, there is no mail server (it sits in the outbox
// and nobody receives it), or the mail server would not take it (it is tried again by the timer).
export type MailStatus = 'sent' | 'outbox' | 'failed';

const g = globalThis as any;

async function transport() {
  if (!process.env.SMTP_URL) return null;
  if (!g.__tsmail) {
    const nodemailer = (await import('nodemailer')).default;
    g.__tsmail = nodemailer.createTransport(transportOptions());
  }
  return g.__tsmail;
}

/** What the mail library is given: the address in SMTP_URL with our time limits, and requireTLS with SMTP_REQUIRE_TLS. */
export function transportOptions(smtpUrl = process.env.SMTP_URL || ''): { url: string; requireTLS?: true } {
  // A mail server that takes the connection and then says nothing must not hold up whatever is waiting for this
  // email (a payment step, say) for nodemailer's own limits of up to ten minutes. These limits apply unless the
  // address names its own (?connectionTimeout=...&greetingTimeout=...&socketTimeout=..., in milliseconds).
  let url = smtpUrl;
  const tls = smtpRequireTls();
  try {
    const u = new URL(url);
    for (const [k, v] of [['connectionTimeout', '10000'], ['greetingTimeout', '10000'], ['socketTimeout', '20000']]) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    // Nothing in the address switches the rule off: the library reads the address last, and its requireTLS wins over
    // ignoreTLS and opportunisticTLS. Without STARTTLS it refuses to hand the email over (src/lib/mailtls.ts).
    if (tls) u.searchParams.set('requireTLS', 'true');
    url = u.toString();
  } catch {}
  return tls ? { url, requireTLS: true } : { url };
}

// "Ada Lovelace via GrowSigning" <sign@example.com>: recipients see who it is from before they open it.
function fromHeader(name?: string): string {
  const base = process.env.MAIL_FROM || '"GrowSigning" <no-reply@localhost>';
  if (!name) return base;
  const address = /<([^>]+)>/.exec(base)?.[1] || base.trim();
  return `"${name.replace(/["\\\r\n<>]/g, '')} via GrowSigning" <${address}>`;
}

// "Report this email": the check page with the security code filled in. Reporting from there needs no signing link.
const reportUrl = (code: string) => `${baseUrl()}/check?code=${fmtCode(code)}&report=1`;
// "Get help with this document": the help form with the topic chosen and the same security code, so the message
// says which document it is about and its sender can be told. The signing link's own secret is never put in it.
export const helpUrl = (code: string) => `${baseUrl()}/help?topic=signing&code=${fmtCode(code)}#contact`;

// A line of an email may hold a word with nowhere to break, such as a SHA-256 fingerprint or a long address. Lines
// wrap anywhere (overflow-wrap), so the email never becomes wider than the phone it is read on.
export function renderMail(m: Mail): string {
  const L = m.locale || 'en';
  const color = /^#[0-9a-f]{6}$/i.test(m.brand?.color || '') ? m.brand!.color! : '#1f6f43';
  // The sender's logo, else the sender's name, else ours: the drawn logo as a picture loaded from APP_URL (until the app
  // is public, mail programs show its alt text, "GrowSigning"). Every email has a light header, so it is always the
  // logo for light grounds. The picture carries a tile of this email's ground colour (#f4f1ea, scripts/build-brand.mjs),
  // which cannot be seen here; a mail program that darkens the ground and leaves pictures alone then shows the dark
  // word "signing" on that light tile instead of dark on dark. public/brand/email-logo-dark.png is not used.
  const ours = !m.brand?.logo?.startsWith('data:image/') && !m.brand?.name; // the tile's own edge is its padding
  const logo = m.brand?.logo?.startsWith('data:image/')
    ? `<img src="${esc(m.brand.logo)}" alt="${esc(m.brand?.name || '')}" style="max-height:40px;max-width:200px">`
    : m.brand?.name
      ? `<span style="font-size:18px;font-weight:700;color:${color}">${esc(m.brand.name)}</span>`
      : `<img src="${esc(baseUrl())}/brand/email-logo.png" width="156" height="32" alt="GrowSigning" style="display:block;border:0;width:156px;height:32px;color:#1f6f43;font-size:18px;font-weight:700">`;
  return `<!doctype html><html ${mailLangAttrs(L)}><body style="margin:0;background:#f4f1ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2a22">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="padding:${ours ? '0 0 11px' : '0 4px 16px'}">${logo}</div>
  <div style="background:#fff;border-radius:14px;padding:32px;border:1px solid #e4dfd3">
    <h1 style="font-size:20px;margin:0 0 16px;line-height:1.3">${esc(m.heading)}</h1>
    ${m.lines.map(mailLine).join('')}
    ${(m.links || []).map((l) => `<p style="font-size:15px;line-height:1.45;margin:0 0 12px"><a href="${esc(l.url)}" style="color:${color};font-weight:600">${esc(l.label)}</a>${l.note ? `<br><span style="font-size:13px;color:#6b776f">${esc(l.note)}</span>` : ''}</p>`).join('')}
    ${m.cta ? `<p style="margin:24px 0 8px"><a href="${esc(m.cta.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:10px;font-size:15px">${esc(m.cta.label)}</a></p>` : ''}
    ${m.footnote ? `<p style="font-size:12px;color:#6b776f;margin:18px 0 0;line-height:1.5;overflow-wrap:anywhere;word-break:break-word">${esc(m.footnote)}</p>` : ''}
  </div>
  <p style="font-size:12px;color:#6b776f;line-height:1.6;padding:16px 4px 0;overflow-wrap:anywhere;word-break:break-word">
    ${m.code
    // One short footer on an email with a signing link (research/ux-charter.md, quick win 12): how to check that the
    // email is real without clicking anything in it, how to report it, and the link itself when the button fails.
    // Every part in the reader's language (maillang.ts); English reads as it always has.
    ? `<b style="color:#1c2a22">${esc(mt(L, 'mail.footer.not_sure'))}</b> ${mailHtml(L, 'mail.footer.type_code', { address: `<b style="color:#1c2a22">${esc(baseUrl().replace(/^https?:\/\//, ''))}/check</b>`, code: `<b style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#1c2a22;white-space:nowrap;letter-spacing:1px">${esc(fmtCode(m.code))}</b>` })} ${esc(mt(L, 'mail.footer.never_ask'))} <a href="${esc(reportUrl(m.code))}" style="color:#1c2a22;font-weight:600">${esc(mt(L, 'mail.footer.report'))}</a><br>`
    : ''}
    ${m.cta && !m.brief ? `${esc(mt(L, 'mail.footer.button_link', { url: m.cta.url }))}<br>` : ''}
    ${m.askForPdf ? `${esc(mt(L, 'mail.footer.cannot_open', { sender: m.askForPdf }))}<br>` : ''}
    ${m.code ? `${esc(mt(L, 'mail.footer.personal'))}<br>` : ''}
    ${m.code ? `<a href="${esc(helpUrl(m.code))}" style="color:#6b776f;font-weight:600">${esc(mt(L, 'mail.footer.get_help'))}</a>` : esc(mt(L, 'mail.footer.need_hand', { url: `${baseUrl()}/help` }))}
    ${m.brief ? '' : m.help ? `<br>${esc(mt(L, 'mail.footer.from_help'))}` : m.envelopeId || m.links
    // Emails about a document go to people who only came to sign. The pages promise them no marketing, so these end
    // with where the email came from and nothing that sells. Emails to an account's own people keep the full line.
    ? `<br>${m.code || m.onPaper ? '' : `${esc(mt(L, 'mail.footer.no_paper'))} `}${esc(mt(L, 'mail.footer.sent_with'))}`
    : `<br>${esc(mt(L, 'mail.footer.no_paper'))} ${esc(mt(L, 'mail.footer.trees', { trees: String(PRICING.treesPerUsd) }))}`}
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

// ---- Ids the mail provider hands back ----------------------------------------------------------
//
// Hand-over is all the mail server tells us. Whether an email arrived, came back or was marked as spam is told later
// by the mail provider (POST /mail/events, src/server/bounces.ts), and that news has to name the email. So every
// email carries two ids of ours. Its Message-ID is made here and kept on the row, the same for every try, instead
// of being left to the mail library: providers quote it back (some as "smtp-id" or "message-id"). And X-SG-Mail is
// the number of the row in the emails table, for providers that return the headers of the original email. Neither
// says anything about the reader.
const mailDomain = (): string => {
  let host = /@([^>\s"]+)/.exec(process.env.MAIL_FROM || '')?.[1] || '';
  try {
    host ||= new URL(baseUrl()).hostname;
  } catch {}
  return host.toLowerCase().replace(/[^a-z0-9.-]/g, '') || 'localhost';
};
/** A new Message-ID without its angle brackets, lower case, which is how it is stored and compared. */
const newMessageId = (): string => `sg-${sha256(token()).slice(0, 32)}@${mailDomain()}`;
/**
 * The headers every email goes out with. Three providers do not return our own headers with their news and have a
 * header of their own for a value to carry along. It is added only when SMTP_URL names that provider, so nothing
 * made for one provider is ever sent through another. Written from their documentation, not tried against them.
 */
export function mailHeaders(id: number | bigint, smtpUrl = process.env.SMTP_URL || ''): Record<string, string> {
  const h: Record<string, string> = { 'X-SG-Mail': String(id) };
  let host = '';
  try {
    host = new URL(smtpUrl).hostname.toLowerCase();
  } catch {}
  if (host.endsWith('postmarkapp.com')) h['X-PM-Metadata-sg-mail'] = String(id);
  if (host.endsWith('sendgrid.net')) h['X-SMTPAPI'] = JSON.stringify({ unique_args: { sg_mail: String(id) } });
  if (host.endsWith('mailgun.org')) h['X-Mailgun-Variables'] = JSON.stringify({ sg_mail: String(id) });
  return h;
}

// One try at handing a recorded email to the mail server. Everything it needs is on the row. `again` is a try made
// by the timer: when that one goes through, whoever listens hears that the email left after all.
async function deliver(id: number | bigint, again = false): Promise<MailStatus> {
  const row = get('SELECT * FROM emails WHERE id=?', id);
  try {
    const t = await transport();
    if (!t) {
      run("UPDATE emails SET status='outbox' WHERE id=?", id);
      await archiveAfter(id);
      return 'outbox';
    }
    const p = JSON.parse(row.payload || '{}');
    // An attached file whose stored copy cannot be read when the email goes out (it failed its check, or it is locked
    // with a key this server was not given) must not hold the email back until it gives up: the email goes without
    // it and says so at the top, and the copy we keep of the email is what went out (readStored reports the file).
    const left: string[] = [];
    const attachments = (p.attachments || []).flatMap((a: any) => {
      try {
        return [{ filename: a.filename, content: readBlob(a.sha256) }];
      } catch (x) {
        if (!(x instanceof HttpError)) throw x;
        return (left.push(String(a.filename || 'the file')), []);
      }
    });
    const missing = left.length ? mt(row.locale, 'mail.attach_missing', { files: listIn(row.locale, left.map((f) => `"${f}"`)) }) : '';
    const html = missing ? String(row.html).replace('</h1>', `</h1>\n    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;padding:10px 12px;background:#fdf3e1;border-radius:8px">${esc(missing)}</p>`) : row.html;
    await t.sendMail({
      from: p.from || fromHeader(), replyTo: p.replyTo || undefined, to: row.to_email, subject: row.subject, html, text: missing ? `${missing}\n\n${p.text || ''}` : p.text || undefined,
      // The ids the mail provider hands back when it tells us what became of this email: see mailHeaders.
      ...(row.message_id ? { messageId: `<${row.message_id}>` } : {}), headers: mailHeaders(row.id),
      attachments,
    });
    if (missing) run('UPDATE emails SET html=? WHERE id=?', seal('emails.html', html), id);
    run("UPDATE emails SET status='sent', error=NULL, tries=tries+1, tried_at=?, next_try_at=NULL WHERE id=?", now(), id);
    if (again) await tell(id, 'sent');
    noteArchiveSent(row);
    await archiveAfter(id);
    return 'sent';
  } catch (e: any) {
    const tries = row.tries + 1;
    const wait = MAIL_RETRY_MINUTES[tries - 1];
    // A mail server that would not encrypt the connection, with SMTP_REQUIRE_TLS on, is said in our words (mailtls.ts).
    run("UPDATE emails SET status='failed', error=?, tries=?, tried_at=?, next_try_at=? WHERE id=?", (tlsRefusal(e) || String(e?.message || e)).slice(0, 500), tries, now(), wait ? new Date(Date.now() + wait * 60_000).toISOString() : null, id);
    console.error('[mail] failed', row.to_email, e?.message);
    if (!wait) await tell(id, 'gave_up');
    else if (tries === 1) await tell(id, 'delayed');
    return 'failed';
  }
}

// Every message is recorded. With SMTP_URL set it is also delivered; without it, it shows up in the dev outbox.
// The answer says which, so nothing has to claim an email was sent when it was not.
export async function sendMail(m: Mail): Promise<MailStatus> {
  return deliver(recordMail(m));
}

// Once an email about a document has left (taken by the mail server, or in the outbox where there is none), every
// confirmed archive address of its account gets a copy of its own, without links or codes (archivemail.ts). A copy
// that must wait (sending is paused) stays queued for the timer. Never throws: the email it copies has gone.
async function archiveAfter(id: number | bigint) {
  try {
    for (const c of takeArchiveCopies(id)) {
      const mid = recordMail(c.mail);
      markArchiveRow(mid, c);
      const no = archiveCheck(get('SELECT * FROM emails WHERE id=?', mid));
      if (!no) await deliver(mid);
      else if (no !== 'wait') run("UPDATE emails SET status='failed', next_try_at=NULL, error=? WHERE id=?", no.why, mid);
    }
  } catch (e: any) {
    console.error('[mail] archive copy', e?.message);
  }
}

// The two halves of sendMail, for code that must not wait for the mail server where it writes an email (the payment
// code writes its emails inside an account's queue and hands them over after it, see serial() in routes-billing.ts).
// recordMail writes the row as 'queued'; deliverQueued hands it over once. A queued row nobody handed over (the
// process stopped) is picked up by the timer after MAIL_STUCK_MS, and each hand-over first claims the row, so the
// timer and the code that wrote it never both send it.
export function recordMail(m: Mail): number | bigint {
  // Sent by a colleague for the person it belongs to: both names, in the From line and at the foot (sentfor.ts).
  m = withSentBy(m);
  const html = renderMail(m);
  // What a later try needs besides the html. Attachments go to the file store (a signed PDF is there already) and
  // the row only names them.
  const payload = {
    from: fromHeader(m.fromName), replyTo: m.replyTo || process.env.SUPPORT_EMAIL || null,
    text: [m.heading, ...m.lines.map(unquote), ...(m.links || []).map((l) => `${l.label}${l.note ? ` (${l.note})` : ''}: ${l.url}`), m.cta ? `${m.cta.label}: ${m.cta.url}` : '', m.footnote || '',
      m.askForPdf ? mt(m.locale, 'mail.footer.cannot_open', { sender: m.askForPdf }) : '',
      m.code ? mt(m.locale, 'mail.text.check', { url: `${baseUrl()}/check`, code: fmtCode(m.code) }) : '',
      m.code ? mt(m.locale, 'mail.text.report', { url: reportUrl(m.code) }) : '',
      m.code ? mt(m.locale, 'mail.text.help', { url: helpUrl(m.code) }) : ''].filter(Boolean).join('\n\n'),
    attachments: process.env.SMTP_URL ? (m.attachments || []).map((a) => ({ filename: a.filename, sha256: saveBlob(a.content) })) : [],
    ...(m.untilDone && m.recipientId ? { untilDone: true } : {}),
  };
  const r = run(
    'INSERT INTO emails (to_email, subject, html, link, envelope_id, recipient_id, status, at, payload, expires_at, about_user, message_id, locale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    m.to, m.subject, seal('emails.html', html), m.cta?.url ?? null, m.envelopeId ?? null, m.recipientId ?? null, 'queued', now(), seal('emails.payload', JSON.stringify(payload)), m.expiresAt ?? null, m.about ?? null, newMessageId(), storedLocale(m.locale),
  );
  // The copy for the account's archive addresses, made now while the whole email is known (archivemail.ts).
  const draft = archiveDraft(m);
  if (draft) run('UPDATE emails SET archive_draft=? WHERE id=?', seal('emails.archive_draft', draft), r.lastInsertRowid);
  return r.lastInsertRowid;
}
export async function deliverQueued(id: number | bigint): Promise<MailStatus | null> {
  const t = now(), stuck = new Date(Date.now() - MAIL_STUCK_MS).toISOString();
  if (!run("UPDATE emails SET tried_at=? WHERE id=? AND status='queued' AND COALESCE(tried_at, '') < ?", t, id, stuck).changes) return null;
  return deliver(id);
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
  // The second half finds the link of a member of a group (src/server/groups.ts), which opens the document for as
  // long as nobody else in the group has taken it on and the member is still in the group.
  if (signing && !['sent', 'completed'].includes(get(`SELECT e.status FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.token=?
      UNION ALL SELECT e.status FROM recipient_members m JOIN recipients r ON r.id=m.recipient_id JOIN envelopes e ON e.id=r.envelope_id WHERE m.token=? AND m.removed_at IS NULL AND r.claimed_by IS NULL`, signing, signing)?.status))
    return { why: 'Not sent again: its link no longer opens the document.', quiet: true };
  // A request or a reminder is not delivered to someone who has finished in the meantime (the sender passed the link
  // on by hand, say): it would ask them to sign what they already signed.
  let asks = false;
  try {
    asks = !!JSON.parse(row.payload).untilDone;
  } catch {}
  if (asks && row.recipient_id && ['completed', 'declined'].includes(get('SELECT status FROM recipients WHERE id=?', row.recipient_id)?.status))
    return { why: 'Not sent again: the person it asks had already finished by then.', quiet: true };
  // What the mail provider told us since (routes-bounces.ts) holds for an email that was waiting too. Someone who
  // marked an earlier one as spam gets nothing more, and a request or reminder does not go to an address that came
  // back for good: the envelope's record and the sender were told about that already.
  const to = row.recipient_id ? get('SELECT email, bounced_at, complained_at FROM recipients WHERE id=?', row.recipient_id) : null;
  if (to && String(to.email || '').toLowerCase() === String(row.to_email).toLowerCase() && (to.complained_at || (asks && to.bounced_at)))
    return { why: `Not sent again: ${to.complained_at ? 'the person had marked an earlier email as spam by then' : 'an earlier email to the address had come back for good by then'}.`, quiet: true };
  // A team invitation is only worth sending while it can still be accepted. One that was withdrawn, replaced by a
  // newer one or used already would lead to a refusal.
  const invite = /[?&]invite=([\w-]+)/.exec(row.link || '')?.[1];
  if (invite && !get('SELECT 1 x FROM invites WHERE token=? AND accepted_at IS NULL', invite))
    return { why: 'Not sent again: the invitation in it had been withdrawn, replaced or used by then.', quiet: true };
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
  // Archive copies that wait for a pause to be lifted are not even looked at, so they never crowd out other emails.
  for (const { id } of all(`SELECT id FROM emails WHERE ${isDue} AND ${ARCHIVE_NOT_WAITING} ORDER BY id LIMIT 200`, t, stuck)) {
    // The timer can run twice at once (the built-in one and a scheduler calling /api/cron). Each email is claimed
    // by one statement before it is tried, so the other run passes it over and nobody gets it twice.
    const lease = new Date(Date.now() + MAIL_STUCK_MS).toISOString();
    if (!run(`UPDATE emails SET tried_at=?, next_try_at=CASE WHEN status='failed' THEN ? ELSE next_try_at END WHERE id=? AND ${isDue}`, t, lease, id, t, stuck).changes) continue;
    const row = get('SELECT * FROM emails WHERE id=?', id);
    // An archive copy has rules of its own instead: it waits while sending is paused, however long, and goes nowhere
    // once its address was removed or paused (archivemail.ts).
    const arch = row?.archive_to ? archiveCheck(row) : null;
    if (arch === 'wait') continue;
    const no = row?.archive_to ? arch : tooLate(row);
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
