// What each role on a team can do, checked on every request (router.ts calls routeAllowed) and inside the handlers
// that do more for some people than for others (can). The list of things and the words are in src/lib/perm.ts.
//
// The built-in roles. The owner and Admin can do everything; Member what MEMBER_THINGS says. For them the router
// keeps the check it always had (an "admin" route needs an owner or admin), and tests/ds-perm-profiles.test.ts
// proves that the table below says the same for every route, so nothing changes for an account that makes no role.
//
// A role an admin made (perm_profiles). It is a copy of Admin or Member (its base, kept in memberships.role, so every
// screen and every check that reads the role still sees Admin or Member) less what it leaves out. The router refuses
// a route whose thing the role left out, and can() says no for it inside the handlers. The plan and payments
// ('billing') are never part of a made role, and handing the account over stays with the owner (routes-account.ts).
//
// API keys. A key has its scope ("send" or "admin"), and on top of that it can never do what the role of the person
// who made it leaves out: the key's request is checked with that person's role, as it is now.
//
// Groups of members (member_groups). A template's chosen members can name a group (tplroles.ts reads inGroups), and
// a group can give its people a role: adding someone to it, or setting its role, sets the role of each of its people.
import type { Ctx } from './router.ts';
import type { Auth } from './auth.ts';
import { all, get } from './db.ts';
import { HttpError, bad, str } from './util.ts';
import { THINGS, MEMBER_THINGS, isThing, roleThings, notInRole, THING_WORDS, BASE_WORDS, ROLE_NAME_MAX, RESERVED_ROLE_NAMES, type Base, type Can, type Thing, type MyRole } from '../lib/perm.ts';

/** What a route needs. A thing of the list, or: */
type Need =
  | Can
  // anyone signed in to the account: their own login, reading what sending needs, and routes with checks of their own
  // (the operator, organisations, handing over the account)
  | 'always'
  // an envelope or a template, decided by which one it is (needFor)
  | 'by_kind'
  // writing a document, for an envelope or for a template: send or make_templates
  | 'drafting'
  // reading a file or the export of documents: send, use_templates, make_templates or see_all
  | 'reading'
  // the full export and bringing documents in: they hold every document of the account, so both settings and see_all
  | 'settings_and_see_all';

// Every route that needs a person signed in, by what it needs. A route missing here fails
// tests/ds-perm-profiles.test.ts, so a new route is always given one. Public routes are not listed.
const NEEDS: Record<Need, string[]> = {
  always: [
    // Whether the account connected its own Stripe account, and Stripe's way back after connecting (routes-collect.ts).
    'GET /collect/connection', 'GET /collect/callback',
    // Locking this browser before the device is handed over to sign in person without signal (routes-offline.ts).
    'POST /offline/:prep/hand-over',
    'GET /account/archive-addresses', 'GET /account/impact-record', 'POST /account/leave', 'GET /account/members',
    'GET /account/retention', 'POST /account/retention/holds', 'DELETE /account/retention/holds/:id',
    'POST /account/transfer-owner', 'POST /auth/resend-verification', 'POST /auth/switch', 'POST /auth/verify-code',
    'GET /billing', 'POST /clickwraps/:id/acceptances', 'GET /clickwraps/:id/status', 'GET /custom-fields', 'GET /saved-fields',
    'POST /embed/sender/close', 'GET /groups', 'GET /impact', 'GET /inbox', 'POST /invites/accept', 'PATCH /me',
    'GET /me/delete', 'POST /me/delete', 'POST /me/email', 'POST /me/email-works', 'POST /me/email/confirm', 'GET /me/idle',
    'POST /me/idle/stay', 'POST /me/password', 'GET /me/sessions', 'DELETE /me/sessions/:id', 'POST /me/sessions/sign-out-others',
    'GET /me/signin', 'DELETE /me/signin/:id', 'POST /me/signin/:provider/connect', 'POST /me/signin/password-link',
    'GET /me/two-step', 'POST /me/two-step/confirm', 'DELETE /me/two-step/devices', 'DELETE /me/two-step/devices/:id',
    'POST /me/two-step/email-reset', 'POST /me/two-step/lost', 'POST /me/two-step/off', 'POST /me/two-step/recovery-codes',
    'POST /me/two-step/reset/stop', 'POST /me/two-step/setup', 'POST /operator/accounts/:id', 'PUT /operator/accounts/:id/org',
    'POST /operator/billing/accounts/:id/clear-dispute', 'GET /operator/billing/disputed', 'GET /operator/billing/lookup',
    'POST /operator/billing/price-notice', 'POST /operator/disputes/:id', 'GET /operator/holds', 'POST /operator/holds/:id/lift',
    'GET /operator/leak-check', 'GET /operator/encryption', 'GET /operator/tree-commitments', 'POST /operator/tree-commitments', 'POST /operator/tree-commitments/:id/signed',
    'POST /operator/tree-commitments/:id/statements', 'DELETE /operator/tree-commitments/:id/statements/:sid', 'GET /billing-mode', 'GET /operator/orgs', 'POST /operator/orgs', 'PUT /operator/orgs/:id/break-glass', 'GET /operator/queue',
    'POST /operator/reports/:id', 'GET /operator/support', 'GET /operator/support/:id', 'POST /operator/support/:id', 'GET /orgs',
    'GET /orgs/:id', 'POST /orgs/:id/admins', 'DELETE /orgs/:id/admins/:user', 'POST /orgs/:id/agencies',
    'POST /orgs/:id/agencies/:aid/break-glass', 'GET /orgs/:id/agencies/:aid/members', 'PATCH /orgs/:id/agencies/:aid/members/:uid',
    'POST /orgs/:id/agencies/:aid/members/:uid/two-step/reset', 'POST /orgs/:id/agencies/:aid/people', 'PUT /orgs/:id/agencies/:aid/sending',
    'GET /orgs/:id/events', 'POST /orgs/:id/orgs', 'PUT /orgs/:id/policy', 'GET /orgs/:id/report', 'GET /stamps', 'GET /stamps/:id/image',
    'GET /support/mine', 'POST /support/mine/:id/reply', 'POST /support/mine/:id/solved',
    // This file's own (routes-perm.ts): reading the roles and the groups, for the role select and "Who can use this".
    'GET /account/roles', 'GET /account/member-groups',
    // Signing at a service counter (routes-counter.ts): the counter checks its own staff list.
    'GET /counter', 'POST /counter/start', 'POST /counter/visits', 'GET /counter/visits/:id', 'POST /counter/visits/:id/identity',
    'POST /counter/visits/:id/picture', 'POST /counter/visits/:id/helps', 'POST /counter/visits/:id/helps/:help/confirm',
    'DELETE /counter/visits/:id/helps/:help', 'POST /counter/visits/:id/code', 'POST /counter/visits/:id/link', 'GET /counter/visits/:id/receipt',
    // A person's own delegate while they are away (routes-delegation.ts): their own, whatever their role.
    'GET /me/delegate', 'PUT /me/delegate', 'DELETE /me/delegate',
    // Sharing one's own documents with a colleague (routes-shares.ts): their own, whatever their role.
    'GET /me/shares', 'POST /me/shares', 'DELETE /me/shares/:id', 'GET /me/sends-for',
  ],
  by_kind: [
    'GET /envelopes', 'POST /envelopes', 'DELETE /envelopes/:id', 'GET /envelopes/:id', 'PATCH /envelopes/:id', 'PUT /envelopes/:id',
    'GET /envelopes/:id/access', 'PUT /envelopes/:id/access', 'GET /envelopes/:id/ai-summary', 'PUT /envelopes/:id/ai-summary',
    'POST /envelopes/:id/clone', 'GET /envelopes/:id/comments', 'POST /envelopes/:id/comments', 'POST /envelopes/:id/comments/:thread/settle',
    'POST /envelopes/:id/correct', 'PUT /envelopes/:id/custom-fields', 'GET /envelopes/:id/disputes', 'POST /envelopes/:id/documents/:doc/pages',
    'GET /envelopes/:id/download', 'GET /envelopes/:id/evidence', 'POST /envelopes/:id/extend', 'POST /envelopes/:id/hold',
    'DELETE /envelopes/:id/hold', 'GET /envelopes/:id/impact', 'POST /envelopes/:id/impact/seen', 'POST /envelopes/:id/keep',
    'POST /envelopes/:id/pause', 'GET /envelopes/:id/pay-link', 'PUT /envelopes/:id/pay-link', 'POST /envelopes/:id/purge',
    'DELETE /envelopes/:id/purge', 'POST /envelopes/:id/recipient-view', 'POST /envelopes/:id/recipient-preview',
    // Signing in person without signal: getting one person's part ready on this device, and ending it (routes-offline.ts).
    'POST /envelopes/:id/offline', 'GET /envelopes/:id/offline', 'DELETE /envelopes/:id/offline/:prep', 'POST /envelopes/:id/recipients/:rid/release',
    'POST /envelopes/:id/remind', 'POST /envelopes/:id/restore', 'GET /envelopes/:id/retention', 'POST /envelopes/:id/resume',
    'POST /envelopes/:id/send', 'POST /envelopes/:id/send-later', 'DELETE /envelopes/:id/send-later', 'POST /envelopes/:id/sender-view',
    'GET /envelopes/:id/stamp-image/:sha', 'POST /envelopes/:id/try-again', 'POST /envelopes/:id/void', 'GET /envelopes/:id/warnings',
    'GET /envelopes/:id/key-dates', 'POST /envelopes/:id/key-dates/find', 'POST /envelopes/:id/key-dates', 'PUT /envelopes/:id/key-dates/:term',
    'DELETE /envelopes/:id/key-dates/:term', 'PUT /envelopes/:id/key-dates-reminder',
    'PUT /envelopes/:id/only-named', 'POST /envelopes/:id/away',
    // Moving to a colleague and "Send for" (routes-shares.ts).
    'POST /envelopes/:id/move', 'POST /envelopes/:id/send-for',
    // Asking for a payment by card on a document or template (routes-collect.ts).
    'GET /envelopes/:id/collect', 'PUT /envelopes/:id/collect',
  ],
  drafting: [
    'GET /ai/assist', 'POST /ai/draft', 'POST /ai/fields', 'POST /files', 'POST /files/:id/undo-cleanup', 'POST /print-check', 'GET /write', 'POST /write/change',
    'POST /write/draft', 'POST /write/render', 'GET /write/source/:file', 'POST /write/tidy',
    // "This looks like your template ... Use it?" (routes-tplmatch.ts).
    'GET /files/:id/template-match', 'POST /files/:id/template-match/use',
  ],
  reading: ['GET /export', 'GET /files/:id/content', 'GET /files/:id/original', 'GET /account/key-dates', 'GET /key-dates', 'GET /key-dates/calendar.ics'],
  send: ['POST /envelopes/move', 'POST /share-target'],
  use_templates: ['GET /starters', 'GET /starters/:id/preview', 'POST /templates/:id/recipient-preview'],
  make_templates: ['POST /starters/:id/use'],
  edit_any_template: [],
  see_all: [],
  bulk: [
    'GET /bulk', 'POST /bulk', 'GET /bulk-lists', 'POST /bulk-lists', 'DELETE /bulk-lists/:id', 'GET /bulk-lists/:id', 'GET /bulk/:id',
    'POST /bulk/:id/remind', 'POST /bulk/:id/void', 'POST /bulk/check',
  ],
  forms: ['GET /powerforms', 'POST /powerforms', 'DELETE /powerforms/:id', 'PATCH /powerforms/:id'],
  contacts: ['GET /contacts', 'POST /contacts', 'DELETE /contacts/:id', 'PATCH /contacts/:id'],
  reports: ['GET /reports', 'GET /reports/csv', 'GET /reports/monthly', 'PUT /reports/monthly', 'GET /reports/summary'],
  api_keys: ['GET /api-keys', 'POST /api-keys', 'DELETE /api-keys/:id'],
  clickwrap: [
    'GET /clickwrap-acceptances', 'GET /clickwrap-acceptances/:id', 'GET /clickwrap-acceptances/:id/certificate',
    'GET /clickwrap-acceptances/export', 'GET /clickwraps', 'POST /clickwraps', 'DELETE /clickwraps/:id', 'GET /clickwraps/:id',
    'PATCH /clickwraps/:id', 'POST /clickwraps/:id/publish', 'POST /clickwraps/:id/secret',
  ],
  groups: ['POST /groups', 'DELETE /groups/:id', 'PUT /groups/:id'],
  stamps: ['GET /seal', 'POST /stamps', 'DELETE /stamps/:id', 'PUT /stamps/:id'],
  webhooks: ['GET /webhooks', 'POST /webhooks', 'DELETE /webhooks/:id', 'POST /webhooks/deliveries/:id/redeliver'],
  team: [
    'POST /account/invites', 'DELETE /account/invites/:id', 'DELETE /account/members/:id', 'PATCH /account/members/:id',
    'POST /account/members/:id/two-step/reset',
    'POST /account/roles', 'PATCH /account/roles/:id', 'DELETE /account/roles/:id',
    'POST /account/member-groups', 'PATCH /account/member-groups/:id', 'DELETE /account/member-groups/:id',
    'GET /account/members/:id/move-documents', 'POST /account/members/:id/move-documents',
    // Members from your directory (routes-scim.ts): the directory adds and removes people, so this is Team. Making or
    // stopping its token also needs the built-in Admin role or the owner (the handler checks it).
    'PATCH /account/directory', 'POST /account/directory/token', 'DELETE /account/directory/token',
  ],
  settings: [
    // Connecting and disconnecting the account's own Stripe account (routes-collect.ts).
    'POST /collect/connect', 'DELETE /collect/connection',
    'PATCH /account', 'PUT /account/ai-read', 'POST /account/archive-addresses', 'DELETE /account/archive-addresses/:id',
    'GET /account/disclosure', 'PUT /account/disclosure', 'GET /account/disclosure/versions', 'DELETE /account/embed-origins',
    'GET /account/embed-origins', 'POST /account/embed-origins', 'PUT /account/impact-record', 'GET /account/pdfa', 'PUT /account/pdfa', 'GET /account/template-match', 'PUT /account/template-match',
    'GET /account/policy', 'PUT /account/policy', 'PUT /account/retention', 'GET /account/retention/log', 'GET /account/rules',
    'PATCH /account/rules', 'GET /account/security', 'PATCH /account/security', 'GET /account/security-events',
    'GET /account/security-events/csv', 'GET /account/security-events/view', 'DELETE /account/sso', 'GET /account/sso', 'PUT /account/sso',
    'POST /account/sso/domains', 'DELETE /account/sso/domains/:id', 'PATCH /account/sso/domains/:id', 'POST /account/sso/domains/:id/check',
    'PATCH /account/sso/rules', 'POST /account/sso/try', 'PUT /account/sso/saml', 'GET /account/directory', 'GET /account/two-step', 'POST /account/two-step', 'PUT /bulk-lists/settings',
    'POST /custom-fields', 'DELETE /custom-fields/:id', 'PATCH /custom-fields/:id',
    // Saved fields and the text style new fields start with (routes-fieldlib.ts).
    'POST /saved-fields', 'DELETE /saved-fields/:id', 'PUT /saved-fields/look',
    'PUT /account/key-dates', 'POST /account/key-dates/older',
    'GET /account/delegation', 'PUT /account/delegation',
    'GET /counter/settings', 'PUT /counter/settings', 'PUT /counter/staff/:user', 'PUT /counter/templates/:id',
  ],
  settings_and_see_all: [
    'GET /export/full', 'GET /export/full/jobs', 'POST /export/full/jobs', 'GET /export/full/jobs/:id/download',
    'POST /import/docusign', 'POST /import/full', 'GET /imported', 'DELETE /imported/:id', 'GET /imported/:id',
    'GET /imported/:id/files/:sha256', 'GET /imported/count',
  ],
  billing: [
    'POST /billing/cancel', 'POST /billing/checkout', 'POST /billing/pay-open', 'POST /billing/portal', 'POST /billing/redeem',
    'POST /billing/refund', 'POST /billing/remove-card', 'POST /billing/resume', 'POST /billing/sync', 'POST /billing/topup',
  ],
};
const BY_ROUTE = new Map<string, Need>(Object.entries(NEEDS).flatMap(([need, keys]) => keys.map((k) => [k, need as Need] as const)));

/** What a route needs, for the test and the API description. undefined for a route nobody listed yet. */
export const routeNeed = (method: string, path: string): Need | undefined => BY_ROUTE.get(`${method} ${path}`);
/** The list itself, for the test. */
export const ROUTE_NEEDS = NEEDS;

// ---- Whose role is what ------------------------------------------------------------------------------------------

export type Role = { base: 'owner' | Base; profile: any | null; things: ReadonlySet<Can>; name: string };
const ALL: ReadonlySet<Can> = new Set<Can>([...THINGS, 'billing']);
const MEMBER: ReadonlySet<Can> = new Set<Can>(MEMBER_THINGS);
const BUILT_IN_NAME = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

const leftOutOf = (p: any): string[] => {
  try {
    const l = JSON.parse(p?.left_out || '[]');
    return Array.isArray(l) ? l.filter(isThing) : [];
  } catch {
    return [];
  }
};
/** A made role as the API shows it. */
export function profileView(p: any) {
  const base: Base = p.base === 'admin' ? 'admin' : 'member';
  return { id: p.id, name: p.name, base, left_out: leftOutOf(p), can: roleThings(base, leftOutOf(p)) };
}

/** The role of one person in one account. `held` is the role the request is held to (an organisation's admin is a member here). */
export function roleIn(accountId: string, userId: string, held?: string): Role {
  const m = get('SELECT m.role, m.profile_id, p.id pid, p.name pname, p.base, p.left_out FROM memberships m LEFT JOIN perm_profiles p ON p.id=m.profile_id AND p.account_id=m.account_id WHERE m.account_id=? AND m.user_id=?', accountId, userId);
  const role = held || m?.role || 'member';
  if (role === 'owner') return { base: 'owner', profile: null, things: ALL, name: BUILT_IN_NAME.owner };
  // Held to less than the membership says (an organisation's admin, orgs.ts): the built-in Member, whatever is stored.
  if (m?.pid && m.role === role) {
    const p = { id: m.pid, name: m.pname, base: m.base, left_out: m.left_out };
    const base: Base = m.base === 'admin' ? 'admin' : 'member';
    return { base, profile: p, things: new Set<Can>(roleThings(base, leftOutOf(p))), name: m.pname };
  }
  return role === 'admin' ? { base: 'admin', profile: null, things: ALL, name: BUILT_IN_NAME.admin } : { base: 'member', profile: null, things: MEMBER, name: BUILT_IN_NAME.member };
}

const cache = new WeakMap<object, Role>();
function roleOfAuth(auth: Auth): Role {
  let r = cache.get(auth);
  if (!r) cache.set(auth, (r = roleIn(auth.account.id, auth.user.id, auth.role)));
  return r;
}
/** The role of the person of a request. */
export const roleOf = (c: Ctx | Auth): Role => roleOfAuth(('auth' in c ? c.auth : c) as Auth);

/** Someone the rules are asked about: a request, its sign-in, or a stand-in made without a request (a timer's). */
type Who = Ctx | Auth | { user?: any; account?: any; admin?: boolean; auth?: undefined };

/** Whether the person of this request (or the person who made its key) may do one thing. */
export function can(c: Who | null | undefined, thing: Can): boolean {
  if (!c) return false;
  if ('auth' in c && c.auth) return roleOfAuth(c.auth).things.has(thing);
  if ('via' in c && (c as Auth).via) return roleOfAuth(c as Auth).things.has(thing);
  // A stand-in for a person, made by a timer or a bulk send without a request: their role as it is now.
  const w = c as { user?: any; account?: any; admin?: boolean };
  if (w.user?.id && w.account?.id) return roleIn(w.account.id, w.user.id).things.has(thing);
  return w.admin === true || (MEMBER_THINGS as readonly string[]).includes(thing);
}

/** Refuses, in words, when the person may not do one thing. */
export function need(c: Ctx, thing: Can) {
  if (!can(c, thing)) throw bad(notInRole(roleOf(c).name, thing), 403, { code: 'not_in_role', needs: thing });
}

/** For GET /me: the role's name, its base, and what it can do, so the screens can leave out what it cannot. */
export function myRole(c: Ctx): MyRole {
  const r = roleOf(c);
  return { name: r.name, base: r.base, can: [...r.things], custom: !!r.profile };
}

// ---- The check on every request --------------------------------------------------------------------------------

const kindOf = (accountId: string, envelopeId: string): string | null => get('SELECT kind FROM envelopes WHERE id=? AND account_id=?', envelopeId, accountId)?.kind || null;
async function bodyKind(req: Request): Promise<string> {
  try {
    const b = await req.clone().json();
    return typeof b?.kind === 'string' ? b.kind : '';
  } catch {
    return '';
  }
}

/** The things of which one is enough for this request, for the routes whose need depends on what they touch. */
async function needFor(need: Need, auth: Auth, method: string, path: string, params: Record<string, string>, req: Request, url: URL): Promise<Can[]> {
  if (need === 'drafting') return ['send', 'make_templates'];
  if (need === 'reading') return ['send', 'use_templates', 'make_templates', 'see_all'];
  if (need === 'settings_and_see_all') return ['settings', 'see_all'];
  if (need !== 'by_kind') return [need as Can];
  if (!params.id) {
    // The list, and making a new one.
    const kind = method === 'GET' ? url.searchParams.get('kind') : await bodyKind(req);
    if (kind === 'template') return method === 'GET' ? ['use_templates', 'make_templates', 'edit_any_template'] : ['make_templates'];
    return method === 'GET' ? ['send', 'see_all'] : ['send'];
  }
  const kind = kindOf(auth.account.id, params.id);
  // One that is not there, or not in this account: the handler says "not found" in its own words.
  if (!kind) return [];
  if (path === '/envelopes/:id/clone') {
    const into = (await bodyKind(req)) || kind;
    return into === 'template' ? ['make_templates'] : kind === 'template' ? ['use_templates'] : ['send'];
  }
  if (kind === 'template') return method === 'GET' || path === '/envelopes/:id/sender-view' ? ['use_templates', 'make_templates', 'edit_any_template'] : ['make_templates', 'edit_any_template'];
  return method === 'GET' ? ['send', 'see_all'] : ['send'];
}

/**
 * Called by the router for every route that needs a person signed in, after authenticate. The built-in roles keep
 * the one check there always was; a made role is checked against the table.
 */
export async function routeAllowed(auth: Auth, method: string, path: string, level: string, params: Record<string, string>, req: Request, url: URL) {
  const r = roleOfAuth(auth);
  if (!r.profile) {
    if (level === 'admin' && r.base === 'member') throw new HttpError(403, 'Only account admins can do that.');
    return;
  }
  // A made role starts from its base, so a route of the admins is closed to one that started from Member.
  if (level === 'admin' && r.base === 'member') throw new HttpError(403, 'Only account admins can do that.');
  const n = routeNeed(method, path) ?? (level === 'admin' ? 'settings' : 'always');
  if (n === 'always') return;
  const any = await needFor(n, auth, method, path, params, req, url);
  // Both, not one of them: the first one the role leaves out is named.
  if (n === 'settings_and_see_all') {
    const lacks = any.find((t) => !r.things.has(t));
    if (!lacks) return;
    throw new HttpError(403, notInRole(r.name, lacks), { code: 'not_in_role', needs: lacks });
  }
  if (!any.length || any.some((t) => r.things.has(t))) return;
  throw new HttpError(403, notInRole(r.name, any[0]), { code: 'not_in_role', needs: any[0] });
}

// ---- Giving roles ------------------------------------------------------------------------------------------------

export type RoleChoice = { role: 'admin' | 'member'; profile_id: string | null; name: string; things: ReadonlySet<Can> };

/**
 * What the "role" of an invitation or a member means: "admin", "member", or the id of a role the account made.
 * Anything else is refused, never quietly made a Member.
 */
export function roleChoice(accountId: string, value: unknown): RoleChoice {
  const v = str(value, 80).trim();
  if (v === '' || v === 'member') return { role: 'member', profile_id: null, name: 'Member', things: MEMBER };
  if (v === 'admin') return { role: 'admin', profile_id: null, name: 'Admin', things: ALL };
  const p = get('SELECT * FROM perm_profiles WHERE id=? AND account_id=?', v, accountId);
  if (!p) throw bad(`"role" is "${str(v, 40)}", which is not a role of this team. Use "admin", "member", or the id of a role from GET /account/roles. Nothing was changed.`);
  const view = profileView(p);
  return { role: view.base, profile_id: p.id, name: p.name, things: new Set<Can>(view.can) };
}

const missing = (have: ReadonlySet<Can>, want: ReadonlySet<Can>) => [...want].filter((t) => !have.has(t));
const thingList = (l: Can[]) => l.map((t) => (t === 'billing' ? 'the plan and payments' : THING_WORDS[t as Thing].name.toLowerCase())).join(', ');

/** Refused when someone would give a role that can do more than they can: nobody hands out what they do not have. */
export function assertMayGive(c: Ctx, choice: RoleChoice) {
  const more = missing(roleOf(c).things, choice.things);
  if (more.length) throw bad(`You cannot give the role ${choice.name}, because it can do things your own role cannot: ${thingList(more)}. Nothing was changed. Ask the owner or an admin of your team.`, 403, { code: 'role_too_wide' });
}

/** Refused when someone would change or remove a person whose role can do more than theirs. */
export function assertMayManage(c: Ctx, userId: string, what: string) {
  const target = roleIn(c.account.id, userId);
  if (target.base === 'owner') throw bad(`The owner cannot be ${what}.`, 403);
  const more = missing(roleOf(c).things, target.things);
  if (more.length) throw bad(`This person's role (${target.name}) can do things your own role cannot: ${thingList(more)}. So only the owner or an admin of your team can ${what === 'removed' ? 'remove them' : 'change their role'}. Nothing was changed.`, 403, { code: 'role_too_wide' });
}

/** Checks a role's name: plain text, not too long, not a built-in name, not taken. */
export function roleName(accountId: string, value: unknown, exceptId: string | null, max = ROLE_NAME_MAX, what = 'role'): string {
  const name = str(value, 200).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) throw bad(`Give the ${what} a name.`);
  if (name.length > max) throw bad(`The name of a ${what} can be up to ${max} characters long. Nothing was saved.`);
  if (what === 'role' && RESERVED_ROLE_NAMES.includes(name.toLowerCase())) throw bad(`"${name}" is the name of a built-in role. Choose another name, such as "${name} without billing" or "Reviewer". Nothing was saved.`);
  const table = what === 'role' ? 'perm_profiles' : 'member_groups';
  if (get(`SELECT 1 x FROM ${table} WHERE account_id=? AND lower(name)=lower(?) AND id!=?`, accountId, name, exceptId || ''))
    throw bad(`There is already a ${what} called "${name}" on this team. Choose another name. Nothing was saved.`);
  return name;
}

/** The base words, for the API description. */
export const BASES = BASE_WORDS;

// ---- Groups of members -------------------------------------------------------------------------------------------

/** The ids of the groups of members one person is in, in one account. */
export const inGroups = (accountId: string, userId: string): string[] =>
  all('SELECT g.id FROM member_group_people gp JOIN member_groups g ON g.id=gp.group_id WHERE g.account_id=? AND gp.user_id=?', accountId, userId).map((r) => r.id as string);
