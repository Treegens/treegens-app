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
import { CARD_TITLE, CARD_HINT, RECEIVED_TITLE, LEVEL_WORDS, SHARE_LEVELS, shareDates, shareDatesProblem, type ShareLevel } from '@/lib/shares';

const todayHere = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function ShareRow({ s, who, onEnd, busy }: { s: any; who: string; onEnd: () => void; busy: boolean }) {
  const state = !s.active ? (s.waiting ? 'Starts later' : 'Not in force') : '';
  return (
    <li className="setting-row" data-item="share" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span className="grow">
        <b>{who}</b>: {LEVEL_WORDS[s.level as ShareLevel]?.name || s.level}, {shareDates(s.starts_on, s.ends_on)}.{state ? ` ${state}.` : ''}
      </span>
      <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={onEnd} aria-label={`End sharing with ${who} now`}>End now</button>
    </li>
  );
}

export function Shares() {
  const [d, reload] = useLoad<any>(() => api('/me/shares').catch(() => null), []);
  const [said, saved] = useSaved('Shared');
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
    if (!form.grantee) return setErr('Choose a colleague to share with. Nothing was shared.');
    const problem = shareDatesProblem(form.starts_on || today, form.ends_on, today);
    if (problem) return setErr(`${problem} Nothing was shared.`);
    setBusy(true);
    try {
      await api('/me/shares', { body: { ...form, starts_on: form.starts_on || today } });
      setForm({ grantee: '', level: 'see', starts_on: '', ends_on: '' });
      saved();
      reload();
    } catch (e: any) {
      setErr(e?.message || 'That did not work. Nothing was shared. Try again.');
    }
    setBusy(false);
  };
  const others = (d.all || []).filter((s: any) => !d.given.some((g: any) => g.id === s.id) && !d.received.some((r: any) => r.id === s.id));
  return (
    <>
      <Card><div className="card stack" data-feature="ds-colleagues">
        <h2 style={{ margin: 0 }} id="shr-title">{CARD_TITLE}</h2>
        <p className="muted small" style={{ margin: 0 }}>{CARD_HINT}</p>
        {d.given.length > 0 && (
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Shared by you">
            {d.given.map((s: any) => <ShareRow key={s.id} s={s} who={s.grantee.name} busy={busy} onEnd={() => void end(s.id)} />)}
          </ul>
        )}
        <div className="stack" role="group" aria-labelledby="shr-title">
          <label className="f">
            <span>Colleague</span>
            <select id="shr-colleague" value={form.grantee} style={{ minHeight: 44 }} onChange={(e) => setForm({ ...form, grantee: e.target.value })}>
              <option value="">Choose a colleague</option>
              {d.colleagues.map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
            </select>
          </label>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>What they may do</legend>
            {SHARE_LEVELS.map((l) => (
              <label key={l} className="setting-row" style={{ minHeight: 44, margin: 0 }}>
                <input type="radio" name="shr-level" value={l} checked={form.level === l} onChange={() => setForm({ ...form, level: l })} />
                <span><b>{LEVEL_WORDS[l].name}</b><span className="muted small" style={{ display: 'block' }}>{LEVEL_WORDS[l].covers}</span></span>
              </label>
            ))}
          </fieldset>
          <div className="grid g2">
            <label className="f"><span>First day</span><input type="date" min={today} value={form.starts_on || today} style={{ minHeight: 44 }} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} /></label>
            <label className="f"><span>Last day (empty: until you end it)</span><input type="date" min={form.starts_on || today} value={form.ends_on} style={{ minHeight: 44 }} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} /></label>
          </div>
          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => void give()}>Share with a colleague</button>
            {said}
          </div>
        </div>
      </div></Card>
      {d.received.length > 0 && (
        <Card><div className="card stack" data-feature="ds-colleagues">
          <h2 style={{ margin: 0 }}>{RECEIVED_TITLE}</h2>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={RECEIVED_TITLE}>
            {d.received.map((s: any) => <ShareRow key={s.id} s={s} who={s.owner.name} busy={busy} onEnd={() => void end(s.id)} />)}
          </ul>
          {d.received.filter((s: any) => s.active).map((s: any) => <p key={s.id} className="small" style={{ margin: 0 }}><Link href={`/app/envelopes?sender=${encodeURIComponent(s.owner.id)}`} style={{ display: 'inline-block', minHeight: 44, lineHeight: '44px' }}>Open {s.owner.name}&apos;s documents</Link></p>)}
        </div></Card>
      )}
      {others.length > 0 && (
        <Card><div className="card stack" data-feature="ds-colleagues">
          <h2 style={{ margin: 0 }}>Everyone&apos;s shares in this account</h2>
          <p className="muted small" style={{ margin: 0 }}>You see these because you are an admin. Ending one stops it at once.</p>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Everyone's shares">
            {others.map((s: any) => <ShareRow key={s.id} s={s} who={`${s.owner.name} to ${s.grantee.name}`} busy={busy} onEnd={() => void end(s.id)} />)}
          </ul>
        </div></Card>
      )}
    </>
  );
}

export function MoveDocuments({ members }: { members: any[] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, saved] = useSaved('Moved');
  const [err, setErr] = useState('');
  // Asked first, with the numbers: { documents, templates } from GET .../move-documents.
  const [ask, setAsk] = useState<{ documents: number; templates: number } | null>(null);
  if (!members || members.length < 2) return null;
  const id = (m: any) => m.user_id || m.id;
  const nameOf = (x: string) => members.find((m: any) => id(m) === x)?.name || 'them';
  const check = async () => {
    setErr('');
    if (!from || !to) return setErr('Choose whose documents to move and to whom. Nothing was moved.');
    if (from === to) return setErr('Those are the same person. Choose someone else to move them to. Nothing was moved.');
    setBusy(true);
    try {
      const n = await api(`/account/members/${from}/move-documents`);
      if (!n.documents && !n.templates) setErr(`${nameOf(from)} has no documents or templates. Nothing was moved.`);
      else setAsk(n);
    } catch (e: any) {
      setErr(e?.message || 'That did not work. Nothing was moved. Try again.');
    }
    setBusy(false);
  };
  const go = async () => {
    await api(`/account/members/${from}/move-documents`, { body: { to } });
    setAsk(null);
    saved();
  };
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return (
    <div className="card stack" data-feature="ds-colleagues">
      <h3 style={{ margin: 0 }}>Move a member&apos;s documents</h3>
      <p className="muted small" style={{ margin: 0 }}>Everything one member sent, and their templates, then belong to another member. Each document&apos;s history says who moved it, and its certificate keeps who sent it first.</p>
      <div className="grid g2">
        <label className="f"><span>From</span><select value={from} style={{ minHeight: 44 }} onChange={(e) => setFrom(e.target.value)}><option value="">Choose a member</option>{members.map((m: any) => <option key={id(m)} value={id(m)}>{m.name}</option>)}</select></label>
        <label className="f"><span>To</span><select value={to} style={{ minHeight: 44 }} onChange={(e) => setTo(e.target.value)}><option value="">Choose a member</option>{members.map((m: any) => <option key={id(m)} value={id(m)}>{m.name}</option>)}</select></label>
      </div>
      {err && <div className="notice" role="status">{err}</div>}
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => void check()}>Move their documents</button>
        {said}
      </div>
      {ask && (
        <ConfirmDialog title={`Move ${nameOf(from)}'s documents to ${nameOf(to)}?`} confirmLabel="Move them" keepLabel="Keep them where they are" danger={false} unchanged="Nothing was moved." onClose={() => setAsk(null)} onConfirm={go}>
          <p>{count(ask.documents, 'document')} and {count(ask.templates, 'template')} then belong to {nameOf(to)}. Each history says you moved them. There is no undo, but you can move them back the same way.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
