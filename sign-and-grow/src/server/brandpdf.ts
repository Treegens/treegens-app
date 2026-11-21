// The GrowSigning logo and stamp in the PDFs we make: the certificate's header, the foot of the certificate and of
// notice pages, and the foot of every page of a signed copy (brand/README.md, "Wiring it in", step 7). Drawn as vector
// paths from src/lib/brandMark.ts, so they print sharp at any size and add no fonts or images to the file. Being paths,
// they add no words either: text a program pulls out of the PDF is the same as before.
import { rgb, type PDFPage, type PDFFont, type Color, type Rotation } from 'pdf-lib';
import { LOGO, STAMP, TONES, COLORS, rgb01 } from '../lib/brandMark.ts';

/** How tall the stamp is drawn, in points. The brand kit says 14 pt: never larger than a document's own text. */
export const STAMP_PT = 14;
/** How tall the logo in the certificate's header is, in points. */
export const HEADER_LOGO_PT = 24;
/** The stamp's width when it is STAMP_PT tall. */
export const STAMP_W = (STAMP.width * STAMP_PT) / STAMP.height;

const color = (hex: string) => rgb(...rgb01(hex));

/**
 * The deep green band across the top of a sheet with the logo for dark grounds and a title in white under it.
 * `W` and `H` are the sheet's size, `L` its left margin. The band is 92 pt deep, as the old one was, so what follows
 * starts where it did.
 */
export function drawBrandHeader(page: PDFPage, o: { W: number; H: number; L: number; title: string; bold: PDFFont }) {
  page.drawRectangle({ x: 0, y: o.H - 92, width: o.W, height: 92, color: color(COLORS.deep) });
  const scale = HEADER_LOGO_PT / LOGO.height;
  const parts = [[LOGO.mark.lit, 'lit'], [LOGO.mark.shade, 'shade'], [LOGO.grow, 'grow'], [LOGO.signing, 'signing']] as const;
  for (const [d, part] of parts) page.drawSvgPath(d, { x: o.L, y: o.H - 22, scale, color: color(TONES.dark[part]) });
  // The title has 20 pt type; a long one is made smaller so it stays on the band.
  let size = 20;
  while (size > 12 && o.bold.widthOfTextAtSize(o.title, size) > o.W - 2 * o.L) size -= 0.5;
  page.drawText(o.title, { x: o.L, y: o.H - 74, size, font: o.bold, color: rgb(1, 1, 1) });
}

/** The stamp at the foot of a certificate or notice sheet, with the sheet's footer line beside it on its baseline. */
export function drawSheetFoot(page: PDFPage, o: { L: number; footer: string; font: PDFFont; color: Color }) {
  const scale = STAMP_PT / STAMP.height;
  page.drawSvgPath(STAMP.d, { x: o.L, y: 36, scale, color: o.color });
  if (o.footer) page.drawText(o.footer, { x: o.L + STAMP_W + 8, y: 26.8, size: 7, font: o.font, color: o.color });
}

/** How tall the stamp is on a page of a signed copy, and how far its foot is above the bottom of the page, in points. */
export const PAGE_STAMP_PT = 12;
export const PAGE_STAMP_UP = 5;
/** The stamp's width when it is PAGE_STAMP_PT tall. */
export const PAGE_STAMP_W = (STAMP.width * PAGE_STAMP_PT) / STAMP.height;

/**
 * The foot of a page of a signed copy: the stamp, 12 pt from the left, and the envelope ID line beside it on its
 * baseline, whichever way the page is turned. `pt` and `rotate` come from pdf.ts's mapper() for that page.
 *
 * We print on somebody else's document and cannot see what is on it, so everything we add stays in one strip: the
 * lowest 17 pt of the page, under the quarter inch (18 pt) that desk printers leave blank and that a document's own
 * footer therefore stays above. Nothing is printed at the top of the page. A page that is one picture to its edges
 * (a scan) still gets this strip printed over its lowest 17 pt. A line too long for a narrow page is made smaller,
 * down to 4 pt, so the ID is never cut off.
 */
export function drawPageFoot(page: PDFPage, m: { W: number; H: number; pt: (x: number, y: number) => { x: number; y: number }; rotate: Rotation }, o: { line: string; font: PDFFont; color: Color }) {
  const top = m.pt(12, m.H - PAGE_STAMP_UP - PAGE_STAMP_PT); // the stamp's top left corner as the page is shown
  page.drawSvgPath(STAMP.d, { x: top.x, y: top.y, scale: PAGE_STAMP_PT / STAMP.height, rotate: m.rotate, color: o.color });
  if (!o.line) return;
  const x = 12 + PAGE_STAMP_W + 6;
  let size = 6.5;
  while (size > 4 && o.font.widthOfTextAtSize(o.line, size) > m.W - x - 12) size -= 0.25;
  const base = m.pt(x, m.H - PAGE_STAMP_UP - 4.1);
  page.drawText(o.line, { x: base.x, y: base.y, size, font: o.font, color: o.color, rotate: m.rotate });
}
