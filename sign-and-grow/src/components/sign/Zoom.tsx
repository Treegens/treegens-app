'use client';
import { ZOOMS } from '@/lib/mobile';

// The size of the pages on the signing page: 100, 150 or 200 percent. The pages are drawn again at that size, so the
// words stay sharp (PdfDoc, pixelRatio), and at more than 100 percent they slide sideways inside their own strip
// (.sg-pan), so the bars at the top and the bottom stay where they are. Pinching the screen keeps working as well.
export function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  function choose(z: number) {
    if (z === zoom) return;
    // Keep the same part of the document in the middle of the screen, across and down.
    const pan = document.querySelector<HTMLElement>('.sg-pan');
    const before = pan?.getBoundingClientRect();
    const mid = window.innerHeight / 2;
    const down = before && before.height ? (mid - before.top) / before.height : 0;
    const across = pan && pan.scrollWidth ? (pan.scrollLeft + pan.clientWidth / 2) / pan.scrollWidth : 0.5;
    onZoom(z);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const now = document.querySelector<HTMLElement>('.sg-pan');
      const after = now?.getBoundingClientRect();
      if (!now || !after || !before) return;
      window.scrollTo({ top: Math.max(0, window.scrollY + after.top + down * after.height - mid) });
      now.scrollLeft = Math.max(0, across * now.scrollWidth - now.clientWidth / 2);
    }));
  }
  return (
    <div className="sg-seg sg-zoom" role="group" aria-label="Size of the pages">
      {ZOOMS.map((z) => (
        <button key={z} type="button" aria-pressed={zoom === z} aria-label={`${Math.round(z * 100)} percent`} onClick={() => choose(z)}>{Math.round(z * 100)}%</button>
      ))}
    </div>
  );
}
