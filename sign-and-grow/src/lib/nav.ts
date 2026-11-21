// The app's navigation (research/ux-charter.md, section 2.1): what the sidebar lists, in order, and what sits in its
// closed More group. The sidebar and the phone's bottom bar (src/components/AppNav.tsx) are drawn from here, and
// tests/simplify-start.test.ts counts it, so the list cannot grow without someone noticing.

export type NavItem = { href: string; label: string; /** Only the owner and admins of the account see it. */ admins?: boolean };

/** The one start button of the app. On a phone it is "Send" in the bottom bar. */
export const NAV_START: NavItem = { href: '/app/envelopes/new', label: 'Send a document' };

/** Above More. */
export const NAV_MAIN: NavItem[] = [
  { href: '/app', label: 'Home' },
  { href: '/app/envelopes', label: 'Documents' },
  { href: '/app/inbox', label: 'To sign' },
  { href: '/app/templates', label: 'Templates' },
  { href: '/app/contacts', label: 'Contacts' },
];

/** Inside More, closed until the person opens it or is on one of these pages. */
export const NAV_MORE: NavItem[] = [
  { href: '/app/bulk', label: 'Send to many' },
  { href: '/app/powerforms', label: 'Forms' },
  // These terms speak for the team's website, so only its owner and admins manage them.
  { href: '/app/agreements', label: 'Website terms', admins: true },
  { href: '/app/reports', label: 'Reports' },
  { href: '/app/impact', label: 'Trees planted' },
];

/** Below More. Help follows it: a button that opens the helper, not a page. */
export const NAV_END: NavItem[] = [{ href: '/app/settings', label: 'Settings' }];

/** Entries a person sees in the sidebar before opening anything: the start button, the pages, More and Help. */
export const NAV_ENTRIES = 1 + NAV_MAIN.length + 1 + NAV_END.length + 1;

/** The phone's bottom bar, left to right. "Menu" opens everything else. */
export const TAB_BAR = ['Home', 'Documents', 'Send', 'To sign', 'Menu'] as const;

/** Whether the page at `path` belongs to the entry `href`. Home is only Home; starting a document is not Documents. */
export function navOn(href: string, path: string): boolean {
  if (href === '/app') return path === '/app';
  if (href === '/app/envelopes' && path.startsWith('/app/envelopes/new')) return false;
  return path === href || path.startsWith(`${href}/`);
}

const isAdmin = (role: string) => role === 'owner' || role === 'admin';

/** The entries of More this person may see. */
export const moreFor = (role: string): NavItem[] => NAV_MORE.filter((n) => !n.admins || isAdmin(role));

/** Whether `path` is a page inside More: then the group is open without being asked. */
export const insideMore = (path: string, role: string): boolean => moreFor(role).some((n) => navOn(n.href, path));

/** The entries the phone's bottom bar already shows, so the phone's menu does not say them a second time. */
export const IN_TAB_BAR = ['/app', '/app/envelopes', '/app/inbox'];

/**
 * The title of the browser tab for a page of the app, so Home, Documents, To sign and Settings do not all sound
 * alike to a screen reader or look alike in a row of tabs: "Documents · GrowSigning".
 */
export function pageTitle(path: string): string {
  const named = (label: string) => `${label} · GrowSigning`;
  if (path.startsWith('/app/envelopes/new') || /^\/app\/envelopes\/[^/]+\/edit/.test(path)) return named(NAV_START.label);
  if (path === '/app/operator' || path.startsWith('/app/operator/')) return named('Operator');
  // The longest address first, so a page inside Documents is not taken for Home.
  const hit = [...NAV_MAIN, ...NAV_MORE, ...NAV_END].filter((n) => navOn(n.href, path)).sort((a, b) => b.href.length - a.href.length)[0];
  return hit ? named(hit.label) : 'GrowSigning';
}

/** Where this browser remembers, per person, that More was left open. */
export const moreKey = (userId: string) => `growsigning-nav-more:${userId}`;
