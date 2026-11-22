'use client';
// Working for a colleague in Settings (src/server/shares.ts):
//   Shares        Settings, Away and sharing (accounts with 2 or more members): "Documents I send: a colleague looks after them",
//                 the shares given and received, and for an admin of the team every share in the account, each with
//                 "End now" (GET, POST and DELETE /api/me/shares).
//   MoveDocuments Settings, Team, More options, for admins: every document and template of one member to another
//                 (POST /api/account/members/:id/move-documents).
// The words are in src/lib/shares.ts, so the server, the emails and these cards say the same.
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, oops } from '@/components/ui';
import { Card, useSaved } from '@/components/settings/Frame';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { SHARE_LEVELS, shareDates, shareDatesProblem, type ShareLevel } from '@/lib/shares';
import { useST, senderRich } from '@/components/senderLang';

const todayHere = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function ShareRow({ s, who, onEnd, busy }: { s: any; who: string; onEnd: () => void; busy: boolean }) {
  const T = useST();
  const state = !s.active ? T(s.waiting ? 'settings.shares.later' : 'settings.shares.not_in_force') : '';
  return (
    <li className="setting-row" data-item="share" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span className="grow">
        {senderRich(T.lang, 'settings.shares.row', { who: <b>{who}</b> }, { level: (SHARE_LEVELS as readonly string[]).includes(s.level) ? T(`shares.level.${s.level}.name`) : s.level, dates: shareDates(s.starts_on, s.ends_on) })}{state ? ` ${state}.` : ''}
      </span>
      <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={onEnd} aria-label={T('settings.shares.end_one', { who })}>{T('settings.shares.end')}</button>
    </li>
  );
}

export function Shares() {
  const T = useST();
  const [d, reload] = useLoad<any>(() => api('/me/shares').catch(() => null), []);
  const [said, saved] = useSaved(T('settings.shares.shared'));
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ grantee: '', level: 'see' as ShareLevel, starts_on: '', ends_on: '' });
  const [err, setErr] = useState('');
  if (!d) return null;
  const today = todayHere();
  const end = async (id: string) => {
    setBusy(true);
    try {
      await api(`/me/shares/${id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      oops(e);
    }
    setBusy(false);
  };
  const give = async () => {
    setErr('');
    if (!form.grantee) return setErr(T('settings.shares.choose'));
    const problem = shareDatesProblem(form.starts_on || today, form.ends_on, today);
    if (problem) return setErr(`${problem} ${T('settings.shares.nothing')}`);
    setBusy(true);
    try {
      await api('/me/shares', { body: { ...form, starts_on: form.starts_on || today } });
      setForm({ grantee: '', level: 'see', starts_on: '', ends_on: '' });
      saved();
      reload();
    } catch (e: any) {
      setErr(e?.code || e?.message ? T.error(e) : T('settings.shares.failed'));
    }
    setBusy(false);
  };
  const others = (d.all || []).filter((s: any) => !d.given.some((g: any) => g.id === s.id) && !d.received.some((r: any) => r.id === s.id));
  return (
    <>
      <Card><div className="card stack" data-feature="ds-colleagues">
        <h2 style={{ margin: 0 }} id="shr-title">{T('shares.card_title')}</h2>
        <p className="muted small" style={{ margin: 0 }}>{T('shares.card_hint')}</p>
        {d.given.length > 0 && (
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={T('settings.shares.by_you')}>
            {d.given.map((s: any) => <ShareRow key={s.id} s={s} who={s.grantee.name} busy={busy} onEnd={() => void end(s.id)} />)}
          </ul>
        )}
        <div className="stack" role="group" aria-labelledby="shr-title">
          <label className="f">
            <span>{T('settings.shares.colleague')}</span>
            <select id="shr-colleague" value={form.grantee} style={{ minHeight: 44 }} onChange={(e) => setForm({ ...form, grantee: e.target.value })}>
              <option value="">{T('settings.shares.choose_colleague')}</option>
              {d.colleagues.map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
            </select>
          </label>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{T('settings.shares.may_do')}</legend>
            {SHARE_LEVELS.map((l) => (
              <label key={l} className="setting-row" style={{ minHeight: 44, margin: 0 }}>
                <input type="radio" name="shr-level" value={l} checked={form.level === l} onChange={() => setForm({ ...form, level: l })} />
                <span><b>{T(`shares.level.${l}.name`)}</b><span className="muted small" style={{ display: 'block' }}>{T(`shares.level.${l}.covers`)}</span></span>
              </label>
            ))}
          </fieldset>
          <div className="grid g2">
            <label className="f"><span>{T('settings.delegate.first_day')}</span><input type="date" min={today} value={form.starts_on || today} style={{ minHeight: 44 }} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} /></label>
            <label className="f"><span>{T('settings.shares.last_day')}</span><input type="date" min={form.starts_on || today} value={form.ends_on} style={{ minHeight: 44 }} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} /></label>
          </div>
          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => void give()}>{T('settings.shares.give')}</button>
            {said}
          </div>
        </div>
      </div></Card>
      {d.received.length > 0 && (
        <Card><div className="card stack" data-feature="ds-colleagues">
          <h2 style={{ margin: 0 }}>{T('shares.received_title')}</h2>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={T('shares.received_title')}>
            {d.received.map((s: any) => <ShareRow key={s.id} s={s} who={s.owner.name} busy={busy} onEnd={() => void end(s.id)} />)}
          </ul>
          {d.received.filter((s: any) => s.active).map((s: any) => <p key={s.id} className="small" style={{ margin: 0 }}><Link href={`/app/envelopes?sender=${encodeURIComponent(s.owner.id)}`} style={{ display: 'inline-block', minHeight: 44, lineHeight: '44px' }}>{T('settings.shares.open', { name: s.owner.name })}</Link></p>)}
        </div></Card>
      )}
      {others.length > 0 && (
        <Card><div className="card stack" data-feature="ds-colleagues">
          <h2 style={{ margin: 0 }}>{T('settings.shares.everyone')}</h2>
          <p className="muted small" style={{ margin: 0 }}>{T('settings.shares.admin_note')}</p>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={T('settings.shares.everyone_list')}>
            {others.map((s: any) => <ShareRow key={s.id} s={s} who={T('settings.shares.from_to', { from: s.owner.name, to: s.grantee.name })} busy={busy} onEnd={() => void end(s.id)} />)}
          </ul>
        </div></Card>
      )}
    </>
  );
}

export function MoveDocuments({ members }: { members: any[] }) {
  const T = useST();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, saved] = useSaved(T('settings.move.moved'));
  const [err, setErr] = useState('');
  // Asked first, with the numbers: { documents, templates } from GET .../move-documents.
  const [ask, setAsk] = useState<{ documents: number; templates: number } | null>(null);
  if (!members || members.length < 2) return null;
  const id = (m: any) => m.user_id || m.id;
  const nameOf = (x: string) => members.find((m: any) => id(m) === x)?.name || T('settings.move.them');
  const check = async () => {
    setErr('');
    if (!from || !to) return setErr(T('settings.move.choose'));
    if (from === to) return setErr(T('settings.move.same'));
    setBusy(true);
    try {
      const n = await api(`/account/members/${from}/move-documents`);
      if (!n.documents && !n.templates) setErr(T('settings.move.none', { name: nameOf(from) }));
      else setAsk(n);
    } catch (e: any) {
      setErr(e?.code || e?.message ? T.error(e) : T('settings.move.failed'));
    }
    setBusy(false);
  };
  const go = async () => {
    await api(`/account/members/${from}/move-documents`, { body: { to } });
    setAsk(null);
    saved();
  };
  return (
    <div className="card stack" data-feature="ds-colleagues">
      <h3 style={{ margin: 0 }}>{T('settings.move.title')}</h3>
      <p className="muted small" style={{ margin: 0 }}>{T('settings.move.lead')}</p>
      <div className="grid g2">
        <label className="f"><span>{T('settings.move.from')}</span><select value={from} style={{ minHeight: 44 }} onChange={(e) => setFrom(e.target.value)}><option value="">{T('settings.move.choose_member')}</option>{members.map((m: any) => <option key={id(m)} value={id(m)}>{m.name}</option>)}</select></label>
        <label className="f"><span>{T('settings.move.to')}</span><select value={to} style={{ minHeight: 44 }} onChange={(e) => setTo(e.target.value)}><option value="">{T('settings.move.choose_member')}</option>{members.map((m: any) => <option key={id(m)} value={id(m)}>{m.name}</option>)}</select></label>
      </div>
      {err && <div className="notice" role="status">{err}</div>}
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => void check()}>{T('settings.move.button')}</button>
        {said}
      </div>
      {ask && (
        <ConfirmDialog title={T('settings.move.ask', { from: nameOf(from), to: nameOf(to) })} confirmLabel={T('settings.move.confirm')} keepLabel={T('settings.move.keep')} danger={false} unchanged={T('settings.move.unchanged')} onClose={() => setAsk(null)} onConfirm={go}>
          <p>{T('settings.move.what', { documents: T('settings.move.documents', { count: ask.documents }), templates: T('settings.move.templates', { count: ask.templates }), to: nameOf(to) })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
