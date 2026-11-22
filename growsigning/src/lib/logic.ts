// Conditional fields and formulas. A field can be shown only when another field of the same person has a certain
// answer ("show_when"), and a number field can be worked out from other number fields ("formula"), for totals on
// order forms and quotes. Plain data in, plain data out, no React and no server: the signing page shows, hides and
// adds up live with these functions, and the server works everything out again with the same ones from what is
// stored (src/server/logic.ts), so what a signer saw is what is printed. The server never takes the browser's word
// for a hidden or a calculated field.
//
// The formula is read by the small parser below. Nothing in a formula is ever run as code: no eval, no Function, no
// lookups by name on objects. It knows numbers, field names in curly brackets, + - * / (also × ÷ and the minus sign),
// round brackets, sum(...) and round(..., decimals). Anything else is refused in words.
import { NUMBER_RULE } from './numbers.ts';

// ---- Rules: "Only show when..." ----------------------------------------------------------------------------------

export const CONDS = ['checked', 'unchecked', 'filled', 'empty', 'equals', 'not_equals', 'more_than', 'less_than'] as const;
export type Cond = (typeof CONDS)[number];
export type Rule = { field: string; is: Cond; value?: string | null };

const TEXTY: Cond[] = ['filled', 'empty', 'equals', 'not_equals'];
/** Which questions can be asked about each kind of field. A rule can only depend on one of these. */
export const CONDS_FOR: Record<string, Cond[]> = {
  checkbox: ['checked', 'unchecked'], radio: ['checked', 'unchecked'],
  dropdown: ['equals', 'not_equals', 'filled', 'empty'],
  text: TEXTY, company: TEXTY, title: TEXTY,
  number: ['filled', 'empty', 'equals', 'not_equals', 'more_than', 'less_than'],
  date: ['filled', 'empty'], attachment: ['filled', 'empty'],
};
/** The conditions that compare with a value the sender gives. */
export const NEEDS_VALUE: Cond[] = ['equals', 'not_equals', 'more_than', 'less_than'];
/** The longest value a rule may compare with, and the longest formula. */
export const RULE_VALUE_MAX = 200;
export const FORMULA_MAX = 500;
/** round(x, n) rounds to at most this many decimals. */
export const MAX_DECIMALS = 10;
/** The most fields that can depend on each other in one line (a total of a total of a total...). */
export const MAX_CHAIN = 100;

/** Fields that belong to the sender and are always on the page: they cannot be made conditional. */
export const ALWAYS_SHOWN = (type: any) => type === 'note' || type === 'strike';

type F = { id: string; type: string; recipient_id?: string | null; value?: any; calc_num?: any; label?: any; options?: any; readonly?: any; show_when?: Rule | null; formula?: string | null; group_name?: any };

/** The rule of a field as an object, whether it came from the database (JSON text), the editor or an API caller. */
export function ruleOf(f: { show_when?: any } | null | undefined): Rule | null {
  let w: any = f?.show_when;
  if (typeof w === 'string') {
    try {
      w = JSON.parse(w);
    } catch {
      return null;
    }
  }
  // The value is trimmed, as the server stores it (saveLogic), so "Gold " in the editor is the rule "Gold" and not a
  // change that would ask someone to sign again.
  const v = w?.value != null ? String(w.value).trim() : '';
  return w && typeof w === 'object' && !Array.isArray(w) && w.field ? { field: String(w.field), is: w.is, ...(v ? { value: v } : {}) } : null;
}

/**
 * The rule and the formula of a field in one string, the same on the server and in the editor. It is part of what
 * is printed (printedView in src/server/envelopes.ts, and its mirror in src/components/editor/changes.ts): once
 * someone has finished, a changed rule or formula changes what their document says, so it needs the sign-again choice.
 */
export function logicKey(f: any): string {
  const w = ruleOf(f);
  const formula = f?.formula ? String(f.formula) : '';
  return w || formula ? JSON.stringify([w ? [w.field, w.is, w.value ?? ''] : null, formula]) : '';
}

const fold = (s: any) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

// ---- Numbers as people write them ----------------------------------------------------------------------------------

/** How a number was written: which mark comes before the decimals and which one groups the thousands. */
export type Notation = { dec: '.' | ','; group: string | null; indian: boolean };
export type ReadNumber = { value: number; digits: number; dec: '.' | ',' | null; group: string | null; indian: boolean; ambiguous: '.' | ',' | null };

/**
 * Digits of any script (١٢٣, १२३, １２３, 𝟙𝟘𝟘) as 0 to 9. Unicode keeps every script's digits together in order from
 * 0, in whole runs of ten, and some runs sit right after each other (five styles of mathematical digits, 50 in a
 * row): so the digit is how far it is from the start of its run, counted in tens, not at most ten steps back.
 */
function asciiDigit(ch: string): string {
  const plain = ch.normalize('NFKC');
  if (plain >= '0' && plain <= '9') return plain;
  let cp = ch.codePointAt(0)!, k = 0;
  while (k < 60 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))) (cp--, k++);
  return String(k % 10);
}
const SPACES = /[    ]/g;
/** At most this many digits are worked out exactly. A longer number is said, not rounded quietly. */
export const MAX_DIGITS = 15;

/**
 * The value of a number the way a number field accepts it (src/lib/numbers.ts): 2500, 12,5, 1.234,56, 1 234,56,
 * 1'234.56, 1,23,456, with a sign or a currency. Null when it is not a number. A single mark followed by exactly
 * three digits (1.234 or 1,234) can be either: `dec` says which mark the other numbers of the same formula use before
 * decimals, and without one it is read as a thousands mark (one thousand two hundred and thirty-four), the way a
 * total on an order form is most often written. Such a reading is flagged in `ambiguous`.
 */
export function readNumber(text: any, dec?: '.' | ',' | null): ReadNumber | null {
  const raw = String(text ?? '').trim();
  if (!raw || !NUMBER_RULE.test(raw)) return null;
  let s = raw.replace(/\p{Sc}/gu, '').replace(/(kr|zł|Kč|Ft|лв|руб)$/u, '').trim();
  let sign = 1;
  if (/^[+\-−]/.test(s)) (sign = s[0] === '+' ? 1 : -1), (s = s.slice(1).trim());
  s = [...s].map((ch) => (/\p{Nd}/u.test(ch) ? asciiDigit(ch) : ch)).join('').replace(SPACES, ' ').replace(/’/g, "'").replace(/٬/g, ',');
  const marks = [...s].filter((ch) => !/[0-9]/.test(ch));
  let intPart = s, frac = '', group: string | null = null, decMark: '.' | ',' | null = null, ambiguous: '.' | ',' | null = null, indian = false;
  const kinds = [...new Set(marks)];
  if (kinds.length === 2) {
    // Two kinds of mark: the last one is before the decimals, the other groups the thousands.
    const last = s.search(/[^0-9][0-9]+$/);
    frac = s.slice(last + 1);
    const d = s[last];
    decMark = d === '٫' || d === '.' ? '.' : ',';
    group = kinds.find((k) => k !== d) || null;
    intPart = s.slice(0, last);
  } else if (kinds.length === 1) {
    const m = kinds[0];
    const parts = s.split(m);
    if (m === '٫') (decMark = '.'), (intPart = parts[0]), (frac = parts[1]);
    else if (marks.length > 1 || m === ' ' || m === "'") group = m;
    else if (parts[1].length !== 3 || parts[0] === '0' || parts[0].length > 3) (decMark = m as '.' | ','), (intPart = parts[0]), (frac = parts[1]);
    else if (dec === m) (decMark = m), (intPart = parts[0]), (frac = parts[1]);
    else (group = m), (ambiguous = dec ? null : (m as '.' | ','));
  }
  if (group) {
    const groups = intPart.split(group);
    indian = groups.length > 2 && groups.slice(1, -1).every((g) => g.length === 2);
    intPart = groups.join('');
  }
  const digits = (intPart.replace(/^0+/, '') + frac).replace(/^0+/, '').length;
  return { value: sign * Number(`${intPart || '0'}.${frac || '0'}`), digits, dec: decMark, group: group === "'" ? "'" : group, indian, ambiguous };
}

/** The way a list of numbers is written, taken from the first of them that shows it. Plain 1234.5 when none does. */
export function notationOf(texts: any[]): Notation {
  let dec: '.' | ',' | null = null, group: string | null = null, indian = false;
  for (const t of texts) {
    // { text, dec }: a text whose mark before decimals is known (a calculated result, see markOf).
    const n = t && typeof t === 'object' ? readNumber(t.text, t.dec) : readNumber(t);
    if (!n) continue;
    if (!dec && n.dec) dec = n.dec;
    if (!group && n.group && !n.ambiguous) (group = n.group), (indian = n.indian);
  }
  if (!dec && group) dec = group === '.' ? ',' : '.';
  if (group === dec) group = null;
  return { dec: dec || '.', group, indian };
}

/** Rounds half away from zero, on the number as it is written in decimals (1.005 to 2 decimals is 1.01). */
export function roundTo(x: number, n: number): number {
  // The number is first cut to the digits that can be trusted, then moved n places by writing it in decimals, so
  // the rounding happens on the number a person reads and not on its nearest binary neighbour.
  const a = Number(Math.abs(x).toPrecision(MAX_DIGITS));
  if (!a || !Number.isFinite(a)) return a === 0 ? 0 : x;
  const [m, e] = a.toExponential().split('e');
  const shifted = Number(`${m}e${Number(e) + n}`);
  if (shifted >= 1e21) return x; // far more digits than can be trusted already: nothing left to round
  const r = Number(`${Math.round(shifted)}e-${n}`);
  return x < 0 ? -r : r;
}

/**
 * A worked-out number written the way the numbers it came from are written: with their mark before the decimals
 * and their thousands mark. `fixed` is the number of decimals round() asked for, always shown (12.50); without it, as
 * many as the number has, up to MAX_DIGITS digits in all.
 */
export function formatNumber(x: number, how: Notation, fixed?: number | null): string {
  const neg = x < 0 && roundTo(x, fixed ?? MAX_DECIMALS) !== 0;
  const a = Math.abs(x);
  let s: string;
  if (fixed != null) s = roundTo(a, fixed).toFixed(fixed);
  else {
    const whole = Math.max(1, Math.floor(a).toString().length);
    s = roundTo(a, Math.max(0, Math.min(MAX_DECIMALS, MAX_DIGITS - whole))).toFixed(Math.max(0, Math.min(MAX_DECIMALS, MAX_DIGITS - whole))).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  let [int, frac] = s.split('.');
  if (how.group) {
    const g = how.group;
    if (how.indian && int.length > 3) int = `${int.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, g)}${g}${int.slice(-3)}`;
    else int = int.replace(/\B(?=(\d{3})+$)/g, g);
  }
  return `${neg ? '-' : ''}${int}${frac ? `${how.dec}${frac}` : ''}`;
}
/** The mark before decimals in `text`, which is known to show the number `num`: the reading that gives that number. */
export function markOf(text: string, num: number): '.' | ',' | null {
  for (const d of ['.', ','] as const) {
    const n = readNumber(text, d);
    if (n && n.value === num) return n.dec;
  }
  return null;
}
/** A number written plainly: a dot before decimals and no grouping, the way a calculated result is kept (canon). */
export const PLAIN: Notation = { dec: '.', group: null, indian: false };
/**
 * The number a stored calculated field holds, from `calc_num` (its result written plainly, kept next to the text that
 * is shown): "1.233" or "1,233" on its own could be one thousand and more, so the shown text is never read again for
 * it. Null when the field holds nothing (a view that blanks a value blanks its number with it) or keeps no number.
 */
export function canonOf(f: { value?: any; calc_num?: any } | null | undefined): number | null {
  if (!f || f.value == null || f.value === '' || f.calc_num == null || f.calc_num === '') return null;
  const n = Number(f.calc_num);
  return Number.isFinite(n) ? n : null;
}

// ---- Formulas: "Calculate from..." ------------------------------------------------------------------------------

export type Ast =
  | { k: 'num'; v: number; text: string }
  | { k: 'ref'; id: string }
  | { k: 'neg'; a: Ast }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Ast; b: Ast }
  | { k: 'sum'; args: Ast[] }
  | { k: 'round'; a: Ast; n: number };

export class FormulaError extends Error {}
const MAX_DEPTH = 20;
const MAX_REFS = 100;

type Tok = { t: 'num' | 'ref' | 'name' | 'op' | '(' | ')' | ','; v: string; at: number };
function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new FormulaError('A field name is opened with { and never closed with }. Write field names like {Quantity}.');
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new FormulaError('There is an empty {} in the formula. Put the name of a number field between the curly brackets, like {Quantity}.');
      if (name.includes('{')) throw new FormulaError('A field name is opened with { and never closed with }. Write field names like {Quantity}.');
      out.push({ t: 'ref', v: name, at: i });
      i = end + 1;
      continue;
    }
    if (ch === '}') throw new FormulaError('There is a } with no { before it. Write field names like {Quantity}.');
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      // A number typed into a field may have at most MAX_DIGITS digits, and so may one in the formula: beyond that the
      // sum is no longer exact, and the result would be wrong without a word.
      if (num[0].replace('.', '').replace(/^0+/, '').length > MAX_DIGITS)
        throw new FormulaError(`The number ${num[0].length > 40 ? `${num[0].slice(0, 20)}...` : num[0]} in the formula has more than ${MAX_DIGITS} digits, more than can be worked out exactly. Use a shorter number.`);
      out.push({ t: 'num', v: num[0], at: i });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z]+/.exec(src.slice(i));
    if (word) {
      out.push({ t: 'name', v: word[0].toLowerCase(), at: i });
      i += word[0].length;
      continue;
    }
    if ('+-*/×÷−'.includes(ch)) {
      out.push({ t: 'op', v: ch === '×' ? '*' : ch === '÷' ? '/' : ch === '−' ? '-' : ch, at: i });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ t: ch, v: ch, at: i });
      i++;
      continue;
    }
    if (ch === ',' || ch === ';') {
      out.push({ t: ',', v: ch, at: i });
      i++;
      continue;
    }
    throw new FormulaError(`The formula has "${ch}" in it, which it cannot use. Use numbers (with a dot before decimals, like 0.2), field names in curly brackets like {Quantity}, + - * / and round brackets.`);
  }
  return out;
}

/** Reads a formula into a tree. Refused with a FormulaError whose message says what is wrong in plain words. */
export function parseFormula(src: any): Ast {
  const text = String(src ?? '');
  if (!text.trim()) throw new FormulaError('The formula is empty. Write one like {Quantity} * {Unit price}.');
  if (text.length > FORMULA_MAX) throw new FormulaError(`The formula is ${text.length} characters long, and the most it can be is ${FORMULA_MAX}.`);
  const t = tokens(text);
  let p = 0, refs = 0;
  const peek = () => t[p];
  const after = () => (p > 0 ? ` after "${t[p - 1].v}"` : ' at the start');
  const expect = (kind: Tok['t'], what: string) => {
    if (peek()?.t !== kind) throw new FormulaError(`${what} is missing${after()}.`);
    p++;
  };
  function expr(depth: number): Ast {
    if (depth > MAX_DEPTH) throw new FormulaError(`The formula has more than ${MAX_DEPTH} brackets or functions inside each other. Write it more simply.`);
    let a = term(depth);
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = t[p++].v as '+' | '-';
      a = { k: 'bin', op, a, b: term(depth) };
    }
    return a;
  }
  function term(depth: number): Ast {
    let a = unary(depth);
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = t[p++].v as '*' | '/';
      a = { k: 'bin', op, a, b: unary(depth) };
    }
    return a;
  }
  function unary(depth: number): Ast {
    if (peek()?.t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const minus = t[p++].v === '-';
      if (depth > MAX_DEPTH) throw new FormulaError(`The formula has more than ${MAX_DEPTH} signs or brackets inside each other. Write it more simply.`);
      const a = unary(depth + 1);
      return minus ? { k: 'neg', a } : a;
    }
    return primary(depth);
  }
  function primary(depth: number): Ast {
    const k = peek();
    if (!k) throw new FormulaError(`Something is missing at the end${after()}: a number, a field like {Quantity} or a bracket.`);
    if (k.t === 'num') return (p++, { k: 'num', v: Number(k.v), text: k.v });
    if (k.t === 'ref') {
      if (++refs > MAX_REFS) throw new FormulaError(`The formula uses more than ${MAX_REFS} fields.`);
      return (p++, { k: 'ref', id: k.v });
    }
    if (k.t === '(') {
      p++;
      const a = expr(depth + 1);
      expect(')', 'A closing bracket )');
      return a;
    }
    if (k.t === 'name') {
      p++;
      if (k.v !== 'sum' && k.v !== 'round') throw new FormulaError(`"${k.v}" is not something a formula knows. It can use sum(...) to add up a list and round(..., decimals) to round, and field names go in curly brackets, like {${k.v}}.`);
      expect('(', `The bracket ( after ${k.v}`);
      const args: Ast[] = [];
      if (peek()?.t !== ')') {
        args.push(expr(depth + 1));
        while (peek()?.t === ',') (p++, args.push(expr(depth + 1)));
      }
      expect(')', `The closing bracket ) of ${k.v}(...)`);
      if (k.v === 'sum') {
        if (!args.length) throw new FormulaError('sum() has nothing in it. Put the fields to add up between the brackets, like sum({Line 1}, {Line 2}).');
        return { k: 'sum', args };
      }
      const n = args[1];
      if (args.length !== 2 || n.k !== 'num' || !Number.isInteger(n.v) || n.v > MAX_DECIMALS)
        throw new FormulaError(`round needs what to round and a whole number of decimals from 0 to ${MAX_DECIMALS}, like round({Total}, 2).`);
      return { k: 'round', a: args[0], n: n.v };
    }
    if (k.t === ')') throw new FormulaError(`There is a closing bracket )${after()} with nothing before it to close.`);
    if (k.t === ',') throw new FormulaError(`There is a "${k.v}"${after()}. Commas only go between the parts of sum(...) or round(...). Write decimals with a dot, like 0.2.`);
    throw new FormulaError(`Something is missing${after()}: a number, a field like {Quantity} or a bracket.`);
  }
  const ast = expr(0);
  if (p < t.length) {
    const k = t[p];
    throw new FormulaError(k.t === ')' ? 'There is a closing bracket ) with no opening one before it.' : k.t === ',' ? `There is a "${k.v}" outside sum(...) or round(...). Write decimals with a dot, like 0.2.` : `"${k.v}" follows${after()} with nothing between them. Put + - * or / between two parts.`);
  }
  return ast;
}

/** Every field a formula names, in order, each once. */
export function refsOf(ast: Ast, out: string[] = []): string[] {
  if (ast.k === 'ref') !out.includes(ast.id) && out.push(ast.id);
  else if (ast.k === 'neg') refsOf(ast.a, out);
  else if (ast.k === 'bin') (refsOf(ast.a, out), refsOf(ast.b, out));
  else if (ast.k === 'sum') ast.args.forEach((a) => refsOf(a, out));
  else if (ast.k === 'round') refsOf(ast.a, out);
  return out;
}
/** The names in a formula as written, without parsing the rest (so a half-typed formula still shows its fields). */
export const namesIn = (src: any): string[] => [...String(src ?? '').matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].trim()).filter(Boolean);
/** The formula with every {name} replaced: from labels to ids when it is saved, from ids to labels when it is shown. */
export const renameRefs = (src: any, to: (name: string) => string): string => String(src ?? '').replace(/\{([^{}]*)\}/g, (_m, n) => `{${to(String(n).trim())}}`);

/** What a formula worked out to: a number, or nothing and why. */
/**
 * `text` is the result as the signer sees it, in the notation of its inputs (1.234,50). `canon` is the same number
 * written plainly (1234.5), stored next to it (fields.calc_num) and read by everything that later needs the number,
 * and `value` is that number: what is shown, what is printed and what the next formula counts are one number.
 */
export type Calc = { value: number | null; text: string | null; canon?: string | null; error: string | null; empty: boolean; ambiguous: string[]; numbers: string };
export const CALC_EMPTY = 'Fills in by itself once the fields it is worked out from are filled in.';
export const CALC_RULES = 'Empty fields count as 0. A field that is not shown counts as empty.';

/**
 * Works a formula out. `input(id)` gives the text of a field it names (null or '' when empty) or, for another
 * calculated field, its number. `name(id)` names a field for the words. The result has no value, and says why, when
 * it would divide by 0, when a field it uses does not read as a number, when a number is too long to work out
 * exactly, and when every field it uses is empty.
 */
export function evaluate(ast: Ast, input: (id: string) => { text?: string | null; num?: number | null; error?: string | null } | null, name: (id: string) => string): Calc {
  // An input with `num` (another calculated field) is taken as that number; its `text` only says how it is written.
  const refs = refsOf(ast);
  // A calculated input shown as "1,233" says nothing on its own about its comma; its number (1.233) does. So its
  // mark is known, and the result and a lone 1.234 typed next to it are written and read the same way.
  const texts = refs.map((id) => input(id)).filter((g) => g?.text != null && String(g.text).trim() !== '')
    .map((g) => (g!.num != null ? { text: String(g!.text), dec: markOf(String(g!.text), g!.num) } : g!.text));
  const how = notationOf(texts);
  const hint = texts.map((t: any) => (typeof t === 'object' ? readNumber(t.text, t.dec) : readNumber(t))).find((n) => n?.dec)?.dec ?? null;
  const ambiguous: string[] = [];
  let filled = 0;
  const shown = new Map<string, number>();
  const fail = (error: string): Calc => ({ value: null, text: null, error, empty: false, ambiguous, numbers: '' });
  for (const id of refs) {
    const got = input(id);
    // Another calculated field that cannot be worked out: neither can this one, and it says which.
    if (got?.error) return fail(`'${name(id)}' cannot be worked out, so this cannot either.`);
    if (got?.num != null) {
      shown.set(id, got.num), filled++;
      continue;
    }
    const t = got?.text == null ? '' : String(got.text).trim();
    if (!t) {
      shown.set(id, 0);
      continue;
    }
    const n = readNumber(t, hint);
    if (!n) return fail(`'${name(id)}' does not read as a number, so this cannot be worked out. Type it as a number, like 2500 or 12.5.`);
    if (n.digits > MAX_DIGITS) return fail(`'${name(id)}' has more than ${MAX_DIGITS} digits, more than can be worked out exactly, so this is left empty.`);
    if (n.ambiguous) ambiguous.push(`'${name(id)}' (${t}) is read as ${formatNumber(n.value, { dec: n.ambiguous === '.' ? ',' : '.', group: null, indian: false })}.`);
    shown.set(id, n.value), filled++;
  }
  if (refs.length && !filled) return { value: null, text: null, error: null, empty: true, ambiguous, numbers: '' };
  let div0 = '';
  const run = (a: Ast): number => {
    switch (a.k) {
      case 'num': return a.v;
      case 'ref': return shown.get(a.id) ?? 0;
      case 'neg': return -run(a.a);
      case 'sum': return a.args.reduce((s, x) => s + run(x), 0);
      case 'round': return roundTo(run(a.a), a.n);
      case 'bin': {
        const x = run(a.a), y = run(a.b);
        if (a.op === '/' && y === 0) {
          div0 ||= a.b.k === 'ref' ? `'${name(a.b.id)}' is 0 or empty` : 'a part of it comes to 0';
          return NaN;
        }
        return a.op === '+' ? x + y : a.op === '-' ? x - y : a.op === '*' ? x * y : x / y;
      }
    }
  };
  const v = run(ast);
  if (div0) return fail(`This cannot be worked out yet: it would divide by 0, because ${div0}.`);
  const fixed = ast.k === 'round' ? ast.n : null;
  // The number as it is shown, written plainly. The limit is checked on it, after rounding: 999999999999999.9 shows
  // as 1000000000000000, which has 16 digits.
  const canon = Number.isFinite(v) ? formatNumber(v, PLAIN, fixed) : '';
  if (!canon || Math.abs(Number(canon)) >= 10 ** MAX_DIGITS) return fail(`The result is too large to work out exactly (${MAX_DIGITS} digits at most), so this is left empty.`);
  const numbers = refs.map((id) => `${name(id)} ${formatNumber(shown.get(id) ?? 0, { ...how, group: null })}`).join(', ');
  return { value: Number(canon), text: formatNumber(v, how, fixed), canon, error: null, empty: false, ambiguous, numbers };
}

/**
 * A formula in words for the screen: field names as they are labelled, × and ÷ for * and /, brackets only where they
 * change something, and a round() around the whole of it said as "rounded to 2 decimals".
 */
export function formulaWords(src: any, name: (id: string) => string): string {
  let ast: Ast;
  try {
    ast = parseFormula(src);
  } catch {
    // Not readable yet (the editor shows it while it is being typed): the text with the names put in.
    return renameRefs(src, name).replace(/\{([^{}]*)\}/g, "'$1'").replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s+/g, ' ').trim();
  }
  const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 } as const;
  const SIGN = { '+': '+', '-': '-', '*': '×', '/': '÷' } as const;
  const w = (a: Ast, outer = 0, right = false): string => {
    switch (a.k) {
      case 'num': return a.text;
      case 'ref': return `'${name(a.id)}'`;
      case 'neg': return `-${a.a.k === 'bin' ? `(${w(a.a)})` : w(a.a, 3)}`;
      case 'sum': return `sum(${a.args.map((x) => w(x)).join(', ')})`;
      case 'round': return `round(${w(a.a)}, ${a.n})`;
      case 'bin': {
        const p = PREC[a.op];
        const s = `${w(a.a, p)} ${SIGN[a.op]} ${w(a.b, p, true)}`;
        return p < outer || (right && p === outer) ? `(${s})` : s;
      }
    }
  };
  if (ast.k === 'round') return `${ast.a.k === 'sum' ? `the sum of ${ast.a.args.map((x) => w(x)).join(', ')}` : w(ast.a)}, rounded to ${ast.n} decimal${ast.n === 1 ? '' : 's'}`;
  if (ast.k === 'sum') return `the sum of ${ast.args.map((x) => w(x)).join(', ')}`;
  return w(ast);
}

// ---- Working out a whole set of fields --------------------------------------------------------------------------

export type Outcome = {
  /** Fields that are not shown: not on the screen, not required, nothing printed. */
  hidden: Set<string>;
  /** For each calculated field, what it worked out to. */
  calc: Map<string, Calc>;
};

/**
 * Which fields are shown and what every formula comes to, from the values in `fields`. A field with a rule is shown
 * only when the field it depends on is shown and has the answer asked for, so a chain of rules folds up from the
 * top. A field in a loop (which the server refuses when the sender saves) is never shown. `stored(f)` says that a
 * calculated field keeps the value it holds (its signer has finished, or it is someone else's) instead of being
 * worked out again.
 */
export function workOut(fields: F[], o: { stored?: (f: F) => boolean; name?: (f: F) => string } = {}): Outcome {
  const byId = new Map<string, F>(fields.map((f) => [f.id, f]));
  // A field that is not in the list is never named by its id on a screen.
  const name = (id: string) => {
    const f = byId.get(id);
    return f ? (o.name ? o.name(f) : String(f.label || f.type)) : 'another field';
  };
  const shownMemo = new Map<string, boolean>();
  const calcMemo = new Map<string, Calc>();
  const busy = new Set<string>();
  const parsed = new Map<string, Ast | null>();
  const astOf = (f: F) => {
    if (!parsed.has(f.id)) {
      try {
        parsed.set(f.id, parseFormula(f.formula));
      } catch (err) {
        // Only a formula that cannot be read is "cannot be read". Anything else is a fault of ours and is not hidden.
        if (!(err instanceof FormulaError)) throw err;
        parsed.set(f.id, null);
      }
    }
    return parsed.get(f.id)!;
  };
  const calcd = (f: F) => !!f.formula && f.type === 'number' && !(o.stored && o.stored(f));
  // How deep the working out goes at once. A save refuses a line of more than MAX_CHAIN fields that depend on each
  // other (src/server/logic.ts), so this is only reached by fields saved before that limit: they are not shown or
  // not worked out, instead of the stack running out on a phone or on the server.
  let level = 0;
  const DEEP = MAX_CHAIN * 3;
  function shown(f: F): boolean {
    if (shownMemo.has(f.id)) return shownMemo.get(f.id)!;
    const w = ruleOf(f);
    if (!w || ALWAYS_SHOWN(f.type)) return (shownMemo.set(f.id, true), true);
    if (busy.has(`s:${f.id}`)) return false; // a loop: never shown
    if (level > DEEP) return (shownMemo.set(f.id, false), false);
    busy.add(`s:${f.id}`);
    level++;
    const p = byId.get(w.field);
    const ok = !!p && p.id !== f.id && shown(p) && holds(w, p);
    level--;
    busy.delete(`s:${f.id}`);
    shownMemo.set(f.id, ok);
    return ok;
  }
  function textOf(f: F): string {
    if (!shown(f)) return '';
    if (calcd(f)) return calc(f).text ?? '';
    return f.value == null ? '' : String(f.value);
  }
  // A calculated field that keeps what it holds counts with the number stored for it (canonOf), never with its
  // shown text read again: "1.233" is one and a bit, not one thousand two hundred and thirty-three.
  function numOf(f: F): number | null {
    if (!shown(f)) return null;
    if (calcd(f)) return calc(f).value;
    return canonOf(f) ?? readNumber(f.value)?.value ?? null;
  }
  function holds(w: Rule, p: F): boolean {
    const v = textOf(p);
    switch (w.is) {
      case 'checked': return v === '1';
      case 'unchecked': return v !== '1';
      case 'filled': return v.trim() !== '';
      case 'empty': return v.trim() === '';
      case 'equals':
      case 'not_equals': {
        let same: boolean;
        if (p.type === 'number') {
          const a = numOf(p), b = readNumber(w.value)?.value;
          same = a != null && b != null && a === b;
        } else same = v.trim() !== '' && fold(v) === fold(w.value);
        return w.is === 'equals' ? same : !same;
      }
      case 'more_than':
      case 'less_than': {
        const a = numOf(p), b = readNumber(w.value)?.value;
        return a != null && b != null && (w.is === 'more_than' ? a > b : a < b);
      }
      default: return false;
    }
  }
  function calc(f: F): Calc {
    if (calcMemo.has(f.id)) return calcMemo.get(f.id)!;
    const ast = astOf(f);
    if (!ast) return { value: null, text: null, error: 'This formula cannot be read, so nothing is worked out.', empty: false, ambiguous: [], numbers: '' };
    if (busy.has(`c:${f.id}`)) return { value: null, text: null, error: 'This formula depends on itself, so it cannot be worked out.', empty: false, ambiguous: [], numbers: '' };
    if (level > DEEP) return { value: null, text: null, error: `More than ${MAX_CHAIN} fields depend on each other in a line here, so this is not worked out.`, empty: false, ambiguous: [], numbers: '' };
    busy.add(`c:${f.id}`);
    level++;
    const out = evaluate(ast, (id) => {
      const x = byId.get(id);
      if (!x || x.type !== 'number' || !shown(x)) return null;
      const text = x.value == null ? null : String(x.value);
      // Another calculated field gives its number, whether it is worked out now or kept as stored, and its text says
      // how it is written, so both ways come to the same result.
      if (!calcd(x)) return canonOf(x) != null ? { num: canonOf(x), text } : { text };
      const inner = calc(x);
      return { num: inner.value, error: inner.error, text: inner.text };
    }, name);
    level--;
    busy.delete(`c:${f.id}`);
    calcMemo.set(f.id, out);
    return out;
  }
  const hidden = new Set<string>();
  const results = new Map<string, Calc>();
  for (const f of fields) {
    if (!shown(f)) hidden.add(f.id);
    else if (calcd(f)) results.set(f.id, calc(f));
  }
  return { hidden, calc: results };
}

/** Each field that a rule or a formula of `f` depends on. */
export function dependsOn(f: F): string[] {
  const out: string[] = [];
  const w = ruleOf(f);
  if (w) out.push(w.field);
  if (f.formula) for (const n of namesIn(f.formula)) if (!out.includes(n)) out.push(n);
  return out;
}

/** Loops of fields that depend on each other, each as the list of field ids around it. Empty when there is none. */
export function loopsIn(fields: F[]): string[][] {
  const byId = new Map<string, F>(fields.map((f) => [f.id, f]));
  const state = new Map<string, 1 | 2>();
  const loops: string[][] = [];
  // Walked with a list of its own rather than by calling itself, so no number of fields can run the stack out.
  const path: string[] = [];
  const todo: { id: string; next: string[]; i: number }[] = [];
  const enter = (id: string) => (state.set(id, 1), path.push(id), todo.push({ id, next: dependsOn(byId.get(id)!), i: 0 }));
  for (const f of fields) {
    if (state.has(f.id)) continue;
    enter(f.id);
    while (todo.length) {
      const top = todo[todo.length - 1];
      if (top.i >= top.next.length) {
        todo.pop(), path.pop(), state.set(top.id, 2);
        continue;
      }
      const next = top.next[top.i++];
      if (!byId.has(next)) continue;
      if (state.get(next) === 1) loops.push(path.slice(path.indexOf(next)));
      else if (!state.has(next)) enter(next);
    }
  }
  return loops;
}

/**
 * The longest line of fields that each depend on the next (shown after its answer, or worked out from it), as the
 * field it starts from and how many fields are in it. Asked once there is no loop; walked without calling itself.
 */
export function longestChain(fields: F[]): { id: string; length: number } {
  const byId = new Map<string, F>(fields.map((f) => [f.id, f]));
  const len = new Map<string, number>();
  let best = { id: '', length: 0 };
  for (const f of fields) {
    if (len.has(f.id)) continue;
    const on = new Set<string>([f.id]);
    const todo: { id: string; next: string[]; i: number }[] = [{ id: f.id, next: dependsOn(f).filter((n) => byId.has(n)), i: 0 }];
    while (todo.length) {
      const top = todo[todo.length - 1];
      if (top.i < top.next.length) {
        const n = top.next[top.i++];
        if (!len.has(n) && !on.has(n)) (on.add(n), todo.push({ id: n, next: dependsOn(byId.get(n)!).filter((x) => byId.has(x)), i: 0 }));
        continue;
      }
      todo.pop(), on.delete(top.id);
      const l = 1 + top.next.reduce((m, n) => Math.max(m, len.get(n) ?? 0), 0);
      len.set(top.id, l);
      if (l > best.length) best = { id: top.id, length: l };
    }
  }
  return best;
}

/** A rule as a sentence: "Shown when 'Has a co-signer' is ticked". `parent` is the field it depends on. */
export function ruleWords(w: Rule | null, parent: { type: string } | null | undefined, parentName: string): string {
  if (!w) return '';
  const n = `'${parentName}'`;
  const pick = parent?.type === 'radio' ? 'chosen' : 'ticked';
  const v = w.value ?? '';
  const quoted = parent?.type === 'number' ? v : `"${v}"`;
  switch (w.is) {
    case 'checked': return `Shown when ${n} is ${pick}`;
    case 'unchecked': return `Shown when ${n} is not ${pick}`;
    case 'filled': return `Shown when ${n} is filled in`;
    case 'empty': return `Shown when ${n} is left empty`;
    case 'equals': return `Shown when ${n} is ${quoted}`;
    case 'not_equals': return `Shown when ${n} is anything but ${quoted}`;
    case 'more_than': return `Shown when ${n} is more than ${v}`;
    case 'less_than': return `Shown when ${n} is less than ${v}`;
    default: return `Shown when ${n} has a certain answer`;
  }
}

/** The words for each condition, for the editor's choice. */
export const COND_WORDS: Record<Cond, (type: string) => string> = {
  checked: (t) => (t === 'radio' ? 'is chosen' : 'is ticked'),
  unchecked: (t) => (t === 'radio' ? 'is not chosen' : 'is not ticked'),
  filled: () => 'is filled in',
  empty: () => 'is left empty',
  equals: () => 'is',
  not_equals: () => 'is anything but',
  more_than: () => 'is more than',
  less_than: () => 'is less than',
};

// ---- What the review step warns about ------------------------------------------------------------------------------

type R = { id: string; name?: string | null; role?: string | null; role_name?: string | null; routing_order?: any };
const SIGNS = (r?: R) => r?.role === 'signer' || r?.role === 'inperson';

/**
 * What the editor's review step lists before sending, in words: rules that can never be true, and fields a formula
 * needs that the person it belongs to cannot reach when they sign. Sending is not refused for these (an empty input
 * counts as 0, a rule that is never true hides its field), but the sender should know. `ordered` is whether people
 * sign in order. `name(f)` names a field.
 */
export function logicWarnings(fields: F[], recipients: R[], ordered: boolean, name: (f: F) => string): string[] {
  const out: string[] = [];
  const byId = new Map<string, F>(fields.map((f) => [f.id, f]));
  const person = (id?: string | null) => recipients.find((r) => r.id === id);
  const who = (id?: string | null) => person(id)?.name || person(id)?.role_name || 'someone';
  const never = new Set<string>();
  // A rule can never be true when its answer is fixed and not the one asked for, or the choice does not exist.
  const fixed = (p: F) => !!p.readonly;
  const neverTrue = (f: F, seen = new Set<string>()): string | null => {
    const w = ruleOf(f);
    if (!w || seen.has(f.id)) return null;
    seen.add(f.id);
    const p = byId.get(w.field);
    if (!p) return `it depends on a field that is no longer on the envelope`;
    if (p.recipient_id !== f.recipient_id) return `it depends on '${name(p)}', which belongs to someone else`;
    if (p.type === 'dropdown' && (w.is === 'equals') && !(p.options || []).some((x: any) => fold(x) === fold(w.value))) return `'${name(p)}' has no choice "${w.value ?? ''}"`;
    if (fixed(p)) {
      const one = workOut([{ ...p, show_when: null }, { ...f, show_when: { ...w, field: p.id } }]);
      if (one.hidden.has(f.id)) return `'${name(p)}' is filled in by the sender and cannot be changed, so the answer it would need never comes`;
    }
    const up = neverTrue(p, seen);
    return up ? `'${name(p)}' is never shown itself (${up})` : null;
  };
  for (const f of fields) {
    const why = neverTrue(f);
    if (why) {
      never.add(f.id);
      out.push(`'${name(f)}' for ${who(f.recipient_id)} will never be shown: ${why}. Change the rule under "Only show when", or remove it.`);
    }
  }
  // Someone whose every signature field has a rule may finish without signing anywhere, when their answers hide them.
  for (const r of recipients) {
    const sigs = fields.filter((f) => f.recipient_id === r.id && (f.type === 'signature' || f.type === 'initials'));
    if (SIGNS(r) && sigs.length && sigs.every((f) => ruleOf(f))) out.push(`Every signature and initials field of ${who(r.id)} is shown only after a certain answer. With other answers ${who(r.id)} finishes without signing anywhere on the page. Leave at least one of them always shown.`);
  }
  for (const f of fields) {
    if (!f.formula || f.type !== 'number') continue;
    const owner = person(f.recipient_id);
    for (const id of namesIn(f.formula)) {
      const x = byId.get(id);
      if (!x) {
        out.push(`The formula of '${name(f)}' uses a field that is no longer on the envelope. Choose another one under "Calculate from".`);
        continue;
      }
      const theirs = person(x.recipient_id);
      const before = ordered && Number(theirs?.routing_order) < Number(owner?.routing_order);
      if (never.has(x.id)) out.push(`The formula of '${name(f)}' uses '${name(x)}', which is never shown, so it always counts as 0.`);
      else if (x.readonly && (x.value == null || x.value === '') && !x.formula) out.push(`The formula of '${name(f)}' uses '${name(x)}', which is read only and empty, so it always counts as 0.`);
      else if (x.recipient_id && x.recipient_id !== f.recipient_id && !x.readonly && !SIGNS(theirs)) out.push(`The formula of '${name(f)}' uses '${name(x)}', which belongs to ${who(x.recipient_id)}, who does not fill in fields, so it always counts as 0.`);
      else if (x.recipient_id && x.recipient_id !== f.recipient_id && !x.readonly && !before)
        out.push(`The formula of '${name(f)}' (for ${who(f.recipient_id)}) uses '${name(x)}', which ${who(x.recipient_id)} fills in. Unless ${who(x.recipient_id)} has finished first, it counts as 0 when ${who(f.recipient_id)} signs, and the result ${who(f.recipient_id)} signed does not change afterwards. To use it, have ${who(x.recipient_id)} sign earlier in the order.`);
    }
  }
  return out;
}

/**
 * Deleting a field others depend on, in the editor. A field that was shown only after its answer is now always
 * shown, and a formula that used it counts 0 in its place. Both are said, so the sender knows, and the editor makes
 * it one step that Undo brings back.
 */
export function dropField(list: any[], fid: string, name: (f: any) => string): { list: any[]; said: string[] } {
  const gone = list.find((f) => f.id === fid);
  const said: string[] = [];
  const next = list.filter((f) => f.id !== fid).map((f) => {
    let g = f;
    if (ruleOf(f)?.field === fid) (g = { ...g, show_when: null }), said.push(`${name(f)} depended on it and is now always shown.`);
    if (typeof f.formula === 'string' && f.formula.includes(`{${fid}}`)) (g = { ...g, formula: f.formula.split(`{${fid}}`).join('0') }), said.push(`The formula of ${name(f)} used it and counts 0 in its place now.`);
    return g;
  });
  return { list: next, said: said.length ? [`${name(gone)} was deleted.`, ...said, 'Undo brings it back.'] : [] };
}

/**
 * Two fields whose rules can never both be true at once: they depend on the same field, and one asks for ticked and
 * the other for not ticked, or filled and empty, or two different answers. Only one of them is ever on the page, so
 * they may sit in the same place (stackedFields in src/lib/stacked.ts).
 */
export function neverTogether(a: any, b: any, all?: any[]): boolean {
  const x = ruleOf(a), y = ruleOf(b);
  if (!x || !y || x.field !== y.field) return false;
  const pair = (p: Cond, q: Cond) => (x.is === p && y.is === q) || (x.is === q && y.is === p);
  // A number field is compared as a number, the way the rule itself is (holds in workOut): '1.000' and '1000' are
  // one answer, and so are '5' and '5.0'. Without the field to look at, two values only count as different answers
  // when they differ as words and as numbers.
  const parent = all?.find((f) => f?.id === x.field);
  const nx = readNumber(x.value)?.value, ny = readNumber(y.value)?.value;
  const sameNumber = nx != null && ny != null && nx === ny;
  const same = parent?.type === 'number' ? sameNumber || fold(x.value) === fold(y.value) : fold(x.value) === fold(y.value);
  const differ = parent?.type === 'number' ? !sameNumber : !same && (parent ? true : !sameNumber);
  return pair('checked', 'unchecked') || pair('filled', 'empty') || (x.is === 'equals' && y.is === 'equals' && differ) || (pair('equals', 'not_equals') && same);
}
