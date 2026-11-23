// Field checks: the format a text field takes, its character limit, the range and currency of a number field, what
// is hidden from the other people on a document, a box of fixed size, and rules for a group of tick boxes. One set
// of rules, used by the editor, the signing page while someone types, and the server when they save and finish, so
// the three can never disagree. Plain functions with no environment in them: safe for pages.
//
// What a sender sets is kept in the field's "validation". The old form, a word ("email", "number", "phone") or a
// pattern of the sender's own, keeps working. The new form is an object (see Checks). Nothing here checks a value
// against an outside database: "checked the format" is all it ever means.
import { NUMBER_RULE, NUMBER_PROBLEM } from './numbers.ts';
import { readNumber } from './logic.ts';
import { DEFAULT_DATE_FORMAT, DATE_FORMATS, formatDateValue } from './dates.ts';

export const KINDS = ['email', 'number', 'phone', 'letters', 'date', 'pattern'] as const;
export type Kind = (typeof KINDS)[number];
export const GROUP_RULES = ['at_least', 'at_most', 'exactly'] as const;
export type GroupRule = (typeof GROUP_RULES)[number];

export type Checks = {
  /** The format a text field takes. None: any text. */
  kind?: Kind;
  /** For "pattern": the sender's own pattern, checked by safePattern before it is saved. */
  pattern?: string;
  /** What a person is told when the format is not met (needed for "pattern"), or when a tick-box group rule is not. */
  message?: string;
  /** A text field: the most characters it takes, 1 to 4,000. */
  max_length?: number;
  /** A number field: the smallest and largest number it takes, the most decimal places, and its currency (ISO code). */
  min?: number;
  max?: number;
  decimals?: number;
  currency?: string;
  /** A text field: dots for every other person while the document is out. */
  hide?: boolean;
  /** With hide: the completed copy prints "(hidden by the sender)" instead of the value. */
  hide_in_copy?: boolean;
  /** A text field: the text does not grow past its box. fit_chars is worked out by the server from the box. */
  fixed?: boolean;
  fit_chars?: number;
  /** A tick box: the rule for every tick box with the same group name. */
  group_rule?: GroupRule;
  group_count?: number;
};

export const MAX_LENGTH = 4000;
/** What a field with a pattern of the sender's own takes at most, which with the reader's rules keeps every check short. */
export const PATTERN_VALUE_MAX = 100;
/** The most open-ended repeats (+, *, {2,}) and the most repeats of any kind (also ?) a pattern may have. */
export const MANY_REPEATS = 3;
export const ANY_REPEATS = 8;
export const PATTERN_MAX = 200;
export const MESSAGE_MAX = 200;
export const MAX_DECIMALS = 10;
export const GROUP_MAX = 100;
/** The smallest size text in a box of fixed size shrinks to, in points. */
export const FIXED_MIN_PT = 7;
/** The words printed instead of a value the sender hid in the completed copy too. */
export const HIDDEN_IN_COPY = '(hidden by the sender)';
/** What everyone else sees instead of a hidden value while the document is out. */
export const DOTS = '••••••••';
/** Said beside the option, exactly: it is a screen mask, not encryption. */
export const HIDE_SAYS = 'Others see dots while it is out. You still see it. This is not encryption.';
export const HIDE_COPY_SAYS = 'The completed copy prints "(hidden by the sender)" instead, and its certificate says so.';

const LEGACY: Record<string, Kind> = { email: 'email', number: 'number', phone: 'phone' };
const num = (v: any): number | undefined => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
const int = (v: any): number | undefined => (num(v) == null ? undefined : Math.trunc(Number(v)));

/** The checks a field holds, whatever form they were saved in. Never throws: what cannot be read is no check at all. */
export function checksOf(v: any): Checks {
  if (v == null || v === '') return {};
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {};
    if (LEGACY[s]) return { kind: LEGACY[s] };
    if (s.startsWith('{')) {
      try {
        return checksOf(JSON.parse(s));
      } catch {
        return {};
      }
    }
    return { kind: 'pattern', pattern: s };
  }
  if (typeof v !== 'object' || Array.isArray(v)) return {};
  const c: Checks = {};
  if (KINDS.includes(v.kind)) c.kind = v.kind;
  if (typeof v.pattern === 'string' && v.pattern) c.pattern = v.pattern;
  if (typeof v.message === 'string' && v.message.trim()) c.message = v.message.trim();
  for (const k of ['max_length', 'decimals', 'group_count', 'fit_chars'] as const) if (int(v[k]) != null) c[k] = int(v[k]);
  for (const k of ['min', 'max'] as const) if (num(v[k]) != null) c[k] = num(v[k]);
  if (typeof v.currency === 'string' && v.currency.trim()) c.currency = v.currency.trim().toUpperCase();
  for (const k of ['hide', 'hide_in_copy', 'fixed'] as const) if (v[k] === true) c[k] = true;
  if (GROUP_RULES.includes(v.group_rule)) c.group_rule = v.group_rule;
  return c;
}

/** Whether a field has any check at all. */
export const hasChecks = (c: Checks) => Object.keys(c).length > 0;

/** The checks a field holds, from what the server gave (`checks`) or the saved form (`validation`). */
export const fieldChecks = (f: any): Checks => checksOf(f?.checks ?? f?.validation);

// ---- Patterns of the sender's own ------------------------------------------------------------------------------

/**
 * Why a pattern of the sender's own cannot be used, or '' when it can. Our own small reader, not the browser's: at
 * most 200 characters, it must read as a pattern, and it refuses what can make a pattern take minutes over a short
 * text: back-references (\1, \k<name>), a repeat inside a repeat such as (a+)+ or (a*){5}, a repeated choice whose
 * parts can start alike such as (a|a)* or (\w|\d)+ ((ab|cd)+ is fine: each part starts with its own letter), and
 * more than MANY_REPEATS open-ended repeats or more than ANY_REPEATS repeats of any kind. A value it is tested on is
 * at most PATTERN_VALUE_MAX characters. Together these keep a check to moments; the server also stops any check
 * that runs long (matchesPattern).
 */
export function patternProblem(src: any): string {
  const p = String(src ?? '');
  if (!p.trim()) return 'Write the pattern, or choose another format.';
  if (p.length > PATTERN_MAX) return `A pattern can be at most ${PATTERN_MAX} characters, and this one has ${p.length}. Make it shorter.`;
  try {
    new RegExp(`^(?:${p})$`);
  } catch {
    return 'This pattern cannot be read. Check its brackets and backslashes.';
  }
  // Each open group remembers whether something inside it repeats, whether it holds a choice (|), and the first
  // character of each part of the choice ('' for a part that does not start with a plain character).
  type G = { repeats: boolean; choice: boolean; risky: boolean; firsts: string[]; open: boolean };
  const group = (): G => ({ repeats: false, choice: false, risky: false, firsts: [], open: true });
  const stack: G[] = [group()];
  let last: 'atom' | 'group' | null = null;
  let lastGroup: G | null = null;
  let many = 0;
  let any = 0;
  // The first thing of a part of a choice: a plain character, or '' for anything else.
  const first = (t: string) => {
    const g = stack[stack.length - 1];
    if (g.open) g.firsts.push(t);
    g.open = false;
  };
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') {
      const n = p[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return 'A pattern cannot refer back to an earlier part of itself (like \\1). Write that part out again instead.';
      i++;
      if ((n === 'u' || n === 'x' || n === 'p' || n === 'P') && p[i + 1] === '{') i = Math.max(i, p.indexOf('}', i));
      first('');
      last = 'atom';
      continue;
    }
    if (ch === '[') {
      // A set of characters is one thing, whatever is in it.
      let j = i + 1;
      if (p[j] === '^') j++;
      if (p[j] === ']') j++;
      for (; j < p.length && p[j] !== ']'; j++) if (p[j] === '\\') j++;
      i = j;
      first('');
      last = 'atom';
      continue;
    }
    if (ch === '(') {
      first('');
      stack.push(group());
      if (p[i + 1] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i++;
        if (p[i + 1] === '<' && p[i + 2] !== '=' && p[i + 2] !== '!') i = p.indexOf('>', i);
        else i++;
      }
      last = null;
      continue;
    }
    if (ch === ')') {
      const g = stack.pop()!;
      if (!stack.length) return 'This pattern cannot be read. Check its brackets.';
      if (g.open) g.firsts.push(''); // an empty part, like (a|)
      // A choice is risky to repeat when two parts could start with the same character.
      if (g.choice && (g.firsts.includes('') || new Set(g.firsts).size < g.firsts.length)) g.risky = true;
      lastGroup = g;
      const parent = stack[stack.length - 1];
      if (g.repeats) parent.repeats = true;
      if (g.risky) parent.risky = true;
      last = 'group';
      continue;
    }
    const brace = ch === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i)) : null;
    if (ch === '*' || ch === '+' || ch === '?' || brace) {
      if (!last) continue; // a ? after ( or a lazy ? after a repeat
      if (brace && (Number(brace[1]) > 1000 || Number(brace[3] || 0) > 1000)) return 'A pattern can repeat something at most 1,000 times.';
      const lo = brace ? Number(brace[1]) : ch === '+' ? 1 : 0;
      const hi = brace ? (!brace[2] ? lo : brace[3] === '' ? Infinity : Number(brace[3])) : ch === '?' ? 1 : Infinity;
      const once = hi <= 1;
      if (last === 'group' && lastGroup?.repeats && !once) return 'A pattern cannot repeat something that already repeats, like (a+)+. Such a pattern can take minutes to check. Repeat only the inner part, like a+.';
      if (last === 'group' && lastGroup?.risky && hi > 1) return 'A pattern cannot repeat a choice whose parts can start the same way, like (a|a)+ or (\\w|\\d)+. Such a pattern can take minutes to check. Use a set of characters instead, like [\\w\\d]+.';
      if (hi > lo) {
        any++;
        if (hi - lo > 3) many++;
      }
      if (many > MANY_REPEATS) return `A pattern can have at most ${MANY_REPEATS} open-ended repeats (like + or *). Make it simpler.`;
      if (any > ANY_REPEATS) return `A pattern can have at most ${ANY_REPEATS} repeats or optional parts. Make it simpler.`;
      stack[stack.length - 1].repeats = true;
      if (brace) i += brace[0].length - 1;
      if (p[i + 1] === '?') i++;
      last = null;
      continue;
    }
    if (ch === '|') {
      const g = stack[stack.length - 1];
      if (g.open) g.firsts.push('');
      g.choice = true;
      g.open = true;
      last = null;
      continue;
    }
    first(ch === '.' || ch === '^' || ch === '$' ? '' : ch);
    last = 'atom';
  }
  return '';
}

/**
 * Whether `value` matches pattern `p` in full. A pattern the reader refuses is never run (it counts as a match: the
 * signer is not held to a rule that cannot be checked safely). The server swaps in a tester that also stops a check
 * that runs long (usePatternTester in src/server/fieldchecks.ts).
 */
let tester = (p: string, value: string) => new RegExp(`^(?:${p})$`).test(value);
export function usePatternTester(t: (p: string, value: string) => boolean) {
  tester = t;
}
export function matchesPattern(p: string, value: string): boolean {
  if (patternProblem(p)) return true;
  try {
    return tester(p, value);
  } catch {
    return true;
  }
}

// ---- Dates in the envelope's format ------------------------------------------------------------------------------

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const realDay = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m, d));
  return y >= 1000 && t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d;
};
/** Whether `value` is a real day written in `format` (one of DATE_FORMATS), like 20/03/2027 for DD/MM/YYYY. */
export function isDateIn(value: any, format?: string | null): boolean {
  const s = String(value ?? '').trim();
  const f = DATE_FORMATS.includes(format as any) ? format : DEFAULT_DATE_FORMAT;
  let m: RegExpExecArray | null;
  const month = (w: string) => MON.indexOf(w.slice(0, 3).toLowerCase());
  switch (f) {
    case 'DD/MM/YYYY': return !!(m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)) && realDay(+m[3], +m[2] - 1, +m[1]);
    case 'MM/DD/YYYY': return !!(m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)) && realDay(+m[3], +m[1] - 1, +m[2]);
    case 'D MMM YYYY': return !!(m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(s)) && month(m[2]) >= 0 && realDay(+m[3], month(m[2]), +m[1]);
    case 'MMM D, YYYY': return !!(m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s)) && month(m[1]) >= 0 && realDay(+m[3], month(m[1]), +m[2]);
    default: return !!(m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)) && realDay(+m[1], +m[2] - 1, +m[3]);
  }
}
/** An example date in the format, for the words that say how to type one. */
export const dateExample = (format?: string | null) => formatDateValue('2027-03-20', DATE_FORMATS.includes(format as any) ? format : DEFAULT_DATE_FORMAT);

// ---- Currencies ----------------------------------------------------------------------------------------------------

/** Whether `code` is a currency the browser and the server both know, like EUR or USD. */
export function isCurrency(code: any): boolean {
  const c = String(code ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return false;
  try {
    const all = (Intl as any).supportedValuesOf?.('currency') as string[] | undefined;
    if (all) return all.includes(c);
    new Intl.NumberFormat('en', { style: 'currency', currency: c });
    return true;
  } catch {
    return false;
  }
}
/** The sign of a currency, like € for EUR, or the code itself where it has no sign of its own. */
export function currencySign(code: any): string {
  const c = String(code ?? '').toUpperCase();
  if (!isCurrency(c)) return '';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).formatToParts(1).find((p) => p.type === 'currency')?.value || c;
  } catch {
    return c;
  }
}
/** `value` with letters (a currency's code or sign, like "KSh" or "EUR") taken off its start and end: "KSh 100" is "100". */
const withoutCurrency = (value: string) => value.trim().replace(/^[\p{L}\p{Sc}.]+\s*/u, '').replace(/\s*[\p{L}\p{Sc}.]+$/u, '');
/** A number field's value as it is printed: as typed, with the currency's sign in front when it was typed without one. */
export function printedAmount(value: string, c: Checks): string {
  if (!value || !c.currency || /\p{Sc}/u.test(value) || value.toUpperCase().includes(c.currency)) return value;
  const sign = currencySign(c.currency);
  return sign ? `${sign}${sign.length > 1 ? ' ' : ''}${value.trim()}` : value;
}

// ---- Boxes of fixed size ---------------------------------------------------------------------------------------------

/**
 * About how many characters fit in a box of fixed size at 7 points, from its size in points: the average character
 * of the font the signed copy uses is a little over half a point wide per point of size. A little is kept back for
 * wide letters and for words that move to the next line. At least 1.
 */
export function fitChars(wPt: number, hPt: number): number {
  const perLine = Math.max(1, Math.floor((wPt - 4) / (FIXED_MIN_PT * 0.56)));
  // The signed copy prints a box on one line unless it is taller than 2.6 lines of its natural size (pdf.ts).
  const multi = hPt > Math.max(6, Math.min(11, hPt * 0.62)) * 2.6;
  const lines = multi ? Math.max(1, Math.floor((hPt - 2) / (FIXED_MIN_PT * 1.3))) : 1;
  return Math.max(1, lines > 1 ? Math.floor(perLine * lines * 0.85) : perLine);
}
/** The most characters a field takes from the signer, or null for no limit of its own. */
export function limitOf(f: any): number | null {
  if (f?.type !== 'text') return null;
  const c = fieldChecks(f);
  const all = [c.max_length, c.fixed ? c.fit_chars : undefined, c.kind === 'pattern' ? PATTERN_VALUE_MAX : undefined].filter((n): n is number => typeof n === 'number' && n > 0);
  return all.length ? Math.min(...all) : null;
}

// ---- What a person typed --------------------------------------------------------------------------------------------

const RE: Partial<Record<Kind, RegExp>> = { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, phone: /^[+()\d][\d\s().-]{5,}$/, letters: /^[\p{L}\p{M}](?:[\p{L}\p{M}' ’.-]|\s)*$/u };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const fmt = (n: number) => n.toLocaleString('en', { maximumFractionDigits: MAX_DECIMALS });

/** A number field's value read as a number, or null. "1.234" on its own is read as one thousand two hundred and thirty-four. */
export const amountOf = (value: any): number | null => readNumber(value)?.value ?? null;

/**
 * What is wrong with `value` in field `f`, said with what to do, or '' when nothing is. `dateFormat` is the envelope's
 * date format, for a text field that takes a date. A field with no checks is only held to its own type's rule.
 */
export function valueProblem(f: any, value: any, dateFormat?: string | null): string {
  const v = String(value ?? '');
  if (!v) return '';
  const c = fieldChecks(f);
  const limit = limitOf(f);
  if (limit != null && [...v].length > limit) {
    return c.fixed && c.fit_chars === limit
      ? `This box is a fixed size and holds about ${plural(limit, 'character')}. This has ${[...v].length}. Make it shorter.`
      : `This field takes at most ${plural(limit, 'character')}, and this has ${[...v].length}. Make it shorter.`;
  }
  const kind: Kind | undefined = f?.type === 'number' ? 'number' : f?.type === 'text' ? c.kind : undefined;
  if (!kind) return '';
  if (kind === 'number') {
    // An amount typed with its currency's letters, like "KSh 100" or "12 EUR": the number alone is what is asked for.
    if (c.currency && !NUMBER_RULE.test(v) && /\p{L}/u.test(v) && NUMBER_RULE.test(withoutCurrency(v))) return `Type only the number, like 100. This amount is already in ${c.currency}.`;
    if (!NUMBER_RULE.test(v)) return NUMBER_PROBLEM;
    const n = readNumber(v);
    if (!n) return NUMBER_PROBLEM;
    if (c.currency) {
      const signs = v.match(/\p{Sc}/gu) || [];
      const sign = currencySign(c.currency);
      if (signs.some((s) => s !== sign && !sign.includes(s))) return `This amount is in ${c.currency}. Type it without another currency sign, like 1250.50.`;
    }
    if (c.decimals != null) {
      const at = n.dec === '.' ? Math.max(v.lastIndexOf('.'), v.lastIndexOf('٫')) : n.dec === ',' ? v.lastIndexOf(',') : -1;
      const places = at < 0 ? 0 : v.slice(at + 1).replace(/\P{Nd}/gu, '').length;
      if (places > c.decimals) return c.decimals === 0 ? 'Type a whole number, with no decimals.' : `Type at most ${plural(c.decimals, 'decimal place')}, like ${(1250.5).toFixed(c.decimals)}.`;
    }
    if ((c.min != null && n.value < c.min) || (c.max != null && n.value > c.max)) {
      // Only here is there a range to talk about: a field with only a currency or decimal places has none.
      const range = c.min != null && c.max != null ? `from ${fmt(c.min)} to ${fmt(c.max)}` : c.min != null ? `of ${fmt(c.min)} or more` : `of ${fmt(c.max as number)} or less`;
      return `Type a number ${range}.`;
    }
    return '';
  }
  if (kind === 'date') return isDateIn(v, dateFormat) ? '' : `Type a date like ${dateExample(dateFormat)}.`;
  if (kind === 'pattern') {
    if (!c.pattern || patternProblem(c.pattern)) return ''; // a pattern that was never safe to run is not run
    if (matchesPattern(c.pattern, v)) return '';
    return c.message || 'This is not in the format the sender asked for. Check it and try again.';
  }
  if (RE[kind]!.test(v.trim())) return '';
  if (c.message) return c.message;
  if (kind === 'email') return 'Enter an email address, like name@example.org.';
  if (kind === 'phone') return 'Enter a phone number with its area code.';
  return 'Use letters only. Spaces, hyphens and apostrophes are fine, digits and other signs are not.';
}

/** The words for a group rule: "Tick at least 2 of these boxes." */
export function groupRuleWords(rule: GroupRule, count: number): string {
  const boxes = plural(count, 'box', 'boxes');
  return rule === 'at_least' ? `Tick at least ${boxes} of these.` : rule === 'at_most' ? `Tick at most ${boxes} of these.` : `Tick exactly ${boxes} of these.`;
}

/** The rule of a group of tick boxes: the one the first box of that group carries. */
export function groupRuleOf(boxes: any[]): { rule: GroupRule; count: number; message: string } | null {
  for (const b of boxes) {
    const c = fieldChecks(b);
    if (c.group_rule && c.group_count != null) return { rule: c.group_rule, count: c.group_count, message: c.message || groupRuleWords(c.group_rule, c.group_count) };
  }
  return null;
}

/**
 * The first group of tick boxes among `fields` (one person's) whose rule is not met by `values`, with what to say,
 * or null. Boxes in `skip` (not shown, by "Only show when") do not count. A group nobody ticked in, and that is not
 * required, is not held to "at least".
 */
export function groupProblem(fields: any[], values: Record<string, any>, skip?: Set<string>): { field: any; name: string; text: string } | null {
  const groups = new Map<string, any[]>();
  for (const f of fields) if (f.type === 'checkbox' && f.group_name && !skip?.has(f.id)) groups.set(f.group_name, [...(groups.get(f.group_name) || []), f]);
  for (const [name, boxes] of groups) {
    const r = groupRuleOf(boxes);
    if (!r) continue;
    const ticked = boxes.filter((b) => values[b.id] === '1' || values[b.id] === true || values[b.id] === 'true').length;
    const required = boxes.some((b) => b.required);
    // Boxes that are not shown cannot be ticked, so a rule never asks for more boxes than there are to tick.
    const need = Math.min(r.count, boxes.length);
    const ok = r.rule === 'at_least' ? ticked >= need || (!ticked && !required) : r.rule === 'at_most' ? ticked <= r.count : ticked === need || (!ticked && !required);
    if (!ok) return { field: boxes[0], name, text: r.message };
  }
  return null;
}

// ---- Hidden values --------------------------------------------------------------------------------------------------

/** Whether the sender asked for what is typed in this field to be hidden from the others. */
export const isHidden = (f: any) => f?.type === 'text' && !!fieldChecks(f).hide;

/**
 * What someone other than the field's owner and the sender is shown of a hidden value: dots while the document is
 * out; once it is completed, what the completed copy prints. `value` for anything not hidden.
 */
export function shownToOthers(f: any, value: any, completed: boolean): any {
  if (!isHidden(f) || value == null || value === '') return value;
  if (!completed) return DOTS;
  return fieldChecks(f).hide_in_copy ? HIDDEN_IN_COPY : value;
}

/** How many values the completed copy leaves out by the sender's choice. */
export const hiddenInCopy = (fields: any[]) => fields.filter((f) => isHidden(f) && fieldChecks(f).hide_in_copy && f.value != null && f.value !== '').length;

// ---- Saving what the sender set ------------------------------------------------------------------------------------

/**
 * The checks of a field as the sender set them, made tidy, or the reason they cannot be saved (`problem`, said with
 * what to do). `pageSize` is the field's page in points, for a box of fixed size; `box` its share of the page.
 */
export function tidyChecks(type: string, raw: any, box?: { w: number; h: number }, pageSize?: { w: number; h: number } | null): { checks: Checks; problem: string } {
  const c = checksOf(raw);
  const out: Checks = {};
  const say = (problem: string) => ({ checks: out, problem });
  if (raw != null && typeof raw === 'object' && raw.kind != null && raw.kind !== '' && raw.kind !== 'none' && !KINDS.includes(raw.kind)) return say(`The format "${String(raw.kind).slice(0, 40)}" does not exist. Use one of: none, ${KINDS.join(', ')}.`);
  if (c.message && c.message.length > MESSAGE_MAX) return say(`The message can be at most ${MESSAGE_MAX} characters.`);
  if (type === 'text') {
    if (c.kind) out.kind = c.kind;
    if (c.kind === 'pattern') {
      const why = patternProblem(c.pattern);
      if (why) return say(why);
      out.pattern = c.pattern;
      // Legacy patterns came without words of their own and keep the general sentence. A new one needs its own.
      if (!c.message && typeof raw === 'object') return say('Write the message people see when what they type does not match, and say how to put it right, like "Type 5 digits, like 12345".');
    }
    if (c.message && c.kind) out.message = c.message;
    if (c.max_length != null) {
      if (c.max_length < 1 || c.max_length > MAX_LENGTH) return say(`The character limit is a whole number from 1 to ${MAX_LENGTH.toLocaleString('en')}.`);
      out.max_length = c.max_length;
    }
    if (c.hide) out.hide = true;
    if (c.hide && c.hide_in_copy) out.hide_in_copy = true;
    if (c.fixed) {
      out.fixed = true;
      if (box && pageSize) out.fit_chars = fitChars(box.w * pageSize.w, box.h * pageSize.h);
    }
  } else if (type === 'number') {
    if (c.min != null) out.min = c.min;
    if (c.max != null) out.max = c.max;
    if (c.min != null && c.max != null && c.min > c.max) return say(`The smallest number (${fmt(c.min)}) is larger than the largest (${fmt(c.max)}). Swap them.`);
    if (c.decimals != null) {
      if (c.decimals < 0 || c.decimals > MAX_DECIMALS) return say(`Decimal places is a whole number from 0 to ${MAX_DECIMALS}.`);
      out.decimals = c.decimals;
    }
    if (c.currency) {
      if (!isCurrency(c.currency)) return say(`"${c.currency.slice(0, 10)}" is not a currency code we know. Use the three letters of the currency, like EUR, USD or KES.`);
      out.currency = c.currency;
    }
  } else if (type === 'checkbox') {
    if (c.group_rule) {
      if (c.group_count == null || c.group_count < 0 || c.group_count > GROUP_MAX) return say(`The number of boxes for the group rule is a whole number from 0 to ${GROUP_MAX}.`);
      out.group_rule = c.group_rule;
      out.group_count = c.group_count;
      if (c.message) out.message = c.message;
    }
  }
  return { checks: out, problem: '' };
}

/**
 * Why the rule of a group of tick boxes can never be met, or ''. Every required box has to be ticked, so a rule of
 * "at most" or "exactly" fewer boxes than are required would leave the signer stuck for good.
 */
export function groupRuleProblem(boxes: any[]): string {
  const r = groupRuleOf(boxes);
  if (!r || r.rule === 'at_least') return '';
  const required = boxes.filter((b) => b.required).length;
  if (r.count >= required) return '';
  return `${plural(required, 'box', 'boxes')} of this group ${required === 1 ? 'is' : 'are'} required, so people have to tick ${required === 1 ? 'it' : 'them'}, but the rule says ${r.rule === 'exactly' ? 'exactly' : 'at most'} ${r.count.toLocaleString('en')}. Nobody could finish. Raise the number, or make fewer boxes required.`;
}

/** What the editor says under a group rule that asks for more boxes than the group has, or ''. It still works. */
export function groupRuleNote(rule: string, count: number | undefined, boxes: number): string {
  if (count == null || count <= boxes || rule === 'at_most') return '';
  return `The group has ${plural(boxes, 'box', 'boxes')}, so people will be asked to tick all ${boxes.toLocaleString('en')}.`;
}

/**
 * Why the checks of field `f` stop the document from being sent, or '' (said with what to do). `all` is every field,
 * for the rule of a tick-box group. The same reasons the server gives when it is sent (fieldchecks.ts sendProblem).
 */
export function checksSendProblem(f: any, all: any[]): string {
  const raw = f?.validation;
  if (raw != null && raw !== '') {
    if (typeof raw === 'string' && !raw.trim().startsWith('{')) {
      const s = raw.trim();
      if (s && !LEGACY[s]) {
        const why = patternProblem(s);
        if (why) return why;
      }
    } else {
      let obj = raw;
      if (typeof raw === 'string') {
        try {
          obj = JSON.parse(raw);
        } catch {
          return 'The format of this field cannot be read. Choose it again.';
        }
      }
      const { problem } = tidyChecks(f.type, obj);
      if (problem) return problem;
    }
  }
  if (f?.type === 'checkbox' && f.group_name) {
    const boxes = all.filter((g) => g.type === 'checkbox' && g.group_name === f.group_name && g.recipient_id === f.recipient_id);
    if (boxes[0]?.id === f.id) return groupRuleProblem(boxes);
  }
  return '';
}

/** How checks are kept in the "validation" column: the old word where that says it all, else the object as JSON. */
export function storedChecks(c: Checks): string | null {
  if (!hasChecks(c)) return null;
  const keys = Object.keys(c);
  if (keys.length === 1 && (c.kind === 'email' || c.kind === 'number' || c.kind === 'phone')) return c.kind;
  return JSON.stringify(c);
}

/** One short line that says what a field's checks are, for the editor ("Letters only, at most 40 characters"). */
export function checksSummary(type: string, c: Checks, dateFormat?: string | null): string {
  const parts: string[] = [];
  const K: Record<Kind, string> = { email: 'An email address', number: 'A number', phone: 'A phone number', letters: 'Letters only', date: `A date like ${dateExample(dateFormat)}`, pattern: 'Your own pattern' };
  if (type === 'text' && c.kind) parts.push(K[c.kind]);
  if (c.max_length) parts.push(`at most ${plural(c.max_length, 'character')}`);
  if (c.fixed) parts.push('fixed size');
  if (c.hide) parts.push(c.hide_in_copy ? 'hidden from the others and in the copy' : 'hidden from the others');
  if (type === 'number') {
    if (c.currency) parts.push(`in ${c.currency}`);
    if (c.min != null) parts.push(`at least ${fmt(c.min)}`);
    if (c.max != null) parts.push(`at most ${fmt(c.max)}`);
    if (c.decimals != null) parts.push(c.decimals ? `up to ${plural(c.decimals, 'decimal place')}` : 'whole numbers');
  }
  if (type === 'checkbox' && c.group_rule && c.group_count != null) parts.push(groupRuleWords(c.group_rule, c.group_count).replace(/\.$/, ''));
  const s = parts.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'None';
}
