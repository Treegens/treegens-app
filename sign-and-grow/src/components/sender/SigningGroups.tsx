'use client';
import { useEffect, useRef, useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { ConfirmDialog } from './dialogs';
import { explain, looksLikeEmail } from './lib';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS, GROUP_RULE } from '@/lib/policy';

// Signing groups on the Contacts page: a named list of people, any one of whom can sign for the group ("HR team").
// Everyone on the team sees them and can put them on an envelope. Only admins can add, change or delete one, and
// the server enforces that (src/server/routes-groups.ts): a member is shown the list and no buttons.

export type Group = { id: string; name: string; members: { id?: string; name: string; email: string }[]; used_by: number };
type Draft = { id?: string; name: string; members: { name: string; email: string }[] };
const blank = (): Draft => ({ name: '', members: Array.from({ length: GROUP_MIN_MEMBERS }, () => ({ name: '', email: '' })) });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What is wrong with a group before it goes to the server, in the server's own words where they overlap. The
// server checks all of it again.
function trouble(d: Draft): string {
  if (!d.name.trim()) return 'Give the group a name, such as "HR team".';
  const filled = d.members.filter((m) => m.name.trim() || m.email.trim());
  for (const [i, m] of filled.entries()) {
    if (!m.name.trim()) return `Member ${i + 1} needs a name.`;
    if (!looksLikeEmail(m.email.trim())) return `${m.name.trim()} needs a complete email address, such as name@example.org.`;
  }
  const seen = new Set<string>();
  for (const m of filled) {
    const k = m.email.trim().toLowerCase();
    if (seen.has(k)) return `${m.email.trim()} is in the group twice. Every member gets a link of their own, so each needs an address of their own.`;
    seen.add(k);
  }
  if (filled.length < GROUP_MIN_MEMBERS) return `A group needs at least ${GROUP_MIN_MEMBERS} members. To send to one person, name that person as the recipient instead.`;
  return '';
}

export function SigningGroups() {
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
    const no = trouble(draft);
    if (no) return setProblem(`${no} Nothing was saved.`);
    setSaving(true);
    setProblem('');
    const body = { name: draft.name.trim(), members: draft.members.filter((m) => m.name.trim() || m.email.trim()).map((m) => ({ name: m.name.trim(), email: m.email.trim() })) };
    try {
      await api(draft.id ? `/groups/${draft.id}` : '/groups', { method: draft.id ? 'PUT' : 'POST', body });
      toast(draft.id ? `${body.name} saved. Envelopes already sent keep the members they went out with.` : `${body.name} saved. You can now choose it as a recipient.`);
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
          <h2 id="sn-groups-h">Signing groups <span className="muted sn-count">{data ? groups.length : ''}</span></h2>
          <p className="muted small sn-groups-intro">A group is one recipient made of {GROUP_MIN_MEMBERS} to {GROUP_MAX_MEMBERS} people, any one of whom can act for it, such as &ldquo;HR team&rdquo;. {GROUP_RULE}</p>
          {data && !admin && <p className="muted small sn-groups-intro">Only an admin of your team can add or change groups. You can choose them as a recipient on your own envelopes and templates.</p>}
        </div>
        {admin && !draft && <button id="sn-group-new" type="button" className="btn sn-group-btn" onClick={() => open(blank(), 'sn-group-new')}>New group</button>}
      </div>

      {draft && (
        <form className="sn-group-form" noValidate onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())} aria-label={draft.id ? `Change ${draft.name || 'the group'}` : 'New group'}>
          <label className="f"><span>Group name</span><input value={draft.name} maxLength={80} autoFocus autoComplete="off" placeholder="HR team" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <fieldset className="sn-group-members">
            <legend>Members <span className="hint">({GROUP_MIN_MEMBERS} to {GROUP_MAX_MEMBERS} people, each with their own email address)</span></legend>
            <ol role="list">
              {draft.members.map((m, i) => (
                <li key={i}>
                  <label className="f"><span>Name of member {i + 1}</span><input value={m.name} maxLength={120} autoComplete="off" onChange={(e) => patchMember(i, { name: e.target.value })} /></label>
                  <label className="f"><span>Email of member {i + 1}</span><input type="email" value={m.email} autoComplete="off" onChange={(e) => patchMember(i, { email: e.target.value })} /></label>
                  <button type="button" className="btn ghost danger sn-group-btn" disabled={draft.members.length <= 1} onClick={() => setDraft({ ...draft, members: draft.members.filter((_, j) => j !== i) })} aria-label={`Take ${m.name.trim() || `member ${i + 1}`} out of the group`}>Take out</button>
                </li>
              ))}
            </ol>
            {draft.members.length < GROUP_MAX_MEMBERS
              ? <button type="button" className="btn sn-group-btn" onClick={() => setDraft({ ...draft, members: [...draft.members, { name: '', email: '' }] })}>Add a member</button>
              : <p className="muted small">A group can have up to {GROUP_MAX_MEMBERS} members. For more, make a second group.</p>}
          </fieldset>
          {draft.id && <p className="muted small">Envelopes already sent to this group keep the members they went out with. To change who can act on one of those, open that document and choose More, then Edit. Drafts and templates that name the group use it as you save it here.</p>}
          {problem && <div className="notice err" role="alert">{problem}</div>}
          <div className="sn-contact-actions">
            <button type="submit" className="btn primary sn-group-btn" disabled={saving}>{saving ? 'Saving…' : 'Save group'}</button>
            <button type="button" className="btn sn-group-btn" onClick={close}>Cancel</button>
          </div>
        </form>
      )}

      {error ? (
        <div className="empty" role="alert"><h3>We could not load your groups</h3>Check your connection, then try again.<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>Try again</button></div></div>
      ) : !data ? (
        <div className="empty" role="status">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="empty"><h3>No groups yet</h3>{admin ? 'Choose New group to make one.' : 'When an admin makes one, it appears here.'}</div>
      ) : (
        <ul className="sn-contacts" role="list">
          {groups.map((g) => (
            <li key={g.id}>
              <div className="sn-group-who">
                <b>{g.name}</b>
                <span className="muted small">{plural(g.members.length, 'member')}: {g.members.map((m) => `${m.name} (${m.email})`).join(', ')}</span>
                {g.used_by > 0 && <span className="muted small">Named on {plural(g.used_by, 'draft or template', 'drafts and templates')}.</span>}
              </div>
              {admin && (
                <div className="sn-contact-actions">
                  <button id={`sn-group-edit-${g.id}`} type="button" className="btn sm sn-group-btn" disabled={!!draft} onClick={() => open({ id: g.id, name: g.name, members: g.members.map((m) => ({ name: m.name, email: m.email })) }, `sn-group-edit-${g.id}`)} aria-label={`Change ${g.name}`}>Change</button>
                  <button type="button" className="btn sm ghost danger sn-group-btn" disabled={!!draft} onClick={() => setRemoving(g)} aria-label={`Delete ${g.name}`}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <ConfirmDialog title={`Delete ${removing.name}`} confirmLabel="Delete group" keepLabel="Keep" onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/groups/${removing.id}`, { method: 'DELETE' });
            toast(`${removing.name} deleted.`);
            setRemoving(null);
            reload();
          }}>
          <p>Envelopes already sent to {removing.name} are not affected: they keep the members they went out with, and those people can still sign.</p>
          {removing.used_by > 0 && <p><b>{plural(removing.used_by, 'draft or template names', 'drafts and templates name')} this group.</b> They cannot be sent until you choose another group or a person for that recipient.</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}
