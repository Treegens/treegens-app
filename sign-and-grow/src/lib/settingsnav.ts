// The sections of Settings, and who sees which (research/ux-charter.md, 2.2). A section with nothing for this person
// is not listed: an owner or admin sees at most 10, a member at most 4. Shared by the Settings page and its tests.
//
// What moved on 21 November 2026, and where an old link lands:
//   password, ways to sign in, two-step login, where you are signed in   Profile -> Security
//   reminders, the deadline and the date format of new documents          Account -> Sending
//   the emails you get about your documents                               Notifications -> Profile
// Members have no Account, Sending, Stamps, Plan or Your data section: everything there is set by admins. What a
// member could do in them before (export their documents, close their own login) is under Profile, More options.

export type Role = 'owner' | 'admin' | 'member';
export type SectionKey = 'profile' | 'security' | 'account' | 'sending' | 'team' | 'stamps' | 'billing' | 'data' | 'developers';

const SECTIONS: { key: SectionKey; label: string; admins?: true }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'security', label: 'Security' },
  { key: 'account', label: 'Account', admins: true },
  { key: 'sending', label: 'Sending', admins: true },
  { key: 'team', label: 'Team' },
  { key: 'stamps', label: 'Stamps', admins: true },
  { key: 'billing', label: 'Plan', admins: true },
  { key: 'data', label: 'Your data', admins: true },
  { key: 'developers', label: 'API and webhooks' },
];

export const SETTINGS_MAX = { admin: 10, member: 4, cards: 4 };

/** The sections this person sees, in order. */
export function sectionsFor(role: string | null | undefined): [SectionKey, string][] {
  const member = role !== 'owner' && role !== 'admin';
  return SECTIONS.filter((s) => !(member && s.admins)).map((s) => [s.key, s.label]);
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
export function landingFor(role: string | null | undefined, tab: string | null | undefined, hash = '', signin = false): Landing {
  const mine = sectionsFor(role).map(([k]) => k);
  const asked = String(tab || '').toLowerCase();
  const anchor = hash.replace(/^#/, '');
  if (asked === 'notifications') return { tab: 'profile', focus: 'notifications' };
  if ((asked === 'profile' || !asked) && (anchor === 'two-step' || signin)) return { tab: 'security', focus: anchor || undefined };
  const known = SECTIONS.find((s) => s.key === asked);
  if (!known) return { tab: 'profile' };
  if (!mine.includes(known.key)) return { tab: 'profile', note: `${known.label} is set by the owner and the admins of this account, so it is not in your Settings. Ask one of them: Team lists who they are.` };
  return { tab: known.key, focus: anchor || undefined };
}

/** A whole number of days inside the limits, or null when the box does not hold one (then nothing is sent). */
export function daysIn(value: string, lo: number, hi: number): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= lo && n <= hi ? n : null;
}
