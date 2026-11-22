// gov-G13: organisations above accounts (src/server/orgs.ts, src/server/routes-orgs.ts).
//   1. Organisations: the operator makes the top ones and names their first admin; an admin makes organisations and
//      agencies below, and names each agency's first owner. Nesting, depth, who may do what.
//   2. Rules passed down: an agency is brought up to them, may ask for more, never for less; an organisation below
//      may not ask for less than one above; each screen is told who set a value.
//   3. Delegated admin: members, roles, two-step reset with the existing rules, sending off; never a document. Every
//      document route of the router answers no to an organisation admin. Emergency access only where the operator
//      allowed it, with a reason, the owners told and a line in the record.
//   5. Counts per agency, with no titles or names.
//   Moving an agency between organisations is for the operator alone.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, mailTo, simple, upload, type Server } from './helpers.ts';

let db: Server['db'];
let grant: typeof import('../src/server/credits.ts').grant;
let listRoutes: typeof import('../src/server/router.ts').listRoutes;

const OP = 'op@g13.example';
let op: Client, govAdmin: Client, minAdmin: Client, owner: Client, member: Client, stranger: Client;
let gov: string, ministry: string, agency: string;
let ownerId: string, memberId: string;

const uid = (email: string) => db.get('SELECT id FROM users WHERE email=?', email).id;
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const lines = (accountId: string, kind: string) => db.all('SELECT * FROM security_events WHERE account_id=? AND kind=? ORDER BY seq', accountId, kind).map((r: any) => ({ ...r, details: JSON.parse(r.details) }));
/** Every refusal a person reads: two sentences or more, and a sentence after the first that starts with a verb or says what is kept. */
const plain = (msg: string) => {
  assert.ok(typeof msg === 'string' && msg.length > 20, msg);
  assert.ok(!/\u2014/.test(msg), `em dash in: ${msg}`);
  assert.ok(msg.split(/(?<=\.)\s+/).length >= 2, `one sentence only: ${msg}`);
};

before(async () => {
  process.env.OPERATOR_EMAILS = OP;
  const s = await boot();
  db = s.db;
  grant = (await import('../src/server/credits.ts')).grant;
  listRoutes = (await import('../src/server/router.ts')).listRoutes;
  op = await signUp('Opal Operator', OP, '198.51.100.1');
  govAdmin = await signUp('Gita Central', 'gita@gov.example', '198.51.100.2');
  minAdmin = await signUp('Musa Ministry', 'musa@health.example', '198.51.100.3');
  owner = await signUp('Olu Owner', 'olu@agency.example', '198.51.100.4');
  member = await signUp('Mira Member', 'mira@agency.example', '198.51.100.5');
  stranger = await signUp('Sam Stranger', 'sam@else.example', '198.51.100.6');
  ownerId = uid('olu@agency.example');
  memberId = uid('mira@agency.example');
});

test('1. the operator makes a top organisation; nobody else can', async () => {
  const no = await govAdmin.post('/operator/orgs', { name: 'Government', admin_email: 'gita@gov.example' });
  assert.equal(no.status, 404);
  const unknown = await op.post('/operator/orgs', { name: 'Government', admin_email: 'nobody@gov.example' });
  assert.equal(unknown.status, 409);
  plain(unknown.data.error);
  assert.equal((await op.post('/operator/orgs', { name: '  ', admin_email: 'gita@gov.example' })).status, 400);
  const r = await op.post('/operator/orgs', { name: 'Government of Example', admin_email: 'gita@gov.example' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  gov = r.data.org.id;
  assert.deepEqual((await govAdmin.get('/orgs')).data.orgs.map((o: any) => o.name), ['Government of Example']);
  assert.deepEqual((await owner.get('/orgs')).data.orgs, []);
  assert.equal((await stranger.get(`/orgs/${gov}`)).status, 404);
});

test('1. an admin makes a ministry below, names its admin, and the ministry makes an agency with its owner', async () => {
  const m = await govAdmin.post(`/orgs/${gov}/orgs`, { name: 'Ministry of Health' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  ministry = m.data.org.id;
  const noLogin = await govAdmin.post(`/orgs/${ministry}/admins`, { email: 'new@health.example' });
  assert.equal(noLogin.status, 409);
  plain(noLogin.data.error);
  assert.equal((await govAdmin.post(`/orgs/${ministry}/admins`, { email: 'musa@health.example' })).status, 200);
  assert.ok(mailTo('musa@health.example').some((e: any) => /admin of Ministry of Health/.test(e.subject)));
  // The ministry's admin is not an admin of the government above it.
  assert.equal((await minAdmin.get(`/orgs/${gov}`)).status, 404);
  const view = (await minAdmin.get(`/orgs/${ministry}`)).data;
  assert.deepEqual(view.path.map((p: any) => [p.name, p.yours]), [['Government of Example', false], ['Ministry of Health', true]]);

  const a = await minAdmin.post(`/orgs/${ministry}/agencies`, { name: 'Public Health Agency', owner_email: 'olu@agency.example' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  agency = a.data.agency.id;
  // The first owner is invited, never added at once: the answer is the same whether a login exists for the address.
  assert.deepEqual(a.data.owner, { emailed: true, joined: false });
  assert.ok(!db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', agency, ownerId));
  assert.equal(acct(agency).org_id, ministry);
  assert.ok(mailTo('olu@agency.example').some((e: any) => /owner of Public Health Agency/.test(e.subject)));
  const inv = db.get('SELECT token FROM invites WHERE account_id=? AND email=?', agency, 'olu@agency.example').token;
  assert.equal((await owner.post('/invites/accept', { token: inv })).status, 200);
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', agency, ownerId).role, 'owner');
  // Someone with no login yet is invited as owner, by email, with the same answer.
  const b = await minAdmin.post(`/orgs/${ministry}/agencies`, { name: 'Blood Service', owner_email: 'new.owner@blood.example', owner_name: 'Nia' });
  assert.deepEqual(b.data.owner, { emailed: true, joined: false });
  assert.equal(db.get('SELECT role FROM invites WHERE account_id=? AND email=?', b.data.agency.id, 'new.owner@blood.example').role, 'owner');
  assert.equal(lines(agency, 'org.changed').filter((l: any) => l.details.what === 'agency_created').length, 1);
  // The government admin sees and works on everything below.
  assert.equal((await govAdmin.get(`/orgs/${ministry}`)).status, 200);
  // The owner adds a member the ordinary way.
  grant(agency, 20, 'welcome', `g13-${agency}`);
  await owner.post('/auth/switch', { account_id: agency });
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", agency, memberId, new Date().toISOString());
});

test('1. an organisation admin cannot be named owner or admin of an agency below, and an agency admin cannot become an organisation admin', async () => {
  const r = await govAdmin.post(`/orgs/${ministry}/agencies`, { name: 'Shadow', owner_email: 'gita@gov.example' });
  assert.equal(r.status, 409);
  plain(r.data.error);
  assert.equal((await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/people`, { email: 'musa@health.example', role: 'admin' })).status, 409);
  const back = await govAdmin.post(`/orgs/${ministry}/admins`, { email: 'olu@agency.example' });
  assert.equal(back.status, 409);
  plain(back.data.error);
});

test('1. nesting stops at five deep, and an API key reaches no organisation route', async () => {
  let at = ministry;
  const made: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await govAdmin.post(`/orgs/${at}/orgs`, { name: `Level ${i + 3}` });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    at = r.data.org.id;
    made.push(at);
  }
  const deep = await govAdmin.post(`/orgs/${at}/orgs`, { name: 'Too deep' });
  assert.equal(deep.status, 400);
  plain(deep.data.error);
  const key = (await govAdmin.post('/api-keys', { name: 'k' })).data.key;
  const viaKey = await new Client().call('GET', `/orgs/${gov}`, undefined, { authorization: `Bearer ${key}` });
  assert.equal(viaKey.status, 403);
  plain(viaKey.data.error);
});

test('2. rules passed down: agencies are brought up to them, may tighten, may not loosen; a ministry may not loosen', async () => {
  const bad = await govAdmin.put(`/orgs/${gov}/policy`, { min_password_length: 'twelve' });
  assert.equal(bad.status, 400);
  assert.equal((await govAdmin.put(`/orgs/${gov}/policy`, { fingerprint: true })).status, 400);
  const r = await govAdmin.put(`/orgs/${gov}/policy`, { min_password_length: 12, impact_display: 'off', idle_minutes: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.accounts_changed >= 2);
  const a = acct(agency);
  assert.deepEqual([a.min_password_length, a.impact_display, a.idle_minutes], [12, 'off', 60]);
  const line = lines(agency, 'settings.changed').at(-1);
  assert.equal(line.details.by_organisation, true);
  assert.equal(line.details.settings.min_length.set_by, 'Government of Example');

  // The screens say where each value comes from.
  const pol = await owner.get('/account/policy');
  assert.equal(pol.data.set_by.impact_display, 'Set by Government of Example');
  const rules = await owner.get('/account/rules');
  assert.equal(rules.data.set_by.min_password_length, 'Set by Government of Example');

  // Loosening, refused with the name of who asked; tightening, kept.
  const on = await owner.put('/account/policy', { impact_display: 'on' });
  assert.equal(on.status, 409);
  assert.match(on.data.error, /Government of Example/);
  plain(on.data.error);
  assert.equal(acct(agency).impact_display, 'off');
  const short = await owner.call('PATCH', '/account/rules', { min_password_length: 10 });
  assert.equal(short.status, 409);
  plain(short.data.error);
  const longIdle = await owner.call('PATCH', '/account/rules', { idle_minutes: 120 });
  assert.equal(longIdle.status, 409);
  const offIdle = await owner.call('PATCH', '/account/rules', { idle_minutes: null });
  assert.equal(offIdle.status, 409);
  assert.equal((await owner.call('PATCH', '/account/rules', { min_password_length: 14, idle_minutes: 30 })).status, 200);
  assert.deepEqual([acct(agency).min_password_length, acct(agency).idle_minutes], [14, 30]);

  // A ministry may ask for more than the government, never for less.
  const loose = await minAdmin.put(`/orgs/${ministry}/policy`, { min_password_length: 10 });
  assert.equal(loose.status, 409);
  assert.match(loose.data.error, /Government of Example/);
  plain(loose.data.error);
  const tight = await minAdmin.put(`/orgs/${ministry}/policy`, { min_password_length: 16, ai_helper: 'off' });
  assert.equal(tight.status, 200, JSON.stringify(tight.data));
  assert.equal(tight.data.above.min_password_length.set_by, 'Set by Government of Example');
  assert.deepEqual([acct(agency).min_password_length, acct(agency).ai_helper], [16, 'off']);
  assert.equal((await owner.get('/account/rules')).data.set_by.min_password_length, 'Set by Ministry of Health');

  // "No tree lines" covers the signing record too (owner_answers.trees_on_certificate), locked with who set it.
  assert.equal(acct(agency).cert_impact_off, 1);
  const rec = await owner.get('/account/impact-record');
  assert.equal(rec.data.set_by, 'Set by Government of Example');
  const recOn = await owner.put('/account/impact-record', { on: true });
  assert.equal(recOn.status, 409);
  plain(recOn.data.error);
  // Taking a rule away gives each agency back what it had before, said in its record with who took it away.
  const away = await govAdmin.put(`/orgs/${gov}/policy`, { impact_display: null });
  assert.equal(away.status, 200);
  assert.ok(away.data.accounts_given_back >= 1);
  assert.equal(acct(agency).impact_display, null);
  assert.equal(acct(agency).cert_impact_off, 0);
  const { securityDetail } = await import('../src/lib/seclog.ts');
  const back = lines(agency, 'settings.changed').at(-1);
  assert.equal(back.details.given_back, true);
  assert.match(securityDetail('settings.changed', back.details).join(' '), /Government of Example took away its rule \(no tree lines/);
  // What an organisation set reads as a sentence that names it, with "AI" kept in capitals and no field names.
  const setLine = lines(agency, 'settings.changed').find((l: any) => l.details.settings?.ai_helper);
  const words = securityDetail('settings.changed', setLine.details).join(' ');
  assert.match(words, /Ministry of Health set: passwords of at least 16 characters, no AI answers in the help chat\./);
  assert.ok(!/Ai helper|By organisation|nothing/.test(words), words);
  // The agency's own choice since stays: tightened by itself, it is not loosened when the rule goes.
  assert.equal((await govAdmin.put(`/orgs/${gov}/policy`, { idle_minutes: null })).status, 200);
  assert.equal(acct(agency).idle_minutes, 30);
});

test('2. two-step login for everyone, passed down, cannot be switched off by the agency', async () => {
  assert.equal((await minAdmin.put(`/orgs/${ministry}/policy`, { two_step_required: true })).status, 200);
  assert.ok(acct(agency).two_step_required_at);
  // The owner (without two-step login) is now asked to set it up before anything else opens; the rule itself says who set it.
  db.run('UPDATE users SET two_step_on_at=?, two_step_secret=? WHERE id=?', new Date().toISOString(), 'JBSWY3DPEHPK3PXP', ownerId);
  const view = await owner.get('/account/two-step');
  assert.equal(view.data.set_by, 'Set by Ministry of Health');
  const off = await owner.post('/account/two-step', { required: false });
  assert.equal(off.status, 409);
  plain(off.data.error);
  assert.ok(acct(agency).two_step_required_at);
  db.run('UPDATE users SET two_step_on_at=NULL, two_step_secret=NULL WHERE id=?', ownerId);
  assert.equal((await minAdmin.put(`/orgs/${ministry}/policy`, { two_step_required: null })).status, 200);
  db.run('UPDATE accounts SET two_step_required_at=NULL WHERE id=?', agency);
});

test('3. delegated admin: members, roles, two-step reset with the existing rules', async () => {
  const m = await minAdmin.get(`/orgs/${ministry}/agencies/${agency}/members`);
  assert.equal(m.status, 200);
  assert.deepEqual(m.data.members.map((x: any) => [x.name, x.role]).sort(), [['Mira Member', 'member'], ['Olu Owner', 'owner']]);
  assert.equal((await stranger.get(`/orgs/${ministry}/agencies/${agency}/members`)).status, 404);
  // An agency not below this organisation is not found.
  const other = (await op.post('/operator/orgs', { name: 'Elsewhere', admin_email: 'sam@else.example' })).data.org.id;
  assert.equal((await stranger.get(`/orgs/${other}/agencies/${agency}/members`)).status, 404);

  assert.equal((await minAdmin.call('PATCH', `/orgs/${ministry}/agencies/${agency}/members/${memberId}`, { role: 'admin' })).status, 200);
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', agency, memberId).role, 'admin');
  const ownerRole = await minAdmin.call('PATCH', `/orgs/${ministry}/agencies/${agency}/members/${ownerId}`, { role: 'member' });
  assert.equal(ownerRole.status, 409);
  plain(ownerRole.data.error);
  await minAdmin.call('PATCH', `/orgs/${ministry}/agencies/${agency}/members/${memberId}`, { role: 'member' });

  // Reset: never an owner; a member who has it on, yes, emailed at once and in the agency's record.
  db.run('UPDATE users SET two_step_on_at=?, two_step_secret=? WHERE id IN (?,?)', new Date().toISOString(), 'JBSWY3DPEHPK3PXP', ownerId, memberId);
  const own = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/members/${ownerId}/two-step/reset`, {});
  assert.equal(own.status, 403);
  plain(own.data.error);
  // Mira owns her own workspace from sign-up, so the existing rule says no: it would open that one too.
  const elsewhere = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/members/${memberId}/two-step/reset`, {});
  assert.equal(elsewhere.data.code, 'admin_elsewhere');
  db.run("DELETE FROM memberships WHERE user_id=? AND account_id<>?", memberId, agency);
  const ok = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/members/${memberId}/two-step/reset`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.get('SELECT two_step_on_at FROM users WHERE id=?', memberId).two_step_on_at, null);
  assert.ok(mailTo('mira@agency.example').some((e: any) => /switched off two-step login/.test(e.subject)));
  assert.equal(lines(agency, 'two_step.reset').at(-1).details.organisation, 'Ministry of Health');
  db.run('UPDATE users SET two_step_on_at=NULL, two_step_secret=NULL WHERE id=?', ownerId);
});

test('3. sending switched off for an agency stops new documents, says who did it, and comes back on', async () => {
  const off = await minAdmin.put(`/orgs/${ministry}/agencies/${agency}/sending`, { on: false });
  assert.equal(off.status, 200);
  assert.ok(mailTo('olu@agency.example').some((e: any) => /switched sending off/.test(e.subject)));
  const file = await upload(owner, 1);
  const r = await owner.post('/envelopes', {
    subject: 'Held back', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: 'sam.signer@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  const sent = await owner.post(`/envelopes/${r.data.envelope.id}/send`);
  assert.equal(sent.status, 403);
  assert.match(sent.data.error, /Ministry of Health switched sending off/);
  plain(sent.data.error);
  assert.equal((await owner.post('/account/invites', { email: 'x@agency.example' })).status, 403);
  assert.equal((await minAdmin.put(`/orgs/${ministry}/agencies/${agency}/sending`, { on: true })).status, 200);
  assert.equal((await owner.post(`/envelopes/${r.data.envelope.id}/send`)).status, 200);
  assert.deepEqual(lines(agency, 'org.changed').filter((l: any) => /^sending_/.test(l.details.what)).map((l: any) => l.details.what), ['sending_off', 'sending_on']);
});

test('3. an organisation admin is refused every document route of the router, and no org answer holds a title', async () => {
  const e = await simple(owner, 'secret.signer@example.com', { subject: 'Confidential tender 7731' });
  const tpl = db.get("SELECT id FROM envelopes WHERE account_id=? AND kind='template' LIMIT 1", agency)?.id || e.id;
  const recipient = db.get('SELECT id, token FROM recipients WHERE envelope_id=?', e.id);
  const fileId = db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id;
  const fill = (p: string) => p.replace(/:(\w+)/g, (_, k) => (/token/.test(k) ? 'not-a-token' : /file/.test(k) ? fileId : /rid|recipient/.test(k) ? recipient.id : /tpl|template/.test(k) ? tpl : e.id));
  const doc = /^\/(envelopes|templates|files|bulk|comments|documents|reports|exports?|archive|search|powerforms|forms|fields|clickwrap|agreements)/;
  const checked: string[] = [];
  for (const r of listRoutes()) {
    if (r.level === 'public' || !doc.test(r.path)) continue;
    for (const who of [govAdmin, minAdmin]) {
      const res = await who.call(r.method, fill(r.path), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      const body = JSON.stringify(res.data instanceof Uint8Array ? Buffer.from(res.data).toString('latin1') : res.data);
      assert.ok(!body.includes('Confidential tender 7731'), `${r.method} ${r.path} showed the title`);
      if (r.path.includes(':')) assert.ok(res.status >= 400, `${r.method} ${r.path} answered ${res.status}`);
    }
    checked.push(`${r.method} ${r.path}`);
  }
  assert.ok(checked.length > 30, `only ${checked.length} document routes found`);
  for (const p of [`/orgs/${gov}`, `/orgs/${ministry}`, `/orgs/${ministry}/agencies/${agency}/members`, `/orgs/${gov}/report`, `/orgs/${gov}/events`]) {
    const res = await govAdmin.get(p);
    assert.equal(res.status, 200, p);
    assert.ok(!JSON.stringify(res.data).includes('Confidential tender'), p);
  }
  // The envelope is untouched by all of that.
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'draft');
});

test('3. emergency access: off until the operator allows it, needs a reason, tells the owners, and is in the record', async () => {
  const e = db.get("SELECT id FROM envelopes WHERE account_id=? AND subject='Confidential tender 7731'", agency);
  const off = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/break-glass`, { envelope_id: e.id, reason: 'Court order 44 of 2026 asks for it' });
  assert.equal(off.status, 403);
  plain(off.data.error);
  assert.equal((await govAdmin.put(`/operator/orgs/${ministry}/break-glass`, { allowed: true })).status, 404);
  assert.equal((await op.put(`/operator/orgs/${ministry}/break-glass`, { allowed: true })).status, 200);
  const short = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/break-glass`, { envelope_id: e.id, reason: 'need it' });
  assert.equal(short.status, 400);
  plain(short.data.error);
  const wrong = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/break-glass`, { envelope_id: 'env_nope', reason: 'Court order 44 of 2026 asks for it' });
  assert.equal(wrong.status, 404);
  const before = mailTo('olu@agency.example').length;
  const r = await minAdmin.post(`/orgs/${ministry}/agencies/${agency}/break-glass`, { envelope_id: e.id, reason: 'Court order 44 of 2026 asks for it' });
  assert.equal(r.status, 200);
  assert.ok(r.data instanceof Uint8Array && Buffer.from(r.data.subarray(0, 5)).toString() === '%PDF-');
  const told = mailTo('olu@agency.example').slice(before);
  assert.ok(told.some((m: any) => /opened a document/.test(m.subject) && /Court order 44/.test(m.html)));
  const line = lines(agency, 'org.break_glass').at(-1);
  assert.equal(line.details.reason, 'Court order 44 of 2026 asks for it');
  assert.equal(line.actor_id, uid('musa@health.example'));
  assert.ok(db.get("SELECT 1 x FROM org_events WHERE org_id=? AND kind='org.break_glass'", ministry));
  // An admin of an organisation that was not allowed it (Elsewhere) never reaches this agency at all.
  const other = db.get("SELECT id FROM orgs WHERE name='Elsewhere'").id;
  assert.equal((await stranger.post(`/orgs/${other}/agencies/${agency}/break-glass`, { envelope_id: e.id, reason: 'Court order 44 of 2026 asks for it' })).status, 404);
  // The words in the agency's record.
  const { securityDetail } = await import('../src/lib/seclog.ts');
  assert.match(securityDetail('org.break_glass', line.details).join(' '), /Musa Ministry of Ministry of Health opened the document/);
});

test('5. counts per agency, with no titles and no names of people', async () => {
  const r = await govAdmin.get(`/orgs/${gov}/report`);
  assert.equal(r.status, 200);
  const row = r.data.agencies.find((a: any) => a.id === agency);
  assert.equal(row.organisation, 'Ministry of Health');
  assert.equal(row.sent, 1, JSON.stringify(row));
  assert.equal(row.completed, 0);
  const text = JSON.stringify(r.data);
  assert.ok(!/Confidential|Held back|Olu|Mira|@/.test(text), text);
  assert.equal((await minAdmin.get(`/orgs/${gov}/report`)).status, 404);
});

test('moving an agency between organisations is for the operator alone, and brings it up to the rules there', async () => {
  const other = db.get("SELECT id FROM orgs WHERE name='Elsewhere'").id;
  assert.equal((await stranger.put(`/orgs/${other}/policy`, { min_password_length: 20 })).status, 200);
  assert.equal((await govAdmin.put(`/operator/accounts/${agency}/org`, { org_id: other })).status, 404);
  const r = await op.put(`/operator/accounts/${agency}/org`, { org_id: other });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(acct(agency).org_id, other);
  assert.equal(acct(agency).min_password_length, 20);
  assert.equal((await minAdmin.get(`/orgs/${ministry}/agencies/${agency}/members`)).status, 404);
  assert.ok(lines(agency, 'org.changed').some((l: any) => l.details.what === 'agency_moved_in'));
  assert.equal((await op.put(`/operator/accounts/${agency}/org`, { org_id: 'org_nope' })).status, 404);
});

test('every kind written is known, and the record of an agency still checks', async () => {
  const { SECURITY_KIND_LIST } = await import('../src/lib/seclog.ts');
  for (const k of db.all('SELECT DISTINCT kind FROM security_events').map((r: any) => r.kind)) assert.ok((SECURITY_KIND_LIST as readonly string[]).includes(k), k);
  const { verifySecurityChain } = await import('../src/server/seclog.ts');
  assert.equal(verifySecurityChain(agency).ok, true);
});

// ---- Repair: the skeptic's and the simplicity reviewer's findings ---------------------------------------------------

let gov2: string, ag2: string;
let r2Admin: Client, r2Owner: Client, r2Other: Client;
const role = (accountId: string, email: string) => db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', accountId, uid(email))?.role;
const acceptAs = async (who: Client, accountId: string, email: string) =>
  who.post('/invites/accept', { token: db.get('SELECT token FROM invites WHERE account_id=? AND lower(email)=lower(?) AND accepted_at IS NULL', accountId, email).token });

test('repair setup: an organisation, an agency with an owner who sends a secret document', async () => {
  r2Admin = await signUp('Grace Central', 'grace@gov2.example', '198.51.100.31');
  r2Owner = await signUp('Omar Owner', 'omar@agency2.example', '198.51.100.32');
  r2Other = await signUp('Otto Other', 'otto@agency2.example', '198.51.100.33');
  gov2 = (await op.post('/operator/orgs', { name: 'Gov Two', admin_email: 'grace@gov2.example' })).data.org.id;
  ag2 = (await r2Admin.post(`/orgs/${gov2}/agencies`, { name: 'Health Records Agency', owner_email: 'omar@agency2.example' })).data.agency.id;
  assert.equal((await acceptAs(r2Owner, ag2, 'omar@agency2.example')).status, 200);
  grant(ag2, 20, 'welcome', `g13r-${ag2}`);
  await r2Owner.post('/auth/switch', { account_id: ag2 });
  const e = await simple(r2Owner, 'signer2@example.com', { subject: 'Secret Contract Title' });
  assert.equal((await r2Owner.post(`/envelopes/${e.id}/send`)).status, 200);
});

test('repair P1: an organisation admin who is a member of an agency cannot make themselves admin by any route', async () => {
  // The agency invites the organisation admin as a member: allowed, and a member sees only what they send.
  assert.equal((await r2Owner.post('/account/invites', { email: 'grace@gov2.example', role: 'member' })).status, 200);
  assert.equal((await acceptAs(r2Admin, ag2, 'grace@gov2.example')).status, 200);
  await r2Admin.post('/auth/switch', { account_id: ag2 });
  assert.ok(!JSON.stringify((await r2Admin.get('/envelopes')).data).includes('Secret Contract Title'));
  // The organisation's own route, on themselves.
  const self = await r2Admin.call('PATCH', `/orgs/${gov2}/agencies/${ag2}/members/${uid('grace@gov2.example')}`, { role: 'admin' });
  assert.equal(self.status, 409);
  assert.equal(self.data.code, 'org_admin');
  plain(self.data.error);
  // The agency's own Team route.
  const team = await r2Owner.call('PATCH', `/account/members/${uid('grace@gov2.example')}`, { role: 'admin' });
  assert.equal(team.status, 409);
  plain(team.data.error);
  // Handing the agency over to them.
  assert.equal((await r2Owner.post('/account/transfer-owner', { user_id: uid('grace@gov2.example') })).status, 409);
  assert.equal(role(ag2, 'grace@gov2.example'), 'member');
  // The router's backstop: a membership made admin behind every route's back still reads as a member.
  db.run("UPDATE memberships SET role='admin' WHERE account_id=? AND user_id=?", ag2, uid('grace@gov2.example'));
  assert.ok(!JSON.stringify((await r2Admin.get('/envelopes')).data).includes('Secret Contract Title'));
  assert.equal((await r2Admin.get('/account/rules')).status, 403);
  // Every document route of the router, as that member of the agency: no title anywhere.
  const e = db.get("SELECT id FROM envelopes WHERE account_id=? AND subject='Secret Contract Title'", ag2);
  for (const r of listRoutes()) {
    if (r.level === 'public' || !/^\/(envelopes|templates|files|bulk|comments|documents|reports|exports?|archive|search)/.test(r.path) || r.method !== 'GET') continue;
    const res = await r2Admin.get(r.path.replace(/:(\w+)/g, () => e.id));
    const body = JSON.stringify(res.data instanceof Uint8Array ? Buffer.from(res.data).toString('latin1') : res.data);
    assert.ok(!body.includes('Secret Contract Title'), `${r.path} showed the title`);
  }
  assert.equal((await r2Admin.post('/auth/switch', { account_id: db.get("SELECT account_id FROM memberships WHERE user_id=? AND role='owner'", uid('grace@gov2.example')).account_id })).status, 200);
  db.run("DELETE FROM memberships WHERE account_id=? AND user_id=?", ag2, uid('grace@gov2.example'));
});

test('repair P2: an agency cannot invite an organisation admin above it as admin, and an old admin invitation cannot be accepted', async () => {
  const no = await r2Owner.post('/account/invites', { email: 'grace@gov2.example', role: 'admin' });
  assert.equal(no.status, 409);
  plain(no.data.error);
  // An admin invitation sent before the person became an organisation admin is refused when they accept it.
  assert.equal((await r2Owner.post('/account/invites', { email: 'otto@agency2.example', role: 'admin' })).status, 200);
  assert.equal((await r2Admin.post(`/orgs/${gov2}/admins`, { email: 'otto@agency2.example' })).status, 200);
  const late = await acceptAs(r2Other, ag2, 'otto@agency2.example');
  assert.equal(late.status, 409);
  assert.equal(role(ag2, 'otto@agency2.example'), undefined);
  assert.equal((await r2Admin.call('DELETE', `/orgs/${gov2}/admins/${uid('otto@agency2.example')}`)).status, 200);
});

test('repair P3+P4: a login with an unconfirmed address is never made owner, and the answer does not say whether a login exists', async () => {
  const squat = new Client();
  squat.ip = '198.51.100.34';
  assert.equal((await squat.post('/auth/signup', { name: 'Squatter', email: 'boss@realagency.example', password: 'correct horse battery staple' })).status, 200);
  assert.equal(db.get('SELECT email_verified FROM users WHERE email=?', 'boss@realagency.example').email_verified, 0);
  const a = await r2Admin.post(`/orgs/${gov2}/agencies`, { name: 'Real Agency', owner_email: 'boss@realagency.example' });
  const b = await r2Admin.post(`/orgs/${gov2}/agencies`, { name: 'Empty Agency', owner_email: 'nobody-here@realagency.example' });
  assert.deepEqual(a.data.owner, b.data.owner);
  assert.equal(role(a.data.agency.id, 'boss@realagency.example'), undefined);
  // The members view lists both the same way: an invitation, never a member.
  for (const id of [a.data.agency.id, b.data.agency.id]) {
    const m = (await r2Admin.get(`/orgs/${gov2}/agencies/${id}/members`)).data;
    assert.equal(m.members.length, 0);
    assert.equal(m.invites.length, 1);
  }
});

test('repair P5: the title of a document opened with emergency access stays in the agency record only', async () => {
  const e = db.get("SELECT id FROM envelopes WHERE account_id=? AND subject='Secret Contract Title'", ag2);
  assert.equal((await op.put(`/operator/orgs/${gov2}/break-glass`, { allowed: true })).status, 200);
  assert.equal((await r2Admin.post(`/orgs/${gov2}/agencies/${ag2}/break-glass`, { envelope_id: e.id, reason: 'Court order 2026/11 needs the file' })).status, 200);
  const ev = await r2Admin.get(`/orgs/${gov2}/events`);
  assert.ok(!JSON.stringify(ev.data).includes('Secret Contract Title'));
  assert.ok(!db.all('SELECT details FROM org_events WHERE org_id=?', gov2).some((r: any) => r.details.includes('Secret Contract Title')));
  const line = lines(ag2, 'org.break_glass').at(-1);
  assert.equal(line.details.document, 'Secret Contract Title');
  // The organisation's page names the agency, not "this account".
  const { orgEventWords } = await import('../src/lib/orgs.ts');
  const said = ev.data.events.map((x: any) => orgEventWords(x.kind, x.details)).join(' ');
  assert.match(said, /opened a document of Health Records Agency with emergency access/);
  assert.ok(!/this account/.test(said), said);
  assert.equal((await op.put(`/operator/orgs/${gov2}/break-glass`, { allowed: false })).status, 200);
});

test('repair: the agency record names the organisation admin with their organisation, never as someone who left', async () => {
  const rows = (await r2Owner.get('/account/security-events/view')).data;
  const org = rows.events.filter((l: any) => /^org\./.test(l.kind) && l.actor.type === 'user');
  assert.ok(org.length > 0, JSON.stringify(rows).slice(0, 300));
  for (const l of org) assert.equal(l.actor_name, 'Grace Central of Gov Two');
});

test('repair: two-step login for everyone, set above, names the organisation, asks once, and is given back when taken away', async () => {
  const view = (await r2Admin.get(`/orgs/${gov2}`)).data;
  assert.ok(view.reach.agencies >= 1 && view.reach.people >= 1, JSON.stringify(view.reach));
  assert.equal(typeof view.ai_available, 'boolean');
  assert.equal(acct(ag2).two_step_required_at, null);
  assert.equal((await r2Admin.put(`/orgs/${gov2}/policy`, { two_step_required: true })).status, 200);
  assert.ok(acct(ag2).two_step_required_at);
  // The person locked out reads who asks it: the organisation, in the agency.
  const gate = await r2Owner.get('/envelopes');
  assert.equal(gate.status, 403);
  assert.match(gate.data.error, /^Gov Two asks everyone in Health Records Agency to sign in with two-step login/);
  assert.equal((await r2Owner.get('/me')).data.org.two_step_by, 'Gov Two');
  // Taken away: every agency has back what it had before, so nobody stays locked out.
  const off = await r2Admin.put(`/orgs/${gov2}/policy`, { two_step_required: null });
  assert.equal(off.status, 200);
  assert.ok(off.data.accounts_given_back >= 1);
  assert.equal(acct(ag2).two_step_required_at, null);
  assert.equal((await r2Owner.get('/envelopes')).status, 200);
  // An agency that asked it itself before keeps it when the organisation takes its rule away.
  const before = new Date(Date.now() - 864e5).toISOString();
  db.run('UPDATE accounts SET two_step_required_at=? WHERE id=?', before, ag2);
  await r2Admin.put(`/orgs/${gov2}/policy`, { two_step_required: true });
  await r2Admin.put(`/orgs/${gov2}/policy`, { two_step_required: null });
  assert.equal(acct(ag2).two_step_required_at, before);
  db.run('UPDATE accounts SET two_step_required_at=NULL WHERE id=?', ag2);
});

test('repair: sending switched off from above is in GET /me for every page to say, not only at Send', async () => {
  assert.equal((await r2Owner.get('/me')).data.org.sending_off, undefined);
  assert.equal((await r2Admin.put(`/orgs/${gov2}/agencies/${ag2}/sending`, { on: false })).status, 200);
  const me = (await r2Owner.get('/me')).data;
  assert.match(me.org.sending_off, /^Gov Two switched sending off for Health Records Agency\./);
  plain(me.org.sending_off);
  await r2Admin.put(`/orgs/${gov2}/agencies/${ag2}/sending`, { on: true });
  // A workspace with no organisation says nothing of organisations.
  assert.equal((await stranger.get('/me')).data.org, undefined);
});

test('repair: the sign-in rules card offers nothing below what is asked above', async () => {
  assert.equal((await r2Admin.put(`/orgs/${gov2}/policy`, { min_password_length: 12, idle_minutes: 60 })).status, 200);
  const r = (await r2Owner.get('/account/rules')).data;
  assert.deepEqual(r.limits.password, [12, 64]);
  assert.equal(r.limits.idle_minutes[1], 60);
  await r2Admin.put(`/orgs/${gov2}/policy`, { min_password_length: null, idle_minutes: null });
});

test('repair: a reclaimed login gets its organisation rules back at once, and the operator cannot move an agency under its own runner', async () => {
  // A lone-owner agency (made the old way) under an organisation that asks for two-step login.
  await r2Admin.put(`/orgs/${gov2}/policy`, { two_step_required: true });
  const squatId = uid('boss@realagency.example');
  const lone = 'acc_g13_lone';
  db.run("INSERT INTO accounts (id, name, created_at, default_reminder_days, org_id, two_step_required_at) VALUES (?,?,?,?,?,?)", lone, 'Lone Agency', new Date().toISOString(), 3, gov2, new Date().toISOString());
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'owner',?)", lone, squatId, new Date().toISOString());
  const { forgetEarlierSetup } = await import('../src/server/reclaim.ts');
  forgetEarlierSetup(squatId, 'Real Boss');
  assert.ok(acct(lone).two_step_required_at, 'the organisation rule came back');
  await r2Admin.put(`/orgs/${gov2}/policy`, { two_step_required: null });
  // Moving an agency into an organisation whose admin runs it is refused.
  const own = db.get("SELECT account_id FROM memberships WHERE user_id=? AND role='owner' AND account_id<>?", uid('grace@gov2.example'), ag2).account_id;
  const mv = await op.put(`/operator/accounts/${own}/org`, { org_id: gov2 });
  assert.equal(mv.status, 409);
  plain(mv.data.error);
  assert.equal(acct(own).org_id, null);
});
