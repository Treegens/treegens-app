import { PDFDocument } from 'pdf-lib';
import { all, get, run, readBlob } from './db.ts';
import { now, baseUrl, bad, str, id, isEmail, sha256, fmtCode, HttpError } from './util.ts';
import { sendMail, type MailStatus } from './mail.ts';
import { audit, notCompletedNotice, notifySender, buildPdf, verifyChain, type Actor } from './envelopes.ts';
import { safeName, type ZipEntry } from './zip.ts';
import { labelOf } from '../lib/bysender.ts';
import { CONSENT_VERSION, consentWording } from '../lib/policy.ts';
import { CHAIN_TRUTH, WHO_WHEN_WHERE } from '../lib/evidence.ts';
import { FINGERPRINT_KEPT_DAYS } from '../lib/evidence.ts';
import { deviceName } from '../lib/phone.ts';
import { commentsText, threadsOf } from './comments.ts';
import { COMMENTS_NOT_SIGNED } from '../lib/policy.ts';

const SYSTEM: Actor = { name: 'System' };

// What happens around the certificate of a signed document, so a dispute months later has something to stand on:
// what is kept after a deletion, the public lookup by envelope ID, the record of the completed copy (handed to the
// mail server, first opened, later visits), "I did not sign this", and the evidence pack. The words the pages use
// are in src/lib/evidence.ts. Nothing in here calls into envelopes.ts while this module is being loaded, which is
// what lets the two files use each other.

// ---- After a deletion ------------------------------------------------------------------------------------------

// A completed envelope that is deleted for good (with its account: a sender who deletes one alone only takes it out
// of their own lists) leaves the fingerprint of its signed PDF behind, with the envelope id and the day it was
// completed. No name, no address, no title: whoever holds that exact file learns at /verify that it was completed
// here on that day and that its sender deleted it since, instead of being told it does not match. Kept for
// FINGERPRINT_KEPT_DAYS, like the fingerprints of security codes (forgotten_codes), and said in KEPT_AFTER_DELETION
// in src/lib/policy.ts. Call it from forgetEnvelopes (src/server/routes-trust.ts), before the envelope goes.
export function keepFingerprint(envelopeId: string) {
  const e = get("SELECT id, final_sha256, completed_at FROM envelopes WHERE id=? AND status='completed' AND final_sha256 IS NOT NULL", envelopeId);
  if (e) run('INSERT OR IGNORE INTO forgotten_files (file_sha256, envelope_id, completed_at, at) VALUES (?,?,?,?)', e.final_sha256, e.id, e.completed_at, now());
}

/** The deleted document a signed file or an envelope id belongs to, with the last day we keep knowing it. */
export function forgottenFile(o: { sha256?: string; id?: string }): { envelope_id: string; completed_at: string | null; deleted_at: string; kept_until: string } | null {
  const f = o.sha256 ? get('SELECT * FROM forgotten_files WHERE file_sha256=?', o.sha256) : o.id ? get('SELECT * FROM forgotten_files WHERE envelope_id=? ORDER BY at DESC LIMIT 1', o.id) : null;
  if (!f) return null;
  return { envelope_id: f.envelope_id, completed_at: f.completed_at, deleted_at: f.at, kept_until: new Date(Date.parse(f.at) + FINGERPRINT_KEPT_DAYS * 864e5).toISOString() };
}

/** Run from the timer, next to the year of the security codes (purgeClosedAccounts). */
export const forgetOldFingerprints = () => run('DELETE FROM forgotten_files WHERE at < ?', new Date(Date.now() - FINGERPRINT_KEPT_DAYS * 864e5).toISOString());

// ---- Looking a document up by its envelope ID ------------------------------------------------------------------

// Every page of a signed PDF carries its envelope ID, so the holder of a printed or scanned copy has that and
// nothing else. An ID is not a secret: it is printed on every page and handed to whoever is shown the paper. So a
// lookup by ID says only what such a person may know and what helps them: whether it was completed, voided,
// declined or ran out of time, and when; how many pages and how many people asked to sign; the fingerprint of the
// signed file, to compare a file with; and whether someone named on it disputes it. Never a name, an address, the
// title, the sender or the account: those stay with the file itself and with the people on it. A draft or a
// template is not found.
const CLOSING = ['Envelope voided', 'Declined', 'Envelope expired'];
export async function lookupEnvelope(envelopeId: string): Promise<any> {
  const e = get("SELECT id, status, sent_at, completed_at, final_sha256, final_pages, disputed_at FROM envelopes WHERE id=? AND kind='envelope' AND status!='draft'", envelopeId);
  if (!e) {
    const gone = forgottenFile({ id: envelopeId });
    return gone ? { found: true, id: gone.envelope_id, status: 'deleted', completed_at: gone.completed_at, deleted_at: gone.deleted_at, kept_until: gone.kept_until, sha256: get('SELECT file_sha256 s FROM forgotten_files WHERE envelope_id=?', envelopeId)?.s }
      : { found: false };
  }
  const people = all("SELECT role, status FROM recipients WHERE envelope_id=? AND role IN ('signer','inperson','approver')", e.id);
  const signers = people.filter((r) => r.role !== 'approver');
  const closed = e.status === 'sent' || e.status === 'completed' ? null : get(`SELECT at FROM audit WHERE envelope_id=? AND action IN (${CLOSING.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 1`, e.id, ...CLOSING)?.at || null;
  return {
    found: true, id: e.id, status: e.status, sent_at: e.sent_at, completed_at: e.completed_at, closed_at: closed,
    pages: { documents: get('SELECT COALESCE(SUM(f.pages), 0) n FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', e.id).n, signed_file: e.final_sha256 ? await finalPages(e) : null },
    signers: signers.length, signed: signers.filter((r) => r.status === 'completed').length, approvers: people.length - signers.length,
    sha256: e.final_sha256 || null,
    disputed_at: e.disputed_at || null, disputes: e.disputed_at ? get('SELECT COUNT(*) n FROM disputes WHERE envelope_id=?', e.id).n : 0,
  };
}

// ---- The completed copy ------------------------------------------------------------------------------------------

export type CopyState = 'attached' | 'too-large' | 'not-ready';

// Said in every email that a document is complete: the fingerprint of the signed PDF, so each person holds a
// reference of their own that does not depend on this service or on the other side, and where to check a file or a
// printed copy. Only once the PDF exists: when it is still being made, the email says that instead.
export function fingerprintLines(e: any, copy: CopyState): string[] {
  if (copy === 'not-ready' || !e.final_sha256) return [];
  return [`${copy === 'attached' ? 'The signed PDF attached to this email' : 'The signed PDF (too large to attach, so it is at the link below)'} has this SHA-256 fingerprint: ${e.final_sha256}. Keep it with your copy. Anyone can check a file against it at ${baseUrl()}/verify, and whoever has a printed copy can look the document up there by its envelope ID, ${e.id}.`];
}

// What became of the email with the completed copy, for each person, in the envelope's record. The mail server
// taking it is all we can know at that moment. One it would not take yet is written down by the listener in
// envelopes.ts ("Email could not be sent yet", then "Email sent" or "Email could not be sent"), like every email.
export function noteCopyMailed(e: any, r: { name: string; email: string; sender?: boolean }, copy: CopyState, how: MailStatus) {
  const who = `${r.sender ? 'the sender, ' : ''}${r.name} <${r.email}>`;
  const what = copy === 'attached' ? 'with the signed PDF attached' : copy === 'too-large' ? 'with a link to the signed PDF, which was too large to attach' : 'with a link to the completed document, as the signed PDF was still being made';
  if (how === 'sent') audit(e.id, SYSTEM, 'Completed copy sent', `To ${who}: handed to the mail server ${what}. Whether it arrived is not known at this point.`);
  else if (how === 'outbox') audit(e.id, SYSTEM, 'Completed copy not emailed', `To ${who}: no mail server is set up, so no email went out. ${r.sender ? 'The envelope page has the document.' : 'Their link opens the completed document.'}`);
}

// ---- A copy of a closed envelope ---------------------------------------------------------------------------------

// The sender's own download of an envelope that was voided, declined or ran out of time shows the signatures that
// were collected by then. It must never pass for a signed document, so it carries what the signer's copy carries
// (notCompletedNotice in envelopes.ts): a first page that says it was not completed by everyone and why, the line at
// the foot of every page, and the large mark across every page (stamp.ts). The reason is the signer's copy's own
// first sentence, so both say the same thing.
export const CLOSED = ['voided', 'declined', 'expired'];
export function senderNotice(e: any): { title: string; lines: string[] } {
  const why = notCompletedNotice(e, { name: '', role: 'signer', status: 'completed' }).lines[0];
  return {
    title: 'Not completed by everyone',
    lines: [why,
      'This is the sender\'s copy. It shows the document as it stood when it was closed, with what the people who had finished by then filled in, and their signatures. Every page is marked across, and there is no certificate of completion.',
      `Anyone can look up what became of this envelope at ${baseUrl()}/verify with its envelope ID, ${e.id}.`],
  };
}

// The browser and device a request came from, in words, for an audit line. The raw string is kept with the line too.
const onWhat = (ua?: string) => {
  const d = deviceName(ua);
  if (d.browser === 'unknown browser' && d.device === 'Unknown device') return 'in a browser that did not say what it is';
  const device = d.device === 'Unknown device' ? 'a device that did not say what it is' : `${/^[aeiou]/i.test(d.device) ? 'an' : 'a'} ${d.device}`;
  return `in ${d.browser === 'unknown browser' ? 'a browser that did not say which' : d.browser} on ${device}`;
};

// The first time each person opens or downloads the completed copy, with their internet address and browser. What
// they do with it later is theirs. One statement decides, so two requests at the same moment leave one line. The
// certificate inside the file was sealed before this, so the line is in the envelope's live audit trail.
export function noteCopyOpened(e: any, r: any, actor: Actor, onScreen: boolean) {
  if (e.status !== 'completed' || !r?.id) return;
  if (!run('UPDATE recipients SET copy_opened_at=? WHERE id=? AND copy_opened_at IS NULL', now(), r.id).changes) return;
  audit(e.id, actor, 'Completed copy opened', `${r.name} ${onScreen ? 'opened the completed document on screen' : 'downloaded the completed document'} for the first time, ${onWhat(actor.ua)}.`);
}

// Visits after the first open. "Viewed" is written once, on the first open. Every later visit to the signing page
// would bury the trail (it is printed on the certificate), so one line a day at most for each person, counted from
// the first open: a reload a minute later says nothing, coming back the next day does. The members of a group that
// nobody has taken on share one row, so their visits are left to the group's own lines (groups.ts).
export function noteVisit(e: any, r: any, actor: Actor) {
  if (!r?.viewed_at || (r.member && !r.claimed_by)) return;
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  if (!run('UPDATE recipients SET visit_noted_at=? WHERE id=? AND COALESCE(visit_noted_at, viewed_at) < ?', now(), r.id, dayAgo).changes) return;
  audit(e.id, actor, 'Opened again', `${r.name} opened the envelope again, ${onWhat(actor.ua)}. Later visits on the same day are not written down.`);
}

// ---- "I did not sign this, or this was not me" ------------------------------------------------------------------

// A person named on an envelope says that what stands under their name is not theirs: someone else used their link,
// or the sender signed for them. We cannot know who is right, and nothing here decides it. What it does: the
// envelope carries a disputed mark (disputed_at) from then on, on its page and wherever /verify shows it; the record
// has a line that says who said it, as far as we know who (the holder of the email or of the link, not a confirmed
// person); the sender and the people who run the service are told; and nothing is changed, held or deleted. What the
// person writes goes to the people who run the service only, because a person who says the sender signed for them
// may not want the sender to read it. One dispute for each person on an envelope: saying it again changes nothing.
// `via` is how they reached us: the security code of an email we sent them ('check') or their signing link ('sign').
export async function disputeEnvelope(e: any, r: any, body: any, actor: Actor, via: 'check' | 'sign') {
  if (e.kind !== 'envelope' || e.status === 'draft') throw bad('This is not a document that was sent to anyone, so there is nothing to dispute.', 404);
  if (r.role === 'cc') throw bad('You were only sent a copy of this document, so nothing on it is signed in your name. If you do not know this document, report it instead.', 409, { code: 'nothing_signed' });
  // Disputing is about something done in this person's name: signed, approved, confirmed or declined, now or before
  // the sender changed the document. Before that there is nothing to dispute, and a report is what fits.
  if (r.status !== 'completed' && r.status !== 'declined' && !r.signed_before)
    throw bad(`Nothing has been signed, approved or declined in ${r.name}'s name on this document so far, so there is nothing to dispute yet. If you do not know this document or did not expect it, do not sign it and report it instead.`, 409, { code: 'nothing_signed' });
  const detail = str(body?.detail, 2000).trim() || null;
  const t = now();
  if (!run('INSERT OR IGNORE INTO disputes (id, envelope_id, recipient_id, name, email, via, detail, ip, user_agent, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id('dsp'), e.id, r.id, r.name, r.email || null, via, detail, actor.ip || null, (actor.ua || '').slice(0, 300) || null, t).changes)
    return { ok: true, already: true, disputed_at: get('SELECT disputed_at FROM envelopes WHERE id=?', e.id)?.disputed_at || t };
  run('UPDATE envelopes SET disputed_at=COALESCE(disputed_at, ?) WHERE id=?', t, e.id);
  // Who said it, as far as we know: whoever held that email or that link. The emails for an in-person signing went to
  // the sender who hosted it, and the completed copy to the signer, so either can hold that code.
  const who = via === 'sign' ? `Someone using the signing link of ${labelOf(r)}`
    : r.role === 'inperson' ? `Someone holding the security code of ${labelOf(r)}, which is in our emails to the sender who hosted the signing and in the completed copy to ${r.name}`
    : `Someone holding the email we sent to ${labelOf(r)}`;
  audit(e.id, actor, 'Disputed', `${who} said that ${r.name} did not sign this, or that it was not them. Nothing was changed or deleted: the document, the signatures and this record stay as they are.`);
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  const ops = await tellOperatorsOfDispute(e, r, who, detail, sender);
  await notifySender(e, 'always', `Disputed: ${e.subject}`, `${r.name} says they did not sign this`, [
    `${who} told us that ${r.name} did not sign "${e.subject}", or that it was not them.`,
    `Nothing was changed or deleted. The document, its signatures and its audit trail stay exactly as they are. From now on the envelope is marked as disputed, on its page here and for anyone who looks it up at ${baseUrl()}/verify.`,
    ...(e.status === 'sent' ? ['The envelope is still out for signature, and nothing about it was stopped. If you agree that it was not them, void it and send it again to the right person.'] : []),
    `We do not decide who is right. Speak to ${r.name} directly. If it becomes a legal matter, the rules differ by country and by kind of document, so ask a lawyer where you are.`,
    ops ? 'A person at Sign&Grow has been told as well. What was written to us with it goes to them, not to you.' : 'What was written to us with it, if anything, is not passed on to you.',
  ]);
  return { ok: true, already: false, disputed_at: t };
}

// The people who run the service hear of every dispute, by email and in their queue, like the alerts the payment code
// files (tellOperators in routes-billing.ts). Answers whether anyone could be told by email.
async function tellOperatorsOfDispute(e: any, r: any, who: string, detail: string | null, sender: any): Promise<boolean> {
  const to = [...new Set([process.env.ABUSE_EMAIL || process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];
  const subject = `Disputed: envelope ${e.id}`;
  const lines = [`${who} said that ${r.name} did not sign "${e.subject}", or that it was not them.`,
    `Envelope ${e.id} (${e.status}) from ${sender ? `${sender.name} <${sender.email}>` : 'a sender who is gone'}, account ${e.account_id}.`,
    detail ? `They wrote: ${detail}` : 'They wrote nothing more.',
    'The envelope is marked as disputed and the sender was told, without what they wrote. Nothing was changed or deleted. Nothing more happens by itself.'];
  run("INSERT INTO support_requests (id, email, name, topic, message, account_id, envelope_id, status, at) VALUES (?,?,?,'not-me',?,?,?,'open',?)",
    id('sup'), to[0] || 'dispute-alert@localhost', 'Sign&Grow (automatic alert)', `${subject}\n\n${lines.join('\n')}`.slice(0, 5000), e.account_id, e.id, now());
  for (const t of to) await sendMail({ to: t, subject, heading: subject, lines, ...(isEmail(r.email) ? { replyTo: r.email } : {}), cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } });
  if (!to.length) console.error(`[disputes] NOBODY WAS TOLD BY EMAIL (set SUPPORT_EMAIL or OPERATOR_EMAILS). Envelope ${e.id} was disputed; it is in the operator queue.`);
  return to.length > 0;
}

// ---- The evidence pack ----------------------------------------------------------------------------------------------

// "Download evidence pack" on the envelope page: what a sender is told by lawyers to keep outside any platform, in
// one ZIP. The signed PDF, its certificate on its own, the audit trail as text and as JSON with every chain value,
// every email we stored about the envelope with what became of it, the consent wording each person agreed to, and a
// README that says what each file is and what it does not show. It reuses the export's ZIP writer (zip.ts). It is a
// snapshot of the moment it is made. A copy of an email keeps everything but what would open the document today:
// signing links and security codes are taken out, so the pack can be handed to a lawyer or a court without handing
// over the documents' keys. The fingerprint of each stored email as it was is in emails/index.csv.
const csvRow = (cells: any[]) => cells.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
const SIGN_LINK = /\/sign\/[A-Za-z0-9_-]{8,}/g;
const HASH_HOW = 'Each line\'s hash is the SHA-256 of JSON.stringify([prev_hash, envelope_id, at, actor, action, detail, ip or ""]). The first line\'s prev_hash is empty. user_agent is stored with a line but is not part of its hash.';

export async function evidencePack(e: any, madeBy: string): Promise<{ entries: ZipEntry[]; name: string }> {
  const out: ZipEntry[] = [];
  const add = (name: string, data: string | Uint8Array) => out.push({ name, data: typeof data === 'string' ? Buffer.from(data) : data });
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  const base = `${(e.completed_at || e.sent_at || e.created_at || now()).slice(0, 10)} ${safeName(e.subject)} ${e.id.slice(-6)}`;
  const notes: string[] = [];

  // The signed PDF and its certificate, or, before or without completion, the document as it stands, marked.
  let pdfName = '', certName = '';
  if (e.final_sha256) {
    try {
      const pdf = readBlob(e.final_sha256);
      add(pdfName = 'signed.pdf', pdf);
      const cert = await certificatePages(e, pdf);
      if (cert) add(certName = 'certificate.pdf', cert);
      else notes.push('The certificate could not be taken out of the signed PDF on its own. It is the last pages of signed.pdf.');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      notes.push('The signed PDF could not be read from storage, so it is not in this pack: its stored copy failed its check. The people who run this server have been told. Everything else is here.');
    }
  } else if (e.documents?.length) {
    add(pdfName = e.status === 'sent' ? 'document-so-far.pdf' : 'document-not-completed.pdf', await buildPdf(e, false, undefined, CLOSED.includes(e.status) ? senderNotice(e) : undefined));
  }

  // The audit trail: as text to read, as JSON to check, with the chain worked out as the app works it out.
  const events = all('SELECT seq, at, actor, action, detail, ip, user_agent, prev_hash, hash FROM audit WHERE envelope_id=? ORDER BY seq', e.id);
  const chain = verifyChain(e.id);
  const people = all('SELECT name, email, role, status, routing_order, sent_at, viewed_at, consent_at, completed_at, decline_reason, ip, user_agent, tz, link_by_sender FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
  add('audit-trail.json', JSON.stringify({
    envelope: { id: e.id, subject: e.subject, status: e.status, sent_at: e.sent_at, completed_at: e.completed_at, disputed_at: e.disputed_at || null, signed_pdf_sha256: e.final_sha256 || null },
    sender, recipients: people, chain: { ...chain, how: HASH_HOW }, events,
  }, null, 2));
  add('audit-trail.txt', [
    `Audit trail of envelope ${e.id}, "${e.subject}", as stored on ${now()}.`, `Record ${chain.ok ? `intact: ${chain.events} lines, chain head ${chain.head}` : 'ALTERED: the stored lines no longer lead from one to the next. Do not rely on it.'}.`, '',
    ...events.flatMap((a: any) => [`${String(a.at).replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}  ${a.actor}${a.ip ? `  from ${a.ip}` : ''}`, `    ${a.action}${a.detail ? `: ${a.detail}` : ''}`, `    hash ${a.hash}`, '']),
  ].join('\r\n'));

  // Every email stored about the envelope, with what became of it at the mail server and afterwards.
  const codes = new Set<string>([...all('SELECT check_code c FROM recipients WHERE envelope_id=? AND check_code IS NOT NULL', e.id), ...all('SELECT check_code c FROM recipient_members WHERE envelope_id=? AND check_code IS NOT NULL', e.id),
    ...all('SELECT t.check_code c FROM retired_tokens t WHERE t.check_code IS NOT NULL AND (t.envelope_id=? OR t.recipient_id IN (SELECT id FROM recipients WHERE envelope_id=?))', e.id, e.id)].map((x: any) => x.c));
  const scrub = (html: string) => [...codes].reduce((h, c) => h.split(fmtCode(c)).join('[security code removed]').split(c).join('[security code removed]'), html.replace(SIGN_LINK, '/sign/[link removed]'));
  const mails = all('SELECT id, to_email, subject, html, status, error, at, tries, tried_at, delivered_at, bounced_at, bounce_kind, bounce_reason, complained_at FROM emails WHERE envelope_id=? ORDER BY id', e.id);
  const index = [csvRow(['file', 'to', 'subject', 'written_at', 'mail_server', 'tries', 'last_try_at', 'error', 'delivered_at', 'bounced_at', 'bounce_kind', 'bounce_reason', 'marked_as_spam_at', 'stored_html_sha256'])];
  mails.forEach((m: any, i: number) => {
    const file = `emails/${String(i + 1).padStart(3, '0')} ${safeName(m.to_email)} ${safeName(m.subject)}.html`;
    add(file, scrub(m.html));
    index.push(csvRow([file, m.to_email, m.subject, m.at, MAIL_SAID[m.status] || m.status, m.tries, m.tried_at, m.error, m.delivered_at, m.bounced_at, m.bounce_kind, m.bounce_reason, m.complained_at, sha256(m.html)]));
  });
  add('emails/index.csv', '﻿' + index.join('\r\n'));

  // The consent wording each person agreed to, by the version their audit line names (src/lib/policy.ts).
  const agreed = events.filter((a: any) => a.action === 'Agreed to electronic records and signatures');
  add('consent.txt', [
    `What each person agreed to before signing "${e.subject}" (envelope ${e.id}). The audit line names the version of the wording their screen showed, and this is that wording.`, '',
    ...(agreed.length ? agreed.flatMap((a: any) => {
      const version = /Wording (\S+?),/.exec(a.detail)?.[1] || /wording in use was (\S+?),/.exec(a.detail)?.[1] || CONSENT_VERSION;
      const r = people.find((p: any) => labelOf(p) === a.actor);
      const w = consentWording(sender?.name || 'the sender', !r || r.role === 'signer' || r.role === 'inperson', version);
      return [`${a.actor}, ${String(a.at).replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}${a.ip ? `, from ${a.ip}` : ''}. Wording ${w.version}${/did not say/.test(a.detail) ? ' (their screen did not say which wording it showed; this is the one in use then)' : ''}:`, '', w.legal, '', w.practical, '', `"${w.agree}"`, '', '----', ''];
    }) : ['Nobody has agreed yet.']),
  ].join('\r\n'));

  // The questions and comments in full, private ones included: the pack is for the sender's side (comments.ts).
  const said = commentsText(e);
  if (said) (add('comments.txt', said), add('comments.json', JSON.stringify({ envelope_id: e.id, not_signed: COMMENTS_NOT_SIGNED, threads: threadsOf(e, { side: 'sender' }) }, null, 2)));

  add('README.txt', [
    `Sign&Grow evidence pack for envelope ${e.id}, "${e.subject}".`, `Made on ${now()} by ${madeBy}. It shows the envelope as it stood at that moment.`, '',
    ...(pdfName === 'signed.pdf' ? [`signed.pdf            the signed document exactly as stored when everyone had finished, with its certificate of completion. SHA-256 ${e.final_sha256}. Anyone can check a copy at ${baseUrl()}/verify, or look the envelope up there by its ID.`] : pdfName ? [`${pdfName.padEnd(22)}the document as it stands, ${e.status === 'sent' ? 'while it is still out for signature' : 'marked as not completed on every page'}. It is not a signed document and has no certificate.`] : []),
    ...(certName ? ['certificate.pdf       the certificate of completion on its own: the last pages of signed.pdf. It was sealed when everyone had finished, so it does not show what happened after that.'] : []),
    'audit-trail.txt       every line of the audit trail, to read: time in UTC, who, internet address, what, and each line\'s hash.',
    `audit-trail.json      the same lines with prev_hash and hash, the browser string stored with each line, the people on the envelope, and the chain as checked now. ${HASH_HOW}`,
    'emails/               a copy of every email we stored about this envelope, as HTML. Signing links and security codes are taken out of these copies, because they would still open the document; nothing else is changed. emails/index.csv says what became of each: whether the mail server took it, every try, and what the mail provider told us later (delivered, came back, marked as spam), with the SHA-256 of the email as stored before anything was taken out.',
    'consent.txt           the words each person agreed to before signing, in the version their audit line names.',
    ...(said ? ['comments.txt          the questions and comments written on the envelope, every thread in full with who wrote what and when; comments.json is the same as data. They were not printed on the document and are not part of what was signed.'] : []), '',
    'What this does and does not show.', CHAIN_TRUTH, WHO_WHEN_WHERE,
    'Rules about electronic signatures differ by country and by kind of document. This pack is a record of what happened in Sign&Grow; it does not say that a signature is valid, and it is not legal advice.',
    ...(e.disputed_at ? ['', `This envelope is disputed: on ${e.disputed_at} a person named on it said they did not sign it, or that it was not them. See the "Disputed" lines in the audit trail.`] : []),
    ...(notes.length ? ['', ...notes] : []),
  ].join('\r\n'));
  return { entries: out, name: `evidence ${base}.zip` };
}
const MAIL_SAID: Record<string, string> = { sent: 'took it', outbox: 'none set up, not sent', failed: 'would not take it', queued: 'not tried yet' };

// The certificate is drawn after the documents and the files signers attached (renderEnvelopePdf in pdf.ts), so it
// is the pages that are left after those. Null when the count does not add up, rather than a wrong cut.
async function certificatePages(e: any, pdf: Uint8Array): Promise<Uint8Array | null> {
  const src = await PDFDocument.load(pdf, { updateMetadata: false });
  const docs = (e.documents || []).reduce((n: number, d: any) => n + (d.pages || 0), 0);
  const attached = all("SELECT f.pages FROM fields x JOIN files f ON f.id=x.value WHERE x.envelope_id=? AND x.type='attachment' AND x.value IS NOT NULL", e.id).reduce((n: number, f: any) => n + (f.pages || 0), 0);
  const from = docs + attached, total = src.getPageCount();
  if (from <= 0 || from >= total) return null;
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, Array.from({ length: total - from }, (_, i) => from + i))) out.addPage(p);
  out.setTitle(`Certificate of completion, envelope ${e.id}`);
  out.setProducer('Sign&Grow');
  out.setCreator('Sign&Grow');
  return out.save();
}

// How many pages the signed PDF has (the documents, the files signers attached and the certificate). Counted once
// and kept, because the file never changes once it is made.
async function finalPages(e: any): Promise<number | null> {
  if (e.final_pages) return e.final_pages;
  try {
    const n = (await PDFDocument.load(readBlob(e.final_sha256), { updateMetadata: false })).getPageCount();
    run('UPDATE envelopes SET final_pages=? WHERE id=?', n, e.id);
    return n;
  } catch {
    return null; // a stored file that cannot be read is said by the file store; the lookup still answers
  }
}
