'use client';

// Shows a code that src/lib/qr.ts drew. The picture is built from where the dark modules are and from nothing else
// (tests/qr.test.ts holds it to that), so putting it into the page as markup cannot carry anything from a link
// into the page. `label` is what a screen reader says in place of the picture: what the code opens, never the link.
export function QrCode({ svg, label }: { svg: string; label: string }) {
  return <div className="qr-code" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
