// More kinds of field, and how filled-in text looks. Plain data in, plain data out: the editor, the signing page and
// the server (src/server/fieldkinds.ts) all use these, so what a signer sees on the page is what the PDF prints.
//
// 1. First name and last name: taken from the name the sender typed for the person, by a stated rule (the first word,
//    the last word). The signer sees it filled in and can change it. Only that field changes, never their name.
// 2. Drawing: a box the signer draws in freehand. Printed as a picture and listed as a drawing, never as a signature.
// 3. Approve and Decline buttons placed on a page: Approve does what Finish (or Approve) does, Decline opens the
//    decline dialog.
// 4. Same answer as: fields of one person with the same link share one value. Typing in one fills the others.
// 5. Date from another date: a date field worked out from another date field of the same person, or from the date
//    they sign, plus or minus days, weeks or months, on the Gregorian calendar.
// 6. Text style: font, size, colour and bold for what a field prints.
// 7. Saved fields: a field an admin saved under a name, for the whole team's editor.
import { clockIn, validZone } from './dates.ts';

// ---- 1. First and last name -------------------------------------------------------------------------------------

export const NAME_PARTS = ['first_name', 'last_name'] as const;
export const isNamePart = (type: any): boolean => type === 'first_name' || type === 'last_name';
/** How the first or last name is taken from the name the sender typed, said in the editor. */
export const NAME_RULE: Record<string, string> = {
  first_name: 'Filled in with the first word of their name. They can change it.',
  last_name: 'Filled in with the last word of their name. They can change it.',
};
/** Said under the field on the signing page, while it still holds what was taken from their name. */
export const NAME_CHECK: Record<string, string> = { first_name: 'Check your first name', last_name: 'Check your last name' };

/** The first or the last word of a name, by the rule above. "Mary Ann van Dijk" gives "Mary" and "Dijk". */
export function namePart(name: any, type: string): string {
  const words = String(name ?? '').normalize('NFC').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return type === 'last_name' ? words[words.length - 1] : type === 'first_name' ? words[0] : '';
}

// ---- 2 and 3. Drawing, Approve, Decline -------------------------------------------------------------------------

export const DRAWING = 'drawing';
export const isButton = (type: any): boolean => type === 'approve' || type === 'decline';
/** The roles a button on the page can be for: Approve and Decline are for someone who approves or signs. */
export const BUTTON_ROLES = ['signer', 'inperson', 'approver'];
/** The new kinds as the editor and the signing page name them. */
export const KIND_LABEL: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', drawing: 'Drawing', approve: 'Approve button', decline: 'Decline button',
};
/** The words on a button on the page, by its kind and the person's role. */
export const buttonWords = (type: string, role: string): string =>
  type === 'approve' ? (role === 'approver' ? 'Approve' : 'Finish') : role === 'approver' ? 'Decline to approve' : 'Decline to sign';
/** What a drawing is, said on the signing page and in the certificate. */
export const DRAWING_IS = 'A drawing is a picture. It is not your signature.';
/** The largest drawing kept, as a data URL: the same limit as a signature picture. */
export const DRAWING_MAX = 700_000;
export const isDrawingValue = (v: any): boolean => typeof v === 'string' && v.length < DRAWING_MAX && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v);

// ---- 4. Same answer as ------------------------------------------------------------------------------------------

/** The kinds of field that can share one answer with another field of the same kind. */
export const LINKABLE = ['text', 'number', 'date', 'company', 'title', 'first_name', 'last_name', 'checkbox', 'dropdown'];
export const LINK_MAX = 80;
/** A link as stored: trimmed, spaces made one, at most LINK_MAX characters. Empty means none. */
export const linkOf = (f: any): string => (LINKABLE.includes(f?.type) ? String(f?.link ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, LINK_MAX) : '');

/** The other fields that share an answer with `f`: the same person, the same kind and the same link. */
export function linkedTo(f: any, fields: any[]): any[] {
  const k = linkOf(f);
  // A date worked out from another date is the server's, never typed: it shares no answer (saveKinds refuses it).
  if (!k || dateFromOf(f)) return [];
  return fields.filter((g) => g.id !== f.id && g.recipient_id === f.recipient_id && g.type === f.type && linkOf(g) === k && !g.readonly && !dateFromOf(g));
}

/** Values with `v` put in field `id` and in every field linked to it. */
export function spreadLinked(fields: any[], values: Record<string, string>, id: string, v: string): Record<string, string> {
  const f = fields.find((x) => x.id === id);
  const next = { ...values, [id]: v };
  if (f) for (const g of linkedTo(f, fields)) next[g.id] = v;
  return next;
}

/**
 * One value for each group of linked fields, from what was sent: the value that differs from what is stored wins
 * (that is the one the person just typed); when none differs, the first. Returns the values with every member of a
 * group set to it.
 */
export function settleLinked(fields: any[], values: Record<string, any>): Record<string, any> {
  const out = { ...values };
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.id) || !linkOf(f)) continue;
    const group = [f, ...linkedTo(f, fields)];
    group.forEach((g) => seen.add(g.id));
    const sent = group.filter((g) => g.id in values);
    if (!sent.length) continue;
    const changed = sent.find((g) => String(values[g.id] ?? '') !== String(g.value ?? ''));
    const v = values[(changed || sent[0]).id];
    for (const g of group) out[g.id] = v;
  }
  return out;
}

// ---- 5. Date from another date ----------------------------------------------------------------------------------

export const DATE_UNITS = ['days', 'weeks', 'months'] as const;
export type DateUnit = (typeof DATE_UNITS)[number];
/** `from` is the id of a date or date-signed field of the same person. `add` may be below 0: before that date. */
export type DateFrom = { from: string; add: number; unit: DateUnit };
export const DATE_ADD_MAX = 3650;

/** The rule of a field as an object, from the database (JSON text), the editor or an API caller. Null when it has none. */
export function dateFromOf(f: any): DateFrom | null {
  let d: any = f?.date_from;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  // `from` is '' while a draft's date waits for the sender to choose which date it counts from.
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.from == null) return null;
  const add = Number(d.add);
  return { from: String(d.from), add: Number.isInteger(add) ? add : 0, unit: (DATE_UNITS as readonly string[]).includes(d.unit) ? d.unit : 'days' };
}

const ymd = (s: any): [number, number, number] | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
};
const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m counted from 1

/**
 * A day plus or minus days, weeks or months, on the Gregorian calendar. Months keep the day of the month, and when
 * that month is shorter it is the month's last day: 31 January plus 1 month is 28 or 29 February. Empty when `day` is
 * not a real day written year-month-day.
 */
export function addToDay(day: string, add: number, unit: DateUnit): string {
  const p = ymd(day);
  if (!p || !Number.isInteger(add)) return '';
  let [y, m, d] = p;
  if (unit === 'months') {
    const total = y * 12 + (m - 1) + add;
    y = Math.floor(total / 12);
    m = (total % 12 + 12) % 12 + 1;
    d = Math.min(d, daysIn(y, m));
    return y >= 1 && y <= 9999 ? `${y}-${pad(m)}-${pad(d)}` : '';
  }
  const t = new Date(Date.UTC(y, m - 1, d + add * (unit === 'weeks' ? 7 : 1)));
  const yy = t.getUTCFullYear();
  return yy >= 1 && yy <= 9999 ? `${yy}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` : '';
}

/** The calendar day of a moment in a time zone, written year-month-day ('' when there is no moment). UTC without a zone. */
export function dayOf(moment: string | Date | null | undefined, zone?: string | null): string {
  if (!moment) return '';
  const c = clockIn(moment, validZone(zone) || 'UTC');
  return c ? `${c.y}-${pad(c.m + 1)}-${pad(c.d)}` : '';
}

/**
 * What a date-from field comes to. `source` is the field it is worked out from; `signedDay` is the calendar day this
 * person signs on (only known at Finish), for a field worked out from the date of signing.
 */
export function dateFromValue(rule: DateFrom | null, source: any, values: Record<string, any>, signedDay?: string | null): string {
  if (!rule || !source) return '';
  const start = source.type === 'date_signed' ? signedDay || '' : String((source.id in values ? values[source.id] : source.value) ?? '');
  return start ? addToDay(start, rule.add, rule.unit) : '';
}

const unitWord = (n: number, unit: DateUnit) => `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
/** The rule said back, under the field and in the editor: "30 days after Start date". */
export function dateFromWords(rule: DateFrom | null, sourceName: string): string {
  if (!rule) return '';
  if (!rule.add) return `The same day as ${sourceName}`;
  return `${unitWord(Math.abs(rule.add), rule.unit)} ${rule.add > 0 ? 'after' : 'before'} ${sourceName}`;
}
/** Said once, wherever the rule is explained: what the date is, and what it is not. */
export const DATE_FROM_NOTE = 'Counted on the calendar. GrowSigning does not track it or remind anyone of it.';
/** Said in the field until the date it is worked out from is there. */
export const DATE_FROM_WAITS = 'Fills in by itself';

// ---- 6. Text style ----------------------------------------------------------------------------------------------

export const FONTS = [
  { key: 'sans', name: 'Sans', css: '"DejaVu Sans", Verdana, Arial, sans-serif' },
  { key: 'serif', name: 'Serif', css: '"Times New Roman", Times, serif' },
  { key: 'mono', name: 'Typewriter', css: '"Courier New", Courier, monospace' },
] as const;
export const COLORS = [
  { key: 'black', name: 'Black', hex: '#1c2921' },
  { key: 'blue', name: 'Dark blue', hex: '#1f3a8a' },
  { key: 'brand', name: 'Your brand colour', hex: '' },
] as const;
export const SIZE_MIN = 8;
export const SIZE_MAX = 24;
/** The sizes offered, in the editor and in Settings alike. */
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];
export type Look = { font?: 'sans' | 'serif' | 'mono'; size?: number; color?: 'black' | 'blue' | 'brand'; bold?: boolean };
/** The kinds of field whose filled-in text a style changes. */
export const STYLED = ['text', 'number', 'date', 'company', 'title', 'full_name', 'first_name', 'last_name', 'email', 'date_signed', 'dropdown', 'note'];

/** A style as an object, from the database (JSON text) or a caller. Null when it says nothing. */
export function lookOf(raw: any): Look | null {
  let l: any = raw;
  if (typeof l === 'string') {
    try {
      l = JSON.parse(l);
    } catch {
      return null;
    }
  }
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const out: Look = {};
  if (FONTS.some((f) => f.key === l.font)) out.font = l.font;
  if (Number.isFinite(Number(l.size)) && l.size !== null && l.size !== '') out.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(Number(l.size) * 2) / 2));
  if (COLORS.some((c) => c.key === l.color)) out.color = l.color;
  if (l.bold === true) out.bold = true;
  return Object.keys(out).length ? out : null;
}

/** Why a style sent by a caller cannot be used, or ''. */
export function lookProblem(raw: any): string {
  if (raw == null || raw === '') return '';
  let l: any = raw;
  if (typeof l === 'string') {
    try {
      l = JSON.parse(l);
    } catch {
      return 'The text style cannot be read. Send an object like {"font": "serif", "size": 12, "color": "blue", "bold": true}.';
    }
  }
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'The text style must be an object like {"font": "serif", "size": 12}.';
  if (l.font != null && !FONTS.some((f) => f.key === l.font)) return `The font "${String(l.font).slice(0, 30)}" is not one we have. Use ${FONTS.map((f) => `"${f.key}" (${f.name})`).join(', ')}.`;
  if (l.size != null && l.size !== '' && !(Number(l.size) >= SIZE_MIN && Number(l.size) <= SIZE_MAX)) return `The text size must be from ${SIZE_MIN} to ${SIZE_MAX} points.`;
  if (l.color != null && !COLORS.some((c) => c.key === l.color)) return `The colour "${String(l.color).slice(0, 30)}" is not one we have. Use "black", "blue" (dark blue) or "brand" (your brand colour).`;
  if (l.bold != null && typeof l.bold !== 'boolean') return 'Bold is true or false.';
  return '';
}

/** A field's own style over the account's default style. Null when neither says anything. */
export const lookFor = (f: any, accountDefault?: any): Look | null => {
  if (!STYLED.includes(f?.type)) return null;
  const a = lookOf(accountDefault), own = lookOf(f?.look);
  return a || own ? { ...(a || {}), ...(own || {}) } : null;
};

const hexOk = (s: any) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
/** The account's brand colour as #rrggbb, or null when it has none. */
export const brandHex = (brand: any): string | null => (hexOk(brand) ? String(brand) : null);
/** The colours to offer: "Your brand colour" only when the account has one (or the style already uses it). */
export const colorsFor = (brand: any, current?: string | null) => COLORS.filter((c) => c.key !== 'brand' || brandHex(brand) || current === 'brand');
/** The colour as #rrggbb. The brand colour falls back to black when the account has none set. */
export const lookHex = (l: Look | null, brand?: string | null): string =>
  l?.color === 'brand' ? (hexOk(brand) ? String(brand) : COLORS[0].hex) : COLORS.find((c) => c.key === l?.color)?.hex || COLORS[0].hex;

/** The style as CSS for a field on the screen. Sizes are in points of the page, so `scale` is pixels per point. */
export function lookCss(l: Look | null, brand?: string | null, scale?: number): Record<string, string | number> {
  if (!l) return {};
  return {
    ...(l.font ? { fontFamily: FONTS.find((f) => f.key === l.font)!.css } : {}),
    ...(l.size && scale ? { fontSize: `${l.size * scale}px` } : {}),
    ...(l.color ? { color: lookHex(l, brand) } : {}),
    ...(l.bold ? { fontWeight: 700 } : {}),
  };
}

/** The style in a few words, for the editor: "Serif, 12 pt, dark blue, bold". */
export function lookWords(l: Look | null): string {
  if (!l) return 'As usual';
  return [l.font && FONTS.find((f) => f.key === l.font)!.name, l.size && `${l.size} pt`, l.color && COLORS.find((c) => c.key === l.color)!.name.toLowerCase(), l.bold && 'bold'].filter(Boolean).join(', ');
}

// ---- 7. Saved fields --------------------------------------------------------------------------------------------

export const SAVED_MAX = 100;
export const SAVED_NAME_MAX = 60;
/** What a saved field keeps: its kind, label, checks, size and text style. Never a value, a person or a place. */
export const SAVED_KEYS = ['type', 'label', 'required', 'validation', 'options', 'group_name', 'w', 'h', 'look'] as const;
/** The kinds a saved field can be. A note and a strike-out are the sender's own words; a stamp is a picture. */
export const SAVABLE = ['signature', 'initials', 'date_signed', 'full_name', 'first_name', 'last_name', 'email', 'company', 'title', 'text', 'number', 'date', 'checkbox', 'radio', 'dropdown', 'attachment', 'drawing'];
export const savedKey = (name: any): string => String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

// ---- 8. A box they fill in, and your own text ---------------------------------------------------------------------
// Two kinds that were easy to mix up. The stored types keep their names ('text' and 'note'); only what people read
// changed. "Fill in" is a blank the signer types into. "Your text" is the sender's own words, printed on the page.

/** What the editor calls the two kinds, wherever a kind is named. */
export const FILL_IN_NAME = 'Fill in';
export const YOUR_TEXT_NAME = 'Your text';
/** One line under the name at the moment of choosing: who types. Kinds without a line need none. */
export const KIND_HINT: Record<string, string> = {
  text: 'They type here',
  note: 'You type, they read',
  email: 'Their email, filled in for them',
};
/** The longer sentence, said once a kind is picked or selected. */
export const KIND_SAYS: Record<string, string> = {
  text: 'A blank for the signer. They type the answer when they sign.',
  note: 'Your own words, printed on the page. Nobody can type here when signing.',
  email: 'Prints the email address you sent the document to. They type nothing.',
};
/** What the signer reads in an empty box to type into when the sender gave it no label. */
export const TYPE_HERE = 'Type here';
/** What a "Your text" box says in the editor only, while it is still empty. Never sent, never printed. */
export const YOUR_TEXT_EMPTY = 'Type your text';
/** The word older drafts put into a new box before anything was typed. It was never the sender's wording. */
export const OLD_NOTE_WORD = 'Note';

/** The words of a "Your text" box, or '' when it holds none. Spaces and line breaks alone are not words. */
export const noteWords = (f: any): string => (f?.type === 'note' ? String(f.value ?? '').trim() : '');
/** A "Your text" box with nothing in it. It is not shown to anyone who signs and is not printed. */
export const isEmptyNote = (f: any): boolean => f?.type === 'note' && !noteWords(f);
/** A box that still holds only the word an older draft started it with. */
export const isLeftoverNote = (f: any): boolean => f?.type === 'note' && noteWords(f) === OLD_NOTE_WORD;
/** The boxes to bring up before sending: empty ones, and ones that still say only "Note". */
export const unwrittenNotes = <F extends { type: string; value?: any }>(fields: F[]): F[] => fields.filter((f) => isEmptyNote(f) || isLeftoverNote(f));
/** What a "Your text" box is saved with: its words as typed, or nothing at all when there are none. */
export const noteValue = (value: any): string | null => (String(value ?? '').trim() ? String(value) : null);
/** What is on a "Fill in" box in the editor: its label, or who types there. */
export const fillInTag = (f: any, person?: string | null): string => String(f?.label || '').trim() || (person ? `${person} types here` : FILL_IN_NAME);
