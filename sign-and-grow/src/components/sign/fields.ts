// What a signer's fields mean, shared by the document view, the text view and the phone sheet.

export const AUTO = ['date_signed', 'full_name', 'email'];
/** Fields that are typed into. On a phone these open a sheet with a large input. */
export const TYPED = ['text', 'number', 'date', 'company', 'title'];

export const LABEL: Record<string, string> = {
  signature: 'Signature', initials: 'Initials', text: 'Text', number: 'Number', date: 'Date', company: 'Company', title: 'Job title',
  dropdown: 'Choice', attachment: 'Attachment', checkbox: 'Checkbox', radio: 'Option', date_signed: 'Date signed', full_name: 'Full name', email: 'Email', note: 'Note',
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
    if (f.readonly || AUTO.includes(f.type)) continue;
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
const RULES: Record<string, RegExp> = { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, number: /^-?\d+([.,]\d+)?$/, phone: /^[+()\d][\d\s().-]{5,}$/ };
export function problemWith(f: any, value: string): string {
  if (!value || isSig(f) || isBox(f) || f.type === 'dropdown' || f.type === 'attachment') return '';
  const rule = f.type === 'number' ? 'number' : f.validation;
  if (!rule) return '';
  let re: RegExp | null = RULES[rule] || null;
  if (!re) {
    try {
      re = new RegExp(`^(?:${rule})$`);
    } catch {
      return '';
    }
  }
  if (re.test(value)) return '';
  if (rule === 'number') return 'Use digits only, like 2500 or 12.5.';
  if (rule === 'email') return 'Enter an email address, like name@example.org.';
  if (rule === 'phone') return 'Enter a phone number with its area code.';
  return 'This is not in the format the sender asked for. Check it and try again.';
}

export const pos = (f: any) => ({ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });

// The signature a person adopts is only sent when they finish. Keeping it for the life of the tab means a
// reload or a dropped connection does not make them draw it again.
const keptKey = (token: string) => `sg:sign:${token}`;
export function readKept(token: string): { sig: string | null; ini: string | null } {
  try {
    const k = JSON.parse(sessionStorage.getItem(keptKey(token)) || '{}');
    const ok = (s: any) => (typeof s === 'string' && s.startsWith('data:image/') ? s : null);
    return { sig: ok(k.sig), ini: ok(k.ini) };
  } catch {
    return { sig: null, ini: null };
  }
}
export function writeKept(token: string, sig: string | null, ini: string | null) {
  try {
    if (sig || ini) sessionStorage.setItem(keptKey(token), JSON.stringify({ sig, ini }));
    else sessionStorage.removeItem(keptKey(token));
  } catch {
    /* Private mode or a full store: the signature simply is not kept across a reload. */
  }
}

// ---- Rules of the signing screen that are plain decisions, kept here so they can be tested without a browser ----

/** The browser tab says which document this is, so it can be found again among other tabs. */
export const pageTitle = (subject?: string | null): string => (subject && subject.trim() ? `${subject.trim()} · Sign&Grow` : 'Sign&Grow');

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
 */
export function placeFlag(field: Box, flag: { w: number; h: number }, gap: { x: number; y: number }, taken: Box[]): FlagSide {
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
