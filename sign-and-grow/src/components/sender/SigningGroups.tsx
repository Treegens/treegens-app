'use client';
import { useEffect, useRef, useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { ConfirmDialog } from './dialogs';
import { explain, looksLikeEmail } from './lib';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS } from '@/lib/policy';
import { useST } from '@/components/senderLang';
import { senderT } from '@/lib/senderlang';

// Signing groups on the Contacts page: a named list of people, any one of whom can sign for the group ("HR team").
// Everyone on the team sees them and can put them on an envelope. Only admins can add, change or delete one, and
// the server enforces that (src/server/routes-groups.ts): a member is shown the list and no buttons.

export type Group = { id: string; name: string; members: { id?: string; name: string; email: string }[]; used_by: number };
type Draft = { id?: string; name: string; members: { name: string; email: string }[] };
const blank = (): Draft => ({ name: '', members: Array.from({ length: GROUP_MIN_MEMBERS }, () => ({ name: '', email: '' })) });

// What is wrong with a group before it goes to the server, in the server's own words where they overlap. The
// server checks all of it again.
function trouble(d: Draft, lang = 'en'): string {
  const T = (key: string, vars?: Record<string, string | number>) => senderT(lang, `contacts.groups.${key}`, vars);
  if (!d.name.trim()) return T('need_name');
  const filled = d.members.filter((m) => m.name.trim() || m.email.trim());
  for (const [i, m] of filled.entries()) {
    if (!m.name.trim()) return T('member_name', { n: String(i + 1) });
    if (!looksLikeEmail(m.email.trim())) return T('member_email', { name: m.name.trim() });
  }
  const seen = new Set<string>();
  for (const m of filled) {
    const k = m.email.trim().toLowerCase();
    if (seen.has(k)) return T('twice', { email: m.email.trim() });
    seen.add(k);
  }
  if (filled.length < GROUP_MIN_MEMBERS) return T('too_few', { min: GROUP_MIN_MEMBERS });
  return '';
}

export function SigningGroups() {
  const T = useST();
  const [data, reload, error] = useLoad<{ groups: Group[]; may_change: boolean }>(() => api('/groups'));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<Group | null>(null);
  const backTo = useRef('');
  const groups = data?.groups || [];
  const admin = !!data?.may_change;

  // When the form closes, the keyboard goes back to the button that opened it.
  useEffect(() => {
    if (draft || !backTo.current) return;
    document.getElementById(backTo.current)?.focus();
    backTo.current = '';
  }, [draft]);

  const open = (d: Draft, from: string) => (backTo.current = from, setProblem(''), setDraft(d));
  const close = () => (setDraft(null), setProblem(''));
  const patchMember = (i: number, p: Partial<{ name: string; email: string }>) => draft && setDraft({ ...draft, members: draft.members.map((m, j) => (j === i ? { ...m, ...p } : m)) });

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!draft) return;
    const no = trouble(draft, T.lang);
    if (no) return setProblem(T('contacts.groups.not_saved', { why: no }));
    setSaving(true);
    setProblem('');
    const body = { name: draft.name.trim(), members: draft.members.filter((m) => m.name.trim() || m.email.trim()).map((m) => ({ name: m.name.trim(), email: m.email.trim() })) };
    try {
      await api(draft.id ? `/groups/${draft.id}` : '/groups', { method: draft.id ? 'PUT' : 'POST', body });
      toast(draft.id ? T('contacts.groups.saved_change', { name: body.name }) : T('contacts.groups.saved_new', { name: body.name }));
      if (draft.id) backTo.current = `sn-group-edit-${draft.id}`;
      setDraft(null);
      reload();
    } catch (err) {
      setProblem(explain(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card pad0" aria-labelledby="sn-groups-h">
      <div className="sn-cardhead sn-contacts-head">
        <div>
          <h2 id="sn-groups-h">{T('contacts.groups.title')} <span className="muted sn-count">{data ? groups.length : ''}</span></h2>
          <p className="muted small sn-groups-intro">{T('contacts.groups.intro', { min: GROUP_MIN_MEMBERS, max: GROUP_MAX_MEMBERS })} {T('contacts.groups.rule')}</p>
          {data && !admin && <p className="muted small sn-groups-intro">{T('contacts.groups.admins_only')}</p>}
        </div>
        {admin && !draft && <button id="sn-group-new" type="button" className="btn sn-group-btn" onClick={() => open(blank(), 'sn-group-new')}>{T('contacts.groups.new')}</button>}
      </div>

      {draft && (
        <form className="sn-group-form" noValidate onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())} aria-label={draft.id ? T('contacts.groups.change_title', { name: draft.name || T('contacts.groups.the_group') }) : T('contacts.groups.new')}>
          <label className="f"><span>{T('contacts.groups.name')}</span><input value={draft.name} maxLength={80} autoFocus autoComplete="off" placeholder={T('contacts.groups.name_placeholder')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <fieldset className="sn-group-members">
            <legend>{T('contacts.groups.members')} <span className="hint">{T('contacts.groups.members_hint', { min: GROUP_MIN_MEMBERS, max: GROUP_MAX_MEMBERS })}</span></legend>
            <ol role="list">
              {draft.members.map((m, i) => (
                <li key={i}>
                  <label className="f"><span>{T('contacts.groups.member_n_name', { n: String(i + 1) })}</span><input value={m.name} maxLength={120} autoComplete="off" onChange={(e) => patchMember(i, { name: e.target.value })} /></label>
                  <label className="f"><span>{T('contacts.groups.member_n_email', { n: String(i + 1) })}</span><input type="email" value={m.email} autoComplete="off" onChange={(e) => patchMember(i, { email: e.target.value })} /></label>
                  <button type="button" className="btn ghost danger sn-group-btn" disabled={draft.members.length <= 1} onClick={() => setDraft({ ...draft, members: draft.members.filter((_, j) => j !== i) })} aria-label={T('contacts.groups.take_out_label', { name: m.name.trim() || T('contacts.groups.member_n', { n: String(i + 1) }) })}>{T('contacts.groups.take_out')}</button>
                </li>
              ))}
            </ol>
            {draft.members.length < GROUP_MAX_MEMBERS
              ? <button type="button" className="btn sn-group-btn" onClick={() => setDraft({ ...draft, members: [...draft.members, { name: '', email: '' }] })}>{T('contacts.groups.add_member')}</button>
              : <p className="muted small">{T('contacts.groups.at_max', { max: GROUP_MAX_MEMBERS })}</p>}
          </fieldset>
          {draft.id && <p className="muted small">{T('contacts.groups.change_note')}</p>}
          {problem && <div className="notice err" role="alert">{problem}</div>}
          <div className="sn-contact-actions">
            <button type="submit" className="btn primary sn-group-btn" disabled={saving}>{saving ? T('contacts.groups.saving') : T('contacts.groups.save')}</button>
            <button type="button" className="btn sn-group-btn" onClick={close}>{T('contacts.groups.cancel')}</button>
          </div>
        </form>
      )}

      {error ? (
        <div className="empty" role="alert"><h3>{T('contacts.groups.load_failed')}</h3>{T('contacts.groups.load_failed_body')}<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>{T('contacts.groups.try_again')}</button></div></div>
      ) : !data ? (
        <div className="empty" role="status">{T('contacts.groups.loading')}</div>
      ) : groups.length === 0 ? (
        <div className="empty"><h3>{T('contacts.groups.none')}</h3>{admin ? T('contacts.groups.none_admin') : T('contacts.groups.none_member')}</div>
      ) : (
        <ul className="sn-contacts" role="list">
          {groups.map((g) => (
            <li key={g.id}>
              <div className="sn-group-who">
                <b>{g.name}</b>
                <span className="muted small">{T('contacts.groups.member_list', { count: g.members.length, list: g.members.map((m) => `${m.name} (${m.email})`).join(', ') })}</span>
                {g.used_by > 0 && <span className="muted small">{T('contacts.groups.named_on', { count: g.used_by })}</span>}
              </div>
              {admin && (
                <div className="sn-contact-actions">
                  <button id={`sn-group-edit-${g.id}`} type="button" className="btn sm sn-group-btn" disabled={!!draft} onClick={() => open({ id: g.id, name: g.name, members: g.members.map((m) => ({ name: m.name, email: m.email })) }, `sn-group-edit-${g.id}`)} aria-label={T('contacts.groups.change_label', { name: g.name })}>{T('contacts.groups.change')}</button>
                  <button type="button" className="btn sm ghost danger sn-group-btn" disabled={!!draft} onClick={() => setRemoving(g)} aria-label={T('contacts.groups.delete_label', { name: g.name })}>{T('contacts.groups.delete')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <ConfirmDialog title={T('contacts.groups.delete_title', { name: removing.name })} confirmLabel={T('contacts.groups.delete_confirm')} keepLabel={T('contacts.groups.keep')} onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/groups/${removing.id}`, { method: 'DELETE' });
            toast(T('contacts.groups.deleted', { name: removing.name }));
            setRemoving(null);
            reload();
          }}>
          <p>{T('contacts.groups.delete_body', { name: removing.name })}</p>
          {removing.used_by > 0 && <p><b>{T('contacts.groups.used_by', { count: removing.used_by })}</b> {T('contacts.groups.used_by_rest')}</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}
