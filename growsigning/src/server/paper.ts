// Signed on paper (research/docusign-gaps.json, batch "paper"). Someone who cannot or will not sign on screen prints
// the document from their own link, signs it by hand and sends back a photo or a scan through that same link. The
// sender, or a colleague they shared their documents with, looks at it and accepts it as signed by that person, or
// asks again with a reason that is emailed. Until then the person shows "Signed on paper, waiting for the sender to
// check" and nobody after them in the order is asked. An accepted scan finishes the person through the one
// completion path every signer finishes through (completeRecipient in envelopes.ts), so it uses a signature like any
// finished signer. The signed PDF carries the scan after a divider page, the person's places point to it, and the
// certificate says what happened in words. It is never called an electronic signature, and nothing reads the
// handwriting.
//
// Nothing of this exists until an admin switches on "People may sign on paper" (accounts.paper_sign). Then a person
// who signs (signer or approver) may sign on paper unless the sender chose "On screen only" (allow_paper 0), and must
// when the sender chose "On paper only" (require_paper 1). Never for someone who signs in person, a group, a witness
// or a signer with a witness, a public form, a document that asks for a payment before finishing, or a delegate's link.
import { PDFDocument, PDFPage, rgb } from 'pdf-lib';
import fontkitMod from '@pdf-lib/fontkit';
import { get, all, run } from './db.ts';
import { bad, now, hmac, fmtCode, id as newId, str, baseUrl } from './util.ts';
import { audit, completeRecipient, loadEnvelope, notifySender, senderOf, signUrl, emailRefusal, type Actor } from './envelopes.ts';
import { renderEnvelopePdf, sheetPdf, mapper, fontBytes, Sheet } from './pdf.ts';
import { drawFootClear } from './footplace.ts';
import { drawStamp } from './stamp.ts';
import { hiddenOf } from './logic.ts';
import { delegateLinkOf } from './delegation.ts';
import { toSign } from './supplements.ts';
import { sendMail } from './mail.ts';
import { whoIs } from '../lib/groups.ts';
import { labelOf } from '../lib/bysender.ts';
import { momentText, dayText } from '../lib/dates.ts';
import { PAPER_ROLES, PAPER_REASON_MAX, PAPER_WORDS, printMark, placeWords, placeShort, dividerTitle, paperCertSentence, type PaperWay } from '../lib/paper.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
const GREEN = rgb(0.12, 0.44, 0.26);
const INK = rgb(0.11, 0.16, 0.13);
const MUTED = rgb(0.42, 0.47, 0.44);

// ---- Who may sign on paper -----------------------------------------------------------------------------------------

/** The admins' switch, Settings, Sending, "People may sign on paper". Off for every account until switched on. */
export const paperOn = (accountId: string): boolean => !!get('SELECT paper_sign FROM accounts WHERE id=?', accountId)?.paper_sign;

export function setPaperOn(accountId: string, on: boolean): boolean {
  const was = paperOn(accountId);
  if (was !== on) run('UPDATE accounts SET paper_sign=? WHERE id=?', on ? 1 : 0, accountId);
  return was !== on;
}

const hasWitness = (e: any, r: any): boolean => (e?.recipients || []).some((x: any) => x.role === 'witness' && x.witness_for === r.id);

/** Why this person can never sign on paper on this document, in words, or null when they can. */
export function notForPaper(e: any, r: any): string | null {
  const name = r?.name || 'This person';
  if (r?.role === 'inperson') return `${name} signs in person, with you. Signing on paper is for someone who signs from their own link.`;
  if (!PAPER_ROLES.includes(r?.role)) return `${name} signs nothing here, so there is nothing to sign on paper. Signing on paper is for people who sign or approve.`;
  if (r.group_id || r.group_name) return `${name} is a signing group. Signing on paper is for one person, who signs from their own link.`;
  if (hasWitness(e, r)) return `${name} has a witness, and a witness watches a signature made on screen. Take the witness off, or let ${name} sign on screen.`;
  if (e?.powerform_id) return 'A public form is signed on screen. Signing on paper is for documents you send to people.';
  if (e?.collect_currency && e?.collect_when === 'before') return `This document asks ${name} to pay before finishing, and that is done on screen. Ask for the payment after finishing, or let ${name} sign on screen.`;
  return null;
}

/** How this person may sign here: 'may', 'only' or null (on screen only, or the switch is off). */
export function paperWay(e: any, r: any): PaperWay {
  if (!e || !r || !paperOn(e.account_id) || notForPaper(e, r)) return null;
  if (r.require_paper) return 'only';
  return r.allow_paper === 0 ? null : 'may';
}

/** The security code printed on every page of this person's print: it changes when the document changes. */
export const paperCode = (e: any, r: any): string => fmtCode(hmac(`paper:${e.id}:${r.id}:${e.content_version}`).slice(0, 8).toUpperCase());

const scansOf = (rid: string) => all('SELECT * FROM paper_scans WHERE recipient_id=? ORDER BY at DESC, rowid DESC', rid);

/**
 * The mark acceptScan puts on what it hands completeRecipient. A symbol, so no request body (JSON) can ever carry it:
 * only an accepted scan finishes someone without an electronic signature (completeRecipient in envelopes.ts).
 */
export const PAPER_FINISH = Symbol.for('growsigning.paper.finish');

/** Whether a scan came from the person the request is for now (the same person_gen and address). */
const sameUploader = (s: any, r: any): boolean =>
  s.person_gen == null || ((Number(s.person_gen) || 0) === (Number(r.person_gen) || 0) && String(s.email || '').toLowerCase() === String(r.email || '').toLowerCase());

/**
 * Keeps each person's paper state true after a change (a correction, sign again, a hand-over). Called after every
 * change of who someone is or whether they finished (newerVersion and correctEnvelope in envelopes.ts, collab.ts),
 * and again before anything reads or acts on a scan.
 *   - An accepted scan counts only while its person stays finished. Asked to sign again, it is set aside and kept on
 *     record: they sign the new version again, on screen or on paper.
 *   - A scan waiting or asked again belongs to the person who sent it. When the request is now for someone else, it
 *     is set aside: the new person starts as anyone does, and nobody can accept it as theirs.
 */
export function settlePaper(envelopeId: string) {
  for (const r of all("SELECT * FROM recipients WHERE envelope_id=? AND (paper_state IS NOT NULL OR paper_scan_id IS NOT NULL)", envelopeId)) {
    const s = latestScan(r.id);
    if (r.status !== 'completed' && (r.paper_scan_id || r.paper_state === 'accepted')) {
      run("UPDATE paper_scans SET state='set_aside' WHERE recipient_id=? AND state='accepted'", r.id);
      run('UPDATE recipients SET paper_scan_id=NULL, paper_state=NULL WHERE id=?', r.id);
      audit(envelopeId, { name: 'System' }, 'Scan signed on paper set aside', `${whoIs(r)} is asked to sign again, so the scan accepted before no longer counts. It is kept on record. They sign the document as it is now, on screen or on paper.`);
    } else if ((r.paper_state === 'waiting' || r.paper_state === 'asked_again') && (!s || !sameUploader(s, r))) {
      run("UPDATE paper_scans SET state='set_aside' WHERE recipient_id=? AND state IN ('waiting','asked_again')", r.id);
      run('UPDATE recipients SET paper_state=NULL WHERE id=?', r.id);
      if (s && !sameUploader(s, r)) audit(envelopeId, { name: 'System' }, 'Scan signed on paper set aside', `This request is now for ${whoIs(r)}, so the scan another person sent back before no longer counts. It is kept on record and cannot be accepted as signed by ${r.name || 'them'}.`);
    }
  }
}
const latestScan = (rid: string) => get('SELECT * FROM paper_scans WHERE recipient_id=? ORDER BY at DESC, rowid DESC LIMIT 1', rid);

// ---- Saving what the sender chose ------------------------------------------------------------------------------------

const flag = (v: any, what: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === false) return v;
  if (v === 1 || v === 0) return v === 1;
  throw bad(`${what} must be true or false. Nothing was saved.`);
};

/**
 * "allow_paper" and "require_paper" of each recipient, as PUT /envelopes/:id names them. Left out, a person keeps what
 * they have. "require_paper": true is refused while the account's switch is off, and for anyone who cannot sign on
 * paper (notForPaper). Called after the witnesses are saved, so a signer who just got a witness is seen to have one.
 */
export function savePaper(e: any, asked: { rid: string; r: any; i: number }[], before: Map<string, any>) {
  const on = paperOn(e.account_id);
  const now_ = loadEnvelope(e.id);
  for (const { rid, r, i } of asked) {
    const allow = flag(r?.allow_paper, `"allow_paper" of recipient ${i + 1}`);
    const need = flag(r?.require_paper, `"require_paper" of recipient ${i + 1}`);
    const old = before.get(rid);
    const row = now_?.recipients.find((x: any) => x.id === rid);
    // One already set stays as it is when an admin has switched paper off since: it does nothing then (paperWay).
    if (need && !on && !old?.require_paper) throw bad('Signing on paper is off for this account, so nobody can be asked to sign on paper only. An admin can switch on "People may sign on paper" in Settings, Sending. Nothing was saved.', 400, { code: 'paper_off' });
    const no = need && row ? notForPaper(now_, row) : null;
    if (no) throw bad(`${no} Nothing was saved.`, 400, { code: 'not_for_paper' });
    const a = allow === undefined ? (old ? old.allow_paper : null) : allow ? null : 0;
    const q = need === undefined ? (old?.require_paper ? 1 : 0) : need ? 1 : 0;
    if (row && (row.allow_paper !== a || (row.require_paper ? 1 : 0) !== q)) run('UPDATE recipients SET allow_paper=?, require_paper=? WHERE id=?', a, q, rid);
  }
}

/** A template's choices go with everything made from it, and with every copy. */
export function copyPaper(from: any, newId_: string) {
  if (from?.allow_paper === 0 || from?.require_paper) run('UPDATE recipients SET allow_paper=?, require_paper=? WHERE id=?', from.allow_paper === 0 ? 0 : null, from.require_paper ? 1 : 0, newId_);
}

// ---- The signing page ------------------------------------------------------------------------------------------------

/**
 * What the signing page needs: null when paper is not offered to this person (nothing on the page changes). Otherwise
 * how they may sign, where their latest scan stands and, after "Ask again", the sender's reason.
 */
export function paperSignFacts(e: any, r: any, token: string) {
  settlePaper(e.id);
  const way = paperWay(e, r);
  const s0 = latestScan(r.id);
  // A scan set aside (the person changed, or they were asked to sign again) is no longer theirs to act on.
  const s = s0 && s0.state !== 'set_aside' ? s0 : null;
  // A scan that waits is shown as waiting even if the sender has since switched paper off: it is still theirs to check.
  // Accepted: so the Done screen knows they printed it (no "signed without paper" for them). Asked again after the
  // switch went off: they are told why, and that they now sign on screen ("off").
  if (!way && s?.state !== 'waiting' && s?.state !== 'accepted' && s?.state !== 'asked_again') return null;
  if (way && token && isDelegateLink(token)) return null;
  return {
    way: way || 'may',
    ...(!way && s?.state === 'asked_again' ? { off: true } : {}),
    state: s?.state || null,
    sent_at: s?.at || null,
    pages: s?.pages || null,
    ...(s?.state === 'asked_again' ? { reason: s.reason || '' } : {}),
    code: paperCode(e, r),
    max_mb: 25,
    // Whether "Ask again" reaches them by email (askAgain sends none to an address that marked ours as spam).
    mail: !!r.email && !r.complained_at,
  };
}

function isDelegateLink(token: string): boolean {
  try {
    return !!delegateLinkOf(token);
  } catch {
    return false;
  }
}

/**
 * Called by POST /sign/:token/complete before anything is signed: someone the sender asked to sign on paper only has
 * no electronic signing, and someone whose scan waits for the sender cannot also sign on screen.
 */
export function paperGate(e: any, r: any) {
  settlePaper(e.id);
  if (get('SELECT paper_state FROM recipients WHERE id=?', r.id)?.paper_state === 'waiting') throw bad(`You sent back a scan signed on paper, and ${senderOf(e)?.name || 'the sender'} has not looked at it yet. Wait for their answer: we email you if they ask you to send it again.`, 409, { code: 'paper_waiting' });
  if (paperWay(e, r) === 'only') throw bad(`${senderOf(e)?.name || 'The sender'} asked you to sign this on paper. Print it, sign it by hand and send back a photo of every page from this page.`, 409, { code: 'paper_only' });
}

// ---- The print -----------------------------------------------------------------------------------------------------

/**
 * The PDF to print: a cover page that says how to return it, then the document as this person's screen shows it, with
 * their places marked ("Sign here", "Initial here", a box for each value), and on every page the envelope ID, "Page x
 * of y" and the security code.
 */
export async function printPdf(e: any, r: any): Promise<Uint8Array> {
  const sender = senderOf(e);
  const code = paperCode(e, r);
  // Nobody has signed this with us, so its pages carry our own line at the top and no "Signed with growsigning".
  const body = await renderEnvelopePdf(e, [], { certificate: false, viewer: r.id, sender, foot: false });
  const src = await PDFDocument.load(body, { updateMetadata: false });
  const docs = toSign(e.documents || []);
  const total = src.getPageCount() + 1;
  const cover = await sheetPdf('How to sign this on paper', `Envelope ${e.id} · Security code ${code}`, (s) => {
    s.text(`${r.name}, ${sender?.name || 'the sender'} asked you to sign "${e.subject || 'this document'}". To sign it on paper:`, { size: 11, gap: 10 });
    const steps = [
      `${total === 2 ? 'Print both pages' : `Print all ${total} pages`}, this one too. Keep the pages in order.`,
      'Sign and fill in only where a dashed box is marked: "Sign here", "Initial here" or a box to write in.',
      'Do not change the words of the document. Anything written outside the marked boxes may not be accepted.',
      'Take a clear photo or scan of every signed page. The code at the top of each page must be easy to read.',
      // Never the link itself: it opens the document as this person, and paper lies about at printers and in the post.
      `Open the email from ${sender?.name || 'the sender'} again and press its button, or open the same page you printed this from.${r.require_paper ? '' : ' Choose Other actions, then Sign on paper instead.'} Send the photos there. A PDF, JPEG or PNG works, several photos become one document, up to 25 MB.`,
      `${sender?.name || 'The sender'} looks at it and accepts it as signed by you, or asks you to send it again and says why.`,
    ];
    steps.forEach((t, i) => s.text(`${i + 1}. ${t}`, { size: 10.5, gap: 6 }));
    s.rule(8);
    s.text(`Security code: ${code}. It is printed on every page and only fits this version of the document. If the document changes, print it again.`, { size: 9.5, gap: 4 });
    if (e.expires_at) s.text(`Send it back by ${dayText(e.expires_at)}. After that the document closes.`, { size: 9.5, gap: 4 });
    s.text('Please do not email or post the paper to us. GrowSigning only takes it through your link, and does not read or check handwriting.', { size: 9, color: MUTED, gap: 4 });
  }, undefined, { badge: false });
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await out.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  const coverDoc = await PDFDocument.load(cover);
  for (const p of await out.copyPages(coverDoc, coverDoc.getPageIndices())) out.addPage(p);
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  // This person's places, on the pages of the documents to sign (they come first, in order, a page for each page).
  const hidden = hiddenOf(e.fields);
  let at = 0;
  for (const d of docs) {
    for (const f of e.fields.filter((x: any) => x.document_id === d.id && x.recipient_id === r.id && !hidden.has(x.id))) {
      const page = pages[at + f.page];
      const words = printMark(f.type, f.label);
      if (page && words && !f.value) markPlace(page, f, words, font, bold);
    }
    at += d.pages;
  }
  const all_ = out.getPages();
  all_.forEach((p, i) => {
    const m = mapper(p);
    const line = `Envelope ${e.id} · Page ${i + 1} of ${all_.length} · Security code ${code} · ${r.name}`;
    const size = 7;
    const q = m.pt(12, 12);
    // The cover's top is our dark band: the line is white there, dark everywhere else.
    p.drawText(line.replace(/[\u0000-\u001f]/g, ''), { x: q.x, y: q.y, size, font, color: i === 0 ? rgb(1, 1, 1) : INK, rotate: m.rotate });
  });
  out.setTitle(`To sign on paper: ${e.subject || 'document'}`);
  out.setProducer('GrowSigning');
  out.setCreator('GrowSigning');
  return out.save();
}

function markPlace(page: PDFPage, f: any, words: string, font: any, bold: any) {
  const m = mapper(page);
  const vx = f.x * m.W, vy = f.y * m.H, vw = f.w * m.W, vh = f.h * m.H;
  const corners = [m.pt(vx, vy), m.pt(vx + vw, vy), m.pt(vx + vw, vy + vh), m.pt(vx, vy + vh)];
  for (let i = 0; i < 4; i++) page.drawLine({ start: corners[i], end: corners[(i + 1) % 4], thickness: 1.2, color: GREEN, dashArray: [3, 2] });
  // The words above the box, where there is room; inside its top left corner otherwise.
  let size = 7;
  while (size > 4 && bold.widthOfTextAtSize(words, size) > Math.max(vw, 60)) size -= 0.5;
  const above = vy > size + 3;
  const p = m.pt(vx + 1, above ? vy - 2 : vy + size + 1);
  page.drawText(words, { x: p.x, y: p.y, size, font: bold, color: GREEN, rotate: m.rotate });
}

// ---- The scan comes back -----------------------------------------------------------------------------------------

/**
 * Records a scan stored by storeUpload (a PDF, or the photos made into one) as this person's, writes the audit line
 * and tells the sender. `file` is what storeUpload answered.
 */
export async function keepScan(e: any, r: any, file: { id: string; pages: number }, actor: Actor) {
  settlePaper(e.id);
  const way = paperWay(e, r);
  if (!way) throw bad('Signing on paper is not offered on this document any more. Nothing was sent. Sign on screen, or ask the sender.', 409, { code: 'paper_not_offered' });
  if (get('SELECT paper_state FROM recipients WHERE id=?', r.id)?.paper_state === 'waiting') throw bad(`You already sent back a scan, and ${senderOf(e)?.name || 'the sender'} has not looked at it yet. Wait for their answer: we email you if they ask for it again.`, 409, { code: 'paper_waiting' });
  const f = get('SELECT sha256 FROM files WHERE id=?', file.id);
  const sid = newId('pap');
  const t = now();
  const code = paperCode(e, r);
  // Claimed in one statement while the person is still open, so two uploads at the same moment never both wait.
  const claimed = run("UPDATE recipients SET paper_state='waiting' WHERE id=? AND status IN ('sent','viewed') AND COALESCE(paper_state, '')<>'waiting' AND (SELECT status FROM envelopes WHERE id=?)='sent'", r.id, e.id).changes;
  if (!claimed) throw bad('This document is no longer open for signing, or a scan from you is already waiting. Nothing was sent.', 409, { code: 'paper_not_open' });
  run('UPDATE files SET via_envelope=? WHERE id=?', e.id, file.id);
  // Who the request is for at this moment: the scan is theirs alone (settlePaper, acceptScan).
  const who = get('SELECT person_gen, email FROM recipients WHERE id=?', r.id);
  run('INSERT INTO paper_scans (id, envelope_id, recipient_id, file_id, pages, sha256, content_version, code, at, ip, ua, person_gen, email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    sid, e.id, r.id, file.id, file.pages, f?.sha256 || '', e.content_version, code, t, actor.ip || null, (actor.ua || '').slice(0, 300) || null, Number(who?.person_gen) || 0, String(who?.email || '').toLowerCase());
  audit(e.id, actor, 'Sent back a scan signed on paper', `${whoIs(r)}. ${file.pages} page${file.pages === 1 ? '' : 's'}, SHA-256 ${f?.sha256 || ''}, made from the print with security code ${code}. Waiting for the sender to look at it.`);
  const name = r.name || 'Someone';
  const waits = e.ordered && e.recipients.some((x: any) => x.status === 'pending' && x.routing_order > r.routing_order);
  await notifySender(e, 'always', `Signed on paper: ${e.subject}`, `${name} sent back a scan signed on paper`, [
    `${name} printed "${e.subject}", signed it by hand and uploaded a scan of ${file.pages} page${file.pages === 1 ? '' : 's'} through their own link.`,
    `Look at every page, then choose "${PAPER_WORDS.accept(name)}", or "${PAPER_WORDS.again}" and say why.${waits ? ` Until you do, nobody after ${name} is asked.` : ''}`,
    `The code at the top of each page should read ${code}. ${PAPER_WORDS.notChecked}`,
  ], { label: PAPER_WORDS.look, url: `${baseUrl()}/app/envelopes/${e.id}` }, { onPaper: true });
  return { ok: true, state: 'waiting', pages: file.pages };
}

// ---- The sender decides ----------------------------------------------------------------------------------------------

function waitingScan(e0: any, rid: string) {
  settlePaper(e0.id);
  const e = loadEnvelope(e0.id) || e0;
  const r = e.recipients.find((x: any) => x.id === rid);
  if (!r) throw bad('That person is not on this document. Open the document again to see who is.', 404);
  const s = latestScan(r.id);
  // A scan is the person's who sent it, never the next person's on the same request (settlePaper sets it aside).
  if (s?.state === 'waiting' && !sameUploader(s, r)) throw bad(`This scan was sent by the person before ${r.name || 'this person'} on this request, so it cannot be accepted as theirs. Nothing was changed.`, 409, { code: 'no_scan' });
  if (!s || s.state !== 'waiting') throw bad(`There is no scan from ${r.name || 'this person'} waiting to be looked at. Open the document again to see how it stands.`, 409, { code: 'no_scan' });
  return { e, r, s };
}

/** "Accept as signed by <name>": the person finishes through completeRecipient, as having signed on paper. */
export async function acceptScan(e0: any, rid: string, actor: Actor) {
  const { e, r, s } = waitingScan(e0, rid);
  if (e.status !== 'sent') throw bad('This document is no longer out for signing, so the scan cannot be accepted. Nothing was changed.', 409, { code: 'not_open' });
  if (s.content_version !== e.content_version) throw bad(`You changed the document after ${r.name} printed it, so the scan is of an older version. Choose "${PAPER_WORDS.again}" so they print the new one. Nothing was changed.`, 409, { code: 'paper_old_version' });
  const no = notForPaper(e, r);
  if (no) throw bad(`${no} Nothing was changed.`, 409, { code: 'not_for_paper' });
  const t = now();
  // Claimed once: a second Accept, or an Accept and an Ask again at the same moment, find it already decided.
  if (!run("UPDATE paper_scans SET state='accepted', decided_at=?, decided_by=? WHERE id=? AND state='waiting'", t, actor.name, s.id).changes) throw bad('Someone has just decided about this scan. Open the document again to see how it stands.', 409, { code: 'no_scan' });
  run("UPDATE recipients SET paper_scan_id=?, paper_state='accepted' WHERE id=?", s.id, r.id);
  audit(e.id, actor, 'Accepted a scan signed on paper', `As signed by ${whoIs(r)}: the scan uploaded through their link on ${momentText(s.at)} (${s.pages} page${s.pages === 1 ? '' : 's'}, SHA-256 ${s.sha256}). GrowSigning did not check the handwriting.`);
  try {
    const fresh = loadEnvelope(e.id);
    const fr = fresh.recipients.find((x: any) => x.id === r.id);
    // The person finishes as if from their link: the moment is now, the address and browser those of the upload.
    await completeRecipient(fresh, fr, { version: fresh.content_version, [PAPER_FINISH]: s.id }, { name: labelOf(fr), ip: s.ip || undefined, ua: s.ua || undefined });
  } catch (x: any) {
    run("UPDATE paper_scans SET state='waiting', decided_at=NULL, decided_by=NULL WHERE id=?", s.id);
    run("UPDATE recipients SET paper_scan_id=NULL, paper_state='waiting' WHERE id=? AND status<>'completed'", r.id);
    audit(e.id, { name: 'System' }, 'Scan not accepted after all', `${whoIs(r)}. ${x?.message || 'The document could not be finished.'}`);
    throw x;
  }
  const after = get('SELECT status FROM envelopes WHERE id=?', e.id);
  return { ok: true, envelope_status: after?.status };
}

/** "Ask again" with a reason: the scan is set aside, the person is emailed the reason and may send a new one. */
export async function askAgain(e0: any, rid: string, reasonIn: any, actor: Actor) {
  const reason = str(reasonIn, PAPER_REASON_MAX * 2).replace(/\s+/g, ' ').trim();
  if (!reason) throw bad('Say why you ask again, so they know what to do differently. Nothing was sent.', 400, { code: 'reason_needed' });
  if (reason.length > PAPER_REASON_MAX) throw bad(`The reason can be up to ${PAPER_REASON_MAX} characters. Make it shorter and try again.`, 400);
  const { e, r, s } = waitingScan(e0, rid);
  if (e.status !== 'sent') throw bad('This document is no longer out for signing, so there is nothing to ask again. Nothing was sent.', 409, { code: 'not_open' });
  const mail = !!r.email && !r.complained_at;
  // The reason is emailed in the sender's words, so it goes through the same guard as every email they cause.
  const no = mail ? emailRefusal(e, [], { extra: [reason] }) : null;
  if (no) throw bad(no.message, no.status);
  if (!run("UPDATE paper_scans SET state='asked_again', decided_at=?, decided_by=?, reason=? WHERE id=? AND state='waiting'", now(), actor.name, reason, s.id).changes) throw bad('Someone has just decided about this scan. Open the document again to see how it stands.', 409, { code: 'no_scan' });
  run("UPDATE recipients SET paper_state='asked_again' WHERE id=?", r.id);
  audit(e.id, actor, 'Asked again for the scan signed on paper', `${whoIs(r)}. Reason: ${reason}`);
  const sender = senderOf(e);
  if (mail)
    await sendMail({
      to: r.email,
      subject: `Please send the signed pages again: ${e.subject}`,
      heading: `${sender?.name || 'The sender'} asks you to send the scan again`,
      lines: [
        `${sender?.name || 'The sender'} looked at the scan you sent back for "${e.subject}" and asks you to send it again.`,
        `Their reason: "${reason}"`,
        'Open your link, print it again if you need to, sign where it is marked and send new photos of every page.',
      ],
      cta: { label: 'Open the document', url: signUrl(r) },
      envelopeId: e.id,
      recipientId: r.id,
      onPaper: true,
      ...(sender ? { replyTo: sender.email, fromName: sender.name } : {}),
    });
  return { ok: true, emailed: mail };
}

/** The scans of a document for its envelope page, newest first, with what the sender needs to check each one. */
export function scansView(e: any) {
  settlePaper(e.id);
  const code = (r: any) => paperCode(e, r);
  return all('SELECT * FROM paper_scans WHERE envelope_id=? ORDER BY at DESC, rowid DESC', e.id).map((s: any) => {
    const r = e.recipients.find((x: any) => x.id === s.recipient_id);
    return {
      id: s.id, recipient_id: s.recipient_id, name: r?.name || '', state: s.state, at: s.at, pages: s.pages, code: s.code,
      // The print it was made from is of the document as it is now: the codes match only then.
      current: !!r && s.code === code(r) && s.content_version === e.content_version,
      decided_at: s.decided_at, decided_by: s.decided_by, ...(s.reason ? { reason: s.reason } : {}),
    };
  });
}

export function scanFile(e: any, rid: string, scanId?: string | null) {
  const s = scanId ? get('SELECT * FROM paper_scans WHERE id=? AND envelope_id=? AND recipient_id=?', scanId, e.id, rid) : get('SELECT * FROM paper_scans WHERE envelope_id=? AND recipient_id=? ORDER BY at DESC, rowid DESC LIMIT 1', e.id, rid);
  if (!s) throw bad('There is no scan from this person. Open the document again to see how it stands.', 404);
  return s;
}

// ---- The signed PDF and the certificate ----------------------------------------------------------------------------

/** The people on this document who signed on paper: their recipient id and the accepted scan. */
export function paperSigned(e: any): Map<string, any> {
  const out = new Map<string, any>();
  for (const r of e.recipients || []) {
    if (!r.paper_scan_id || r.status !== 'completed') continue;
    const s = get("SELECT s.*, f.sha256 file_sha FROM paper_scans s JOIN files f ON f.id=s.file_id WHERE s.id=? AND s.state='accepted'", r.paper_scan_id);
    if (s) out.set(r.id, s);
  }
  return out;
}

/**
 * Called by renderEnvelopePdf after the documents: for each person who signed on paper, a divider page "Signed on
 * paper by <name>" and the scan, and on each of their places "Signed on paper: see page N", N being the divider.
 */
export async function addPaperScans(e: any, doc: PDFDocument, o: {
  font: any; bold: any; footLine: string; mark: [string, string] | null; places: any[]; docPages: Map<string, PDFPage[]>; flat: (sha: string) => Promise<PDFPage[]>;
}) {
  const signed = paperSigned(e);
  if (!signed.size) return;
  const sender = senderOf(e);
  for (const r of e.recipients) {
    const s = signed.get(r.id);
    if (!s) continue;
    const at = doc.getPageCount() + 1;
    const sheet = new Sheet(doc, o.font, o.bold, o.footLine);
    sheet.y = sheet.H - 80;
    sheet.text(dividerTitle(r.name), { size: 18, bold: true, color: GREEN, gap: 12 });
    sheet.text(`The next ${s.pages} page${s.pages === 1 ? ' is a scan' : 's are a scan'} that ${r.name} uploaded through their own signing link on ${momentText(s.at)}. ${s.decided_by || sender?.name || 'The sender'} accepted it as signed by ${r.name} on ${momentText(s.decided_at)}.`, { size: 10.5, gap: 8 });
    sheet.text(`GrowSigning did not read or check the handwriting. This is not an electronic signature: it is a picture of pages signed by hand. SHA-256 of the scan as uploaded: ${s.file_sha}`, { size: 9, color: MUTED, gap: 6 });
    if (o.mark) drawStamp(sheet.page, o.bold, o.mark);
    try {
      for (const p of await o.flat(s.file_sha)) {
        doc.addPage(p);
        drawFootClear(p, mapper(p), [], { line: o.footLine, font: o.font, color: MUTED });
        if (o.mark) drawStamp(p, o.bold, o.mark);
      }
    } catch (err: any) {
      // Like a signer's attachment: a stored scan that failed its check is never left out of a copy kept for good.
      if (err?.data?.code === 'file_damaged' || err?.data?.code === 'file_locked') throw err;
    }
    for (const f of o.places.filter((x: any) => x.recipient_id === r.id)) {
      const page = o.docPages.get(f.document_id)?.[f.page];
      if (page) pointTo(page, f, at, o.font);
    }
  }
}

function pointTo(page: PDFPage, f: any, at: number, font: any) {
  const m = mapper(page);
  const vx = f.x * m.W, vy = f.y * m.H, vw = f.w * m.W, vh = f.h * m.H;
  let words = placeWords(at);
  let size = Math.max(3.5, Math.min(8, vh * 0.5));
  while (size > 3.5 && font.widthOfTextAtSize(words, size) > vw - 3) size -= 0.5;
  if (font.widthOfTextAtSize(words, size) > vw - 3) {
    words = placeShort(at);
    size = Math.max(3, Math.min(8, vh * 0.5));
    while (size > 3 && font.widthOfTextAtSize(words, size) > vw - 2) size -= 0.5;
  }
  const p = m.pt(vx + 1.5, vy + vh / 2 + size * 0.35);
  page.drawText(words, { x: p.x, y: p.y, size, font, color: GREEN, rotate: m.rotate });
}

/** The certificate's lines for someone who signed on paper. None for anyone else. */
export function paperCertLines(e: any, r: any, ts: (at: string | null | undefined) => string): [string, string][] {
  if (!r.paper_scan_id || r.status !== 'completed') return [];
  const s = get("SELECT * FROM paper_scans WHERE id=? AND state='accepted'", r.paper_scan_id);
  if (!s) return [];
  return [
    ['Signed on paper', paperCertSentence({ uploaded: ts(s.at), from: s.ip || '', by: s.decided_by || senderOf(e)?.name || 'the sender', accepted: ts(s.decided_at) })],
    ['Scan', `${s.pages} page${s.pages === 1 ? '' : 's'}, security code ${s.code}, SHA-256 ${s.sha256}`],
  ];
}

/** The status the certificate gives someone who signed on paper, or '' for anyone else. */
export const paperStatus = (r: any): string => (r?.paper_scan_id && r.status === 'completed' ? (r.role === 'approver' ? 'Approved on paper' : PAPER_WORDS.accepted) : '');

/** For the timer: someone whose scan waits gets no reminder to sign, since they did. */
export const scanWaits = (r: any): boolean => r?.paper_state === 'waiting';

export { scansOf, latestScan };
