// Bulk send: columns of the list that fill fields of the template. A column whose header is the label of a field the
// sender may fill in (a text, a number, a date, a choice, a tick box), or the name of a group of radio buttons, gives
// that field its starting value in each row's envelope, the way a prefilled value does. So a rule that depends on it
// ("Only show when 'Plan' is Gold") shows or hides from the first look. The server checks every value again before
// anything is sent (rowFieldProblem in src/server/logic.ts) and refuses the batch with the row and the reason.
// No React in here, so it can be tested on its own.
import { parseCsv } from './csv.ts';

const norm = (s: any) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9\p{L}]/gu, '');
const FILLABLE = ['text', 'number', 'date', 'company', 'title', 'checkbox', 'radio', 'dropdown'];

/** The fields of a template a list can fill, by the column name that fills them. */
export function fillableColumns(fields: any[] | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fields || []) {
    // A calculated field works itself out, and the template's own fixed wording is not a row's to change.
    if (!FILLABLE.includes(f.type) || f.formula || (f.readonly && f.value)) continue;
    const name = f.type === 'radio' ? f.group_name : f.label;
    if (name && norm(name)) out.set(norm(name), String(name));
  }
  return out;
}

/**
 * For each row of the list (by its line number, as readRecipients counts rows), the fields its columns fill, and the
 * names of the columns that were used for fields. Only a list with a header row can name fields. Empty cells fill
 * nothing, so the template's own value stays.
 */
export function readFieldColumns(text: string, fields: any[] | undefined | null, header: boolean): { names: string[]; byRow: Map<number, Record<string, string>> } {
  const byRow = new Map<number, Record<string, string>>();
  const fillable = fillableColumns(fields);
  if (!header || !fillable.size) return { names: [], byRow };
  const table = parseCsv(text);
  const head = table[0] || [];
  const cols = head.map((h, i) => [i, fillable.get(norm(h))] as const).filter(([, name]) => !!name) as [number, string][];
  table.slice(1).forEach((cells, i) => {
    const row: Record<string, string> = {};
    for (const [c, name] of cols) if ((cells[c] || '').trim()) row[name] = cells[c].trim();
    if (Object.keys(row).length) byRow.set(i + 2, row);
  });
  return { names: cols.map(([c]) => head[c]), byRow };
}
