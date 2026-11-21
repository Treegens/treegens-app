// The sections of Settings, and who sees which (research/ux-charter.md, 2.2). A section with nothing for this person
// is not listed: an owner or admin sees at most 10, a member at most 4. Shared by the Settings page and its tests.
//
// What moved on 21 November 2026, and where an old link lands:
//   password, ways to sign in, two-step login, where you are signed in   Profile -> Security
//   reminders, the deadline and the date format of new documents          Account -> Sending
//   the emails you get about your documents                               Notifications -> Profile
// Members have no Account, Sending, Stamps and seals, Plan or Records and data section: everything there is set by admins. What a
// member could do in them before is under Profile, More options: export their documents, close their own login, and
// read the plan and the stamps (MEMBER_READS: shown without a tab of their own).

export type Role = 'owner' | 'admin' | 'member';
export type SectionKey = 'profile' | 'security' | 'account' | 'sending' | 'team' | 'stamps' | 'billing' | 'data' | 'developers' | 'organisation';

const SECTIONS: { key: SectionKey; label: string; admins?: true; orgAdmins?: true }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'security', label: 'Security' },
  { key: 'account', label: 'Account', admins: true },
  { key: 'sending', label: 'Sending', admins: true },
  { key: 'team', label: 'Team' },
  { key: 'stamps', label: 'Stamps and seals', admins: true },
  { key: 'billing', label: 'Plan', admins: true },
  { key: 'data', label: 'Records and data', admins: true },
  { key: 'developers', label: 'API and webhooks' },
  // Only for an admin of an organisation above accounts (src/server/orgs.ts), whatever their role in this account.
  { key: 'organisation', label: 'Organisation', orgAdmins: true },
];

export const SETTINGS_MAX = { admin: 10, member: 4, cards: 4 };

/** The sections this person sees, in order. */
export function sectionsFor(role: string | null | undefined, orgAdmin = false): [SectionKey, string][] {
  const member = role !== 'owner' && role !== 'admin';
  return SECTIONS.filter((s) => !(member && s.admins) && (!s.orgAdmins || orgAdmin)).map((s) => [s.key, s.label]);
}

export type Landing = {
  /** The section to open. */
  tab: SectionKey;
  /** An element to bring into view once the section is drawn, if the link named one. */
  focus?: string;
  /** Said once at the top when the link asked for a section this person does not have. */
  note?: string;
};

/**
 * Where a link into Settings lands: `tab` and `hash` as they stand in the address, `signin` true when the address
 * carries the answer of a sign-in provider. Old addresses keep working, and a member who follows a link to a section
 * of the admins is told so in words instead of being shown an empty page.
 */
export function landingFor(role: string | null | undefined, tab: string | null | undefined, hash = '', signin = false, orgAdmin = false): Landing {
  const mine = sectionsFor(role, orgAdmin).map(([k]) => k);
  const asked = String(tab || '').toLowerCase();
  const anchor = hash.replace(/^#/, '');
  if (asked === 'notifications') return { tab: 'profile', focus: 'notifications' };
  if ((asked === 'profile' || !asked) && (anchor === 'two-step' || signin)) return { tab: 'security', focus: anchor || undefined };
  const known = SECTIONS.find((s) => s.key === asked);
  if (!known) return { tab: 'profile' };
  // A member may read the plan and the stamps. They have no tab for them and change nothing there.
  if (!mine.includes(known.key) && MEMBER_READS.some(([k]) => k === known.key)) return { tab: known.key, note: `${known.label} is set by the owner and the admins of this account. You can read it here, and they are the ones who change it.` };
  if (!mine.includes(known.key)) return { tab: 'profile', note: `${known.label} is set by the owner and the admins of this account, so it is not in your Settings. Ask one of them: Team lists who they are.` };
  return { tab: known.key, focus: anchor || undefined };
}

/** A whole number of days inside the limits, or null when the box does not hold one (then nothing is sent). */
export function daysIn(value: string, lo: number, hi: number): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= lo && n <= hi ? n : null;
}

/** What is said under a number box of Settings, Sending when its value was refused: which box, the limits, and what is still saved. */
export function refusedDays(key: 'default_reminder_days' | 'default_expire_days', lo: number, hi: number, kept: string): string {
  const box = key === 'default_reminder_days' ? 'Reminders' : 'Deadline';
  return `${box}: type a whole number from ${lo} to ${hi}. ${kept === '' ? 'Nothing was changed.' : `It is still ${kept}.`}`;
}

/** "its 3 documents", "its 1 document", or just "everything in it" for none: how many documents go with a closing account. */
export const closingCount = (n: number): string => (n > 1 ? `its ${n} documents` : n === 1 ? 'its 1 document' : 'everything in it');

/** Which section an arrow key moves to in the row of sections, or null when the key is not one of them. */
export function nextTab<T extends string>(keys: T[], at: T, key: string): T | null {
  const i = Math.max(0, keys.indexOf(at));
  if (key === 'ArrowRight' || key === 'ArrowDown') return keys[(i + 1) % keys.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return keys[(i - 1 + keys.length) % keys.length];
  if (key === 'Home') return keys[0];
  if (key === 'End') return keys[keys.length - 1];
  return null;
}

/** Said with the API keys, where it matters: it stood in the two-step cards of every member until 21 November 2026. */
export const KEYS_AND_TWO_STEP = 'Two-step login does not apply to API keys: a program that uses one is never asked for a code. Treat a key like a password, and revoke it here if it may have leaked.';

/** What a member may read though admins set it. They have no tab for these: the links are under Profile, More options. */
export const MEMBER_READS: [SectionKey, string][] = [['billing', 'See the plan and payments'], ['stamps', 'See the stamps']];

/** One line about when a browser is signed out. The full rule (sessionWords in policy.ts) is behind "How this works". */
export const sessionShort = (days: number, maxDays: number): string =>
  maxDays <= days ? `A browser is signed out ${maxDays} days after you signed in on it.` : `A browser is signed out after ${days} days without use, or ${maxDays} days after you signed in on it.`;
