// "Only when...": a person on a document is asked only when an answer of someone earlier in the signing order is the
// one the sender chose ("Only when Amount is more than 1000"), or only when another person in the same step is not
// asked ("Instead of Manager A"). Plain data in, plain data out, no React and no server: the editor says the rule
// back with these words, and the server decides with the same functions from what is stored when the person's step
// is reached (src/server/routing.ts). The conditions are the ones a field's "Only show when" has (src/lib/logic.ts).
import { CONDS_FOR, NEEDS_VALUE, workOut, ruleOf, type Cond } from './logic.ts';

/** A rule on an answer of someone earlier in the order. */
export type AnswerRule = { field: string; is: Cond; value?: string };
/** Asked only when the person `otherwise` (same step, with an answer rule) is not asked. */
export type InsteadRule = { otherwise: string };
export type OnlyWhen = AnswerRule | InsteadRule;

export const isInstead = (w: OnlyWhen | null | undefined): w is InsteadRule => !!w && typeof (w as any).otherwise === 'string';

/** The rule of a person as an object, whether it came from the database (JSON text), the editor or an API caller. */
export function onlyWhenOf(r: { only_when?: any } | null | undefined): OnlyWhen | null {
  let w: any = r?.only_when;
  if (typeof w === 'string') {
    try {
      w = JSON.parse(w);
    } catch {
      return null;
    }
  }
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  if (w.otherwise != null && w.otherwise !== '') return { otherwise: String(w.otherwise) };
  if (w.field == null || w.field === '') return null;
  const v = w.value != null ? String(w.value).trim() : '';
  return { field: String(w.field), is: w.is, ...(v ? { value: v } : {}) };
}

/** The same rule as a string, to tell whether a save changes it. */
export const onlyWhenKey = (r: any): string => {
  const w = onlyWhenOf(r);
  return !w ? '' : isInstead(w) ? `o:${w.otherwise}` : JSON.stringify([w.field, w.is, w.value ?? '']);
};

/** Fields a rule can read: the kinds "Only show when" can ask about. */
export const TESTABLE = (f: any) => !!CONDS_FOR[f?.type];

type P = { id: string; role?: string | null; routing_order?: any; name?: string | null; role_name?: string | null };

/**
 * The fields a rule of `r` may read: fields of people earlier in the signing order, of a kind that can be asked
 * about. A witness signs when their signer has signed, whatever the order, so their fields are not read.
 * Without a signing order nobody is earlier, so there are none.
 */
export function fieldsBefore(r: P, people: P[], fields: any[], ordered: boolean): any[] {
  if (!ordered) return [];
  const at = Number(r.routing_order);
  const earlier = new Set(people.filter((p) => p.id !== r.id && p.role !== 'witness' && Number(p.routing_order) < at).map((p) => p.id));
  return fields.filter((f) => f.recipient_id && earlier.has(f.recipient_id) && TESTABLE(f));
}

/** People in the same step as `r` whose rule is an answer rule: `r` can be asked instead of one of them. */
export function insteadOf(r: P, people: any[]): any[] {
  return people.filter((p) => p.id !== r.id && p.role !== 'witness' && Number(p.routing_order) === Number(r.routing_order) && (() => {
    const w = onlyWhenOf(p);
    return !!w && !isInstead(w);
  })());
}

/**
 * Someone whose answer `r` could depend on, but who does not sign before `r` (no signing order, or the same step or
 * later): the first such person in the order. The editor then lists "Only when..." anyway and offers to put `r`
 * after them, so the line is not hidden behind a switch the sender never thought of. Null when there is nothing.
 */
export function answerAfter(r: P, people: P[], fields: any[], ordered: boolean): P | null {
  if (r.role === 'witness' || fieldsBefore(r, people, fields, ordered).length) return null;
  const owners = new Set(fields.filter((f) => f.recipient_id && f.recipient_id !== r.id && TESTABLE(f)).map((f) => f.recipient_id));
  const them = people.filter((p) => p.id !== r.id && p.role !== 'witness' && p.role !== 'cc' && owners.has(p.id));
  return them.sort((a, b) => Number(a.routing_order) - Number(b.routing_order))[0] || null;
}

/** Whether a rule can be set for `r` at all: there is something to read, or someone to stand in for. */
export const canHaveRule = (r: P, people: any[], fields: any[], ordered: boolean): boolean =>
  r.role !== 'witness' && (fieldsBefore(r, people, fields, ordered).length > 0 || insteadOf(r, people).length > 0);

const quoted = (type: string, v: string) => (type === 'number' ? v : `"${v}"`);

/** The condition alone, as in "(rule: more than 1000)". */
export function condWords(is: Cond, type: string, value?: string | null): string {
  const v = String(value ?? '');
  const pick = type === 'radio' ? 'chosen' : 'ticked';
  switch (is) {
    case 'checked': return pick;
    case 'unchecked': return `not ${pick}`;
    case 'filled': return 'filled in';
    case 'empty': return 'left empty';
    case 'equals': return quoted(type, v);
    case 'not_equals': return `anything but ${quoted(type, v)}`;
    case 'more_than': return `more than ${v}`;
    case 'less_than': return `less than ${v}`;
    default: return 'a certain answer';
  }
}

/** The whole rule as the editor and the review step say it: "Only when Amount is more than 1000". */
export function onlyWhenWords(w: OnlyWhen | null, o: { field?: any; fieldName?: string; insteadName?: string }): string {
  if (!w) return '';
  if (isInstead(w)) return `Only when ${o.insteadName || 'the other person'} is not asked`;
  return `Only when ${o.fieldName || 'an earlier answer'} is ${condWords(w.is, o.field?.type || 'text', w.value)}`;
}

/** What an answer was, for the record: "800", "not ticked", "empty". `hidden` is a field its own rule kept off the page. */
export function wasWords(f: any, text: string, hidden: boolean): string {
  if (hidden) return 'not shown, so empty';
  if (f?.type === 'checkbox' || f?.type === 'radio') return text === '1' ? (f.type === 'radio' ? 'chosen' : 'ticked') : f.type === 'radio' ? 'not chosen' : 'not ticked';
  const t = String(text ?? '').trim();
  if (!t) return 'empty';
  return f?.type === 'number' ? t : `"${t.length > 80 ? `${t.slice(0, 80)}...` : t}"`;
}

/**
 * Whether an answer rule is met, from the fields as they are stored: the field's stored value, a calculated field's
 * stored result, and a field that its own "Only show when" keeps off the page counts as empty. A field that is not
 * there any more counts as empty too. `was` says what the answer was, in words.
 */
export function decide(w: AnswerRule, fields: any[]): { met: boolean; was: string; field: any | null } {
  const all = fields.map((f) => ({ ...f, show_when: ruleOf(f) }));
  const out = workOut(all, { stored: () => true });
  const p = all.find((f) => f.id === w.field) || null;
  const hidden = !p || out.hidden.has(p.id);
  const text = !p || hidden ? '' : p.value == null ? '' : String(p.value);
  // The answer alone, always shown, and a stand-in that depends on it with the same rule.
  const plain = { id: 'answer', type: p?.type || 'text', recipient_id: 'x', value: text, calc_num: hidden ? null : p?.calc_num ?? null, options: p?.options };
  const probe = { id: 'probe', type: 'text', recipient_id: 'x', show_when: { field: 'answer', is: w.is, ...(NEEDS_VALUE.includes(w.is) ? { value: w.value ?? '' } : {}) } };
  const met = !workOut([plain, probe] as any).hidden.has('probe');
  return { met, was: wasWords(p, text, !!p && hidden), field: p };
}

/** The line in the record and on the signing record: "Ben, because Amount was 800 (rule: more than 1000)." */
export function notAskedWhy(name: string, fieldName: string, was: string, w: AnswerRule, type: string): string {
  return `${name}, because ${fieldName} was ${was} (rule: ${condWords(w.is, type, w.value)}).`;
}

/**
 * The same for an answer the sender hid from the others: what it was, and the rule's value, stay out of the record
 * and the certificate, which everyone gets. `met`: the words for someone who is asked.
 */
export function hiddenWhy(name: string, fieldName: string, met: boolean): string {
  return met ? `${name} is asked, because ${fieldName}, an answer hidden from the others, meets the rule.` : `${name}, because ${fieldName}, an answer hidden from the others, did not meet the rule.`;
}

/**
 * The status of a person on the signing record and the full record: "Not asked: Ben, because Amount was 800 (rule:
 * more than 1000)." Someone who had been asked before a correction and is not needed now is never called "Not
 * asked": "No longer needed: ..., after they had been asked."
 */
export const notAskedStatus = (r: any): string => {
  const why = r?.skipped_why || `${r?.name || 'this person'}, because the rule for them was not met.`;
  return r?.skipped_was_asked ? `No longer needed: ${why} They had been asked before the document was changed, and did not sign or approve it.` : `Not asked: ${why}`;
};

/**
 * The rule of `r` when it can still work with the people and fields as they are now in the editor, else null: the
 * field it reads is still there and belongs to someone earlier, or the person it stands in for is in the same step
 * with an answer rule. The editor saves only a rule that works, and says so under the person when one stopped working.
 */
export function usableRule(r: any, people: any[], fields: any[], ordered: boolean): OnlyWhen | null {
  const w = onlyWhenOf(r);
  if (!w || r.role === 'witness') return null;
  if (isInstead(w)) {
    const t = people.find((p) => p.id === w.otherwise);
    const tw = t ? onlyWhenOf(t) : null;
    return t && tw && !isInstead(tw) && Number(t.routing_order) === Number(r.routing_order) && usableRule(t, people, fields, ordered) ? w : null;
  }
  const f = fieldsBefore(r, people, fields, ordered).find((x) => x.id === w.field);
  return f && (CONDS_FOR[f.type] || []).includes(w.is) && (!NEEDS_VALUE.includes(w.is) || String(w.value ?? '').trim() !== '') ? w : null;
}
