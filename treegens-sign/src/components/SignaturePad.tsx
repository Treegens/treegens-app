'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';

const STYLES = ['Sig Dancing', 'Sig Caveat', 'Sig Vibes', 'Sig Sacramento'];

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

function typed(text: string, font: string): string | null {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 220;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#10243a';
  ctx.textBaseline = 'middle';
  let size = 110;
  do {
    ctx.font = `${size}px '${font}', cursive`;
    size -= 6;
  } while (ctx.measureText(text).width > 860 && size > 24);
  ctx.fillText(text, 20, 110);
  return trim(c);
}

export function AdoptSignature({ kind, name, onDone, onClose }: { kind: 'signature' | 'initials'; name: string; onDone: (png: string) => void; onClose: () => void }) {
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 4).toUpperCase();
  const [tab, setTab] = useState<'type' | 'draw' | 'upload'>('type');
  const [text, setText] = useState(kind === 'signature' ? name : initials);
  const [font, setFont] = useState(STYLES[0]);
  const [error, setError] = useState('');
  const pad = useRef<HTMLCanvasElement>(null);
  const drew = useRef(false);

  useEffect(() => {
    // Make sure the handwriting fonts are ready before they are drawn to a canvas.
    STYLES.forEach((f) => document.fonts?.load(`40px '${f}'`).catch(() => {}));
  }, []);

  useEffect(() => {
    if (tab !== 'draw' || !pad.current) return;
    const c = pad.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#10243a';
    let last: { x: number; y: number } | null = null;
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      last = pos(e);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = '#10243a';
      ctx.fill();
      drew.current = true;
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.quadraticCurveTo(last.x, last.y, (last.x + p.x) / 2, (last.y + p.y) / 2);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    };
    const up = () => (last = null);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    };
  }, [tab]);

  const clear = () => {
    const c = pad.current;
    if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    drew.current = false;
  };

  async function adopt() {
    setError('');
    let png: string | null = null;
    if (tab === 'type') {
      if (!text.trim()) return setError('Type your name first.');
      await document.fonts?.load(`110px '${font}'`, text).catch(() => {});
      png = typed(text.trim(), font);
    } else if (tab === 'draw') {
      png = drew.current && pad.current ? trim(pad.current) : null;
      if (!png) return setError('Draw your signature in the box first.');
    }
    if (png) onDone(png);
  }

  function upload(file?: File) {
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 900 / img.width, 400 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      onDone(c.toDataURL('image/png'));
    };
    img.onerror = () => setError('That image could not be read.');
    img.src = URL.createObjectURL(file);
  }

  return (
    <Modal title={kind === 'signature' ? 'Adopt your signature' : 'Adopt your initials'} onClose={onClose} wide>
      <div className="tabs">
        {(['type', 'draw', 'upload'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'type' ? 'Type' : t === 'draw' ? 'Draw' : 'Upload'}</button>
        ))}
      </div>
      {tab === 'type' && (
        <div className="stack">
          <label className="f"><span>{kind === 'signature' ? 'Full name' : 'Initials'}</span><input value={text} onChange={(e) => setText(e.target.value)} autoFocus maxLength={60} /></label>
          <div className="grid g2">
            {STYLES.map((f) => (
              <button key={f} type="button" className={`sigstyle${font === f ? ' on' : ''}`} style={{ fontFamily: `'${f}', cursive` }} onClick={() => setFont(f)} aria-pressed={font === f}>
                {text || 'Your name'}
              </button>
            ))}
          </div>
        </div>
      )}
      {tab === 'draw' && (
        <div>
          <canvas ref={pad} className="sigpad" aria-label="Draw your signature" />
          <div className="row between" style={{ marginTop: 8 }}>
            <span className="muted small">Use your mouse, finger or stylus.</span>
            <button className="btn sm ghost" onClick={clear}>Clear</button>
          </div>
        </div>
      )}
      {tab === 'upload' && (
        <label className="drop" style={{ display: 'block' }}>
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <b>Choose a photo or scan of your signature</b>
          <div className="muted small">PNG or JPEG. A transparent or white background works best.</div>
        </label>
      )}
      {error && <div className="notice err" style={{ marginTop: 12 }}>{error}</div>}
      <p className="muted small" style={{ marginTop: 16, marginBottom: 0 }}>
        By choosing Adopt and sign, I agree that this mark is the electronic representation of my {kind === 'signature' ? 'signature' : 'initials'} and is as valid as one made with pen on paper.
      </p>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        {tab !== 'upload' && <button className="btn primary" onClick={adopt}>Adopt and sign</button>}
      </div>
    </Modal>
  );
}
