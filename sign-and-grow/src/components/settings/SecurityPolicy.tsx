'use client';
// Settings, Security, for the owner and admins: the card "Sign-in rules" (GET and PATCH /api/account/rules,
// src/server/routes-secpolicy.ts; the rules themselves are in src/server/secpolicy.ts). Three rules, all off until
// someone sets them, then one line about two-step login for everyone (changed under Team, its one place) and one
// about the leaked-password check when this server has it on. Why there is no forced password change and no rule
// about capitals or digits is folded under the last line.
//
// A card of boxes, so it has one secondary Save (research/ux-charter.md P5). When the person saving has two-step
// login, the box for their code appears above Save once something changed: the rules decide who gets in.
import { setByLine } from '@/lib/orgs';
import { useEffect, useState } from 'react';
import { api, useLoad } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { CodeField } from '@/components/TwoStep';
import { wholeIn, IDLE_CHOICES, TEAM_TWO_STEP_HREF } from '@/lib/signinrules';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;
const say = (key: string, vars: Record<string, string | number> = {}) => t(ui, key, vars);

type Rules = {
  min_password_length: number; idle_minutes: number | null; one_session: boolean;
  set_by?: Record<string, string>;
  limits: { password: [number, number]; idle_minutes: [number, number]; warn_seconds: number };
  leak_check: boolean; two_step_required: boolean; code_needed: boolean;
};
/** idle: the minutes of "Sign out after", or '' for Never (the rule is off). */
type Form = { min: string; idle: string; one: boolean };
const formOf = (r: Rules): Form => ({ min: String(r.min_password_length), idle: r.idle_minutes ? String(r.idle_minutes) : '', one: r.one_session });
/** "15 minutes of no use", "1 hour of no use": one choice of "Sign out after". */
const idleWords = (m: number) => (m % 60 === 0 ? say('rules.idle.hours', { count: m / 60 }) : say('rules.idle.minutes', { count: m }));

export function SecurityPolicy() {
  const me: any = useMe();
  const admin = me.role === 'owner' || me.role === 'admin';
  const [r, reload, failed] = useLoad<Rules | null>(() => (admin ? api('/account/rules') : Promise.resolve(null)), [admin]);
  const [f, setF] = useState<Form | null>(null);
  const [code, setCode] = useState('');
  const [said, setSaid] = useState<{ text: string; err?: boolean; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (r) setF(formOf(r));
  }, [r]);
  if (!admin) return null;
  if (failed) return <section className="card" data-feature="ds-sec-policy"><h2>{say('rules.title')}</h2><p className="notice err" role="alert">{failed.message || say('rules.load_failed')}</p></section>;
  if (!r || !f) return null;
  const account = me.account.name;
  const [pLo, pHi] = r.limits.password;
  const [iLo, iHi] = r.limits.idle_minutes;
  const was = formOf(r);
  const changed = f.min !== was.min || f.idle !== was.idle || f.one !== was.one;
  // The usual choices, and the minutes this account has now when they were set to another number through the API.
  const choices = [...new Set([...IDLE_CHOICES, ...(r.idle_minutes ? [r.idle_minutes] : [])])].sort((x, y) => x - y);
  const set = (x: Partial<Form>) => (setF({ ...f, ...x }), setSaid(null));
  // The owner's own password, when it is shorter than the rule: they are never held by it, so they are told here.
  const ownerShort = me.role === 'owner' && me.rules?.password_short ? me.rules.password_short : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f || !r) return;
    // The same limits as the server, said under the box before anything is sent.
    if (wholeIn(f.min, pLo, pHi) === null) return setSaid({ text: say('rules.refused.password', { lo: pLo, hi: pHi, kept: r.min_password_length }), err: true, field: 'min_password_length' });
    if (f.idle && wholeIn(f.idle, iLo, iHi) === null) return setSaid({ text: say('rules.refused.idle', { lo: iLo, hi: iHi, kept: r.idle_minutes ? say('rules.kept.minutes', { count: r.idle_minutes }) : say('rules.kept.off') }), err: true, field: 'idle_minutes' });
    setBusy(true);
    setSaid(null);
    try {
      const out = await api('/account/rules', { method: 'PATCH', body: { min_password_length: Number(f.min), idle_minutes: f.idle ? Number(f.idle) : null, one_session: f.one, ...(r.code_needed ? { code } : {}) } });
      setCode('');
      setSaid({ text: out.signed_out ? say('rules.saved_out', { count: out.signed_out }) : say('rules.saved') });
      reload();
      me.reload();
    } catch (err: any) {
      setSaid({ text: err?.message || say('rules.short.failed'), err: true, field: err?.data?.field });
    } finally {
      setBusy(false);
    }
  }

  const bad = (field: string) => (said?.err && said.field === field ? said.text : '');
  return (
    <section className="card sp-card" data-feature="ds-sec-policy" aria-labelledby="sp-h">
      <h2 id="sp-h" style={{ marginBottom: 4 }}>{say('rules.title')}</h2>
      <p className="muted small">{say('rules.intro', { account })}</p>
      {setByLine(r.set_by, ['min_password_length', 'idle_minutes', 'one_session']) && <p className="small" data-feature="gov-G13">{setByLine(r.set_by, ['min_password_length', 'idle_minutes', 'one_session'])}</p>}
      {ownerShort && <p className="notice warn small" role="status">{say('rules.owner_short', { min: ownerShort })}</p>}
      <form onSubmit={save} noValidate>
        {/* Each hint sits under its control, outside the label: a screen reader hears the name, then the hint once. */}
        <div className="sp-field">
          <label className="f sp-num" htmlFor="sp-min"><span>{say('rules.password.label')}</span></label>
          <div className="sp-num">
            <span className="sp-box">
              <input id="sp-min" type="number" inputMode="numeric" min={pLo} max={pHi} value={f.min} aria-describedby={`sp-min-unit sp-min-hint${bad('min_password_length') ? ' sp-min-bad' : ''}`} aria-invalid={!!bad('min_password_length')} onChange={(e) => set({ min: e.target.value })} />
              <span id="sp-min-unit" className="sp-unit">{say('rules.password.unit')}</span>
            </span>
          </div>
          <p id="sp-min-hint" className="hint sp-hint">{say('rules.password.hint', { lo: pLo, hi: pHi })}</p>
          {bad('min_password_length') && <p id="sp-min-bad" className="set-bad sp-hint" role="alert">{bad('min_password_length')}</p>}
        </div>

        <div className="sp-field">
          <label className="f sp-num" htmlFor="sp-idle"><span>{say('rules.idle.label')}</span></label>
          <div className="sp-num">
            <select id="sp-idle" value={f.idle} aria-describedby={`sp-idle-hint${bad('idle_minutes') ? ' sp-idle-bad' : ''}`} aria-invalid={!!bad('idle_minutes')} onChange={(e) => set({ idle: e.target.value })}>
              <option value="">{say('rules.idle.never')}</option>
              {choices.map((m) => <option key={m} value={String(m)}>{idleWords(m)}</option>)}
            </select>
          </div>
          <p id="sp-idle-hint" className="hint sp-hint">{say('rules.idle.hint')}</p>
          {bad('idle_minutes') && <p id="sp-idle-bad" className="set-bad sp-hint" role="alert">{bad('idle_minutes')}</p>}
        </div>

        <div className="sp-field">
          <label className="setting-row sp-row">
            <input type="checkbox" checked={f.one} aria-describedby={`sp-one-hint${f.one && !r.one_session ? ' sp-one-confirm' : ''}`} onChange={(e) => set({ one: e.target.checked })} />
            <b>{say('rules.one.label')}</b>
          </label>
          <p id="sp-one-hint" className="muted small sp-sub">{say('rules.one.hint', { account })}</p>
          {/* Said before it happens, in place: switching it on signs extra browsers out at once. */}
          {f.one && !r.one_session && <p id="sp-one-confirm" className="small sp-warn sp-sub">{say('rules.one.confirm', { account })}</p>}
        </div>

        <p className="small sp-line">{say(r.two_step_required ? 'rules.two_step.on' : 'rules.two_step.off')} <a href={TEAM_TWO_STEP_HREF} className="sp-link">{say('rules.two_step.link')}</a></p>
        {r.leak_check && <p className="muted small sp-line">{say('rules.leak.on')}</p>}
        <details data-fold="">
          <summary className="set-fold">{say('rules.why.summary')}</summary>
          <p className="muted small" style={{ marginBottom: 0 }}>{say('rules.why.body')}</p>
        </details>

        {r.code_needed && changed && <CodeField id="sp-code" value={code} onChange={setCode} label={say('rules.code.label')} either />}
        <div className="row wrap sp-actions">
          <button className="btn" disabled={busy || !changed || (r.code_needed && !code.trim())}>{say('rules.save')}</button>
          {said && !said.field && <span className={said.err ? 'set-bad' : 'set-saved'} role={said.err ? 'alert' : 'status'}>{said.text}</span>}
        </div>
      </form>
    </section>
  );
}
