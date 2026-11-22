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
import { SWITCH_TITLE, SWITCH_HINT, CARD_TITLE, CARD_HINT, datesProblem, datesShort } from '@/lib/delegation';

export function DelegationSwitch() {
  const me = useMe();
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
          <b id="dlg-switch-title">{SWITCH_TITLE}</b> {said}
          <span className="muted small" id="dlg-switch-hint" style={{ display: 'block' }}>{SWITCH_HINT}</span>
        </span>
      </label>
    </div></Card>
  );
}

export function Delegate() {
  const me = useMe();
  const [d, reload] = useLoad<any>(() => api('/me/delegate'), []);
  const [f, setF] = useState({ name: '', email: '', starts_on: '', ends_on: '' });
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, saved] = useSaved();
  if (!d || Number(me.members) < 2) return null;
  const has = d.delegate;
  const save = async () => {
    const p = datesProblem(f.starts_on, f.ends_on, d.today);
    if (!f.name.trim() || !f.email.trim()) return setProblem('Type the name and the email address of the person who signs for you.');
    if (p) return setProblem(p);
    setProblem('');
    setBusy(true);
    try {
      await api('/me/delegate', { method: 'PUT', body: f });
      saved();
      setF({ name: '', email: '', starts_on: '', ends_on: '' });
      reload();
    } catch (e: any) {
      setProblem(e?.message || 'That was not saved. Try again in a moment.');
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
      <h2 style={{ marginBottom: 4 }}>{CARD_TITLE}</h2>
      <p className="muted small">{CARD_HINT(me.account?.name || 'this account')}</p>
      {!d.allowed ? <p className="notice">The admins of this account turned this off. Anything you set before has stopped.</p>
        : !d.confirmed ? <p className="notice">Confirm your email address first: type the 6-digit code from our email in the box at the top.</p>
        : has ? (
          <div className="stack">
            <p role="status"><b>{has.name}</b> ({has.email}) signs for you {datesShort(has.starts_on, has.ends_on)}{d.active ? (has.starts_on === d.today ? ', starting today' : ', and that has started') : ''}.</p>
            <div className="row wrap">
              <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => void stop()}>{d.active ? 'I am back: stop it now' : 'Stop it'}</button>
              {said}
            </div>
            <p className="muted small">Documents {has.name} has already taken on stay with them. Any they have not taken on yet come back to you only.</p>
          </div>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
            <div className="grid g2">
              <label className="f"><span>Their name</span><input value={f.name} autoComplete="off" onChange={(e) => setF({ ...f, name: e.target.value })} style={{ minHeight: 44 }} /></label>
              <label className="f"><span>Their email address</span><input type="email" value={f.email} autoComplete="off" onChange={(e) => setF({ ...f, email: e.target.value })} style={{ minHeight: 44 }} /></label>
              <label className="f"><span>First day</span><input type="date" value={f.starts_on} min={d.today} onChange={(e) => setF({ ...f, starts_on: e.target.value })} style={{ minHeight: 44 }} /></label>
              <label className="f"><span>Last day</span><input type="date" value={f.ends_on} min={f.starts_on || d.today} aria-describedby="dlg-both-days" onChange={(e) => setF({ ...f, ends_on: e.target.value })} style={{ minHeight: 44 }} />
                <span className="muted small" id="dlg-both-days">Both days are included.</span></label>
            </div>
            {problem && <div className="notice err" role="alert">{problem}</div>}
            <div className="row wrap"><button className="btn primary" style={{ minHeight: 44 }} disabled={busy}>Save</button>{said}</div>
            <p className="muted small">We email them now to say you named them.</p>
          </form>
        )}
    </div></Card>
  );
}
