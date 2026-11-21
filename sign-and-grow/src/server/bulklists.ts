import { all, get, run, tx } from './db.ts';
import { bad, id, now, str } from './util.ts';
import type { Ctx } from './router.ts';
import type { ZipEntry } from './zip.ts';
import { LIST_DAYS_DEFAULT, LIST_DAYS_MIN, LIST_DAYS_MAX, LIST_MAX_ROWS, LIST_MAX_BYTES, LIST_NAME_MAX, LISTS_PER_ACCOUNT, countListLines } from '../lib/reports.ts';

// Saved lists for Send to many: a list of people someone pasted or uploaded, kept under a name so the team can send
// to it again. The list is kept as it was typed (bulk_lists.csv), and the Send to many page reads it again against
// the template chosen, with the same check as a list pasted that moment (components/sender/csv.ts, POST /bulk/check).
// Everyone in the account can see and use every list; the person who saved it and the admins can delete it. A
// list nobody opened for the account's number of days (accounts.list_days, default 180) is deleted by the timer. Lists go with
// the account, and are in its export (GET /export, lists/).

export const listDays = (a: any): number => Number(a?.list_days) || LIST_DAYS_DEFAULT;
const deletesAt = (l: any, days: number) => new Date(Date.parse(l.used_at || l.created_at) + days * 86400_000).toISOString();
const view = (l: any, c: Pick<Ctx, 'admin' | 'user'>, days: number) => ({
  id: l.id, name: l.name, rows: l.rows, created_by: l.created_by_name, created_at: l.created_at, used_at: l.used_at, deletes_at: deletesAt(l, days),
  may_delete: !!c.admin || l.created_by === c.user.id,
});

export function listLists(c: Pick<Ctx, 'admin' | 'user' | 'account'>) {
  const days = listDays(c.account);
  return all('SELECT id, name, rows, created_by, created_by_name, created_at, used_at FROM bulk_lists WHERE account_id=? ORDER BY name COLLATE NOCASE', c.account.id).map((l) => view(l, c, days));
}

/** Saves a list under a name. How many people it holds is counted here; a `rows` the caller sends is not used. */
export function saveList(c: Pick<Ctx, 'admin' | 'user' | 'account'>, b: any) {
  // Direction marks and other invisible controls are dropped, so a name cannot show itself reordered to the team.
  const name = str(b?.name, 500).replace(/[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().replace(/\s+/g, ' ');
  if (!name) throw bad('Give the list a name, such as "Volunteers 2026". Nothing was saved.');
  if (name.length > LIST_NAME_MAX) throw bad(`The name of a list can be up to ${LIST_NAME_MAX} characters long, and this one has ${name.length}. Shorten it and save again. Nothing was saved.`);
  if (typeof b?.csv !== 'string' || !b.csv.trim()) throw bad('The list is empty. Paste or upload the list first, then save it. Nothing was saved.');
  const text: string = b.csv;
  if (Buffer.byteLength(text) > LIST_MAX_BYTES) throw bad(`That list is larger than ${LIST_MAX_BYTES / 1_000_000} MB. Keep only the columns Send to many needs, and save it again. Nothing was saved.`);
  if (text.includes('\u0000')) throw bad('That is not a text list. In your spreadsheet, choose Save as CSV, then paste or upload that file. Nothing was saved.');
  const lines = countListLines(text);
  if (lines > LIST_MAX_ROWS + 1) throw bad(`That list has ${lines} lines. A list can hold up to ${LIST_MAX_ROWS} people, as many as one batch takes. Split it into two lists. Nothing was saved.`);
  // How many people: every line with something in it, less a header row. A first line without an email address in
  // it is a header (a row of a person always has one). Counted here, so a list never claims more than it holds.
  const first = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => /[^\s,;]/.test(l)) || '';
  const rows = /@/.test(first) ? lines : lines - 1;
  if (rows < 1) throw bad('That list has a header row but nobody under it. Add one row per person, then save it. Nothing was saved.');
  return tx(() => {
    if (get('SELECT 1 x FROM bulk_lists WHERE account_id=? AND name=? COLLATE NOCASE', c.account.id, name))
      throw bad(`There is already a list called "${name}". Give this one another name, or delete that one first. Nothing was saved.`, 409);
    if (get('SELECT COUNT(*) n FROM bulk_lists WHERE account_id=?', c.account.id).n >= LISTS_PER_ACCOUNT)
      throw bad(`An account can keep up to ${LISTS_PER_ACCOUNT} lists, and this one has that many. Delete one you no longer use in Contacts, then save this one. Nothing was saved.`);
    const lid = id('lst');
    run('INSERT INTO bulk_lists (id, account_id, name, csv, rows, created_by, created_by_name, created_at) VALUES (?,?,?,?,?,?,?,?)', lid, c.account.id, name, text, rows, c.user.id, c.user.name || c.user.email, now());
    return view(get('SELECT * FROM bulk_lists WHERE id=?', lid), c, listDays(c.account));
  });
}

/** One list with what it holds, to use in Send to many. Opening it counts as using it, so it is kept for another period. */
export function openList(c: Pick<Ctx, 'admin' | 'user' | 'account'>, listId: string) {
  const l = get('SELECT * FROM bulk_lists WHERE id=? AND account_id=?', listId, c.account.id);
  if (!l) throw bad('We could not find that list. It may have been deleted, by someone on your team or because nobody used it for a long time.', 404);
  l.used_at = now();
  run('UPDATE bulk_lists SET used_at=? WHERE id=?', l.used_at, l.id);
  return { ...view(l, c, listDays(c.account)), csv: l.csv };
}

export function deleteList(c: Pick<Ctx, 'admin' | 'user' | 'account'>, listId: string) {
  const l = get('SELECT created_by FROM bulk_lists WHERE id=? AND account_id=?', listId, c.account.id);
  if (!l) throw bad('That list is not there any more. Nothing was deleted.', 404);
  if (!c.admin && l.created_by !== c.user.id) throw bad('Only the person who saved this list, or an admin, can delete it. Nothing was deleted.', 403);
  run('DELETE FROM bulk_lists WHERE id=?', listId);
}

/** How many of the account's lists nobody used for `days` days: the ones the next check would delete. */
export function listsOlderThan(accountId: string, days: number, at = new Date()): number {
  return get('SELECT COUNT(*) n FROM bulk_lists WHERE account_id=? AND COALESCE(used_at, created_at) < ?', accountId, new Date(at.getTime() - days * 86400_000).toISOString()).n;
}

/**
 * The account's number of days (admins). A smaller number that would delete lists at the next check is refused
 * (409, with how many) unless the request says `confirm: true`, so nobody loses lists without being told first.
 */
export function setListDays(accountId: string, b: any): { days: number; deleting: number } {
  const days = Number(b?.days);
  if (!Number.isInteger(days) || days < LIST_DAYS_MIN || days > LIST_DAYS_MAX) throw bad(`Choose a whole number of days from ${LIST_DAYS_MIN} to ${LIST_DAYS_MAX}. Nothing was changed.`);
  const deleting = listsOlderThan(accountId, days);
  if (deleting && b?.confirm !== true) {
    throw bad(`${deleting === 1 ? '1 saved list was' : `${deleting} saved lists were`} not used in the last ${days} days, so ${deleting === 1 ? 'it' : 'they'} would be deleted at the next check. Choose a larger number to keep ${deleting === 1 ? 'it' : 'them'}, or confirm. Nothing was changed.`, 409, { code: 'lists_would_be_deleted', deleting });
  }
  run('UPDATE accounts SET list_days=? WHERE id=?', days === LIST_DAYS_DEFAULT ? null : days, accountId);
  return { days, deleting };
}

/** The timer (cron.ts): deletes every list nobody used for its account's number of days. Answers how many went. */
export function purgeOldLists(at = new Date()): number {
  let n = 0;
  for (const a of all('SELECT DISTINCT a.id, a.list_days FROM accounts a JOIN bulk_lists l ON l.account_id=a.id')) {
    const cut = new Date(at.getTime() - listDays(a) * 86400_000).toISOString();
    n += Number(run('DELETE FROM bulk_lists WHERE account_id=? AND COALESCE(used_at, created_at) < ?', a.id, cut).changes);
  }
  return n;
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N} ._-]+/gu, '_').slice(0, 80) || 'list';
const cell = (v: any) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
/** For the export: each list as it was saved, and lists/index.csv with who saved it, when, and when it was last used. */
export function listExport(accountId: string): ZipEntry[] {
  const lists = all('SELECT * FROM bulk_lists WHERE account_id=? ORDER BY name COLLATE NOCASE', accountId);
  if (!lists.length) return [];
  const index = ['name,rows,saved_by,saved_at,last_used_at,file', ...lists.map((l) => [l.name, l.rows, l.created_by_name, l.created_at, l.used_at || '', `lists/${safeName(l.name)} ${l.id.slice(-6)}.csv`].map(cell).join(','))];
  return [...lists.map((l) => ({ name: `lists/${safeName(l.name)} ${l.id.slice(-6)}.csv`, data: Buffer.from(l.csv) })), { name: 'lists/index.csv', data: Buffer.from('﻿' + index.join('\r\n')) }];
}
