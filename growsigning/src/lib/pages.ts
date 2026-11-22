// Removing, turning and moving the pages of one document before it is sent (research/docusign-gaps.json, batch
// "page-tools"). The rules are shared: the server makes the new file from them (src/server/pages.ts), and the editor
// moves its own fields with them (src/components/editor/PageTools.tsx), so both always agree on where a field goes.
//
// An operation names a page as it is at that moment, counted from 1, after the operations before it:
//   { op: 'remove', page: 3 }            page 3 goes
//   { op: 'turn', page: 2, by: 90 }      page 2 is turned a quarter to the right (90), upside down (180) or a quarter
//                                         to the left (270)
//   { op: 'move', page: 4, to: 1 }       page 4 becomes page 1, the others close up
// Fields are on pages counted from 0 (as everywhere else), with places and sizes as shares of the page as it is seen.

export type PageOp = { op: 'remove'; page: number } | { op: 'turn'; page: number; by: 90 | 180 | 270 } | { op: 'move'; page: number; to: number };
/** For each page of the new file: which page of the old file it is (from 0) and how far it was turned to the right. */
export type PagePlan = { from: number; turn: number }[];
export type Size = { w: number; h: number };

/** The most operations one request can carry. */
export const MAX_PAGE_OPS = 500;
export const TURNS = [90, 180, 270] as const;

const whole = (n: any) => typeof n === 'number' && Number.isInteger(n);

/** The new order of the pages, or the sentence that says what is wrong with the operations (nothing is changed then). */
export function planPages(count: number, ops: any): { plan: PagePlan; ops: PageOp[] } | { error: string } {
  if (!Array.isArray(ops) || !ops.length) return { error: 'No change to the pages was sent. Send "ops" as a list, like [{ "op": "remove", "page": 3 }].' };
  if (ops.length > MAX_PAGE_OPS) return { error: `That is ${ops.length} changes in one go, and the most is ${MAX_PAGE_OPS}. Send them in smaller groups.` };
  let plan: PagePlan = Array.from({ length: count }, (_, i) => ({ from: i, turn: 0 }));
  const clean: PageOp[] = [];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i] || {};
    const n = plan.length;
    const which = `Change ${i + 1}`;
    if (typeof o.page === 'string' && o.page.trim() !== '') return { error: `${which} names the page as text, ${JSON.stringify(o.page)}. Write the page as a plain number without quotes, like "page": 2.` };
    if (!whole(o.page) || o.page < 1 || o.page > n) return { error: `${which} names page ${JSON.stringify(o.page ?? null)}, and at that point the document has ${n} page${n === 1 ? '' : 's'}. Use a page number from 1 to ${n}.` };
    const at = o.page - 1;
    if (o.op === 'remove') {
      if (n === 1) return { error: `${which} would remove the last page. A document needs at least one page. Remove the whole file instead.` };
      plan = plan.filter((_, k) => k !== at);
      clean.push({ op: 'remove', page: o.page });
    } else if (o.op === 'turn') {
      if (typeof o.by === 'string' && TURNS.map(String).includes(o.by.trim())) return { error: `${which} names the turn as text, ${JSON.stringify(o.by)}. Write it as a plain number without quotes, like "by": 90.` };
      if (!(TURNS as readonly number[]).includes(o.by)) return { error: `${which} turns page ${o.page} by ${JSON.stringify(o.by ?? null)}. Use 90 (a quarter to the right), 180 (upside down) or 270 (a quarter to the left).` };
      plan = plan.map((p, k) => (k === at ? { ...p, turn: (p.turn + o.by) % 360 } : p));
      // Turning one page again straight after is one turn in the record: three quarters right is a quarter left.
      const last = clean[clean.length - 1];
      if (last?.op === 'turn' && last.page === o.page) {
        const by = (last.by + o.by) % 360;
        if (by) last.by = by as 90 | 180 | 270;
        else clean.pop();
      } else clean.push({ op: 'turn', page: o.page, by: o.by });
    } else if (o.op === 'move') {
      if (typeof o.to === 'string' && o.to.trim() !== '') return { error: `${which} names the place as text, ${JSON.stringify(o.to)}. Write the place as a plain number without quotes, like "to": 1.` };
      if (!whole(o.to) || o.to < 1 || o.to > n) return { error: `${which} moves page ${o.page} to place ${JSON.stringify(o.to ?? null)}. Use a place from 1 to ${n}.` };
      const next = [...plan];
      const [x] = next.splice(at, 1);
      next.splice(o.to - 1, 0, x);
      plan = next;
      clean.push({ op: 'move', page: o.page, to: o.to });
    } else return { error: `${which} has "op": ${JSON.stringify(o.op ?? null)}. Use "remove", "turn" or "move".` };
  }
  return { plan, ops: clean };
}

/** True when the plan leaves every page as it was. */
export const unchanged = (plan: PagePlan, count: number) => plan.length === count && plan.every((p, i) => p.from === i && p.turn === 0);

/** The size of a page as it is seen once it has been turned by `turn` more degrees to the right. */
export const turnedSize = (s: Size, turn: number): Size => (turn % 180 ? { w: s.h, h: s.w } : { w: s.w, h: s.h });

// One field moved with its page. On a turned page the field stays on the same words: its middle turns with the page,
// and it keeps its size and stays upright, so a signature line is still a line you sign on and not a tall strip.
function placeField(f: any, turn: number, old: Size): { x: number; y: number; w: number; h: number } {
  const W = old.w, H = old.h;
  const nw = turnedSize(old, turn);
  const cx = (f.x + f.w / 2) * W, cy = (f.y + f.h / 2) * H;
  const [nx, ny] = turn === 90 ? [H - cy, cx] : turn === 180 ? [W - cx, H - cy] : turn === 270 ? [cy, W - cx] : [cx, cy];
  const w = Math.min(1, (f.w * W) / nw.w), h = Math.min(1, (f.h * H) / nw.h);
  const clamp = (v: number, size: number) => Math.min(Math.max(0, v), 1 - size);
  return { x: clamp(nx / nw.w - w / 2, w), y: clamp(ny / nw.h - h / 2, h), w, h };
}

/**
 * The fields of the whole envelope after `plan` was applied to document `documentId`. Fields of other documents are
 * untouched. `dropped` are the fields that were on a page that is gone; they are not in `fields`.
 * `sizes` are the old file's pages as seen (page_sizes); without them a turned field keeps its shares of the page.
 */
export function moveFields<T extends { document_id: string; page: number; x: number; y: number; w: number; h: number }>(fields: T[], documentId: string, plan: PagePlan, sizes?: Size[] | null): { fields: T[]; dropped: T[] } {
  const where = new Map<number, number>(plan.map((p, i) => [p.from, i]));
  const out: T[] = [], dropped: T[] = [];
  for (const f of fields) {
    if (f.document_id !== documentId) {
      out.push(f);
      continue;
    }
    const at = where.get(Number(f.page) || 0);
    if (at === undefined) {
      dropped.push(f);
      continue;
    }
    const turn = plan[at].turn;
    const size = sizes?.[Number(f.page) || 0] || { w: 1, h: 1 };
    out.push({ ...f, page: at, ...(turn ? placeField(f, turn, size) : {}) });
  }
  return { fields: out, dropped };
}

const TURN_WORDS: Record<number, string> = { 90: 'a quarter turn to the right', 180: 'upside down', 270: 'a quarter turn to the left' };

/** One operation in words for the record and for the screen: "Page 3 removed", "Page 2 turned a quarter turn to the right". */
export function opWords(o: PageOp): string {
  if (o.op === 'remove') return `Page ${o.page} removed`;
  if (o.op === 'turn') return `Page ${o.page} turned ${TURN_WORDS[o.by]}`;
  return `Page ${o.page} moved to place ${o.to}`;
}

/** The fields on removed pages in words, for the refusal and for the question in the editor: "Signature for Ada on page 3". */
export function fieldWords(f: { type: string; label?: string | null; page: number }, owner?: string | null): string {
  const kind = f.label ? `"${String(f.label).slice(0, 60)}"` : f.type.replace('_', ' ').replace(/^./, (c) => c.toUpperCase());
  return `${kind}${owner ? ` for ${owner}` : ''} on page ${Number(f.page) + 1}`;
}
