// Bulk send: columns of the list named like one of the account's custom fields (src/server/customfields.ts) fill
// that field in each row's envelope, in place of the template's value. The server checks every value again, and that
// every required field has one, before anything is sent, and refuses the batch with the row and the reason.
// No React in here, so it can be tested on its own.
import { parseCsv } from './csv.ts';
import { customKey } from '../../lib/customfields.ts';

/**
 * For each row of the list (by its line number, as readRecipients counts rows), the custom fields its columns fill,
 * and the names of the columns that were used. Only a list with a header row can name them. An empty cell fills
 * nothing, so the template's own value stays.
 */
export function readCustomColumns(text: string, names: string[], header: boolean): { names: string[]; byRow: Map<number, Record<string, string>> } {
  const byRow = new Map<number, Record<string, string>>();
  const known = new Map(names.map((n) => [customKey(n), n]));
  if (!header || !known.size) return { names: [], byRow };
  const table = parseCsv(text);
  const head = table[0] || [];
  const cols = head.map((h, i) => [i, known.get(customKey(h))] as const).filter(([, name]) => !!name) as [number, string][];
  table.slice(1).forEach((cells, i) => {
    const row: Record<string, string> = {};
    for (const [c, name] of cols) if ((cells[c] || '').trim()) row[name] = cells[c].trim();
    if (Object.keys(row).length) byRow.set(i + 2, row);
  });
  return { names: cols.map(([c]) => head[c]), byRow };
}
