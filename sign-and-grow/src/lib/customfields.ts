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

export const CUSTOM_KINDS = ['text', 'list'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];
export type CustomDef = { id: string; name: string; kind: CustomKind; choices: string[]; required: boolean; on_certificate: boolean };

/** The heading of the block on the certificate of completion. */
export const CERT_HEADING = 'Details given by the sender (their words)';
/** Said under it, once: what these lines are and what they are not. */
export const CERT_NOTE = 'The sender typed these for their own records. They were not on the signing page, and nobody checked them.';

/**
 * The same name or value whatever the letter case, the width of its characters and the spaces around it: "Case
 * number", "case  number" and "ＣＡＳＥ number" are one name. Letters of every script are kept as they are.
 */
export const customKey = (s: unknown): string => String(s ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

// Characters that change how text around them is shown (right-to-left overrides and isolates) or that cannot be seen
// at all: in a value they could make a certificate line read as something else. Joiners stay, because Persian and
// the scripts of South Asia need them.
const HIDDEN = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

/** What is wrong with a piece of text that has to be one plain line, or null. `what` starts the sentence. */
export function lineProblem(v: string, max: number, what: string): string | null {
  if (/[\r\n\u2028\u2029]/.test(v)) return `${what} has to be one line. Take out the line break.`;
  if (HIDDEN.test(v)) return `${what} holds a character that cannot be seen or that turns text around. Type it again without it.`;
  if ([...v].length > max) return `${what} is ${[...v].length} characters long, and the most is ${max}. Shorten it.`;
  return null;
}

/** What is wrong with the name of a field, or null. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return 'Give the field a name, for example Case number.';
  return lineProblem(name, CUSTOM_NAME_MAX, 'The name');
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
