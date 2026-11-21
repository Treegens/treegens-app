'use client';
// "Pages" on a file's row in step 1 (research/ux-notes.json, ds-page-tools): the pages as small pictures, each with
// Turn and Remove, moved by dragging or with the arrow keys (or the arrow buttons on a phone). Nothing is changed
// until "Save pages", and Undo takes back one change at a time until then. Saving makes a new file on the server
// (POST /envelopes/:id/documents/:doc/pages with "save": false) and the editor moves its own fields with the pages
// (src/lib/pages.ts); the envelope itself is saved the way it always is, so a correction still asks before anyone
// who finished has to sign again.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, Modal } from '../ui';
import { planPages, moveFields, fieldWords, unchanged, type PageOp } from '@/lib/pages';
import { plural, who, type Ed } from './shared';

let lib: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  lib ??= (new Function('u', 'return import(u)') as (u: string) => Promise<any>)('/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return lib;
}

// The pictures of the pages of one file, drawn small, one at a time, as they come into view.
function usePictures(fileId: string, count: number) {
  const [pics, setPics] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState(false);
  const want = useRef<Set<number>>(new Set());
  const doc = useRef<any>(null);
  const busy = useRef(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    pdfjs().then((m) => m.getDocument({ url: `/api/files/${fileId}/content`, withCredentials: true }).promise).then((d) => {
      if (!live) return d.destroy();
      doc.current = d;
      setTick((t) => t + 1);
    }).catch(() => live && setFailed(true));
    return () => {
      live = false;
      doc.current?.destroy?.();
      doc.current = null;
    };
  }, [fileId]);
  useEffect(() => {
    if (!doc.current || busy.current) return;
    const next = [...want.current].find((i) => !(i in pics));
    if (next === undefined || next >= count) return;
    busy.current = true;
    (async () => {
      try {
        const page = await doc.current.getPage(next + 1);
        const v1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 220 / Math.max(v1.width, v1.height) });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const url = c.toDataURL('image/jpeg', 0.75);
        c.width = c.height = 0;
        setPics((p) => ({ ...p, [next]: url }));
      } catch {
        setPics((p) => ({ ...p, [next]: '' }));
      } finally {
        busy.current = false;
      }
    })();
  }, [pics, tick, count]);
  const ask = (i: number) => {
    if (!want.current.has(i)) (want.current.add(i), setTick((t) => t + 1));
  };
  return { pics, ask, failed };
}

function Thumb({ src, turn, from, onSeen }: { src: string | undefined; turn: number; from: number; onSeen: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  // A turn on its side swaps the picture's width and height, and CSS rotate does not make room for that, so the
  // picture is made smaller until it fits its box again (otherwise a wide page is cut off at the top and bottom).
  const [fit, setFit] = useState(1);
  const measure = () => {
    const b = box.current, i = img.current;
    if (!b || !i || !i.clientWidth || !i.clientHeight) return;
    setFit(turn % 180 ? Math.min(1, b.clientWidth / i.clientHeight, b.clientHeight / i.clientWidth) : 1);
  };
  useEffect(measure, [turn, src]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && onSeen(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onSeen]);
  return (
    <div ref={box} className="pt-pic" aria-hidden="true">
      {src ? <img ref={img} src={src} alt="" onLoad={measure} style={{ transform: `rotate(${turn}deg)${fit < 1 ? ` scale(${fit.toFixed(3)})` : ''}` }} /> : <span className="muted small">{src === '' ? `Page ${from + 1}` : 'Loading'}</span>}
    </div>
  );
}

export function PageTools({ ed, d, onClose }: { ed: Ed; d: any; onClose: () => void }) {
  const name = d.name || 'this file';
  const [ops, setOps] = useState<PageOp[]>([]);
  const [ask, setAsk] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const focusFrom = useRef<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Focus goes into the dialog when it opens, to the first page, and back to the button that opened it when it closes.
  // The opener is the element that had focus when the dialog was first drawn (kept once, so a second run of the effect
  // in development does not take the dialog itself for it).
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-from]')?.focus();
    const back = opener.current;
    return () => {
      setTimeout(() => {
        const at = document.activeElement;
        if (back?.isConnected && (!at || at === document.body)) back.focus();
      }, 0);
    };
  }, []);
  // Tab stays inside the dialog while it is open.
  const keepTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !box.current) return;
    const all = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"], a[href], input, select, textarea')].filter((x) => x.offsetParent !== null);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  // Escape and a tap outside the dialog never throw away changes that are not saved: they say so instead. Cancel is
  // the one way to leave them.
  const UNSAVED = 'Your changes to the pages are not saved yet. Choose Save pages, or Cancel to leave them.';
  const [held, setHeld] = useState(false);
  const softClose = () => {
    if (!ops.length) return onClose();
    setHeld(true);
  };
  const { pics, ask: want, failed } = usePictures(d.file_id, d.pages);
  const planned = useMemo(() => {
    const r = ops.length ? planPages(d.pages, ops) : null;
    return r && !('error' in r) ? r.plan : Array.from({ length: d.pages }, (_, i) => ({ from: i, turn: 0 }));
  }, [ops, d.pages]);

  // After a move, the page that moved keeps the keyboard.
  useEffect(() => {
    if (focusFrom.current == null) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-from="${focusFrom.current}"]`);
    focusFrom.current = null;
    el?.focus();
  }, [planned]);

  const push = (o: PageOp, words: string) => (setOps((l) => [...l, o]), setSaid(words), setAsk(null), setError(''), setHeld(false));
  const turn = (i: number) => push({ op: 'turn', page: i + 1, by: 90 }, `Page ${i + 1} turned.`);
  const remove = (i: number) => planned.length > 1 && push({ op: 'remove', page: i + 1 }, `Page ${i + 1} removed. Undo brings it back.`);
  const move = (i: number, to: number) => {
    if (to < 0 || to >= planned.length || to === i) return;
    focusFrom.current = planned[i].from;
    push({ op: 'move', page: i + 1, to: to + 1 }, `Page ${i + 1} is now page ${to + 1}.`);
  };
  const undo = () => (setOps((l) => l.slice(0, -1)), setSaid('The last change was undone.'), setAsk(null), setHeld(false));
  const one = planned.length === 1;

  async function save(dropOk = false) {
    // Turned all the way round, or moved back: nothing to make.
    if (unchanged(planned, d.pages)) return onClose();
    const { dropped } = moveFields(ed.fields.value, d.id, planned);
    if (dropped.length && !dropOk) {
      const owner = (f: any) => (f.recipient_id ? who(ed.rcps.find((r) => r.id === f.recipient_id)) : null);
      return setAsk(dropped.map((f) => fieldWords(f, owner(f))));
    }
    setBusy(true);
    setError('');
    try {
      const r = await api(`/envelopes/${ed.env.id}/documents/${d.id}/pages`, { body: { ops, save: false, file_id: d.file_id } });
      ed.pagesChanged(d.id, r.file, r.plan);
      onClose();
    } catch (e: any) {
      setError(e?.status ? e.message : 'We could not reach the server, so the pages were not changed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Pages of ${name}`} onClose={softClose} wide>
      <div data-feature="ds-page-tools" ref={box} onKeyDown={keepTab}>
        {/* Dragging also works with a mouse, but is not promised: on a phone the arrows are the way to move a page. */}
        <p className="muted small" style={{ marginTop: -6 }}>{one ? 'Turn the page until it reads the right way up. Nothing changes until you save.' : 'Turn or remove a page, or move it with the arrows. Nothing changes until you save.'}</p>
        {ed.anyLocked && <p className="notice warn small">{ed.lockedNames} already finished. Changing the pages means asking them to sign again. You are asked before anything is saved.</p>}
        {failed && <p className="notice warn small">The pictures of the pages could not be shown. You can still turn, remove and move pages by their numbers.</p>}
        <ol ref={list} className="pt-grid" aria-label={`Pages of ${name}`}>
          {planned.map((p, i) => (
            <li key={p.from} data-from={p.from} tabIndex={0} className={`pt-page${drag === i ? ' dragging' : ''}`}
              aria-label={`Page ${i + 1} of ${planned.length}${p.from !== i ? `, was page ${p.from + 1}` : ''}${p.turn ? ', turned' : ''}.${one ? '' : ' Arrow keys move it.'}`}
              draggable={!one} onDragStart={(e) => (setDrag(i), e.dataTransfer.setData('text/plain', String(i)), (e.dataTransfer.effectAllowed = 'move'))}
              onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => (e.preventDefault(), drag != null && move(drag, i), setDrag(null))}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                const by = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
                if (by) (e.preventDefault(), move(i, i + by));
              }}>
              <Thumb src={pics[p.from]} turn={p.turn} from={p.from} onSeen={() => want(p.from)} />
              <b className="pt-num">Page {i + 1}</b>
              <div className="pt-row">
                <button type="button" className="btn sm" onClick={() => turn(i)} aria-label={`Turn page ${i + 1}`}>Turn</button>
                {planned.length > 1 && <button type="button" className="btn sm" onClick={() => remove(i)} aria-label={`Remove page ${i + 1}`}>Remove</button>}
              </div>
              {planned.length > 1 && (
                <div className="pt-row">
                  <button type="button" className="btn sm" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move page ${i + 1} earlier`}>&larr;</button>
                  <button type="button" className="btn sm" disabled={i === planned.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move page ${i + 1} later`}>&rarr;</button>
                </div>
              )}
            </li>
          ))}
        </ol>
        <p className="ed-sr" role="status" aria-live="polite">{said}</p>
        {ask && (
          <div className="notice warn" role="alert">
            <p style={{ margin: 0 }}>The pages you are removing have {plural(ask.length, 'field')}: {ask.slice(0, 8).join(', ')}{ask.length > 8 ? ` and ${ask.length - 8} more` : ''}. {ask.length === 1 ? 'It goes' : 'They go'} with the page.</p>
            <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
              <button type="button" className="btn danger" disabled={busy} onClick={() => save(true)}>Remove the pages and fields</button>
              <button type="button" className="btn" onClick={() => setAsk(null)}>Go back</button>
            </div>
          </div>
        )}
        {error && <p className="notice warn small" role="alert">{error}</p>}
        {held && ops.length > 0 && <p className="notice warn small" role="alert">{UNSAVED}</p>}
        <div className="actions">
          {ops.length > 0 && <button type="button" className="btn" onClick={undo} disabled={busy}>Undo</button>}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{ops.length ? 'Cancel' : 'Close'}</button>
          {ops.length > 0 && !ask && <button type="button" className="btn primary" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save pages'}</button>}
        </div>
      </div>
    </Modal>
  );
}
