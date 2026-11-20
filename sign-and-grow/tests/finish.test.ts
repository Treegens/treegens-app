// The last open ends: leaving a team by yourself, and what follows further down in this file.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, simple, signUp, mailTo, type Server } from './helpers.ts';
import { PRICING } from '../src/lib/impact.ts';

let db: Server['db'];
let cron: Server['cron'];
before(async () => {
  ({ db, cron } = await boot());
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.${200 + Math.floor(++n / 250)}.${n % 250}.9`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const me = async (c: Client) => (await c.get('/me')).data;
const idOf = async (c: Client) => (await me(c)).user.id;
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = from();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
const withKey = (key: string) => {
  const c = from();
  const call = c.call.bind(c);
  c.call = (method: string, url: string, body?: any, headers: Record<string, string> = {}) => call(method, url, body, { authorization: `Bearer ${key}`, ...headers });
  return c;
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const auditOf = (envelopeId: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);

// ---- Leaving a team ------------------------------------------------------------------------------------------

test('a member leaves a team by themselves: what they sent stays with the team, they stay signed in, and the admins are told', async () => {
  const owner = await person('Olga Owner', 'olga@leave.example');
  const adm = await join(owner, 'Adam Admin', 'adam@leave.example', 'admin');
  const sam = await join(owner, 'Sam Stays', 'sam@leave.example');
  const lea = await join(owner, 'Lea Leaver', 'lea@leave.example');
  const [ownerId, samId, leaId] = [await idOf(owner), await idOf(sam), await idOf(lea)];
  const team = (await me(owner)).account;

  // Lea has an envelope out for signature, a draft, and an API key that something uses.
  const out = await simple(lea, 'client@leave.example', { subject: 'Lea in flight' });
  assert.equal((await lea.post(`/envelopes/${out.id}/send`)).status, 200);
  const draft = await simple(lea, 'later@leave.example', { subject: 'Lea draft' });
  const key = (await lea.post('/api-keys', { name: 'Lea script' })).data.key;
  const viaKey = withKey(key);
  assert.equal((await viaKey.get('/envelopes')).status, 200);

  // The owner cannot walk out, a key cannot do it for a person, and a successor has to be someone who stays.
  const own = await owner.post('/account/leave', {});
  assert.equal(own.status, 400);
  assert.match(own.data.error, /You own .* Make someone else the owner first/);
  const keyed = await viaKey.post('/account/leave', {});
  assert.equal(keyed.status, 403, JSON.stringify(keyed.data));
  for (const to of ['usr_nobody', leaId]) {
    const r = await lea.post('/account/leave', { to });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /not on the team\. Nothing was changed/);
  }
  assert.equal(db.get('SELECT COUNT(*) n FROM memberships WHERE account_id=? AND user_id=?', team.id, leaId).n, 1, 'nothing changed so far');

  // Lea leaves and names nobody: the owner takes over.
  const left = await lea.post('/account/leave', {});
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.equal(left.data.left, team.name);
  assert.equal(left.data.handed_to.id, ownerId);
  assert.equal(left.data.handed_over, 2);
  assert.equal(left.data.keys_stopped.length, 1);
  for (const id of [out.id, draft.id]) assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', id).sender_id, ownerId);
  assert.ok(auditOf(out.id).some((a: any) => a.action === 'Handed over' && /From Lea Leaver <lea@leave\.example> to Olga Owner <olga@leave\.example>: Lea Leaver left the team/.test(a.detail)));
  assert.equal((await owner.get(`/envelopes/${out.id}`)).status, 200, 'the team still has the envelope');

  // She is still signed in, in a workspace of her own, with the welcome signatures a person gets once.
  const now_ = await me(lea);
  assert.notEqual(now_.account.id, team.id);
  assert.equal(now_.role, 'owner');
  assert.equal(now_.account.id, left.data.now_in.id);
  assert.equal(db.get("SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=? AND reason='welcome'", now_.account.id).n, PRICING.welcomeSignatures);
  assert.equal((await lea.get(`/envelopes/${out.id}`)).status, 404, 'no way back into the team');
  assert.equal((await lea.get('/account/members')).data.members.length, 1);
  // Her key stopped with her.
  const dead = await viaKey.get('/envelopes');
  assert.equal(dead.status, 401, JSON.stringify(dead.data));

  // The owner and the admin are told, with what was handed over and which key stopped. Other members are not mailed.
  for (const [email, who] of [['olga@leave.example', 'you'], ['adam@leave.example', 'Olga Owner']] as const) {
    const m = mailTo(email).find((x: any) => x.subject === `Lea Leaver left ${team.name}`);
    assert.ok(m, `${email} is told`);
    const t = text(m.html);
    assert.match(t, new RegExp(`2 envelopes, drafts and templates and any bulk sends now belong to ${who}\\.`));
    assert.match(t, /"Lea script"/);
    assert.doesNotMatch(t, /—/);
  }
  assert.equal(mailTo('sam@leave.example').filter((x: any) => /left/.test(x.subject)).length, 0);

  // The admin leaves too and chooses Sam, a plain member, who is told because the envelopes are now Sam's.
  const mine = await simple(adm, 'other@leave.example', { subject: 'Adam in flight' });
  assert.equal((await adm.post(`/envelopes/${mine.id}/send`)).status, 200);
  const gone = await adm.post('/account/leave', { to: samId });
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', mine.id).sender_id, samId);
  assert.match(text(mailTo('sam@leave.example').find((x: any) => x.subject === `Adam Admin left ${team.name}`)!.html), /1 envelope, draft or template and any bulk sends now belong to you\./);
  assert.equal((await sam.get(`/envelopes/${mine.id}`)).status, 200);

  // Lea can be invited back, and joins by signing in.
  assert.equal((await owner.post('/account/invites', { email: 'lea@leave.example' })).status, 200);
  const back = from();
  const r = await back.post('/auth/login', { email: 'lea@leave.example', password: PW, invite: inviteFor('lea@leave.example') });
  assert.equal(r.data.joined, team.name);
});
