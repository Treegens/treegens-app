'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Dialog } from '@/components/sign/Dialog';
import { StampMaker, OnPaper, type Made } from './StampMaker';
import { STAMP_IS_YOU } from '@/lib/stamps';
import { INK_WORD } from '@/lib/stampink';

// Putting a stamp on one stamp field of the signing page: a saved stamp of the signer's own account (only when they
// are signed in with the address the document went to), a picture of the stamp, or a photo taken now. The picture
// becomes an impression in this browser (StampMaker) and is sent once, when it is put on. The field holds one.

export type PutStamp = { value: string; image_url: string; stamp: { name: string | null; ink: string | null; from: string | null } };

export function StampDialog({ base, field, current, version, onClose, onPut, onTakeOff, onChanged }: {
  base: string;
  field: any;
  /** The stamp on the field now, if there is one. */
  current: { image_url: string; name?: string | null } | null;
  version: number | null;
  onClose: () => void;
  onPut: (r: PutStamp) => void;
  onTakeOff: () => Promise<void>;
  /** The sender changed the document while this was open: nothing was put on, and the page loads it again. */
  onChanged: () => void;
}) {
  const [saved, setSaved] = useState<any[] | null>(null);
  const [pick, setPick] = useState('');
  const [file, setFile] = useState<{ f: File; from: 'upload' | 'camera' } | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replace, setReplace] = useState(!current);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api(`${base}/stamps`).then((r) => live && setSaved(r.stamps || [])).catch(() => live && setSaved([]));
    return () => {
      live = false;
    };
  }, [base]);

  async function put(body: any) {
    setBusy(true);
    setError('');
    try {
      const r = await api(`${base}/stamp`, { body: { field_id: field.id, version, ...body } });
      onPut(r);
    } catch (e: any) {
      if (e?.code === 'changed') return onChanged();
      setError(e?.message || 'The stamp could not be put on. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }
  const chosen = (from: 'upload' | 'camera') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) (setFile({ f, from }), setMade(null), setPick(''), setError(''));
  };
  const name = field.label || 'Stamp';

  if (current && !replace)
    return (
      <Dialog title={`Your stamp: ${name}`} onClose={onClose}>
        <OnPaper label={`Your stamp${current.name ? ` "${current.name}"` : ''} on a page of text`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="st-on st-ink" src={current.image_url} alt="" />
        </OnPaper>
        <p className="muted small">{STAMP_IS_YOU}</p>
        {error && <div className="notice err" role="alert">{error}</div>}
        <div className="actions sg-three">
          <button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await onTakeOff(); } catch (e: any) { setError(e?.message || 'It could not be taken off. Try again.'); } finally { setBusy(false); } }}>Take it off</button>
          <button type="button" className="btn" onClick={() => setReplace(true)}>Change it</button>
          <button type="button" className="btn primary" data-autofocus onClick={onClose}>Keep it</button>
        </div>
      </Dialog>
    );

  return (
    <Dialog title={`Put your stamp on: ${name}`} onClose={onClose} wide>
      <div className="st-dialog">
        {!!saved?.length && !file && (
          <fieldset className="st-saved">
            <legend>Your team&apos;s stamps</legend>
            <div className="st-saved-list">
              {saved.map((s) => (
                <label key={s.id} className={`st-card${pick === s.id ? ' on' : ''}`}>
                  <input type="radio" name="st-saved" value={s.id} checked={pick === s.id} onChange={() => setPick(s.id)} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.image_url} alt="" />
                  <span><b>{s.name}</b><span className="muted small">{INK_WORD[s.ink as keyof typeof INK_WORD] || ''} ink</span></span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {!file && (
          <div className="st-sources">
            <p className="muted small">{saved?.length ? 'Or use a picture of the stamp.' : 'Use a picture of your stamp: a design file, or a photo of the stamp pressed on paper.'} PNG, JPEG or WebP, up to 8 MB. We take the paper away and print it in one ink, like a rubber stamp.</p>
            <div className="row st-row">
              <button type="button" className="btn" onClick={() => picker.current?.click()}>Choose a picture</button>
              <button type="button" className="btn" onClick={() => camera.current?.click()}>Take a photo</button>
            </div>
          </div>
        )}
        <input ref={picker} type="file" className="sg-vh" tabIndex={-1} aria-hidden="true" accept="image/png,image/jpeg,image/webp" onChange={chosen('upload')} />
        <input ref={camera} type="file" className="sg-vh" tabIndex={-1} aria-hidden="true" accept="image/*" capture="environment" onChange={chosen('camera')} />
        {file && (
          <>
            <StampMaker file={file.f} from={file.from} onMade={setMade} sizeLabel={`On the document it fills the stamp field the sender placed.`} />
            <button type="button" className="btn sm st-other" onClick={() => (setFile(null), setMade(null))}>Use another picture</button>
          </>
        )}
        <p className="muted small st-honest">{STAMP_IS_YOU}</p>
        {error && <div className="notice err" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={current ? () => setReplace(false) : onClose}>{current ? 'Back' : 'Cancel'}</button>
          {file ? (
            <button type="button" className="btn primary" disabled={!made || busy} onClick={() => made && put({ image: made.png, ink: made.look.ink, seed: made.look.seed, tilt: made.look.tilt, texture: made.look.texture, from: made.from })}>
              {busy ? 'Putting it on' : 'Put this stamp on the page'}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!pick || busy} onClick={() => put({ stamp_id: pick })}>{busy ? 'Putting it on' : 'Use this stamp'}</button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
