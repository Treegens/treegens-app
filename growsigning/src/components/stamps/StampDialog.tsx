'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Dialog } from '@/components/sign/Dialog';
import { StampMaker, OnPaper, type Made } from './StampMaker';
import { STAMP_IS_YOU, stampTurn, turnStyle } from '@/lib/stamps';
import { useStampT } from './words';

// Putting a stamp on one stamp field of the signing page: a saved stamp of the signer's own account (only when they
// are signed in with the address the document went to), a picture of the stamp, or a photo taken now. The picture
// becomes an impression in this browser (StampMaker) and is sent once, when it is put on. The field holds one.

export type PutStamp = { value: string; image_url: string; turn?: number; stamp: { name: string | null; ink: string | null; from: string | null } };

/** The stamp this signer already put on another of their stamp fields of this document, to offer it again. */
export type SameStamp = { field_id: string; image_url: string; turn: number };
export function sameStampOf(fields: any[], field: any, urlOf: (f: any) => string | null, turns: Record<string, number>): SameStamp | null {
  const f = fields.find((x) => x.type === 'stamp' && x.id !== field.id && urlOf(x));
  return f ? { field_id: f.id, image_url: urlOf(f)!, turn: turns[f.id] ?? stampTurn(f.stamp_meta) } : null;
}

export function StampDialog({ base, field, current, same, version, onClose, onPut, onTakeOff, onChanged }: {
  base: string;
  field: any;
  /** The stamp they already put on another field of this document: offered first, so it is not made twice. */
  same?: SameStamp | null;
  /** The stamp on the field now, if there is one. */
  current: { image_url: string; name?: string | null; turn?: number } | null;
  version: number | null;
  onClose: () => void;
  onPut: (r: PutStamp) => void;
  onTakeOff: () => Promise<void>;
  /** The sender changed the document while this was open: nothing was put on, and the page loads it again. */
  onChanged: () => void;
}) {
  const T = useStampT();
  const [saved, setSaved] = useState<any[] | null>(null);
  const [pick, setPick] = useState('');
  const [file, setFile] = useState<{ f: File; from: 'upload' | 'camera' } | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replace, setReplace] = useState(!current);
  // "Use another picture" on the offer of the stamp they already put on.
  const [another, setAnother] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    // The first saved stamp is chosen to start with, so the main button always has something to use.
    api(`${base}/stamps`).then((r) => live && (setSaved(r.stamps || []), setPick((p) => p || r.stamps?.[0]?.id || ''))).catch(() => live && setSaved([]));
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
      setError(e?.message || T('stamps.put_failed'));
    } finally {
      setBusy(false);
    }
  }
  const chosen = (from: 'upload' | 'camera') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) (setFile({ f, from }), setMade(null), setError(''));
  };
  const name = field.label || T('stamps.field_name');

  if (current && !replace)
    return (
      <Dialog title={T('stamps.yours_title', { name })} onClose={onClose}>
        <OnPaper label={current.name ? T('stamps.yours_label_named', { name: current.name }) : T('stamps.yours_label')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="st-on st-ink" src={current.image_url} alt="" style={turnStyle(current.turn || 0)} />
        </OnPaper>
        <p className="muted small">{STAMP_IS_YOU}</p>
        {error && <div className="notice err" role="alert">{error}</div>}
        <div className="actions sg-three">
          <button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await onTakeOff(); } catch (e: any) { setError(e?.message || T('stamps.not_taken_off')); } finally { setBusy(false); } }}>{T('stamps.take_off')}</button>
          <button type="button" className="btn" onClick={() => setReplace(true)}>{T('stamps.change_it')}</button>
          <button type="button" className="btn primary" data-autofocus onClick={onClose}>{T('stamps.keep')}</button>
        </div>
      </Dialog>
    );

  if (same && !another)
    return (
      <Dialog title={T('stamps.put_title', { name })} onClose={onClose}>
        <div className="st-dialog">
          <OnPaper className="st-same" label={T('stamps.same_label')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="st-on st-ink" src={same.image_url} alt="" style={turnStyle(same.turn)} />
          </OnPaper>
          <p style={{ margin: 0 }}>{T('stamps.same_line')}</p>
          <p className="muted small st-honest">{STAMP_IS_YOU}</p>
          <div className="st-foot">
            {error && <div className="notice err" role="alert">{error}</div>}
            <div className="actions sg-three">
              <button type="button" className="btn" onClick={current ? () => setReplace(false) : onClose}>{current ? T('stamps.back') : T('stamps.cancel')}</button>
              <button type="button" className="btn" onClick={() => (setAnother(true), setError(''))}>{T('stamps.another_picture')}</button>
              <button type="button" className="btn primary" data-autofocus disabled={busy} onClick={() => put({ same_as: same.field_id })}>{busy ? T('stamps.putting') : T('stamps.use_same')}</button>
            </div>
          </div>
        </div>
      </Dialog>
    );

  return (
    <Dialog title={T('stamps.put_title', { name })} onClose={onClose} wide>
      <div className="st-dialog">
        {!!saved?.length && !file && (
          <fieldset className="st-saved">
            <legend>{T('stamps.team_stamps')}</legend>
            <div className="st-saved-list">
              {saved.map((s) => (
                <label key={s.id} className={`st-card${pick === s.id ? ' on' : ''}`}>
                  <input type="radio" name="st-saved" value={s.id} checked={pick === s.id} onChange={() => setPick(s.id)} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.image_url} alt="" style={turnStyle(stampTurn(s.turn))} />
                  <span><b>{s.name}</b><span className="muted small">{T.ink(s.ink) ? T('stamps.ink_of', { ink: T.ink(s.ink) }) : ''}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {!file && (
          <div className="st-sources">
            <p className="muted small">{saved?.length ? T('stamps.or_picture') : T('stamps.use_picture')}</p>
            <div className="row st-row">
              <button type="button" className="btn" onClick={() => picker.current?.click()}>{T('stamps.choose_picture')}</button>
              <button type="button" className="btn" onClick={() => camera.current?.click()}>{T('stamps.take_photo')}</button>
            </div>
          </div>
        )}
        <input ref={picker} type="file" className="sg-vh" tabIndex={-1} aria-hidden="true" accept="image/png,image/jpeg,image/webp" onChange={chosen('upload')} />
        <input ref={camera} type="file" className="sg-vh" tabIndex={-1} aria-hidden="true" accept="image/*" capture="environment" onChange={chosen('camera')} />
        {file && (
          <>
            <StampMaker file={file.f} from={file.from} onMade={setMade} sizeLabel={T('stamps.fills_field')} />
            <button type="button" className="btn sm st-other" onClick={() => (setFile(null), setMade(null))}>{T('stamps.another_picture')}</button>
          </>
        )}
        <p className="muted small st-honest">{STAMP_IS_YOU}</p>
        {/* The buttons stay in view at the bottom of the dialog. The main one is there only once it can do something:
            a picture made into a stamp, or a saved stamp to use. Before that, Cancel alone. */}
        <div className="st-foot">
          {error && <div className="notice err" role="alert">{error}</div>}
          <div className="actions">
            <button type="button" className="btn" onClick={current ? () => setReplace(false) : onClose}>{current ? T('stamps.back') : T('stamps.cancel')}</button>
            {file && made && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => put({ image: made.png, ink: made.look.ink, seed: made.look.seed, tilt: made.look.tilt, texture: made.look.texture, turn: made.look.tilt, from: made.from })}>
                {busy ? T('stamps.putting') : T('stamps.put_this')}
              </button>
            )}
            {!file && !!saved?.length && !!pick && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => put({ stamp_id: pick })}>{busy ? T('stamps.putting') : T('stamps.use_this')}</button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
