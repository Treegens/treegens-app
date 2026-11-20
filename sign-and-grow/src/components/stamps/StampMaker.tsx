'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { prepare, impression, lookFor, tiltFor, INKS, INK_WORD, INK_RGB, TILT_MAX, type Look, type Prepared, type InkFound, type Ink, type Rgba } from '@/lib/stampink';
import { stampFileProblem, tooManyPixels, turnStyle, STAMP_WORK_SIDE, STAMP_UPLOAD_MAX_PIXELS } from '@/lib/stamps';

// Turns a picture of a stamp into an impression that looks like ink, in this browser, on a canvas: the steps are in
// src/lib/stampink.ts. Shows the picture as it came and the impression on a page of text side by side ("before" and
// "after"), with a plain control for each step. Hands the finished PNG to its parent, which stores it. Drawing the
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
export function OnPaper({ children, label }: { children?: React.ReactNode; label: string }) {
  return (
    <div className="st-paper" role="img" aria-label={label}>
      <p>The goods listed in the schedule were delivered in full and in good condition. Payment is due within thirty days of the date below.</p>
      <p>Signed for and on behalf of the company:</p>
      <div className="st-sigline"><span className="st-sig">J. Mwangi</span></div>
      <p className="st-small">Name and title</p>
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
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<{ png: string; empty: boolean; w: number; h: number; found: InkFound; oval: boolean } | null>(null);
  const [before, setBefore] = useState('');
  const [edges, setEdges] = useState(false);
  const made = useRef(onMade);
  made.current = onMade;

  // Reading the picture: once for each file.
  useEffect(() => {
    let live = true;
    setPrepared(null);
    setResult(null);
    setProblem('');
    setBusy(true);
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
      .catch((e: any) => live && (setProblem(e?.said ? e.message : file.type === 'image/webp' ? `"${file.name}" is a WebP picture, and this browser cannot read WebP. Choose a PNG or JPEG instead.` : `We could not read "${file.name}" as a picture. Choose another picture of the stamp, or take a photo of it.`), setBusy(false)));
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Making the impression: again after every change of a control, a moment after the last one.
  useEffect(() => {
    if (!prepared || !look) return;
    setBusy(true);
    const t = setTimeout(() => {
      const r = impression(prepared, look, undefined, mm && mm > 0 ? mm : undefined);
      const png = r.empty ? '' : toPng(r.image);
      const oval = !!r.oval && Math.abs(Math.log(r.oval.ratio)) > 0.025 && Math.abs(Math.log(r.oval.ratio)) < 0.35;
      setResult({ png, empty: r.empty || prepared.found.empty, w: r.image.width, h: r.image.height, found: r.found, oval });
      setBusy(false);
      made.current(r.empty || prepared.found.empty ? null : { png, look, found: r.found, width: r.image.width, height: r.image.height, from });
    }, 90);
    return () => clearTimeout(t);
  }, [prepared, look, from, mm]);

  if (problem) return <div className="notice err" role="alert">{problem}</div>;
  if (!prepared || !look) return <p className="muted" role="status">Reading the picture</p>;
  const set = (p: Partial<Look>) => setLook((l) => (l ? { ...l, ...p } : l));
  // What was found in the part of the picture that is used (after cutting off its edges).
  const f = result?.found || prepared.found;
  const crop = look.crop || { left: 0, top: 0, right: 0, bottom: 0 };
  // The colour "Only the ... marks" keeps: the ink chosen when the picture has marks in it, or else the main colour.
  const kept = f.colours?.some((c) => c.ink === look.ink && c.hue != null && c.share >= 0.06) ? look.ink : f.ink;
  const keptWord = INK_WORD[kept].toLowerCase();
  const design = !prepared.photo;

  return (
    <div className="st-maker">
      <div className="st-compare">
        <figure>
          <figcaption>Before: your picture</figcaption>
          <OnPaper label="Your picture as it came, pasted on a page of text">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="st-on st-before" src={before} alt="" />
          </OnPaper>
        </figure>
        <figure>
          <figcaption>After: printed like ink</figcaption>
          <OnPaper label={result?.png ? `The stamp in ${INK_WORD[look.ink].toLowerCase()} ink on a page of text. The words under it show through.` : 'No stamp yet'}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {result?.png && <img className="st-on st-ink" src={result.png} alt="" style={turnStyle(look.tilt)} />}
          </OnPaper>
        </figure>
      </div>
      <p className="muted small" role="status" aria-live="polite">{busy ? 'Making the stamp' : result?.empty ? '' : `Ready. ${sizeLabel || ''}`}</p>
      {f.empty && <div className="notice warn" role="alert">We could not find a stamp in this picture: it looks like blank paper. Choose a picture where the stamp is darker than the paper around it.</div>}
      {!f.empty && result?.empty && <div className="notice warn" role="alert">Nothing is left at these settings. Move &ldquo;What counts as paper&rdquo; towards &ldquo;Keep faint marks&rdquo;, or cut less off the edges.</div>}
      {f.several && (
        <p className="notice small">
          This picture has marks in more than one colour, like a logo. A real stamp prints in one ink, so {look.onlyInk && f.hue != null ? <>only the {keptWord} marks are kept, in the ink you choose. To keep every mark, untick &ldquo;Only the {keptWord} marks&rdquo; below.</> : <>every mark is printed in the ink you choose{design && look.gaps ? ', with a thin gap of paper where two colours meet so the shapes stay apart' : ''}.</>}
          {design && <> A logo made for screens often looks less like a real stamp than a design made for one ink. If you have the stamp itself, a photo of it pressed on paper works best.</>}
        </p>
      )}

      <fieldset className="st-inks">
        <legend>Ink{prepared.found.empty ? '' : <span className="hint"> (we found {INK_WORD[prepared.found.ink].toLowerCase()} and chose it for you)</span>}</legend>
        {INKS.map((k: Ink) => (
          <label key={k} className={`st-swatch${look.ink === k ? ' on' : ''}`}>
            <input type="radio" name={`${id}-ink`} value={k} checked={look.ink === k} onChange={() => set({ ink: k })} />
            <span className="st-dot" style={{ background: `rgb(${INK_RGB[k].join(',')})` }} aria-hidden="true" />
            {INK_WORD[k]}
          </label>
        ))}
      </fieldset>

      <div className="st-controls">
        <label className="f st-range">
          <span>What counts as paper</span>
          <input type="range" min={0} max={100} value={Math.round(look.paper * 100)} onChange={(e) => set({ paper: Number(e.target.value) / 100 })} aria-describedby={`${id}-paper`} />
          <span id={`${id}-paper`} className="st-ends muted small"><span>Keep faint marks</span><span>Take more away</span></span>
        </label>
        <label className="f st-range">
          <span>Rubber texture</span>
          <input type="range" min={0} max={100} value={Math.round(look.texture * 100)} onChange={(e) => set({ texture: Number(e.target.value) / 100 })} aria-describedby={`${id}-tex`} />
          <span id={`${id}-tex`} className="st-ends muted small"><span>Even ink</span><span>A well-worn stamp</span></span>
        </label>
        <div className="f st-range">
          <label htmlFor={`${id}-tilt`}>Tilt: {look.tilt === 0 ? 'straight' : `${Math.abs(look.tilt).toFixed(1)} degrees ${look.tilt > 0 ? 'clockwise' : 'anticlockwise'}`}</label>
          <input id={`${id}-tilt`} type="range" min={-TILT_MAX * 10} max={TILT_MAX * 10} value={Math.round(look.tilt * 10)} onChange={(e) => set({ tilt: Number(e.target.value) / 10 })} />
          <div className="row st-row">
            <button type="button" className="btn sm" onClick={() => set({ tilt: 0 })} disabled={look.tilt === 0}>Straight</button>
            <button type="button" className="btn sm" onClick={() => { const seed = newSeed(); set({ seed, tilt: tiltFor(seed) }); }}>A different look</button>
          </div>
        </div>
        {f.hue != null && (
          <label className="check st-check">
            <input type="checkbox" checked={look.onlyInk} onChange={(e) => set({ onlyInk: e.target.checked })} />
            <span>Only the {keptWord} marks <span className="hint">(leaves out printed black text and lines in other colours around the stamp)</span></span>
          </label>
        )}
        {design && f.several && !look.onlyInk && (
          <label className="check st-check">
            <input type="checkbox" checked={!!look.gaps} onChange={(e) => set({ gaps: e.target.checked })} />
            <span>Keep the shapes apart <span className="hint">(a thin gap of paper where two colours meet, so a shape inside another does not vanish in one ink)</span></span>
          </label>
        )}
        {result?.oval && (
          <label className="check st-check">
            <input type="checkbox" checked={!!look.round} onChange={(e) => set({ round: e.target.checked })} />
            <span>Make it round <span className="hint">(the stamp looks like an oval, as a round seal does in a photo taken at a slant)</span></span>
          </label>
        )}
        <details className="st-edges" open={edges} onToggle={(e) => setEdges((e.target as HTMLDetailsElement).open)}>
          <summary>Cut off the edges of the picture</summary>
          <p className="muted small">For a photo with something else in it, such as other writing or the edge of a table.</p>
          {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
            <label key={side} className="f st-range">
              <span>{side[0].toUpperCase() + side.slice(1)}: {Math.round(crop[side] * 100)} percent</span>
              <input type="range" min={0} max={45} value={Math.round(crop[side] * 100)} onChange={(e) => set({ crop: { ...crop, [side]: Number(e.target.value) / 100 } })} />
            </label>
          ))}
        </details>
      </div>
    </div>
  );
}
