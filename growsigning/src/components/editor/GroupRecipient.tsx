'use client';
import { useEffect, useState } from 'react';
import { api } from '../ui';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS } from '@/lib/policy';
import { groupDoes } from '@/lib/groups';
import { MAX_RECIPIENTS, plural, type Ed } from './shared';
import { RecipientRule } from './RecipientRule';

// A recipient that is a signing group, in step 1 of the editor: any one of its members can act for it. On a draft
// or template it only names the account's group and follows it. On an envelope that is out (a correction) its
// members are the people it went out with, and the sender can change them here: someone added is emailed their own
// link when the correction is saved if the group can act (otherwise when it can), someone taken out loses theirs. The server sets the name and the address of
// a group recipient itself and checks every rule again (src/server/groups.ts).

type Member = { id?: string; name: string; email: string; sent_at?: string | null; viewed_at?: string | null };
export type GroupItem = { id: string; name: string; members: Member[] };

// The account's groups, loaded once for the editor. null while loading, and an empty list when there are none or
// they could not be loaded: then nothing about groups is offered, and a person can be named as always.
let cache: GroupItem[] | null = null;
export function useGroups(): GroupItem[] | null {
  const [groups, setGroups] = useState<GroupItem[] | null>(cache);
  useEffect(() => {
    let on = true;
    api('/groups').then((d) => on && setGroups((cache = d.groups || []))).catch(() => on && setGroups(cache || []));
    return () => {
      on = false;
    };
  }, []);
  return groups;
}

export const isGroupRow = (r: any) => !!(r?.group_id || r?.group_name);
const names = (l: Member[]) => (l.length <= 1 ? l.map((m) => m.name).join('') : `${l.slice(0, -1).map((m) => m.name).join(', ')} and ${l[l.length - 1].name}`);
const ROLES: [string, string][] = [['signer', 'Needs to sign'], ['approver', 'Needs to approve'], ['cc', 'Gets a copy'], ['viewer', 'Must open it']];

/** One line about who can act for a group recipient. */
export function groupLine(r: any): string {
  const l: Member[] = r.members || [];
  if (r.group_missing) return 'This group was deleted. Choose another group, or remove this row and name a person.';
  if (!l.length) return 'A group';
  if (r.role === 'cc') return `Each of ${names(l)} gets the copy, with their own link.`;
  return `Any one of ${names(l)} (${plural(l.length, 'person', 'people')}) can ${groupDoes(r.role)} for the group. Each gets their own email and link.`;
}

/** What stops a group recipient from being sent, for the editor's list of problems. The server says the same. */
export function groupProblem(r: any): string {
  if (!isGroupRow(r)) return '';
  const name = r.group_name || r.name || 'A group';
  if (r.group_missing) return `The group "${name}" was deleted. Choose another group for that row, or name a person.`;
  const n = (r.members || []).filter((m: Member) => m.name.trim() && m.email.trim()).length;
  if (n < GROUP_MIN_MEMBERS || n > GROUP_MAX_MEMBERS) return `${name} needs from ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS} members, each with a name and an email address.`;
  return '';
}

/** "Add a group": shown only when the account has groups to choose from. */
export function AddGroup({ ed, groups }: { ed: Ed; groups: GroupItem[] | null }) {
  if (!groups?.length || ed.rcps.length >= MAX_RECIPIENTS) return null;
  const g = groups[0];
  return (
    <button type="button" className="btn ghost ed-group-add" onClick={() => ed.addRcp({ group_id: g.id, group_name: g.name, name: g.name, email: '', members: g.members.map((m) => ({ name: m.name, email: m.email })) })}>
      Add a group
    </button>
  );
}

/** A recipient that is a group, in place of the name and email boxes of a person. */
export function GroupRow({ ed, r, groups, old }: { ed: Ed; r: any; groups: GroupItem[] | null; old: any }) {
  const { env, isTpl, correcting } = ed;
  const wording = ed.wording;
  const [more, setMore] = useState(false);
  const members: Member[] = r.members || [];
  const choose = (id: string) => {
    const g = (groups || []).find((x) => x.id === id);
    if (g) ed.patchRcp(r.id, { group_id: g.id, group_name: g.name, name: g.name, email: '', group_missing: false, claimed_by: null, members: g.members.map((m) => ({ name: m.name, email: m.email })) });
  };
  const setMembers = (l: Member[]) => ed.patchRcp(r.id, { members: l });
  // The same group as when the correction was opened: its members are the people it went out with, and can change.
  const sent = correcting && !!old?.group_name && old.group_id === r.group_id;
  const list = groups || [];
  const known = list.some((g) => g.id === r.group_id);
  return (
    <div className="rcpt ed-group" data-item="person" style={{ ['--fc' as any]: ed.color(r.id) }} role="group" aria-label={`The group ${r.group_name || r.name}`}>
      <div className="row wrap">
        {!!env.ordered && <input type="number" min={1} max={99} value={r.routing_order} aria-label="Signing order" style={{ width: 64 }} disabled={!!wording} onChange={(e) => ed.patchRcp(r.id, { routing_order: Number(e.target.value) || 1 })} />}
        {isTpl && <input placeholder="Role, e.g. HR" value={r.role_name || ''} aria-label="Role name" style={{ flex: '1 1 130px' }} onChange={(e) => ed.patchRcp(r.id, { role_name: e.target.value })} />}
        <select value={known ? r.group_id : ''} aria-label="Signing group" style={{ flex: '1 1 200px' }} disabled={!!wording || !list.length} onChange={(e) => choose(e.target.value)}>
          {!known && <option value="">{r.group_name || r.name || 'Choose a group'}{r.group_missing ? ' (deleted)' : ''}</option>}
          {list.map((g) => <option key={g.id} value={g.id}>{g.name} ({plural(g.members.length, 'member')})</option>)}
        </select>
        <button type="button" className="btn sm ghost" data-more="item" onClick={() => setMore(!more)} aria-expanded={more} aria-controls={`ed-more-${r.id}`} aria-label={`More options for ${r.group_name || r.name}`}>More</button>
        {!wording && <button type="button" className="btn sm ghost danger" onClick={() => ed.removeRcp(r.id)} aria-label={`Remove ${r.group_name || r.name}`}>✕</button>}
      </div>
      <p className="ed-group-members">{r.role !== 'signer' && <b>{ROLES.find(([k]) => k === r.role)?.[1]}. </b>}{groupLine(r)}{r.role !== 'cc' && ' The first who agrees takes it on, and the others then see who has it.'}</p>
      {correcting && old?.claimed_by && old.group_id === r.group_id && (
        <p className="ed-group-members"><b>{old.name} has taken this on for {old.group_name}.</b> To let the whole group have it again, use Give back to the group on the document's page.</p>
      )}
      {more && (
        <div id={`ed-more-${r.id}`} className="grid g2" style={{ marginTop: 10 }}>
          {/* What the group does: in More, like a person's role (PersonMore.tsx). */}
          <label className="f" style={{ margin: 0 }}><span>What the group does</span>
            <select value={r.role} aria-label="Role" disabled={!!wording} onChange={(e) => ed.patchRcp(r.id, { role: e.target.value })}>
              {ROLES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="f" style={{ margin: 0 }}><span>Access code <span className="hint">(one for the whole group, at least 4 characters, give it to them yourself)</span></span><input value={r.access_code || ''} maxLength={50} onChange={(e) => ed.patchRcp(r.id, { access_code: e.target.value })} /></label>
          <label className="f" style={{ margin: 0 }}><span>Private note <span className="hint">(every member sees it)</span></span><input value={r.note || ''} maxLength={1000} onChange={(e) => ed.patchRcp(r.id, { note: e.target.value })} /></label>
          <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>A one-time code by email or text message goes to one person, so it cannot be asked of a group.</p>
          {/* "Only when...", as for a person (RecipientRule.tsx). */}
          <div style={{ gridColumn: '1 / -1', minWidth: 0 }}><RecipientRule ed={ed} r={r} /></div>
        </div>
      )}
      {sent && <MembersEditor members={members} onChange={setMembers} done={old.status === 'completed' && old.role !== 'cc'} />}
    </div>
  );
}

// Who can act for a group on an envelope that is out. Changing it here changes only this envelope, never the
// saved group. A member who is kept keeps their link.
function MembersEditor({ members, onChange, done }: { members: Member[]; onChange: (l: Member[]) => void; done: boolean }) {
  if (done) return <p className="ed-group-members">This group has finished, so its members stay as they were. The record names the group as it was.</p>;
  const patch = (i: number, p: Partial<Member>) => onChange(members.map((m, j) => (j === i ? { ...m, ...p } : m)));
  return (
    <fieldset className="sn-group-members ed-group-edit">
      <legend>Who can act for the group on this document <span className="hint">(changes this document only)</span></legend>
      <ol role="list">
        {members.map((m, i) => (
          <li key={m.id || `new-${i}`}>
            <label className="f"><span>Name of member {i + 1}</span><input value={m.name} maxLength={120} autoComplete="off" onChange={(e) => patch(i, { name: e.target.value })} /></label>
            <label className="f"><span>Email of member {i + 1}</span><input type="email" value={m.email} autoComplete="off" readOnly={!!m.id} title={m.id ? 'To change an address, take this member out and add the new address.' : undefined} onChange={(e) => patch(i, { email: e.target.value })} /></label>
            <button type="button" className="btn ghost danger" disabled={members.length <= 1} onClick={() => onChange(members.filter((_, j) => j !== i))} aria-label={`Take ${m.name || `member ${i + 1}`} out of the group on this document`}>Take out</button>
          </li>
        ))}
      </ol>
      {members.length < GROUP_MAX_MEMBERS && <button type="button" className="btn" onClick={() => onChange([...members, { name: '', email: '' }])}>Add a member</button>}
      <p className="muted small" style={{ margin: '8px 0 0' }}>Someone you add is emailed their own link when you save, if nobody has taken it on and it is the group&apos;s turn. If a colleague has taken it on, they are emailed when it comes back to the group. Someone you take out is told they no longer need to act. If you take out the person who took it on, the whole group is asked again.</p>
    </fieldset>
  );
}
