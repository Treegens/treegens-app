'use client';
// Settings, Security, for the owner and admins: the card "Single sign-on" (GET and the rest of /api/account/sso,
// src/server/routes-orgsso.ts; the rules are in src/server/orgsso.ts). Two parts in one card, as the charter has it
// (research/ux-notes.json, ds-sso-oidc): "Your email domains" and "Your sign-in service", then the two switches once
// the service has been tried, and "Remove single sign-on" in More options. Without FILE_ENCRYPTION_KEY on the server
// the card is not drawn at all.
import { useEffect, useState } from 'react';
import { api, useLoad, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { CodeField } from '@/components/TwoStep';
import { Card, useSaved } from '@/components/settings/Frame';
import { ssoErrorText } from '@/lib/orgsso';
import { isSamlWhy } from '@/lib/samlscim';
import { OrgSaml, type SamlCard } from '@/components/settings/OrgSaml';
import { useST } from '@/components/senderLang';

// A long domain name wraps inside its button instead of pushing the page sideways on a phone.
const wraps = { whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: '100%', textAlign: 'left' } as const;

type Domain = { id: string; domain: string; state: 'waiting' | 'claimed' | 'lost'; use_sso: boolean; verified_at: string | null; record: { type: string; name: string; value: string } };
type Service = { kind?: 'oidc' | 'saml'; name: string; issuer: string; client_id: string; enforce: boolean; join_new: boolean; tested_at: string | null; tested_by: string | null };
type Card = { available: boolean; domains: Domain[]; service: Service | null; redirect_uri: string; session_hours: number; owner_two_step: boolean; code_needed: boolean; saml?: SamlCard };

export function OrgSso() {
  const say = useST();
  const me: any = useMe();
  const admin = me.role === 'owner' || me.role === 'admin';
  const [d, reload] = useLoad<Card | null>(() => (admin ? api('/account/sso') : Promise.resolve(null)), [admin]);
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [f, setF] = useState({ name: '', issuer: '', client_id: '', client_secret: '' });
  // OpenID Connect or SAML 2.0 (OrgSaml.tsx): the standard the service speaks, chosen here, the saved one first.
  const [kind, setKind] = useState<'oidc' | 'saml'>('oidc');
  useEffect(() => setKind(d?.service?.kind === 'saml' ? 'saml' : 'oidc'), [d?.service?.kind]);
  const [checked, setChecked] = useState<Record<string, string>>({});
  const [savedSwitch, savedNow] = useSaved();
  // What the trip through the service from "Try a sign-in" ended with, said once and taken out of the address.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('sso') === 'tried') setSaid({ text: 'tried' });
    // A SAML answer refused during "Try a sign-in" says why, and what to change at the identity provider.
    else if (q.get('sso_error')) setSaid({ text: isSamlWhy(q.get('sso_why')) ? say(`saml.why.${q.get('sso_why')}`) : ssoErrorText(q.get('sso_error')), err: true });
    if (q.get('sso') || q.get('sso_error')) window.history.replaceState(null, '', '/app/settings?tab=security');
  }, []);
  useEffect(() => {
    if (d?.service) setF({ name: d.service.name, issuer: d.service.issuer, client_id: d.service.client_id, client_secret: '' });
  }, [d?.service?.name, d?.service?.issuer, d?.service?.client_id]);
  if (!admin || !d || !d.available) return null;
  const s = d.service;
  const withCode = (b: any) => (d.code_needed ? { ...b, code } : b);
  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    setSaid(null);
    try {
      await fn();
      if (ok) setSaid({ text: ok });
      reload();
      return true;
    } catch (e: any) {
      setSaid({ text: e.message, err: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const claimed = d.domains.filter((x) => x.state === 'claimed');

  return (
    <Card>
    <section className="card stack" data-feature="ds-sso-oidc" aria-labelledby="sso-h">
      <h2 id="sso-h" className="set-group">{say('sso.title')}</h2>
      <p className="muted small" style={{ margin: 0 }}>{say('sso.lead', { hours: d.session_hours })}</p>
      {said && <div className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'}>{said.text === 'tried' ? say('sso.service.tried_now', { name: s?.name || '' }) : said.text}</div>}
      {d.code_needed && <CodeField id="sso-code" value={code} onChange={setCode} label={say('sso.code_label')} either />}

      <h3 style={{ fontSize: 16, margin: '8px 0 0' }}>{say('sso.domains.title')}</h3>
      <p className="muted small" style={{ margin: 0 }}>{say('sso.domains.lead')}</p>
      {d.domains.map((x) => (
        <div key={x.id} data-item="domain" className="set-row stack" style={{ gap: 6 }}>
          <div style={{ overflowWrap: 'anywhere' }}><strong>{x.domain}</strong> <span className={x.state === 'lost' ? 'notice warn small' : 'muted small'}>{x.state === 'claimed' ? `${say('sso.domains.claimed', { day: fmtDate(x.verified_at) })}${s && !x.use_sso ? ` ${say('sso.domains.not_used')}` : ''}` : x.state === 'lost' ? say('sso.domains.lost') : say('sso.domains.waiting')}</span></div>
          {x.state !== 'claimed' && (
            <div className="small">
              <p style={{ margin: '0 0 4px' }}>{say('sso.domains.record', { domain: x.domain })}</p>
              <div>{say('sso.domains.record_name')}: <code style={{ wordBreak: 'break-all' }}>{x.record.name}</code></div>
              <div>{say('sso.domains.record_value')}: <code style={{ wordBreak: 'break-all' }}>{x.record.value}</code></div>
              <button type="button" className="btn" style={{ marginTop: 8, ...wraps }} disabled={busy} onClick={() => act(async () => {
                const r = await api(`/account/sso/domains/${x.id}/check`, { method: 'POST' });
                setChecked({ ...checked, [x.id]: r.found === 'found' ? say('sso.domains.found', { domain: x.domain }) : r.found === 'unknown' ? say('sso.domains.unknown') : say('sso.domains.not_found') });
              })}>{say('sso.domains.check', { domain: x.domain })}</button>
              {checked[x.id] && <p className="small" role="status" style={{ margin: '6px 0 0' }}>{checked[x.id]}</p>}
            </div>
          )}
          {/* A claimed domain uses the service; taking one out of it is rare, so it sits in More with Remove. */}
          <details data-more="item" className="set-more">
            <summary>{say('settings.more')}</summary>
            <div className="stack" style={{ gap: 8 }}>
              {x.state === 'claimed' && s && (
                <div><button type="button" className="btn" style={wraps} disabled={busy} onClick={() => act(() => api(`/account/sso/domains/${x.id}`, { method: 'PATCH', body: withCode({ use_sso: !x.use_sso }) }))}>{say(x.use_sso ? 'sso.domains.stop' : 'sso.domains.use', { domain: x.domain })}</button></div>
              )}
              <div><button type="button" className="btn" style={wraps} disabled={busy} onClick={() => act(() => api(`/account/sso/domains/${x.id}`, { method: 'DELETE', body: withCode({}) }))}>{say('sso.domains.remove', { domain: x.domain })}</button></div>
            </div>
          </details>
        </div>
      ))}
      <form className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); act(async () => { await api('/account/sso/domains', { body: { domain: newDomain } }); setNewDomain(''); }); }}>
        <label className="f" style={{ flex: '1 1 180px', margin: 0 }}><span>{say('sso.domains.label')}</span><input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="example.org" autoCapitalize="off" spellCheck={false} required /></label>
        <button className="btn" disabled={busy}>{say('sso.domains.add')}</button>
      </form>

      <h3 style={{ fontSize: 16, margin: '8px 0 0' }}>{say('sso.service.title')}</h3>
      {d.saml && (
        <fieldset className="row wrap" style={{ gap: 16, border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ padding: 0, marginBottom: 4 }}>{say('saml.standard_label')}</legend>
          {(['oidc', 'saml'] as const).map((k) => (
            <label key={k} className="check" style={{ minHeight: 44 }}><input type="radio" name="sso-kind" checked={kind === k} onChange={() => setKind(k)} /> {say(`saml.kind.${k}`)}</label>
          ))}
        </fieldset>
      )}
      {kind === 'saml' && d.saml ? <OrgSaml saml={d.saml} name={s?.name || ''} saved={s?.kind === 'saml' && !!d.saml.idp} busy={busy} act={act} withCode={withCode} /> : (
      <form className="stack" style={{ gap: 0 }} onSubmit={(e) => { e.preventDefault(); act(() => api('/account/sso', { method: 'PUT', body: withCode({ ...f, client_secret: f.client_secret || undefined }) }).then(() => setF({ ...f, client_secret: '' })), say('settings.saved_dot')); }}>
        <label className="f"><span>{say('sso.service.name')} <span className="hint">{say('sso.service.name_hint')}</span></span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} required /></label>
        <label className="f"><span>{say('sso.service.issuer')} <span className="hint">{say('sso.service.issuer_hint')}</span></span><input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder="https://login.example.org" inputMode="url" autoCapitalize="off" spellCheck={false} required /></label>
        <label className="f"><span>{say('sso.service.client_id')} <span className="hint">{say('sso.service.client_id_hint')}</span></span><input value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })} autoCapitalize="off" spellCheck={false} required /></label>
        <label className="f"><span>{say('sso.service.secret')} <span className="hint">{say(s ? 'sso.service.secret_kept' : 'sso.service.secret_hint')}</span></span><input type="password" value={f.client_secret} onChange={(e) => setF({ ...f, client_secret: e.target.value })} autoComplete="off" required={!s} /></label>
        <p className="small" style={{ margin: '0 0 10px' }}>{say('sso.service.redirect')} <code style={{ wordBreak: 'break-all' }}>{d.redirect_uri}</code></p>
        <div><button className="btn" disabled={busy}>{say('sso.service.save')}</button></div>
      </form>
      )}
      {s && (
        <div className="stack" style={{ gap: 6 }}>
          <p className="small" style={{ margin: 0 }}>{s.tested_at ? (s.tested_by ? say('sso.service.tried', { day: fmtDate(s.tested_at), who: s.tested_by }) : say('sso.service.tried_day', { day: fmtDate(s.tested_at) })) : say('sso.service.untried')}</p>
          <div><button type="button" className="btn" disabled={busy} onClick={() => act(async () => { const r = await api('/account/sso/try', { method: 'POST' }); window.location.assign(r.url); })}>{say('sso.service.try')}</button></div>
        </div>
      )}
      {s?.tested_at && claimed.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="check" style={{ minHeight: 44 }}><input type="checkbox" checked={s.enforce} disabled={busy} onChange={(e) => act(async () => { await api('/account/sso/rules', { method: 'PATCH', body: withCode({ enforce: e.target.checked }) }); savedNow(); })} /> {say('sso.rules.enforce', { name: s.name })}</label>
          <p className="muted small" style={{ margin: '0 0 0 28px' }}>{say('sso.rules.enforce_hint', { hours: d.session_hours })}{!d.owner_two_step && !s.enforce ? ` ${say(me.role === 'owner' ? 'sso.rules.owner_two_step_you' : 'sso.rules.owner_two_step')}` : ''}</p>
          {/* On, but the owner's two-step login went (a reset by email after a lost phone, say): said plainly, every time. */}
          {s.enforce && !d.owner_two_step && <div className="notice warn small" role="status" style={{ marginLeft: 28 }}>{say(me.role === 'owner' ? 'sso.rules.no_way_back_you' : 'sso.rules.no_way_back', { name: s.name })}</div>}
          <label className="check" style={{ minHeight: 44 }}><input type="checkbox" checked={s.join_new} disabled={busy} onChange={(e) => act(async () => { await api('/account/sso/rules', { method: 'PATCH', body: withCode({ join_new: e.target.checked }) }); savedNow(); })} /> {say('sso.rules.join')}</label>
          {savedSwitch}
        </div>
      )}
      {s && (
        <details data-more="item" className="set-more">
          <summary>{say('settings.more')}</summary>
          <div><button type="button" className="btn" disabled={busy} onClick={() => act(() => api('/account/sso', { method: 'DELETE', body: withCode({}) }), say('sso.service.removed'))}>{say('sso.service.remove')}</button></div>
        </details>
      )}
    </section>
    </Card>
  );
}
