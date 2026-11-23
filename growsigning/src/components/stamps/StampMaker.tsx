'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { prepare, impression, lookFor, tiltFor, INKS, INK_RGB, TILT_MAX, FINE_WARN_SHARE, FINE_WARN_TEXTURE, type Look, type Prepared, type InkFound, type Ink, type Rgba } from '@/lib/stampink';
import { stampFileProblem, tooManyPixels, turnStyle, STAMP_WORK_SIDE, STAMP_UPLOAD_MAX_PIXELS } from '@/lib/stamps';
import { useStampT } from './words';

// Turns a picture of a stamp into an impression that looks like ink, in this browser, on a canvas: the steps are in
// src/lib/stampink.ts. Shows the picture as it came and the impression on a page of text side by side ("before" and
// "after"), then the ink, and every other adjustment behind one closed fold ("Adjust the look"): the defaults are
// meant to be right, so nobody has to pass them to finish. Hands the finished PNG to its parent, which stores it. Drawing the
// picture onto a canvas and saving it again also leaves out what the file carried besides its pixels (the camera's
// notes, the place a photo was taken).

export type Made = { png: string; look: Look; found: InkFound; width: number; height: number; from: 'upload' | 'camera' };

const newSeed = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483645);

/** The picture's pixels, at most STAMP_WORK_SIDE on its longer side, turned the way the camera held it. */
async function readPicture(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, no) => {
      img.onload = () => ok();
      img.onerror = () => no(new Error('unreadable'));
      img.src = url;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('unreadable');
    if (w * h > STAMP_UPLOAD_MAX_PIXELS) throw Object.assign(new Error(tooManyPixels(w, h)), { said: true });
    const k = Math.min(1, STAMP_WORK_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toPng(img: Rgba): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toDataURL('image/png');
}

/** A short piece of a printed page, to see the stamp on. Words under the stamp show through it, as on paper. */
export function OnPaper({ children, label, className }: { children?: React.ReactNode; label: string; className?: string }) {
  const T = useStampT();
  return (
    <div className={`st-paper${className ? ` ${className}` : ''}`} role="img" aria-label={label}>
      <p>{T('stamps.paper.p1')}</p>
      <p>{T('stamps.paper.p2')}</p>
      <div className="st-sigline"><span className="st-sig">{T('stamps.paper.sample_name')}</span></div>
      <p className="st-small">{T('stamps.paper.name_title')}</p>
      {children}
    </div>
  );
}

export function StampMaker({ file, from, onMade, sizeLabel, mm }: {
  file: File;
  from: 'upload' | 'camera';
  /** The finished impression whenever it changes, or null while it is being made or when there is none. */
  onMade: (m: Made | null) => void;
  /** Said under the "after" picture, such as "At its real size of 40 mm across". */
  sizeLabel?: string;
  /** The size it prints at, in mm across its longer side, which sizes its texture. 40 when not known. */
  mm?: number;
}) {
  const id = useId();
  const T = useStampT();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<{ png: string; empty: boolean; w: number; h: number; found: InkFound; oval: boolean; fine: number } | null>(null);
  const [before, setBefore] = useState('');
  // The fold with every adjustment but the ink: closed each time a picture is read.
  const [adjust, setAdjust] = useState(false);
  // A design with thin lines at its size is printed with even ink from the start, once for each picture, and the
  // person is told so (the simplicity reviewer: a good default rather than a setting to fix). 'pending' until the first
  // impression of a picture is measured.
  const evenFirst = useRef<'pending' | 'done'>('pending');
  const [evened, setEvened] = useState(false);
  const made = useRef(onMade);
  made.current = onMade;

  // Reading the picture: once for each file.
  useEffect(() => {
    let live = true;
    setPrepared(null);
    setResult(null);
    setProblem('');
    setBusy(true);
    setAdjust(false);
    evenFirst.current = 'pending';
    setEvened(false);
    made.current(null);
    const said = stampFileProblem(file, true);
    if (said) return (setProblem(said), setBusy(false));
    const url = URL.createObjectURL(file);
    setBefore(url);
    readPicture(file)
      .then((px) => new Promise<Prepared>((ok) => setTimeout(() => ok(prepare(px)), 0)))
      .then((p) => {
        if (!live) return;
        setPrepared(p);
        setLook(lookFor(newSeed(), p.found.ink, p));
      })
      .catch((e: any) => live && (setProblem(e?.said ? e.message : file.type === 'image/webp' ? T('stamps.webp', { file: file.name }) : T('stamps.unreadable', { file: file.name })), setBusy(false)));
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Making the impression: again after every change of a control, a moment after the last one.
  useEffect(() => {
    if (!prepared || !look) return;
    setBusy(true);
    const t = setTimeout(() => {
      const r = impression(prepared, look, undefined, mm && mm > 0 ? mm : undefined);
      const png = r.empty ? '' : toPng(r.image);
      const oval = !!r.oval && Math.abs(Math.log(r.oval.ratio)) > 0.025 && Math.abs(Math.log(r.oval.ratio)) < 0.35;
      setResult({ png, empty: r.empty || prepared.found.empty, w: r.image.width, h: r.image.height, found: r.found, oval, fine: r.fine || 0 });
      setBusy(false);
      if (evenFirst.current === 'pending') {
        evenFirst.current = 'done';
        if (!r.empty && (r.fine || 0) >= FINE_WARN_SHARE && look.texture > FINE_WARN_TEXTURE) {
          setEvened(true);
          setLook((l) => (l ? { ...l, texture: FINE_WARN_TEXTURE } : l));
          return;
        }
      }
      // Nothing left at these settings: the controls that bring it back are shown.
      if (r.empty && !prepared.found.empty) setAdjust(true);
      made.current(r.empty || prepared.found.empty ? null : { png, look, found: r.found, width: r.image.width, height: r.image.height, from });
    }, 90);
    return () => clearTimeout(t);
  }, [prepared, look, from, mm]);

  if (problem) return <div className="notice err" role="alert">{problem}</div>;
  if (!prepared || !look) return <p className="muted" role="status">{T('stamps.reading')}</p>;
  const set = (p: Partial<Look>) => setLook((l) => (l ? { ...l, ...p } : l));
  // What was found in the part of the picture that is used (after cutting off its edges).
  const f = result?.found || prepared.found;
  const crop = look.crop || { left: 0, top: 0, right: 0, bottom: 0 };
  // The colour "Only the ... marks" keeps: the ink chosen when the picture has marks in it, or else the main colour.
  const kept = f.colours?.some((c) => c.ink === look.ink && c.hue != null && c.share >= 0.06) ? look.ink : f.ink;
  const keptWord = T.inkLower(kept);
  const design = !prepared.photo;

  return (
    <div className="st-maker">
      <div className="st-compare">
        <figure>
          <figcaption>{T('stamps.before')}</figcaption>
          <OnPaper label={T('stamps.before_label')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="st-on st-before" src={before} alt="" />
          </OnPaper>
        </figure>
        <figure>
          <figcaption>{T('stamps.after')}</figcaption>
          <OnPaper label={result?.png ? T('stamps.after_label', { ink: T.inkLower(look.ink) }) : T('stamps.no_stamp_yet')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {result?.png && <img className="st-on st-ink" src={result.png} alt="" style={turnStyle(look.tilt)} />}
          </OnPaper>
        </figure>
      </div>
      <p className="muted small" role="status" aria-live="polite">{busy ? T('stamps.making') : result?.empty ? '' : T('stamps.ready', { size: sizeLabel || '' }).trim()}</p>
      {f.empty && <div className="notice warn" role="alert">{T('stamps.blank')}</div>}
      {/* Small type and hairline rings at this size: the rubber texture breaks them into specks (fineShare in stampink.ts). */}
      {!busy && result && !result.empty && evened && look.texture <= FINE_WARN_TEXTURE && (
        <p className="notice small st-fine">{T('stamps.evened')}</p>
      )}
      {!busy && result && !result.empty && result.fine >= FINE_WARN_SHARE && look.texture > FINE_WARN_TEXTURE && (
        <p className="notice small st-fine">{T('stamps.fine')}</p>
      )}
      {!f.empty && result?.empty && <div className="notice warn" role="alert">{T('stamps.nothing_left')}</div>}
      {f.several && (
        <p className="notice small">
          {design ? T('stamps.several_design') : T('stamps.several_photo')} {look.onlyInk && f.hue != null ? T('stamps.only_kept', { ink: keptWord }) : design && look.gaps ? T('stamps.every_mark_gaps') : T('stamps.every_mark')}
          {design && <> {T('stamps.logo_note')}</>}
        </p>
      )}

      <fieldset className="st-inks">
        <legend>{T('stamps.ink_legend')}{prepared.found.empty ? '' : <span className="hint"> {T('stamps.ink_found', { ink: T.inkLower(prepared.found.ink) })}</span>}</legend>
        {INKS.map((k: Ink) => (
          <label key={k} className={`st-swatch${look.ink === k ? ' on' : ''}`}>
            <input type="radio" name={`${id}-ink`} value={k} checked={look.ink === k} onChange={() => set({ ink: k })} />
            <span className="st-dot" style={{ background: `rgb(${INK_RGB[k].join(',')})` }} aria-hidden="true" />
            {T.ink(k)}
          </label>
        ))}
      </fieldset>

      <details className="st-adjust" data-fold open={adjust} onToggle={(e) => setAdjust((e.target as HTMLDetailsElement).open)}>
      <summary>{T('stamps.adjust')}</summary>
      <div className="st-controls">
        <label className="f st-range">
          <span id={`${id}-paper-l`}>{T('stamps.paper_label')}</span>
          <input type="range" min={0} max={100} value={Math.round(look.paper * 100)} onChange={(e) => set({ paper: Number(e.target.value) / 100 })} aria-labelledby={`${id}-paper-l`} aria-describedby={`${id}-paper`} />
          <span id={`${id}-paper`} className="st-ends muted small"><span>{T('stamps.paper_keep')}</span><span>{T('stamps.paper_more')}</span></span>
        </label>
        <label className="f st-range">
          <span id={`${id}-tex-l`}>{T('stamps.texture_label')}</span>
          <input type="range" min={0} max={100} value={Math.round(look.texture * 100)} onChange={(e) => set({ texture: Number(e.target.value) / 100 })} aria-labelledby={`${id}-tex-l`} aria-describedby={`${id}-tex`} />
          <span id={`${id}-tex`} className="st-ends muted small"><span>{T('stamps.texture_even')}</span><span>{T('stamps.texture_worn')}</span></span>
        </label>
        <div className="f st-range">
          <label htmlFor={`${id}-tilt`}>{look.tilt === 0 ? T('stamps.tilt_straight') : T(look.tilt > 0 ? 'stamps.tilt_clockwise' : 'stamps.tilt_anticlockwise', { degrees: Math.abs(look.tilt).toFixed(1) })}</label>
          <input id={`${id}-tilt`} type="range" min={-TILT_MAX * 10} max={TILT_MAX * 10} value={Math.round(look.tilt * 10)} onChange={(e) => set({ tilt: Number(e.target.value) / 10 })} />
          <div className="row st-row">
            <button type="button" className="btn sm" onClick={() => set({ tilt: 0 })} disabled={look.tilt === 0}>{T('stamps.straight')}</button>
            <button type="button" className="btn sm" onClick={() => { const seed = newSeed(); set({ seed, tilt: tiltFor(seed) }); }}>{T('stamps.different_look')}</button>
          </div>
        </div>
        {f.hue != null && (
          <label className="check st-check">
            <input type="checkbox" checked={look.onlyInk} onChange={(e) => set({ onlyInk: e.target.checked })} />
            <span>{T('stamps.only_ink', { ink: keptWord })} <span className="hint">{T('stamps.only_ink_hint')}</span></span>
          </label>
        )}
        {design && f.several && !look.onlyInk && (
          <label className="check st-check">
            <input type="checkbox" checked={!!look.gaps} onChange={(e) => set({ gaps: e.target.checked })} />
            <span>{T('stamps.gaps')} <span className="hint">{T('stamps.gaps_hint')}</span></span>
          </label>
        )}
        {result?.oval && (
          <label className="check st-check">
            <input type="checkbox" checked={!!look.round} onChange={(e) => set({ round: e.target.checked })} />
            <span>{T('stamps.round')} <span className="hint">{T('stamps.round_hint')}</span></span>
          </label>
        )}
        <fieldset className="st-edges">
          <legend>{T('stamps.edges')}</legend>
          <p className="muted small">{T('stamps.edges_hint')}</p>
          {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
            <label key={side} className="f st-range">
              <span>{T(`stamps.edge.${side}`, { percent: String(Math.round(crop[side] * 100)) })}</span>
              <input type="range" min={0} max={45} value={Math.round(crop[side] * 100)} onChange={(e) => set({ crop: { ...crop, [side]: Number(e.target.value) / 100 } })} />
            </label>
          ))}
        </fieldset>
      </div>
      </details>
    </div>
  );
}
