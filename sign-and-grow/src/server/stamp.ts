import { rgb, degrees, type PDFPage, type PDFFont } from 'pdf-lib';

// The large mark drawn across every page of a copy that must never pass for a signed document: an envelope that was
// voided, declined or ran out of time, and the copy of what someone signed before the sender changed the document.
// The small line at the foot of each page says it too, but a small line is easy to cut off or overlook, and the
// signatures collected so far are on those pages. Drawn over the page, see-through, so the document stays readable.
// Used by renderEnvelopePdf and withNotice in pdf.ts.

const RED = rgb(0.66, 0.2, 0.16);

/** The two lines of the mark for an envelope in this state. */
export function stampFor(status: string): [string, string] {
  if (status === 'voided') return ['VOIDED', 'NOT A SIGNED DOCUMENT'];
  if (status === 'declined') return ['DECLINED', 'NOT A SIGNED DOCUMENT'];
  if (status === 'expired') return ['EXPIRED', 'NOT A SIGNED DOCUMENT'];
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

// Two lines, centred, along the diagonal from the lower left to the upper right as the page is looked at.
export function drawStamp(page: PDFPage, font: PDFFont, [big, small]: [string, string]) {
  const { W, H, pt, rot } = view(page);
  const angle = Math.atan2(H, W);
  const room = Math.hypot(W, H) * 0.72;
  const fit = (text: string, max: number) => Math.max(8, Math.min(max, (room / font.widthOfTextAtSize(text, 10)) * 10));
  const s1 = fit(big, 110);
  const s2 = Math.min(fit(small, 40), s1 * 0.45);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Looked-at coordinates run downwards, so "along the line" is (cos, -sin) and "up from the line" is (-sin, -cos).
  const line = (text: string, size: number, lift: number) => {
    const w = font.widthOfTextAtSize(text, size);
    const cap = size * 0.72;
    const cx = W / 2 - sin * lift, cy = H / 2 - cos * lift;
    const p = pt(cx - cos * (w / 2) + sin * (cap / 2), cy + sin * (w / 2) + cos * (cap / 2));
    page.drawText(text, { x: p.x, y: p.y, size, font, color: RED, opacity: 0.24, rotate: degrees((angle * 180) / Math.PI + rot) });
  };
  line(big, s1, s2 * 0.75);
  line(small, s2, -s1 * 0.62);
}
