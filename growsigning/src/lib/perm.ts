// What each role on a team can do (Settings, Team, More options, "What each role can do"). Shared by the server
// (src/server/perm.ts enforces it) and the Team page, so the list on the screen is the list that is checked.
//
// Three roles are built in and behave exactly as they always have: the owner, Admin and Member. An admin can make
// more roles. A new role starts as a copy of Admin or of Member and leaves out what it may not do, so it never does
// anything the role it started from could not do, and the screens it sees are the screens of that role.
// Two things are never part of a role an admin makes: the plan and payments, and handing the account over. They stay
// with the owner (and the plan with the built-in admins as well, as it always was).

/** The things a role can do, in the order the screen lists them. */
export const THINGS = [
  'send', 'use_templates', 'make_templates', 'edit_any_template', 'see_all', 'bulk', 'forms', 'clickwrap',
  'contacts', 'groups', 'stamps', 'reports', 'api_keys', 'webhooks', 'team', 'settings',
] as const;
export type Thing = (typeof THINGS)[number];
/** Kept for the built-in owner and admins only, never in a role an admin makes. */
export type OwnerThing = 'billing';
export type Can = Thing | OwnerThing;
export const isThing = (k: unknown): k is Thing => typeof k === 'string' && (THINGS as readonly string[]).includes(k);

/** The words for each thing: a short name, and what it covers in one sentence. */
export const THING_WORDS: Record<Thing, { name: string; covers: string }> = {
  send: { name: 'Send documents', covers: 'Write, send, change and cancel their own documents.' },
  use_templates: { name: 'Use templates', covers: 'Open templates and start documents from them.' },
  make_templates: { name: 'Make templates', covers: 'Make templates and change their own.' },
  edit_any_template: { name: "Change other people's templates", covers: 'Change, lock and share any template of the team, and see every template.' },
  see_all: { name: 'See every document', covers: 'See the documents, Send to many, contacts and reports of everyone on the team, not only their own. Exporting everything and bringing documents in need this too.' },
  bulk: { name: 'Send to many', covers: 'Send one template to a list of people.' },
  forms: { name: 'Forms', covers: 'Make links that anyone can open to fill in and sign.' },
  clickwrap: { name: 'Website terms', covers: 'Make and publish terms people agree to on a website, and see who agreed.' },
  contacts: { name: 'Contacts', covers: 'Save and change contacts.' },
  groups: { name: 'Contact groups', covers: 'Make and change groups in Contacts, where any one person of the group signs.' },
  stamps: { name: 'Stamps and seals', covers: 'Add and change the company stamps, and see the seal. Using a stamp while signing needs nothing extra.' },
  reports: { name: 'Reports', covers: 'See the reports of what was sent.' },
  api_keys: { name: 'API keys of their own', covers: 'Make and stop API keys that send for them.' },
  webhooks: { name: 'Webhooks and team-wide keys', covers: 'Set up webhooks, see every API key of the team, and make keys that can do what an admin can.' },
  team: { name: 'Team', covers: 'Invite people, change their role, remove them, and set up roles and groups of members.' },
  settings: { name: 'Account settings', covers: 'Change the account, sending, security, records and data settings, and read the security record.' },
};

/** What a built-in Member can do, exactly as before roles could be made. */
export const MEMBER_THINGS: readonly Thing[] = ['send', 'use_templates', 'make_templates', 'bulk', 'forms', 'contacts', 'reports', 'api_keys'];
/** What a built-in Admin (and the owner) can do: everything. */
export const ADMIN_THINGS: readonly Thing[] = THINGS;

export type Base = 'admin' | 'member';
export const BASE_WORDS: Record<Base, string> = { admin: 'Admin', member: 'Member' };
export const baseThings = (base: Base): readonly Thing[] => (base === 'admin' ? ADMIN_THINGS : MEMBER_THINGS);

/** How many roles an account can make, how long a name may be, how many groups and how many people per group. */
export const ROLES_PER_ACCOUNT = 20;
export const ROLE_NAME_MAX = 40;
export const MEMBER_GROUPS_PER_ACCOUNT = 50;
export const MEMBER_GROUP_SIZE_MAX = 500;
/** Names a made role cannot take, so nobody reads "Admin" and thinks it is the built-in one. */
export const RESERVED_ROLE_NAMES = ['owner', 'admin', 'admins', 'member', 'members'];

/** The things a role keeps: those of its base, less the ones it leaves out, in the order of THINGS. */
export function roleThings(base: Base, leftOut: readonly string[]): Thing[] {
  const out = new Set(leftOut);
  return baseThings(base).filter((k) => !out.has(k));
}

/** One sentence for the Team page: what a role leaves out compared with the role it started from. */
export function roleSentence(name: string, base: Base, things: readonly Thing[]): string {
  const missing = baseThings(base).filter((k) => !things.includes(k)).map((k) => THING_WORDS[k].name.toLowerCase());
  const list = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
  const plan = base === 'admin' ? ' The plan and payments stay with the owner and the built-in admins.' : '';
  return missing.length
    ? `${name} can do what ${BASE_WORDS[base] === 'Admin' ? 'an Admin' : 'a Member'} can, except: ${list(missing)}.${plan}`
    : `${name} can do everything ${BASE_WORDS[base] === 'Admin' ? 'an Admin' : 'a Member'} can.${plan}`;
}

/** What /me says about the person's role: the base screens and the things they may do. */
export type MyRole = { name: string; base: Base | 'owner'; can: Can[]; custom: boolean };

/** Whether the person /me describes may do one thing. Without the field (an older server), the role decides. */
export function mayDo(me: { role?: string; my_role?: MyRole | null } | null | undefined, thing: Can): boolean {
  if (me?.my_role?.can) return me.my_role.can.includes(thing);
  if (me?.role === 'owner' || me?.role === 'admin') return true;
  return (MEMBER_THINGS as readonly string[]).includes(thing);
}

/** The refusal a person reads when their role leaves a thing out. */
export const notInRole = (role: string, thing: Can): string =>
  thing === 'billing'
    ? 'Only the owner and the admins of this account can change the plan or pay. Nothing was changed.'
    : `Your role on this team (${role}) does not include "${THING_WORDS[thing].name}". Nothing was changed. Ask an admin of your team if you need it.`;

// The pages of the sidebar that need a thing (src/components/AppNav.tsx). Only a role an admin made can lack one, so
// with the built-in roles every entry stays where it was.
const PAGE_NEEDS: Record<string, Thing> = {
  '/app/envelopes/new': 'send', '/app/templates': 'use_templates', '/app/contacts': 'contacts', '/app/bulk': 'bulk',
  '/app/powerforms': 'forms', '/app/agreements': 'clickwrap', '/app/reports': 'reports',
};
/** Whether the sidebar shows the entry `href` to a person whose role can do `can` (absent: everything as before). */
export const navAllowed = (href: string, can?: readonly string[] | null): boolean => !can || !PAGE_NEEDS[href] || can.includes(PAGE_NEEDS[href]);
