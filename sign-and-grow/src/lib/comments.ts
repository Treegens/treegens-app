// Words about comments that the signing page, the envelope page and the server's emails share
// (src/server/comments.ts keeps the comments themselves).

export type Pin = { document_id: string; document?: string | null; page: number; x?: number | null; y?: number | null };

// Where on a page a comment was pinned, in words a screen reader reads as well as anyone: "Lease, page 2, near the
// top on the left". Pages are counted from 1 here; they are kept from 0 like the fields.
export function pinWords(pin: Pin | null | undefined, documents = 1): string {
  if (!pin) return '';
  const page = `page ${pin.page + 1}`;
  const where = pin.x == null || pin.y == null ? '' : `, near the ${pin.y < 1 / 3 ? 'top' : pin.y < 2 / 3 ? 'middle' : 'bottom'}${pin.x < 1 / 3 ? ' on the left' : pin.x < 2 / 3 ? '' : ' on the right'}`;
  return `${documents > 1 && pin.document ? `${pin.document}, ` : ''}${page}${where}`;
}

/** Who can read a thread, said to the person reading it. The sender's side is the sender and the admins of their account
 * (and its API keys), so a private thread is never called "only the two of you". */
export function audienceWords(t: { private: boolean; with?: { name: string } | null }, side: 'sender' | 'recipient', senderName = 'the sender'): string {
  if (!t.private) return 'Everyone on this document can read this.';
  return side === 'sender' ? `Private between your account and ${t.with?.name || 'this person'}. Nobody else on the envelope can read it.`
    : `Private between you and ${senderName}. The admins of their account can read it too. Nobody else on this document can.`;
}
