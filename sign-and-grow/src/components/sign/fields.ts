// What a signer's fields mean, shared by the document view, the text view and the phone sheet.
import { NUMBER_RULE, NUMBER_PROBLEM } from '../../lib/numbers.ts';
import { isDateValue, DATE_PROBLEM } from '../../lib/dates.ts';
import { valueProblem, fieldChecks, currencySign, patternProblem, limitOf, groupProblem, groupRuleOf } from '../../lib/fieldrules.ts';

export const AUTO = ['date_signed', 'full_name', 'email'];
/** Fields that are typed into. On a phone these open a sheet with a large input. */
export const TYPED = ['text', 'number', 'date', 'company', 'title', 'first_name', 'last_name'];

export const LABEL: Record<string, string> = {
  signature: 'Signature', initials: 'Initials', text: 'Text', number: 'Number', date: 'Date', company: 'Company', title: 'Job title',
  dropdown: 'Choice', attachment: 'Attachment', checkbox: 'Checkbox', radio: 'Option', date_signed: 'Date signed', full_name: 'Full name', email: 'Email', note: 'Note', stamp: 'Stamp',
  first_name: 'First name', last_name: 'Last name', drawing: 'Drawing', approve: 'Approve', decline: 'Decline',
};
export const fieldName = (f: any): string => f.label || LABEL[f.type] || 'Field';
export const groupKey = (f: any): string => f.group_name || f.id;
export const isSig = (f: any) => f.type === 'signature' || f.type === 'initials';
export const isBox = (f: any) => f.type === 'checkbox' || f.type === 'radio';
/** Tall text fields are printed on several lines, so they get a bigger box to type in. */
export const isMulti = (f: any) => f.type === 'text' && f.h >= 0.04;

export type Item = { key: string; first: any; fields: any[]; required: boolean; done: boolean };

// One thing the signer has to deal with. A group of radio buttons is one thing, not several.
export function buildItems(ordered: any[], filled: (f: any) => boolean): Item[] {
  const out: Item[] = [];
  const groups = new Map<string, Item>();
  for (const f of ordered) {
    // A button on the page and a date worked out from another are nothing to fill in (src/lib/fieldkinds.ts).
    if (f.readonly || AUTO.includes(f.type) || f.type === 'approve' || f.type === 'decline' || f.date_from) continue;
    if (f.type === 'radio') {
      const key = `g:${groupKey(f)}`;
      let it = groups.get(key);
      if (!it) {
        it = { key, first: f, fields: [], required: false, done: false };
        groups.set(key, it);
        out.push(it);
      }
      it.fields.push(f);
      it.required ||= !!f.required;
      it.done ||= filled(f);
    } else out.push({ key: f.id, first: f, fields: [f], required: !!f.required, done: filled(f) });
  }
  return out;
}

// The same checks the server makes when finishing, so a mistake is caught while the person is still at the field.
// The number rule is the server's own (src/lib/numbers.ts): numbers as people write them anywhere, not only in the US.
// Formats, limits and ranges the sender set are the shared rules of src/lib/fieldrules.ts. `dateFormat` is the
// envelope's, for a text field that takes a date.
const RULES: Record<string, RegExp> = { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, number: NUMBER_RULE, phone: /^[+()\d][\d\s().-]{5,}$/ };
export function problemWith(f: any, value: string, dateFormat?: string | null): string {
  if (!value || isSig(f) || isBox(f) || f.type === 'dropdown' || f.type === 'attachment') return '';
  // The same rule the server holds a date to at Finish (isDateValue in src/lib/dates.ts).
  if (f.type === 'date') return isDateValue(value) ? '' : DATE_PROBLEM;
  // Checks set in the editor's Format and limits (an object, or one kept as JSON).
  if ((f.validation && typeof f.validation === 'object') || String(f.validation || '').trim().startsWith('{')) return valueProblem(f, value, dateFormat);
  const rule = f.type === 'number' ? 'number' : typeof f.validation === 'string' ? f.validation : '';
  if (!rule) return '';
  let re: RegExp | null = RULES[rule] || null;
  if (!re) {
    // A pattern that could keep the browser busy is not run (patternProblem); the server does not run it either.
    if (patternProblem(rule)) return '';
    try {
      re = new RegExp(`^(?:${rule})$`);
    } catch {
      return '';
    }
  }
  if (re.test(value)) return '';
  if (rule === 'number') return NUMBER_PROBLEM;
  if (rule === 'email') return 'Enter an email address, like name@example.org.';
  if (rule === 'phone') return 'Enter a phone number with its area code.';
  return 'This is not in the format the sender asked for. Check it and try again.';
}

/**
 * What a number field the sender set a currency or a range for says before anything is wrong: "An amount in EUR
 * (€), from 0 to 1,000, with at most 2 decimal places." Empty for a number field with none of those.
 */
export function amountHint(f: any): string {
  if (f?.type !== 'number') return '';
  const c = fieldChecks(f);
  const parts: string[] = [];
  const n = (x: number) => x.toLocaleString('en', { maximumFractionDigits: 10 });
  if (c.min != null && c.max != null) parts.push(`from ${n(c.min)} to ${n(c.max)}`);
  else if (c.min != null) parts.push(`${n(c.min)} or more`);
  else if (c.max != null) parts.push(`${n(c.max)} or less`);
  if (c.decimals != null) parts.push(c.decimals ? `with at most ${c.decimals} decimal place${c.decimals === 1 ? '' : 's'}` : 'a whole number');
  if (!c.currency && !parts.length) return '';
  const sign = c.currency ? currencySign(c.currency) : '';
  return `${c.currency ? `An amount in ${c.currency}${sign && sign !== c.currency ? ` (${sign})` : ''}` : 'A number'}${parts.length ? `, ${parts.join(', ')}` : ''}.${c.currency ? ' Type only the number.' : ''}`;
}

/**
 * For a field with a character limit, how much of it is used, so typing that stops is never a mystery: "12 of 40
 * characters." Shown always for a limit the sender set (a character limit, a box of fixed size); for the quiet limit of
 * a field with a pattern only once the person is within 20 characters of it.
 */
export function lengthHint(f: any, value: string): string {
  const limit = limitOf(f);
  if (limit == null) return '';
  const c = fieldChecks(f);
  const used = [...String(value || '')].length;
  if (!c.max_length && !c.fixed && used < limit - 20) return '';
  return used >= limit ? `${used} of ${limit} characters. That is all this field takes. If you pasted something longer, check what was kept.` : `${used} of ${limit} characters.`;
}

/**
 * The rule of the tick-box group `f` belongs to, said where the box is, or ''. `short` is for the pointer on the page
 * ("Tick at least 2"); otherwise the group's name and the rule ("Drinks: tick at least 2 boxes of these.").
 */
export function boxRuleHint(f: any, fields: any[], short = false): string {
  if (f?.type !== 'checkbox' || !f.group_name) return '';
  const r = groupRuleOf(fields.filter((g) => g.type === 'checkbox' && g.group_name === f.group_name));
  if (!r) return '';
  if (short) return `Tick ${r.rule === 'at_least' ? 'at least' : r.rule === 'at_most' ? 'at most' : 'exactly'} ${r.count}`;
  return `${f.group_name}: ${r.message[0].toLowerCase()}${r.message.slice(1)}`;
}

/** The most characters a field takes, for the input's own limit, or undefined for none. */
export const inputLimit = (f: any): number | undefined => limitOf(f) ?? undefined;

/**
 * What stops Finish: the first field whose answer needs another look, or the first group of tick boxes whose rule is
 * not met, with what to say. Null when nothing does.
 */
export function finishProblem(ordered: any[], values: Record<string, string>, dateFormat?: string | null): { field: any; text: string } | null {
  const wrong = ordered.find((f) => problemWith(f, values[f.id] || '', dateFormat));
  if (wrong) return { field: wrong, text: problemWith(wrong, values[wrong.id] || '', dateFormat) };
  const g = groupProblem(ordered, values);
  return g ? { field: g.field, text: g.text } : null;
}

export const pos = (f: any) => ({ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });

// The signature a person adopts is only sent when they finish. Keeping it for the life of the tab means a
// reload or a dropped connection does not make them draw it again.
// It is kept under the name it was made for (`who`). A signature belongs to the person who made it: when the sender
// has put another name on the request since, the tab's copy is not given back, and only what the server still holds
// for the request counts (it clears that too when the new name is another person). `store` is the tab's own
// storage, and a parameter only so this can be tested without a browser.
type KeptStore = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const keptKey = (token: string) => `sg:sign:${token}`;
export function readKept(token: string, who?: string | null, store?: KeptStore): { sig: string | null; ini: string | null } {
  try {
    const k = JSON.parse((store || sessionStorage).getItem(keptKey(token)) || '{}');
    const ok = (s: any) => (typeof s === 'string' && s.startsWith('data:image/') ? s : null);
    if (who != null && k.who !== who) return { sig: null, ini: null };
    return { sig: ok(k.sig), ini: ok(k.ini) };
  } catch {
    return { sig: null, ini: null };
  }
}
export function writeKept(token: string, sig: string | null, ini: string | null, who?: string | null, store?: KeptStore) {
  try {
    if (sig || ini) (store || sessionStorage).setItem(keptKey(token), JSON.stringify({ sig, ini, who: who ?? null }));
    else (store || sessionStorage).removeItem(keptKey(token));
  } catch {
    /* Private mode or a full store: the signature simply is not kept across a reload. */
  }
}

// ---- Rules of the signing screen that are plain decisions, kept here so they can be tested without a browser ----

/** The browser tab says which document this is, so it can be found again among other tabs. */
export const pageTitle = (subject?: string | null): string => (subject && subject.trim() ? `${subject.trim()} · GrowSigning` : 'GrowSigning');

/**
 * Keeps the tab named after the document for as long as the screen shows it. Setting the title once is not enough:
 * whenever the framework renders the head of the page again it writes the site's own title back, and the tab would
 * lose the document's name. So the head is watched, and the name is put back when something else changed it.
 * Returns how to stop. `doc` and `Watch` are the page's own document and MutationObserver, and parameters only so
 * this can be tested without a browser.
 */
export function keepTitle(subject: string | null | undefined, doc?: { title: string; head: any }, Watch?: new (fn: () => void) => { observe(target: any, o: any): void; disconnect(): void }): () => void {
  if (!subject || !subject.trim()) return () => {};
  const d = doc || document;
  const want = pageTitle(subject);
  const set = () => {
    if (d.title !== want) d.title = want;
  };
  set();
  const watch = new (Watch || MutationObserver)(set);
  watch.observe(d.head, { childList: true, subtree: true, characterData: true });
  return () => watch.disconnect();
}

/** Names are compared the way a person reads them: case, accents and extra spaces make no difference. */
export function sameName(a: any, b: any): boolean {
  const n = (s: any) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return !!n(a) && n(a) === n(b);
}

export type Marks = { signature: string | null; initials: string | null };

/**
 * The signature saved on a signed-in person's own account may be offered to a signer only when that account is
 * plainly theirs: the same email address and the same name. The address alone is not enough, because two people can
 * share one (a couple, an office inbox). Never in person: that device belongs to the host.
 */
export function accountMarks(user: any, recipient: any): Marks {
  const theirs = !!user && !!recipient && recipient.role !== 'inperson'
    && !!user.email && String(user.email).toLowerCase() === String(recipient.email || '').toLowerCase() && sameName(user.name, recipient.name);
  return { signature: (theirs && user.signature_png) || null, initials: (theirs && user.initials_png) || null };
}

/**
 * What a tap on an empty signature or initials field does. A mark made or confirmed in this tab goes straight onto
 * the page. A stored one (saved with this document on another device, or kept on the person's account) is never put
 * on a page without being shown first: the adopt dialog opens with it as a choice the person has to confirm.
 */
export function tapOnMark(o: { current: string | null; seen: boolean; account: string | null }): { apply: boolean; offer: { image: string; from: 'document' | 'account' } | null } {
  if (o.current && o.seen) return { apply: true, offer: null };
  if (o.current) return { apply: false, offer: { image: o.current, from: 'document' } };
  return { apply: false, offer: o.account ? { image: o.account, from: 'account' } : null };
}

/**
 * What the signing screen starts from when it loads. `here` is the signature and initials made or confirmed in this
 * tab. Without them, the ones saved with the document (on another device, or in another tab) are used, so fields
 * that were signed there stay signed. A field saved as signed with no signature to show for it is emptied on this
 * screen only: `baseline` is what counts as already saved, so merely opening the document never saves anything
 * back and never wipes a mark that was made elsewhere.
 */
export function restoreMarks(fields: any[], recipient: any, here: { sig: string | null; ini: string | null }) {
  const values: Record<string, string> = Object.fromEntries(fields.map((f) => [f.id, f.value || '']));
  const sig: string | null = here.sig || recipient?.signature_png || null;
  const ini: string | null = here.ini || recipient?.initials_png || null;
  for (const f of fields) if ((f.type === 'signature' && !sig) || (f.type === 'initials' && !ini)) values[f.id] = '';
  return { values, sig, ini, seen: { signature: !!here.sig, initials: !!here.ini }, baseline: JSON.stringify(values), saved: { sig: recipient?.signature_png || null, ini: recipient?.initials_png || null } };
}

/**
 * The body of an autosave ("Finish later"). The adopted signature and initials travel with the answers, so another
 * device or tab gets them back. They are large, so each is only sent when it differs from what the server has.
 */
export function saveBody(values: Record<string, string>, version: number | null, marks: { sig: string | null; ini: string | null }, saved: { sig: string | null; ini: string | null }) {
  return {
    values, version,
    ...(marks.sig && marks.sig !== saved.sig ? { signature_png: marks.sig } : {}),
    ...(marks.ini && marks.ini !== saved.ini ? { initials_png: marks.ini } : {}),
  };
}

/**
 * Where the signing screen loads the pages of a document from. The address carries the fingerprint of the file, so
 * a file the sender replaced has a new address, and the pages are fetched and drawn again instead of staying as they
 * were while only the fields around them change.
 */
export const docUrl = (base: string, d: { id: string; sha256?: string | null }): string => `/api${base}/doc/${d.id}${d.sha256 ? `?v=${d.sha256}` : ''}`;

/**
 * Finish only works while the file of every document, as it is on the envelope now, is the one on the screen.
 * `onScreen` holds, for each document, the fingerprint of the file whose pages have been drawn (or read out, in the
 * text view). After the sender replaces a file this is false until the new pages are there, so nobody can finish on
 * pages they were not shown.
 */
export const allOnScreen = (documents: { id: string; sha256?: string | null }[] | undefined | null, onScreen: Record<string, string>): boolean =>
  !!documents && documents.every((d) => onScreen[d.id] === (d.sha256 || ''));

export type Box = { x: number; y: number; w: number; h: number };
export type FlagSide = 'above' | 'below' | 'right' | 'left';
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Where the "Sign here" pointer goes: above the field, below it, to its right or to its left. The first of those
 * that stays on the page and covers nothing wins, where `taken` is everything it must not sit on: the printed lines
 * of the page and the other fields. When every side covers something, the one that covers least is used. All
 * numbers are fractions of the page; `flag` is the pointer's own size and `gap` the space between it and the field.
 * `margin` is the room kept clear around everything in `taken`: a pointer that stands right beside a printed label,
 * on the same line, reads as that label's answer ("Date: Sign here"), so that counts as covering it too.
 */
export function placeFlag(field: Box, flag: { w: number; h: number }, gap: { x: number; y: number }, taken: Box[], margin: { x: number; y: number } = { x: 0, y: 0 }): FlagSide {
  if (margin.x || margin.y) taken = taken.map((t) => ({ x: t.x - margin.x, y: t.y - margin.y, w: t.w + 2 * margin.x, h: t.h + 2 * margin.y }));
  const x = Math.max(0, Math.min(field.x, 1 - flag.w));
  const mid = field.y + field.h / 2 - flag.h / 2;
  const spots: [FlagSide, Box][] = [
    ['above', { x, y: field.y - gap.y - flag.h, ...flag }],
    ['below', { x, y: field.y + field.h + gap.y, ...flag }],
    ['right', { x: field.x + field.w + gap.x, y: mid, ...flag }],
    ['left', { x: field.x - gap.x - flag.w, y: mid, ...flag }],
  ];
  let best: FlagSide = 'above', least = Infinity;
  for (const [side, b] of spots) {
    if (b.x < 0 || b.y < 0 || b.x + b.w > 1 || b.y + b.h > 1) continue;
    const covered = taken.reduce((n, t) => n + overlap(b, t), 0);
    if (covered < least) [best, least] = [side, covered];
  }
  // Nothing fits on the page at all (a field that fills it): below is the old fallback for a field at the very top.
  return least === Infinity ? (field.y < 0.07 ? 'below' : 'above') : best;
}
