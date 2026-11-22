'use client';
// Settings, Security, for the owner and admins: "Members from your directory" (SCIM 2.0; GET and the rest of
// /api/account/directory, src/server/routes-scim.ts and scim.ts). Drawn only once single sign-on was tried with
// success, or while a token exists, so with zero setup nothing of it appears (research/ux-notes.json,
// ds-sso-saml-scim). The token is shown once, right after it is made; making a new one and stopping the directory sit
// in the card's More.
import { useState } from 'react';
import { api, useLoad, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { CodeField } from '@/components/TwoStep';
import { Card, useSaved } from '@/components/settings/Frame';
import { CopyValue } from '@/components/settings/CopyValue';
import { useST } from '@/components/senderLang';


type Dir = {
  available: boolean; offered: boolean; base_url: string; managed: boolean; people: number; code_needed: boolean; may_change?: boolean;
  token: { prefix: string; made_at: string; made_by: string | null; last_used_at: string | null } | null;
  heir: { id: string; name: string } | null;
};

export function OrgDirectory() {
  const say = useST();
  const me: any = useMe();
  // The owner and the built-in Admin role only: the directory can remove admins, so a role an admin made never runs it.
  const admin = (me.role === 'owner' || me.role === 'admin') && !me.my_role?.custom;
  const [d, reload] = useLoad<Dir | null>(() => (admin ? api('/account/directory') : Promise.resolve(null)), [admin]);
  const [team] = useLoad<any>(() => (admin ? api('/account/members') : Promise.resolve(null)), [admin]);
  const [made, setMade] = useState('');
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedSwitch, savedNow] = useSaved();
  if (!admin || !d || !d.available || d.may_change === false || (!d.offered && !d.token)) return null;
  const withCode = (b: any) => (d.code_needed ? { ...b, code } : b);
  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    setSaid(null);
    try {
      await fn();
      if (ok) setSaid({ text: ok });
      reload();
    } catch (e: any) {
      setSaid({ text: e.message, err: true });
    } finally {
      setBusy(false);
    }
  };
  const makeToken = () => act(async () => setMade((await api('/account/directory/token', { method: 'POST', body: withCode({}) })).token));
  const others: any[] = (team?.members || []).filter((m: any) => m.role !== 'owner');

  return (
    <Card>
      <section className="card stack" data-feature="ds-sso-saml-scim" aria-labelledby="dir-h">
        <h2 id="dir-h" className="set-group">{say('directory.title')}</h2>
        <p className="muted small" style={{ margin: 0 }}>{say('directory.lead')} {say('directory.how')}</p>
        {said && <div className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'}>{said.text}</div>}
        {d.code_needed && <CodeField id="dir-code" value={code} onChange={setCode} label={say('directory.code_label')} either />}
        {d.token && !d.offered && <p className="notice warn small" role="status" style={{ margin: 0 }}>{say('directory.paused')}</p>}
        <CopyValue label={say('directory.base')} value={d.base_url} button={say('directory.copy_base')} />
        {made && (
          <div className="notice" role="status">
            <p style={{ margin: '0 0 6px' }}>{say('directory.token_once')}</p>
            <CopyValue value={made} button={say('directory.copy_token')} />
          </div>
        )}
        {!d.token ? (
          <div><button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={makeToken}>{say('directory.make')}</button></div>
        ) : (
          <>
            <p className="small" style={{ margin: 0 }}>
              {say('directory.token_made', { prefix: d.token.prefix, day: fmtDate(d.token.made_at), who: d.token.made_by || '' })} {d.token.last_used_at ? say('directory.token_used', { day: fmtDate(d.token.last_used_at) }) : say('directory.token_unused')} {say('directory.people', { count: d.people })}
            </p>
            <label className="check" style={{ minHeight: 44 }}><input type="checkbox" checked={d.managed} disabled={busy} onChange={(e) => act(async () => { await api('/account/directory', { method: 'PATCH', body: { managed: e.target.checked } }); savedNow(); })} /> {say('directory.managed')}</label>
            <p className="muted small" style={{ margin: '0 0 0 28px' }}>{say('directory.managed_hint')}</p>
            <label className="f" style={{ margin: 0 }}><span>{say('directory.heir')}</span>
              <select value={d.heir?.id || ''} disabled={busy} style={{ minHeight: 44 }} onChange={(e) => act(async () => { await api('/account/directory', { method: 'PATCH', body: { heir_id: e.target.value || null } }); savedNow(); })}>
                <option value="">{say('directory.heir_owner')}</option>
                {others.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
              </select>
            </label>
            {savedSwitch}
            <details data-more="item" className="set-more">
              <summary>{say('settings.more')}</summary>
              <div className="stack" style={{ gap: 8 }}>
                <div><button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={makeToken}>{say('directory.remake')}</button> <span className="hint">{say('directory.remake_hint')}</span></div>
                <div><button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => act(async () => { await api('/account/directory/token', { method: 'DELETE', body: withCode({}) }); setMade(''); }, say('directory.stopped'))}>{say('directory.stop')}</button></div>
              </div>
            </details>
          </>
        )}
      </section>
    </Card>
  );
}
