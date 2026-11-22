// People who change the envelope on their turn, instead of signing it (src/server/agents.ts). Two roles, in the
// words of research/ux-notes.json "ds-recipient-types":
//   - 'editor', "Can change the document": on their turn they may replace the files and change, add or take off the
//     people after them, under the same rules as the sender's Edit (someone who finished signs again when what
//     they signed changes). Then they finish their step. They do not sign.
//   - 'agent', "Chooses who comes next": on their turn they fill in, or change, the name and the email address of the
//     people after them who have not started. Then they finish their step. They do not sign.
// Neither changes the sender's subject or message. Both need a signing order, so that there is an "after them".
// Shared by the server and the pages: no server imports here.
import { onlyWhenOf } from './routing.ts';

export const STEP_ROLES = ['editor', 'agent'] as const;
export type StepRole = (typeof STEP_ROLES)[number];
export const isStepRole = (role: any): role is StepRole => role === 'editor' || role === 'agent';

/** The role list's words, after the divider (research/ux-charter.md 2.3). */
export const STEP_ROLE_WORDS: Record<StepRole, string> = { editor: 'Can change the document', agent: 'Chooses who comes next' };

/** The one line under the chosen role in the editor. */
export const STEP_ROLE_LINE: Record<StepRole, string> = {
  editor: 'They can change the files and the people after them on their turn, and do not sign.',
  agent: 'They name the people after them on their turn, and do not sign.',
};

/** Their invitation email: "Rosa Diaz asked you to choose who signs next: Lease" and its button. */
export const STEP_MAIL: Record<StepRole, { verb: string; button: string }> = {
  editor: { verb: 'asked you to check and, if needed, change:', button: 'Open the document' },
  agent: { verb: 'asked you to choose who signs next:', button: 'Choose who signs' },
};

/** What the certificate says under Status once they finished. */
export const STEP_DONE: Record<StepRole, string> = { editor: 'Finished their step', agent: 'Finished their step' };

/** The most people one step may name or change in one go, and how many times a link may save changes in an hour. */
export const STEP_MAX_PEOPLE = 50;
export const STEP_SAVES_PER_HOUR = 30;

/**
 * Who changed what someone had signed, in the words they are told: the sender, or the person who "Can change the
 * document" with who asked them ("Ed Lawyer, who Rosa Diaz asked to check it,"). Ends with a comma for an editor, so
 * "After that, ${changerWords(...)} changed the document" reads as one sentence either way.
 */
export const changerWords = (editor: string | null | undefined, sender: string): string => (String(editor || '').trim() ? `${String(editor).trim()}, who ${sender} asked to check it,` : sender);

/** After "Finish later" on their screen: nothing typed there is kept until they finish (POST .../step/... saves it). */
export const stepLaterWords = (bySender: boolean): string =>
  `${bySender ? 'Open this same link again' : 'Use the link in your email'} when you are ready. What you typed here is saved only when you press Finish.`;

/** The name a place gets while it waits for the person who chooses it. */
export const openPlaceName = (chooser: string, roleName?: string | null) => (String(roleName || '').trim() ? String(roleName).trim() : `Chosen by ${String(chooser || '').trim() || 'the person before'}`);

/** Someone before `r` in the order who chooses who comes next and has not finished yet. */
export function chooserBefore(r: any, people: any[], ordered: boolean): any | null {
  if (!ordered || !r) return null;
  const before = people.filter((x) => x.id !== r.id && x.role === 'agent' && x.status !== 'completed' && Number(x.routing_order) < Number(r.routing_order));
  return before.sort((a, b) => Number(b.routing_order) - Number(a.routing_order))[0] || null;
}

/**
 * Whether this row is a place left open for someone who chooses who comes next: no address, no group, not a
 * witness, not a link the sender passes on, and such a chooser comes before it.
 */
export const isOpenPlace = (r: any, people: any[], ordered: boolean): boolean =>
  !!r && !String(r.email || '').trim() && !r.group_id && !r.group_name && !r.link_by_sender && r.role !== 'witness' && r.role !== 'cc' && !isStepRole(r.role) && !!chooserBefore(r, people, ordered);

/** The sentence for the record and the certificate: "Mia Chen named Paul Ade as the signer for Landowner". */
export function namedLine(by: string, to: { name: string; email: string }, place: { role: string; role_name?: string | null; name?: string }, before?: { name: string; email: string } | null): string {
  const as = place.role === 'approver' ? 'the approver' : place.role === 'viewer' ? 'the person who must open it' : place.role === 'inperson' ? 'the signer in person' : 'the signer';
  const label = String(place.role_name || '').trim();
  const where = label ? ` for ${label}` : '';
  return `${by} named ${to.name} <${to.email}> as ${as}${where}${before && before.email ? `, in place of ${before.name} <${before.email}>` : ''}.`;
}

/**
 * What stops an envelope with these roles from going out, or null. `people` are its recipients, `fields` its fields.
 * The same words for the editor's review list and the server.
 */
export function stepRoleProblem(people: any[], fields: any[], ordered: boolean, o: { form?: boolean; bulk?: boolean } = {}): string | null {
  const steps = people.filter((r) => isStepRole(r.role));
  if (!steps.length) return null;
  const s = steps[0];
  const what = STEP_ROLE_WORDS[s.role as StepRole].toLowerCase();
  if (o.form) return `${s.name || 'A person'} ${s.role === 'agent' ? 'chooses who comes next' : 'can change the document'}, and a public form cannot have that: each visitor fills it in alone. Pick another role for them, or send the template as a normal document.`;
  if (o.bulk) return `${s.name || 'A person'} ${s.role === 'agent' ? 'chooses who comes next' : 'can change the document'}, and that does not work with Send to many, where each copy goes out by itself. Pick another role for them, or send these one at a time.`;
  for (const r of steps) {
    const who = String(r.name || '').trim() || 'A person who ' + what;
    if (!ordered) return `${who} ${r.role === 'agent' ? 'chooses who comes next' : 'can change the document'}, so the people they change have to come after them. Turn on Set signing order (More options in step 1) and put ${who === r.name ? r.name : 'them'} before those people.`;
    if (!people.some((x) => x.id !== r.id && Number(x.routing_order) > Number(r.routing_order) && x.role !== 'witness')) return `${who} ${r.role === 'agent' ? 'chooses who comes next' : 'can change the document'}, but nobody comes after them in the signing order. Add the people after them, or pick another role.`;
    // Someone skipped by "Only when" would leave the places they fill in waiting for nobody.
    if (r.role === 'agent' && onlyWhenOf(r)) return `${who} chooses who comes next, so they are always asked. Take off their "Only when" rule, or pick another role for them.`;
    if (fields.some((f) => f.recipient_id === r.id)) return `${who} does not sign, so they cannot have fields. Give their fields to someone else, or pick Needs to sign for them.`;
  }
  return null;
}

/** The certificate's lines for one person (pdf.ts): what a step role did, and who named someone. */
export function stepCertLines(e: any, r: any, ts: (s: any) => string): [string, string][] {
  const lines: [string, string][] = [];
  if (isStepRole(r.role)) lines.push(['What they could do', r.role === 'agent' ? 'Choose the people after them. They did not sign.' : 'Change the files and the people after them. They did not sign.']);
  if (r.chosen_by) lines.push(['Named by', `${r.chosen_by}, on ${ts(r.chosen_at)}`]);
  return lines;
}

/** The status word on the certificate for these roles, or null for every other role. */
export const stepStatus = (r: any): string | null => (isStepRole(r.role) && r.status === 'completed' ? STEP_DONE[r.role as StepRole] : null);
