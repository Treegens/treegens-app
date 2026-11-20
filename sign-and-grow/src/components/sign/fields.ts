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
