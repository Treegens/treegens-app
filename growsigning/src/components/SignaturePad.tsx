'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from './sign/Dialog';
import { adoptLine } from '@/lib/policy';
import { handwritingWrites } from '@/lib/scripts';
import { drawnProblem, inkShare, pictureProblem, onePen, twoFingers, PEN_WIDTH } from '@/lib/ink';
import { DRAWING_IS } from '@/lib/fieldkinds';
import { waysLimited, type SignWay } from '@/lib/switches';
import { fitLabel, pictureLooksCut, trimInk, typedMark, TYPED_INK, TYPED_SIZE } from '@/lib/sigmark';

const STYLES = ['Sig Dancing', 'Sig Caveat', 'Sig Vibes', 'Sig Sacramento'];
// The handwriting fonts have Latin letters only. A name with none of them is typed in the device's own plain font:
// one style, said as such, instead of four buttons that would all show the same picture.
const PLAIN = 'system-ui, sans-serif';
// The style the person chose last, so their initials open in the same handwriting as their signature (and the other
// way round) without another tap. Kept for this visit only: in memory, and in the tab's own storage across a reload.
const STYLE_KEY = 'gs-sig-style';
let lastStyle = '';
function rememberedStyle(): string {
  if (!lastStyle) {
    try {
      lastStyle = sessionStorage.getItem(STYLE_KEY) || '';
    } catch {}
  }
  return STYLES.includes(lastStyle) ? lastStyle : STYLES[0];
}
function rememberStyle(f: string) {
  lastStyle = f;
  try {
    sessionStorage.setItem(STYLE_KEY, f);
  } catch {}
}
// A name longer than this gets one style to a row, so all of it can be read before it is chosen.
const LONG_NAME = 22;

/**
 * True when a saved signature picture looks cut off at an edge (looksCut in src/lib/sigmark.ts): one typed before
 * the letters were measured lost the tail of a "j" there. Such a picture is not offered as the first choice.
 */
export function useLooksCut(image?: string | null): boolean {
  const [cut, setCut] = useState(false);
  useEffect(() => {
    let on = true;
    setCut(false);
    if (image) pictureLooksCut(image).then((c) => on && setCut(c));
    return () => {
      on = false;
    };
  }, [image]);
  return cut;
}
const INK = TYPED_INK;
// The server stores signatures up to 700,000 characters. Stay well inside that.
const MAX_CHARS = 600_000;
type Point = { x: number; y: number };
type Tab = 'saved' | 'type' | 'draw' | 'upload';
const MAKE: [Tab, string][] = [['type', 'Type'], ['draw', 'Draw'], ['upload', 'Upload']];
/** A signature that was not made in this tab: saved with this document on another device, or kept on the person's account. */
export type SavedMark = { image: string; from: 'document' | 'account' };

// Typed and drawn marks become pictures in src/lib/sigmark.ts: all of the ink, tails of letters included, with a
// little clear space on every side, so the picture is never cut off at an edge and fills its field.

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
// The dialog is called "Your signature" and its button "Sign" (research/ux-charter.md, section 4: no "adopt").
// `doneLabel` is the button where nothing is signed, such as "Save" in Settings. `onDone` also gets the name that was
// typed, when the signature was typed: the signing page compares it with the name on the document.
// kind "drawing": the same box to draw in, for a Drawing field (src/lib/fieldkinds.ts). Only Draw, no style, and none
// of the words about signing: a drawing is a picture, never a signature.
// `ways`: the ways the account offers (Settings, Sending, src/lib/switches.ts), all three when left out. With fewer,
// a saved signature is not offered: nobody can say how it was made. `onDone` also gets how it was made ("type:<style>",
// "draw", "upload" or "saved"), which the certificate prints.
export function AdoptSignature({ kind: asked, name, saved: savedIn, onDone, onClose, doneLabel, ways }: { kind: 'signature' | 'initials' | 'drawing'; name: string; saved?: SavedMark | null; onDone: (png: string, typedText?: string, how?: string) => void; onClose: () => void; doneLabel?: string; ways?: readonly SignWay[] }) {
  const saved = ways && waysLimited(ways) ? null : savedIn;
  const make = ways ? MAKE.filter(([t]) => (ways as readonly string[]).includes(t)) : MAKE;
  const drawing = asked === 'drawing';
  const kind = asked === 'drawing' ? 'signature' : asked;
  // A drawing's button is its own (doneLabel from sign/KindFields.tsx: "Put it on the page").
  const sign = doneLabel || (kind === 'signature' ? 'Sign' : 'Add initials');
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 4).toUpperCase();
  // Typed as the two marks adoptLine knows: "drawing" is only ever put into sentences, and a drawing has no adoptLine.
  const word = (drawing ? 'drawing' : kind === 'signature' ? 'signature' : 'initials') as 'signature' | 'initials';
  // A saved picture that looks cut off at an edge is not the first choice: the dialog opens on making a fresh one,
  // says why in one line, and keeps the saved one as the last tab for the person who wants it as it is.
  const cut = useLooksCut(saved?.image) && !!make.length;
  const TABS: [Tab, string][] = drawing ? [['draw', 'Draw']] : saved ? (cut ? [...make, ['saved', 'Saved']] : [['saved', 'Saved'], ...make]) : make;
  const [tab, setTab] = useState<Tab>(drawing ? 'draw' : saved ? 'saved' : make[0]?.[0] || 'type');
  const touched = useRef(false);
  useEffect(() => {
    if (cut && !touched.current) setTab(make[0][0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cut]);
  const [text, setText] = useState(kind === 'signature' ? name : initials);
  const [font, setFont] = useState(rememberedStyle);
  const styles = useRef<HTMLDivElement>(null);
  // A long name is shown whole in each style, in smaller letters, instead of ending in "…".
  useLayoutEffect(() => {
    const fit = () => styles.current?.querySelectorAll<HTMLElement>('.sigstyle').forEach((b) => fitLabel(b));
    fit();
    let on = true;
    document.fonts?.ready.then(() => on && fit()).catch(() => {});
    window.addEventListener('resize', fit);
    return () => {
      on = false;
      window.removeEventListener('resize', fit);
    };
  }, [text, tab]);
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
      await document.fonts?.load(`${TYPED_SIZE}px '${font}'`, text).catch(() => {});
      image = typedMark(text.trim(), handwritingWrites(text) ? `'${font}', cursive` : PLAIN);
      if (!image) return setError('Type at least one letter or number, then try again.');
      if (handwritingWrites(text)) rememberStyle(font);
    } else if (tab === 'draw') {
      // A tap or a speck is not a signature: refused in words before it goes on the page (src/lib/ink.ts). A drawing
      // may be anything the person draws.
      const wrong = drawing ? '' : drawnProblem(strokes.current, size.current, kind);
      if (wrong) return setError(wrong);
      image = strokes.current.length && pad.current ? trimInk(pad.current) : null;
      if (!image) return setError(`Draw your ${word} in the box first.`);
    } else {
      if (!photo) return setError('Choose a picture first.');
      image = photo;
    }
    if (!image) return setError(`Choose Type, Draw or Upload to make your ${word}.`);
    onDone(image, tab === 'type' ? text.trim() : undefined, tab === 'type' ? `type:${handwritingWrites(text) ? font : 'plain'}` : tab);
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
    touched.current = true;
    setTab(TABS[next][0]);
    setError('');
    document.getElementById(`${ids}-${TABS[next][0]}`)?.focus();
  }

  return (
    <Dialog title={kind === 'signature' ? 'Your signature' : 'Your initials'} {...(drawing ? { title: 'Your drawing' } : {})} onClose={onClose} wide variant="field">
      {/* One way only (Settings, Sending): no row of tabs with a single tab in it, the box itself. */}
      {(drawing || TABS.length > 1) && <div className="tabs sg-sigtabs" role="tablist" aria-label={`How to make your ${word}`} onKeyDown={tabKey}>
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={`${ids}-${t}`} aria-selected={tab === t} aria-controls={`${ids}-panel`} tabIndex={tab === t ? 0 : -1} className={tab === t ? 'on' : ''} onClick={() => ((touched.current = true), setTab(t), setError(''))}>{label}</button>
        ))}
      </div>}
      <div {...(drawing || TABS.length > 1 ? { role: 'tabpanel', 'aria-labelledby': `${ids}-${tab}` } : {})} id={`${ids}-panel`}>
        {cut && <p className="notice warn small sg-sigcut" role="status">Your saved {word} {kind === 'signature' ? 'was' : 'were'} cut off at the edge. {tab === 'saved' ? 'Type, Draw or Upload makes a whole one.' : `Here is a fresh one: choose ${sign} to use it.`}</p>}
        {tab === 'saved' && saved && (
          <div>
            <div className="sg-sigpreview"><img src={saved.image} alt={`Your saved ${word}`} /></div>
            <p className="muted small">
              {saved.from === 'account'
                ? `This is the ${word} saved on your GrowSigning account. Nothing is on the document yet.`
                : `This is the ${word} you chose for this document earlier, on another device or in another tab.`}
              {' '}Use {kind === 'signature' ? 'it only if it is' : 'them only if they are'} yours and you want {kind === 'signature' ? 'it' : 'them'} here. Otherwise make a new one with Type, Draw or Upload.
            </p>
          </div>
        )}
        {tab === 'type' && (
          <div className="stack">
            <label className="f"><span>{kind === 'signature' ? 'Full name' : 'Initials'}</span><input dir="auto" value={text} onChange={(e) => setText(e.target.value)} maxLength={60} autoComplete="off" /></label>
            {handwritingWrites(text) ? (
              <div ref={styles} className={`grid g2 sg-sigstyles${text.trim().length > LONG_NAME ? ' long' : ''}`} role="group" aria-label="Choose a style">
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
        {drawing ? <p className="muted small sg-siglegal">{DRAWING_IS}</p> : <p className="muted small sg-siglegal">
          By choosing {tab === 'saved' ? `Use ${kind === 'signature' ? 'this signature' : 'these initials'}` : sign}, {adoptLine(word)}
        </p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={adopt}>{tab === 'saved' ? `Use ${kind === 'signature' ? 'this signature' : 'these initials'}` : sign}</button>
        </div>
      </div>
    </Dialog>
  );
}
