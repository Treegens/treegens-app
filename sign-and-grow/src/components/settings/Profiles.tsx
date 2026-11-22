'use client';
// Settings, Team, More options: "What each role can do" and "Groups of members" (src/server/routes-perm.ts).
// Also the one role select of the Team list and the invitation (RoleSelect): Member and Admin as always, and the
// roles the team made after them. With no role made, it is the same two choices as before.
// The list of things a role can do, and their words, are in src/lib/perm.ts, which the server checks too.
import { useState } from 'react';
import { api, useLoad, toast, oops } from '@/components/ui';
import { Dialog } from '@/components/sender/Dialog';
import { THINGS, THING_WORDS, MEMBER_THINGS, baseThings, ROLE_NAME_MAX, type Base, type Thing } from '@/lib/perm';

const TALL = { minHeight: 44 };
const STICKY = { position: 'sticky', bottom: 0, background: 'var(--surface)', paddingBottom: 4, zIndex: 1 } as const;
type Made = { id: string; name: string; base: Base; left_out: Thing[]; can: Thing[]; sentence: string; people: number; names: string[]; invites: number; groups: string[] };
type Group = { id: string; name: string; role: { id: string; name: string } | null; people: { id: string; name: string; email: string }[] };

/** The roles the team made, for the selects. Loaded once per Team section. */
export function useRoles(): [Made[], () => void] {
  const [d, reload] = useLoad<any>(() => api('/account/roles'), []);
  return [d?.roles || [], reload];
}

/** The role a person or an invitation has, as one value of the select: "admin", "member", or the id of a made role. */
export const roleValue = (row: { role: string; role_id?: string | null }) => row.role_id || row.role;
/** How the Team list names a role: the made role's name, or Owner, Admin, Member. */
export const roleLabel = (row: { role: string; role_name?: string | null }) => row.role_name || (row.role === 'owner' ? 'Owner' : row.role === 'admin' ? 'Admin' : 'Member');

/**
 * Whether someone whose role can do `giver` may give a role that can do `wants` (the server's assertMayGive).
 * Without `giver` (an older answer, or a built-in admin), everything as before.
 */
export const mayGive = (giver: readonly string[] | null | undefined, wants: readonly string[]) => !giver || wants.every((t) => giver.includes(t));
// The built-in Admin can do everything, the plan and payments too; a made role never can, so it never offers Admin.
const ADMIN_CAN = [...THINGS, 'billing'];

export function RoleSelect({ value, roles, onChange, label, width, giver }: { value: string; roles: Made[]; onChange: (v: string) => void; label?: string; width?: number; giver?: readonly string[] | null }) {
  // Only the roles this person may give: no choice that is refused only after pressing Send invite. The one a row
  // has now stays in the list, so the select never shows a role the person does not have.
  const offer = (v: string, wants: readonly string[]) => v === value || mayGive(giver, wants);
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} style={{ ...TALL, ...(width ? { width } : {}) }}>
      {offer('member', MEMBER_THINGS) && <option value="member">Member</option>}
      {offer('admin', ADMIN_CAN) && <option value="admin">Admin</option>}
      {roles.filter((r) => offer(r.id, r.can)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  );
}

type RoleForm = { id?: string; name: string; base: Base; keep: Thing[] };

export function Profiles({ members, onChanged }: { members: { id: string; name: string; role: string }[]; onChanged?: () => void }) {
  const [d, reload] = useLoad<any>(() => api('/account/roles'), []);
  const [g, reloadGroups] = useLoad<any>(() => api('/account/member-groups'), []);
  const [form, setForm] = useState<RoleForm | null>(null);
  const [group, setGroup] = useState<{ id?: string; name: string; people: string[]; role: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!d || !g) return null;
  const roles: Made[] = d.roles || [];
  const groups: Group[] = g.groups || [];
  const may = !!d.may_change;
  // Only what the person's own role can do can be given (the server says the same).
  const mine = new Set<string>(d.yours?.can || []);
  // A role from Member with nothing left out would be Member under a second name (the server refuses it too).
  const sameAsMember = !!form && form.base === 'member' && baseThings('member').every((t) => form.keep.includes(t));

  async function saveRole() {
    if (!form) return;
    setBusy(true);
    setError('');
    const left_out = baseThings(form.base).filter((t) => !form.keep.includes(t));
    try {
      if (form.id) await api(`/account/roles/${form.id}`, { method: 'PATCH', body: { name: form.name, left_out } });
      else await api('/account/roles', { body: { name: form.name, base: form.base, left_out } });
      toast(form.id ? 'Role saved' : 'Role made');
      setForm(null);
      reload();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  async function saveGroup() {
    if (!group) return;
    setBusy(true);
    setError('');
    try {
      const body = { name: group.name, people: group.people, role: group.role || null };
      if (group.id) await api(`/account/member-groups/${group.id}`, { method: 'PATCH', body });
      else await api('/account/member-groups', { body });
      toast(group.id ? 'Group saved' : 'Group made');
      setGroup(null);
      reloadGroups();
      reload();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  const removeRole = (r: Made) => window.confirm(`Delete the role ${r.name}? Nobody has it now, so nobody's access changes.`)
    && api(`/account/roles/${r.id}`, { method: 'DELETE' }).then(() => (toast('Role deleted'), reload(), reloadGroups(), onChanged?.())).catch(oops);
  const removeGroup = (x: Group) => window.confirm(`Delete the group ${x.name}? Its people keep their roles. Templates chosen for the group are no longer open to them through it.`)
    && api(`/account/member-groups/${x.id}`, { method: 'DELETE' }).then(() => (toast('Group deleted'), reloadGroups())).catch(oops);

  return (
    <>
      {/* One card for both, so Team keeps to its count of cards when More options is open (research/ux-charter.md, 2.2). */}
      <div className="card stack" data-item="card">
      <section aria-labelledby="roles-h">
        <h2 id="roles-h" style={{ marginBottom: 4 }}>What each role can do</h2>
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
          {d.built_in.map((b: any) => <li key={b.key}><b>{b.name}</b><div className="muted small">{b.sentence}</div></li>)}
          {roles.map((r) => (
            <li key={r.id} className="row between wrap" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ flex: '1 1 220px' }}>
                <b>{r.name}</b>
                <div className="muted small">{r.sentence}</div>
                <div className="muted small">{r.people ? `${r.people === 1 ? '1 person has it' : `${r.people} people have it`}: ${r.names.join(', ')}.` : 'Nobody has it yet.'}{r.groups.length ? ` Given by the group${r.groups.length > 1 ? 's' : ''} ${r.groups.join(', ')}.` : ''}</div>
              </div>
              {/* A role that can do more than yours is not yours to change or delete (the server says the same). */}
              {may && mayGive(d.yours?.can, r.can) && <span className="row">
                <button className="btn sm" style={TALL} onClick={() => (setError(''), setForm({ id: r.id, name: r.name, base: r.base, keep: r.can }))} aria-label={`Change the role ${r.name}`}>Change</button>
                {!r.people && !r.invites && <button className="btn sm ghost danger" style={TALL} onClick={() => removeRole(r)} aria-label={`Delete the role ${r.name}`}>Delete</button>}
              </span>}
            </li>
          ))}
        </ul>
        {may && roles.length < d.max && <button className="btn" style={TALL} onClick={() => (setError(''), setForm({ name: '', base: 'member', keep: [...baseThings('member')] }))}>Make a role</button>}
        <p className="muted small" style={{ marginBottom: 0 }}>A new role starts from Admin or Member and leaves out what it should not do. To give it to someone, pick it in the Role list when you invite them, or next to their name above. The plan and payments stay with the owner and the admins.</p>
      </section>

      <section aria-labelledby="mgroups-h" style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <h2 id="mgroups-h" style={{ marginBottom: 4 }}>Groups of members</h2>
        <p className="muted small">Not the same as groups in Contacts: these are people on your team, used to share templates and give a role. A group can be chosen as a whole under a template&apos;s &quot;Who can use this&quot;. It can also give everyone in it a role.</p>
        {groups.length > 0 && <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
          {groups.map((x) => (
            <li key={x.id} className="row between wrap" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ flex: '1 1 220px' }}>
                <b>{x.name}</b>
                <div className="muted small">{x.people.length ? x.people.map((p) => p.name).join(', ') : 'Nobody in it yet.'}{x.role ? ` Gives the role ${x.role.name}.` : ''}</div>
              </div>
              {g.may_change && <span className="row">
                <button className="btn sm" style={TALL} onClick={() => (setError(''), setGroup({ id: x.id, name: x.name, people: x.people.map((p) => p.id), role: x.role?.id || '' }))} aria-label={`Change the group ${x.name}`}>Change</button>
                <button className="btn sm ghost danger" style={TALL} onClick={() => removeGroup(x)} aria-label={`Delete the group ${x.name}`}>Delete</button>
              </span>}
            </li>
          ))}
        </ul>}
        {g.may_change && groups.length < g.max && <button className="btn" style={TALL} onClick={() => (setError(''), setGroup({ name: '', people: [], role: '' }))}>Make a group</button>}
      </section>
      </div>

      {form && (
        <Dialog title={form.id ? `Change ${form.name || 'the role'}` : 'Make a role'} onClose={() => setForm(null)}>
          <label className="f"><span>Name</span><input data-autofocus value={form.name} maxLength={ROLE_NAME_MAX} onChange={(e) => setForm({ ...form, name: e.target.value })} style={TALL} /></label>
          {!form.id && (
            <label className="f"><span>Starts from</span>
              <select value={form.base} onChange={(e) => { const base = e.target.value as Base; setForm({ ...form, base, keep: [...baseThings(base)].filter((t) => mine.has(t)) }); }} style={TALL}>
                <option value="member">Member: sees what they sent</option>
                <option value="admin">Admin: sees Settings for the team</option>
              </select>
            </label>
          )}
          <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
            <legend className="small" style={{ fontWeight: 600 }}>What it can do</legend>
            {THINGS.filter((t) => baseThings(form.base).includes(t)).map((t) => (
              <label key={t} className="row" style={{ alignItems: 'flex-start', gap: 10, minHeight: 44, padding: '4px 0' }}>
                <input type="checkbox" style={{ width: 22, height: 22, marginTop: 2, flex: '0 0 auto' }} checked={form.keep.includes(t)} disabled={!mine.has(t)}
                  onChange={(e) => setForm({ ...form, keep: e.target.checked ? [...form.keep, t] : form.keep.filter((x) => x !== t) })} />
                <span><b>{THING_WORDS[t].name}</b><span className="muted small" style={{ display: 'block' }}>{THING_WORDS[t].covers}{!mine.has(t) ? ' Your own role cannot do this, so you cannot give it.' : ''}</span></span>
              </label>
            ))}
          </fieldset>
          {sameAsMember && <p className="muted small" id="role-same">Untick what this role should not do. With everything ticked it is the same as Member.</p>}
          {error && <p className="notice err" role="alert">{error}</p>}
          {/* Kept in reach at the bottom: from Admin the list is long on a phone (research/ux-charter.md, P11). */}
          <div className="actions" style={STICKY}>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !form.name.trim() || sameAsMember} aria-describedby={sameAsMember ? 'role-same' : undefined} onClick={saveRole}>{form.id ? 'Save role' : 'Make role'}</button>
          </div>
        </Dialog>
      )}

      {group && (
        <Dialog title={group.id ? `Change ${group.name || 'the group'}` : 'Make a group'} onClose={() => setGroup(null)}>
          <label className="f"><span>Name</span><input data-autofocus value={group.name} maxLength={60} onChange={(e) => setGroup({ ...group, name: e.target.value })} style={TALL} /></label>
          <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
            <legend className="small" style={{ fontWeight: 600 }}>Who is in it</legend>
            {members.map((m) => (
              <label key={m.id} className="row" style={{ gap: 10, minHeight: 44 }}>
                <input type="checkbox" style={{ width: 22, height: 22, flex: '0 0 auto' }} checked={group.people.includes(m.id)}
                  onChange={(e) => setGroup({ ...group, people: e.target.checked ? [...group.people, m.id] : group.people.filter((x) => x !== m.id) })} />
                <span>{m.name}</span>
              </label>
            ))}
          </fieldset>
          {roles.length > 0 && (
            <label className="f"><span>Give everyone in it a role</span>
              <select value={group.role} onChange={(e) => setGroup({ ...group, role: e.target.value })} style={TALL}>
                <option value="">No, they keep their own</option>
                {roles.filter((r) => r.id === group.role || mayGive(d.yours?.can, r.can)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          {group.role && <p className="muted small">Everyone in the group gets this role now, and so does anyone added later. The owner keeps theirs. Taking someone out of the group does not change their role: change it next to their name on the Team list.</p>}
          {error && <p className="notice err" role="alert">{error}</p>}
          <div className="actions" style={STICKY}>
            <button className="btn" onClick={() => setGroup(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !group.name.trim()} onClick={saveGroup}>{group.id ? 'Save group' : 'Make group'}</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
