// Files given to read with a document, not signed: a privacy notice, terms, a leaflet. Shared by the editor, the
// signing page and the server (src/server/supplements.ts), so all three say the same thing.
//
// Honest words: "opened" means the file was opened on that person's screen or downloaded by their link. We never
// say it was read or understood, because nothing can tell us that.

/** The rule before Finish. none: just there to read; open: Finish waits until it was opened; acknowledge: a tick. */
export const SUPPLEMENT_RULES = ['none', 'open', 'acknowledge'] as const;
export type SupplementRule = (typeof SUPPLEMENT_RULES)[number];

export const isSupplementRule = (v: unknown): v is SupplementRule => typeof v === 'string' && (SUPPLEMENT_RULES as readonly string[]).includes(v);

/** The words of each rule in the editor (research/ux-notes.json, ds-supplements: the same words as the role). */
export const RULE_LABEL: Record<SupplementRule, string> = {
  none: 'Nothing, it is there to read',
  open: 'Must open it',
  acknowledge: "Must tick 'I have been given it'",
};

/** The editor's switch on a file's More. */
export const TO_READ = 'To read, not sign';

/** The tick a signer is asked for when the rule is acknowledge. */
export const givenLine = (name: string) => `I have been given ${name}`;

/** The divider page in front of the files given to read, in the completed copy. */
export const DIVIDER_TITLE = 'Given with this document, not signed';
export const DIVIDER_LINE = 'The files after this page were given to the people who signed. They were not signed. Opened means the file was opened, not that it was read.';

/** The audit trail's lines. Never "read". */
export const OPENED_ACTION = (name: string) => `Opened ${name}`;
export const ACKNOWLEDGED_ACTION = (name: string) => `Acknowledged receiving ${name}`;

/** What the sender sees in the editor under a file that is to read. */
export const ruleSummary = (rule: SupplementRule, inCopy: boolean) =>
  `To read, not sign. ${rule === 'open' ? 'Each person must open it before they finish.' : rule === 'acknowledge' ? `Each person must tick that they have been given it before they finish.` : 'Nobody has to open it.'}${inCopy ? '' : ' Not in the signed copy.'}`;

/** One file as the API and the editor carry it: null for a file to sign. */
export type Supplemental = { rule: SupplementRule; in_copy: boolean } | null;

/** Who has to meet the rules: everyone who presses Finish, except a witness, who only witnesses a signature. */
export const meetsRules = (role: string) => role !== 'cc' && role !== 'witness';

/** The names in a list, for a sentence: "A", "A and B", "A, B and C". */
export const nameList = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);
