// A witness for one signer: a person who was physically there and saw that signer sign, for the documents that need
// one (a deed in England and Wales, for example). The rules and the words that both the pages and the server quote
// live here. Plain values and functions, so a page may import them. The server side is src/server/witness.ts.
//
// What the role means everywhere: a witness belongs to one person who signs (witness_for), is asked straight after
// that person has signed whatever the signing order says, never uses a signature, and fills in a block the sender
// places near that person's signature. The sender names the witness, or leaves it to the signer (named_by_signer),
// who then names them on the review screen before Finish. GrowSigning records what the witness states. It cannot check
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
  'A witness has to be an adult who is not a party to the document: they do not sign it as one of the people it binds, and it gives them nothing. They have to be physically with the person who signs, in the same room, and watch them sign. Someone on a video call is usually not enough. The rules differ by country and by kind of document, and some ask for more, so check what applies before anyone signs.';

/** What the product does and does not do, said wherever a witness is offered: editor, signing page, certificate, help. */
export const WITNESS_RECORDS =
  'GrowSigning records what the witness states, when they stated it, and from which internet address and browser. It cannot check that they were in the room. Whether a document witnessed this way is accepted depends on the law that applies to it and on whoever it is for. For a deed, check that first.';

/** The same, shorter, for the certificate of completion. */
export const WITNESS_CERT_NOTE = 'GrowSigning recorded what the witness stated. It cannot check that they were physically present.';

/** The witness's own statement, ticked on their first screen and printed on the certificate exactly as ticked. */
export const statementText = (signer: string, date: string): string => `I was physically present and saw ${signer} sign this document on ${date}.`;

/** The words for the marks a challenge would look at, as the certificate and the sender's page print them. */
// "device": the same browser on the same device finished both (a cookie, compared for one document only). Another
// browser or a private window on that device is not caught, so the words say browser. "network": the same internet
// address and the same kind of browser, which can also be two devices in one place, so it is said as exactly that.
// "name": the signer's own name (another spelling counts), at another address.
export const MARK_WORDS: Record<string, string> = { address: 'same email address as the signer', device: 'same device and browser as the signer', network: 'same internet address and browser as the signer', name: 'same name as the signer, or a spelling of it, at another address' };
export const marksOf = (stored: any): string[] => String(stored || '').split(',').filter((m) => m in MARK_WORDS);

/** Same device: the only thing a sender is shown of the comparison is yes or no, next to what it can and cannot show. */
export const sameDevice = (w: any): boolean | null => (w?.status === 'completed' ? marksOf(w.witness_marks).includes('device') : null);
export const SAME_DEVICE_LIMITS =
  'Yes means the witness finished in the browser the signer signed in. No means they did not: another browser or a private window on the same device, or a cleared cookie, would also say no. It cannot show where anyone was.';
/** The browser cookie behind it, as /security describes it. */
export const DEVICE_COOKIE_WORDS =
  'When someone signs a document that has a witness, their browser gets a cookie with a random value. When the witness finishes, we compare it with the witness\'s browser for that one document, and the sender sees only "same device: yes" or "no". We keep a keyed fingerprint made for that document alone, never the cookie itself, so it cannot link one browser across documents or accounts, and nobody is shown it. It is used for nothing else and lasts up to 400 days.';

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
/** One name written two ways is one name: case, accents, dots and spaces make no difference ("Ánn  signer" is "Ann Signer"). */
export const sameName = (a: any, b: any): boolean => {
  const k = (s: any) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
  return !!k(a) && k(a) === k(b);
};
/** The roles that make someone a party to the document: they sign or approve it. */
export const PARTY_ROLES = ['signer', 'inperson', 'approver'];

/**
 * What a witness may fill in: their block and nothing more. A witness uses no signature, so a "witness" given the
 * fields of a party (an amount to repay, initials on a clause, a tick to agree) would be a free signature for
 * somebody who is really a party. Counted per type, so the block can be placed again after it was moved.
 */
export const WITNESS_FIELDS: Record<string, number> = WITNESS_BLOCK.reduce((m: Record<string, number>, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {});
const FIELD_WORDS: Record<string, string> = { signature: 'signature', full_name: 'name', text: 'text', date_signed: 'date' };

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
  if (r.group_id || r.group_name) return `A witness is one named person, not a group. Name the person who will watch ${whose} sign.`;
  if (target.group_id || target.group_name) return `${whose} is a group, so nobody knows in advance who will sign for it, and a witness watches one person sign. Remove the witness, or put the person who signs on the document by name.`;
  if (!WITNESSED_ROLES.includes(target.role)) return `${name} is the witness for ${whose}, who does not sign this document. A witness can only be there for someone who signs.`;
  const second = people.find((x) => x.id !== r.id && isWitness(x) && x.witness_for === r.witness_for);
  if (second) return `${whose} has two witnesses here. A person who signs has one witness on GrowSigning. Remove one of them.`;
  if (r.link_by_sender) return `${name} is a witness, and a witness gets their own email straight after ${whose} signs. Untick "I will send the link myself" for them.`;
  if (r.named_by_signer && r.verify === 'sms_code') return `${whose} names the witness, so there is no mobile number for them to check a code with. Choose a code by email or no extra check for the witness.`;
  if (!waitsForName(r) && norm(r.email) === norm(target.email) && sameName(r.name, target.name)) return `${name} would be the witness of their own signature. A witness has to be somebody else.`;
  // Not a party: someone who signs or approves the same document, at the same address and under the same name.
  const party = waitsForName(r) ? null : people.find((x) => x.id !== r.id && x.id !== target.id && !isWitness(x) && PARTY_ROLES.includes(x.role) && norm(x.email) === norm(r.email) && sameName(x.name, r.name));
  if (party) return `${name} is the witness for ${whose} and also ${party.role === 'approver' ? 'approves' : 'signs'} this document, so they are a party to it, and a witness should not be. Name somebody else as the witness.`;
  const mine = (e?.fields || []).filter((f) => f.recipient_id === r.id);
  if (!mine.some((f) => f.type === 'signature')) return `${name} is a witness and has no signature field yet. Place the witness block for them near the signature of ${whose}.`;
  // Only the block: a witness never uses a signature, so fields of a party would make a free one.
  const extra = Object.entries(mine.reduce((m: Record<string, number>, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {})).find(([t, k]) => Number(k) > (WITNESS_FIELDS[t] || 0));
  if (extra) return `${name} is a witness, and a witness fills in only their witness block: one signature, their name, their address and occupation (two text fields) and the date. ${WITNESS_FIELDS[extra[0]] ? `They have ${extra[1]} ${FIELD_WORDS[extra[0]]} fields, and the block has ${WITNESS_FIELDS[extra[0]]}` : `They have ${/^[aeiou]/.test(extra[0]) ? 'an' : 'a'} ${extra[0].replace('_', ' ')} field`}. Remove it, or make them a signer if they agree to the document themselves.`;
  return null;
}
