'use client';
// The one screen of a team whose "Shortest password" rule this member's password breaks (src/server/secpolicy.ts,
// rulesGate). The server opens nothing else of that team to them until they have chosen a longer one, so the app
// draws only this: the form that fixes it, the way out when they do not know the password, and their other
// workspaces, which are not affected. Nothing they had is lost. The owner never sees it (the card tells them).
import { useState } from 'react';
import { api } from './ui';
import { CodeField } from './TwoStep';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const say = (key: string, vars: Record<string, string | number> = {}) => t(SOURCE_LOCALE, key, vars);

export function PasswordRequired({ me }: { me: any }) {
  const min = Number(me.rules?.password_needed) || 8;
  const account = me.account.name;
  const others = (me.accounts || []).filter((a: any) => a.id !== me.account.id);
  const [f, setF] = useState({ current: '', password: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const codeNeeded = !!me.two_step?.on;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/me/password', { body: { current: f.current, password: f.password, ...(codeNeeded ? { code: f.code } : {}) } });
      window.location.assign('/app');
    } catch (err: any) {
      setError(err?.message || say('rules.short.failed'));
      setBusy(false);
    }
  }
  return (
    <main className="authbox pw-need" style={{ maxWidth: 560 }} data-feature="ds-sec-policy">
      <form className="card" onSubmit={submit}>
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>{say('rules.short.title', { account })}</h1>
        <p>{say('rules.short.body', { account, min })}</p>
        <label className="f"><span>{say('rules.short.current')}</span>
          <input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
        <label className="f"><span>{say('rules.short.new', { min })}</span>
          <input type="password" autoComplete="new-password" required minLength={min} maxLength={200} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {codeNeeded && <CodeField id="pw-code" value={f.code} onChange={(v) => setF({ ...f, code: v })} label={say('rules.code.label')} either />}
        {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" disabled={busy}>{say('rules.short.button')}</button>
        <hr style={{ margin: '18px 0', border: 0, borderTop: '1px solid var(--line)' }} />
        <p className="small muted">{say('rules.short.forgot')}</p>
        <div className="actions">
          {others.map((a: any) => <button type="button" key={a.id} className="btn" onClick={() => api('/auth/switch', { body: { account_id: a.id } }).then(() => window.location.assign('/app')).catch((err: any) => setError(err?.message || say('rules.short.failed')))}>{say('rules.short.switch', { account: a.name })}</button>)}
          <button type="button" className="btn" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.assign('/login'))}>{say('rules.short.sign_out')}</button>
        </div>
      </form>
    </main>
  );
}
