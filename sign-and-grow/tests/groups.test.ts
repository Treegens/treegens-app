// Signing groups: a recipient that is a group of people, any one of whom can act. The groups an account keeps, a
// group on a draft, what is sent to whom, who takes a document on and what the others are told, handing it back,
// declining for the group, reminders, the access code, finding documents, the security code, money (one signature
// for one group), the group as it was sent, corrections to its members, templates and bulk sends, and the ways
// each of those can be abused or get an honest person stuck.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, upload, mailTo, PNG, type Server } from './helpers.ts';

let s: Server;
let db: Server['db'];
before(async () => {
  s = await boot();
  db = s.db;
});

let n = 0;
const ip = () => `10.77.${Math.floor(++n / 250)}.${n % 250}`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const ok = (r: { status: number; data: any }, what = '') => (assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`), r.data);

// A fresh group of three for every test, so no test reads another's emails.
let g = 0;
function three(tag: string) {
  const k = `${tag}${++g}`;
  return [{ name: 'Maya Lopez', email: `maya.${k}@hr.example` }, { name: 'Ben Ortiz', email: `ben.${k}@hr.example` }, { name: 'Cy Tan', email: `cy.${k}@hr.example` }];
}
const makeGroup = async (c: Client, members: any[], name = 'HR team') => ok(await c.post('/groups', { name, members }), 'group').group;

// A sender with a group of three, and an envelope on which that group is the one signer.
async function setup(tag: string, over: any = {}, name = 'HR team') {
  const c = await person(`Sender ${tag}`, `sender.${tag}.${++g}@example.com`);
  const members = three(tag);
  const group = await makeGroup(c, members, name);
  const e = await groupDraft(c, group.id, over);
  return { c, members, group, e, maya: members[0].email, ben: members[1].email, cy: members[2].email };
}
async function groupDraft(c: Client, groupId: string, over: any = {}) {
  const file = await upload(c, 1);
  return ok(await c.post('/envelopes', {
    subject: 'Staff handbook', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'g', role: 'signer', group_id: groupId }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 't', document_id: 'd', recipient_id: 'g', type: 'text', label: 'Remarks', required: false, page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.03 }],
    ...over,
  }), 'draft').envelope;
}
const send = async (c: Client, id: string) => ok(await c.post(`/envelopes/${id}/send`), 'send').envelope;
const linkOf = (envelopeId: string, email: string): string => db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', envelopeId, email)?.token;
const row = (envelopeId: string) => db.get('SELECT * FROM recipients WHERE envelope_id=? AND group_name IS NOT NULL', envelopeId);
const trail = (envelopeId: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);
const said = (envelopeId: string, action: string) => trail(envelopeId).filter((a: any) => a.action === action);
const view = async (tok: string, c = from()) => (await c.get(`/sign/${tok}`)).data;
const agree = (tok: string, c = from()) => c.post(`/sign/${tok}/consent`);
async function finish(tok: string, c = from()) {
  const v = (await c.get(`/sign/${tok}`)).data;
  const values: Record<string, string> = {};
  for (const f of v.fields || []) values[f.id] = f.type === 'text' ? 'filled in' : '1';
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG });
}
const asBody = (e: any) => ({ subject: e.subject, documents: e.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), recipients: e.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, routing_order: r.routing_order, group_id: r.group_id || undefined, access_code: r.access_code || undefined })), fields: e.fields });
const fresh = async (c: Client, id: string) => ok(await c.get(`/envelopes/${id}`)).envelope;

// ---- 1. The groups an account keeps ----------------------------------------------------------------------------

test('an account keeps named groups: admins manage them, every member of the team can use them, nobody else can', async () => {
  const owner = await person('Olga Owner', 'olga@groups.example');
  const members = three('keep');
  const made = await owner.post('/groups', { name: '  HR   team ', members });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.group.name, 'HR team', 'spaces are tidied');
  assert.deepEqual(made.data.group.members.map((m: any) => m.email), members.map((m) => m.email));
  const gid = made.data.group.id;

  // Refused in words, and nothing is cut short or dropped: too few, too many, an address twice, no name, no address.
  const no = async (body: any, re: RegExp, status = 400) => {
    const r = await owner.post('/groups', body);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await no({ name: 'Solo', members: [members[0]] }, /at least 2 members/);
  await no({ name: 'Crowd', members: Array.from({ length: 21 }, (_, i) => ({ name: `P ${i}`, email: `p${i}@crowd.example` })) }, /up to 20 members/);
  await no({ name: 'Twice', members: [members[0], { name: 'Other', email: members[0].email.toUpperCase() }] }, /in the group twice/);
  await no({ name: 'Nameless', members: [members[0], { name: ' ', email: 'x@y.example' }] }, /member 2 .*needs a name/);
  await no({ name: 'Bad address', members: [members[0], { name: 'Typo', email: 'typo@' }] }, /Typo needs a valid email address/);
  await no({ name: '', members }, /Give the group a name/);
  await no({ name: 'x'.repeat(81), members }, /up to 80 characters/);
  await no({ name: 'hr TEAM', members }, /already a group called/, 409);
  await no({ name: 'Not a list', members: 'maya' }, /must be a list/);
  assert.equal(db.get('SELECT COUNT(*) n FROM signing_groups').n, 1, 'none of the refused groups was kept');

  // A member of the team reads and uses the groups, and cannot change them.
  ok(await owner.post('/account/invites', { email: 'mel@groups.example', role: 'member' }));
  const mel = from();
  ok(await mel.post('/auth/signup', { name: 'Mel Member', email: 'mel@groups.example', password: 'correct horse battery', invite: db.get('SELECT token FROM invites WHERE email=?', 'mel@groups.example').token }));
  const seen = ok(await mel.get('/groups'));
  assert.equal(seen.groups.length, 1);
  assert.equal(seen.may_change, false);
  assert.equal(seen.min_members, 2);
  assert.equal(seen.max_members, 20);
  for (const r of [await mel.post('/groups', { name: 'Mine', members }), await mel.put(`/groups/${gid}`, { name: 'Mine', members }), await mel.call('DELETE', `/groups/${gid}`)]) assert.equal(r.status, 403);
  const used = await groupDraft(mel, gid);
  assert.equal(used.recipients[0].group_name, 'HR team', 'a member puts the team\'s group on their own envelope');

  // Another account neither sees the group nor can name it on an envelope or change it.
  const other = await person('Otto Other', 'otto@elsewhere.example');
  assert.deepEqual(ok(await other.get('/groups')).groups, []);
  assert.equal((await other.put(`/groups/${gid}`, { name: 'Taken over', members })).status, 404);
  assert.equal((await other.call('DELETE', `/groups/${gid}`)).status, 404);
  const file = await upload(other, 1);
  const stolen = await other.post('/envelopes', { documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'g', role: 'signer', group_id: gid }] });
  assert.equal(stolen.status, 400);
  assert.match(stolen.data.error, /names a group .* that does not exist in this account/);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE u.email=?', 'otto@elsewhere.example').n, 0, 'and no draft is left behind');

  // Changing a group replaces its name and its members. The list says how many drafts and templates name it.
  const changed = ok(await owner.put(`/groups/${gid}`, { name: 'People team', members: members.slice(0, 2) })).group;
  assert.equal(changed.name, 'People team');
  assert.equal(changed.members.length, 2);
  assert.equal(changed.used_by, 1);
  assert.equal((await fresh(mel, used.id)).recipients[0].name, 'People team', 'a draft follows the saved group');
  ok(await owner.call('DELETE', `/groups/${gid}`));
  assert.deepEqual(ok(await owner.get('/groups')).groups, []);
  assert.equal(db.get('SELECT COUNT(*) n FROM signing_group_members').n, 0);
});

// ---- 2. A group on a draft ----------------------------------------------------------------------------------------

test('a recipient can be a group in every role but in person, and its name and address are not the caller\'s to choose', async () => {
  const { c, group, e, members } = await setup('draft');
  const r = e.recipients[0];
  assert.equal(r.name, 'HR team');
  assert.equal(r.email, '');
  assert.equal(r.group_id, group.id);
  assert.deepEqual(r.members.map((m: any) => m.email), members.map((m) => m.email));
  assert.ok(!JSON.stringify(e).includes('"token"'), 'a draft gives out no link');

  // Whatever name and address the body carries for a group, the row keeps the group's.
  const spoofed = ok(await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role: 'approver', group_id: group.id, name: 'Somebody Else', email: 'else@example.com' }], fields: [] })).envelope;
  assert.equal(spoofed.recipients[0].name, 'HR team');
  assert.equal(spoofed.recipients[0].email, '');
  assert.equal(spoofed.recipients[0].role, 'approver');
  for (const role of ['viewer', 'cc', 'signer']) assert.equal((await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role, group_id: group.id }], fields: role === 'signer' ? e.fields : [] })).status, 200, role);

  const inPerson = await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role: 'inperson', group_id: group.id }] });
  assert.equal(inPerson.status, 400);
  assert.match(inPerson.data.error, /signing in person is for one named person/);
  const coded = await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role: 'signer', group_id: group.id, verify: 'email_code' }] });
  assert.equal(coded.status, 400);
  assert.match(coded.data.error, /A one-time code and a text message go to one person/);
  const unknown = await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role: 'signer', group_id: 'grp_doesnotexist000000' }] });
  assert.equal(unknown.status, 400);
  assert.equal((await fresh(c, e.id)).recipients[0].group_id, group.id, 'a refused save changed nothing');

  // Leaving group_id out keeps the group, and null makes the recipient a person again.
  const kept = ok(await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role: 'signer' }] })).envelope;
  assert.equal(kept.recipients[0].group_name, 'HR team');
  const personNow = ok(await c.put(`/envelopes/${e.id}`, { ...asBody(e), recipients: [{ id: r.id, role: 'signer', group_id: null, name: 'Pat Person', email: 'pat@example.com' }] })).envelope;
  assert.equal(personNow.recipients[0].group_name, null);
  assert.equal(personNow.recipients[0].name, 'Pat Person');
  assert.equal(personNow.recipients[0].members, undefined);
});

// ---- 3. Sending: every member gets their own email and their own link ------------------------------------------

test('at send time every member gets their own email and their own link, and the group itself has no link at all', async () => {
  const { c, e, members, maya, ben, cy } = await setup('send');
  const sent = await send(c, e.id);
  assert.equal(sent.recipients.length, 1, 'the group is one recipient');
  assert.equal(sent.recipients[0].status, 'sent');
  assert.equal(sent.recipients[0].members.length, 3);
  assert.ok(!JSON.stringify(sent).includes(linkOf(e.id, maya)), 'the sender\'s copy of the envelope carries no member\'s link');

  const links = members.map((m) => linkOf(e.id, m.email));
  assert.equal(new Set(links).size, 3, 'three separate secrets');
  for (const l of links) assert.ok(l.length >= 40);
  assert.equal(row(e.id).token, null, 'no link exists that is "the group\'s"');
  assert.equal(row(e.id).check_code, null);
  assert.equal(row(e.id).email, '');

  for (const m of members) {
    const mail = mailTo(m.email);
    assert.equal(mail.length, 1, `${m.email} got one email`);
    assert.ok(mail[0].link.endsWith(`/sign/${linkOf(e.id, m.email)}`), 'with their own link');
    assert.match(mail[0].html, /This was sent to HR team \(3 people\), and any one of you can sign it/);
    assert.match(mail[0].html, /The first of you who agrees to do so takes it on/);
  }
  const codes = db.all('SELECT check_code c FROM recipient_members WHERE envelope_id=?', e.id).map((x: any) => x.c);
  assert.equal(new Set(codes).size, 3, 'and their own security code');
  // The record says who was written to: the group with its members, not an address the group does not have.
  const line = trail(e.id).find((a: any) => a.action === 'Not emailed' || a.action === 'Sent to recipient');
  assert.match(line.detail, new RegExp(`HR team \\(a group of 3: Maya Lopez <${maya}>, Ben Ortiz <${ben}>, Cy Tan <${cy}>\\)`));
  // Each member counts as a person reached, and none of them became a contact with an empty address.
  assert.equal(db.get('SELECT COUNT(*) n FROM reached WHERE envelope_id=?', e.id).n, 3);
  assert.equal(db.get("SELECT COUNT(*) n FROM contacts WHERE email=''").n, 0);
});

test('the daily limit counts every member emailed, on a first send and when a correction adds members', async () => {
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = '4';
  try {
    const { c, e } = await setup('limit');
    await send(c, e.id); // three people
    const more = await makeGroup(c, [{ name: 'Dee Diaz', email: 'dee@limit.example' }, { name: 'Eli Esh', email: 'eli@limit.example' }], 'Payroll');
    const second = await groupDraft(c, more.id);
    const no = await c.post(`/envelopes/${second.id}/send`);
    assert.equal(no.status, 429, JSON.stringify(no.data));
    assert.match(no.data.error, /has sent to 3 in the last 24 hours and this would add 2/);
    assert.equal(mailTo('dee@limit.example').length, 0);
    // A correction that adds two members to the group that is out is two more people, and is refused the same way.
    const cur = await fresh(c, e.id);
    const grown = await c.put(`/envelopes/${e.id}`, { ...asBody(cur), recipients: [{ id: cur.recipients[0].id, role: 'signer', members: [...cur.recipients[0].members.map((m: any) => ({ name: m.name, email: m.email })), { name: 'Dee Diaz', email: 'dee@limit.example' }, { name: 'Eli Esh', email: 'eli@limit.example' }] }] });
    assert.equal(grown.status, 429, JSON.stringify(grown.data));
    assert.equal((await fresh(c, e.id)).recipients[0].members.length, 3, 'nothing of the refused correction was saved');
    // One more is within the limit.
    const one = await c.put(`/envelopes/${e.id}`, { ...asBody(cur), recipients: [{ id: cur.recipients[0].id, role: 'signer', members: [...cur.recipients[0].members.map((m: any) => ({ name: m.name, email: m.email })), { name: 'Dee Diaz', email: 'dee@limit.example' }] }] });
    assert.equal(one.status, 200, JSON.stringify(one.data));
    assert.equal(mailTo('dee@limit.example').length, 1, 'the new member is emailed their own link at once');
  } finally {
    delete process.env.NEW_ACCOUNT_DAILY_RECIPIENTS;
  }
});

// ---- 4. Taking it on ------------------------------------------------------------------------------------------

test('the first member who agrees takes it on: the others are told who has it and can do nothing, and the record names the person and the group', async () => {
  const { c, e, maya, ben, cy } = await setup('take');
  await send(c, e.id);
  const [mayaLink, benLink, cyLink] = [maya, ben, cy].map((m) => linkOf(e.id, m));

  // Before anyone has agreed, every member can read the document under their own name.
  const benFirst = await view(benLink);
  assert.equal(benFirst.recipient.name, 'Ben Ortiz');
  assert.equal(benFirst.recipient.email, ben);
  assert.equal(benFirst.recipient.consented, false);
  assert.deepEqual({ name: benFirst.recipient.group.name, size: benFirst.recipient.group.size, state: benFirst.recipient.group.state, away: benFirst.recipient.group.away }, { name: 'HR team', size: 3, state: 'open', away: false });
  assert.equal(benFirst.documents.length, 1);
  assert.equal((await from().get(`/sign/${benLink}/doc/${benFirst.documents[0].id}`)).status, 200);
  // But nothing can be filled in, saved or finished through a link that has not taken it on.
  for (const [path, body] of [['save', { values: { x: 'y' } }], ['complete', { values: {}, signature_png: PNG }], ['name', { name: 'Ben Ortis' }], ['reassign', { name: 'Zed', email: 'zed@example.com' }], ['hand-back', {}], ['print-check', { values: {} }]] as [string, any][]) {
    const r = await from().post(`/sign/${benLink}/${path}`, body);
    assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, /Agree to sign first/);
  }
  assert.equal(row(e.id).claimed_by, null);

  const took = await agree(mayaLink);
  assert.equal(took.status, 200, JSON.stringify(took.data));
  const r = row(e.id);
  assert.equal(r.name, 'Maya Lopez');
  assert.equal(r.email, maya);
  assert.equal(r.group_name, 'HR team');
  assert.equal(r.token, mayaLink, 'the link she was emailed is the recipient\'s link from here on');
  assert.ok(r.consent_at);
  const taken = said(e.id, 'Taken on for a group');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].actor, `Maya Lopez, for HR team <${maya}>`);
  assert.match(taken[0].detail, new RegExp(`Maya Lopez <${maya}> took this on for HR team, by agreeing to sign it\\. The links of the other members now say so: Ben Ortiz <${ben}>, Cy Tan <${cy}>\\.`));

  // Ben and Cy: who has it, the sender to ask, and nothing of the document.
  for (const [link, name, email] of [[benLink, 'Ben Ortiz', ben], [cyLink, 'Cy Tan', cy]]) {
    const v = await view(link);
    assert.equal(v.recipient.name, name);
    assert.equal(v.recipient.email, email);
    assert.equal(v.recipient.group.state, 'taken');
    assert.equal(v.recipient.group.away, true);
    assert.equal(v.recipient.group.by, 'Maya Lopez');
    assert.equal(v.recipient.group.can_ask, true);
    assert.ok(v.envelope.sender.email, 'with the sender\'s contact');
    assert.equal(v.documents, undefined);
    assert.equal(v.fields, undefined);
    assert.equal(v.others, undefined);
    for (const [method, path, body] of [['POST', 'consent', {}], ['POST', 'save', { values: {} }], ['POST', 'complete', { values: {}, signature_png: PNG }], ['POST', 'decline', { reason: 'no' }], ['POST', 'hand-back', {}], ['POST', 'reassign', { name: 'Zed', email: 'zed@example.com' }], ['POST', 'ask', { message: 'May I have it?' }], ['GET', 'download', undefined], ['GET', `doc/${benFirst.documents[0].id}`, undefined]] as [string, string, any][]) {
      const x = await from().call(method, `/sign/${link}/${path}`, body);
      assert.equal(x.status, 409, `${name} ${path}: ${JSON.stringify(x.data).slice(0, 200)}`);
      assert.match(x.data.error, /Maya Lopez from HR team has taken this on/);
      assert.match(x.data.error, /ask Sender take .* to give it back to the group/);
    }
  }
  assert.equal(row(e.id).claimed_by, db.get('SELECT id FROM recipient_members WHERE token=?', mayaLink).id, 'nothing the others tried moved it');

  // Maya signs with the link she always had. The record and the certificate name her and the group.
  const mine = await view(mayaLink);
  assert.equal(mine.recipient.group.state, 'mine');
  assert.equal(mine.recipient.group.can_hand_back, true);
  assert.equal(mine.recipient.consented, true);
  const done = await finish(mayaLink);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.envelope_status, 'completed');
  const signed = said(e.id, 'Signed');
  assert.equal(signed[0].actor, `Maya Lopez, for HR team <${maya}>`);
  assert.equal(signed[0].detail, `Maya Lopez, for HR team <${maya}>`);
  const { extractPages } = await import('../src/server/text.ts');
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  const text = (await extractPages(pdf.data)).join(' ').replace(/\s+/g, ' ');
  assert.match(text, new RegExp(`Maya Lopez, for HR team <${maya.replace(/\./g, '\\.')}>`), 'the certificate names the person who signed and the group');
  assert.match(text, /Acted for HR team, a group of 3: Maya Lopez/);
  assert.match(text, /Taken on for a group/);
  // The completed copy goes to the person who signed. The others see who signed and get no document.
  assert.equal(mailTo(maya).filter((m: any) => m.subject.startsWith('Completed:')).length, 1);
  assert.equal(mailTo(ben).filter((m: any) => m.subject.startsWith('Completed:')).length, 0);
  const after = await view(benLink);
  assert.equal(after.recipient.group.done, true);
  assert.equal(after.recipient.group.can_ask, false);
  assert.equal(after.documents, undefined);
  const late = await from().get(`/sign/${benLink}/download`);
  assert.equal(late.status, 409);
  assert.match(late.data.error, /Maya Lopez from HR team has signed this/);
});

test('two members who agree at the same moment: one takes it on, the other is told who did', async () => {
  const { c, e, maya, ben } = await setup('race');
  await send(c, e.id);
  const both = await Promise.all([agree(linkOf(e.id, maya)), agree(linkOf(e.id, ben))]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const lost = both.find((r) => r.status === 409)!;
  assert.match(lost.data.error, /from HR team has taken this on/);
  assert.equal(lost.data.code, 'taken');
  assert.equal(said(e.id, 'Taken on for a group').length, 1);
  assert.equal(said(e.id, 'Agreed to electronic records and signatures').length, 1);
  // Agreeing again with the link that has it changes nothing and writes nothing twice.
  const winner = row(e.id).token;
  assert.equal((await agree(winner)).status, 200);
  assert.equal(said(e.id, 'Taken on for a group').length, 1);
  assert.equal(said(e.id, 'Agreed to electronic records and signatures').length, 1);
});

// ---- The API description and the screens that manage groups ------------------------------------------------------

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the API describes groups, and the Contacts page lets admins manage them', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  for (const [p, m] of [['/groups', 'get'], ['/groups', 'post'], ['/groups/{id}', 'put'], ['/groups/{id}', 'delete'], ['/envelopes/{id}/recipients/{rid}/release', 'post']]) assert.ok(spec.paths[p]?.[m], `${m} ${p}`);
  for (const k of ['group_id', 'group_name', 'members', 'claimed_by']) assert.ok(spec.components.schemas.Recipient.properties[k], k);
  assert.ok(spec.paths['/envelopes/{id}/recipient-view'].post.requestBody.content['application/json'].schema.properties.member_id);
  // The Contacts page carries the groups, and only an admin is offered the buttons that change them.
  assert.match(read('src/app/app/contacts/page.tsx'), /<SigningGroups \/>/);
  const ui = read('src/components/sender/SigningGroups.tsx');
  assert.match(ui, /may_change/);
  assert.match(ui, /\{admin && !draft && <button id="sn-group-new"/);
  assert.match(ui, /\{admin && \(\s*<div className="sn-contact-actions">/);
  assert.match(read('src/app/layout.tsx'), /styles\/groups\.css/);
});

test('the editor offers a group as a recipient, saves it by its id, and counts a change of members as a change', async () => {
  const { fingerprint } = await import('../src/components/editor/changes.ts');
  const env = { subject: 'S' };
  const base = { documents: [], fields: [], recipients: [{ id: 'g', role: 'signer', name: 'HR team', email: '', group_id: 'grp_1', members: [{ name: 'Maya Lopez', email: 'maya@hr.example' }, { name: 'Ben Ortiz', email: 'ben@hr.example' }] }] };
  const more = { ...base, recipients: [{ ...base.recipients[0], members: [...base.recipients[0].members, { name: 'Cy Tan', email: 'cy@hr.example' }] }] };
  const other = { ...base, recipients: [{ ...base.recipients[0], group_id: 'grp_2' }] };
  assert.notEqual(fingerprint(env, base), fingerprint(env, more), 'a member added is something to save');
  assert.notEqual(fingerprint(env, base), fingerprint(env, other), 'another group is something to save');
  assert.equal(fingerprint(env, base), fingerprint(env, { ...base, recipients: [{ ...base.recipients[0], members: base.recipients[0].members.map((m) => ({ ...m, email: m.email.toUpperCase() })) }] }), 'the case of an address is no change');
  // The editor sends the group's id, and its members only on an envelope that is out (a draft follows the saved group).
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /group_id: r\.group_id \|\| null, \.\.\.\(correcting && r\.group_id && r\.members \?/);
  assert.match(editor, /isGroupRow\(r\)\) \{\s*\/\/[^\n]*\n\s*const no = groupProblem\(r\)/);
  assert.match(read('src/components/editor/StepAdd.tsx'), /if \(isGroupRow\(r\)\) return <GroupRow /);
  const row = read('src/components/editor/GroupRecipient.tsx');
  assert.doesNotMatch(row.match(/const ROLES[^\n]*/)![0], /inperson/, 'a group is never offered signing in person');
  assert.match(row, /if \(!groups\?\.length \|\| ed\.rcps\.length >= MAX_RECIPIENTS\) return null;/, 'no Add a group button without groups');
});
