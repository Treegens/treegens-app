// Two fields of the same person on top of each other. A finger reaches only the one drawn on top, so the signer
// stays at "1 of 2 left" with nothing to tap and cannot finish. Refused before sending: in the editor's review step
// and by the server when it sends or corrects (assertSendable in src/server/envelopes.ts). Plain data in, words out,
// so the editor, the server and the tests use the same rule.
import { overlap } from './autoplace.ts';

/** How much of the smaller field the other one may cover before one of them cannot be tapped. */
export const STACK_SHARE = 0.6;
// Filled in for the signer: nobody taps these, so two of them on top of each other block nothing.
const FILLED_FOR_THEM = ['date_signed', 'full_name', 'email'];
const tapped = (f: any) => !f.readonly && !FILLED_FOR_THEM.includes(f.type);

type F = { recipient_id?: string | null; document_id: string; page: number; type: string; x: number; y: number; w: number; h: number; readonly?: any };

/**
 * One sentence for each person and page where two of their fields cover each other, at least one of which they have
 * to tap. Empty when there is none. `recipients` and `documents` give the names said.
 */
export function stackedFields(fields: F[], recipients: { id: string; name?: string | null; role_name?: string | null }[], documents: { id: string; name?: string | null }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const mine = fields.filter((f) => f.recipient_id && f.type !== 'note');
  for (let i = 0; i < mine.length; i++)
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i], b = mine[j];
      if (a.recipient_id !== b.recipient_id || a.document_id !== b.document_id || Number(a.page) !== Number(b.page)) continue;
      if (!tapped(a) && !tapped(b)) continue;
      if (overlap(a, b) <= STACK_SHARE) continue;
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
