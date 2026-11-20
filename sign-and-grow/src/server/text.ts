// Pulls the words out of an uploaded PDF so documents can be found by what they say, not just by their subject.
// Best effort: scanned pages have no text, and a document that cannot be read simply is not searchable.

const MAX_CHARS = 300_000;

export async function extractText(bytes: Uint8Array): Promise<string> {
  const work = async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    let out = '';
    try {
      for (let i = 1; i <= doc.numPages && out.length < MAX_CHARS; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        out += content.items.map((x: any) => x.str || '').join(' ') + '\n';
      }
    } finally {
      await doc.destroy().catch(() => {});
    }
    return out.replace(/[ \t]+/g, ' ').slice(0, MAX_CHARS);
  };
  try {
    return await Promise.race([work(), new Promise<string>((resolve) => setTimeout(() => resolve(''), 15_000))]);
  } catch {
    return '';
  }
}
