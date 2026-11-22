// Organisations above accounts (src/server/orgs.ts), as routes.
//
// For the operator (OPERATOR_EMAILS; anyone else gets 404):
//   GET  /operator/orgs                       every organisation, with its admins and how many agencies
//   POST /operator/orgs                       { name, parent_id?, admin_email }: an organisation and its first admin
//   PUT  /operator/orgs/:id/break-glass       { allowed }: emergency access to documents for its admins, on or off
//   PUT  /operator/accounts/:id/org           { org_id | null }: moves an agency to another organisation
// For an admin of an organisation, about that organisation and everything below it (anyone else gets 404):
//   GET  /orgs                                the organisations I am an admin of
//   GET  /orgs/:id                            its rules (and where each comes from), its organisations, agencies, admins
//   POST /orgs/:id/orgs                       { name }: an organisation below it
//   PUT  /orgs/:id/policy                     { rule: value | null, ... }: the rules it passes down
//   POST /orgs/:id/admins                     { email }: another admin, who has a GrowSigning login already
//   DELETE /orgs/:id/admins/:user             takes an admin off
//   POST /orgs/:id/agencies                   { name, owner_email, owner_name? }: an agency (an account), its first owner invited by email
//   GET  /orgs/:id/agencies/:aid/members      its people: names, addresses, roles, two-step login on or off
//   POST /orgs/:id/agencies/:aid/people       { email, role: 'owner' | 'admin' }: another owner or admin (invited, or at once for
//                                             someone already on its team with a confirmed address)
//   PATCH /orgs/:id/agencies/:aid/members/:uid  { role: 'admin' | 'member' }
//   POST /orgs/:id/agencies/:aid/members/:uid/two-step/reset  { code? }: the same rules as an account admin's reset
//   PUT  /orgs/:id/agencies/:aid/sending      { on }: switches sending off or on for the agency
//   POST /orgs/:id/agencies/:aid/break-glass  { envelope_id, reason }: the document, only where the operator allowed it
//   GET  /orgs/:id/report                     counts per agency: sent, completed, average days; no titles, no names
//   GET  /orgs/:id/events                     what was done at the level of this organisation
//
// Never an owner or admin of an agency below: an admin of an organisation (refuseOrgAdminRole in orgs.ts, asked here,
// in routes-account.ts and by the router, which treats one that slipped through as a member).
// Never here: a list of any agency's documents, their titles, comments or field values. An API key reaches none of
// it: an organisation is run by people signed in to the app.
import { route, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, now, id, token, isEmail, str, baseUrl, rateLimit, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { isOperator } from './routes-trust.ts';
import { loadEnvelope, finalPdf, buildPdf } from './envelopes.ts';
import { twoStepOn, adminResetTeams, needCode, clearTwoStep, logStep } from './twostep.ts';
import { record } from './seclog.ts';
import { DEFAULT_REMINDER_DAYS, TWO_STEP_EMAIL_RESET_DAYS } from '../lib/policy.ts';
import { ORG_POLICY_KEYS, parseOrgPolicy, setByWords, type OrgPolicy } from '../lib/orgs.ts';
import {
  orgById, chain, subtree, accountsBelow, isOrgAdminOf, adminOrgs, floorOfChain, applyBelow, applyFloor, restoreBelow, refuseOrgLoosening, refuseOrgAdminRole, orgEvent, orgName, createOrg, moveAccount,
} from './orgs.ts';
import { chatModelOn } from '../lib/chatprovider.ts';

const notFound = () => new HttpError(404, 'Not found');

function operator(c: Ctx) {
  if (!isOperator(c.user)) throw notFound();
}
/** A person in the app (never an API key) who is an admin of this organisation or of one above it. */
function orgAdmin(c: Ctx, orgId: string) {
  if (c.auth?.via !== 'session') throw new HttpError(403, 'An API key cannot work on an organisation. Sign in to the app as an admin of the organisation and do it under Settings, Organisation.');
  const org = orgById(orgId);
  if (!org || !isOrgAdminOf(c.user.id, org.id)) throw notFound();
  return org;
}
/** An agency in this organisation or below it. */
function agencyOf(org: { id: string }, accountId: string) {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a || !a.org_id || !subtree(org.id).includes(a.org_id)) throw new HttpError(404, 'There is no such agency in this organisation. Check the list of agencies and try again.');
  return a;
}
const loginByEmail = (email: string) => get('SELECT * FROM users WHERE lower(email)=lower(?)', email);
const emailOf = (v: unknown) => {
  const e = str(v, 254).trim().toLowerCase();
  if (!isEmail(e)) throw bad('Type a whole email address, like name@agency.example. Nothing was changed.');
  return e;
};
/** Someone with rights over the organisation above an account is never made one of its owners or admins: that
 * would be a way into its documents that is not emergency access. */
function notAnAdminAbove(orgId: string, email: string) {
  const u = loginByEmail(email);
  if (u && isOrgAdminOf(u.id, orgId))
    throw bad(`${u.name} is an admin of an organisation above this agency, so they cannot also be one of its owners or admins: that would let them read its documents. Name someone who works in the agency.`, 409, { code: 'org_admin' });
}

/**
 * Names an owner or admin of an agency. Someone already on the agency's team with a confirmed address gets the role
 * at once (the organisation admin sees the team anyway). Everyone else is invited by email and joins by accepting:
 * the invitation goes to the address only, so a login someone made in an official's name and never confirmed gets
 * nothing, and the answer is the same whether a login exists for the address or not. Both are emailed.
 */
async function namePerson(c: Ctx, org: any, agency: any, email: string, role: 'owner' | 'admin', personName?: string) {
  notAnAdminAbove(org.id, email);
  const u = loginByEmail(email);
  const words = role === 'owner' ? 'an owner' : 'an admin';
  const had = u ? get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', agency.id, u.id) : null;
  if (had?.role === role || had?.role === 'owner') throw bad(`${u.name} is already ${had.role === 'owner' ? 'an owner' : 'an admin'} of ${agency.name}. Nothing was changed.`, 409);
  if (had && u.email_verified) {
    run('UPDATE memberships SET role=? WHERE account_id=? AND user_id=?', role, agency.id, u.id);
    orgEvent(org.id, 'org.changed', { c, account: agency.id, details: { what: 'owner_named', role, person: u.name } });
    await sendMail({ to: u.email, about: u.id, subject: `You are now ${words} of ${agency.name} on GrowSigning`, heading: `${agency.name}`,
      lines: [`${c.user.name} of ${org.name} made you ${words} of ${agency.name} on GrowSigning.`,
        `If you did not expect this, tell ${c.user.name} or reply to the admins of ${org.name}.`],
      cta: { label: `Open ${agency.name}`, url: `${baseUrl()}/app` } });
    return { emailed: true, joined: true };
  }
  run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', agency.id, email);
  const t = token();
  const inviteId = id('inv');
  run('INSERT INTO invites (id, token, account_id, email, role, created_at) VALUES (?,?,?,?,?,?)', inviteId, t, agency.id, email, role, now());
  orgEvent(org.id, 'org.changed', { c, account: agency.id, details: { what: 'owner_named', invited: true, role, person: personName || email } });
  await sendMail({ to: email, about: c.user.id, subject: `${org.name} made you ${words} of ${agency.name} on GrowSigning`, heading: `Join ${agency.name}`,
    lines: [`${c.user.name} of ${org.name} named you ${words} of ${agency.name}, where it sends and signs documents. Press the button and sign in with this address, or make your GrowSigning login with it. Then you are in.`],
    cta: { label: 'Accept', url: `${baseUrl()}/${u ? 'login' : 'signup'}?invite=${t}&email=${encodeURIComponent(email)}` } });
  return { emailed: true, joined: false };
}

// ---- Operator ---------------------------------------------------------------------------------------------------

route('GET', '/operator/orgs', (c) => {
  operator(c);
  return {
    orgs: all('SELECT * FROM orgs ORDER BY name').map((o) => ({
      id: o.id, name: o.name, parent_id: o.parent_id, break_glass: !!o.break_glass, created_at: o.created_at,
      agencies: get('SELECT COUNT(*) n FROM accounts WHERE org_id=?', o.id).n,
      admins: all('SELECT u.id, u.name, u.email FROM org_admins a JOIN users u ON u.id=a.user_id WHERE a.org_id=? ORDER BY u.name', o.id),
    })),
  };
});

route('POST', '/operator/orgs', async (c) => {
  operator(c);
  const b = await c.body();
  const name = orgName(b.name, 'organisation');
  const parent = b.parent_id ? orgById(str(b.parent_id, 80)) : null;
  if (b.parent_id && !parent) throw bad('There is no organisation with that parent_id. Leave it out for an organisation at the top.', 404);
  const admin = loginByEmail(emailOf(b.admin_email));
  if (!admin || !admin.email_verified) throw bad('The first admin needs a GrowSigning login with a confirmed address. Ask them to sign up with it and confirm it, then try again. Nothing was made.', 409, { code: 'no_login' });
  // Below a parent: nobody who runs an agency under it becomes an admin above that agency (as POST /orgs/:id/admins).
  const under = parent ? accountsBelow(parent.id) : [];
  if (under.length && get(`SELECT 1 x FROM memberships WHERE user_id=? AND role IN ('owner','admin') AND account_id IN (${under.map(() => '?').join(',')})`, admin.id, ...under))
    throw bad(`${admin.name} is an owner or admin of an agency below that organisation, so they cannot be an admin above it too. Hand that role to someone else first. Nothing was made.`, 409, { code: 'agency_admin' });
  const org = tx(() => {
    const o = createOrg(name, parent?.id || null);
    run('INSERT INTO org_admins (org_id, user_id, added_by, added_at) VALUES (?,?,?,?)', o.id, admin.id, `operator:${c.user.id}`, now());
    orgEvent(o.id, 'org.changed', { operator: c.user.id, details: { what: 'org_created', name } });
    orgEvent(o.id, 'org.changed', { operator: c.user.id, details: { what: 'admin_added', person: admin.name } });
    return o;
  });
  return { org };
});

route('PUT', '/operator/orgs/:id/break-glass', async (c) => {
  operator(c);
  const org = orgById(c.params.id);
  if (!org) throw bad('There is no organisation with that id.', 404);
  const b = await c.body();
  if (typeof b.allowed !== 'boolean') throw bad('Send "allowed": true to allow emergency access to documents for the admins of this organisation, or false to stop it. Nothing was changed.');
  run('UPDATE orgs SET break_glass=? WHERE id=?', b.allowed ? 1 : 0, org.id);
  orgEvent(org.id, 'org.changed', { operator: c.user.id, details: { what: 'break_glass_allowed', to: b.allowed } });
  // Every agency below hears it in its own record: from now on its documents can, or can no longer, be opened this way.
  for (const accountId of accountsBelow(org.id)) record('org.changed', { by: { type: 'operator', id: c.user.id }, accounts: accountId, about: ['account', accountId], details: { what: 'break_glass_allowed', to: b.allowed, organisation: org.name } });
  return { ok: true, allowed: b.allowed };
});

route('PUT', '/operator/accounts/:id/org', async (c) => {
  operator(c);
  const b = await c.body();
  if (!('org_id' in b)) throw bad('Send "org_id": the organisation to move the account into, or null to take it out of every organisation. Nothing was changed.');
  return { ok: true, ...moveAccount(c.params.id, b.org_id ? str(b.org_id, 80) : null, c.user.id) };
});

// ---- Organisation admins ----------------------------------------------------------------------------------------

route('GET', '/orgs', (c) => ({ orgs: c.auth?.via === 'session' ? adminOrgs(c.user.id).map((o) => ({ id: o.id, name: o.name })) : [] }));

function orgView(c: Ctx, org: any) {
  const up = chain(org.id);
  const above = floorOfChain(up, org.id);
  const kids = all('SELECT id, name FROM orgs WHERE parent_id=? ORDER BY name', org.id);
  return {
    id: org.id, name: org.name,
    path: up.map((o) => ({ id: o.id, name: o.name, yours: isOrgAdminOf(c.user.id, o.id) })),
    break_glass: up.some((o) => o.break_glass),
    // The rules: what this organisation asks itself, and what is asked above it, with who asked.
    policy: org.policy as OrgPolicy,
    above: Object.fromEntries(ORG_POLICY_KEYS.filter((k) => above.policy[k] !== undefined).map((k) => [k, { value: above.policy[k], set_by: setByWords(above.from[k]!) }])),
    orgs: kids,
    agencies: all('SELECT id, name, org_sending_off_at, created_at FROM accounts WHERE org_id=? ORDER BY name', org.id).map((a) => ({
      id: a.id, name: a.name, sending: !a.org_sending_off_at, created_at: a.created_at,
      people: get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', a.id).n,
      waiting_owner: !get("SELECT 1 x FROM memberships WHERE account_id=? AND role='owner'", a.id),
    })),
    admins: all('SELECT u.id, u.name, u.email FROM org_admins a JOIN users u ON u.id=a.user_id WHERE a.org_id=? ORDER BY u.name', org.id),
    // How many agencies and people a rule reaches: said before a rule that can lock people out is switched on.
    reach: (() => {
      const ids = accountsBelow(org.id);
      return { agencies: ids.length, people: ids.length ? get(`SELECT COUNT(DISTINCT user_id) n FROM memberships WHERE account_id IN (${ids.map(() => '?').join(',')})`, ...ids).n : 0 };
    })(),
    // Whether a model answers the help chat on this server at all. When not, the rule about AI answers is not shown.
    ai_available: chatModelOn(),
  };
}

route('GET', '/orgs/:id', (c) => orgView(c, orgAdmin(c, c.params.id)));

route('POST', '/orgs/:id/orgs', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const name = orgName((await c.body()).name, 'organisation');
  const made = tx(() => {
    const o = createOrg(name, org.id);
    orgEvent(org.id, 'org.changed', { c, details: { what: 'org_created', name } });
    return o;
  });
  return { org: { id: made.id, name: made.name } };
});

route('PUT', '/orgs/:id/policy', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const parsed = parseOrgPolicy(await c.body());
  if ('error' in parsed) throw bad(parsed.error);
  const next: OrgPolicy = { ...org.policy, ...parsed.policy };
  for (const k of parsed.unset) delete next[k];
  refuseOrgLoosening(org, next);
  const [brought, given] = tx(() => {
    run('UPDATE orgs SET policy=? WHERE id=?', JSON.stringify(next), org.id);
    orgEvent(org.id, 'org.changed', { c, details: { what: 'policy_changed', policy: { from: org.policy, to: next } } });
    // A rule taken away gives each agency back what it had before it, unless the agency changed it since.
    return [applyBelow(org.id, { c }), parsed.unset.length ? restoreBelow(org.id, { c }) : 0];
  });
  return { ...orgView(c, orgById(org.id)), accounts_changed: brought, accounts_given_back: given };
});

route('POST', '/orgs/:id/admins', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const u = loginByEmail(emailOf((await c.body()).email));
  if (!u || !u.email_verified) throw bad('The new admin needs a GrowSigning login with a confirmed address. Ask them to sign up with it and confirm it, then try again. Nothing was changed.', 409, { code: 'no_login' });
  // An admin of the organisation reads none of the documents below it, so whoever is a member of an agency below
  // stays only that: they are told to leave it first.
  const below = accountsBelow(org.id);
  if (below.length && get(`SELECT 1 x FROM memberships WHERE user_id=? AND role IN ('owner','admin') AND account_id IN (${below.map(() => '?').join(',')})`, u.id, ...below))
    throw bad(`${u.name} is an owner or admin of an agency below ${org.name}. An organisation admin cannot be one too, because it would mix reading that agency's documents with rights over the others. Hand that role to someone else first.`, 409, { code: 'agency_admin' });
  if (get('SELECT 1 x FROM org_admins WHERE org_id=? AND user_id=?', org.id, u.id)) throw bad(`${u.name} is already an admin of ${org.name}. Nothing was changed.`, 409);
  run('INSERT INTO org_admins (org_id, user_id, added_by, added_at) VALUES (?,?,?,?)', org.id, u.id, c.user.id, now());
  orgEvent(org.id, 'org.changed', { c, details: { what: 'admin_added', person: u.name } });
  await sendMail({ to: u.email, about: u.id, subject: `You are now an admin of ${org.name} on GrowSigning`, heading: org.name,
    lines: [`${c.user.name} made you an admin of ${org.name}. You set the rules its agencies follow and see how many documents they send, under Settings, Organisation. You do not see their documents.`],
    cta: { label: 'Open Settings, Organisation', url: `${baseUrl()}/app/settings?tab=organisation` } });
  return orgView(c, org);
});

route('DELETE', '/orgs/:id/admins/:user', (c) => {
  const org = orgAdmin(c, c.params.id);
  const u = get('SELECT u.id, u.name FROM org_admins a JOIN users u ON u.id=a.user_id WHERE a.org_id=? AND a.user_id=?', org.id, c.params.user);
  if (!u) throw bad('That person is not an admin of this organisation.', 404);
  const left = get('SELECT COUNT(*) n FROM org_admins WHERE org_id=?', org.id).n;
  if (left < 2 && !org.parent_id) throw bad(`${u.name} is the last admin of ${org.name}. Add another admin first, so the organisation is never without one.`, 409, { code: 'last_admin' });
  run('DELETE FROM org_admins WHERE org_id=? AND user_id=?', org.id, u.id);
  orgEvent(org.id, 'org.changed', { c, details: { what: 'admin_removed', person: u.name } });
  return orgView(c, org);
});

route('POST', '/orgs/:id/agencies', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const b = await c.body();
  const name = orgName(b.name, 'agency');
  const email = emailOf(b.owner_email);
  notAnAdminAbove(org.id, email);
  rateLimit(`org-agencies:${c.user.id}`, 50, 3600_000);
  const accountId = id('acc');
  tx(() => {
    run('INSERT INTO accounts (id, name, created_at, default_reminder_days, org_id) VALUES (?,?,?,?,?)', accountId, name, now(), DEFAULT_REMINDER_DAYS, org.id);
    orgEvent(org.id, 'org.changed', { c, account: accountId, details: { what: 'agency_created', name } });
    applyFloor(accountId, { c });
  });
  const named = await namePerson(c, org, get('SELECT * FROM accounts WHERE id=?', accountId), email, 'owner', str(b.owner_name, 120).trim() || undefined);
  return { agency: { id: accountId, name }, owner: named };
});

route('GET', '/orgs/:id/agencies/:aid/members', (c) => {
  const org = orgAdmin(c, c.params.id);
  const a = agencyOf(org, c.params.aid);
  return {
    agency: { id: a.id, name: a.name, sending: !a.org_sending_off_at },
    members: all('SELECT u.id, u.name, u.email, u.two_step_on_at, u.two_step_secret, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', a.id)
      .map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, two_step: twoStepOn(m), can_reset: twoStepOn(m) && m.role !== 'owner' && adminResetTeams(m.id).includes(a.id) })),
    invites: all("SELECT id, email, role, created_at FROM invites WHERE account_id=? AND accepted_at IS NULL AND role IN ('owner','admin')", a.id),
  };
});

route('POST', '/orgs/:id/agencies/:aid/people', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const a = agencyOf(org, c.params.aid);
  const b = await c.body();
  if (b.role !== 'owner' && b.role !== 'admin') throw bad('Send "role" as "owner" or "admin". Members are invited by the agency itself, under Settings, Team. Nothing was changed.');
  return namePerson(c, org, a, emailOf(b.email), b.role);
});

route('PATCH', '/orgs/:id/agencies/:aid/members/:uid', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const a = agencyOf(org, c.params.aid);
  const b = await c.body();
  if (b.role !== 'admin' && b.role !== 'member') throw bad('Send "role" as "admin" or "member". To name an owner, use "Name an owner". Nothing was changed.');
  const m = get('SELECT m.role, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', a.id, c.params.uid);
  if (!m) throw bad(`That person is not on ${a.name}.`, 404);
  if (m.role === 'owner') throw bad(`${m.name} is an owner of ${a.name}. An owner's role is changed by the agency itself, under Settings, Team. Nothing was changed.`, 409);
  if (m.role === b.role) return { ok: true, role: m.role };
  // Never an admin of this organisation, or of one above it, and so never the one asking for themselves.
  refuseOrgAdminRole(a.id, c.params.uid, b.role);
  run('UPDATE memberships SET role=? WHERE account_id=? AND user_id=?', b.role, a.id, c.params.uid);
  orgEvent(org.id, 'org.changed', { c, account: a.id, details: { what: 'role_changed', role: b.role, person: m.name } });
  return { ok: true, role: b.role };
});

// The same rules as the reset an account admin can do (routes-twostep.ts): never an owner, only someone this agency
// speaks for alone, after the organisation admin typed their own code when they have two-step login; the person is
// emailed at once.
route('POST', '/orgs/:id/agencies/:aid/members/:uid/two-step/reset', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const a = agencyOf(org, c.params.aid);
  const b = await c.body();
  const m = get('SELECT u.*, m.role member_role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', a.id, c.params.uid);
  if (!m) throw bad(`That person is not on ${a.name}.`, 404);
  if (m.member_role === 'owner') throw bad(`${m.name} owns ${a.name}, and nobody else can reset the second step of an owner. They use the reset by email on the sign-in screen, which takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days.`, 403, { code: 'owner' });
  if (!adminResetTeams(m.id).includes(a.id)) throw bad(`${m.name} owns a workspace or is an admin of another one, so their second step cannot be switched off from here: it would open that workspace too. They can use the reset by email on the sign-in screen, which takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days. Nothing was changed.`, 403, { code: 'admin_elsewhere' });
  if (!twoStepOn(m)) throw bad(`${m.name} does not have two-step login on, so there is nothing to reset.`, 409, { code: 'two_step_off' });
  rateLimit(`two-step-admin-reset:${c.user.id}`, 10, 3600_000);
  await needCode(c, b.code, `reset the second step of ${m.name}`);
  tx(() => {
    clearTwoStep(m.id);
    logStep(m.id, 'reset_by_admin', { id: c.user.id, name: `${c.user.name} (${org.name})` }, a);
    record('two_step.reset', { c, accounts: a.id, about: ['user', m.id], details: { how: 'by_an_admin', organisation: org.name } });
    orgEvent(org.id, 'org.changed', { c, details: { what: 'two_step_reset', person: m.name, agency: a.id } });
  });
  await sendMail({ to: m.email, subject: `${c.user.name} switched off two-step login of your GrowSigning login`, heading: 'Your second step was reset',
    lines: [`${c.user.name} of ${org.name}, the organisation above ${a.name}, switched off two-step login of your GrowSigning login just now. Signing in asks for no code now, and your recovery codes and remembered devices were removed.`,
      `Set it up again under Settings, Security, with the authenticator app on your phone.${a.two_step_required_at ? ` ${a.name} asks everyone for it, so you are asked to do that the next time you open it.` : ''}`,
      `If you did not ask for this, tell ${c.user.name} and change your password, because whoever knows it can now sign in with it alone.`],
    cta: { label: 'Set it up again', url: `${baseUrl()}/app/settings?tab=security#two-step` } });
  return { ok: true, name: m.name };
});

route('PUT', '/orgs/:id/agencies/:aid/sending', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const a = agencyOf(org, c.params.aid);
  const b = await c.body();
  if (typeof b.on !== 'boolean') throw bad('Send "on": false to switch sending off for this agency, or true to switch it on again. Nothing was changed.');
  if (b.on === !a.org_sending_off_at) return { ok: true, sending: b.on };
  run('UPDATE accounts SET org_sending_off_at=?, org_sending_off_by=? WHERE id=?', b.on ? null : now(), b.on ? null : org.name, a.id);
  orgEvent(org.id, 'org.changed', { c, account: a.id, details: { what: b.on ? 'sending_on' : 'sending_off' } });
  const owners = all("SELECT u.email, u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", a.id);
  for (const o of owners)
    await sendMail({ to: o.email, about: o.id, subject: `${org.name} switched sending ${b.on ? 'on' : 'off'} for ${a.name}`, heading: `Sending ${b.on ? 'on again' : 'switched off'}`,
      lines: [b.on ? `${c.user.name} of ${org.name} switched sending on again for ${a.name}. New documents and reminders go out as before.`
        : `${c.user.name} of ${org.name} switched sending off for ${a.name}. Nothing new is emailed from it until they switch it on again. People who already have a document can still open, sign and download it.`,
      `Ask ${c.user.name} if you do not know why.`] });
  return { ok: true, sending: b.on };
});

// Emergency access to one document. Only where the operator allowed it for this organisation or one above it, with
// a reason. The owners and admins of the agency are emailed at once, before the file is given, and the agency's
// security record holds a line that nobody can take out.
route('POST', '/orgs/:id/agencies/:aid/break-glass', async (c) => {
  const org = orgAdmin(c, c.params.id);
  const a = agencyOf(org, c.params.aid);
  const allowedBy = chain(a.org_id).find((o) => o.break_glass && isOrgAdminOf(c.user.id, o.id));
  if (!allowedBy) throw bad(`Emergency access to documents is not allowed for ${org.name}. Only the people who run this server can allow it. Ask the agency to share the document instead.`, 403, { code: 'break_glass_off' });
  const b = await c.body();
  const reason = str(b.reason, 500).replace(/\s+/g, ' ').trim();
  if (reason.length < 15) throw bad('Write why you need this document, in a sentence of at least 15 characters. The owners of the agency read it. Nothing was opened.', 400, { code: 'reason' });
  rateLimit(`break-glass:${c.user.id}`, 5, 24 * 3600_000);
  const envelopeId = str(b.envelope_id, 80);
  const e = envelopeId ? loadEnvelope(envelopeId) : null;
  if (!e || e.account_id !== a.id || e.kind === 'template') throw bad(`There is no document with that id in ${a.name}. Ask the agency for the id on the document's page.`, 404);
  if (e.purged_at) throw bad('The files of this document were deleted under the agency\'s rule for keeping documents. Its record is still with the agency.', 410, { code: 'purged' });
  // The title goes into the agency's own record only, never into the organisation's (agencyOnly).
  orgEvent(org.id, 'org.break_glass', { c, account: a.id, details: { reason, envelope: e.id }, agencyOnly: { document: e.subject || 'Untitled' } });
  const owners = all("SELECT u.email, u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", a.id);
  for (const o of owners)
    await sendMail({ to: o.email, about: o.id, subject: `${c.user.name} of ${org.name} opened a document of ${a.name}`, heading: 'Emergency access to a document',
      lines: [`${c.user.name} of ${org.name} opened "${e.subject || 'Untitled'}" with emergency access just now. The reason they gave: "${reason}".`,
        `This is in the security record of ${a.name}, under Settings, Security. If you did not expect it, ask ${c.user.name} or the people who run this server.`] });
  const bytes = finalPdf(e) || (await buildPdf(e, false));
  return pdfResponse(bytes, e.subject || 'document');
});

// Counts only: no titles, no names, no people. An agency with fewer than one document shows zeros.
route('GET', '/orgs/:id/report', (c) => {
  const org = orgAdmin(c, c.params.id);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.q.get('from') || '') ? c.q.get('from')! : new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.q.get('to') || '') ? c.q.get('to')! : new Date().toISOString().slice(0, 10);
  const ids = accountsBelow(org.id);
  const rows = ids.map((accountId) => {
    const a = get('SELECT id, name, org_id FROM accounts WHERE id=?', accountId);
    const r = get(`SELECT COUNT(*) sent, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
        AVG(CASE WHEN status='completed' AND completed_at IS NOT NULL THEN julianday(completed_at) - julianday(sent_at) END) days
      FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL AND substr(sent_at,1,10) BETWEEN ? AND ?`, accountId, from, to);
    return { id: a.id, name: a.name, organisation: orgById(a.org_id)?.name || null, sent: Number(r.sent) || 0, completed: Number(r.completed) || 0, average_days: r.days == null ? null : Math.round(r.days * 10) / 10 };
  });
  return { from, to, agencies: rows };
});

route('GET', '/orgs/:id/events', (c) => {
  const org = orgAdmin(c, c.params.id);
  const ids = subtree(org.id);
  return {
    events: all(`SELECT seq, org_id, at, actor_type, kind, account_id, details FROM org_events WHERE org_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 200`, ...ids)
      // A title kept here before it went to the agency's record only is still never shown.
      .map((r) => {
        const { document: _title, ...details } = JSON.parse(r.details || '{}');
        return { ...r, details };
      }),
  };
});
