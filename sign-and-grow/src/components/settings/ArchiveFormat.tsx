'use client';
// Settings, Records and data: "Archive format (PDF/A)" (GET and PUT /account/pdfa, src/server/routes-pdfa.ts). One
// switch for admins, off by default, that saves as it is flipped. Listed only when the people who run the server set
// up the checker (veraPDF): on any other server, and for members, nothing at all. The designer's note is
// research/ux-notes.json, "ds-pdfa": no per-document choice, and veraPDF is not named here.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;

export function ArchiveFormat() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [d, reload] = useLoad<any>(() => (admin ? api('/account/pdfa').catch(() => null) : Promise.resolve(null)), [admin]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!d?.available) return null;
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
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(false);
  };
  return (
    <section className="card" data-feature="ds-pdfa" data-item="card" aria-labelledby="pdfa-title">
      <label className="setting-row" style={{ margin: 0, minHeight: 44 }}>
        <input type="checkbox" role="switch" checked={!!d.on} aria-busy={busy} aria-labelledby="pdfa-title" aria-describedby="pdfa-hint" onChange={(e) => flip(e.target.checked)} />
        <span>
          <b id="pdfa-title">{t(ui, 'pdfa.setting.title')}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved ? 'Saved' : ''}</span>
          <span className="muted small" id="pdfa-hint" style={{ display: 'block' }}>{t(ui, 'pdfa.setting.hint')}</span>
        </span>
      </label>
    </section>
  );
}
