// Signing at a service counter (research/government.json, G18): an official helps a person sign in front of them,
// and records what they checked and what help they gave. The words and numbers the Counter page, the person's own
// screen, the certificate and the server share are here. The rules are in src/server/counter.ts.
//
// What the software does and does not do, said once and used on every screen of the Counter: it writes down what
// the official states. It cannot look at an identity document, and nothing here makes a signature valid.

/** The one line every Counter screen carries. */
export const CANNOT_CHECK_ID = 'GrowSigning cannot check an identity document. It records what the official states they saw.';

/** The one ID question of the in-person flow (the same question ds-id-small asks a host). */
export const ID_QUESTION = 'Which ID did you see?';

/** Ways an official can know who is in front of them. "eID checked" joins this list once the server checks an eID (G09). */
export const ID_METHODS = [
  { key: 'document', label: 'An identity document' },
  { key: 'known', label: 'Nothing: I know this person' },
] as const;
export type IdMethod = (typeof ID_METHODS)[number]['key'];

/** Kinds of identity document. "Other" takes the official's own words. */
export const ID_DOC_TYPES = ['Passport', 'National identity card', 'Driving licence', 'Residence permit', 'Other'] as const;

/** The statement the official makes with their own login, word for word. It is printed as theirs. */
export const ID_STATEMENT = "I checked this person's identity as recorded above.";

/** The help an official can give, each written on the certificate in words. */
export const HELPS = {
  mark: { label: 'Signs with a mark', hint: 'An X or any mark of their own, in front of a witness.' },
  behalf: { label: 'Someone signs for them', hint: 'They cannot sign. They ask out loud, and two officials hear it.' },
  read_aloud: { label: 'The document was read aloud', hint: 'You read the whole document to them.' },
  interpreter: { label: 'An interpreter helped', hint: 'Name and language of the interpreter.' },
} as const;
export type HelpKind = keyof typeof HELPS;
export const HELP_KINDS = Object.keys(HELPS) as HelpKind[];

/** What the official states for each kind of help. `p` is the person signing, `o` the official, `x` the second official. */
export function helpStatement(kind: HelpKind, v: { p: string; o?: string; x?: string; language?: string; interpreter?: string }): string {
  if (kind === 'mark') return `I saw ${v.p} make their mark in place of a signature.`;
  if (kind === 'behalf') return `${v.p} cannot sign and asked out loud for me to sign for them.`;
  if (kind === 'read_aloud') return `I read the whole document aloud to ${v.p} in ${v.language}.`;
  return `${v.interpreter} interpreted between ${v.p} and me in ${v.language}.`;
}

/** What the second official states when someone signs for the person. */
export const behalfSecond = (p: string, o: string) => `I heard ${p} ask out loud for ${o} to sign for them.`;

/** The line under the signature pad on the Counter page. */
export const PAD_LINE = 'A signature pad that works as a pen in the browser can be used. GrowSigning keeps the drawn picture only, not pressure or speed.';

/** The short code that connects the person's own screen. Letters and digits that cannot be read as one another. */
export const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_LENGTH = 6;
export const PAIR_MINUTES = 10;
/** The page the person's screen opens. */
export const SCREEN_PATH = '/counter/screen';

/** A code as typed: capitals, no spaces or dashes. Null when it cannot be one. */
export function cleanCode(raw: unknown): string | null {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (s.length !== PAIR_LENGTH) return null;
  return [...s].every((ch) => PAIR_ALPHABET.includes(ch)) ? s : null;
}
/** A code written in two halves, as the screen shows it: "K7M 2QX". */
export const showCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** The last characters of a document number: exactly 4 letters or digits, nothing more. */
export const LAST_CHARS = 4;
export function cleanLast(raw: unknown): string | null {
  const s = String(raw ?? '').toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{4}$/.test(s) ? s : null;
}

/** How the identity check reads on the certificate and the receipt, from what was recorded. */
export function idWords(v: { id_method?: string | null; id_doc_type?: string | null; id_last4?: string | null; id_country?: string | null }): string {
  if (v.id_method === 'known') return 'Known to the official personally. No document was recorded.';
  if (v.id_method === 'document') return `${v.id_doc_type || 'Identity document'} issued by ${v.id_country || 'a country not recorded'}, number ending ${v.id_last4 || 'not recorded'}, seen by the official.`;
  return 'Not recorded.';
}

/** Paper sizes the receipt prints on. */
export const RECEIPT_SIZES = [
  { key: '80mm', label: 'Receipt printer (80 mm)' },
  { key: 'a4', label: 'A4 sheet' },
] as const;

/** Where the person can check their copy, for the receipt: the public page and the envelope's ID. */
export const receiptCheckLine = (verifyUrl: string, envelopeId: string) => `To check that a copy is the real one, open ${verifyUrl} and type ${envelopeId}.`;
