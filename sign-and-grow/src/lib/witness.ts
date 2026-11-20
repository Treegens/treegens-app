// A witness for one signer: a person who was physically there and saw that signer sign, for the documents that need
// one (a deed in England and Wales, for example). The rules and the words that both the pages and the server quote
// live here. Plain values and functions, so a page may import them. The server side is src/server/witness.ts.
//
// What the role means everywhere: a witness belongs to one person who signs (witness_for), is asked straight after
// that person has signed whatever the signing order says, never uses a signature, and fills in a block the sender
// places near that person's signature. The sender names the witness, or leaves it to the signer (named_by_signer),
// who then names them on the review screen before Finish. Sign&Grow records what the witness states. It cannot check
// that they were in the room, and no sentence here may suggest that it can.

/** The month the help entry and the official guide it points to were last read. */
export const WITNESS_CHECKED = 'November 2026';
/** HM Land Registry, practice guide 8: execution of deeds. The official source the research cites. */
export const WITNESS_SOURCE = 'https://www.gov.uk/government/publications/execution-of-deeds/practice-guide-8-execution-of-deeds';

/** The roles a witness can be there for: someone who signs, on their own device or on the sender's. */
export const WITNESSED_ROLES = ['signer', 'inperson'];
/** How many times one witness place can be given to a person by the signer: a first name and a few corrections. */
export const WITNESS_NAMES_MAX = 4;

export const isWitness = (r: any): boolean => r?.role === 'witness';
/** A witness with no address yet: the signer has to name them (or name another one, after "I was not there"). */
export const waitsForName = (r: any): boolean => isWitness(r) && !String(r?.email || '').trim();
/** What an unnamed witness is called until the signer names them, wherever a name has to be shown. */
export const openWitnessName = (signer: any): string => `Witness for ${String(signer?.name || '').trim() || 'the signer'}`;

/** Who may be a witness, in one paragraph: on the signer's review screen and next to the choice in the editor. */
export const WHO_MAY_WITNESS =
  'A witness has to be an adult who is not a party to this document: they do not sign it as one of the people it binds, and it gives them nothing. They have to be physically with the person who signs, in the same room, and watch them sign. Someone on a video call is usually not enough. The rules differ by country and by kind of document, and some ask for more, so check what applies before anyone signs.';

/** What the product does and does not do, said wherever a witness is offered: editor, signing page, certificate, help. */
export const WITNESS_RECORDS =
  'Sign&Grow records what the witness states, when they stated it, and from which internet address and browser. It cannot check that they were in the room. Whether a document witnessed this way is accepted depends on the law that applies to it and on whoever it is for. For a deed, check that first.';

/** The same, shorter, for the certificate of completion. */
export const WITNESS_CERT_NOTE = 'Sign&Grow recorded what the witness stated. It cannot check that they were physically present.';

/** The witness's own statement, ticked on their first screen and printed on the certificate exactly as ticked. */
export const statementText = (signer: string, date: string): string => `I was physically present and saw ${signer} sign this document on ${date}.`;

/** The words for the marks a challenge would look at, as the certificate and the sender's page print them. */
// "device": the same browser on the same device finished both. "network": the same internet address and the same kind of
// browser, which can also be two devices in one place, so it is said as exactly that.
export const MARK_WORDS: Record<string, string> = { address: 'same email address as the signer', device: 'same device as the signer', network: 'same internet address and browser as the signer' };
export const marksOf = (stored: any): string[] => String(stored || '').split(',').filter((m) => m in MARK_WORDS);

/** The block the sender places for a witness, near the signature of the person they witness. Sizes are shares of the page. */
export const WITNESS_BLOCK: { type: string; label: string; w: number; h: number; required: boolean }[] = [
  { type: 'signature', label: 'Witness signature', w: 0.22, h: 0.05, required: true },
  { type: 'full_name', label: 'Witness name', w: 0.3, h: 0.024, required: true },
  { type: 'text', label: 'Witness address', w: 0.4, h: 0.045, required: true },
  { type: 'text', label: 'Witness occupation', w: 0.3, h: 0.024, required: true },
  { type: 'date_signed', label: 'Date witnessed', w: 0.16, h: 0.024, required: true },
];

const norm = (s: any) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const nameOf = (r: any) => String(r?.name || r?.role_name || '').trim();

/**
 * Why this witness cannot go out like this, or null. One rule for the editor (before Send) and the server (when an
 * envelope is sent or changed). `e` needs its recipients and fields. Ids are compared as they are in `e`.
 */
export function witnessProblem(r: any, e: { recipients?: any[]; fields?: any[]; kind?: string } | null | undefined): string | null {
  if (!isWitness(r)) return null;
  const people = e?.recipients || [];
  const name = nameOf(r) && !waitsForName(r) ? nameOf(r) : 'A witness';
  const target = people.find((x) => x.id === r.witness_for);
  if (!r.witness_for) return `${name} is a witness, and a witness is there for one person who signs. Choose whose signature they witness.`;
  if (!target) return `${name} is the witness for someone who is no longer on this document. Choose one of the people who sign, or remove the witness.`;
  const whose = nameOf(target) || 'the person they witness';
  if (r.group_id || r.group_name) return `A witness is one named person, and ${name} is a group. Name the person who will watch ${whose} sign.`;
  if (target.group_id || target.group_name) return `${whose} is a group, so nobody knows in advance who will sign for it, and a witness watches one person sign. Remove the witness, or put the person who signs on the document by name.`;
  if (!WITNESSED_ROLES.includes(target.role)) return `${name} is the witness for ${whose}, who does not sign this document. A witness can only be there for someone who signs.`;
  const second = people.find((x) => x.id !== r.id && isWitness(x) && x.witness_for === r.witness_for);
  if (second) return `${whose} has two witnesses here. A person who signs has one witness on Sign&Grow. Remove one of them.`;
  if (r.link_by_sender) return `${name} is a witness, and a witness gets their own email straight after ${whose} signs. Untick "I will send the link myself" for them.`;
  if (r.named_by_signer && r.verify === 'sms_code') return `${whose} names the witness, so there is no mobile number for them to check a code with. Choose a code by email or no extra check for the witness.`;
  if (!waitsForName(r) && norm(r.email) === norm(target.email) && norm(r.name) === norm(target.name)) return `${name} would be the witness of their own signature. A witness has to be somebody else.`;
  if (!(e?.fields || []).some((f) => f.recipient_id === r.id && f.type === 'signature')) return `${name} is a witness and has no signature field yet. Place the witness block for them near the signature of ${whose}.`;
  return null;
}
