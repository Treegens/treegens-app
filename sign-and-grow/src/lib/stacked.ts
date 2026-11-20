// Two fields of the same person on top of each other. A finger reaches only the one drawn on top, so the signer
// stays at "1 of 2 left" with nothing to tap and cannot finish. Refused before sending: in the editor's review step
// and by the server when it sends or corrects (assertSendable in src/server/envelopes.ts), and when a template is
// saved or a public form is made from one. Plain data in, words out, so the editor, the server, the signing page
// and the tests use the same rule.
//
// The signing page draws the smaller of two overlapping fields on top (layers below). So a tick box inside the end
// of a text field, as paper forms have them, is not a problem: the box is tapped where it is, the text field
// everywhere else. What is refused is a field that is mostly covered by fields drawn over it: two of the same size
// in the same spot, or a field under others that hide most of it.
import { neverTogether } from './logic.ts';

/** How much of a field the fields drawn over it may cover before it cannot be tapped any more. */
export const STACK_SHARE = 0.6;
// Filled in for the signer: nobody taps these, so two of them on top of each other block nothing.
const FILLED_FOR_THEM = ['date_signed', 'full_name', 'email'];
const tapped = (f: any) => !f.readonly && !FILLED_FOR_THEM.includes(f.type);

type F = { recipient_id?: string | null; document_id: string; page: number; type: string; x: number; y: number; w: number; h: number; readonly?: any };

type B = { x: number; y: number; w: number; h: number };
const area = (f: B) => Math.max(0, f.w) * Math.max(0, f.h);
const common = (a: B, b: B) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
// Of two fields at the same place, which one the page draws over the other: the smaller one, and of two the same
// size the later one, as the page lists them.
const over = (a: B, ai: number, b: B, bi: number) => area(a) < area(b) || (area(a) === area(b) && ai > bi);
const samePage = (a: any, b: any) => (a.document_id ?? '') === (b.document_id ?? '') && Number(a.page) === Number(b.page);

/**
 * The z-index the signing page gives each of a person's fields that overlaps another: one more for each field it is
 * drawn over, so the smaller is always on top (at most 4, under the selected field and the "Sign here" flag). A
 * field that overlaps nothing gets none and keeps the page's order.
 */
export function layers(fields: (B & { id: string; page: number; document_id?: string | null })[]): Map<string, number> {
  const z = new Map<string, number>();
  fields.forEach((a, i) => {
    let under = 0, touches = false;
    fields.forEach((b, j) => {
      if (i === j || !samePage(a, b) || !common(a, b)) return;
      touches = true;
      if (over(a, i, b, j)) under++;
    });
    if (touches) z.set(a.id, Math.min(4, 1 + under));
  });
  return z;
}

/**
 * One sentence for each person and page where two of their fields cover each other, at least one of which they have
 * to tap. Empty when there is none. `recipients` and `documents` give the names said.
 */
export function stackedFields(fields: F[], recipients: { id: string; name?: string | null; role_name?: string | null }[], documents: { id: string; name?: string | null }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const mine = fields.filter((f) => f.recipient_id && f.type !== 'note');
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    // Only a field the person has to tap can be in their way when it is covered.
    if (!tapped(a) || !area(a)) continue;
    let covered = 0;
    for (let j = 0; j < mine.length; j++) {
      const b = mine[j];
      if (i === j || a.recipient_id !== b.recipient_id || !samePage(a, b) || !over(b, j, a, i)) continue;
      // Two fields that are never shown at the same time ("company name" when a box is ticked, "your name" when it is
      // not) may share a place: only one of them is ever on the page (src/lib/logic.ts).
      if (neverTogether(a, b, fields)) continue;
      covered += common(a, b);
    }
    if (covered / area(a) <= STACK_SHARE) continue;
    const key = `${a.recipient_id}|${a.document_id}|${a.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = recipients.find((x) => x.id === a.recipient_id);
    const name = r?.name?.trim() || r?.role_name?.trim() || 'one recipient';
    const doc = documents.length > 1 ? documents.find((d) => d.id === a.document_id)?.name : '';
    out.push(`Two fields for ${name} sit on top of each other on page ${Number(a.page) + 1}${doc ? ` of ${doc}` : ''}, so one of them cannot be tapped. Move or remove one.`);
  }
  return out;
}
