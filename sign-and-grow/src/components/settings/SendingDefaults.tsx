'use client';
// Settings, Sending: the card "New documents". What a new document starts with: reminders, the deadline and how dates
// are written. These stood under Account until 21 November 2026, next to the logo, while the editor asks for the
// same three things on the last step of every send.
//
// Each of the three saves by itself the moment it changes (a number when the box is left, or on Enter), with "Saved"
// next to it. Nothing here changes a document that is already out.
import { useState } from 'react';
import { api, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { DEFAULT_REMINDER_DAYS, reminderText } from '@/lib/policy';
import { DATE_FORMAT_CHOICES, DEFAULT_DATE_FORMAT, formatDate, deviceZone } from '@/lib/dates';
import { daysIn, refusedDays } from '@/lib/settingsnav';
import { useSaved } from './Frame';

export function SendingDefaults() {
  const me = useMe();
  const a = me.account;
  const [f, setF] = useState({ default_reminder_days: String(a.default_reminder_days ?? DEFAULT_REMINDER_DAYS), default_expire_days: String(a.default_expire_days ?? ''), default_date_format: a.default_date_format || DEFAULT_DATE_FORMAT });
  const [bad, setBad] = useState<Record<string, string>>({});
  const [remSaid, remSaved] = useSaved();
  const [dueSaid, dueSaved] = useSaved();
  const [dateSaid, dateSaved] = useSaved();
  const send = (body: Record<string, unknown>, saved: () => void) => api('/account', { method: 'PATCH', body }).then(() => (saved(), me.reload())).catch(oops);
  // A number is saved when the box is left. One that is empty or outside the limits is said in words and not sent,
  // so a slip of the finger never switches reminders off.
  const number = (key: 'default_reminder_days' | 'default_expire_days', lo: number, hi: number, saved: () => void) => () => {
    const n = daysIn(f[key], lo, hi);
    if (n == null) {
      // The box goes back to what is saved, and the line under it says so: nobody is left looking at a number that was not kept.
      const kept = a[key] == null || a[key] === '' ? '' : String(a[key]);
      setF((x) => ({ ...x, [key]: kept }));
      return setBad((b) => ({ ...b, [key]: refusedDays(key, lo, hi, kept) }));
    }
    setBad((b) => ({ ...b, [key]: '' }));
    if (n !== Number(a[key])) send({ [key]: n }, saved);
  };
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };
  const reminders = daysIn(f.default_reminder_days, 0, 60);
  return (
    <section className="card" aria-labelledby="set-new-h">
      <h2 id="set-new-h" style={{ marginBottom: 4 }}>New documents</h2>
      <p className="muted small">What a new document starts with. Whoever sends can change each of these for one document on the last step. Changes here save by themselves.</p>
      <div className="grid g3">
        <label className="f"><span>Remind people every <span className="hint">(days, 0 for never)</span> {remSaid}</span>
          <input type="number" inputMode="numeric" min={0} max={60} value={f.default_reminder_days} aria-describedby={bad.default_reminder_days ? 'set-rem-bad set-reminders' : 'set-reminders'} aria-invalid={!!bad.default_reminder_days} onChange={(e) => setF({ ...f, default_reminder_days: e.target.value })} onBlur={number('default_reminder_days', 0, 60, remSaved)} onKeyDown={onEnter} />
          {bad.default_reminder_days && <span id="set-rem-bad" className="set-bad" role="alert">{bad.default_reminder_days}</span>}
        </label>
        <label className="f"><span>Deadline after <span className="hint">(days)</span> {dueSaid}</span>
          <input type="number" inputMode="numeric" min={1} max={365} value={f.default_expire_days} aria-describedby={bad.default_expire_days ? 'set-due-bad' : undefined} aria-invalid={!!bad.default_expire_days} onChange={(e) => setF({ ...f, default_expire_days: e.target.value })} onBlur={number('default_expire_days', 1, 365, dueSaved)} onKeyDown={onEnter} />
          {bad.default_expire_days && <span id="set-due-bad" className="set-bad" role="alert">{bad.default_expire_days}</span>}
        </label>
        <label className="f"><span>Dates are written as {dateSaid}</span>
          <select value={f.default_date_format} onChange={(e) => { setF({ ...f, default_date_format: e.target.value }); send({ default_date_format: e.target.value }, dateSaved); }}>
            {DATE_FORMAT_CHOICES.map((x) => <option key={x} value={x}>{formatDate(new Date(), x, deviceZone())} ({x})</option>)}
          </select>
        </label>
      </div>
      {/* Said in full, because a new account has reminders on without anyone having chosen that. */}
      <p className="muted small" id="set-reminders"><b>New documents start like this.</b> {reminderText(reminders ?? a.default_reminder_days)} A new account starts at {DEFAULT_REMINDER_DAYS} days.</p>
      <details data-fold="">
        <summary className="set-fold">How this works</summary>
        <p className="muted small">Whoever sends sees the reminder setting on the last step before sending and can change it for that document. Documents that are already out keep what they were sent with.</p>
        <p className="muted small" style={{ marginBottom: 0 }}>The date format is used for the date each person signs on and for dates they pick in a date field. A format with the month as a word cannot be misread: 03/04/2026 is 3 April in most of the world and 4 March in the United States.</p>
      </details>
    </section>
  );
}
