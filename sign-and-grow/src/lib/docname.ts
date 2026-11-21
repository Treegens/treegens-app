// The name a document gets from its file name, so the email subject, the signer's title bar, every list and the
// downloaded file read well: "planting-partnership.pdf" becomes "Planting partnership". The file name has already
// lost its extension when it gets here (KNOWN_EXT in src/lib/convert.ts).
//
// Only what a file name does for want of spaces is undone: underscores become spaces, and so does a hyphen between
// two letters in a name that has no spaces at all ("well-being" in "Well-being policy.pdf" stays). Digits keep their
// hyphens, so a date such as 2026-03-01 is untouched. A first word in small letters gets a capital, and nothing else
// is changed: "NDA", "iPhone" and a person's name keep the capitals they were typed with.
export function nameFromFile(base: string): string {
  let s = String(base ?? '').replace(/_+/g, ' ');
  if (!/\s/.test(s.trim())) s = s.replace(/(?<=\p{L})-+(?=\p{L})/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // A first word typed with a capital anywhere ("iPhone", "eSIM") is left as it is.
  const firstWord = s.split(' ')[0];
  if (firstWord !== firstWord.toLocaleLowerCase()) return s;
  const head = String.fromCodePoint(s.codePointAt(0)!);
  return head.toLocaleUpperCase() + s.slice(head.length);
}
