// The name a document gets from its file name, so the email subject, the signer's title bar, every list and the
// downloaded file read well: "planting-partnership.pdf" becomes "Planting partnership". The file name has already
// lost its extension when it gets here (KNOWN_EXT in src/lib/convert.ts).
//
// Only what a file name does for want of spaces is undone. Underscores become spaces. In a file name that had no
// spaces of its own, a hyphen next to a letter becomes a space too ("planting-partnership_2026" gives "Planting
// partnership 2026", "lease-2026-03-01" gives "Lease 2026-03-01"); a name typed with spaces keeps its hyphens
// ("Well-being policy.pdf" stays). A hyphen between two digits always stays, so a date such as 2026-03-01 is
// untouched. A first word in small letters gets a capital, and nothing else is changed: "NDA", "iPhone" and a
// person's name keep the capitals they were typed with.
export function nameFromFile(base: string): string {
  const typed = String(base ?? '');
  let s = typed.replace(/_+/g, ' ');
  if (!/\s/.test(typed.trim())) s = s.replace(/(?<=\p{L})-+(?=[\p{L}\p{N}])|(?<=\p{N})-+(?=\p{L})/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // A first word typed with a capital anywhere ("iPhone", "eSIM") is left as it is.
  const firstWord = s.split(' ')[0];
  if (firstWord !== firstWord.toLocaleLowerCase()) return s;
  const head = String.fromCodePoint(s.codePointAt(0)!);
  return head.toLocaleUpperCase() + s.slice(head.length);
}

/** What the editor puts in front of the document's name to make the subject of the invitation email. */
export const ASK_PREFIX = 'Please sign: ';

/**
 * The name a document goes by in a list and as a downloaded file: its subject without the "Please sign: " that
 * belongs to the invitation email. "Please sign: Planting partnership" is listed as "Planting partnership" and saved
 * as "Planting partnership.pdf". A subject the sender wrote in their own words is shown as they wrote it.
 */
export function listName(subject: unknown): string {
  const s = String(subject ?? '').trim();
  const rest = s.toLowerCase().startsWith(ASK_PREFIX.trim().toLowerCase()) ? s.slice(ASK_PREFIX.trim().length).trim() : '';
  return rest || s;
}
