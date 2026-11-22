// Organisations above accounts: one deployment for a whole government, where each ministry or agency has its own
// account and a central team sets rules and sees counts without reading anyone's documents.
//
//   orgs          a name, a parent (a government, then a ministry, then an agency's department...), the rules it
//                 passes down (src/lib/orgs.ts) and whether emergency access to a document is allowed (break_glass,
//                 which only the operator switches on).
//   org_admins    people with rights over an organisation and everything below it.
//   accounts.org_id  the organisation an account sits in.
//
// The rules are floors. When an organisation sets one, every account below it is brought up to it at once, in the
// columns the account's own settings already use (two_step_required_at, min_password_length, idle_minutes,
// one_session, impact_display, ai_helper), so every reader of those columns keeps the rule without knowing about
// organisations. An account can then ask for more, never for less: the screens that change them ask refuseLoosening()
// first. When an organisation takes a rule away, each account gets back what it had before the rule (accounts.org_raised),
// unless it changed that setting itself since; nothing goes below what is still asked above it.
//
// What an organisation admin can never do: open an account's documents, comments, field values or templates. They
// are not members of the accounts below, and nothing here makes them one (an admin of an organisation cannot be named
// owner or admin of an account below it). The one way to a document is emergency access, only where the operator
// allowed it, with a reason, the owners of the account told at once, and a line in the account's security record.
import { all, get, run, tx } from './db.ts';
import { bad, now, id, HttpError } from './util.ts';
import { record } from './seclog.ts';
import type { Ctx } from './router.ts';
import { ORG_POLICY_KEYS, ORG_POLICY_WORDS, ORG_MAX_DEPTH, cleanPolicy, tighter, looser, setByWords, lowerFirst, type OrgPolicy, type OrgPolicyKey } from '../lib/orgs.ts';
import { PASSWORD_MIN } from '../lib/signinrules.ts';

export type Org = { id: string; name: string; parent_id: string | null; policy: OrgPolicy; break_glass: boolean; created_at: string };

const asOrg = (r: any): Org | null => (r ? { id: r.id, name: r.name, parent_id: r.parent_id || null, policy: cleanPolicy(r.policy), break_glass: !!r.break_glass, created_at: r.created_at } : null);
export const orgById = (orgId: string | null | undefined): Org | null => (orgId ? asOrg(get('SELECT * FROM orgs WHERE id=?', orgId)) : null);

/** The organisation and every one above it, the top first. Stops at ORG_MAX_DEPTH + 1, so a loop can never hang. */
export function chain(orgId: string | null | undefined): Org[] {
  const out: Org[] = [];
  let at = orgById(orgId);
  while (at && out.length <= ORG_MAX_DEPTH && !out.some((o) => o.id === at!.id)) {
    out.unshift(at);
    at = orgById(at.parent_id);
  }
  return out;
}

/** The ids of this organisation and every one below it. */
export function subtree(orgId: string): string[] {
  const out = [orgId];
  for (let i = 0; i < out.length && out.length < 10_000; i++) for (const r of all('SELECT id FROM orgs WHERE parent_id=?', out[i])) if (!out.includes(r.id)) out.push(r.id);
  return out;
}

/** Every account in this organisation or below it. */
export const accountsBelow = (orgId: string): string[] => {
  const ids = subtree(orgId);
  return all(`SELECT id FROM accounts WHERE org_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`, ...ids).map((r) => r.id as string);
};

/** Is this person an admin of the organisation, or of one above it? */
export const isOrgAdminOf = (userId: string | null | undefined, orgId: string | null | undefined): boolean =>
  !!userId && !!orgId && chain(orgId).some((o) => !!get('SELECT 1 x FROM org_admins WHERE org_id=? AND user_id=?', o.id, userId));

/** The organisations this person administers directly (each with everything below it). */
export const adminOrgs = (userId: string | null | undefined): Org[] =>
  userId ? (all('SELECT o.* FROM org_admins a JOIN orgs o ON o.id=a.org_id WHERE a.user_id=? ORDER BY o.name', userId).map(asOrg) as Org[]) : [];

/** Is this person an organisation admin above this account? */
export const isOrgAdminOverAccount = (userId: string | null | undefined, accountId: string): boolean =>
  isOrgAdminOf(userId, get('SELECT org_id FROM accounts WHERE id=?', accountId)?.org_id);

/** The organisation an account is in, or null. */
export const orgOfAccount = (accountId: string | null | undefined): Org | null => (accountId ? orgById(get('SELECT org_id FROM accounts WHERE id=?', accountId)?.org_id) : null);

// ---- Rules passed down ------------------------------------------------------------------------------------------

export type Floor = { policy: OrgPolicy; from: Partial<Record<OrgPolicyKey, string>> };

/** What the organisations of this chain ask together, and which of them asked each rule (the highest one that asked
 * the tightest value). `skip` leaves one organisation out: for what is asked above it. */
export function floorOfChain(orgs: Org[], skip?: string): Floor {
  const out: Floor = { policy: {}, from: {} };
  for (const o of orgs) {
    if (o.id === skip) continue;
    for (const k of ORG_POLICY_KEYS) {
      const v = o.policy[k];
      if (v === undefined) continue;
      const was = out.policy[k];
      const t = tighter(k, was as any, v as any);
      if (t !== was) {
        (out.policy as any)[k] = t;
        out.from[k] = o.name;
      }
    }
  }
  return out;
}

/** What an account must have at least. */
export const floorForAccount = (accountId: string | null | undefined): Floor => floorOfChain(chain(orgOfAccount(accountId)?.id));

/** For each rule an organisation decided for this account: "Set by Ministry of Health". For the screens. */
export function setByFor(accountId: string | null | undefined): Partial<Record<OrgPolicyKey, string>> {
  const f = floorForAccount(accountId);
  return Object.fromEntries(Object.entries(f.from).map(([k, name]) => [k, setByWords(name!)]));
}

/** `{ set_by }` for a view, or nothing at all for an account no organisation decided anything for. */
export function setByField(accountId: string | null | undefined): { set_by?: Partial<Record<OrgPolicyKey, string>> } {
  const s = setByFor(accountId);
  return Object.keys(s).length ? { set_by: s } : {};
}

/** The account's own value of each rule, read from the columns its settings use. "No tree lines" covers the signing
 * record too (accounts.cert_impact_off): the owner's answer keeps trees off the record of government tenants. */
function accountValues(a: any): OrgPolicy {
  const out: OrgPolicy = {};
  if (a.two_step_required_at) out.two_step_required = true;
  if (Number(a.min_password_length) > PASSWORD_MIN) out.min_password_length = Number(a.min_password_length);
  if (Number(a.idle_minutes) > 0) out.idle_minutes = Number(a.idle_minutes);
  if (a.one_session) out.one_session = true;
  if (a.impact_display === 'off' && a.cert_impact_off) out.impact_display = 'off';
  if (a.ai_helper === 'off') out.ai_helper = 'off';
  return out;
}

type Raised = Partial<Record<OrgPolicyKey, { was: any; set: any; cert_was?: number }>>;
const raisedOf = (a: any): Raised => {
  try {
    const v = JSON.parse(a?.org_raised || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** Who did it, for a line an organisation's rule wrote in an account's record. */
const byOf = (by?: { c?: Ctx | null; operator?: string | null }) => (by?.operator ? { type: 'operator' as const, id: by.operator } : by?.c ? undefined : { type: 'system' as const });

/**
 * Brings one account up to what is asked above it. Answers which rules changed. Each change is a line in the
 * account's security record, saying which organisation asked it. Never loosens anything. What the account had before
 * is kept (accounts.org_raised), so that it gets it back when the organisation takes the rule away (restoreFloor).
 */
export function applyFloor(accountId: string, by?: { c?: Ctx | null; operator?: string | null }): OrgPolicyKey[] {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a) return [];
  const f = floorForAccount(accountId);
  const own = accountValues(a);
  const raised = raisedOf(a);
  const changed: OrgPolicyKey[] = [];
  const t = now();
  for (const k of ORG_POLICY_KEYS) {
    const want = f.policy[k];
    if (want === undefined || !looser(k, own[k] as any, want as any)) continue;
    changed.push(k);
    // The value before the first organisation rule stays the one given back; `set` is what is there now.
    const was = raised[k] ? raised[k]!.was : k === 'two_step_required' ? a.two_step_required_at || null : k === 'min_password_length' ? a.min_password_length ?? null : k === 'idle_minutes' ? a.idle_minutes ?? null : k === 'one_session' ? a.one_session || 0 : k === 'impact_display' ? a.impact_display ?? null : a.ai_helper ?? null;
    let set: any = want;
    if (k === 'two_step_required') (set = t), run('UPDATE accounts SET two_step_required_at=? WHERE id=?', t, accountId);
    else if (k === 'min_password_length') run('UPDATE accounts SET min_password_length=? WHERE id=?', want, accountId);
    else if (k === 'idle_minutes') run('UPDATE accounts SET idle_minutes=?, idle_since=? WHERE id=?', want, t, accountId);
    else if (k === 'one_session') (set = 1), run('UPDATE accounts SET one_session=1 WHERE id=?', accountId);
    else if (k === 'impact_display') run("UPDATE accounts SET impact_display='off', cert_impact_off=1 WHERE id=?", accountId);
    else if (k === 'ai_helper') run("UPDATE accounts SET ai_helper='off' WHERE id=?", accountId);
    raised[k] = { was, set, ...(k === 'impact_display' ? { cert_was: raised[k]?.cert_was ?? (a.cert_impact_off ? 1 : 0) } : {}) };
  }
  if (changed.length) {
    run('UPDATE accounts SET org_raised=? WHERE id=?', JSON.stringify(raised), accountId);
    // The record never keeps a detail whose name says password (seclog.ts): the shortest password is "min_length"
    // there, as in the account's own line when its admins change it (secpolicy.ts).
    const settings = Object.fromEntries(changed.map((k) => [k === 'min_password_length' ? 'min_length' : k, { from: own[k] ?? null, to: f.policy[k], set_by: f.from[k] }]));
    record('settings.changed', { c: by?.c, by: byOf(by), accounts: accountId, about: ['account', accountId], details: { settings, by_organisation: true, organisation: [...new Set(changed.map((k) => f.from[k]))].join(', '), by_name: by?.operator ? null : by?.c?.user?.name || null } });
  }
  return changed;
}

/**
 * Gives an account back what it had before an organisation's rule, for each rule no organisation above it asks any
 * more, unless the account changed that setting itself since (then its own choice stays). Answers which rules were
 * given back; each is a line in the account's security record.
 */
export function restoreFloor(accountId: string, by?: { c?: Ctx | null; operator?: string | null }, leaving?: string): OrgPolicyKey[] {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a) return [];
  const raised = raisedOf(a);
  if (!Object.keys(raised).length) return [];
  const f = floorForAccount(accountId);
  const back: OrgPolicyKey[] = [];
  const settings: Record<string, unknown> = {};
  for (const k of Object.keys(raised) as OrgPolicyKey[]) {
    if (!(ORG_POLICY_KEYS as string[]).includes(k) || f.policy[k] !== undefined) continue;
    const r = raised[k]!;
    delete raised[k];
    const now_ = k === 'two_step_required' ? a.two_step_required_at : k === 'min_password_length' ? a.min_password_length : k === 'idle_minutes' ? a.idle_minutes : k === 'one_session' ? a.one_session : k === 'impact_display' ? a.impact_display : a.ai_helper;
    // Changed by the account itself since: its own choice stays.
    if (String(now_ ?? '') !== String(r.set ?? '')) continue;
    if (k === 'two_step_required') run('UPDATE accounts SET two_step_required_at=? WHERE id=?', r.was || null, accountId);
    else if (k === 'min_password_length') run('UPDATE accounts SET min_password_length=? WHERE id=?', r.was ?? null, accountId);
    else if (k === 'idle_minutes') run('UPDATE accounts SET idle_minutes=? WHERE id=?', r.was ?? null, accountId);
    else if (k === 'one_session') run('UPDATE accounts SET one_session=? WHERE id=?', r.was ? 1 : 0, accountId);
    else if (k === 'impact_display') run('UPDATE accounts SET impact_display=?, cert_impact_off=? WHERE id=?', r.was ?? null, r.cert_was ? 1 : 0, accountId);
    else if (k === 'ai_helper') run('UPDATE accounts SET ai_helper=? WHERE id=?', r.was ?? null, accountId);
    back.push(k);
    settings[k === 'min_password_length' ? 'min_length' : k] = { from: r.set === undefined ? null : k === 'two_step_required' || k === 'one_session' ? true : r.set, to: k === 'two_step_required' ? !!r.was : k === 'one_session' ? !!r.was : r.was ?? null };
  }
  run('UPDATE accounts SET org_raised=? WHERE id=?', Object.keys(raised).length ? JSON.stringify(raised) : null, accountId);
  if (back.length) record('settings.changed', { c: by?.c, by: byOf(by), accounts: accountId, about: ['account', accountId], details: { settings, given_back: true, by_organisation: true, organisation: leaving || orgOfAccount(accountId)?.name || null, by_name: by?.operator ? null : by?.c?.user?.name || null } });
  return back;
}

/** Gives back, in every account below this organisation, what a rule it no longer asks had raised. */
export function restoreBelow(orgId: string, by?: { c?: Ctx | null; operator?: string | null }): number {
  let n = 0;
  const name = orgById(orgId)?.name;
  for (const accountId of accountsBelow(orgId)) if (restoreFloor(accountId, by, name).length) n++;
  return n;
}

// ---- Who may run an account below an organisation ---------------------------------------------------------------

/**
 * An admin of an organisation is never an owner or admin of an account below it: that would be a way into its
 * documents that is not emergency access. Every path that makes someone an owner or admin asks this first (the
 * organisation's own routes, an invitation, accepting it, a role change, handing the account over), and the router
 * treats such a person as a member in case one slipped through (routes from before this rule).
 */
export function refuseOrgAdminRole(accountId: string, userId: string | null | undefined, role: string): void {
  if (role !== 'owner' && role !== 'admin') return;
  if (!userId || !isOrgAdminOverAccount(userId, accountId)) return;
  const u = get('SELECT name FROM users WHERE id=?', userId);
  const org = chain(orgOfAccount(accountId)?.id).find((o) => !!get('SELECT 1 x FROM org_admins WHERE org_id=? AND user_id=?', o.id, userId));
  throw new HttpError(409, `${u?.name || 'This person'} is an admin of ${org?.name || 'an organisation above this account'}, so they cannot also be an owner or admin here: that would let them read its documents. They can be a member, who sees only what they send. Choose someone who works here.`, { code: 'org_admin' });
}

/** True while the person is an owner or admin of an account but an organisation admin above it (the router's backstop). */
export const heldAsMember = (auth: { user?: any; account?: any; role?: string } | null | undefined): boolean =>
  !!auth?.account?.org_id && (auth.role === 'owner' || auth.role === 'admin') && isOrgAdminOverAccount(auth.user?.id, auth.account.id);

/** What GET /me says about the organisation above the account: who set the two-step rule, and sending switched off. */
export function orgMe(account: any): { org?: { name: string; two_step_by?: string; sending_off?: string } } {
  const org = orgOfAccount(account?.id);
  if (!org) return {};
  const f = floorForAccount(account.id);
  return { org: { name: org.name, ...(f.from.two_step_required ? { two_step_by: f.from.two_step_required } : {}), ...(account.org_sending_off_at ? { sending_off: orgSendingOffText(account)! } : {}) } };
}

/** Brings every account below this organisation up to what is asked of it. */
export function applyBelow(orgId: string, by?: { c?: Ctx | null; operator?: string | null }): number {
  let n = 0;
  for (const accountId of accountsBelow(orgId)) if (applyFloor(accountId, by).length) n++;
  return n;
}

/** The refusal when an account tries to ask for less than its organisations ask: two sentences, what and what to do. */
function loosenWords(key: OrgPolicyKey, floor: Floor): string {
  const who = floor.from[key]!;
  return `${who} asks this of every account below it: ${lowerFirst(ORG_POLICY_WORDS[key].on(floor.policy[key]))}. Choose that or stricter, or ask an admin of ${who} to change it. Nothing was changed.`;
}

/**
 * Throws when this change of an account's own settings would ask for less than its organisations ask. `change` has
 * the account's new values in the shape of OrgPolicy; a key set to null means "off" or "no rule", a key left out or undefined is not changed.
 */
export function refuseLoosening(accountId: string, change: Partial<Record<OrgPolicyKey, unknown>>): void {
  const floor = floorForAccount(accountId);
  for (const [k, v] of Object.entries(change)) {
    const key = k as OrgPolicyKey;
    // undefined: this change leaves the setting as it is.
    if (v === undefined || !(ORG_POLICY_KEYS as string[]).includes(key) || floor.policy[key] === undefined) continue;
    const value = v === null || v === false || v === 'on' ? undefined : v;
    if (looser(key, value as any, floor.policy[key] as any)) throw new HttpError(409, loosenWords(key, floor), { code: 'set_by_organisation', setting: key, set_by: floor.from[key] });
  }
}

/** The refusal when an organisation tries to ask for less than one above it already asks. */
export function refuseOrgLoosening(org: Org, next: OrgPolicy): void {
  const above = floorOfChain(chain(org.id), org.id);
  for (const k of ORG_POLICY_KEYS) {
    if (next[k] === undefined || above.policy[k] === undefined) continue;
    if (looser(k, next[k] as any, above.policy[k] as any))
      throw new HttpError(409, `${above.from[k]} already asks for more than that: ${lowerFirst(ORG_POLICY_WORDS[k].on(above.policy[k]))}. Choose that or stricter, or leave the rule to ${above.from[k]}. Nothing was changed.`, { code: 'set_by_organisation', setting: k, set_by: above.from[k] });
  }
}

// ---- Sending switched off by an organisation ---------------------------------------------------------------------

/** What every refused send says while an organisation switched sending off for an account, or null. */
export function orgSendingOffText(account: any): string | null {
  if (!account?.org_sending_off_at) return null;
  const who = account.org_sending_off_by || 'Your organisation';
  return `${who} switched sending off for ${account.name}. Nothing new is emailed from it until they switch it on again: people who already have a document can still open, sign and download it. Ask an admin of ${who} if this should change.`;
}

// ---- Record --------------------------------------------------------------------------------------------------------

/** One line in the organisation's own record, and, when the action touched an account, in that account's record. */
// `agencyOnly` goes into the account's own record and never into the organisation's: the title of a document opened
// with emergency access is for the agency, not for every admin of every organisation above it. The agency's name is
// in both, so a line on the organisation's page says which agency it was about.
export function orgEvent(orgId: string, kind: 'org.changed' | 'org.break_glass', o: { c?: Ctx | null; operator?: string | null; account?: string | null; details: Record<string, unknown>; agencyOnly?: Record<string, unknown> }) {
  const actor = o.operator ? { type: 'operator', id: o.operator } : o.c?.user ? { type: 'user', id: o.c.user.id } : { type: 'system', id: null };
  const org = orgById(orgId);
  const agencyId = o.account || (typeof o.details.agency === 'string' ? o.details.agency : null);
  const agencyName = agencyId ? get('SELECT name FROM accounts WHERE id=?', agencyId)?.name || null : null;
  const details = { organisation: org?.name || null, by_name: o.operator ? null : o.c?.user?.name || null, ...(agencyName ? { agency_name: agencyName } : {}), ...o.details };
  run('INSERT INTO org_events (org_id, at, actor_type, actor_id, kind, account_id, details) VALUES (?,?,?,?,?,?,?)', orgId, now(), actor.type, actor.id, kind, o.account || null, JSON.stringify(details));
  if (o.account) record(kind, { c: o.c, by: o.operator ? { type: 'operator', id: o.operator } : undefined, accounts: o.account, about: ['account', o.account], details: { ...details, ...(o.agencyOnly || {}) } });
}

// ---- Making and moving ----------------------------------------------------------------------------------------------

/** A name for an organisation or an agency: trimmed, one line, not empty. */
export function orgName(v: unknown, what: string): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) throw bad(`Type the name of the ${what}. Nothing was made.`);
  if (s.length > 120) throw bad(`The name of the ${what} can be at most 120 characters. Shorten it and try again.`);
  return s;
}

export function createOrg(name: string, parentId: string | null): Org {
  if (parentId) {
    const depth = chain(parentId).length;
    if (depth >= ORG_MAX_DEPTH) throw bad(`Organisations nest at most ${ORG_MAX_DEPTH} deep, and this one is already that deep. Put the new one higher up.`);
  }
  const orgId = id('org');
  run('INSERT INTO orgs (id, name, parent_id, created_at) VALUES (?,?,?,?)', orgId, name, parentId, now());
  return orgById(orgId)!;
}

/** Moves an account to another organisation (or out of all, with null), and brings it up to the rules there. */
export function moveAccount(accountId: string, toOrg: string | null, operator: string): { from: string | null; to: string | null } {
  const a = get('SELECT id, org_id FROM accounts WHERE id=?', accountId);
  if (!a) throw bad('There is no account with that id.', 404);
  if (toOrg && !orgById(toOrg)) throw bad('There is no organisation with that id.', 404);
  // Nobody who runs the account may be an admin of the organisation it goes into, or of one above it.
  if (toOrg) for (const m of all("SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId))
    if (isOrgAdminOf(m.id, toOrg)) throw bad(`${m.name} runs this account and is an admin of ${orgById(toOrg)!.name} or an organisation above it. Take one of the two roles away first, so nobody both reads its documents and has rights over it from above. Nothing was moved.`, 409, { code: 'org_admin' });
  tx(() => {
    run('UPDATE accounts SET org_id=? WHERE id=?', toOrg, accountId);
    // The rules of the organisation it leaves no longer hold: what they raised is given back, then the new ones apply.
    restoreFloor(accountId, { operator }, orgById(a.org_id)?.name);
    // One line in the account's record (under the organisation it is in now), one in each organisation's.
    if (a.org_id) orgEvent(a.org_id, 'org.changed', { operator, account: toOrg ? null : accountId, details: { what: 'agency_moved_out', agency: accountId, to: orgById(toOrg)?.name || null } });
    if (toOrg) orgEvent(toOrg, 'org.changed', { operator, account: accountId, details: { what: 'agency_moved_in', agency: accountId, from: orgById(a.org_id)?.name || null } });
    applyFloor(accountId, { operator });
  });
  return { from: a.org_id || null, to: toOrg };
}
