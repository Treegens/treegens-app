'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './sign/Dialog';
import { adoptLine } from '@/lib/policy';
import { handwritingWrites } from '@/lib/scripts';
import { drawnProblem, inkShare, pictureProblem, onePen, twoFingers, PEN_WIDTH } from '@/lib/ink';

const STYLES = ['Sig Dancing', 'Sig Caveat', 'Sig Vibes', 'Sig Sacramento'];
// The handwriting fonts have Latin letters only. A name with none of them is typed in the device's own plain font:
// one style, said as such, instead of four buttons that would all show the same picture.
const PLAIN = 'system-ui, sans-serif';
const INK = '#10243a';
// The server stores signatures up to 700,000 characters. Stay well inside that.
const MAX_CHARS = 600_000;
type Point = { x: number; y: number };
type Tab = 'saved' | 'type' | 'draw' | 'upload';
const MAKE: [Tab, string][] = [['type', 'Type'], ['draw', 'Draw'], ['upload', 'Upload']];
/** A signature that was not made in this tab: saved with this document on another device, or kept on the person's account. */
export type SavedMark = { image: string; from: 'document' | 'account' };

// Trim transparent margins so the signature fills its field.
function trim(src: HTMLCanvasElement): string | null {
  const ctx = src.getContext('2d')!;
  const { width: w, height: h } = src;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 6;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + pad * 2;
  out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d')!.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out.toDataURL('image/png');
}

function typed(text: string, family: string): string | null {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 220;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  let size = 110;
  do {
    ctx.font = `${size}px ${family}`;
    size -= 6;
  } while (ctx.measureText(text).width > 860 && size > 24);
  // A name whose first letter is Arabic or Hebrew is laid out as right-to-left text, so a number or a Latin word in
  // it stands on the correct side. It is still drawn from the left edge: the picture is trimmed afterwards.
  ctx.direction = /^[^\p{L}]*[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u.test(text) ? 'rtl' : 'ltr';
  ctx.textAlign = 'left';
  ctx.fillText(text, 20, 110);
  return trim(c);
}

// A photo of a signature can be large. Shrink it until it is small enough to store, so finishing never fails on size.
function fitImage(img: HTMLImageElement): string {
  let scale = Math.min(1, 900 / img.width, 400 / img.height);
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const png = c.toDataURL('image/png');
    if (png.length <= MAX_CHARS) return png;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    const jpeg = c.toDataURL('image/jpeg', 0.85);
    if (jpeg.length <= MAX_CHARS) return jpeg;
    scale *= 0.7;
  }
  return '';
}

// How much of a picture is ink, read from a small copy of it (300 px at most across is plenty to tell).
function inkOf(img: HTMLImageElement): number {
  const k = Math.min(1, 300 / Math.max(img.width, img.height, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return inkShare(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Point[]) {
  if (!s.length) return;
  ctx.beginPath();
  if (s.length === 1) {
    ctx.arc(s[0].x, s[0].y, 1.3, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(s[0].x, s[0].y);
  for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
  ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y);
  ctx.stroke();
}

// `saved` is a stored signature the person may want to use again. It is never put on the page by itself: it is
// shown here first, as the first choice, and only used when the person confirms it with the button.
export function AdoptSignature({ kind, name, saved, onDone, onClose }: { kind: 'signature' | 'initials'; name: string; saved?: SavedMark | null; onDone: (png: string) => void; onClose: () => void }) {
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 4).toUpperCase();
  const word = kind === 'signature' ? 'signature' : 'initials';
  const TABS: [Tab, string][] = saved ? [['saved', 'Saved'], ...MAKE] : MAKE;
  const [tab, setTab] = useState<Tab>(saved ? 'saved' : 'type');
  const [text, setText] = useState(kind === 'signature' ? name : initials);
  const [font, setFont] = useState(STYLES[0]);
  const [error, setError] = useState('');
  const [inked, setInked] = useState(false);
  const [photo, setPhoto] = useState('');
  const pad = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const size = useRef({ w: 0, h: 0 });
  const ids = useId();

  useEffect(() => {
    // Make sure the handwriting fonts are ready before they are drawn to a canvas.
    STYLES.forEach((f) => document.fonts?.load(`40px '${f}'`).catch(() => {}));
  }, []);

  function paint() {
    const c = pad.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    // Turning the phone changes the size of the pad. Keep what was drawn, scaled to fit.
    if (size.current.w && (w !== size.current.w || h !== size.current.h)) {
      const k = Math.min(w / size.current.w, h / size.current.h, 1);
      if (k < 1) strokes.current = strokes.current.map((s) => s.map((p) => ({ x: p.x * k, y: p.y * k })));
    }
    size.current = { w, h };
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = PEN_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    strokes.current.forEach((s) => drawStroke(ctx, s));
    return ctx;
  }

  useEffect(() => {
    if (tab !== 'draw' || !pad.current) return;
    const c = pad.current;
    let ctx = paint()!;
    let live: Point[] | null = null;
    // One finger at a time: a second one takes the line under way away (onePen in src/lib/ink.ts).
    const pens = onePen();
    const at = (e: PointerEvent): Point => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if (e.button > 0) return;
      e.preventDefault();
      const what = pens.down(e.pointerId, e.pointerType, e.isPrimary);
      if (what === 'drop') {
        if (live) strokes.current = strokes.current.filter((s) => s !== live);
        live = null;
        ctx = paint()!;
        setInked(strokes.current.length > 0);
        return setError(twoFingers(kind));
      }
      if (what !== 'draw') return;
      c.setPointerCapture(e.pointerId);
      live = [at(e)];
      strokes.current.push(live);
      drawStroke(ctx, live);
      setInked(true);
      setError('');
    };
    const move = (e: PointerEvent) => {
      if (!live || !pens.move(e.pointerId)) return;
      for (const ev of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) {
        const p = at(ev), last = live[live.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.6) continue;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        live.push(p);
      }
    };
    const up = (e: PointerEvent) => {
      if (!pens.up(e.pointerId) || !live) return;
      live = null;
      ctx = paint()!; // redraw with smoothed curves
    };
    const ro = new ResizeObserver(() => {
      if (c.clientWidth && (c.clientWidth !== size.current.w || c.clientHeight !== size.current.h)) ctx = paint()!;
    });
    ro.observe(c);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    return () => {
      ro.disconnect();
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const clear = () => {
    strokes.current = [];
    paint();
    setInked(false);
  };
  const undo = () => {
    strokes.current.pop();
    paint();
    setInked(strokes.current.length > 0);
  };

  async function adopt() {
    setError('');
    let image: string | null = null;
    if (tab === 'saved') image = saved?.image || null;
    else if (tab === 'type') {
      if (!text.trim()) return setError(kind === 'signature' ? 'Type your name first.' : 'Type your initials first.');
      await document.fonts?.load(`110px '${font}'`, text).catch(() => {});
      image = typed(text.trim(), handwritingWrites(text) ? `'${font}', cursive` : PLAIN);
      if (!image) return setError('Type at least one letter or number, then try again.');
    } else if (tab === 'draw') {
      // A tap or a speck is not a signature: refused in words before it goes on the page (src/lib/ink.ts).
      const wrong = drawnProblem(strokes.current, size.current, kind);
      if (wrong) return setError(wrong);
      image = strokes.current.length && pad.current ? trim(pad.current) : null;
      if (!image) return setError(`Draw your ${word} in the box first.`);
    } else {
      if (!photo) return setError('Choose a picture first.');
      image = photo;
    }
    if (!image) return setError(`Choose Type, Draw or Upload to make your ${word}.`);
    onDone(image);
  }

  function upload(file?: File) {
    if (!file) return;
    setError('');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // A blank photo or a solid block is refused the same way as a tap on the pad.
      const wrong = pictureProblem(inkOf(img), kind);
      if (wrong) return (setPhoto(''), setError(wrong));
      const fitted = fitImage(img);
      if (fitted) setPhoto(fitted);
      else setError('That picture is too detailed to use. Try a smaller one, or draw or type instead.');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError('That file could not be read as a picture. Choose a PNG or JPEG, or draw or type instead.');
    };
    img.src = url;
  }

  function tabKey(e: React.KeyboardEvent) {
    const i = TABS.findIndex(([t]) => t === tab), n = TABS.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next][0]);
    setError('');
    document.getElementById(`${ids}-${TABS[next][0]}`)?.focus();
  }

  return (
    <Dialog title={kind === 'signature' ? 'Adopt your signature' : 'Adopt your initials'} onClose={onClose} wide variant="field">
      <div className="tabs sg-sigtabs" role="tablist" aria-label={`How to make your ${word}`} onKeyDown={tabKey}>
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={`${ids}-${t}`} aria-selected={tab === t} aria-controls={`${ids}-panel`} tabIndex={tab === t ? 0 : -1} className={tab === t ? 'on' : ''} onClick={() => (setTab(t), setError(''))}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab}`}>
        {tab === 'saved' && saved && (
          <div>
            <div className="sg-sigpreview"><img src={saved.image} alt={`Your saved ${word}`} /></div>
            <p className="muted small">
              {saved.from === 'account'
                ? `This is the ${word} saved on your Sign&Grow account. Nothing is on the document yet.`
                : `This is the ${word} you chose for this document earlier, on another device or in another tab.`}
              {' '}Use {kind === 'signature' ? 'it only if it is' : 'them only if they are'} yours and you want {kind === 'signature' ? 'it' : 'them'} here. Otherwise make a new one with Type, Draw or Upload.
            </p>
          </div>
        )}
        {tab === 'type' && (
          <div className="stack">
            <label className="f"><span>{kind === 'signature' ? 'Full name' : 'Initials'}</span><input dir="auto" value={text} onChange={(e) => setText(e.target.value)} maxLength={60} autoComplete="off" /></label>
            {handwritingWrites(text) ? (
              <div className="grid g2 sg-sigstyles" role="group" aria-label="Choose a style">
                {STYLES.map((f, i) => (
                  <button key={f} type="button" className={`sigstyle${font === f ? ' on' : ''}`} style={{ fontFamily: `'${f}', cursive` }} onClick={() => setFont(f)} aria-pressed={font === f} aria-label={`Style ${i + 1}: ${text || 'Your name'}`}>
                    {text || 'Your name'}
                  </button>
                ))}
              </div>
            ) : (
              <div className="sg-sigplain">
                <div className="sigstyle on" style={{ fontFamily: PLAIN }} role="img" aria-label={`Your ${word} in plain letters: ${text}`}><bdi>{text}</bdi></div>
                <p className="muted small">Our handwriting styles only have Latin letters, so this is shown in one plain style. For a handwritten look, choose Draw or Upload.</p>
              </div>
            )}
          </div>
        )}
        {tab === 'draw' && (
          <div>
            <div className="sg-padwrap">
              <canvas ref={pad} className="sigpad" role="img" aria-label={inked ? `Your drawn ${word}` : `Empty box to draw your ${word} in`} />
              {!inked && <span className="sg-padhint" aria-hidden="true">Draw here</span>}
            </div>
            <div className="row between sg-padrow">
              <span className="muted small">Use a finger, stylus or mouse.</span>
              <span className="row">
                <button type="button" className="btn sm" onClick={undo} disabled={!inked}>Undo</button>
                <button type="button" className="btn sm" onClick={clear} disabled={!inked}>Clear</button>
              </span>
            </div>
          </div>
        )}
        {tab === 'upload' && (
          <div>
            {photo && <div className="sg-sigpreview"><img src={photo} alt={`The picture you chose for your ${word}`} /></div>}
            <label className="drop sg-drop">
              <input type="file" className="sg-vh" accept="image/png,image/jpeg" onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
              <b>{photo ? 'Choose a different picture' : `Choose a photo or scan of your ${word}`}</b>
              <span className="muted small">PNG or JPEG. Dark ink on white paper works best.</span>
            </label>
          </div>
        )}
      </div>
      {/* Pinned to the bottom of the dialog (signphone.css): on a phone held sideways, or with large text, the box
          to draw in fills the screen, and the buttons, the sentence they agree to and any problem stay in view. */}
      <div className="sg-adopt-foot">
        {error && <div className="notice err sg-problem" role="alert">{error}</div>}
        <p className="muted small sg-siglegal">
          By choosing {tab === 'saved' ? `Use ${kind === 'signature' ? 'this signature' : 'these initials'}` : 'Adopt and sign'}, {adoptLine(word)}
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={adopt}>{tab === 'saved' ? `Use ${kind === 'signature' ? 'this signature' : 'these initials'}` : 'Adopt and sign'}</button>
        </div>
      </div>
    </Dialog>
  );
}
