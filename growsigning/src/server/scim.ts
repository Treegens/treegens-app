// Members from your directory (SCIM 2.0, RFC 7643 and 7644): an organisation's directory (Okta, Microsoft Entra ID,
// Google, OneLogin and the like) adds people to the account and takes them out again. The card is "Members from your
// directory" under Settings, Security (src/components/settings/OrgDirectory.tsx); the routes are routes-scim.ts.
//
//   It needs single sign-on first: the account's sign-in service (OpenID Connect or SAML, orgsso.ts) must have been
//   tried with success, and only addresses at the account's claimed email domains are taken. The account proved with
//   DNS that it speaks for those addresses, so its directory may add them; nobody else can be added this way.
//
//   One bearer token per account, shown once when made and kept only as its SHA-256 (org_directory). A new one
//   replaces the old at once.
//
//   What the directory says, and what it does here:
//     - a person is added (POST /Users, or "active" true again): someone with a GrowSigning login at that address
//       becomes a Member at once and is emailed; someone without one becomes a Member the first time they sign in
//       through the account's service (routes-orgsso.ts asks directoryWaiting). Nobody is made an admin this way, and
//       a member's role is never changed by the directory.
//     - a person is switched off (PATCH "active" false, PUT with active false) or deleted (DELETE /Users/<id>): they
//       are removed from the team the way an admin removing them by hand is (routes-account.ts): what they sent passes
//       to the person the admins chose on the card, or to the owner; their API keys stop; their browsers in this
//       account are signed out; they and the admins are emailed; the security record says it was the directory.
//       The directory can remove admins too, so only the owner or someone with the built-in Admin role may make its
//       token or change the card (routes-scim.ts mayRunDirectory): a role an admin made, which can do less, may not.
//     - the owner is never removed by the directory: that answers 409 and changes nothing (also when the directory
//       first sends the owner switched off: nothing is kept then).
//   With "Members are managed by your directory" on, nobody invites people by hand (POST /account/invites says so).
//
// Not here: groups (/Groups answers 404), bulk requests, filters other than userName eq "..." and externalId eq
// "...", sorting, changing a person's userName (answers 400: remove and add them again in the directory), and
// passwords (people sign in through the organisation's service).
import { all, get, run, tx } from './db.ts';
import { bad, id, now, token, sha256, baseUrl, isEmail } from './util.ts';
import { record } from './seclog.ts';
import { sendMail } from './mail.ts';
import { handOver, keyList } from './routes-trust.ts';
import { ssoAvailable } from './orgsso.ts';
import { domainOf } from '../lib/orgsso.ts';
import { SCIM_BASE_PATH, SCIM_TOKEN_PREFIX, SCIM_PAGE_MAX } from '../lib/samlscim.ts';
import { SOURCE_LOCALE, t, type Vars } from '../lib/i18n.ts';
import type { Ctx } from './router.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SYSTEM = { type: 'system' as const };
const DIRECTORY_ACTOR = { name: 'Your directory (SCIM)' };

/** A refusal in the form SCIM clients read: status, scimType and detail (in words for the admin who reads logs). */
export class ScimError extends Error {
  status: number;
  scimType?: string;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}
export const scimErrorBody = (e: ScimError) => ({ schemas: [ERROR], status: String(e.status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: e.message });

// ---- The card ----------------------------------------------------------------------------------------------------

const dirRow = (accountId: string) => get('SELECT * FROM org_directory WHERE account_id=?', accountId);
/** The directory may only be set up once single sign-on works: the service was tried and the server can keep it. */
export const directoryOffered = (accountId: string): boolean => ssoAvailable() && !!get('SELECT tested_at FROM org_idps WHERE account_id=?', accountId)?.tested_at;
/**
 * "Members are managed by your directory": invitations by hand are stopped. Only while a token exists and the
 * directory works: once single sign-on is removed or stops working, the directory is paused and invitations by hand
 * come back by themselves, so nobody is left with no way to add a person.
 */
export const directoryManaged = (accountId: string): boolean => {
  const r = dirRow(accountId);
  return !!r?.token_hash && !!r?.managed && directoryOffered(accountId);
};

/** For POST /account/invites (routes-account.ts). */
export function invitesAllowed(accountId: string) {
  if (directoryManaged(accountId)) throw bad(say('directory.err.invites_off'), 409, { code: 'managed_by_directory' });
}

/** For routes-orgsso.ts: someone the directory added, who has no membership yet, joins on their first sign-in. */
export function directoryWaiting(accountId: string, email: string): boolean {
  if (!dirRow(accountId)?.token_hash) return false;
  return !!get('SELECT 1 x FROM scim_users WHERE account_id=? AND user_name=? AND active=1', accountId, String(email || '').toLowerCase());
}

export function directoryView(accountId: string) {
  const r = dirRow(accountId);
  const heir = r?.heir_id ? get('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', accountId, r.heir_id) : null;
  return {
    offered: directoryOffered(accountId),
    base_url: `${baseUrl()}${SCIM_BASE_PATH}`,
    token: r?.token_hash ? { prefix: r.token_prefix, made_at: r.made_at, made_by: r.made_by ? get('SELECT name FROM users WHERE id=?', r.made_by)?.name || null : null, last_used_at: r.last_used_at || null } : null,
    managed: !!r?.token_hash && !!r?.managed,
    heir: heir ? { id: heir.id, name: heir.name } : null,
    people: Number(get('SELECT COUNT(*) n FROM scim_users WHERE account_id=? AND active=1', accountId)?.n || 0),
  };
}

/** Makes the account's token, replacing any before it. Answers it once; only its hash is kept. */
export function makeToken(c: Ctx): string {
  if (!directoryOffered(c.account.id)) throw bad(say('directory.err.sso_first'), 409, { code: 'sso_first' });
  const raw = `${SCIM_TOKEN_PREFIX}${token(32)}`;
  const was = dirRow(c.account.id);
  run(`INSERT INTO org_directory (account_id, token_hash, token_prefix, made_by, made_at, last_used_at) VALUES (?,?,?,?,?,NULL)
    ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash, token_prefix=excluded.token_prefix, made_by=excluded.made_by, made_at=excluded.made_at, last_used_at=NULL`,
    c.account.id, sha256(raw), raw.slice(0, SCIM_TOKEN_PREFIX.length + 6), c.user.id, now());
  record('directory.token_made', { c, details: { replaced: !!was?.token_hash } });
  return raw;
}

/** Stops the directory: the token no longer works and invitations by hand come back. Members stay members. */
export function removeToken(c: Ctx) {
  const was = dirRow(c.account.id);
  if (!was?.token_hash) throw bad(say('directory.err.no_token'), 404);
  run('UPDATE org_directory SET token_hash=NULL, token_prefix=NULL, managed=0 WHERE account_id=?', c.account.id);
  record('directory.token_removed', { c });
}

/** "Members are managed by your directory" and who takes over what a removed member sent. */
export function setDirectory(c: Ctx, b: any) {
  const was = dirRow(c.account.id);
  if (!was?.token_hash) throw bad(say('directory.err.no_token'), 404);
  const managed = b.managed === undefined ? !!was.managed : b.managed;
  if (typeof managed !== 'boolean') throw bad(say('directory.err.switch_form'), 400, { field: 'managed' });
  let heir: string | null = was.heir_id || null;
  if (b.heir_id !== undefined) {
    heir = b.heir_id === null || b.heir_id === '' ? null : String(b.heir_id);
    if (heir && !get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=? AND u.closing_at IS NULL', c.account.id, heir))
      throw bad(say('directory.err.heir_gone'), 400, { field: 'heir_id' });
  }
  run('UPDATE org_directory SET managed=?, heir_id=? WHERE account_id=?', managed ? 1 : 0, heir, c.account.id);
  record('directory.changed', { c, details: { managed_by_directory: { from: !!was.managed, to: managed }, ...(heir !== (was.heir_id || null) ? { takes_over: heir ? 'chosen_member' : 'owner' } : {}) } });
  return directoryView(c.account.id);
}

// ---- The directory's calls -----------------------------------------------------------------------------------------

/** The account a directory token belongs to. A wrong, missing or stopped token is refused the same way. */
export function accountOfToken(req: Request): string {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.get('authorization') || '').trim());
  const raw = m?.[1] || '';
  const r = raw.startsWith(SCIM_TOKEN_PREFIX) ? get('SELECT * FROM org_directory WHERE token_hash=?', sha256(raw)) : null;
  const a = r ? get('SELECT id, closing_at FROM accounts WHERE id=?', r.account_id) : null;
  if (!r || !a) throw new ScimError(401, 'This token is not known here. It was replaced, removed, or not copied in full. An admin can make a new one under Settings, Security, Members from your directory.');
  if (a.closing_at) throw new ScimError(403, 'This account is being closed, so its directory cannot change who is in it. Nothing was changed.');
  if (!directoryOffered(a.id)) throw new ScimError(403, 'Single sign-on is not working for this account just now, so the directory is paused. An admin can check it under Settings, Security, Single sign-on. Nothing was changed.');
  run('UPDATE org_directory SET last_used_at=? WHERE account_id=?', now(), a.id);
  return a.id;
}

const claimed = (accountId: string, email: string) => !!get('SELECT 1 x FROM org_domains WHERE account_id=? AND domain=? AND verified_at IS NOT NULL AND lost_at IS NULL', accountId, domainOf(email));

/** A person as SCIM shows them. Whether they are a member is read from the team, never kept apart. */
function resource(r: any) {
  const formatted = [r.given_name, r.family_name].filter(Boolean).join(' ');
  return {
    schemas: [USER], id: r.id, ...(r.external_id ? { externalId: r.external_id } : {}), userName: r.user_name,
    name: { ...(r.given_name ? { givenName: r.given_name } : {}), ...(r.family_name ? { familyName: r.family_name } : {}), ...(formatted ? { formatted } : {}) },
    ...(r.display_name ? { displayName: r.display_name } : {}),
    emails: [{ value: r.user_name, primary: true, type: 'work' }], active: !!r.active,
    meta: { resourceType: 'User', created: r.created_at, lastModified: r.updated_at, location: `${baseUrl()}${SCIM_BASE_PATH}/Users/${r.id}` },
  };
}
const rowOf = (accountId: string, userId: string) => get('SELECT * FROM scim_users WHERE id=? AND account_id=?', userId, accountId);
const mustRow = (accountId: string, userId: string) => {
  const r = rowOf(accountId, userId);
  if (!r) throw new ScimError(404, 'No person with this id is known for this account. Nothing was changed.');
  return r;
};

const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '');
/** SCIM booleans arrive as true and false, and from some directories as "True" and "False". */
function truth(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  return undefined;
}
/** The fields we keep from a User body. userName is the address; emails[primary] is used when userName is not one. */
function fieldsOf(b: any) {
  const primary = Array.isArray(b?.emails) ? b.emails.find((e: any) => e?.primary && isEmail(e?.value)) || b.emails.find((e: any) => isEmail(e?.value)) : null;
  const userName = text(b?.userName, 254).toLowerCase();
  const email = isEmail(userName) ? userName : primary ? String(primary.value).trim().toLowerCase() : '';
  return {
    email, external_id: text(b?.externalId, 200) || null, given_name: text(b?.name?.givenName) || null, family_name: text(b?.name?.familyName) || null,
    display_name: text(b?.displayName) || null, active: truth(b?.active),
  };
}
const nameFor = (r: any) => r.display_name || [r.given_name, r.family_name].filter(Boolean).join(' ') || r.user_name.split('@')[0];

/** Makes what the directory said true in the team: a member when active, removed when not. */
async function settle(accountId: string, r: any) {
  const u = get('SELECT * FROM users WHERE email=?', r.user_name);
  if (!u) {
    // No login yet: they join on their first sign-in through the service. A waiting invitation from before goes.
    if (!r.active) run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', accountId, r.user_name);
    return;
  }
  const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', accountId, u.id);
  if (r.active && !m) await addMember(accountId, u);
  if (!r.active && m) await removeMember(accountId, u, m.role);
}

async function addMember(accountId: string, u: any) {
  if (u.closing_at) return;
  const a = get('SELECT name FROM accounts WHERE id=?', accountId);
  const added = tx(() => {
    if (!run("INSERT OR IGNORE INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", accountId, u.id, now()).changes) return false;
    run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', accountId, u.email);
    record('member.joined', { by: SYSTEM, accounts: accountId, about: ['user', u.id], details: { role: 'member', by_directory: true } });
    return true;
  });
  if (!added) return;
  const service = get('SELECT name FROM org_idps WHERE account_id=?', accountId)?.name || '';
  await sendMail({ to: u.email, about: u.id, subject: say('directory.mail.added.subject', { account: a?.name || '' }), heading: say('directory.mail.added.heading', { account: a?.name || '' }),
    lines: [say('directory.mail.added.line1', { account: a?.name || '' }), say('directory.mail.added.line2', { name: service })],
    cta: { label: say('directory.mail.added.cta'), url: `${baseUrl()}/login` } }).catch((e) => console.error('[scim] could not email an added member', e?.message));
}

/**
 * Takes someone out of the team the way DELETE /account/members/<id> does (routes-account.ts), with the directory as
 * the one who did it. The owner is never removed.
 */
async function removeMember(accountId: string, u: any, role: string) {
  if (role === 'owner') throw new ScimError(409, 'This person owns the account, so the directory cannot remove them. The owner can hand the account to someone else first (Settings, Team, Make owner). Nothing was changed.', 'mutability');
  const a = get('SELECT name FROM accounts WHERE id=?', accountId);
  const owner = get("SELECT user_id FROM memberships WHERE account_id=? AND role='owner'", accountId)?.user_id;
  const chosen = dirRow(accountId)?.heir_id;
  const heirOk = chosen && chosen !== u.id && get('SELECT 1 x FROM memberships m JOIN users x ON x.id=m.user_id WHERE m.account_id=? AND m.user_id=? AND x.closing_at IS NULL', accountId, chosen);
  const successor = heirOk ? chosen : owner;
  const keys = all('SELECT id, name, prefix, scope, last_used_at FROM api_keys WHERE account_id=? AND user_id=? AND stopped_at IS NULL', accountId, u.id);
  const admins = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin') AND m.user_id!=?", accountId, u.id);
  const handed = tx(() => {
    const n = handOver(accountId, { id: u.id, name: u.name, email: u.email }, successor, DIRECTORY_ACTOR, `${u.name} was removed by your directory`);
    run('DELETE FROM memberships WHERE account_id=? AND user_id=?', accountId, u.id);
    run('DELETE FROM sessions WHERE account_id=? AND user_id=?', accountId, u.id);
    run('UPDATE api_keys SET stopped_at=? WHERE account_id=? AND user_id=? AND stopped_at IS NULL', now(), accountId, u.id);
    record('member.removed', { by: SYSTEM, accounts: accountId, about: ['user', u.id], details: { role, keys_stopped: keys.length, handed_over: n, handed_to: successor, by_directory: true } });
    return n;
  });
  const heir = get('SELECT name FROM users WHERE id=?', successor)?.name || '';
  if (keys.length)
    for (const x of admins)
      await sendMail({ to: x.email, about: u.id, subject: say('directory.mail.keys.subject', { person: u.name, account: a?.name || '' }), heading: say('directory.mail.keys.heading'),
        lines: [say('directory.mail.keys.line1', { person: u.name, account: a?.name || '' }), keyList(keys), say('directory.mail.keys.line2')],
        cta: { label: say('directory.mail.keys.cta'), url: `${baseUrl()}/app/settings?tab=developers` } }).catch((e) => console.error('[scim] could not email admins', e?.message));
  await sendMail({ to: u.email, subject: say('directory.mail.removed.subject', { account: a?.name || '' }), heading: say('directory.mail.removed.heading', { account: a?.name || '' }),
    lines: [say('directory.mail.removed.line1', { account: a?.name || '' }), handed ? say('directory.mail.removed.handed', { heir }) : say('directory.mail.removed.nothing'), say('directory.mail.removed.line3', { account: a?.name || '' })],
    cta: { label: say('directory.mail.removed.cta'), url: `${baseUrl()}/login` } }).catch((e) => console.error('[scim] could not email a removed member', e?.message));
}

export async function createUser(accountId: string, b: any) {
  const f = fieldsOf(b);
  if (!f.email) throw new ScimError(400, 'userName must be the person\'s email address (or emails must hold one). Nothing was added.', 'invalidValue');
  if (!claimed(accountId, f.email)) throw new ScimError(400, `${domainOf(f.email) || 'This domain'} is not one of this account's claimed email domains, so this person cannot be added from the directory. An admin can claim the domain under Settings, Security, Single sign-on. Nothing was added.`, 'invalidValue');
  if (get('SELECT 1 x FROM scim_users WHERE account_id=? AND user_name=?', accountId, f.email)) throw new ScimError(409, 'A person with this userName is already known for this account. Use their id to change them. Nothing was added.', 'uniqueness');
  // The owner sent switched off: refused before anything is kept, so a retry gets the same answer.
  if (f.active === false && get("SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email=? AND m.role='owner'", accountId, f.email))
    throw new ScimError(409, 'This person owns the account, so the directory cannot switch them off. The owner can hand the account to someone else first (Settings, Team, Make owner). Nothing was added.', 'mutability');
  const t = now();
  const r = { id: id('scim'), account_id: accountId, user_name: f.email, external_id: f.external_id, given_name: f.given_name, family_name: f.family_name, display_name: f.display_name, active: f.active === false ? 0 : 1, created_at: t, updated_at: t };
  run('INSERT INTO scim_users (id, account_id, user_name, external_id, given_name, family_name, display_name, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    r.id, accountId, r.user_name, r.external_id, r.given_name, r.family_name, r.display_name, r.active, t, t);
  record('directory.person_added', { by: SYSTEM, accounts: accountId, about: ['directory_person', r.id], details: { domain: domainOf(f.email), active: !!r.active } });
  await settle(accountId, r);
  return resource(r);
}

export const getUser = (accountId: string, userId: string) => resource(mustRow(accountId, userId));

/** GET /Users with the one filter directories use before adding someone: userName eq "..." (or externalId eq). */
export function listUsers(accountId: string, q: URLSearchParams) {
  const filter = (q.get('filter') || '').trim();
  let where = '', args: any[] = [];
  if (filter) {
    const m = /^(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i.exec(filter);
    if (!m) throw new ScimError(400, 'Only the filters userName eq "<address>" and externalId eq "<id>" are understood here.', 'invalidFilter');
    const value = m[2].replace(/\\(.)/g, '$1');
    where = m[1].toLowerCase() === 'username' ? ' AND user_name=?' : ' AND external_id=?';
    args = [m[1].toLowerCase() === 'username' ? value.toLowerCase() : value];
  }
  const start = Math.max(1, Math.floor(Number(q.get('startIndex')) || 1));
  const count = Math.min(SCIM_PAGE_MAX, Math.max(0, Math.floor(Number(q.get('count') ?? SCIM_PAGE_MAX)) || 0));
  const total = Number(get(`SELECT COUNT(*) n FROM scim_users WHERE account_id=?${where}`, accountId, ...args)?.n || 0);
  const rows = count ? all(`SELECT * FROM scim_users WHERE account_id=?${where} ORDER BY created_at, id LIMIT ? OFFSET ?`, accountId, ...args, count, start - 1) : [];
  return { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(resource) };
}

async function update(accountId: string, r: any, next: { email?: string; external_id?: string | null; given_name?: string | null; family_name?: string | null; display_name?: string | null; active?: boolean }) {
  if (next.email !== undefined && next.email !== r.user_name)
    throw new ScimError(400, 'The userName of a person cannot change here. To give them another address, remove them in the directory and add them again. Nothing was changed.', 'mutability');
  const was = !!r.active;
  const now2 = { ...r, ...Object.fromEntries(Object.entries(next).filter(([k, v]) => k !== 'email' && k !== 'active' && v !== undefined)), ...(next.active !== undefined ? { active: next.active ? 1 : 0 } : {}), updated_at: now() };
  // Switching someone off who owns the account is refused before anything is written.
  if (was && !now2.active) {
    const u = get('SELECT id FROM users WHERE email=?', r.user_name);
    if (u && get("SELECT 1 x FROM memberships WHERE account_id=? AND user_id=? AND role='owner'", accountId, u.id)) await removeMember(accountId, u, 'owner');
  }
  run('UPDATE scim_users SET external_id=?, given_name=?, family_name=?, display_name=?, active=?, updated_at=? WHERE id=?', now2.external_id, now2.given_name, now2.family_name, now2.display_name, now2.active, now2.updated_at, r.id);
  if (was !== !!now2.active) record(now2.active ? 'directory.person_added' : 'directory.person_removed', { by: SYSTEM, accounts: accountId, about: ['directory_person', r.id], details: { domain: domainOf(r.user_name), how: now2.active ? 'switched_on' : 'switched_off' } });
  await settle(accountId, now2);
  return resource(now2);
}

/** PUT: the whole person again. Fields left out are cleared, as the standard says; active left out stays as it is. */
export async function replaceUser(accountId: string, userId: string, b: any) {
  const r = mustRow(accountId, userId);
  const f = fieldsOf(b);
  return update(accountId, r, { email: f.email || undefined, external_id: f.external_id, given_name: f.given_name, family_name: f.family_name, display_name: f.display_name, active: f.active });
}

/** PATCH with Operations: replace or add on active, name, displayName, externalId (with or without a path). */
export async function patchUser(accountId: string, userId: string, b: any) {
  const r = mustRow(accountId, userId);
  if (!Array.isArray(b?.Operations) || (Array.isArray(b?.schemas) && !b.schemas.includes(PATCH))) throw new ScimError(400, 'Send a PatchOp with a list of Operations.', 'invalidSyntax');
  const next: any = {};
  const put = (path: string, v: any) => {
    const p = path.toLowerCase();
    if (p === 'active') {
      const a = truth(v);
      if (a === undefined) throw new ScimError(400, '"active" is true or false. Nothing was changed.', 'invalidValue');
      next.active = a;
    } else if (p === 'displayname') next.display_name = text(v) || null;
    else if (p === 'externalid') next.external_id = text(v, 200) || null;
    else if (p === 'name.givenname') next.given_name = text(v) || null;
    else if (p === 'name.familyname') next.family_name = text(v) || null;
    else if (p === 'name' && v && typeof v === 'object') {
      if ('givenName' in v) next.given_name = text(v.givenName) || null;
      if ('familyName' in v) next.family_name = text(v.familyName) || null;
    } else if (p === 'username') {
      const e = text(v, 254).toLowerCase();
      if (e !== r.user_name) next.email = e;
    }
    // Anything else (title, phone numbers, the enterprise extension) is not kept, and is not an error.
  };
  for (const op of b.Operations.slice(0, 50)) {
    const kind = String(op?.op || '').toLowerCase();
    if (kind !== 'replace' && kind !== 'add' && kind !== 'remove') throw new ScimError(400, `"${String(op?.op).slice(0, 20)}" is not an operation. Use add, replace or remove.`, 'invalidSyntax');
    if (kind === 'remove') {
      if (typeof op.path === 'string') put(op.path, op.path.toLowerCase() === 'active' ? false : '');
      continue;
    }
    if (typeof op.path === 'string' && op.path) put(op.path, op.value);
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value)) put(k, v);
  }
  return update(accountId, r, next);
}

export async function deleteUser(accountId: string, userId: string) {
  const r = mustRow(accountId, userId);
  const u = get('SELECT * FROM users WHERE email=?', r.user_name);
  const m = u ? get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', accountId, u.id) : null;
  if (m) await removeMember(accountId, u, m.role);
  run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', accountId, r.user_name);
  run('DELETE FROM scim_users WHERE id=?', r.id);
  record('directory.person_removed', { by: SYSTEM, accounts: accountId, about: ['directory_person', r.id], details: { domain: domainOf(r.user_name), how: 'deleted' } });
}

/** What this server supports, for directories that ask before they start. */
export const serviceProviderConfig = () => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: `${baseUrl()}/api/docs`,
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: SCIM_PAGE_MAX },
  changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The token made under Settings, Security, Members from your directory.', primary: true }],
  meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl()}${SCIM_BASE_PATH}/ServiceProviderConfig` },
});

