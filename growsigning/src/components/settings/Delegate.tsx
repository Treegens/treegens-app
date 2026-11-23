'use client';
// Someone who signs for a person while they are away (src/server/delegation.ts).
//   DelegationSwitch  Settings, Team, for admins: the one switch, off by default (PUT /api/account/delegation). Only
//                     on an account with 2 or more members: alone, nobody else could ever send you a document from it.
//   Delegate          Settings, Away and sharing, listed only once the switch is on and the account has 2 or more
//                     members: "Documents sent to me: someone signs for me while I am away", a name, an address and
//                     two days (GET, PUT and DELETE /api/me/delegate).
// The words are in src/lib/delegation.ts, so the server, the emails and these cards say the same.
import { useState } from 'react';
import { api, useLoad, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { Card, useSaved } from '@/components/settings/Frame';
import { datesProblem, datesShort } from '@/lib/delegation';
import { useST, senderRich } from '@/components/senderLang';

export function DelegationSwitch() {
  const me = useMe();
  const T = useST();
  const [d, reload] = useLoad<any>(() => api('/account/delegation').catch(() => null), []);
  const [said, saved] = useSaved();
  const [busy, setBusy] = useState(false);
  if (!d || (Number(me.members) < 2 && !d.on)) return null;
  const flip = async (on: boolean) => {
    setBusy(true);
    try {
      await api('/account/delegation', { method: 'PUT', body: { on } });
      saved();
      reload();
      me.reload();
    } catch (e) {
      oops(e);
    }
    setBusy(false);
  };
  return (
    <Card><div className="card" data-feature="ds-delegate">
      <label className="setting-row" style={{ margin: 0, minHeight: 44 }}>
        <input type="checkbox" role="switch" checked={!!d.on} disabled={busy} aria-labelledby="dlg-switch-title" aria-describedby="dlg-switch-hint" onChange={(e) => void flip(e.target.checked)} />
        <span>
          <b id="dlg-switch-title">{T('delegation.switch_title')}</b> {said}
          <span className="muted small" id="dlg-switch-hint" style={{ display: 'block' }}>{T('delegation.switch_hint')}</span>
        </span>
      </label>
    </div></Card>
  );
}

export function Delegate() {
  const me = useMe();
  const T = useST();
  const [d, reload] = useLoad<any>(() => api('/me/delegate'), []);
  const [f, setF] = useState({ name: '', email: '', starts_on: '', ends_on: '' });
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, saved] = useSaved();
  if (!d || Number(me.members) < 2) return null;
  const has = d.delegate;
  const save = async () => {
    const p = datesProblem(f.starts_on, f.ends_on, d.today);
    if (!f.name.trim() || !f.email.trim()) return setProblem(T('settings.delegate.need_name'));
    if (p) return setProblem(p);
    setProblem('');
    setBusy(true);
    try {
      await api('/me/delegate', { method: 'PUT', body: f });
      saved();
      setF({ name: '', email: '', starts_on: '', ends_on: '' });
      reload();
    } catch (e: any) {
      setProblem(e?.code || e?.message ? T.error(e) : T('settings.not_saved'));
    }
    setBusy(false);
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api('/me/delegate', { method: 'DELETE' });
      saved();
      reload();
    } catch (e) {
      oops(e);
    }
    setBusy(false);
  };
  return (
    <Card><div className="card" data-feature="ds-delegate">
      <h2 style={{ marginBottom: 4 }}>{T('delegation.card_title')}</h2>
      <p className="muted small">{T('delegation.card_hint', { account: me.account?.name || T('delegation.this_account') })}</p>
      {!d.allowed ? <p className="notice">{T('settings.delegate.off')}</p>
        : !d.confirmed ? <p className="notice">{T('settings.delegate.confirm_first')}</p>
        : has ? (
          <div className="stack">
            <p role="status">{senderRich(T.lang, d.active ? (has.starts_on === d.today ? 'settings.delegate.signs_today' : 'settings.delegate.signs_started') : 'settings.delegate.signs', { name: <b>{has.name}</b> }, { email: has.email, when: datesShort(has.starts_on, has.ends_on) })}</p>
            <div className="row wrap">
              <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => void stop()}>{T(d.active ? 'settings.delegate.back' : 'settings.delegate.stop')}</button>
              {said}
            </div>
            <p className="muted small">{T('settings.delegate.after', { name: has.name })}</p>
          </div>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
            <div className="grid g2">
              <label className="f"><span>{T('settings.delegate.their_name')}</span><input value={f.name} autoComplete="off" onChange={(e) => setF({ ...f, name: e.target.value })} style={{ minHeight: 44 }} /></label>
              <label className="f"><span>{T('settings.delegate.their_email')}</span><input type="email" value={f.email} autoComplete="off" onChange={(e) => setF({ ...f, email: e.target.value })} style={{ minHeight: 44 }} /></label>
              <label className="f"><span>{T('settings.delegate.first_day')}</span><input type="date" value={f.starts_on} min={d.today} onChange={(e) => setF({ ...f, starts_on: e.target.value })} style={{ minHeight: 44 }} /></label>
              <label className="f"><span>{T('settings.delegate.last_day')}</span><input type="date" value={f.ends_on} min={f.starts_on || d.today} aria-describedby="dlg-both-days" onChange={(e) => setF({ ...f, ends_on: e.target.value })} style={{ minHeight: 44 }} />
                <span className="muted small" id="dlg-both-days">{T('settings.delegate.both_days')}</span></label>
            </div>
            {problem && <div className="notice err" role="alert">{problem}</div>}
            <div className="row wrap"><button className="btn primary" style={{ minHeight: 44 }} disabled={busy}>{T('settings.save')}</button>{said}</div>
            <p className="muted small">{T('settings.delegate.we_email')}</p>
          </form>
        )}
    </div></Card>
  );
}
