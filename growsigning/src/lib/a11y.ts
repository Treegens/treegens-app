// The accessibility statement at /accessibility, and the words shared with the text view and the tests: what was
// checked, when and how, what works and what does not yet. One place, so the page, docs/acr.md and the README never
// say different things. No imports with side effects: pages and tests may import it.
//
// When the checks are run again (docs/a11y-checks.md), change LAST_CHECK and the lists below in the same change.

export const LAST_CHECK = {
  /** The day the checks in docs/a11y-checks.md were last run, YYYY-MM-DD. */
  date: '2026-11-21',
  /** How, in the words the statement prints. */
  method: 'Checked by the authors with axe-core and by hand; not audited.',
};

/** "21 November 2026", from the date above. Written out, so it reads the same on every server and in every zone. */
export function checkedOn(iso = LAST_CHECK.date): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** What the checks found to work. Each line is something docs/a11y-checks.md tried, not something hoped for. */
export const WORKS: string[] = [
  'Signing a document with the keyboard alone: Tab, Enter and Space reach every step, from the consent tick to Finish, on a phone-sized screen and on a large one.',
  'Next moves the focus to the next field that needs you, and opens the signature or stamp box when that is what the field needs.',
  'Each field tells a screen reader its name, whether it is required or optional, and the page it is on.',
  'The document can be read as text instead of as pictures of the pages: "Read the document in Easy reading instead" is the first thing the keyboard reaches on the document, and the view can also be changed under View. Easy reading shows the words in one column, with headings, lists and tables, and every field as an ordinary form where it sits in the text.',
  'A signature can be typed instead of drawn, and a stamp can be chosen as a file instead of taking a photo.',
  'The pages work at 320 pixels wide, which is a large screen at 400 percent zoom, without scrolling sideways.',
  'The buttons of the signing page are at least 44 pixels tall. On a phone every field on the document takes a tap 44 pixels across, and on a large screen a small tick box or round button on the document still takes one 24 pixels across. The tick to agree before signing can be pressed anywhere on its sentence.',
  'Placing fields in the editor does not need dragging: choose a field type with the keyboard and it lands on the page in view, the arrow keys move it, and its size can be typed in.',
];

/** What does not work yet, or was not checked. Said plainly, so nobody finds it out halfway through a document. */
export const NOT_YET: string[] = [
  'A document is only as readable as the file the sender uploaded. A scan or a photo of a page has no text, so a screen reader has nothing to read there unless the people who run this server have set up text reading for scanned pages.',
  'The signed PDF that everyone receives has no marked headings or reading order, so a screen reader reads it from top to bottom. While signing, use Easy reading.',
  'Drawing a signature needs a mouse, a finger or a pen. Typing it is offered next to drawing.',
  'We could not try the pages with VoiceOver on an iPhone or with NVDA on Windows. We checked what a screen reader is told using the tools built into the Chrome browser. Some screen readers may say things in a different order.',
  'Screens for the people who run this server, and the emails, were not checked.',
  'Some screens are not split into named regions, so jumping from region to region with a screen reader helps less there. Headings work on every screen we checked.',
];

/** The warning printed beside text that was read by a machine from a picture of a page. Word for word, everywhere. */
export const OCR_WARNING = 'Text read by a machine from a picture of the page. It may contain mistakes. What you sign is the page.';

/** Whether this server reads text from scanned pages: OCR_CMD (a command such as Tesseract) or OCRMYPDF_URL is set. */
export const ocrOn = (env: Record<string, string | undefined> = process.env): boolean => !!((env.OCR_CMD || '').trim() || (env.OCRMYPDF_URL || '').trim());
