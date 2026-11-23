'use client';
// Settings, Profile, "Emails about your documents", for owners and admins: last month's report by email early in
// each month (GET and PUT /reports/monthly, monthlyReports in src/server/routes-reports.ts). Off by default. One line,
// shown only to owners and admins of a team of two or more that has sent something (or who has it on already).
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useST } from '@/components/senderLang';

export function MonthlyReport() {
  const T = useST();
  const [r, reload] = useLoad<any>(() => api('/reports/monthly'), []);
  const [busy, setBusy] = useState(false);
  // The box shows the choice at once; it goes back if the server did not take it.
  const [mine, setMine] = useState<boolean | null>(null);
  if (!r?.may) return null;
  const on = mine ?? !!r.on;
  const flip = async () => {
    setBusy(true);
    setMine(!on);
    try {
      await api('/reports/monthly', { method: 'PUT', body: { on: !on } });
      reload();
    } catch (e: any) {
      setMine(on);
      toast(e?.message || T('reports.monthly.not_saved'), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="setting-row" id="monthly-report">
        <input type="checkbox" checked={on} aria-busy={busy} onChange={flip} />
        <span><b>{T('reports.monthly.title')}</b><span className="muted small" style={{ display: 'block' }}>{T('reports.monthly.label')}</span></span>
    </label>
  );
}
