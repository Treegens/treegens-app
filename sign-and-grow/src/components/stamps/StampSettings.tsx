'use client';
import { useRef, useState, type ReactNode } from 'react';
import { api, toast, useLoad } from '@/components/ui';
import { Dialog } from '@/components/sign/Dialog';
import { StampMaker, OnPaper, type Made } from './StampMaker';
import { STAMP_IS_TEAM, STAMP_DEFAULT_MM, STAMP_MIN_MM, STAMP_MAX_MM, STAMP_NAME_MAX, stampTurn, turnStyle } from '@/lib/stamps';
import { useStampT } from './words';

// Settings, Stamps and seals: the team's own stamps. Admins add them (a name, a picture made into an impression, its real size),
// rename, resize, give one a new picture, or delete one. Everyone on the team can use them: as the sender's stamp on
// an envelope, and when they sign a document sent to their own address. Changing one never changes a document it is
// already on (src/server/stamps.ts).

function StampForm({ stamp, taken, onClose, onSaved }: { stamp?: any; /** The names the team's stamps have now. */ taken: string[]; onClose: () => void; onSaved: () => void }) {
  const T = useStampT();
  // A new stamp starts with a name that works, so a picture alone is enough to add it.
  const [name, setName] = useState(stamp?.name || (taken.some((n) => n.trim().toLowerCase() === T('stamps.default_name').toLowerCase()) ? '' : T('stamps.default_name')));
  const [size, setSize] = useState(String(stamp?.size_mm ?? STAMP_DEFAULT_MM));
  const [file, setFile] = useState<{ f: File; from: 'upload' | 'camera' } | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const chosen = (from: 'upload' | 'camera') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) (setFile({ f, from }), setMade(null), setError(''));
  };
  const mm = Number(size);
  async function save() {
    if (!name.trim()) return setError(T('stamps.need_name'));
    setBusy(true);
    setError('');
    try {
      const look = made ? { image: made.png, ink: made.look.ink, seed: made.look.seed, tilt: made.look.tilt, texture: made.look.texture, turn: made.look.tilt } : {};
      if (stamp) {
        const r = await api(`/stamps/${stamp.id}`, { method: 'PUT', body: { name, size_mm: mm, ...look } });
        toast(made && r.kept_on_documents ? T('stamps.saved_kept', { count: Number(r.kept_on_documents) }) : T('stamps.saved'));
      } else {
        await api('/stamps', { body: { name, size_mm: mm, ...look } });
        toast(T('stamps.ready_for_team', { name: name.trim() }));
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || T('stamps.not_saved'));
    } finally {
      setBusy(false);
    }
  }
  const needsPicture = !stamp;
  return (
    <Dialog title={stamp ? T('stamps.change_title', { name: stamp.name }) : T('stamps.add_title')} onClose={onClose} wide>
      <div className="st-dialog">
        <div className="grid st-controls">
          <label className="f"><span>{T('stamps.name')} <span className="hint">{T('stamps.name_hint')}</span></span>
            <input value={name} maxLength={STAMP_NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
          </label>
          <label className="f"><span>{T('stamps.size')} <span className="hint">{T('stamps.size_hint')}</span></span>
            <input type="number" inputMode="decimal" min={STAMP_MIN_MM} max={STAMP_MAX_MM} step={1} value={size} onChange={(e) => setSize(e.target.value)} />
          </label>
        </div>
        {stamp && !file && (
          <OnPaper label={T('stamps.as_now', { name: stamp.name })}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="st-on st-ink" src={stamp.image_url} alt="" style={turnStyle(stampTurn(stamp.turn))} />
          </OnPaper>
        )}
        {!file && (
          <div className="st-sources">
            <p className="muted small">{stamp ? T('stamps.new_picture') : T('stamps.first_picture')}</p>
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
            <StampMaker file={file.f} from={file.from} onMade={setMade} mm={mm >= STAMP_MIN_MM && mm <= STAMP_MAX_MM ? mm : undefined} sizeLabel={mm >= STAMP_MIN_MM && mm <= STAMP_MAX_MM ? T('stamps.real_size', { mm: String(mm) }) : ''} />
            <button type="button" className="btn sm st-other" onClick={() => (setFile(null), setMade(null))}>{T('stamps.another_picture')}</button>
          </>
        )}
        <p className="muted small st-honest">{STAMP_IS_TEAM}</p>
        {/* The buttons stay in view. The main one is there only once it can do something: for a new stamp, after its
            picture is made. */}
        <div className="st-foot">
          {error && <div className="notice err" role="alert">{error}</div>}
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>{T('stamps.cancel')}</button>
            {(file ? !!made : !needsPicture) && <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? T('stamps.saving') : stamp ? T('stamps.save') : T('stamps.add_button')}</button>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// `after`: drawn at the foot of this card, such as the admins' "Members may place stamps" (settings/Switches.tsx).
export function StampSettings({ after }: { after?: ReactNode } = {}) {
  const T = useStampT();
  const [data, reload, error] = useLoad(() => api('/stamps'));
  const [form, setForm] = useState<{ stamp?: any } | null>(null);
  const [removing, setRemoving] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="notice err" role="alert">{error.message || T('stamps.load_failed')} {T('stamps.load_again')}</div>;
  if (!data) return <p className="muted" role="status">{T('stamps.loading')}</p>;
  const { stamps, max, may_change } = data;
  return (
    <section className="card" aria-labelledby="st-h">
      <div className="row between wrap" style={{ gap: 12 }}>
        <h2 id="st-h">{T('stamps.title')}</h2>
        {may_change && stamps.length < max && <button type="button" className="btn primary" style={{ minHeight: 44 }} onClick={() => setForm({})}>{T('stamps.add')}</button>}
      </div>
      <p className="muted" style={{ margin: '6px 0 0' }}>{T('stamps.one_line')}</p>
      <p className="muted small">{STAMP_IS_TEAM}</p>
      <details className="st-how" data-fold>
        <summary>{T('stamps.how')}</summary>
        <p className="muted small">
          {may_change ? T('stamps.how_max', { max: Number(max) }) : T('stamps.how_admins')} {T('stamps.how_rest')}
        </p>
      </details>
      {stamps.length >= max && may_change && <p className="notice small">{T('stamps.at_max', { max: Number(max) })}</p>}
      {!stamps.length ? (
        <p className="muted">{may_change ? T('stamps.none_add') : T('stamps.none')}</p>
      ) : (
        <div className="st-list">
          {stamps.map((s: any) => (
            <div key={s.id} className="st-item">
              <OnPaper label={T('stamps.on_page', { name: s.name, ink: T.inkLower(s.ink) })}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="st-on st-ink" src={s.image_url} alt="" style={turnStyle(stampTurn(s.turn))} />
              </OnPaper>
              <h3>{s.name}</h3>
              <p className="muted small" style={{ margin: 0 }}>{s.updated_by ? T('stamps.item_by', { ink: T.ink(s.ink), mm: String(s.size_mm), who: s.updated_by }) : T('stamps.item', { ink: T.ink(s.ink), mm: String(s.size_mm) })}</p>
              {may_change && (
                <div className="st-row">
                  <button type="button" className="btn sm" onClick={() => setForm({ stamp: s })}>{T('stamps.change')}<span className="sg-vh"> {s.name}</span></button>
                  <button type="button" className="btn sm danger" onClick={() => setRemoving(s)}>{T('stamps.delete')}<span className="sg-vh"> {s.name}</span></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {form && <StampForm stamp={form.stamp} taken={stamps.map((x: any) => String(x.name || ''))} onClose={() => setForm(null)} onSaved={() => (setForm(null), reload())} />}
      {removing && (
        <Dialog title={T('stamps.delete_title', { name: removing.name })} onClose={() => setRemoving(null)}>
          <p>{T('stamps.delete_body')}</p>
          <div className="actions">
            <button type="button" className="btn" data-autofocus onClick={() => setRemoving(null)}>{T('stamps.keep')}</button>
            <button type="button" className="btn danger" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await api(`/stamps/${removing.id}`, { method: 'DELETE' });
                toast(T('stamps.deleted', { name: removing.name }));
                setRemoving(null);
                reload();
              } catch (e: any) {
                toast(e?.message || T('stamps.not_deleted'), true);
              } finally {
                setBusy(false);
              }
            }}>{T('stamps.delete')}</button>
          </div>
        </Dialog>
      )}
      {after}
    </section>
  );
}
