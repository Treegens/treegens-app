// Single sign-on for an organisation: its email domains, its own sign-in service (OpenID Connect), and the rule
// "everyone at these domains signs in through it". The screens are src/components/settings/OrgSso.tsx (Settings,
// Security) and the sign-in page (src/components/AuthForm.tsx); the routes are routes-orgsso.ts; talking to the
// service and checking its tokens is oidc.ts. The words are in src/lib/orgsso.ts and src/locales/en.json ("sso.*").
//
//   A domain is claimed by putting a TXT record at _growsigning.<domain> with a random value we made. Found once, the
//   domain is the account's: no other account can claim it while the record stands. It is looked at again once a day
//   (recheckDomains, from the timer); a record that is gone pauses single sign-on for that domain, says so on the card
//   and emails the admins, and comes back by itself when the record is found again. A DNS server that does not
//   answer just now changes nothing.
//
//   The sign-in service is an issuer, a client id and a client secret. The secret is only ever kept encrypted with
//   FILE_ENCRYPTION_KEY; without that key nothing of this feature exists (the card is not shown, the routes refuse).
//   Nothing changes on the sign-in page until an admin signed in through the service once with success ("Try a
//   sign-in"), and again after the issuer or the client id change.
//
//   With "Everyone at these domains signs in through <name>" on, a password, Google and Microsoft are refused for
//   every login whose address is at one of the domains, wherever that login is a member. The owner of the account
//   keeps one way back in, for the day the service breaks: their password, only with our own two-step login on, and
//   written to the security record each time it is used. Browsers of people at those domains stay signed in for at
//   most SSO_SESSION_HOURS (sessions.ends_by), so someone who leaves the organisation, and whose login there is
//   closed, is out of GrowSigning within that time.
//
// SAML 2.0 is the other kind of service (org_idps.kind 'saml'): saml.ts and routes-saml.ts. Members from a directory
// (SCIM) are scim.ts. Not here: sub-domains (a claim covers exactly the domain), and an OpenID Connect service that
// only works without a client secret.
import { promises as dns } from 'node:dns';
import { all, get, run, tx } from './db.ts';
import { bad, id, token, now, HttpError } from './util.ts';
import { record } from './seclog.ts';
import { keys } from './filestore.ts';
import { sealText, openText } from './searchtext.ts';
import { discover, forgetDiscovery, issuerUrl, DiscoveryProblem, type OrgProvider } from './oidc.ts';
import { lookHost } from './paydns.ts';
import { twoStepOn } from './twostep.ts';
import { sendMail } from './mail.ts';
import { cleanDomain, domainOf, txtName, TXT_VALUE_PREFIX, DOMAIN_CHECK_HOURS, DOMAINS_MAX, SSO_NAME_MAX, ssoHours } from '../lib/orgsso.ts';
import { SOURCE_LOCALE, t, type Vars } from '../lib/i18n.ts';
import type { Ctx } from './router.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);

/** The TXT lookup in use. It sits on an object so a test can answer for its own names. */
export const txt = { lookup: (name: string): Promise<string[][]> => dns.resolveTxt(name) };
const LOOKUP_MS = 5000;

/** Whether this server can keep a client secret: only with FILE_ENCRYPTION_KEY set. Without it the feature is absent. */
export const ssoAvailable = (): boolean => !!keys().current;

export { ssoHours };

// ---- Who signs in where ------------------------------------------------------------------------------------------

export type Rule = { accountId: string; name: string; enforce: boolean; domain: string; joinNew: boolean };

/**
 * The single sign-on that an email address goes to, or null: its domain is claimed by an account (the record was
 * found and is not lost), the domain is set to use the service, the service was tried with success, and this server
 * can open its secret.
 */
export function ssoFor(email: unknown): Rule | null {
  const domain = domainOf(email);
  if (!domain || !ssoAvailable()) return null;
  const r = get(`SELECT d.domain, d.account_id, i.name, i.enforce, i.join_new FROM org_domains d JOIN org_idps i ON i.account_id=d.account_id
    WHERE d.domain=? AND d.verified_at IS NOT NULL AND d.lost_at IS NULL AND d.use_sso=1 AND i.tested_at IS NOT NULL`, domain);
  return r ? { accountId: r.account_id, name: r.name, enforce: !!r.enforce, domain: r.domain, joinNew: !!r.join_new } : null;
}
/** The rule when it is "everyone signs in through it", else null. */
export const enforcedFor = (email: unknown): Rule | null => {
  const r = ssoFor(email);
  return r?.enforce ? r : null;
};
/** Whether this account has "everyone at these domains signs in through it" switched on. */
export const enforcing = (accountId: string): boolean => !!get('SELECT enforce FROM org_idps WHERE account_id=?', accountId)?.enforce;
const isOwner = (userId: string, accountId: string) => !!get("SELECT 1 x FROM memberships WHERE account_id=? AND user_id=? AND role='owner'", accountId, userId);

/** For createSession (auth.ts): the latest a new browser of this login stays in, or null for the usual time. */
export function sessionCap(userId: string): string | null {
  try {
    const u = get('SELECT email FROM users WHERE id=?', userId);
    return u && enforcedFor(u.email) ? new Date(Date.now() + ssoHours() * 3600_000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Called by POST /auth/login before the password is looked at. An address at an enforced domain is refused, unless
 * the page says this is the owner's way back in (`wayBack`); then the password is checked as usual and `afterPassword`
 * decides. Answers the rule when the way back is being used, else null.
 */
export function passwordAllowed(email: string, wayBack: boolean): Rule | null {
  const r = enforcedFor(email);
  if (!r) return null;
  const refused = () => new HttpError(403, say('sso.refused.password', { name: r.name, domain: r.domain }), { code: 'sso_required', sso: { name: r.name } });
  if (!wayBack) throw refused();
  // Only the owner has a way back. Anyone else is answered before the password is looked at, the same for a right and a
  // wrong one, so asking for the way back cannot be used to find a member's password out.
  const u = get('SELECT id FROM users WHERE email=?', email);
  if (!u || !isOwner(u.id, r.accountId)) throw refused();
  return r;
}

/** The accounts this login owns where everyone signs in through the service: their way back in needs two-step login. */
export function wayBackHeldBy(userId: string): { account: string; name: string }[] {
  if (!ssoAvailable()) return [];
  return all("SELECT a.name account, i.name FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN org_idps i ON i.account_id=m.account_id WHERE m.user_id=? AND m.role='owner' AND i.enforce=1 ORDER BY a.name", userId);
}
/** POST /me/two-step/off: refused while it is an owner's way back in. */
export function twoStepOffAllowed(userId: string) {
  const held = wayBackHeldBy(userId)[0];
  if (held) throw bad(say('sso.refused.two_step_off', { account: held.account, name: held.name }), 409, { code: 'sso_way_back' });
}
/** POST /account/transfer-owner: the new owner needs two-step login while everyone signs in through the service. */
export function handOverAllowed(accountId: string, toUserId: string) {
  if (!ssoAvailable()) return;
  const r = idpRow(accountId);
  if (!r?.enforce) return;
  const to = get('SELECT * FROM users WHERE id=?', toUserId);
  if (to && !twoStepOn(to)) throw bad(say('sso.refused.hand_over', { name: r.name, person: to.name }), 409, { code: 'sso_way_back' });
}
/** The password was right. Only the owner of the account that set the rule gets in, and only with two-step login on. */
export function afterPassword(c: Ctx, u: any, r: Rule) {
  if (!isOwner(u.id, r.accountId)) throw new HttpError(403, say('sso.refused.password', { name: r.name, domain: r.domain }), { code: 'sso_required', sso: { name: r.name } });
  if (!twoStepOn(u)) throw new HttpError(403, say('sso.refused.way_back_two_step', { name: r.name }), { code: 'sso_way_back_two_step' });
  record('sso.way_back', { c, by: { type: 'user', id: u.id }, accounts: r.accountId, about: ['user', u.id], details: { domain: r.domain } });
}
/** POST /auth/signup: no password login is made for an address at an enforced domain. */
export function signupAllowed(email: string) {
  const r = enforcedFor(email);
  if (r) throw new HttpError(403, say('sso.refused.signup', { name: r.name, domain: r.domain }), { code: 'sso_required', sso: { name: r.name } });
}

// ---- Domains -----------------------------------------------------------------------------------------------------

export const domainView = (d: any) => ({
  id: d.id, domain: d.domain, use_sso: !!d.use_sso, created_at: d.created_at, verified_at: d.verified_at || null, checked_at: d.checked_at || null, lost_at: d.lost_at || null,
  state: d.lost_at ? 'lost' : d.verified_at ? 'claimed' : 'waiting',
  record: { type: 'TXT', name: txtName(d.domain), value: `${TXT_VALUE_PREFIX}${d.value}` },
});

export function addDomain(c: Ctx, raw: unknown) {
  const domain = cleanDomain(raw);
  if (!domain) throw bad(say('sso.err.domain_form', { example: 'example.org' }), 400, { field: 'domain' });
  const mine = get('SELECT * FROM org_domains WHERE account_id=? AND domain=?', c.account.id, domain);
  if (mine) return domainView(mine);
  if ((get('SELECT COUNT(*) n FROM org_domains WHERE account_id=?', c.account.id)?.n || 0) >= DOMAINS_MAX) throw bad(say('sso.err.domains_max', { max: DOMAINS_MAX }), 400);
  // Held by another account whose record still stands: said as it is, without naming that account.
  if (get('SELECT 1 x FROM org_domains WHERE domain=? AND account_id!=? AND verified_at IS NOT NULL AND lost_at IS NULL', domain, c.account.id))
    throw bad(say('sso.err.domain_taken', { domain }), 409, { code: 'domain_taken' });
  const row = { id: id('dom'), domain, value: token(18) };
  run('INSERT INTO org_domains (id, account_id, domain, value, created_at) VALUES (?,?,?,?,?)', row.id, c.account.id, domain, row.value, now());
  record('sso.domain_added', { c, details: { domain } });
  return domainView(get('SELECT * FROM org_domains WHERE id=?', row.id));
}

export function removeDomain(c: Ctx, domainId: string) {
  const d = get('SELECT * FROM org_domains WHERE id=? AND account_id=?', domainId, c.account.id);
  if (!d) throw bad(say('sso.err.domain_gone'), 404);
  run('DELETE FROM org_domains WHERE id=?', d.id);
  record('sso.domain_removed', { c, details: { domain: d.domain } });
}

export function setDomainUse(c: Ctx, domainId: string, use: unknown) {
  if (typeof use !== 'boolean') throw bad(say('sso.err.use_form'), 400, { field: 'use_sso' });
  const d = get('SELECT * FROM org_domains WHERE id=? AND account_id=?', domainId, c.account.id);
  if (!d) throw bad(say('sso.err.domain_gone'), 404);
  if (!!d.use_sso === use) return domainView(d);
  run('UPDATE org_domains SET use_sso=? WHERE id=?', use ? 1 : 0, d.id);
  record('sso.changed', { c, details: { domain: d.domain, uses_single_sign_on: use } });
  if (use) capSessionsAt([d.domain]);
  return domainView({ ...d, use_sso: use ? 1 : 0 });
}

type Found = 'found' | 'missing' | 'unknown';
/** Whether the TXT record of this claim is there. 'unknown': the DNS did not answer just now, which proves nothing. */
async function lookTxt(d: any): Promise<Found> {
  let timer: any;
  try {
    const answers = await Promise.race([txt.lookup(txtName(d.domain)), new Promise<never>((_, no) => (timer = setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), LOOKUP_MS)))]);
    // A long TXT record comes in pieces of 255 characters, which make one text again.
    return (answers || []).some((parts) => (Array.isArray(parts) ? parts.join('') : String(parts)).trim() === `${TXT_VALUE_PREFIX}${d.value}`) ? 'found' : 'missing';
  } catch (e: any) {
    return e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? 'missing' : 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** Looks the record of one claim up and writes what it found. `by`: the request of an admin, or null for the timer. */
export async function checkDomain(d: any, c: Ctx | null): Promise<{ domain: ReturnType<typeof domainView>; found: Found }> {
  const found = await lookTxt(d);
  const t = now();
  const at = { c, by: c ? undefined : { type: 'system' as const }, accounts: d.account_id };
  // The row may have been removed or changed while the DNS was asked.
  const cur = get('SELECT * FROM org_domains WHERE id=?', d.id);
  if (!cur) throw bad(say('sso.err.domain_gone'), 404);
  if (found === 'unknown') return { domain: domainView(cur), found };
  run('UPDATE org_domains SET checked_at=? WHERE id=?', t, cur.id);
  if (found === 'found') {
    if (!cur.verified_at) {
      const holder = get('SELECT * FROM org_domains WHERE domain=? AND account_id!=? AND verified_at IS NOT NULL', cur.domain, cur.account_id);
      if (holder && !holder.lost_at) throw bad(say('sso.err.domain_taken', { domain: cur.domain }), 409, { code: 'domain_taken' });
      tx(() => {
        // The other account's record is gone and ours is there: whoever runs the DNS now decided.
        if (holder) {
          run('DELETE FROM org_domains WHERE id=?', holder.id);
          record('sso.domain_removed', { by: { type: 'system' }, accounts: holder.account_id, details: { domain: holder.domain, claimed_by_another_account: true } });
        }
        run('UPDATE org_domains SET verified_at=?, lost_at=NULL WHERE id=?', t, cur.id);
        record('sso.domain_claimed', { ...at, details: { domain: cur.domain } });
      });
      capSessionsAt([cur.domain]);
    } else if (cur.lost_at) {
      run('UPDATE org_domains SET lost_at=NULL WHERE id=?', cur.id);
      record('sso.domain_claimed', { ...at, details: { domain: cur.domain, found_again: true } });
    }
  } else if (cur.verified_at && !cur.lost_at) {
    run('UPDATE org_domains SET lost_at=? WHERE id=?', t, cur.id);
    record('sso.domain_lost', { ...at, failed: true, details: { domain: cur.domain } });
    await tellLost(cur);
  }
  return { domain: domainView(get('SELECT * FROM org_domains WHERE id=?', cur.id)), found };
}

// The owner and the admins hear that single sign-on stopped for a domain, and what brings it back.
async function tellLost(d: any) {
  const a = get('SELECT name FROM accounts WHERE id=?', d.account_id);
  const people = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", d.account_id);
  for (const p of people)
    await sendMail({
      to: p.email, subject: say('sso.mail.lost.subject', { domain: d.domain }), heading: say('sso.mail.lost.heading', { domain: d.domain }),
      lines: [say('sso.mail.lost.line1', { domain: d.domain, record: txtName(d.domain), account: a?.name || '' }), say('sso.mail.lost.line2')],
    }).catch((e) => console.error('[orgsso] could not email about a lost record', e?.message));
}

/** For the timer: every claimed domain not looked at for DOMAIN_CHECK_HOURS is looked at again. Answers how many. */
export async function recheckDomains(max = 200): Promise<number> {
  if (!ssoAvailable()) return 0;
  const before = new Date(Date.now() - DOMAIN_CHECK_HOURS * 3600_000).toISOString();
  const rows = all('SELECT * FROM org_domains WHERE verified_at IS NOT NULL AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT ?', before, max);
  let n = 0;
  for (const d of rows) {
    try {
      await checkDomain(d, null);
      n++;
    } catch (e: any) {
      if (!(e instanceof HttpError)) console.error('[orgsso] recheck', d.domain, e?.message);
    }
  }
  return n;
}

/**
 * When a domain starts to be signed into through the service, the browsers already signed in for addresses at it
 * end within SSO_SESSION_HOURS too, instead of the usual weeks. Only with the rule on; nobody is signed out at once.
 */
function capSessionsAt(domains: string[]) {
  const until = new Date(Date.now() + ssoHours() * 3600_000).toISOString();
  for (const domain of domains) {
    if (!enforcedFor(`x@${domain}`)) continue;
    run(`UPDATE sessions SET ends_by=? WHERE (ends_by IS NULL OR ends_by > ?) AND user_id IN (SELECT id FROM users WHERE email LIKE ? ESCAPE '\\')`, until, until, `%@${domain.replace(/[%_\\]/g, (x) => `\\${x}`)}`);
  }
}

// ---- The account's sign-in service -------------------------------------------------------------------------------

const idpRow = (accountId: string) => get('SELECT * FROM org_idps WHERE account_id=?', accountId);
const secretRef = (accountId: string) => `org sign-in secret ${accountId}`;

/** The service as oidc.ts uses it, or null when there is none or its secret cannot be opened on this server. */
export async function providerOf(accountId: string): Promise<OrgProvider | null> {
  const r = idpRow(accountId);
  if (!r || r.kind === 'saml') return null;
  const secret = openText(r.secret_sealed, secretRef(accountId));
  if (secret === null) return null;
  // The hosts are checked again on every use, not only when the issuer was saved: the document is fetched again each
  // hour and may name other addresses, and a name may lead somewhere else tomorrow.
  const d = await discover(r.issuer, false, vetHost);
  for (const u of [d.token, d.jwks]) await vetHost(new URL(u).hostname);
  return { id: `org:${accountId}`, name: r.name, clientId: r.client_id, clientSecret: secret, authorize: d.authorize, token: d.token, jwks: d.jwks, issuer: r.issuer };
}

export function idpView(accountId: string) {
  const r = idpRow(accountId);
  if (!r) return null;
  return { kind: r.kind === 'saml' ? 'saml' : 'oidc', name: r.name, issuer: r.issuer, client_id: r.client_id, has_secret: r.kind !== 'saml', enforce: !!r.enforce, join_new: !!r.join_new, tested_at: r.tested_at || null, tested_by: r.tested_by ? get('SELECT name FROM users WHERE id=?', r.tested_by)?.name || null : null, updated_at: r.updated_at };
}

/** The sign-in service may only be reached at public addresses. Throws DiscoveryProblem 'host' with what was found. */
export async function vetHost(host: string): Promise<void> {
  const check = await lookHost(host);
  if (!check.ok) throw new DiscoveryProblem('host', `${host} may not be reached (${check.why})`, { host, check });
}

/** Why an issuer cannot be used, in words for the admin at the card. A host that failed gets its own sentence. */
export function issuerProblemWords(e: DiscoveryProblem): string {
  if (e.why !== 'host') return say(`sso.err.discovery_${e.why}`, { example: 'https://login.example.org' });
  const c = e.check || {};
  const why = c.why === 'none' ? 'none' : c.why === 'private' ? 'private' : c.closed ? 'closed' : 'later';
  return say(`sso.err.issuer_${why}`, { host: e.host || '', address: c.address || '' });
}

/** Checks that an issuer leads to a public host and to a working OpenID Connect service. Throws the reason in words. */
async function checkIssuer(issuer: string) {
  try {
    await discover(issuer, true, vetHost);
  } catch (e) {
    if (e instanceof DiscoveryProblem) throw bad(issuerProblemWords(e), 400, { field: 'issuer', why: e.why });
    throw e;
  }
}

/**
 * Saves the service. Creating it needs all of name, issuer, client id and secret; afterwards any of them, and an empty
 * secret keeps the one saved. A new issuer or client id needs a new try before anything uses it, so while everyone at
 * the domains signs in through it, those two cannot change.
 */
export async function saveIdp(c: Ctx, b: any) {
  if (!ssoAvailable()) throw bad(say('sso.err.no_key'), 409, { code: 'sso_unavailable' });
  const was = idpRow(c.account.id);
  const name = b.name === undefined && was ? was.name : String(b.name ?? '').trim();
  if (!name || name.length > SSO_NAME_MAX || /[<>\u0000-\u001f]/.test(name)) throw bad(say('sso.err.name_form', { max: SSO_NAME_MAX }), 400, { field: 'name' });
  const issuer = b.issuer === undefined && was ? was.issuer : issuerUrl(b.issuer);
  if (!issuer) throw bad(say('sso.err.issuer_form', { example: 'https://login.example.org' }), 400, { field: 'issuer' });
  const clientId = b.client_id === undefined && was ? was.client_id : String(b.client_id ?? '').trim();
  if (!clientId || clientId.length > 300 || /\s/.test(clientId)) throw bad(say('sso.err.client_id_form'), 400, { field: 'client_id' });
  const secret = typeof b.client_secret === 'string' ? b.client_secret.trim() : '';
  // Coming from SAML (saml.ts) there is no secret kept yet, so one is needed as for a new service.
  const fromSaml = was?.kind === 'saml';
  if ((!was || fromSaml) && !secret) throw bad(say('sso.err.secret_needed'), 400, { field: 'client_secret' });
  if (secret.length > 2000) throw bad(say('sso.err.secret_form'), 400, { field: 'client_secret' });
  const moved = !was || fromSaml || was.issuer !== issuer || was.client_id !== clientId;
  if (was?.enforce && moved) throw bad(say('sso.err.enforced_change', { name: was.name }), 409, { code: 'enforced' });
  if (!was || fromSaml || was.issuer !== issuer) await checkIssuer(issuer);
  const k = keys().current!;
  const t = now();
  const sealed = secret ? sealText(secret, secretRef(c.account.id), k) : null;
  if (!was) run('INSERT INTO org_idps (account_id, name, issuer, client_id, secret_sealed, secret_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', c.account.id, name, issuer, clientId, sealed, k.id, t, t);
  else run(`UPDATE org_idps SET kind='oidc', name=?, issuer=?, client_id=?, ${sealed ? 'secret_sealed=?, secret_key=?, ' : ''}tested_at=${moved ? 'NULL' : 'tested_at'}, tested_by=${moved ? 'NULL' : 'tested_by'}, updated_at=? WHERE account_id=?`,
    ...[name, issuer, clientId, ...(sealed ? [sealed, k.id] : []), t, c.account.id]);
  if (was && !fromSaml && was.issuer !== issuer) forgetDiscovery(was.issuer);
  // Another issuer or client id knows people by other ids, so the old connections would refuse them as "taken".
  // They go: each person is connected again, by their address at a claimed domain, the next time they sign in.
  const unlinked = was && moved ? forgetConnections(c.account.id) : 0;
  record('sso.changed', { c, details: { service: name, issuer_host: new URL(issuer).host, ...(was ? {} : { added: true }), ...(moved && was ? { needs_a_new_try: true } : {}), ...(secret && was ? { credentials_replaced: true } : {}), ...(unlinked ? { connections_removed: unlinked } : {}) } });
  return idpView(c.account.id);
}

/** Removes every login's connection to this account's service (identities "org:<account>"). Answers how many. */
const forgetConnections = (accountId: string): number => Number(run('DELETE FROM identities WHERE provider=?', `org:${accountId}`).changes || 0);

/** Switches "everyone signs in through it" and "add people as members" on or off. */
export function setRules(c: Ctx, b: any) {
  const r = idpRow(c.account.id);
  if (!r) throw bad(say('sso.err.no_service'), 404);
  const enforce = b.enforce === undefined ? !!r.enforce : b.enforce;
  const joinNew = b.join_new === undefined ? !!r.join_new : b.join_new;
  if (typeof enforce !== 'boolean' || typeof joinNew !== 'boolean') throw bad(say('sso.err.switch_form'), 400);
  if (enforce && !r.enforce) {
    if (!ssoAvailable()) throw bad(say('sso.err.no_key'), 409, { code: 'sso_unavailable' });
    if (!r.tested_at) throw bad(say('sso.err.try_first', { name: r.name }), 409, { code: 'try_first' });
    if (!get('SELECT 1 x FROM org_domains WHERE account_id=? AND verified_at IS NOT NULL AND lost_at IS NULL AND use_sso=1', c.account.id)) throw bad(say('sso.err.no_domain'), 409, { code: 'no_domain' });
    // The owner's way back in, for the day the service breaks, is their password with two-step login.
    const owner = get("SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role='owner'", c.account.id);
    if (!owner || !twoStepOn(owner)) throw bad(say(c.role === 'owner' ? 'sso.err.owner_two_step_you' : 'sso.err.owner_two_step'), 409, { code: 'owner_two_step' });
  }
  run('UPDATE org_idps SET enforce=?, join_new=?, updated_at=? WHERE account_id=?', enforce ? 1 : 0, joinNew ? 1 : 0, now(), c.account.id);
  record('sso.changed', { c, details: { service: r.name, settings: { everyone_signs_in_through_it: { from: !!r.enforce, to: enforce }, members_on_first_sign_in: { from: !!r.join_new, to: joinNew } } } });
  if (enforce && !r.enforce) capSessionsAt(all('SELECT domain FROM org_domains WHERE account_id=? AND verified_at IS NOT NULL AND lost_at IS NULL AND use_sso=1', c.account.id).map((d) => d.domain));
  return idpView(c.account.id);
}

export function removeIdp(c: Ctx) {
  const r = idpRow(c.account.id);
  if (!r) throw bad(say('sso.err.no_service'), 404);
  run('DELETE FROM org_idps WHERE account_id=?', c.account.id);
  // A SAML service's metadata goes with it; our own entity id for the account stays the same (saml.ts).
  run('UPDATE org_saml SET entity_id=NULL, sso_url=NULL, certs=NULL WHERE account_id=?', c.account.id);
  forgetDiscovery(r.issuer);
  const unlinked = forgetConnections(c.account.id);
  record('sso.removed', { c, details: { service: r.name, ...(unlinked ? { connections_removed: unlinked } : {}) } });
}

/** An admin signed in through the service with success: from now on the sign-in page offers it. */
export function noteTried(accountId: string, userId: string, c: Ctx) {
  run('UPDATE org_idps SET tested_at=?, tested_by=? WHERE account_id=?', now(), userId, accountId);
  record('sso.tested', { c, about: ['user', userId] });
}

/** The account a sign-in through the service belongs to, by the "org:<account>" of the provider. */
export const accountOfProvider = (provider: string): string | null => (typeof provider === 'string' && provider.startsWith('org:') ? provider.slice(4) : null);
/** Whether this address is at a claimed domain of this account that uses the service (the rule need not be on). */
export function domainUsesSso(accountId: string, email: string): boolean {
  const domain = domainOf(email);
  return !!domain && !!get('SELECT 1 x FROM org_domains WHERE account_id=? AND domain=? AND verified_at IS NOT NULL AND lost_at IS NULL AND use_sso=1', accountId, domain);
}
