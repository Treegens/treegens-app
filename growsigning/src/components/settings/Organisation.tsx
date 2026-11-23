'use client';
// Settings, Organisation: only for an admin of an organisation above accounts (src/server/routes-orgs.ts). The
// designer's note gov-G13: the agencies first, then the rules passed down, then counts; admins, organisations below,
// emergency access (only where the operator allowed it) and the record behind More options. Words: Organisation,
// Agencies, Set by <name>; never tenant or org.
// What an admin here never sees: an agency's documents, their titles, comments or field values.
import { useEffect, useState, type FormEvent } from 'react';
import { api, useLoad, toast, Modal, fmtDate } from '@/components/ui';
import { Card, MoreOptions, useSaved } from './Frame';
import { ORG_POLICY_WORDS, orgEventWords, lowerFirst, type OrgPolicyKey } from '@/lib/orgs';
import { IDLE_CHOICES, PASSWORD_MIN, PASSWORD_RULE_MAX } from '@/lib/signinrules';
import { useST } from '@/components/senderLang';
import { senderT } from '@/lib/senderlang';

const T44 = { minHeight: 44 } as const;
const errText = (e: any, lang = 'en') => String(e?.message || senderT(lang, 'settings.org.did_not_work'));

// The organisation that is open is in the address (?tab=organisation&org=<id>), so the browser's Back button goes
// back to the one before, and a reload keeps it.
const orgInUrl = () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('org'));

export function Organisation() {
  const T = useST();
  const [list] = useLoad<any>(() => api('/orgs').catch(() => ({ orgs: [] })), []);
  const [picked, setPicked] = useState<string | null>(orgInUrl);
  useEffect(() => {
    const back = () => setPicked(orgInUrl());
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  const open = (id: string) => {
    const q = new URLSearchParams(window.location.search);
    q.set('tab', 'organisation');
    q.set('org', id);
    window.history.pushState(null, '', `${window.location.pathname}?${q}`);
    setPicked(id);
    window.scrollTo({ top: 0 });
  };
  const orgs: { id: string; name: string }[] = list?.orgs || [];
  const orgId = picked || orgs[0]?.id || null;
  if (!list) return null;
  if (!orgId) return <p className="muted">{T('settings.org.not_admin')}</p>;
  return <OrgView key={orgId} orgId={orgId} open={open} mine={orgs} />;
}

function OrgView({ orgId, open, mine }: { orgId: string; open: (id: string) => void; mine: { id: string; name: string }[] }) {
  const T = useST();
  const [o, reload, failed] = useLoad<any>(() => api(`/orgs/${orgId}`), [orgId]);
  if (failed) return <p className="notice err" role="alert">{errText(failed, T.lang)} {T('settings.org.open_again')}</p>;
  if (!o) return null;
  return (
    <div className="stack" data-feature="gov-G13">
      {(mine.length > 1 || o.path.length > 1) && (
        <nav aria-label={T('settings.org.where')} className="small" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {o.path.map((p: any, i: number) => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span aria-hidden="true">/</span>}
              {p.yours && p.id !== o.id ? <button type="button" className="btn ghost sm" style={T44} onClick={() => open(p.id)}>{p.name}</button> : <b aria-current={p.id === o.id ? 'page' : undefined}>{p.name}</b>}
            </span>
          ))}
          {mine.filter((m) => !o.path.some((p: any) => p.id === m.id)).map((m) => <button key={m.id} type="button" className="btn ghost sm" style={T44} onClick={() => open(m.id)}>{m.name}</button>)}
        </nav>
      )}
      <Card><Agencies o={o} reload={reload} open={open} /></Card>
      <Card><Rules o={o} reload={reload} /></Card>
      {(o.agencies.length > 0 || o.orgs.length > 0) && <Counts orgId={o.id} />}
      <MoreOptions>
        <Admins o={o} reload={reload} />
        <Below o={o} reload={reload} />
        {o.break_glass && <BreakGlass o={o} />}
        <Record orgId={o.id} />
      </MoreOptions>
    </div>
  );
}

// ---- Agencies ------------------------------------------------------------------------------------------------------

function Agencies({ o, reload, open }: { o: any; reload: () => void; open: (id: string) => void }) {
  const T = useST();
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<any>(null);
  const [said, saved] = useSaved(T('settings.org.added'));
  // Switching sending off stops a whole agency and emails its owners, so it is asked once, in place.
  const [stopping, setStopping] = useState<string | null>(null);
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api(`/orgs/${o.id}/agencies`, { body: { name: f.get('name'), owner_email: f.get('email') } });
      toast(T('settings.org.agency_made', { name: r.agency.name }));
      setAdding(false);
      saved();
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  const sending = async (a: any, on: boolean) => {
    try {
      setStopping(null);
      await api(`/orgs/${o.id}/agencies/${a.id}/sending`, { method: 'PUT', body: { on } });
      toast(on ? T('settings.org.sending_on', { name: a.name }) : T('settings.org.sending_off', { name: a.name }));
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  return (
    <section className="card" aria-labelledby="org-agencies-h">
      <h2 id="org-agencies-h" style={{ marginBottom: 4 }}>{T('settings.org.agencies')}</h2>
      <p className="muted small">{T('settings.org.agencies_note')}</p>
      {!o.agencies.length && !o.orgs.length && <p className="small">{T('settings.org.no_agencies')}</p>}
      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
        {o.agencies.map((a: any) => (
          <li key={a.id} data-item="agency" style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <span>
              <b>{a.name}</b>
              <span className="muted small" style={{ display: 'block' }}>
                {a.waiting_owner ? T(a.sending ? 'settings.org.waiting_owner' : 'settings.org.waiting_owner_off') : T(a.sending ? 'settings.org.people_count' : 'settings.org.people_count_off', { count: Number(a.people) })}
              </span>
            </span>
            <details data-more="item" style={{ position: 'relative' }}>
              <summary className="btn sm" style={T44} aria-label={T('settings.org.more_for', { name: a.name })}>{T('settings.org.more')}</summary>
              <div className="stack" style={{ padding: '8px 0', gap: 6 }}>
                <button type="button" className="btn sm" style={T44} onClick={() => setPeople(a)}>{T('settings.org.people_of', { name: a.name })}</button>
                {a.sending && stopping === a.id ? (
                  <span role="group" aria-label={T('settings.org.switch_off_ask', { name: a.name })} className="stack" style={{ gap: 6 }}>
                    <span className="small">{T('settings.org.switch_off_note', { name: a.name })}</span>
                    <span className="row wrap" style={{ gap: 8 }}>
                      <button type="button" className="btn danger sm" style={T44} onClick={() => sending(a, false)}>{T('settings.org.switch_off')}</button>
                      <button type="button" className="btn ghost sm" style={T44} onClick={() => setStopping(null)}>{T('settings.cancel')}</button>
                    </span>
                  </span>
                ) : (
                  <button type="button" className="btn sm" style={T44} onClick={() => (a.sending ? setStopping(a.id) : sending(a, true))}>{a.sending ? T('settings.org.switch_off_for', { name: a.name }) : T('settings.org.switch_on_for', { name: a.name })}</button>
                )}
              </div>
            </details>
          </li>
        ))}
        {o.orgs.map((k: any) => (
          <li key={k.id} data-item="org" style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <span><b>{k.name}</b><span className="muted small" style={{ display: 'block' }}>{T('settings.org.below_of', { name: o.name })}</span></span>
            <button type="button" className="btn sm" style={T44} onClick={() => open(k.id)}>{T('settings.org.open_it', { name: k.name })}</button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={add} className="stack" style={{ marginTop: 12 }} aria-label={T('settings.org.add_agency')}>
          <label className="f"><span>{T('settings.org.agency_name')}</span><input name="name" required maxLength={120} autoComplete="organization" style={T44} /></label>
          <label className="f"><span>{T('settings.org.owner_email')}</span><input name="email" type="email" required autoComplete="off" style={T44} /></label>
          <p className="muted small">{T('settings.org.invite_note')}</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" style={T44}>{T('settings.org.add_the_agency')}</button>
            <button type="button" className="btn ghost" style={T44} onClick={() => setAdding(false)}>{T('settings.cancel')}</button>
          </div>
        </form>
      ) : (
        <p style={{ marginTop: 12 }}><button type="button" className="btn" style={T44} onClick={() => setAdding(true)}>{T('settings.org.add_agency')}</button> {said}</p>
      )}
      {people && <People org={o} agency={people} onClose={() => { setPeople(null); reload(); }} />}
    </section>
  );
}

function People({ org, agency, onClose }: { org: any; agency: any; onClose: () => void }) {
  const T = useST();
  const [d, reload] = useLoad<any>(() => api(`/orgs/${org.id}/agencies/${agency.id}/members`), [agency.id]);
  const [code, setCode] = useState<{ uid: string; value: string } | null>(null);
  const role = async (uid: string, to: string) => {
    try {
      await api(`/orgs/${org.id}/agencies/${agency.id}/members/${uid}`, { method: 'PATCH', body: { role: to } });
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  const reset = async (m: any, typed?: string) => {
    try {
      await api(`/orgs/${org.id}/agencies/${agency.id}/members/${m.id}/two-step/reset`, { body: typed ? { code: typed } : {} });
      toast(T('settings.org.reset_done', { name: m.name }));
      setCode(null);
      reload();
    } catch (err: any) {
      if (err?.code === 'code_needed') setCode({ uid: m.id, value: '' });
      else toast(errText(err, T.lang), true);
    }
  };
  const name = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      const r = await api(`/orgs/${org.id}/agencies/${agency.id}/people`, { body: { email: f.get('email'), role: f.get('role') } });
      toast(r.joined ? T('settings.org.joined') : T('settings.org.invited'));
      form.reset();
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  return (
    <Modal title={T('settings.org.people_of', { name: agency.name })} onClose={onClose} wide>
      {!d ? <p className="muted">{T('settings.org.loading')}</p> : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {d.members.map((m: any) => (
              <li key={m.id} data-item="person" style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <span><b>{m.name}</b><span className="muted small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{T(m.two_step ? 'settings.org.two_step_on' : 'settings.org.two_step_off', { email: m.email })}</span></span>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {m.role === 'owner' ? <span className="small">{T('settings.role.owner')}</span> : (
                    <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span>{T('settings.org.role_of', { name: m.name })}</span>
                      <select value={m.role} style={T44} onChange={(e) => role(m.id, e.target.value)}>
                        <option value="admin">{T('settings.role.admin')}</option>
                        <option value="member">{T('settings.role.member')}</option>
                      </select>
                    </label>
                  )}
                  {m.can_reset && <button type="button" className="btn sm" style={T44} onClick={() => reset(m)}>{T('settings.org.reset_for', { name: m.name })}</button>}
                </span>
                {code?.uid === m.id && (
                  <form className="row" style={{ gap: 8, flexBasis: '100%' }} onSubmit={(e) => { e.preventDefault(); reset(m, code?.value); }}>
                    <label className="f" style={{ flex: 1 }}><span>{T('settings.org.own_code')}</span><input inputMode="numeric" autoComplete="one-time-code" value={code?.value || ''} onChange={(e) => setCode({ uid: m.id, value: e.target.value })} style={T44} /></label>
                    <button className="btn" style={{ ...T44, alignSelf: 'flex-end' }}>{T('settings.org.reset')}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {d.invites.length > 0 && <p className="small" style={{ marginTop: 8 }}>{T('settings.org.invites', { list: d.invites.map((i: any) => `${i.email} (${i.role === 'owner' ? T('settings.role.owner') : i.role === 'admin' ? T('settings.role.admin') : T('settings.role.member')})`).join(', ') })}</p>}
          <form onSubmit={name} className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'flex-end' }} aria-label={T('settings.org.name_someone')}>
            <label className="f" style={{ flex: '1 1 220px' }}><span>{T('settings.org.name_by_email')}</span><input name="email" type="email" required style={T44} /></label>
            <label className="f"><span>{T('settings.org.as')}</span><select name="role" defaultValue="admin" style={T44}><option value="admin">{T('settings.role.admin')}</option><option value="owner">{T('settings.role.owner')}</option></select></label>
            <button className="btn" style={T44}>{T('settings.org.name_them')}</button>
          </form>
          <p className="muted small" style={{ marginTop: 8 }}>{T('settings.org.members_note')}</p>
          <p style={{ marginTop: 12 }}><button type="button" className="btn" style={T44} onClick={onClose}>{T('settings.org.close')}</button></p>
        </>
      )}
    </Modal>
  );
}

// ---- Rules passed down --------------------------------------------------------------------------------------------

const SWITCHES: [OrgPolicyKey, any][] = [['two_step_required', true], ['one_session', true], ['impact_display', 'off'], ['ai_helper', 'off']];

function Rules({ o, reload }: { o: any; reload: () => void }) {
  const T = useST();
  const [said, saved] = useSaved();
  // A rule that can keep people out (two-step login, one browser) is asked once, in place, with how many it reaches.
  const [asking, setAsking] = useState<OrgPolicyKey | null>(null);
  const put = async (body: Record<string, unknown>) => {
    setAsking(null);
    try {
      await api(`/orgs/${o.id}/policy`, { method: 'PUT', body });
      saved();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
    reload();
  };
  const above = (k: OrgPolicyKey) => o.above?.[k];
  const hint = (k: OrgPolicyKey) => (above(k) ? `${above(k).set_by}: ${lowerFirst(ORG_POLICY_WORDS[k].on(above(k).value))}.` : '');
  const reach = o.reach ? T('settings.org.reach', { agencies: Number(o.reach.agencies), people: Number(o.reach.people) }) : T('settings.org.reach_all');
  const lockWords: Partial<Record<OrgPolicyKey, string>> = {
    two_step_required: T('settings.org.two_step_ask', { reach }),
    one_session: T('settings.org.one_session_ask', { reach }),
  };
  const num = (k: 'min_password_length' | 'idle_minutes', label: string, choices: number[], none: string) => {
    const a = above(k)?.value as number | undefined;
    // Only choices at least as strict as what is asked above.
    const allowed = choices.filter((n) => a === undefined || (k === 'min_password_length' ? n >= a : n <= a));
    return (
      <div className="setting-row" style={{ cursor: 'auto', ...T44 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
          <b>{label}</b>
          <select value={o.policy[k] ?? ''} style={{ ...T44, maxWidth: 320 }} aria-describedby={`org-${k}-hint`} onChange={(e) => put({ [k]: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{a === undefined ? none : T('settings.org.as_above')}</option>
            {allowed.map((n) => <option key={n} value={n}>{k === 'min_password_length' ? T('settings.org.at_least', { count: n }) : T('settings.org.after_minutes', { count: n })}</option>)}
          </select>
          <span id={`org-${k}-hint`} className="muted small">{hint(k)}</span>
        </label>
      </div>
    );
  };
  return (
    <section className="card" aria-labelledby="org-rules-h">
      <h2 id="org-rules-h" style={{ marginBottom: 4 }}>{T('settings.org.rules')} {said}</h2>
      <p className="muted small">{T('settings.org.rules_note', { name: o.name })}</p>
      {SWITCHES.filter(([k]) => k !== 'ai_helper' || o.ai_available).map(([k, v]) => {
        const fixed = !!above(k);
        return (
          <div key={k}>
            <label className="setting-row" style={T44}>
              <input type="checkbox" role="switch" checked={fixed || o.policy[k] !== undefined || asking === k} disabled={fixed} aria-describedby={`org-${k}-hint`} onChange={(e) => (e.target.checked && lockWords[k] ? setAsking(k) : put({ [k]: e.target.checked ? v : null }))} />
              <span><b>{ORG_POLICY_WORDS[k].on(v)}</b><span id={`org-${k}-hint`} className="muted small" style={{ display: 'block' }}>{fixed ? hint(k) : T('settings.org.for_every', { name: o.name })}</span></span>
            </label>
            {asking === k && (
              <div role="group" aria-label={ORG_POLICY_WORDS[k].on(v)} className="stack" style={{ gap: 6, margin: '4px 0 10px' }}>
                <span className="small">{lockWords[k]}</span>
                <span className="row wrap" style={{ gap: 8 }}>
                  <button type="button" className="btn sm" style={T44} onClick={() => put({ [k]: v })}>{T('settings.org.switch_on')}</button>
                  <button type="button" className="btn ghost sm" style={T44} onClick={() => setAsking(null)}>{T('settings.cancel')}</button>
                </span>
              </div>
            )}
          </div>
        );
      })}
      {num('min_password_length', ORG_POLICY_WORDS.min_password_length.name, [10, 12, 14, 16, 20, 24].filter((n) => n > PASSWORD_MIN && n <= PASSWORD_RULE_MAX), T('settings.org.left_to_each'))}
      {num('idle_minutes', ORG_POLICY_WORDS.idle_minutes.name, IDLE_CHOICES, T('settings.org.left_to_each'))}
    </section>
  );
}

// ---- Counts ---------------------------------------------------------------------------------------------------------

function Counts({ orgId }: { orgId: string }) {
  const T = useST();
  const [r] = useLoad<any>(() => api(`/orgs/${orgId}/report`).catch(() => null), [orgId]);
  // Nothing to count until there is an agency somewhere below.
  if (!r || !r.agencies.length) return null;
  return (
    <Card><section className="card" aria-labelledby="org-counts-h">
      <h2 id="org-counts-h" style={{ marginBottom: 4 }}>{T('settings.org.counts')}</h2>
      <p className="muted small">{T('settings.org.counts_note', { from: fmtDate(r.from), to: fmtDate(r.to) })}</p>
      {(
        <div style={{ overflowX: 'auto' }}>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead><tr><th scope="col" style={{ textAlign: 'left', padding: '4px' }}>{T('settings.org.col_agency')}</th><th scope="col" style={{ padding: '4px 8px' }}>{T('settings.org.col_sent')}</th><th scope="col" style={{ padding: '4px 8px' }}>{T('settings.org.col_completed')}</th><th scope="col" style={{ padding: '4px 8px' }}>{T('settings.org.col_days')}</th></tr></thead>
            <tbody>
              {r.agencies.map((a: any) => (
                <tr key={a.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 600, padding: '8px 4px' }}>{a.name}</th>
                  <td style={{ textAlign: 'center' }}>{a.sent}</td><td style={{ textAlign: 'center' }}>{a.completed}</td><td style={{ textAlign: 'center' }}>{a.average_days ?? T('settings.org.none_yet')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section></Card>
  );
}

// ---- More options -----------------------------------------------------------------------------------------------------

function Admins({ o, reload }: { o: any; reload: () => void }) {
  const T = useST();
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api(`/orgs/${o.id}/admins`, { body: { email: new FormData(form).get('email') } });
      toast(T('settings.org.admin_added'));
      form.reset();
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  const remove = async (a: any) => {
    try {
      await api(`/orgs/${o.id}/admins/${a.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  return (
    <section aria-labelledby="org-admins-h">
      <h3 id="org-admins-h">{T('settings.org.admins_of', { name: o.name })}</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0' }}>
        {o.admins.map((a: any) => (
          <li key={a.id} data-item="admin" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--line)', padding: '6px 0' }}>
            <span style={{ overflowWrap: 'anywhere' }}>{a.name} <span className="muted small">{a.email}</span></span>
            <button type="button" className="btn ghost sm" style={T44} onClick={() => remove(a)}>{T('settings.org.remove', { name: a.name })}</button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="f" style={{ flex: '1 1 220px' }}><span>{T('settings.org.add_admin_email')}</span><input name="email" type="email" required style={T44} /></label>
        <button className="btn" style={T44}>{T('settings.org.add_admin')}</button>
      </form>
      <p className="muted small">{T('settings.org.needs_login')}</p>
    </section>
  );
}

function Below({ o, reload }: { o: any; reload: () => void }) {
  const T = useST();
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api(`/orgs/${o.id}/orgs`, { body: { name: new FormData(form).get('name') } });
      toast(T('settings.org.org_added'));
      form.reset();
      reload();
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  return (
    <section aria-labelledby="org-below-h">
      <h3 id="org-below-h">{T('settings.org.below_of', { name: o.name })}</h3>
      <p className="muted small">{T('settings.org.below_note', { name: o.name })}</p>
      <form onSubmit={add} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="f" style={{ flex: '1 1 220px' }}><span>{T('settings.org.its_name')}</span><input name="name" required maxLength={120} style={T44} /></label>
        <button className="btn" style={T44}>{T('settings.org.add_org')}</button>
      </form>
    </section>
  );
}

function BreakGlass({ o }: { o: any }) {
  const T = useST();
  const go = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch(`/api/orgs/${o.id}/agencies/${f.get('agency')}/break-glass`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ envelope_id: f.get('envelope'), reason: f.get('reason') }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || T('settings.org.did_not_work'));
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      toast(T('settings.org.glass_opened'));
    } catch (err) {
      toast(errText(err, T.lang), true);
    }
  };
  return (
    <section aria-labelledby="org-glass-h">
      <h3 id="org-glass-h">{T('settings.org.glass')}</h3>
      <p className="muted small">{T('settings.org.glass_note')}</p>
      <form onSubmit={go} className="stack">
        <label className="f"><span>{T('settings.org.agency')}</span><select name="agency" required style={T44}>{o.agencies.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="f"><span>{T('settings.org.doc_id')}</span><input name="envelope" required style={T44} /></label>
        <label className="f"><span>{T('settings.org.why')}</span><textarea name="reason" required minLength={15} maxLength={500} rows={3} /></label>
        <p><button className="btn danger" style={T44}>{T('settings.org.open_doc')}</button></p>
      </form>
    </section>
  );
}

function Record({ orgId }: { orgId: string }) {
  const T = useST();
  const [r] = useLoad<any>(() => api(`/orgs/${orgId}/events`).catch(() => null), [orgId]);
  if (!r) return null;
  return (
    <section aria-labelledby="org-record-h">
      <h3 id="org-record-h">{T('settings.org.record')}</h3>
      {!r.events.length ? <p className="small">{T('settings.org.nothing_yet')}</p> : (
        <ul className="small" style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 320, overflowY: 'auto' }}>
          {r.events.slice(0, 50).map((ev: any) => <li key={ev.seq} style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}><span className="muted">{fmtDate(ev.at)}</span> {orgEventWords(ev.kind, ev.details)}</li>)}
        </ul>
      )}
    </section>
  );
}
