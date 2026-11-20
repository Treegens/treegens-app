'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { VIEW_FAILED, whyNotShown, serverSaid, type ViewFailure, type ServerSaid } from './viewFailure';
import { DRAW_SCREENS, RELEASE_SCREENS, nearScreen, pixelRatio } from './pdfMemory';
export type { ViewFailure } from './viewFailure';

// pdf.js is served from /public so the bundler never has to process it.
let lib: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  lib ??= (new Function('u', 'return import(u)') as (u: string) => Promise<any>)('/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return lib;
}

function Page({ pdf, index, width, children, ink, onClick, onDrawn }: { pdf: any; index: number; width: number; children?: ReactNode; ink?: ReactNode; onClick?: (e: React.MouseEvent<HTMLDivElement>) => void; onDrawn?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<any>(null);
  const [visible, setVisible] = useState(index < 2);
  // A drawing that failed (not one that was cancelled), and how often the person asked for it again.
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    let live = true;
    pdf.getPage(index + 1).then((p: any) => live && setPage(p));
    return () => {
      live = false;
    };
  }, [pdf, index]);

  // Drawn when it comes within a screen of view, and its picture given back when it is more than three screens away
  // (src/components/pdfMemory.ts). So a long document holds a handful of pictures, not one per page it ever showed.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const screen = () => window.innerHeight || 800;
    const check = () => {
      const r = el.getBoundingClientRect();
      setVisible((v) => (v ? nearScreen(r.top, r.bottom, screen(), RELEASE_SCREENS) : nearScreen(r.top, r.bottom, screen(), DRAW_SCREENS)));
    };
    const io = new IntersectionObserver(check, { rootMargin: `${DRAW_SCREENS * 100}% 0px` });
    const far = new IntersectionObserver(check, { rootMargin: `${RELEASE_SCREENS * 100}% 0px` });
    io.observe(el);
    far.observe(el);
    return () => (io.disconnect(), far.disconnect());
  }, []);

  const vp = page?.getViewport({ scale: 1 });
  const height = vp ? (width * vp.height) / vp.width : width * 1.294;

  useEffect(() => {
    const c = canvas.current;
    if (!page || !c || !width) return;
    if (!visible) {
      // Far from view: an empty picture holds no memory. The page keeps its size, so nothing on screen moves.
      c.width = 0;
      c.height = 0;
      page.cleanup?.();
      return;
    }
    const base = page.getViewport({ scale: 1 });
    // Sharp at the screen's own density and at any zoom, within a ceiling per page (pixelRatio).
    const ratio = pixelRatio(width, (width * base.height) / base.width, window.devicePixelRatio || 1);
    const v = page.getViewport({ scale: (width / base.width) * ratio });
    c.width = Math.floor(v.width);
    c.height = Math.floor(v.height);
    const task = page.render({ canvasContext: c.getContext('2d')!, viewport: v });
    // Said once the page is really on the screen. A drawing that was cancelled (the file was replaced, the page went
    // far from view) says nothing. One that failed for another reason (a phone short of memory) offers to try again.
    task.promise.then(() => (setFailed(false), onDrawn?.())).catch((e: any) => e?.name !== 'RenderingCancelledException' && setFailed(true));
    return () => task.cancel();
  }, [page, visible, width, again]); // eslint-disable-line react-hooks/exhaustive-deps

  // A first page far from view is only drawn when it comes near, and nothing of an older file is on the screen in its
  // place (a new file is a new PdfDoc). So it counts as shown once it has loaded. Otherwise the signing page, whose
  // Finish waits for this, would stay switched off for a replaced document further down, whether or not it was ever
  // looked at, and drawing it when it comes near still says so above.
  useEffect(() => {
    if (page && !visible) onDrawn?.();
  }, [page, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={box} className="pdfpage" data-page={index} style={{ width, height, ['--pw' as any]: `${width}px` }} onClick={onClick}>
      {/* A drawn page is a picture to a screen reader, and says so: which page it is, and that it is one. Its picture
          starts empty (0 by 0): a canvas left at the browser's default size would hold memory for nothing. */}
      <canvas ref={canvas} role="img" aria-label={`Page ${index + 1} of ${pdf.numPages}, shown as a picture`} width={0} height={0} />
      {failed && visible && (
        <div className="pdf-redraw" role="alert">
          This page could not be drawn. <button type="button" className="btn sm" onClick={(e) => (e.stopPropagation(), setFailed(false), setAgain((n) => n + 1))}>Draw it again</button>
        </div>
      )}
      {/* Stamps, printed like ink (src/server/stamps.ts): a layer of their own right on the drawn page, which starts
          no stacking context, so mix-blend-mode multiplies them into the page's own pixels and the printed words
          show through. What can be clicked stays in the overlay above. */}
      {ink && <div className="ink" aria-hidden="true">{ink}</div>}
      <div className="overlay">{children}</div>
      <span className="pageno">{index + 1}</span>
    </div>
  );
}

export function PdfDoc({ url, maxWidth = 860, zoom = 1, overlay, ink, onPageClick, onPages, onDocument, onShown, failed }: {
  /** What is printed like ink on a page (stamps), under the overlay and blended into the drawn page. */
  ink?: (page: number) => ReactNode;
  /** Called when the first page of the file at `url` has been drawn, or has loaded while far from view (it is drawn
   *  when it comes near), so the parent knows which file is on screen. */
  onShown?: () => void;
  /** What to show instead of the pages when they cannot be shown. Without it, a plain sentence with Try again. */
  failed?: (why: ViewFailure, retry: () => void, said?: ServerSaid | null) => ReactNode;
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
  const [error, setError] = useState<ViewFailure | ''>('');
  const [said, setSaid] = useState<ServerSaid | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [avail, setAvail] = useState(0);

  useEffect(() => {
    let live = true;
    let task: any;
    let loaded = false;
    setPdf(null);
    setError('');
    setSaid(null);
    // A viewer that did not load is forgotten, so Try again fetches it afresh.
    pdfjs()
      .then((m) => {
        loaded = true;
        task = m.getDocument({ url, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', withCredentials: true });
        return task.promise;
      })
      .then((d: any) => {
        if (!live) return;
        setPdf(d);
        onPages?.(d.numPages);
        onDocument?.(d);
      })
      .catch((e: any) => {
        if (!loaded) lib = null;
        // Never the viewer's own words ("Promise.withResolvers is not a function"): what happened, in a person's terms.
        if (live) setError(whyNotShown(e, loaded, typeof navigator === 'undefined' || navigator.onLine !== false));
        // The server refused the file and says why in words: its stored copy failed its check, or it is locked with an
        // encryption key the server was not given. A download would fail the same way, so the page says that instead.
        if (live && e?.name === 'UnexpectedResponseException' && e?.status >= 500)
          serverSaid(url).then((s) => live && setSaid(s));
      });
    return () => {
      live = false;
      onDocument?.(null);
      task?.destroy?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const width = Math.round(Math.min(maxWidth, avail || maxWidth) * zoom);
  return (
    <div ref={wrap} className="pdfdoc" style={{ width: '100%' }}>
      {error && (failed ? failed(error, () => setAttempt((n) => n + 1), said) : (
        <div className="notice err" role="alert">
          {VIEW_FAILED[error]}{' '}
          <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ))}
      {!pdf && !error && <div className="muted" style={{ padding: 40 }}>Loading document…</div>}
      {pdf && avail > 0 &&
        Array.from({ length: pdf.numPages }, (_, i) => (
          <Page key={i} pdf={pdf} index={i} width={width} onDrawn={i === 0 ? onShown : undefined} ink={ink?.(i)}
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
