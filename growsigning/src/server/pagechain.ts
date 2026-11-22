// Which file a file was made from by changing its pages (files.page_ops, written by src/server/pages.ts), followed back
// one step at a time. Kept apart from pages.ts so envelopes.ts can say what changed in a correction without a loop
// of imports.
import { get } from './db.ts';
import { opWords, type PageOp } from '../lib/pages.ts';

/** The changes that lead from file `from` to file `to`, oldest first, when `to` was made from `from` by changing pages
 *  (once or several times in a row). Null when it was not: the file was replaced by another one. */
export function chainOf(from: string, to: string): PageOp[] | null {
  const steps: PageOp[][] = [];
  let at = to;
  for (let n = 0; n < 100 && at !== from; n++) {
    const row = get('SELECT page_ops FROM files WHERE id=?', at);
    if (!row?.page_ops) return null;
    let made: { from: string; ops: PageOp[] };
    try {
      made = JSON.parse(row.page_ops);
    } catch {
      return null;
    }
    steps.unshift(made.ops);
    at = made.from;
  }
  return at === from ? steps.flat() : null;
}

/** Whether file `to` is file `from`, or was made from it by changing pages (once or several times). */
export const madeFrom = (from: string, to: string): boolean => from === to || chainOf(from, to) !== null;

/** "Page 2 turned a quarter turn to the right. Page 3 removed." when `to` was made from `from` by changing pages,
 *  or null when it was not. At most 20 changes are named; the rest are counted. */
export function pageChangeWords(from: string, to: string): string | null {
  const ops = from === to ? null : chainOf(from, to);
  if (!ops?.length) return null;
  const said = ops.slice(0, 20).map((o) => `${opWords(o)}.`);
  return `${said.join(' ')}${ops.length > 20 ? ` And ${ops.length - 20} more changes to the pages.` : ''}`;
}
