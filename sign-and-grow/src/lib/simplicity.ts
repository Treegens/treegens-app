import { listName } from './docname.ts';

// Round 6 of making GrowSigning simpler (build-simplicity-r6, tests/simplicity-r6.test.ts): the words and small rules
// that several screens share, so a page and its test read the same thing. Nothing here decides a fact; each function
// only turns facts the page already has into what a person reads. research/ux-charter.md is the rulebook.

/** The smallest size of anything a person taps or clicks, in CSS pixels (charter P11). */
export const TARGET_PX = 44;

// ---- 1. The done screen of a person who signs (charter 2.6, step 8: "what happens next, Download") ----------------

/**
 * The sentence under "All done" or "You are done". The PDF's last pages are its signing record (charter section 4:
 * "Signing record", never "certificate", which on screens only means a signer's or an organisation's certificate).
 */
export function doneLine(f: { allDone: boolean; inPerson: boolean; sender: string; email: string }): string {
  if (f.allDone) return f.inPerson
    ? `The completed document, with its signing record, has been emailed to ${f.sender}. Download your own copy here.`
    : `A copy has been emailed to ${f.email}. Its last pages are the signing record: who signed and when.`;
  return f.inPerson
    ? `${f.sender} will get the completed document by email once everyone has finished. You can download it as it stands now.`
    : `Others still need to finish. We will email the completed document to ${f.email} as soon as they have.`;
}

/**
 * The buttons of the done screen, in order. Download is the one main button: it works the same on every phone and
 * computer, and it is what the charter names. Opening it in the browser stays, as the second, plain button.
 */
export function doneActions(allDone: boolean): { key: 'download' | 'open'; label: string; primary: boolean }[] {
  return [
    { key: 'download', label: allDone ? 'Download the signed PDF' : 'Download it as it stands', primary: true },
    { key: 'open', label: 'Open it here', primary: false },
  ];
}

// ---- 3. Editor, step 3: the order of the page (charter 2.3) ---------------------------------------------------------

/** What step 3 shows, top to bottom: who gets it first, then the email they get. */
export const STEP3_ORDER = ['preview', 'who', 'message', 'more', 'send'] as const;

// ---- 4. Documents: the line under the title, and the count line ------------------------------------------------

/**
 * The line under "Documents". It used to read "Free, also after you cancel. For everything, see Settings, Records and
 * data.", which explained the ZIP button without naming it. Now it names what it is about.
 */
export const documentsIntro = (_admin?: boolean): string => 'Sent documents and drafts, most recently changed first.';

/**
 * repair-simplicity-r6: the line that goes with the ZIP button, under it and only when the button is shown. It used to
 * be the page's intro, so a new account read about downloading with no download in sight.
 */
export const exportNote = (admin: boolean): string =>
  `Downloading your signed PDFs is free, also after you cancel.${admin ? ' The full export is in Settings, Records and data.' : ''}`;

/**
 * The count line above the list. "Tick the boxes" is said only when a row has a box to tick: a list of drafts has
 * none, and the hint sent people looking for boxes that were not there.
 */
export function countLine(rows: number, tickable: number, page: number): string {
  if (rows <= 0) return '';
  const full = rows === page;
  // "Several" needs two boxes: with one, its own Download is the way (repair-simplicity-r6).
  return `${rows}${full ? ' most recently updated' : ''} document${rows === 1 ? '' : 's'}${full ? '. Search to find older ones' : ''}.${tickable > 1 ? ' Tick the boxes to download several as one ZIP.' : ''}`;
}

// ---- 5. Settings: one line under each email switch (charter 2.2: "One line of explanation under a control") ------

export const NEEDS_YOU_LINE = 'Someone declined, an email to a signer could not be delivered, a request sits unopened, a link could not be opened, or the deadline is close or has passed.';
/** Said once under the switches, not under one of them: what reaches you whatever you choose. */
export const ALWAYS_REACH = 'A few emails reach you whatever you choose here, because only you can act on them: a signer passed the document on, changed how their name is written, or asked for more time or for an access code.';

// ---- 9. Editor, step 1: one control for the pages of a file --------------------------------------------------------

/** The file row's Pages button carries the count, so the row does not say "2 pages" and then "Pages". */
export const pagesButton = (pages: number): string => (pages > 0 ? `${pages.toLocaleString('en')} ${pages === 1 ? 'page' : 'pages'}` : 'Pages');

// ---- 8. Settings, Profile: the address is said once ----------------------------------------------------------------

/**
 * The line of the Email address card. The Profile card above it used to repeat the address with "confirmed" next to
 * Save profile; now this one line says it, and says "not confirmed yet" only when that is so.
 */
export const emailLine = (email: string, confirmed: boolean, bounced: boolean): string =>
  `You sign in with ${email}${confirmed ? '' : ', which is not confirmed yet'}, and our emails to you go there.${bounced ? ' Our last email to it came back, see the notice at the top.' : ''}`;

// ---- 7. The signing page's top bar names the document (charter 2.6, Header) ------------------------------------------

/**
 * The words in the signing page's top bar. The bar is narrow on a phone, so the app's own "Please sign: " (which the
 * consent heading and the email already say) is left out and the document's name is what shows: "Planting
 * partnership", never "Please sign: Pla...". A subject the sender wrote in their own words is shown as written.
 */
export const barTitle = (subject: unknown): string => listName(subject);

// ---- 13. Documents: a ZIP button that has something in it, and a search box that says what it finds ---------------

/**
 * "Download signed PDFs (ZIP)" is shown once something is completed (repair-simplicity-r6: it was "once something was
 * sent", which showed it while nothing was signed yet). Before that it only ever answered "There is nothing to
 * download yet", a button that did nothing on the first visit (charter P3: no dead buttons). While the answer is not
 * in yet it stays hidden, so it never flashes. The page passes the answer of /envelopes?box=completed&limit=1.
 */
export const exportShown = (done: { envelopes?: unknown[] } | null | undefined): boolean => !!done?.envelopes?.length;

/** The search box's hint, short enough for a phone: it used to be cut off at "document text or I". */
export const SEARCH_HINT = 'Search names, people or words';

// ---- repair-simplicity-r6: Home's one-person line --------------------------------------------------------------------

/**
 * Whether Home shows "Only you can manage this account" (src/components/sender/OnePersonLine.tsx). Only for an admin
 * of a team of two or more people with fewer than two admins: a person who works alone has nobody to lock out, and a
 * paid plan alone is no reason. The full explanation is on Settings, Team, for everyone it concerns.
 */
export const onePersonLineShown = (m: { role?: string; admins?: number; members?: number }): boolean =>
  m.role !== 'member' && Number(m.admins ?? 0) < 2 && Number(m.members ?? 0) > 1;

// ---- repair-simplicity-r6: Documents, the status chip of a row ------------------------------------------------------

/**
 * The chip of a waiting row. It said "Waiting for others" while the line under it said "Waiting on You" when the
 * only person left was the sender. Now the chip says "Waiting for you" then, and is unchanged in every other case.
 */
export const rowStatusLabel = (status: string, w: { you?: boolean; people?: unknown[] } | null | undefined): string | undefined =>
  status === 'sent' && w?.you && (w.people?.length ?? 0) === 1 ? 'Waiting for you' : undefined;
