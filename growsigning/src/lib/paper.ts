// Signed on paper: someone prints the document, signs it by hand and sends back a photo or a scan through their own
// link, and the sender looks at it and accepts it as signed by them, or asks again with a reason. The words and the
// numbers the server (src/server/paper.ts), the signing page (src/components/sign/Paper.tsx), the envelope page
// (src/components/sender/PaperReview.tsx), the editor and Settings share. No imports, no side effects.
//
// What it is: a record that says exactly what happened. A scan came through this person's link at a moment from an
// address, and the sender accepted it. What it is not: an electronic signature, a check of handwriting, a check that
// the person who wrote on the paper is the person on the document. GrowSigning reads nothing on the scan.

/** The roles that may sign on paper. Not someone who signs in person, a witness, a group or anyone who signs nothing. */
export const PAPER_ROLES = ['signer', 'approver'];

/** The largest upload, all photos together, and the most photos in one upload (the same as storeUpload's). */
export const PAPER_MAX_MB = 25;

/** The longest reason the sender may give for asking again. */
export const PAPER_REASON_MAX = 500;

/** How this person may sign: 'may' (on screen or on paper), 'only' (on paper only), or null (on screen only). */
export type PaperWay = 'may' | 'only' | null;

/** The editor's choice for one person, from their two API values (allow_paper, require_paper). */
export type PaperPick = 'link' | 'screen' | 'paper';
export const paperPick = (r: { allow_paper?: any; require_paper?: any }): PaperPick => (r.require_paper ? 'paper' : r.allow_paper === 0 || r.allow_paper === false ? 'screen' : 'link');
export const PICK_WORDS: Record<PaperPick, string> = {
  link: 'On screen or on paper',
  screen: 'On screen only',
  paper: 'On paper only',
};
/** The line in a person's More, short. */
export const PICK_SHORT: Record<PaperPick, string> = { link: 'On screen or on paper', screen: 'On screen only', paper: 'On paper only' };

export const PAPER_WORDS = {
  setting: 'People may sign on paper',
  settingHint: 'Someone you send to can print the document, sign it by hand and send back a photo or a scan. You look at it and accept it, or ask again. Off: nobody is offered paper.',
  /** Under a person in the editor, for "On paper only". */
  onlyNote: 'They get a print with their places marked, sign it by hand and send back a photo. You accept it on the document page.',
  /** The envelope page's main button when a scan waits. */
  look: 'Look at the scan',
  accept: (name: string) => `Accept as signed by ${name}`,
  again: 'Ask again',
  /** The person's status while their scan waits. */
  waiting: 'Signed on paper, waiting for the sender to check',
  waitingSender: 'Signed on paper, waiting for you to check',
  askedAgain: 'Asked to send the scan again',
  accepted: 'Signed on paper',
  /** What the sender is told about what was and was not checked. */
  notChecked: 'GrowSigning did not read or check the handwriting. Look at every page before you accept it.',
};

/** The sentence of the certificate, with the moments and the address filled in. `product` is our name. */
export function paperCertSentence(o: { uploaded: string; from: string; by: string; accepted: string; product?: string }): string {
  return `Signed on paper. A scan was uploaded through this person's link on ${o.uploaded} from ${o.from || 'an unknown address'} and accepted by ${o.by} on ${o.accepted}. ${o.product || 'GrowSigning'} did not check the handwriting.`;
}

/** What each of this person's places prints in the signed PDF. */
export const placeWords = (page: number) => `Signed on paper: see page ${page}`;
/** The same for a place too small for the sentence. */
export const placeShort = (page: number) => `See p. ${page}`;
/** The page that comes before the scan in the signed PDF. */
export const dividerTitle = (name: string) => `Signed on paper by ${name}`;

/** The mark printed at a place on the print, by the kind of field. Empty for a field that needs nothing written. */
export function printMark(type: string, label?: string | null): string {
  if (type === 'signature') return 'Sign here';
  if (type === 'initials') return 'Initial here';
  if (type === 'stamp') return 'Stamp here';
  if (type === 'date_signed') return "Today's date";
  if (type === 'checkbox' || type === 'radio') return 'Tick';
  if (['full_name', 'first_name', 'last_name', 'email', 'company', 'title', 'text', 'number', 'date', 'dropdown'].includes(type)) {
    const what = String(label || '').trim() || { full_name: 'Your full name', first_name: 'First name', last_name: 'Last name', email: 'Email', company: 'Company', title: 'Title', text: 'Write here', number: 'Number', date: 'Date', dropdown: 'Write your choice' }[type]!;
    return what.slice(0, 60);
  }
  return '';
}
