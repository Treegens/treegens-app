// How often an account may change pages (POST /envelopes/:id/documents/:doc/pages): each change that stores a new
// file counts, 120 an hour. A request refused for a mistake in it (a page that is not there, a turn that is not 90,
// 180 or 270) stores nothing and does not count, so a caller who mistypes does not use up the hour.
import { get } from './db.ts';
import { rateLimit, rateWait, HttpError } from './util.ts';
import { planPages, unchanged } from '../lib/pages.ts';

export const PAGES_PER_HOUR = 120;
const key = (accountId: string) => `pages:${accountId}`;

/** Refused, with how long to wait, when the account has used up its page changes for this hour. Counts nothing. */
export function pagesWaitCheck(accountId: string) {
  const ms = rateWait(key(accountId), PAGES_PER_HOUR);
  if (!ms) return;
  const min = Math.max(1, Math.ceil(ms / 60_000));
  throw new HttpError(429, `Pages were changed ${PAGES_PER_HOUR} times in the last hour on this account, which is the most for one hour. Nothing was changed. Try again in ${min} minute${min === 1 ? '' : 's'}.`);
}

/** Counts one change when it will store a file: the operations can be applied to the file they are for. */
export function pagesCount(accountId: string, fileId: string, ops: any) {
  const f = get('SELECT pages FROM files WHERE id=? AND account_id=?', fileId, accountId);
  if (!f) return;
  const planned = planPages(f.pages, ops);
  if ('error' in planned || unchanged(planned.plan, f.pages)) return;
  pagesWaitCheck(accountId);
  rateLimit(key(accountId), Infinity, 3600_000);
}
