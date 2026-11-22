'use client';
// Settings, Account, on the AI card under "Let the AI read document text": the "Key dates" switch (PUT
// /api/account/key-dates, src/server/routes-airepo.ts). Shown only while the AI may read document text: it needs
// that, and is its own switch, off until an admin turns it on. It saves as soon as it is flipped. Once on, one
// secondary button reads the documents completed before it: "Look through older documents", only where the timer
// reads documents by itself on this server ("auto"). While on, one line says what turning it off stops.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { KEY_DATES, KEY_SWITCH_HINT, KEY_OFF_WARNING, OLDER_BUTTON, autoLine } from '@/lib/keydates';

export function KeyDatesSetting() {
  const [d, reload] = useLoad<any>(() => api('/account/key-dates').catch(() => null), []);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  if (!d?.possible) return null;
  const flip = async (on: boolean) => {
    setBusy(true);
    setSaved('');
    try {
      await api('/account/key-dates', { method: 'PUT', body: { on } });
      setSaved('Saved');
    } catch (e: any) {
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(false);
  };
  const older = async () => {
    setBusy(true);
    try {
      const r = await api('/account/key-dates/older', { method: 'POST' });
      setSaved(r.waiting ? `Saved. ${r.waiting} document${r.waiting === 1 ? '' : 's'} will be read over the next hours.` : 'Saved. There are no older completed documents to read.');
    } catch (e: any) {
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(false);
  };
  return (
    <div data-feature="ds-ai-repo">
      <label className="setting-row" style={{ margin: '10px 0 0', minHeight: 44 }}>
        <input type="checkbox" role="switch" checked={!!d.on} disabled={busy} aria-labelledby="key-dates-title" aria-describedby="key-dates-hint" onChange={(e) => flip(e.target.checked)} />
        <span>
          <b id="key-dates-title">{KEY_DATES}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved}</span>
          <span className="muted small" id="key-dates-hint" style={{ display: 'block' }}>
            {KEY_SWITCH_HINT} {d.on ? autoLine(!!d.auto, !!d.older) : ''}
            {d.on && <span style={{ display: 'block' }}>{KEY_OFF_WARNING}</span>}
          </span>
        </span>
      </label>
      {d.on && d.auto && !d.older && <button type="button" className="btn sm" style={{ minHeight: 44, marginTop: 6 }} disabled={busy} onClick={() => void older()}>{OLDER_BUTTON}</button>}
    </div>
  );
}
