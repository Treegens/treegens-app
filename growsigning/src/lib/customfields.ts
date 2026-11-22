// Custom fields: an account's own references on every envelope (a case number, a cost centre, a grant, a ward). The
// rules and limits the server enforces (src/server/customfields.ts) and the screens show, in one place, so the two
// cannot disagree. No environment and no database in here: a page may import it.

/** How many custom fields one account can define. */
export const MAX_CUSTOM_FIELDS = 20;
/** The longest name of a field, in characters. */
export const CUSTOM_NAME_MAX = 50;
/** The longest value, in characters. */
export const CUSTOM_VALUE_MAX = 100;
/** How many choices a list can offer. */
export const CUSTOM_CHOICES_MAX = 50;
/** How many name and value pairs one document can carry (documents[].fields, API only). */
export const DOC_FIELDS_MAX = 20;
/** The longest list of names and values one request may carry: every detail, and room for names only old envelopes have. */
export const PAIRS_MAX = 100;
/** The "code" of the refusal when a required detail has no value at send; its "missing" lists the names. */
export const DETAILS_MISSING = 'details_missing';

export const CUSTOM_KINDS = ['text', 'list'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];
export type CustomDef = { id: string; name: string; kind: CustomKind; choices: string[]; required: boolean; on_certificate: boolean };

/** The heading of the block on the certificate of completion. */
export const CERT_HEADING = 'Details given by the sender (their words)';
/** Said under it, once: what these lines are and what they are not. */
export const CERT_NOTE = 'The sender typed these for their own records. They were not on the signing page, and nobody checked them.';

// Characters nobody can see. Format characters (zero-width space, word joiner, soft hyphen, tags, text-turning
// overrides and isolates), blank letters (Hangul fillers, the empty braille cell) and variation selectors. The few
// format characters that are drawn as a sign of their own (Arabic and Syriac number signs) are not in here.
const UNSEEN = /[\p{Cc}\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;
// The ones that are needed where they stand: a joiner or non-joiner between two letters (Persian and the scripts of
// South Asia write with them), a joiner between two pictures, and a variation selector right after a picture or a
// letter of a script that uses them (Mongolian).
const NEEDED = /(?<=[\p{L}\p{M}])[\u200c\u200d](?=[\p{L}\p{M}])|(?<=[\p{Extended_Pictographic}\ufe0f])\u200d(?=\p{Extended_Pictographic})|(?<=\p{Extended_Pictographic})\ufe0f|(?<=\p{Script=Mongolian})[\u180b-\u180d\u180f]/gu;
const PLACE = '\ue000';
/** True when the text holds a character that cannot be seen and is not needed where it stands. */
export const hasUnseen = (s: string): boolean => (UNSEEN.lastIndex = 0, UNSEEN.test(s.replace(NEEDED, PLACE)));
/** The text without any character that cannot be seen, needed or not: what two look-alike texts have in common. */
const seen = (s: string): string => s.replace(UNSEEN, '');
/** True when nothing of the text can be seen: only spaces, unseen characters, or marks with no letter under them. */
export const isBlank = (s: string): boolean => !seen(s).replace(/[\p{Z}\p{M}\s]/gu, '');

/**
 * The same name or value whatever the letter case, the width of its characters, the spaces around it and any
 * character in it that cannot be seen: "Case number", "case  number", "ＣＡＳＥ number" and "Case number" with a
 * zero-width space are one name. Letters of every script are kept as they are.
 */
export const customKey = (s: unknown): string => seen(String(s ?? '').normalize('NFKC')).trim().replace(/\s+/gu, ' ').toLowerCase();

/** What is wrong with a piece of text that has to be one plain line, or null. `what` starts the sentence. */
export function lineProblem(v: string, max: number, what: string): string | null {
  if (/[\r\n\u2028\u2029]/.test(v)) return `${what} has to be one line. Take out the line break.`;
  if (hasUnseen(v)) return `${what} holds a character that cannot be seen or that turns text around. Type it again without it.`;
  if ([...v].length > max) return `${what} is ${[...v].length} characters long, and the most is ${max}. Shorten it.`;
  return null;
}

/** What is wrong with the name of a detail, or null. */
export function nameProblem(name: string): string | null {
  const wrong = lineProblem(name, CUSTOM_NAME_MAX, 'The name');
  if (wrong) return wrong;
  if (isBlank(name)) return 'Give the detail a name, for example Case number.';
  return null;
}

/**
 * Checks one value against its field. Answers the value as it is kept (a choice in the spelling of the list, the
 * spaces around it gone), or a problem in words. An empty value is no value: `required` is checked when sending.
 */
export function readValue(def: Pick<CustomDef, 'name' | 'kind' | 'choices'>, raw: unknown): { value: string } | { problem: string } {
  if (raw != null && typeof raw === 'object') return { problem: `"${def.name}" was sent as ${Array.isArray(raw) ? 'a list' : 'an object'}, and it has to be text.` };
  if (typeof raw === 'boolean') return { problem: `"${def.name}" was sent as ${raw}, and it has to be text.` };
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return { value: '' };
  const wrong = lineProblem(v, CUSTOM_VALUE_MAX, `"${def.name}"`);
  if (wrong) return { problem: wrong };
  // Nothing in it that anyone could read (a mark with no letter under it, say): that is no value.
  if (isBlank(v)) return { value: '' };
  if (def.kind === 'list') {
    const hit = def.choices.find((c) => customKey(c) === customKey(v));
    if (!hit) return { problem: `"${v}" is not one of the choices for "${def.name}". Pick one of: ${def.choices.join(', ')}.` };
    return { value: hit };
  }
  return { value: v };
}

/** How a field is described in one short line on a screen: "A list of 4 choices, required, on the certificate". */
export function defSummary(d: Pick<CustomDef, 'kind' | 'choices' | 'required' | 'on_certificate'>): string {
  const kind = d.kind === 'list' ? `A list of ${d.choices.length} choice${d.choices.length === 1 ? '' : 's'}` : 'Text';
  return `${kind}, ${d.required ? 'required when sending' : 'optional'}, ${d.on_certificate ? 'printed on the certificate' : 'not on the certificate'}`;
}
