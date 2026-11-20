// Reads the words out of a PDF so they can be shown as real text: for screen readers, for large type,
// and for anyone who would rather read than pinch and zoom. pdf.js is loaded the same way PdfDoc loads it.

let lib: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  lib ??= (new Function('u', 'return import(u)') as (u: string) => Promise<any>)('/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc ||= '/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return lib;
}

export type Block = { kind: 'heading' | 'text'; text: string };
/** One page: its text as blocks, and where each printed line sits (0 to 1 from the top left) so fields can be described by the words beside them. */
export type PageText = { blocks: Block[]; lines: { x: number; y: number; text: string }[] };
type Line = { y: number; h: number; x0: number; x1: number; text: string };

function linesOf(items: any[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  let endX = 0;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4], y = it.transform[5];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    if (cur && Math.abs(y - cur.y) > Math.max(h, cur.h) * 0.5) cur = null;
    if (!cur) {
      if (!it.str.trim()) continue;
      cur = { y, h, x0: x, x1: x, text: '' };
      lines.push(cur);
    } else if (x - endX > h * 0.2 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
    cur.text += it.str;
    cur.h = Math.max(cur.h, h);
    cur.x0 = Math.min(cur.x0, x);
    endX = x + (it.width || 0);
    cur.x1 = Math.max(cur.x1, endX);
    if (it.hasEOL) cur = null;
  }
  // Long runs of underscores or dots are blanks to write on. Keep them short so they are not read out one by one.
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').replace(/_{4,}/g, '____').replace(/\.{6,}/g, '.....').trim();
  return lines.filter((l) => l.text);
}

function blocksOf(lines: Line[]): Block[] {
  if (!lines.length) return [];
  // PDFs usually store text in reading order. When one clearly does not, fall back to top to bottom, left to right.
  let jumps = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].y - lines[i - 1].y > lines[i].h * 1.5) jumps++;
  if (jumps > 3 && jumps > lines.length / 4) lines = [...lines].sort((a, b) => b.y - a.y || a.x0 - b.x0);

  // Body size is whichever size carries the most characters. Clearly larger lines are headings.
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(Math.round(l.h), (weight.get(Math.round(l.h)) || 0) + l.text.length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const widest = Math.max(...lines.map((l) => l.x1 - l.x0));
  const isHeading = (l: Line) => l.h >= body * 1.25 && l.text.length < 140;

  const out: Block[] = [];
  let prev: Line | null = null;
  for (const l of lines) {
    const heading = isHeading(l);
    const last = out[out.length - 1];
    const gap = prev ? prev.y - l.y : 0;
    const sameBlock = !!prev && !!last && gap > 0 && gap < Math.max(prev.h, l.h) * 1.9 && (last.kind === 'heading') === heading;
    if (!sameBlock) out.push({ kind: heading ? 'heading' : 'text', text: l.text });
    // A line that ran to the right-hand edge was wrapped, so the next one continues the sentence.
    else last!.text += (heading || prev!.x1 - prev!.x0 > widest * 0.8 ? ' ' : '\n') + l.text;
    prev = l;
  }
  return out;
}

/** The printed line a field sits on, or failing that the line just above it. */
export function textNear(page: PageText | undefined, f: { x: number; y: number; w: number; h: number }): string {
  if (!page) return '';
  const base = f.y + f.h * 0.85;
  let best = '', dist = Infinity;
  for (const l of page.lines) {
    const d = Math.abs(l.y - base);
    if (d < Math.max(0.018, f.h * 0.9) && d < dist) [best, dist] = [l.text, d];
  }
  if (!best)
    for (const l of page.lines) {
      const d = f.y - l.y;
      if (d >= 0 && d < 0.06 && d < dist) [best, dist] = [l.text, d];
    }
  return best.length > 120 ? `${best.slice(0, 117)}...` : best;
}

/**
 * Where the printed lines of one page sit, as boxes in fractions of the page (0 to 1 from the top left). `pdf` is a
 * pdf.js document that is already loaded (the one the page is drawn from), so nothing is downloaded twice. Used to
 * keep the "Sign here" pointer off the words of the document. A scanned page has no lines.
 */
export async function pageBoxes(pdf: any, index: number): Promise<{ x: number; y: number; w: number; h: number }[]> {
  const page = await pdf.getPage(index + 1);
  const vp = page.getViewport({ scale: 1 });
  return linesOf((await page.getTextContent()).items).map((l) => {
    const [x0, y0] = vp.convertToViewportPoint(l.x0, l.y);
    const [x1, y1] = vp.convertToViewportPoint(l.x1, l.y + l.h);
    return { x: Math.min(x0, x1) / vp.width, y: Math.min(y0, y1) / vp.height, w: Math.abs(x1 - x0) / vp.width, h: (Math.abs(y1 - y0) * 1.25) / vp.height };
  });
}

const cache = new Map<string, Promise<PageText[]>>();

/** The text of every page, in reading order. A page with no text (a scan, say) has no blocks. */
export function pageTexts(url: string): Promise<PageText[]> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const m = await pdfjs();
      const task = m.getDocument({ url, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', withCredentials: true });
      const doc = await task.promise;
      try {
        const pages: PageText[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          const lines = linesOf(tc.items);
          const vp = page.getViewport({ scale: 1 });
          pages.push({
            blocks: blocksOf(lines),
            lines: lines.map((l) => {
              const [x, y] = vp.convertToViewportPoint(l.x0, l.y);
              return { x: x / vp.width, y: y / vp.height, text: l.text };
            }),
          });
        }
        return pages;
      } finally {
        task.destroy?.();
      }
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}
