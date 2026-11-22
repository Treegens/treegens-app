// Working for a colleague (src/server/shares.ts): sharing one's documents with someone in the same account at a level
// ('see', 'manage', 'send for me') for some days, every action through a share naming both people, moving envelopes
// and templates to another member, and sending in a colleague's name so recipients read both names everywhere.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, simple, signAll, upload, tokenFor, type Server } from './helpers.ts';
import { shareDatesProblem, levelRefusal, sentByName, LEVEL_WORDS, SHARE_LEVELS } from '../src/lib/shares.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.88.${Math.floor(++n / 250)}.${n % 250}`;
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = Object.assign(new Client(), { ip: ip() });
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
const idOf = async (c: Client) => (await c.get('/me')).data.user.id as string;
const del = (c: Client, u: string) => c.call('DELETE', u);
const withKey = (key: string) => {
  const c = Object.assign(new Client(), { ip: ip() });
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${key}`, ...h });
  return c;
};

let teams = 0;
async function team() {
  const t = ++teams;
  const owner = await signUp('Olive Owner', `olive.${t}@col.example.com`, ip());
  const ben = await join(owner, 'Ben Okoro', `ben.${t}@col.example.com`);
  const ana = await join(owner, 'Ana Silva', `ana.${t}@col.example.com`);
  const carl = await join(owner, 'Carl Other', `carl.${t}@col.example.com`);
  const ids = { owner: await idOf(owner), ben: await idOf(ben), ana: await idOf(ana), carl: await idOf(carl) };
  return { t, owner, ben, ana, carl, ids };
}
const today = () => new Date().toISOString().slice(0, 10);
const dayAfter = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
// Two sentences, the second starts with a verb (charter P10).
const twoSentences = (s: string) => {
  const parts = String(s).split(/(?<=\.)\s+/).filter(Boolean);
  assert.ok(parts.length >= 2, `not two sentences: ${s}`);
  assert.ok(!/—/.test(s), `em dash in: ${s}`);
};

test('the words: levels, dates, refusals, no em dashes', () => {
  assert.deepEqual(SHARE_LEVELS, ['see', 'manage', 'send']);
  for (const l of SHARE_LEVELS) assert.ok(!/—/.test(LEVEL_WORDS[l].covers));
  const t = '2027-03-10';
  assert.equal(shareDatesProblem('2027-03-10', '', t), null);
  assert.equal(shareDatesProblem('2027-03-10', '2027-03-12', t), null);
  assert.match(shareDatesProblem('2027-03-09', '', t)!, /past/);
  assert.match(shareDatesProblem('2027-03-12', '2027-03-11', t)!, /before the first day/);
  assert.match(shareDatesProblem('2028-04-12', '', t)!, /at most a year/);
  assert.match(shareDatesProblem('nonsense', '', t)!, /first day/);
  twoSentences(levelRefusal('Ben Okoro', 'see', 'manage'));
  assert.equal(sentByName('Ben Okoro', 'Ana Silva'), 'Ben Okoro (sent by Ana Silva)');
});

test('members without a share see nothing; a share at "see" opens and lists, and nothing more', async () => {
  const { ben, ana, carl, ids } = await team();
  const e = await simple(ben, 'sam.see@example.com', { send: true });
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await carl.get(`/envelopes/${e.id}`)).status, 404);
  const s = await ben.post('/me/shares', { grantee: ids.ana, level: 'see' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.share.active, true);
  // Carl still sees nothing.
  assert.equal((await carl.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await carl.get('/envelopes?shared=1')).data.envelopes.length, 0);
  const got = await ana.get(`/envelopes/${e.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.data.shared, { owner: 'Ben Okoro', level: 'see' });
  // Her list shows it with nobody chosen, marked with the level, so it is never hidden behind "Sent by"; "Sent by me"
  // is still only her own, and "Shared with me" has it.
  assert.deepEqual((await ana.get('/envelopes')).data.envelopes.map((x: any) => [x.id, x.shared_level]), [[e.id, 'see']]);
  assert.equal((await ana.get(`/envelopes?sender=${ids.ana}`)).data.envelopes.length, 0);
  assert.deepEqual((await ana.get('/envelopes?shared=1')).data.envelopes.map((x: any) => x.id), [e.id]);
  // Each thing beyond seeing is refused in words, and nothing changed.
  for (const [m, u] of [['POST', `/envelopes/${e.id}/remind`], ['GET', `/envelopes/${e.id}/download`], ['POST', `/envelopes/${e.id}/void`], ['POST', `/envelopes/${e.id}/extend`]] as const) {
    const r = await ana.call(m, u, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.data.code, 'share_level');
    twoSentences(r.data.error);
  }
  // Deleting is never through a share.
  const d = await del(ana, `/envelopes/${e.id}`);
  assert.equal(d.status, 403);
  assert.equal(d.data.code, 'not_in_share');
  twoSentences(d.data.error);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'sent');
  // An API key of hers carries the same share, no more.
  const key = withKey((await ana.post('/api-keys', { name: 'script' })).data.key);
  assert.equal((await key.get(`/envelopes/${e.id}`)).status, 200);
  assert.equal((await key.post(`/envelopes/${e.id}/remind`, {})).status, 403);
});

test('"manage" allows remind, correct, void, download; not sending; audit and security record name both', async () => {
  const { ben, ana, ids } = await team();
  const e = await simple(ben, 'sam.manage@example.com', { send: true });
  const draftId = (await simple(ben, 'sam.draft@example.com')).id;
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'manage' })).status, 200);
  const r = await ana.post(`/envelopes/${e.id}/remind`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await ana.get(`/envelopes/${e.id}/download`)).status, 200);
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', e.id).id;
  const c = await ana.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'sam.fixed@example.com' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const trail = db.all('SELECT actor, action FROM audit WHERE envelope_id=? ORDER BY seq', e.id);
  const byAna = trail.filter((a) => a.actor.startsWith('Ana Silva'));
  assert.ok(byAna.length >= 2, JSON.stringify(trail));
  for (const a of byAna) assert.match(a.actor, /^Ana Silva <ana\.\d+@col\.example\.com> for Ben Okoro$/);
  assert.ok(byAna.some((a) => /correct/i.test(a.action)), JSON.stringify(byAna));
  // Sending a draft is beyond managing.
  const s = await ana.post(`/envelopes/${draftId}/send`, {});
  assert.equal(s.status, 403);
  assert.equal(s.data.code, 'share_level');
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', draftId).status, 'draft');
  // Cancel, then the security record of the deletion names whom it was for... cancelling writes the audit line.
  assert.equal((await ana.post(`/envelopes/${e.id}/void`, { reason: 'Wrong person' })).status, 200);
  assert.ok(db.all('SELECT actor FROM audit WHERE envelope_id=? AND action LIKE ?', e.id, '%oid%').some((a) => / for Ben Okoro$/.test(a.actor)));
  // The share itself is in the security record.
  const line = db.get("SELECT details FROM security_events WHERE kind='share.given' ORDER BY seq DESC LIMIT 1");
  assert.match(line.details, /Ana Silva/);
  assert.match(line.details, /Manage/);
});

test('an action through a share leaves "for" in the security record', async () => {
  const { ben, ana, ids } = await team();
  const file = await upload(ben, 1);
  // A draft, cancelled by Ben, then deleted... deleting is not through a share, so use a sent one Ana cancels and a
  // record() line written for it: the download of an evidence pack is not recorded, so check via a direct record.
  const e = await simple(ben, 'sam.rec@example.com', { send: true });
  void file;
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'manage' })).status, 200);
  const { record } = await import('../src/server/seclog.ts');
  const { shareFor } = await import('../src/server/shares.ts');
  // A request as Ana through the share, the way a route does it.
  const auth = db.get('SELECT u.* FROM users u WHERE u.id=?', ids.ana);
  const account = db.get('SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=?', ids.ben);
  const env = db.get('SELECT * FROM envelopes WHERE id=?', e.id);
  const c: any = { req: new Request(`http://test.local/api/envelopes/${e.id}/remind`, { method: 'POST' }), url: new URL(`http://test.local/api/envelopes/${e.id}/remind`), user: auth, account, auth: { via: 'session' }, actor: { name: `${auth.name} <${auth.email}>` }, ip: '1.2.3.4', ua: '' };
  assert.equal(shareFor(c, env), true);
  assert.match(c.actor.name, / for Ben Okoro$/);
  record('envelope.deleted', { c, about: ['envelope', e.id], details: { status: 'sent' } });
  const line = db.get("SELECT details, actor_id FROM security_events WHERE kind='envelope.deleted' AND about_id=? ORDER BY seq DESC LIMIT 1", e.id);
  assert.equal(line.actor_id, ids.ana);
  assert.equal(JSON.parse(line.details).for, 'Ben Okoro');
});

test('dates are respected, and an ended share stops at once for the next request', async () => {
  const { ben, ana, owner, ids } = await team();
  const e = await simple(ben, 'sam.dates@example.com', { send: true });
  // Starting tomorrow: nothing yet.
  const later = await ben.post('/me/shares', { grantee: ids.ana, level: 'manage', starts_on: dayAfter(1) });
  assert.equal(later.status, 200, JSON.stringify(later.data));
  assert.equal(later.data.share.waiting, true);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 404);
  // Past start and bad dates are refused in words.
  for (const body of [{ starts_on: '2020-01-01' }, { starts_on: today(), ends_on: '2020-01-01' }, { level: 'everything' }]) {
    const r = await ben.post('/me/shares', { grantee: ids.ana, level: 'see', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    twoSentences(r.data.error);
  }
  // A share whose last day has passed (written straight into the table) lets nothing through.
  db.run("UPDATE shares SET starts_on='2020-01-01', ends_on='2020-01-02' WHERE owner_id=? AND grantee_id=? AND ended_at IS NULL", ids.ben, ids.ana);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 404);
  // Today, until ended: in. Ending it: out on the very next request.
  const now = await ben.post('/me/shares', { grantee: ids.ana, level: 'see', starts_on: today(), ends_on: today() });
  assert.equal(now.status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM shares WHERE owner_id=? AND grantee_id=? AND ended_at IS NULL', ids.ben, ids.ana).n, 1, 'one open share per pair');
  assert.equal((await del(ben, `/me/shares/${now.data.share.id}`)).status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 404);
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE kind='share.ended'"));
  // An admin ends one; another member cannot.
  const again = await ben.post('/me/shares', { grantee: ids.ana, level: 'see' });
  const { carl } = { carl: await join(owner, 'Cleo Curious', `cleo.${Date.now()}@col.example.com`) };
  assert.equal((await del(carl, `/me/shares/${again.data.share.id}`)).status, 404);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 200);
  const all = (await owner.get('/me/shares')).data.all;
  assert.ok(all.some((s: any) => s.id === again.data.share.id));
  assert.equal((await del(owner, `/me/shares/${again.data.share.id}`)).status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 404);
  // Lists given and received.
  const third = await ben.post('/me/shares', { grantee: ids.ana, level: 'see' });
  assert.equal((await ben.get('/me/shares')).data.given[0].id, third.data.share.id);
  assert.equal((await ana.get('/me/shares')).data.received[0].owner.name, 'Ben Okoro');
  // The colleague may end what they received.
  assert.equal((await del(ana, `/me/shares/${third.data.share.id}`)).status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 404);
});

test('a share stops when either person leaves the account, and never reaches another account', async () => {
  const { ben, ana, owner, ids } = await team();
  const e = await simple(ben, 'sam.leave@example.com', { send: true });
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'manage' })).status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 200);
  // Someone outside the account cannot be a grantee.
  const stranger = await signUp('Stan Stranger', `stan.${teams}@elsewhere.example.com`, ip());
  const r = await ben.post('/me/shares', { grantee: `stan.${teams}@elsewhere.example.com`, level: 'see' });
  assert.equal(r.status, 400);
  twoSentences(r.data.error);
  assert.equal((await stranger.get(`/envelopes/${e.id}`)).status, 404);
  // Ana is removed: the share no longer counts, also if she were to come back.
  const rm = await owner.call('DELETE', `/account/members/${ids.ana}`, { hand_to: ids.owner });
  assert.equal(rm.status, 200, JSON.stringify(rm.data));
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 401);
  assert.equal(db.get('SELECT 1 x FROM memberships WHERE user_id=?', ids.ana), null);
  const { isActive } = await import('../src/server/shares.ts');
  assert.equal(isActive(db.get('SELECT * FROM shares WHERE grantee_id=?', ids.ana)), false);
});

test('"send for me": drafts, sending, and on_behalf_of show both names in emails, on the signing page and the certificate', async () => {
  const { ben, ana, carl, ids } = await team();
  // Without a share, sending in Ben's name is refused.
  const file = await upload(ana, 1);
  const body = {
    subject: 'Lease for the depot', on_behalf_of: ids.ben, send: true,
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Rita Renter', email: `rita.${teams}@example.com` }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  };
  const no = await ana.post('/envelopes', body);
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'not_shared');
  twoSentences(no.data.error);
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'manage' })).status, 200);
  assert.equal((await ana.post('/envelopes', body)).status, 403, 'manage does not send');
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'send' })).status, 200);
  const ok = await ana.post('/envelopes', body);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const e = db.get('SELECT * FROM envelopes WHERE id=?', ok.data.envelope.id);
  assert.equal(e.sender_id, ids.ben);
  assert.equal(e.sent_by_id, ids.ana);
  // Ben has it in his own list; Carl does not.
  assert.ok((await ben.get('/envelopes')).data.envelopes.some((x: any) => x.id === e.id));
  assert.equal((await carl.get(`/envelopes/${e.id}`)).status, 404);
  // The invitation: From line and a line in the email.
  const mail = db.get('SELECT payload, html FROM emails WHERE envelope_id=? AND to_email=? ORDER BY id LIMIT 1', e.id, `rita.${teams}@example.com`);
  assert.match(JSON.parse(mail.payload).from, /^"Ben Okoro \(sent by Ana Silva\) via GrowSigning"/);
  assert.match(mail.html, /Ana Silva sent this for Ben Okoro\./);
  // The audit trail names who pressed Send, for whom.
  assert.ok(db.all('SELECT actor, action FROM audit WHERE envelope_id=?', e.id).some((a) => /^Ana Silva <.*> for Ben Okoro$/.test(a.actor) && /sent/i.test(a.action)));
  // The signing page.
  const view = await new Client().get(`/sign/${tokenFor(e.id, `rita.${teams}@example.com`)}`);
  // The From line names both (ConsentTop.tsx builds it from sent_by); sentences use the owner's plain name.
  assert.equal(view.data.envelope.sender.name, 'Ben Okoro');
  assert.equal(view.data.envelope.sender.sent_by, 'Ana Silva');
  // The envelope page for Ben says who sent it.
  assert.equal((await ben.get(`/envelopes/${e.id}`)).data.sent_by_name, 'Ana Silva');
  // The certificate, once signed.
  const signed = await signAll(e.id, `rita.${teams}@example.com`);
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  const pdf = await ben.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  const { extractPages } = await import('../src/server/text.ts');
  const text = (await extractPages(pdf.data)).join('\n');
  assert.match(text, /Sent by/);
  assert.match(text.replace(/\s+/g, ' '), /Ana Silva <ana\.\d+@col\.example\.com>, for Ben Okoro/);
  // A draft Ben made himself: Ana sends it, and is named.
  const d = await simple(ben, `sam.d.${teams}@example.com`);
  assert.equal((await ana.post(`/envelopes/${d.id}/send`, {})).status, 200);
  assert.equal(db.get('SELECT sent_by_id FROM envelopes WHERE id=?', d.id).sent_by_id, ids.ana);
  // A draft Ana made for Ben that Ben sends himself is Ben's alone: nobody else is named.
  const own = await ana.post('/envelopes', { ...body, send: false, subject: 'Ben sends this one' });
  assert.equal(own.status, 200);
  assert.equal((await ben.post(`/envelopes/${own.data.envelope.id}/send`, {})).status, 200);
  assert.equal(db.get('SELECT sent_by_id FROM envelopes WHERE id=?', own.data.envelope.id).sent_by_id, null);
  // A template in his name.
  const tpl = await ana.post('/envelopes', { ...body, kind: 'template', send: false, subject: 'Depot lease template' });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', tpl.data.envelope.id).sender_id, ids.ben);
  // Somebody not in the account, and oneself, by address.
  assert.equal((await ana.post('/envelopes', { ...body, on_behalf_of: 'nobody@nowhere.example' })).status, 400);
});

test('an admin-scope key sends for a member with on_behalf_of; a send-scope key without a share cannot', async () => {
  const { owner, ben, ana, ids } = await team();
  const adminKey = withKey((await owner.post('/api-keys', { name: 'crm', scope: 'admin' })).data.key);
  const file = await upload(owner, 1);
  const body = {
    subject: 'Order 114', on_behalf_of: `ben.${teams}@col.example.com`, send: true,
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Kim Buyer', email: `kim.${teams}@example.com` }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  };
  const r = await adminKey.post('/envelopes', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = db.get('SELECT sender_id, sent_by_id FROM envelopes WHERE id=?', r.data.envelope.id);
  assert.equal(e.sender_id, ids.ben);
  assert.equal(e.sent_by_id, ids.owner);
  const mail = db.get('SELECT payload FROM emails WHERE envelope_id=? AND to_email=?', r.data.envelope.id, `kim.${teams}@example.com`);
  assert.match(JSON.parse(mail.payload).from, /Ben Okoro \(sent by Olive Owner\)/);
  // Ana's send key, no share from Ben.
  const anaKey = withKey((await ana.post('/api-keys', { name: 'mine' })).data.key);
  const f2 = await upload(ana, 1);
  const no = await anaKey.post('/envelopes', { ...body, documents: [{ id: 'd', file_id: f2.id }] });
  assert.equal(no.status, 403);
  void ben;
});

test('moving: the owner or an admin moves envelopes and templates; audit says who; the certificate keeps the first sender', async () => {
  const { owner, ben, ana, carl, ids } = await team();
  const e = await simple(ben, `sam.move.${teams}@example.com`, { send: true });
  const file = await upload(ben, 1);
  const tpl = await ben.post('/envelopes', { kind: 'template', subject: 'Ben template', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }], fields: [] });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  // Someone else's: refused, nothing moved.
  const no = await carl.post(`/envelopes/${e.id}/move`, { to: ids.carl });
  assert.equal(no.status, 404, JSON.stringify(no.data));
  const no2 = await carl.post('/envelopes/move', { ids: [e.id], to: ids.carl });
  assert.equal(no2.status, 404);
  assert.ok(!no2.data.error.includes('Simple agreement'), 'never names a document the caller may not see');
  twoSentences(no2.data.error);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', e.id).sender_id, ids.ben);
  // To someone outside, or to the same person: refused.
  assert.equal((await ben.post(`/envelopes/${e.id}/move`, { to: 'x@nowhere.example' })).status, 400);
  assert.equal((await ben.post(`/envelopes/${e.id}/move`, { to: ids.ben })).status, 400);
  // Ben moves his envelope and template to Ana.
  const ok = await ben.post('/envelopes/move', { ids: [e.id, tpl.data.envelope.id], to: ids.ana });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.moved, 2);
  const after = db.get('SELECT sender_id, original_sender_id FROM envelopes WHERE id=?', e.id);
  assert.equal(after.sender_id, ids.ana);
  assert.equal(after.original_sender_id, ids.ben);
  const line = db.get("SELECT actor, detail FROM audit WHERE envelope_id=? AND action='Moved'", e.id);
  assert.match(line.detail, /^Moved from Ben Okoro <.*> to Ana Silva <.*> by Ben Okoro <.*>\.$/);
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE kind='envelope.moved' AND about_id=?", e.id));
  // Ben no longer has it; Ana does.
  assert.equal((await ben.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).data.first_sender_name, 'Ben Okoro');
  // An admin moves it on to Carl; the first sender stays Ben.
  assert.equal((await owner.post(`/envelopes/${e.id}/move`, { to: ids.carl })).status, 200);
  assert.equal(db.get('SELECT original_sender_id FROM envelopes WHERE id=?', e.id).original_sender_id, ids.ben);
  assert.match(db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Moved' ORDER BY seq DESC LIMIT 1", e.id).detail, /by Olive Owner/);
  // Signed: the certificate names Ben as the sender.
  assert.equal((await signAll(e.id, `sam.move.${teams}@example.com`)).status, 200);
  const pdf = await carl.get(`/envelopes/${e.id}/download`);
  const { extractPages } = await import('../src/server/text.ts');
  const text = (await extractPages(pdf.data)).join('\n').replace(/\s+/g, ' ');
  assert.match(text, /Sender Ben Okoro <ben\.\d+@col\.example\.com>/);
  assert.match(text, /Moved from Ben Okoro/);
  // Settings, Team: all of a member's documents at once, for admins only.
  const d1 = await simple(carl, `sam.m1.${teams}@example.com`);
  assert.equal((await ana.post(`/account/members/${ids.carl}/move-documents`, { to: ids.ana })).status, 403);
  const all = await owner.post(`/account/members/${ids.carl}/move-documents`, { to: ids.ana });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.ok(all.data.moved >= 2);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', d1.id).sender_id, ids.ana);
});

test('step 3 "Send for": only with a send share, only on one\'s own draft, and it can be taken back', async () => {
  const { ben, ana, carl, ids } = await team();
  const d = await simple(ana, `sam.sf.${teams}@example.com`);
  assert.deepEqual((await ana.get('/me/sends-for')).data.people, []);
  const no = await ana.post(`/envelopes/${d.id}/send-for`, { on_behalf_of: ids.ben });
  assert.equal(no.status, 403);
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'send' })).status, 200);
  assert.deepEqual((await ana.get('/me/sends-for')).data.people, [{ id: ids.ben, name: 'Ben Okoro' }]);
  // Somebody else's draft: not found.
  assert.equal((await carl.post(`/envelopes/${d.id}/send-for`, { on_behalf_of: ids.carl })).status, 404);
  const ok = await ana.post(`/envelopes/${d.id}/send-for`, { on_behalf_of: ids.ben });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  let row = db.get('SELECT sender_id, sent_by_id, original_sender_id FROM envelopes WHERE id=?', d.id);
  assert.equal(row.sender_id, ids.ben);
  assert.equal(row.sent_by_id, ids.ana);
  assert.equal(row.original_sender_id, null, 'not a move: the certificate names Ben as the sender');
  // She still edits it through the share, and can take it back.
  assert.equal((await ana.put(`/envelopes/${d.id}`, { subject: 'Changed by Ana' })).status, 200);
  assert.equal((await ana.post(`/envelopes/${d.id}/send-for`, { on_behalf_of: '' })).status, 200);
  row = db.get('SELECT sender_id, sent_by_id FROM envelopes WHERE id=?', d.id);
  assert.equal(row.sender_id, ids.ana);
  assert.equal(row.sent_by_id, null);
  // Signing links are never handed out through a share.
  const sent = await simple(ben, `sam.rv.${teams}@example.com`, { send: true });
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', sent.id).id;
  const rv = await ana.post(`/envelopes/${sent.id}/recipient-view`, { recipient_id: rid });
  assert.equal(rv.status, 403);
  assert.equal(rv.data.code, 'not_in_share');
  // "Shared with me by" in Documents: the colleague's documents under Sent by.
  const list = (await ana.get('/envelopes')).data;
  assert.ok(list.senders.some((s: any) => s.id === ids.ben && s.shared));
  assert.ok((await ana.get(`/envelopes?sender=${ids.ben}`)).data.envelopes.some((x: any) => x.id === sent.id));
  assert.equal((await carl.get(`/envelopes?sender=${ids.ben}`)).data.envelopes.some((x: any) => x.id === sent.id), false);
});

// ---- Repairs after review (repair-ds-colleagues) ---------------------------------------------------------------

test('leaving ends a share for good: a removed member who is invited back does not get it back, nor does a returning owner', async () => {
  const { owner, ben, ana, ids, t } = await team();
  const e = await simple(ben, `sam.back.${t}@example.com`, { send: true });
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'manage' })).status, 200);
  assert.equal((await ana.get(`/envelopes/${e.id}`)).status, 200);
  assert.equal((await owner.call('DELETE', `/account/members/${ids.ana}`)).status, 200);
  const row = db.get('SELECT * FROM shares WHERE grantee_id=? ORDER BY created_at DESC LIMIT 1', ids.ana);
  assert.ok(row.ended_at, 'removing her ends the share row');
  assert.match(db.get("SELECT details FROM security_events WHERE kind='share.ended' ORDER BY seq DESC LIMIT 1").details, /left the account/);
  // Invited back, she signs in with the invitation: the old share stays ended.
  assert.equal((await owner.post('/account/invites', { email: `ana.${t}@col.example.com`, role: 'member' })).status, 200);
  const back = Object.assign(new Client(), { ip: ip() });
  const li = await back.post('/auth/login', { email: `ana.${t}@col.example.com`, password: PW, invite: inviteFor(`ana.${t}@col.example.com`) });
  assert.equal(li.status, 200, JSON.stringify(li.data));
  assert.equal((await back.get('/me')).data.account.id, (await owner.get('/me')).data.account.id);
  assert.equal((await back.get(`/envelopes/${e.id}`)).status, 404);
  assert.deepEqual((await back.get('/me/shares')).data.received, []);
  // Even a share row someone left open (an older database) is not in force: she joined again after it was given.
  const { isActive } = await import('../src/server/shares.ts');
  assert.equal(isActive({ ...row, ended_at: null }), false);
  // The owner of a share leaving and coming back: the same.
  const ben2 = await join(owner, 'Bea Back', `bea.${t}@col.example.com`);
  const beaId = await idOf(ben2);
  const e2 = await simple(ben2, `sam.bea.${t}@example.com`, { send: true });
  assert.equal((await ben2.post('/me/shares', { grantee: ids.carl, level: 'see' })).status, 200);
  assert.equal((await ben2.post('/account/leave', { to: ids.owner })).status, 200);
  assert.equal((await owner.post('/account/invites', { email: `bea.${t}@col.example.com`, role: 'member' })).status, 200);
  const bea = Object.assign(new Client(), { ip: ip() });
  assert.equal((await bea.post('/auth/login', { email: `bea.${t}@col.example.com`, password: PW, invite: inviteFor(`bea.${t}@col.example.com`) })).status, 200);
  // Her envelope went to the owner when she left; even moved back to her, Carl's old share does not open it.
  assert.equal((await owner.post(`/envelopes/${e2.id}/move`, { to: beaId })).status, 200);
  const carlRow = db.get('SELECT * FROM shares WHERE owner_id=? ORDER BY created_at DESC LIMIT 1', beaId);
  assert.ok(carlRow.ended_at);
  assert.equal(isActive({ ...carlRow, ended_at: null }), false);
});

test('a draft made with "Send for" goes back to whoever made it when the share ends', async () => {
  const { ben, ana, owner, ids, t } = await team();
  const s = await ben.post('/me/shares', { grantee: ids.ana, level: 'send' });
  const d = await simple(ana, `sam.back2.${t}@example.com`);
  assert.equal((await ana.post(`/envelopes/${d.id}/send-for`, { on_behalf_of: ids.ben })).status, 200);
  // A scheduled one stays with Ben: handing it back would send it from Ana at that time.
  const d2 = await simple(ana, `sam.back3.${t}@example.com`);
  assert.equal((await ana.post(`/envelopes/${d2.id}/send-for`, { on_behalf_of: ids.ben })).status, 200);
  db.run('UPDATE envelopes SET send_at=? WHERE id=?', new Date(Date.now() + 864e5).toISOString(), d2.id);
  assert.equal((await del(ben, `/me/shares/${s.data.share.id}`)).status, 200);
  const row = db.get('SELECT sender_id, sent_by_id FROM envelopes WHERE id=?', d.id);
  assert.deepEqual([row.sender_id, row.sent_by_id], [ids.ana, null]);
  assert.equal((await ana.get(`/envelopes/${d.id}`)).status, 200);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', d2.id).sender_id, ids.ben);
  // The same when the colleague who made it leaves the account: it goes with her, so it is handed on with hers.
  const s2 = await ben.post('/me/shares', { grantee: ids.ana, level: 'send' });
  assert.equal(s2.status, 200);
  const d3 = await simple(ana, `sam.back4.${t}@example.com`);
  assert.equal((await ana.post(`/envelopes/${d3.id}/send-for`, { on_behalf_of: ids.ben })).status, 200);
  assert.equal((await owner.call('DELETE', `/account/members/${ids.ana}`)).status, 200);
  const r3 = db.get('SELECT sender_id, sent_by_id FROM envelopes WHERE id=?', d3.id);
  assert.deepEqual([r3.sender_id, r3.sent_by_id], [ids.owner, null], 'handed with her own documents to the person who removed her');
});

test('"see" opens no file content; deleted-after-signing envelopes move only by an admin; several at once; counts first', async () => {
  const { owner, ben, ana, carl, ids, t } = await team();
  const e = await simple(ben, `sam.f.${t}@example.com`, { send: true });
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'see' })).status, 200);
  const fileId = db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id;
  const f = await ana.get(`/files/${fileId}/content`);
  assert.equal(f.status, 403, 'See follows a document without opening its file');
  assert.equal(f.data.code, 'share_level');
  assert.match(LEVEL_WORDS.see.covers, /cannot open the files/);
  assert.ok(!/template/i.test(LEVEL_WORDS.send.covers), 'no screen makes a template in someone else\'s name');
  // Deleted by its sender after somebody signed: the sender cannot move it, an admin can.
  const h = await simple(ben, `sam.h.${t}@example.com`, { send: true });
  db.run('UPDATE envelopes SET hidden_at=? WHERE id=?', new Date().toISOString(), h.id);
  const mv = await ben.post(`/envelopes/${h.id}/move`, { to: ids.carl });
  assert.equal(mv.status, 404);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', h.id).sender_id, ids.ben);
  assert.equal((await owner.post(`/envelopes/${h.id}/move`, { to: ids.carl })).status, 200);
  // Several chosen in the list, at once.
  const a = await simple(carl, `sam.a.${t}@example.com`, { send: true });
  const b = await simple(carl, `sam.b.${t}@example.com`, { send: true });
  const many = await carl.post('/envelopes/move', { ids: [a.id, b.id], to: ids.ana });
  assert.equal(many.status, 200, JSON.stringify(many.data));
  assert.equal(many.data.moved, 2);
  // "Move a member's documents" asks with numbers first; members cannot ask.
  assert.equal((await ana.get(`/account/members/${ids.carl}/move-documents`)).status, 403);
  const n = await owner.get(`/account/members/${ids.ana}/move-documents`);
  assert.equal(n.status, 200, JSON.stringify(n.data));
  assert.ok(n.data.documents >= 2);
  assert.equal(typeof n.data.templates, 'number');
  assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE sender_id=? AND kind='envelope'", ids.ana).n, n.data.documents, 'counting moved nothing');
});

test('the pages offer a colleague only what the share allows, and Settings keeps a member to 4 sections', async () => {
  const { shareAllows, sentForAfter, commentsReadOnly, sharedLine } = await import('../src/lib/shares.ts');
  // Questions and comments: written at manage and send, read only at see. Signing links: never through a share.
  assert.equal(shareAllows('see', 'comment'), false);
  assert.equal(shareAllows('manage', 'comment'), true);
  for (const l of SHARE_LEVELS) assert.equal(shareAllows(l, 'links'), false);
  assert.equal(shareAllows('see', 'edit'), false);
  assert.equal(shareAllows('see', 'remind'), false);
  assert.equal(shareAllows('manage', 'edit'), true);
  for (const s of [sentForAfter('Ben Okoro', 'Kim Buyer has'), commentsReadOnly('Ben Okoro'), sharedLine('Ben Okoro', 'see')]) {
    assert.ok(!/—/.test(s));
    assert.ok(!/\bOpen your documents\b/.test(s));
  }
  assert.match(sentForAfter('Ben Okoro', 'Kim Buyer has'), /^We email Ben Okoro when Kim Buyer has finished\./);
  const { sectionsFor, landingFor, SETTINGS_MAX, awayInTeam, AWAY_ANCHOR } = await import('../src/lib/settingsnav.ts');
  const member = sectionsFor('member', false, null, true).map(([k]) => k);
  assert.ok(member.length <= SETTINGS_MAX.member, member.join());
  assert.ok(!member.includes('away'));
  assert.ok(awayInTeam('member', true));
  assert.ok(!awayInTeam('member', false));
  assert.ok(!awayInTeam('admin', true));
  assert.deepEqual(landingFor('member', 'away', '', false, false, null, true), { tab: 'team', focus: AWAY_ANCHOR });
  assert.ok(sectionsFor('admin', false, null, true).some(([k]) => k === 'away'));
  assert.ok(!sectionsFor('member', false, null, false).some(([k]) => k === 'away'));
});

test('the Documents list: a shared row says its level; "Sent by me" stays own; the signer reads the plain name in sentences', async () => {
  const { ben, ana, ids, t } = await team();
  const mine = await simple(ana, `sam.mine.${t}@example.com`, { send: true });
  const theirs = await simple(ben, `sam.theirs.${t}@example.com`, { send: true });
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'manage' })).status, 200);
  const rows = (await ana.get('/envelopes')).data.envelopes;
  const by = Object.fromEntries(rows.map((x: any) => [x.id, x.shared_level || null]));
  assert.deepEqual(by, { [mine.id]: null, [theirs.id]: 'manage' });
  assert.deepEqual((await ana.get(`/envelopes?sender=${ids.ana}`)).data.envelopes.map((x: any) => x.id), [mine.id]);
  // Ben's own list never gains Ana's.
  assert.deepEqual((await ben.get('/envelopes')).data.envelopes.map((x: any) => x.id), [theirs.id]);
  // An ended share takes the rows away at once.
  const s = (await ben.get('/me/shares')).data.given[0];
  assert.equal((await del(ben, `/me/shares/${s.id}`)).status, 200);
  assert.deepEqual((await ana.get('/envelopes')).data.envelopes.map((x: any) => x.id), [mine.id]);
});

test('a failed Send on a colleague\'s own draft never makes it the presser\'s to take back or to keep', async () => {
  const { ben, ana, ids, t } = await team();
  const s = await ben.post('/me/shares', { grantee: ids.ana, level: 'send' });
  const d = await simple(ben, `sam.own.${t}@example.com`);
  // A draft that cannot go yet: nobody on it any more.
  db.run('DELETE FROM fields WHERE envelope_id=?', d.id);
  db.run('DELETE FROM recipients WHERE envelope_id=?', d.id);
  const r = await ana.post(`/envelopes/${d.id}/send`, {});
  assert.ok(r.status >= 400, JSON.stringify(r.data));
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', d.id).status, 'draft');
  // She did not make it, so "From me" cannot take it, and ending the share leaves it with Ben.
  assert.equal((await ana.post(`/envelopes/${d.id}/send-for`, { on_behalf_of: '' })).status, 404);
  assert.equal((await del(ben, `/me/shares/${s.data.share.id}`)).status, 200);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', d.id).sender_id, ids.ben);
  // A draft she made in his name through the API is hers to take back, and goes back to her when a share ends.
  assert.equal((await ben.post('/me/shares', { grantee: ids.ana, level: 'send' })).status, 200);
  const file = await upload(ana, 1);
  const made = await ana.post('/envelopes', { subject: 'For Ben', on_behalf_of: ids.ben, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: `sam.api.${t}@example.com` }] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const mid = made.data.envelope.id;
  assert.equal(db.get('SELECT made_for_by FROM envelopes WHERE id=?', mid).made_for_by, ids.ana);
  assert.equal((await ana.post(`/envelopes/${mid}/send-for`, { on_behalf_of: '' })).status, 200);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', mid).sender_id, ids.ana);
});
