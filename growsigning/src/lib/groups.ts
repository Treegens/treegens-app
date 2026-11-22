// Signing groups: a recipient that is a group of people, any one of whom can act ("HR team"). What the pages and
// the server both say about such a recipient is here, so the two cannot disagree. Plain data in, words out.
// The rules themselves are enforced in src/server/groups.ts, and the numbers are in src/lib/policy.ts.

/** A recipient that is a group. On a draft it follows the account's group, on a sent envelope it has its own members. */
export const isGroup = (r: any): boolean => !!r?.group_name;

/** A group nobody has taken on yet: every member's own link still opens the document. */
export const isOpenGroup = (r: any): boolean => !!r?.group_name && !r.claimed_by;

/** "Maya Lopez, for HR team": the person who acts for a group, and the group. For anyone else, their name. */
export const actingName = (r: any): string => (r?.group_name && r.claimed_by ? `${r.name}, for ${r.group_name}` : String(r?.name ?? ''));

const memberList = (members: any[] | undefined, max = 20): string => {
  const l = (members || []).map((m) => `${m.name} <${m.email}>`);
  return l.length > max ? `${l.slice(0, max).join(', ')} and ${l.length - max} more` : l.join(', ');
};

/**
 * A recipient as the record names them: "Ada Signer <ada@example.com>" for a person, "Maya Lopez, for HR team
 * <maya@example.com>" for the member who took a group's document on, and "HR team (a group of 3: ...)" while
 * nobody has.
 */
export function whoIs(r: any): string {
  // A person whose link the sender passes on has no address, and is named with how their link reached them.
  if (!r?.group_name) return !r?.email && r?.link_by_sender ? `${r?.name ?? ''} (link shared by the sender)` : `${r?.name ?? ''} <${r?.email ?? ''}>`;
  if (r.claimed_by) return `${actingName(r)} <${r.email}>`;
  const n = (r.members || []).length;
  return n ? `${r.group_name} (a group of ${n}: ${memberList(r.members)})` : `${r.group_name} (a group)`;
}

// What one member does for the group, by the role the group has on the envelope.
const DOES: Record<string, string> = { signer: 'sign', approver: 'approve', viewer: 'read and confirm', cc: 'read' };
const DID: Record<string, string> = { signer: 'signed', approver: 'approved', viewer: 'confirmed', cc: 'read' };
export const groupDoes = (role: string): string => DOES[role] || 'sign';
export const groupDid = (role: string): string => DID[role] || 'signed';

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** Said in the email to each member and on the screen before they agree: how a group's document works. */
export function groupInvite(group: string, size: number, role: string): string {
  if (role === 'cc') return `This copy went to everyone in ${group} (${people(size)}). Each of you has a link of your own.`;
  return `This was sent to ${group} (${people(size)}), and any one of you can ${groupDoes(role)} it. The first of you who agrees to do so takes it on. After that the others see on their own link who has it.`;
}

/** Said on the screen of the member who is about to agree, right above the button. */
export const groupTakeOn = (group: string, role: string): string =>
  `If you continue, you take this on for ${group}. The record will name you and ${group}, and the other members will see that you have it. If you are not the one who should ${groupDoes(role)} it, close this page and leave it to a colleague.`;

/** Said before a member declines: one member declining declines for the whole group. */
export const groupDeclineNote = (group: string): string =>
  `You are declining for ${group}. That closes the document for everyone, the rest of ${group} included, and the record will name you. If you only mean that you are not the right person, do not decline: leave it to a colleague, or hand it back to the group.`;

/** What the link of another member says once someone has taken the document on. */
export const groupTakenTitle = (by: string, group: string, done: boolean, role: string): string =>
  done ? `${by} from ${group} has ${groupDid(role)} this` : `${by} from ${group} has taken this on`;

// ---- The certificate -------------------------------------------------------------------------------------------
// `iso` is how the certificate keeps a name in a right-to-left script in its own reading order (see pdf.ts).

/** The heading of a recipient on the certificate: for a group, the member who acted and the group. */
export const certName = (r: any, iso: (s: any) => string = String): string =>
  !r?.group_name ? (!r?.email && r?.link_by_sender ? `${iso(r.name)}  (link shared by the sender)` : `${iso(r.name)}  <${r.email}>`) : r.claimed_by ? `${iso(r.name)}, for ${iso(r.group_name)}  <${r.email}>` : `${iso(r.group_name)}  (a group)`;

/** The line under it: the group as it was on this envelope, so the record says who could have acted. */
export function certGroup(r: any, iso: (s: any) => string = String): string {
  const l = (r.members || []).map((m: any) => `${iso(m.name)} <${m.email}>`);
  return `${iso(r.group_name)}, a group of ${l.length}: ${l.join(', ')}. Each had a link of their own, and any one of them could act.`;
}
