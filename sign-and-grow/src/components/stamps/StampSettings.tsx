'use client';
import { useRef, useState } from 'react';
import { api, toast, useLoad } from '@/components/ui';
import { Dialog } from '@/components/sign/Dialog';
import { StampMaker, OnPaper, type Made } from './StampMaker';
import { STAMP_IS_TEAM, STAMP_DEFAULT_MM, STAMP_MIN_MM, STAMP_MAX_MM, STAMP_NAME_MAX, stampTurn, turnStyle } from '@/lib/stamps';
import { INK_WORD } from '@/lib/stampink';

// Settings, Stamps: the team's own stamps. Admins add them (a name, a picture made into an impression, its real size),
// rename, resize, give one a new picture, or delete one. Everyone on the team can use them: as the sender's stamp on
// an envelope, and when they sign a document sent to their own address. Changing one never changes a document it is
// already on (src/server/stamps.ts).

const inkWord = (ink: string) => INK_WORD[ink as keyof typeof INK_WORD] || '';

function StampForm({ stamp, onClose, onSaved }: { stamp?: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(stamp?.name || '');
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
    setBusy(true);
    setError('');
    try {
      const look = made ? { image: made.png, ink: made.look.ink, seed: made.look.seed, tilt: made.look.tilt, texture: made.look.texture, turn: made.look.tilt } : {};
      if (stamp) {
        const r = await api(`/stamps/${stamp.id}`, { method: 'PUT', body: { name, size_mm: mm, ...look } });
        toast(made && r.kept_on_documents ? `Saved. The ${r.kept_on_documents === 1 ? 'document that already has it keeps' : `${r.kept_on_documents} documents that already have it keep`} the old picture.` : 'Saved.');
      } else {
        await api('/stamps', { body: { name, size_mm: mm, ...look } });
        toast(`"${name.trim()}" is ready for your team to use.`);
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'It could not be saved. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }
  const needsPicture = !stamp;
  return (
    <Dialog title={stamp ? `Change "${stamp.name}"` : 'Add a stamp'} onClose={onClose} wide>
      <div className="st-dialog">
        <div className="grid st-controls">
          <label className="f"><span>Name <span className="hint">(such as Company stamp or Received)</span></span>
            <input value={name} maxLength={STAMP_NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
          </label>
          <label className="f"><span>Real size across, in millimetres <span className="hint">(a round company seal is about 38 to 45)</span></span>
            <input type="number" inputMode="decimal" min={STAMP_MIN_MM} max={STAMP_MAX_MM} step={1} value={size} onChange={(e) => setSize(e.target.value)} />
          </label>
        </div>
        {stamp && !file && (
          <OnPaper label={`"${stamp.name}" as it is now`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="st-on st-ink" src={stamp.image_url} alt="" style={turnStyle(stampTurn(stamp.turn))} />
          </OnPaper>
        )}
        {!file && (
          <div className="st-sources">
            <p className="muted small">{stamp ? 'To give it a new picture: ' : ''}a design file, or a photo of the stamp pressed on paper. PNG, JPEG or WebP, up to 8 MB. The paper is taken away and it is printed in one ink, like a rubber stamp.</p>
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
            <StampMaker file={file.f} from={file.from} onMade={setMade} mm={mm >= STAMP_MIN_MM && mm <= STAMP_MAX_MM ? mm : undefined} sizeLabel={mm >= STAMP_MIN_MM && mm <= STAMP_MAX_MM ? `A stamp field for it starts at its real size, ${mm} mm across.` : ''} />
            <button type="button" className="btn sm st-other" onClick={() => (setFile(null), setMade(null))}>Use another picture</button>
          </>
        )}
        <p className="muted small st-honest">{STAMP_IS_TEAM}</p>
        {error && <div className="notice err" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim() || (needsPicture && !made) || (!!file && !made)} onClick={save}>{busy ? 'Saving' : stamp ? 'Save' : 'Add the stamp'}</button>
        </div>
      </div>
    </Dialog>
  );
}

export function StampSettings() {
  const [data, reload, error] = useLoad(() => api('/stamps'));
  const [form, setForm] = useState<{ stamp?: any } | null>(null);
  const [removing, setRemoving] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="notice err" role="alert">{error.message || 'The stamps could not be loaded.'} Load the page again.</div>;
  if (!data) return <p className="muted" role="status">Loading the stamps</p>;
  const { stamps, max, may_change } = data;
  return (
    <section className="card" aria-labelledby="st-h">
      <div className="row between wrap" style={{ gap: 12 }}>
        <h2 id="st-h">Stamps</h2>
        {may_change && <button type="button" className="btn primary" style={{ minHeight: 44 }} disabled={stamps.length >= max} onClick={() => setForm({})}>Add a stamp</button>}
      </div>
      <p className="muted" style={{ margin: '6px 0 0' }}>
        Your company stamp or seal, to put next to a signature. It is printed like ink from a rubber stamp: the words under it show through. {may_change ? `Your team can keep up to ${max}.` : 'Admins of the account add and change them.'} Everyone on the team can use them: as your own stamp on a document you send, and when you sign a document sent to your address while you are signed in. Changing or deleting a stamp here never changes a document it is already on.
      </p>
      <p className="muted small">{STAMP_IS_TEAM}</p>
      {stamps.length >= max && may_change && <p className="notice small">Your team has {max} stamps, which is as many as an account can keep. Delete one to add another.</p>}
      {!stamps.length ? (
        <p className="muted">No stamps yet.{may_change ? ' Add one from a design file or a photo of the stamp.' : ''}</p>
      ) : (
        <div className="st-list">
          {stamps.map((s: any) => (
            <div key={s.id} className="st-item">
              <OnPaper label={`"${s.name}" in ${inkWord(s.ink).toLowerCase()} ink on a page of text`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="st-on st-ink" src={s.image_url} alt="" style={turnStyle(stampTurn(s.turn))} />
              </OnPaper>
              <h3>{s.name}</h3>
              <p className="muted small" style={{ margin: 0 }}>{inkWord(s.ink)} ink, {s.size_mm} mm across{s.updated_by ? `. Last changed by ${s.updated_by}.` : '.'}</p>
              {may_change && (
                <div className="st-row">
                  <button type="button" className="btn sm" onClick={() => setForm({ stamp: s })}>Change<span className="sg-vh"> {s.name}</span></button>
                  <button type="button" className="btn sm danger" onClick={() => setRemoving(s)}>Delete<span className="sg-vh"> {s.name}</span></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {form && <StampForm stamp={form.stamp} onClose={() => setForm(null)} onSaved={() => (setForm(null), reload())} />}
      {removing && (
        <Dialog title={`Delete "${removing.name}"?`} onClose={() => setRemoving(null)}>
          <p>Nobody on your team can use it any more. Documents that already have it keep it as it is, and so do drafts and templates that use it.</p>
          <div className="actions">
            <button type="button" className="btn" data-autofocus onClick={() => setRemoving(null)}>Keep it</button>
            <button type="button" className="btn danger" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await api(`/stamps/${removing.id}`, { method: 'DELETE' });
                toast(`"${removing.name}" was deleted.`);
                setRemoving(null);
                reload();
              } catch (e: any) {
                toast(e?.message || 'It could not be deleted. Try again in a moment.', true);
              } finally {
                setBusy(false);
              }
            }}>Delete</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
