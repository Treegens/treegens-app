// Pulls the words out of an uploaded PDF so documents can be found by what they say, not just by their subject.
// Best effort: scanned pages have no text, and a document that cannot be read simply is not searchable.

const MAX_CHARS = 300_000;

// The words of each page, in page order. A page that is only a picture (a scan, a photo) comes back as ''. Reading
// stops at the size limit, so a very long document gives fewer entries than it has pages: the rest are unknown, not
// empty. A file that cannot be read at all, or takes too long, gives no entries.
export async function extractPages(bytes: Uint8Array): Promise<string[]> {
  const work = async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    const out: string[] = [];
    let chars = 0;
    try {
      for (let i = 1; i <= doc.numPages && chars < MAX_CHARS; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        out.push(content.items.map((x: any) => x.str || '').join(' ').replace(/[ \t]+/g, ' '));
        chars += out[out.length - 1].length + 1;
      }
    } finally {
      await doc.destroy().catch(() => {});
    }
    return out;
  };
  try {
    return await Promise.race([work(), new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 15_000))]);
  } catch {
    return [];
  }
}

/** The pages as one searchable text. */
export const textOf = (pages: string[]): string => pages.map((p) => `${p}\n`).join('').slice(0, MAX_CHARS);

export async function extractText(bytes: Uint8Array): Promise<string> {
  return textOf(await extractPages(bytes));
}
