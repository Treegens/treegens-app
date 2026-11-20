'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// pdf.js is served from /public so the bundler never has to process it.
let lib: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  lib ??= (new Function('u', 'return import(u)') as (u: string) => Promise<any>)('/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return lib;
}

function Page({ pdf, index, width, children, onClick }: { pdf: any; index: number; width: number; children?: ReactNode; onClick?: (e: React.MouseEvent<HTMLDivElement>) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<any>(null);
  const [visible, setVisible] = useState(index < 2);

  useEffect(() => {
    let live = true;
    pdf.getPage(index + 1).then((p: any) => live && setPage(p));
    return () => {
      live = false;
    };
  }, [pdf, index]);

  useEffect(() => {
    if (visible || !box.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '800px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, [visible]);

  const vp = page?.getViewport({ scale: 1 });
  const height = vp ? (width * vp.height) / vp.width : width * 1.294;

  useEffect(() => {
    if (!page || !visible || !canvas.current || !width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const v = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
    const c = canvas.current;
    c.width = Math.floor(v.width);
    c.height = Math.floor(v.height);
    const task = page.render({ canvasContext: c.getContext('2d')!, viewport: v });
    task.promise.catch(() => {});
    return () => task.cancel();
  }, [page, visible, width]);

  return (
    <div ref={box} className="pdfpage" data-page={index} style={{ width, height, ['--pw' as any]: `${width}px` }} onClick={onClick}>
      {/* A drawn page is a picture to a screen reader, and says so: which page it is, and that it is one. */}
      <canvas ref={canvas} role="img" aria-label={`Page ${index + 1} of ${pdf.numPages}, shown as a picture`} />
      <div className="overlay">{children}</div>
      <span className="pageno">{index + 1}</span>
    </div>
  );
}

export function PdfDoc({ url, maxWidth = 860, zoom = 1, overlay, onPageClick, onPages, onDocument }: {
  url: string;
  maxWidth?: number;
  zoom?: number;
  overlay?: (page: number) => ReactNode;
  onPageClick?: (page: number, x: number, y: number) => void;
  onPages?: (n: number) => void;
  /** Hands the loaded pdf.js document to the parent (to read its text, for example), and null when it is unloaded. */
  onDocument?: (pdf: any | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<any>(null);
  const [error, setError] = useState('');
  const [avail, setAvail] = useState(0);

  useEffect(() => {
    let live = true;
    let task: any;
    setPdf(null);
    setError('');
    pdfjs()
      .then((m) => {
        task = m.getDocument({ url, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', withCredentials: true });
        return task.promise;
      })
      .then((d: any) => {
        if (!live) return;
        setPdf(d);
        onPages?.(d.numPages);
        onDocument?.(d);
      })
      .catch((e: any) => live && setError(e?.message || 'Could not load the document.'));
    return () => {
      live = false;
      onDocument?.(null);
      task?.destroy?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const width = Math.round(Math.min(maxWidth, avail || maxWidth) * zoom);
  return (
    <div ref={wrap} className="pdfdoc" style={{ width: '100%' }}>
      {error && <div className="notice err">{error}</div>}
      {!pdf && !error && <div className="muted" style={{ padding: 40 }}>Loading document…</div>}
      {pdf && avail > 0 &&
        Array.from({ length: pdf.numPages }, (_, i) => (
          <Page key={i} pdf={pdf} index={i} width={width}
            onClick={onPageClick ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onPageClick(i, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
            } : undefined}>
            {overlay?.(i)}
          </Page>
        ))}
    </div>
  );
}
