'use client';
// Settings, Records and data, under More options: "Archive format (PDF/A)" (GET and PUT /account/pdfa,
// src/server/routes-pdfa.ts). One switch for admins, off by default, that saves as it is flipped. Listed only when the
// people who run the server set up the checker (veraPDF), or while the switch is still on after they took it away
// (then it says so, and can be switched off). On any other server, and for members, nothing at all. The designer's
// note is research/ux-notes.json, "ds-pdfa": no per-document choice, and veraPDF is not named here. It sits behind
// the section's More options (charter 2.2: at most 4 cards in a section; a rarer one goes there).
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { senderT as t, senderError } from '@/lib/senderlang';
import { useSenderLangHere } from '@/components/senderLang';


export function ArchiveFormat() {
  const ui = useSenderLangHere();
  const me = useMe();
  const admin = me.role !== 'member';
  const [d, reload] = useLoad<any>(() => (admin ? api('/account/pdfa').catch(() => null) : Promise.resolve(null)), [admin]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!d || (!d.available && !d.on)) return null;
  // A second flip while one is on its way is ignored. The switch is never disabled under the finger, so keyboard focus
  // stays on it.
  const flip = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    try {
      await api('/account/pdfa', { method: 'PUT', body: { on } });
      setSaved(true);
    } catch (e: any) {
      toast(`${senderError(ui, e)} ${t(ui, 'settings.try_again')}`, true);
    }
    reload();
    setBusy(false);
  };
  return (
    <section className="card" data-feature="ds-pdfa" data-item="card" aria-labelledby="pdfa-title">
      <h2 id="pdfa-title" style={{ marginBottom: 0 }}>{t(ui, 'pdfa.setting.title')}</h2>
      <label className="setting-row" style={{ margin: 0, paddingBottom: 0, minHeight: 44, alignItems: 'center' }}>
        <input type="checkbox" role="switch" checked={!!d.on} aria-busy={busy} aria-labelledby="pdfa-title" aria-describedby="pdfa-hint" onChange={(e) => flip(e.target.checked)} />
        <span>
          <span className="muted" id="pdfa-hint">{t(ui, 'pdfa.setting.hint')}</span>{' '}
          <span role="status" className="small" style={{ color: 'var(--green)' }}>{saved ? t(ui, 'settings.saved') : ''}</span>
        </span>
      </label>
      {d.notice && <p className="notice warn" style={{ margin: '12px 0 0' }}>{d.notice}</p>}
    </section>
  );
}
