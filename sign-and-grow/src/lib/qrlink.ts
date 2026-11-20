// What a screen checks before it draws a QR code for a link, and the words it puts next to one. No React in here,
// so it can be tested on its own. The picture comes from ./qr.ts and is made in the browser: the link is not sent
// anywhere to be drawn.
import { qrEncode, qrSvg, type Qr } from './qr.ts';

/** The longest link a code is drawn for. More than this makes a code too fine for a phone to read off a screen. */
export const QR_LINK_MAX = 300;
/** A personal code is taken off the screen after this long, so it is not left there for the next person who walks by. */
export const QR_SHOW_SECONDS = 120;

export type QrLink =
  | { ok: true; link: string; qr: Qr; svg: string; reach: 'anywhere' | 'network' | 'computer'; note: string }
  | { ok: false; why: string };

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/;
const PRIVATE = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|.*\.local|\[f[cd][0-9a-f]{2}:.*\]|\[fe[89ab][0-9a-f]:.*\])$/;

/** Where a phone has to be to open this address: anywhere, on the same network, or nowhere but this computer. */
export function qrReach(host: string): 'anywhere' | 'network' | 'computer' {
  const h = String(host || '').toLowerCase();
  return LOOPBACK.test(h) ? 'computer' : PRIVATE.test(h) ? 'network' : 'anywhere';
}

/**
 * Checks a link and draws its code. A code is only made for a web link, written out the way a browser writes it
 * (so it holds plain letters and nothing a reader could trip over), and only when it is short enough to scan.
 * A link with a user name in front of the host is refused: "https://bank.example@other.example" opens the second
 * address while showing the first, and nothing this app hands out looks like that.
 */
export function qrForLink(raw: string): QrLink {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, why: 'There is no complete link to make a code from. Copy the link and send it instead.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'A QR code is only made for a web link, one that starts with https://.' };
  if (u.username || u.password) return { ok: false, why: 'This link has a user name in front of its address, which can hide where it really goes. No code is made for it.' };
  const link = u.href;
  if (link.length > QR_LINK_MAX) return { ok: false, why: `This link is ${link.length} characters long. A code for more than ${QR_LINK_MAX} is too fine for a phone camera to read, so none is made. Copy the link and send it instead.` };
  const qr = qrEncode(link);
  const reach = qrReach(u.hostname);
  const note = reach === 'computer' ? `This link points at ${u.hostname}, which is the computer the app runs on. A phone that scans the code cannot open it. It works once the app is opened under its public address.`
    : reach === 'network' ? `This link points at ${u.hostname}, an address inside a private network. A phone can open it only while it is on the same network.` : '';
  return { ok: true, link, qr, svg: qrSvg(qr), reach, note };
}

// ---- Words ---------------------------------------------------------------------------------------------------------

const DOES: Record<string, string> = { signer: 'read and sign', approver: 'read and approve' };
const AS: Record<string, string> = { signer: 'sign it', approver: 'approve it' };
// The whole name as the sender wrote it. Which word of a name is the one to call someone by differs from country to
// country (the family name comes first in much of Asia), so no first name is guessed.
const called = (name: string) => String(name || '').trim() || 'them';

/** Above a personal code: what the person next to the sender has to do, and what happens then. */
export const personScanLine = (name: string, role: string) =>
  `Ask ${called(name)} to point the camera of their phone at this code and tap the link it shows. The document opens on their own phone, and they ${DOES[role] || 'read it'} there.`;

/** Under a personal code. The code is the link, so it is shown to one person only. */
export const personCodeWarning = (name: string, role: string) =>
  `This code is the link. Whoever scans it, or takes a photo of it, can open the document${AS[role] ? ` and ${AS[role]}` : ''} as ${name || 'this person'}. Show it only to ${name || 'the person it is for'}, and close this window when they have scanned it.`;

/** What stands between scanning and the document, when the sender asked for a check. The QR code carries none of it. */
export function afterScanLine(r: { access_code?: string | null; verify?: string | null }): string {
  const code = r.access_code ? 'The access code is not part of the QR code. They are asked for it after scanning, so tell it to them yourself.' : '';
  const once = r.verify === 'sms_code' ? 'After scanning they are asked for a one-time code, which goes to their phone by text message.'
    : r.verify === 'email_code' ? 'After scanning they are asked for a one-time code, which goes to their email address.' : '';
  return [code, once].filter(Boolean).join(' ');
}
export const SCAN_TROUBLE = 'If the camera does not pick it up, turn the screen brightness up and hold the phone about a hand away. Still nothing? Close this and use Copy link.';
export const hiddenLine = (name: string) => `The code was taken off the screen after ${QR_SHOW_SECONDS / 60} minutes, so that it is not left here for someone other than ${name || 'the person it is for'}.`;

/** Printed on the sheet of a public form: one line on what happens when someone scans it. */
export const FORM_SCAN_LINE = 'Point the camera of your phone at this code and tap the link it shows. The form opens in your browser, where you fill in your details and sign. No app and no account are needed.';
/** Printed on the sheet above the link written out. A sticker over the code would show another address. */
export const FORM_LINK_LINE = 'The code holds this link and nothing else. If your phone shows a different address, do not open it. You can also type the link yourself. Capital and small letters matter.';

/** Said to the owner on the screen, never printed. `counted` is whether this server counts signatures at all. */
export const formCodeWarning = (counted: boolean) =>
  `This code is the link to your form. Whoever scans it, or a photo of it, can open the form, fill it in and sign${counted ? ', and each person who signs uses one of your signatures' : ''}. Put the sheet up only where the people it is for will see it. When you pause or delete the form, the code stops working with it.`;
export const FORM_PAUSED_LINE = 'This form is paused. Someone who scans the code now is told that the form is not available. Resume it on the PowerForms page before you put the sheet up.';

/** On a public form that is open on a big screen: the same form, on the visitor's own phone. */
export const OWN_PHONE_LINE = 'Point the camera of your phone at this code and tap the link it shows. The same form opens on your phone. Nothing you typed here is carried over, so you start there with an empty form.';

/** A file name for the saved picture, from the name of the form: plain letters and digits, nothing a disk refuses. */
export const qrFileName = (name: string) => `${String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase() || 'form'}-qr-code.png`;
