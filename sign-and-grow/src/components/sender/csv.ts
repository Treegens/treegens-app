// Reads a pasted or uploaded recipient list for bulk send. Built to forgive the ways real spreadsheets differ:
// any delimiter, columns in any order when there is a header row, any letter case, and a leading byte order mark.
// No React in here, so it can be tested on its own.
import { looksLikeEmail } from './lib.ts';
import { normalPhone } from '../../lib/checks.ts';

// `phone` is true for a role the template checks with a code by text message, or texts the signing link to: every
// row then needs that person's mobile number, in a column of its own.
export type Role = { key: string; label: string; phone?: boolean };
export type Cell = { name: string; email: string; phone?: string };
export type BulkRow = { row: number; cells: Record<string, Cell>; problems: string[]; notes: string[] };
export type Reading = {
  rows: BulkRow[];
  /** A header row was found and the columns were matched by their names. */
  header: boolean;
  /** Header columns that were not needed, by their original names. */
  ignored: string[];
  /** Columns we need and could not find in the header, like "Volunteer email". */
  missing: string[];
  /** Without a header: name and email were the other way round, and we swapped them back. */
  swapped: boolean;
};

export const MAX_ROWS = 500;

function delimiterOf(text: string): string {
  // Decide from the first line, outside quotes. Tabs win (that is what pasting from a spreadsheet gives).
  let quoted = false;
  const count: Record<string, number> = { '\t': 0, ',': 0, ';': 0 };
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in count) count[c]++;
  }
  if (count['\t']) return '\t';
  return count[';'] > count[','] ? ';' : ',';
}

/** Small CSV reader: quoted cells, doubled quotes, and new lines inside quotes. Empty rows are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    row = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell.trim()) quoted = true;
    else if (c === delimiter) (row.push(cell.trim()), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  endRow();
  return rows;
}

// "Volunteer E-mail" and "volunteer_email" are the same column.
const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

const NAME_WORDS = ['name', 'fullname'];
const EMAIL_WORDS = ['email', 'emailaddress', 'mail', 'mailaddress'];
const PHONE_WORDS = ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobilephone', 'cell', 'cellphone', 'telephone', 'tel'];

function findColumn(header: string[], role: string, words: string[], alone: boolean): number {
  const wanted = new Set<string>();
  for (const w of words) {
    wanted.add(role + w);
    wanted.add(w + role);
    wanted.add(`${w}of${role}`);
    // With a single open role, plain "Name" and "Email" are clear enough.
    if (alone) (wanted.add(w), wanted.add(`recipient${w}`), wanted.add(`signer${w}`));
  }
  return header.findIndex((h) => wanted.has(h));
}

/** Turns the text into one row per envelope, matched to the template's open roles, with anything wrong spelled out. */
export function readRecipients(text: string, roles: Role[]): Reading {
  const table = parseCsv(text);
  const out: Reading = { rows: [], header: false, ignored: [], missing: [], swapped: false };
  if (!table.length || !roles.length) return out;

  const first = table[0];
  const firstNorm = first.map(norm);
  // A header has column names in it and no email addresses.
  const header = !first.some((c) => c.includes('@')) && firstNorm.some((h) => h.includes('name') || h.includes('mail'));
  out.header = header;
  const body = header ? table.slice(1) : table;
  const alone = roles.length === 1;

  type Cols = { name: number; first: number; last: number; email: number; phone: number };
  const cols: Record<string, Cols> = {};
  if (header) {
    const used = new Set<number>();
    for (const r of roles) {
      const rn = norm(r.label);
      const c: Cols = {
        name: findColumn(firstNorm, rn, NAME_WORDS, alone),
        first: findColumn(firstNorm, rn, ['firstname', 'givenname'], alone),
        last: findColumn(firstNorm, rn, ['lastname', 'surname', 'familyname'], alone),
        email: findColumn(firstNorm, rn, EMAIL_WORDS, alone),
        // Only read where the template texts this role. Otherwise a phone column is one more we do not need, and
        // nobody's number is taken along for nothing.
        phone: r.phone ? findColumn(firstNorm, rn, PHONE_WORDS, alone) : -1,
      };
      // A column named just after the role ("Volunteer") holds the name.
      if (c.name < 0 && c.first < 0) c.name = firstNorm.indexOf(rn);
      if (c.name < 0 && c.first < 0) out.missing.push(`${r.label} name`);
      if (c.email < 0) out.missing.push(`${r.label} email`);
      if (r.phone && c.phone < 0) out.missing.push(`${r.label} phone`);
      for (const i of [c.name, c.first, c.last, c.email, c.phone]) if (i >= 0) used.add(i);
      cols[r.key] = c;
    }
    out.ignored = first.filter((h, i) => h && !used.has(i));
  } else {
    // Without a header the columns come in the order we suggest: name, email, and a phone where the role needs one.
    let next = 0;
    roles.forEach((r) => {
      let name = next;
      let email = next + 1;
      const phone = r.phone ? next + 2 : -1;
      next += r.phone ? 3 : 2;
      // No header to go by: if the "name" column is full of email addresses and the other is not, they are swapped.
      const at = (col: number) => body.filter((cells) => (cells[col] || '').includes('@')).length;
      if (at(name) > at(email)) ([name, email] = [email, name]), (out.swapped = true);
      cols[r.key] = { name, first: -1, last: -1, email, phone };
    });
  }

  const seen = new Map<string, number>();
  body.forEach((cells, i) => {
    const row: BulkRow = { row: i + (header ? 2 : 1), cells: {}, problems: [], notes: [] };
    for (const r of roles) {
      const c = cols[r.key];
      const get = (col: number) => (col >= 0 ? cells[col] || '' : '');
      const name = (get(c.name) || [get(c.first), get(c.last)].filter(Boolean).join(' ')).trim();
      const email = get(c.email).trim();
      const phone = get(c.phone).trim();
      // The number is sent on as typed when it is a full international one, and said to be wrong here when it is not.
      row.cells[r.key] = { name, email, ...(phone ? { phone: normalPhone(phone) || phone } : {}) };
      const who = alone ? '' : `${r.label}: `;
      if (r.phone && !phone) row.problems.push(`${who}mobile number is missing`);
      else if (phone && !normalPhone(phone)) row.problems.push(`${who}"${phone}" is not a full mobile number. Write it with the country code, like +44 7700 900123`);
      if (!name && !email) row.problems.push(`${who}name and email are missing`);
      else if (!name) row.problems.push(`${who}name is missing`);
      else if (!email) row.problems.push(`${who}email is missing`);
      else if (!looksLikeEmail(email)) row.problems.push(`${who}"${email}" is not a full email address`);
      else {
        const k = `${r.key}\u0000${email.toLowerCase()}`;
        if (seen.has(k)) row.notes.push(`same email as row ${seen.get(k)}, so ${name} gets two envelopes`);
        else seen.set(k, row.row);
      }
    }
    out.rows.push(row);
  });
  return out;
}

/** The header line we suggest, and the example under it. */
export const headerFor = (roles: Role[]) => roles.flatMap((r) => [`${r.label} name`, `${r.label} email`, ...(r.phone ? [`${r.label} phone`] : [])]).join(',');
