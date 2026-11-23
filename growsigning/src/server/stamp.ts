import { rgb, degrees, type PDFPage, type PDFFont } from 'pdf-lib';

// The mark drawn across every page of a copy that must never pass for a signed document: an envelope that was
// voided, declined or ran out of time, a copy made while it is still out (the signatures collected so far are on
// it, and voiding it later does not change a file already downloaded), and the copy of what someone signed before
// the sender changed the document. The small line at the top of each page says it too, but a small line is easy to
// cut off or overlook. Used by renderEnvelopePdf and withNotice in pdf.ts.

/** The two lines of the mark for an envelope in this state. 'sent' is a copy made while it is still out. */
export function stampFor(status: string): [string, string] {
  if (status === 'voided') return ['VOIDED', 'NOT A SIGNED DOCUMENT'];
  if (status === 'declined') return ['DECLINED', 'NOT A SIGNED DOCUMENT'];
  if (status === 'expired') return ['EXPIRED', 'NOT A SIGNED DOCUMENT'];
  if (status === 'sent') return ['NOT COMPLETED YET', 'NOT EVERYONE HAS SIGNED'];
  return ['NOT COMPLETED', 'NOT A SIGNED DOCUMENT'];
}

/** The mark for a copy made by withNotice, by the words its foot line carries. */
export const stampForMark = (mark: string): [string, string] =>
  /before a change/i.test(mark) ? ['SIGNED BEFORE A CHANGE', 'NOT THE CURRENT DOCUMENT'] : ['NOT COMPLETED', 'NOT A SIGNED DOCUMENT'];

// The page as it is looked at (a page can be stored turned, /Rotate), with a way from there to the page's own
// coordinates. The same reckoning as mapper() in pdf.ts.
function view(page: PDFPage) {
  const b = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const W = rot % 180 ? b.height : b.width;
  const H = rot % 180 ? b.width : b.height;
  const pt = (vx: number, vy: number) =>
    rot === 0 ? { x: b.x + vx, y: b.y + b.height - vy }
    : rot === 90 ? { x: b.x + vy, y: b.y + vx }
    : rot === 180 ? { x: b.x + b.width - vx, y: b.y + vy }
    : { x: b.x + b.width - vy, y: b.y + b.height - vx };
  return { W, H, pt, rot };
}

// Dark red: it reads as red in colour and as dark grey in black and white.
const INK = rgb(0.5, 0.07, 0.05);

// The mark, in three layers, so that no part of a page can be cut out or copied without it:
// - the two lines large across the middle, see-through, so the page underneath stays readable;
// - the first line again, small and dark, in rows along both diagonals over the whole page, corners included. At this
//   strength a copier or a fax in black-and-white text mode, which turns anything lighter than half-grey white, still
//   prints it, and a signature block in a corner is crossed by it like the rest of the page;
// - the words of the foot line at the top and at the bottom of the page.
export function drawStamp(page: PDFPage, font: PDFFont, [big, small]: [string, string]) {
  const { W, H, pt, rot } = view(page);
  const angle = Math.atan2(H, W);
  const room = Math.hypot(W, H) * 0.72;
  const fit = (text: string, max: number) => Math.max(8, Math.min(max, (room / font.widthOfTextAtSize(text, 10)) * 10));
  const s1 = fit(big, 110);
  const s2 = Math.min(fit(small, 40), s1 * 0.45);
  // Looked-at coordinates run downwards, so "along the line" is (cos, -sin) and "up from the line" is (-sin, -cos).
  const along = (text: string, size: number, a: number, cx: number, cy: number, opacity: number) => {
    const cos = Math.cos(a), sin = Math.sin(a);
    const w = font.widthOfTextAtSize(text, size);
    const cap = size * 0.72;
    const p = pt(cx - cos * (w / 2) + sin * (cap / 2), cy + sin * (w / 2) + cos * (cap / 2));
    page.drawText(text, { x: p.x, y: p.y, size, font, color: INK, opacity, rotate: degrees((a * 180) / Math.PI + rot) });
  };
  const line = (text: string, size: number, lift: number) => along(text, size, angle, W / 2 - Math.sin(angle) * lift, H / 2 - Math.cos(angle) * lift, 0.3);
  line(big, s1, s2 * 0.75);
  line(small, s2, -s1 * 0.62);
  // The rows: one direction, then the other, each row offset from the one before so the words never line up into a
  // clear lane. Rows stand ROW apart, and along a row the words repeat after their own width and a gap, which leaves
  // no square of a third of the page without them.
  const word = `${big} · ${small}`;
  const size = 9;
  const step = font.widthOfTextAtSize(word, size) + 36;
  const ROW = 84;
  const reach = Math.hypot(W, H) / 2 + step;
  for (const a of [angle, -angle]) {
    const cos = Math.cos(a), sin = Math.sin(a);
    for (let k = -Math.ceil(reach / ROW), n = 0; k <= Math.ceil(reach / ROW); k++, n++)
      for (let t = -reach + ((n % 2) * step) / 2; t <= reach; t += step) {
        const cx = W / 2 + cos * t - sin * k * ROW, cy = H / 2 - sin * t - cos * k * ROW;
        // Only words whose middle falls on the page: the rest would be drawn where nobody sees them.
        if (cx > -step / 2 && cx < W + step / 2 && cy > -step / 2 && cy < H + step / 2) along(word, size, a, cx, cy, 0.85);
      }
  }
  // The words at the bottom of the page as well, dark and plain, like the line at its top (pdf.ts), so cutting off
  // either edge leaves the other.
  const edge = `${big}: ${small}`;
  const p = pt(12, H - 6);
  page.drawText(edge, { x: p.x, y: p.y, size: Math.min(9, (W - 24) / (font.widthOfTextAtSize(edge, 10) / 10)), font, color: INK, rotate: degrees(rot) });
}

// Over every signature, initials and stamp on a copy that must not pass for a signed one: a dark frame, a line
// through it and the mark's first word inside, so a signature cut out of the page carries the word with it.
export function markFields(pages: PDFPage[], fields: any[], font: PDFFont, [big]: [string, string]) {
  for (const f of fields) {
    const page = pages[f.page];
    if (!page || !f.value || !['signature', 'initials', 'stamp'].includes(f.type)) continue;
    const { W, H, pt, rot } = view(page);
    const x = f.x * W, y = f.y * H, w = f.w * W, h = f.h * H;
    const edge = (ax: number, ay: number, bx: number, by: number, thickness: number) => page.drawLine({ start: pt(ax, ay), end: pt(bx, by), thickness, color: INK, opacity: 0.9 });
    edge(x, y, x + w, y, 1.2), edge(x + w, y, x + w, y + h, 1.2), edge(x + w, y + h, x, y + h, 1.2), edge(x, y + h, x, y, 1.2);
    edge(x, y + h, x + w, y, 1);
    const size = Math.max(5, Math.min(h * 0.5, 16, ((w - 6) / font.widthOfTextAtSize(big, 10)) * 10));
    const tw = font.widthOfTextAtSize(big, size);
    const p = pt(x + (w - tw) / 2, y + h / 2 + size * 0.36);
    page.drawText(big, { x: p.x, y: p.y, size, font, color: INK, opacity: 0.95, rotate: degrees(rot) });
  }
}
