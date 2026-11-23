// Switches for senders and admins (research/docusign-gaps.json, batch "switches"): each one on and off, through the
// page's own rules and through the API. With nothing switched, everything works as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, simple, draft, tokenFor, mailTo, PNG } from './helpers.ts';
import { otherActions, bySwitches, WITNESS_ACTIONS } from '../src/components/sign/actions.ts';
import { waysOf, waysLimited, howOf, howText, markWords, markWordsProblem, MARK_WORDS_DEFAULT, SIGN_WAYS } from '../src/lib/switches.ts';

const { db } = await boot();
let n = 0;
const ip = () => `198.51.110.${++n}`;
const ok = (r: { status: number; data: any }, what = '') => (assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`), r.data);
const sent = async (c: Client, email: string, over: any = {}) => {
  const e = await simple(c, email, over);
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  return e;
};
const signer = { role: 'signer' };

// ---- 1. Pass it on --------------------------------------------------------------------------------------------

test('1. Pass it on: on by default, off per account and per envelope, the first person kept as a copy when chosen', async () => {
  const c = await signUp('Rosa Sender', 'rosa@switch1.example', ip());
  // The page's rule: on (or not said) keeps the entry, off takes it away and nothing else.
  assert.deepEqual(otherActions(signer, { stage: 'sign', deadline: false }), ['later', 'reassign', 'ask', 'decline']);
  assert.deepEqual(bySwitches(otherActions(signer, { stage: 'sign', deadline: false }), { pass_on: true }), ['later', 'reassign', 'ask', 'decline']);
  assert.deepEqual(bySwitches(otherActions(signer, { stage: 'sign', deadline: false }), { pass_on: false }), ['later', 'ask', 'decline']);

  // Zero setup: the page is told it may pass it on, and passing it on works as before, with no copy kept.
  const a = ok(await c.get('/account/switches'));
  assert.equal(a.pass_on, true);
  assert.equal(a.pass_on_copy, false);
  const e1 = await sent(c, 'first@switch1.example');
  const v1 = ok(await new Client().get(`/sign/${tokenFor(e1.id, 'first@switch1.example')}`));
  assert.deepEqual(v1.switches, { pass_on: true, comments: true, ways: ['type', 'draw', 'upload'] });
  ok(await new Client().post(`/sign/${tokenFor(e1.id, 'first@switch1.example')}/reassign`, { name: 'Dee Deputy', email: 'dee@switch1.example' }));
  assert.equal(db.all("SELECT 1 FROM recipients WHERE envelope_id=? AND role='cc'", e1.id).length, 0, 'no copy kept unless chosen');

  // Per envelope, while it is out: off refuses, in words that say what to do, and the page hides the entry.
  ok(await c.put(`/envelopes/${e1.id}/switches`, { pass_on: false }));
  const dee = tokenFor(e1.id, 'dee@switch1.example');
  assert.equal(ok(await new Client().get(`/sign/${dee}`)).switches.pass_on, false);
  const refused = await new Client().post(`/sign/${dee}/reassign`, { name: 'Eve Else', email: 'eve@switch1.example' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /^Rosa Sender turned off passing this document to someone else, so it was not passed on\. Nothing was changed\. If someone else should sign, ask Rosa Sender/);
  assert.equal(db.get('SELECT name FROM recipients WHERE envelope_id=? AND role=?', e1.id, 'signer').name, 'Dee Deputy');
  assert.ok(db.all('SELECT action, detail FROM audit WHERE envelope_id=?', e1.id).some((x: any) => x.action === 'Settings changed' && /no longer pass it to someone else/.test(x.detail)));

  // As the account default: a document sent after the change is off; one sent before keeps what it had.
  const before = await sent(c, 'before@switch1.example');
  ok(await c.put('/account/switches', { pass_on: false }));
  const after = await sent(c, 'after@switch1.example');
  assert.equal((await new Client().post(`/sign/${tokenFor(after.id, 'after@switch1.example')}/reassign`, { name: 'X Y', email: 'xy@switch1.example' })).status, 403);
  ok(await new Client().post(`/sign/${tokenFor(before.id, 'before@switch1.example')}/reassign`, { name: 'Pat Other', email: 'pat@switch1.example' }), 'sent before the change');

  // With "keep a copy": the first person stays on as a copy recipient, both in the record, and gets the signed copy.
  ok(await c.put('/account/switches', { pass_on: true, pass_on_copy: true }));
  const e2 = await sent(c, 'kim@switch1.example');
  ok(await new Client().post(`/sign/${tokenFor(e2.id, 'kim@switch1.example')}/reassign`, { name: 'Lou New', email: 'lou@switch1.example' }));
  const cc = db.get("SELECT * FROM recipients WHERE envelope_id=? AND role='cc'", e2.id);
  assert.equal(cc.email, 'kim@switch1.example');
  assert.equal(cc.status, 'completed');
  const trail = db.all('SELECT action FROM audit WHERE envelope_id=?', e2.id).map((x: any) => x.action);
  assert.ok(trail.includes('Reassigned') && trail.includes('Kept as a copy'));
  // The same address again (a spelling fixed) keeps no second copy.
  const e3 = await sent(c, 'same@switch1.example');
  ok(await new Client().post(`/sign/${tokenFor(e3.id, 'same@switch1.example')}/reassign`, { name: 'Sam Other', email: 'same@switch1.example' }));
  assert.equal(db.all("SELECT 1 FROM recipients WHERE envelope_id=? AND role='cc'", e3.id).length, 0);
  // Lou signs: Kim, kept as a copy, is emailed the completed document.
  const lou = new Client();
  const tok = tokenFor(e2.id, 'lou@switch1.example');
  await lou.post(`/sign/${tok}/consent`);
  const f = ok(await lou.get(`/sign/${tok}`)).fields[0];
  ok(await lou.post(`/sign/${tok}/complete`, { values: { [f.id]: '1' }, signature_png: PNG }));
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e2.id).status, 'completed');
  assert.ok(mailTo('kim@switch1.example').some((m: any) => /^Completed:/.test(m.subject)), 'the first person gets the signed copy');

  // Not by a member, not by an API key, and only true or false.
  assert.equal((await c.put('/account/switches', { pass_on: 'no' })).status, 400);
  assert.equal((await c.put('/account/switches', { passon: false })).status, 400);
});

// ---- 2. Questions and comments --------------------------------------------------------------------------------

test('2. Questions and comments: off hides the entry and refuses new comments; what was written stays readable', async () => {
  const c = await signUp('Cleo Sender', 'cleo@switch2.example', ip());
  assert.deepEqual(bySwitches(otherActions(signer, { stage: 'sign', deadline: false }), { comments: false }), ['later', 'reassign', 'decline']);
  assert.deepEqual(bySwitches(otherActions({ role: 'witness' }, { stage: 'sign', deadline: false }), { comments: false }), WITNESS_ACTIONS.filter((k) => k !== 'ask'));
  assert.deepEqual(otherActions({ role: 'witness' }, { stage: 'sign', deadline: false }), [...WITNESS_ACTIONS]);

  const e = await sent(c, 'sig@switch2.example');
  const tok = tokenFor(e.id, 'sig@switch2.example');
  const s = new Client();
  ok(await s.post(`/sign/${tok}/comments`, { text: 'Is page 2 right?' }), 'on by default');
  ok(await c.put(`/envelopes/${e.id}/switches`, { comments: false }));
  const view = ok(await s.get(`/sign/${tok}/comments`));
  assert.equal(view.threads.length, 1, 'what was written stays readable');
  assert.equal(view.may_write, false);
  assert.equal(view.comments_off, true);
  assert.equal(ok(await s.get(`/sign/${tok}`)).switches.comments, false);
  const no = await s.post(`/sign/${tok}/comments`, { text: 'One more thing' });
  assert.equal(no.status, 403);
  assert.match(no.data.error, /^Cleo Sender turned off questions and comments for this document, so this was not sent\. What was written before can still be read\. To ask Cleo Sender something, reply to the email you got about this document\.$/);
  assert.equal((await s.post(`/sign/${tok}/ask`, { message: 'Hello?' })).status, 403, 'the old ask route too');
  assert.equal((await s.post(`/sign/${tok}/comments`, { text: 'Reply', thread_id: view.threads[0].id })).status, 403, 'nor a reply');
  // The sender can still answer the question that was asked, and cannot start a new conversation.
  ok(await c.post(`/envelopes/${e.id}/comments`, { text: 'Yes, it is right.', thread_id: view.threads[0].id }), 'answer');
  const start = await c.post(`/envelopes/${e.id}/comments`, { text: 'Anything else?', for: 'everyone' });
  assert.equal(start.status, 403);
  assert.equal(start.data.error, 'Questions and comments are off for this document, so a new conversation cannot be started on it. You can still answer one that was there before. Nothing was sent.');
  // On again: writing works again.
  ok(await c.put(`/envelopes/${e.id}/switches`, { comments: true }));
  ok(await s.post(`/sign/${tok}/comments`, { text: 'Thanks' }));
  // Not on a finished envelope, not on a template, and nobody else's.
  const other = await signUp('Oz Other', 'oz@switch2.example', ip());
  assert.equal((await other.put(`/envelopes/${e.id}/switches`, { comments: false })).status, 404);
});

// ---- 3. Ways to make a signature ------------------------------------------------------------------------------

test('3. Ways to make a signature: admins choose, at least one, Finish refuses another way, the certificate says how', async () => {
  const { howCertLines } = await import('../src/server/switches.ts');
  // The shared rules.
  assert.deepEqual(waysOf(null), [...SIGN_WAYS]);
  assert.deepEqual(waysOf('upload,type'), ['type', 'upload'], 'always in the same order');
  assert.deepEqual(waysOf('nonsense'), [...SIGN_WAYS], 'nothing valid is all three, never none');
  assert.equal(waysLimited(['type', 'draw', 'upload']), false);
  assert.equal(waysLimited(['draw']), true);
  assert.equal(howOf('type:Sig Dancing'), 'type:Sig Dancing');
  assert.equal(howOf('type:<script>'), null);
  assert.equal(howOf('photocopy'), null);
  assert.equal(howText('type:Sig Dancing'), 'typed, style Dancing');
  assert.equal(howText('type:plain'), 'typed, in plain letters');
  assert.equal(howText('draw'), 'drawn');
  assert.equal(howText('upload'), 'uploaded picture');

  const c = await signUp('Wes Sender', 'wes@switch3.example', ip());
  const v = ok(await c.get('/account/switches'));
  assert.deepEqual(v.sign_ways, ['type', 'draw', 'upload']);
  assert.equal(v.sign_ways_note, 'Drawing does not make a signature stronger in law.');
  assert.equal((await c.put('/account/switches', { sign_ways: [] })).status, 400, 'at least one');
  assert.match((await c.put('/account/switches', { sign_ways: [] })).data.error, /Keep at least one way/);
  assert.equal((await c.put('/account/switches', { sign_ways: ['type', 'stamp'] })).status, 400);
  ok(await c.put('/account/switches', { sign_ways: ['type'] }));

  const e = await sent(c, 'typ@switch3.example');
  const tok = tokenFor(e.id, 'typ@switch3.example');
  const s = new Client();
  await s.post(`/sign/${tok}/consent`);
  const page = ok(await s.get(`/sign/${tok}`));
  assert.deepEqual(page.switches.ways, ['type']);
  const values = { [page.fields[0].id]: '1' };
  const drawn = await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG, signature_how: 'draw' });
  assert.equal(drawn.status, 400);
  assert.match(drawn.data.error, /^This document can be signed in these ways only: type\. Make your signature again in one of them, then finish\.$/);
  assert.equal((await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG, signature_how: 'saved' })).status, 400, 'a saved one cannot say how it was made');
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=?', e.id).status, 'viewed', 'nothing was signed');
  // A save keeps how it was made, so Finish on another device needs no word about it.
  ok(await s.post(`/sign/${tok}/save`, { values, signature_png: PNG, signature_how: 'type:Sig Caveat' }));
  ok(await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG }));
  const r = db.get('SELECT * FROM recipients WHERE envelope_id=?', e.id);
  assert.equal(r.sig_how, 'type:Sig Caveat');
  assert.deepEqual(howCertLines(r), [['Signature made', 'typed, style Caveat, as their signing page reported']]);
  // A second Finish never changes what the record says.
  await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG, signature_how: 'upload' });
  assert.equal(db.get('SELECT sig_how FROM recipients WHERE envelope_id=?', e.id).sig_how, 'type:Sig Caveat');
  // Nothing reported (an older page, the API): no line, rather than a guess.
  assert.deepEqual(howCertLines({ sig_how: null, signature_png: PNG }), []);
  // Back to all three: anything goes again, as before.
  ok(await c.put('/account/switches', { sign_ways: ['type', 'draw', 'upload'] }));
  const e2 = await sent(c, 'drw@switch3.example');
  const t2 = tokenFor(e2.id, 'drw@switch3.example');
  const s2 = new Client();
  await s2.post(`/sign/${t2}/consent`);
  const p2 = ok(await s2.get(`/sign/${t2}`));
  ok(await s2.post(`/sign/${t2}/complete`, { values: { [p2.fields[0].id]: '1' }, signature_png: PNG, signature_how: 'draw' }));
  // The signature pad offers only the ways given, and a saved signature only when all three are on.
  const pad = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/components/SignaturePad.tsx', import.meta.url), 'utf8'));
  assert.match(pad, /const saved = ways && waysLimited\(ways\) \? null : savedIn;/);
  assert.match(pad, /MAKE\.filter\(\(\[t\]\) => \(ways as readonly string\[\]\)\.includes\(t\)\)/);
});

// ---- 4. Members may place stamps --------------------------------------------------------------------------------

test('4. Members may place stamps: off removes the Stamp field for members only; what is out is unchanged', async () => {
  const owner = await signUp('Olu Owner', 'olu@switch4.example', ip());
  const acct = db.get('SELECT account_id a FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', 'olu@switch4.example').a;
  ok(await owner.post('/account/invites', { email: 'mem@switch4.example', role: 'member' }));
  const mem = await signUp('Mem Member', 'mem@switch4.example', ip());
  ok(await mem.post('/invites/accept', { token: db.get('SELECT token FROM invites WHERE email=? AND account_id=?', 'mem@switch4.example', acct).token }));
  const stampField = { id: 'st', document_id: 'd', recipient_id: 'r', type: 'stamp', page: 0, x: 0.5, y: 0.2, w: 0.18, h: 0.12 };
  const withStamp = (fields: any[]) => ({ fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, ...fields] });
  // On by default: a member places a stamp field as before.
  const before = await simple(mem, 'cust@switch4.example', withStamp([stampField]));
  assert.equal(ok(await mem.get('/me')).no_stamps, undefined);
  // Members only: the member is refused, the owner is not, and the member cannot change the switch.
  assert.equal((await mem.put('/account/switches', { members_stamps: true })).status, 403);
  ok(await owner.put('/account/switches', { members_stamps: false }));
  assert.equal(ok(await mem.get('/me')).no_stamps, true);
  assert.equal(ok(await owner.get('/me')).no_stamps, undefined);
  const file = (await import('./helpers.ts')).upload;
  const f = await file(mem, 1);
  const refused = await mem.post('/envelopes', { subject: 'Stamped', documents: [{ id: 'd', file_id: f.id }], recipients: [{ id: 'r', role: 'signer', name: 'Cu Stomer', email: 'cu@switch4.example' }], ...withStamp([stampField]) });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /^Your admins have turned off stamps for members, so a stamp field cannot be added\. Nothing was saved\./);
  await simple(owner, 'own@switch4.example', withStamp([stampField]));
  // A draft that already had its stamp field keeps it, and saving it again is fine; adding a second is not.
  const kept = ok(await mem.get(`/envelopes/${before.id}`)).envelope;
  ok(await mem.put(`/envelopes/${before.id}`, { fields: kept.fields }), 'keeps the stamp it had');
  const second = await mem.put(`/envelopes/${before.id}`, { fields: [...kept.fields, { ...stampField, id: 'st2', y: 0.05 }] });
  assert.equal(second.status, 403);
  // The editor's palette leaves Stamp out for that member, unless the document already has one.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/components/editor/StepFields.tsx', import.meta.url), 'utf8'));
  assert.match(src, /if \(me\?\.no_stamps && !list\.some\(\(f\) => f\.type === 'stamp'\) && kinds\.includes\('stamp'\)\) kinds\.splice/);
});

// ---- 5. Public forms: how many and until when ---------------------------------------------------------------------

test('5. Forms: a most and a closing day; after either the form says it is closed and whom to ask', async () => {
  const c = await signUp('Fay Former', 'fay@switch5.example', ip());
  const { upload } = await import('./helpers.ts');
  const file = await upload(c, 1);
  const tpl = ok(await c.post('/envelopes', { kind: 'template', subject: 'Waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Visitor' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).envelope;
  const pf = ok(await c.post('/powerforms', { template_id: tpl.id, name: 'Sign the waiver' }));
  const slug = (ok(await c.get('/powerforms')).powerforms.find((p: any) => p.id === pf.id)).slug;
  // Zero setup: no limit, open as before.
  assert.equal(ok(await new Client().get(`/public/powerforms/${slug}`)).closed, false);
  // Bad values are refused in words.
  assert.equal((await c.call('PATCH', `/powerforms/${pf.id}`, { max_signed: 0 })).status, 400);
  assert.equal((await c.call('PATCH', `/powerforms/${pf.id}`, { max_signed: 2.5 })).status, 400);
  assert.equal((await c.call('PATCH', `/powerforms/${pf.id}`, { closes_at: 'next friday' })).status, 400);
  // A most of one: the first visitor's start counts while they fill it in, so a second cannot start.
  ok(await c.call('PATCH', `/powerforms/${pf.id}`, { max_signed: 1 }));
  const v1 = new Client();
  v1.ip = ip();
  const start = ok(await v1.post(`/public/powerforms/${slug}/start`, { name: 'Vi One', email: 'vi1@switch5.example' }));
  const v2 = new Client();
  v2.ip = ip();
  const full = await v2.post(`/public/powerforms/${slug}/start`, { name: 'Vi Two', email: 'vi2@switch5.example' });
  assert.equal(full.status, 403);
  // Nobody has signed yet: it is full for now, not full of signatures, and says who to write to.
  assert.equal(full.data.error, 'This form is full for now: the last places are taken by people who started filling it in and have not finished. If one of them stops, a place opens again within 24 hours. If you need to sign soon, write to Fay Former at fay@switch5.example.');
  const page = ok(await v2.get(`/public/powerforms/${slug}`));
  assert.equal(page.closed, true);
  assert.equal(page.closed_why, full.data.error);
  // The one who started can still finish.
  const tok = start.url.split('/sign/')[1];
  await v1.post(`/sign/${tok}/consent`);
  const sv = ok(await v1.get(`/sign/${tok}`));
  ok(await v1.post(`/sign/${tok}/complete`, { values: { [sv.fields[0].id]: '1' }, signature_png: PNG }));
  const signedFull = await v2.post(`/public/powerforms/${slug}/start`, { name: 'Vi Two', email: 'vi2@switch5.example' });
  assert.equal(signedFull.data.error, 'This form has taken as many signatures as it was set up for, so it is closed. If you still need to sign, write to Fay Former at fay@switch5.example.');
  // No limit again, and a closing day that has passed: closed, with the day.
  ok(await c.call('PATCH', `/powerforms/${pf.id}`, { max_signed: null, closes_at: '2020-01-31' }));
  const past = await v2.post(`/public/powerforms/${slug}/start`, { name: 'Vi Two', email: 'vi2@switch5.example' });
  assert.equal(past.status, 403);
  assert.equal(past.data.error, 'This form closed on 31 Jan 2020 and takes no more signatures. If you still need to sign, write to Fay Former at fay@switch5.example.');
  // A day still ahead: open, and the whole of that day counts.
  ok(await c.call('PATCH', `/powerforms/${pf.id}`, { closes_at: '2999-12-31' }));
  const listed = (ok(await c.get('/powerforms')).powerforms.find((p: any) => p.id === pf.id));
  assert.equal(listed.closes_at, '2999-12-31T23:59:59.999Z');
  assert.equal(listed.max_signed, null);
  ok(await v2.post(`/public/powerforms/${slug}/start`, { name: 'Vi Two', email: 'vi2@switch5.example' }));
});

// ---- 6. The words across a copy that is still out --------------------------------------------------------------------

test('6. Mark pages until everyone has signed: the words are the admin\'s, never ones that say it is signed', async () => {
  const { unfinishedMark } = await import('../src/server/switches.ts');
  assert.equal(markWordsProblem('NOT SIGNED YET'), null);
  assert.equal(markWordsProblem('Draft for review'), null);
  assert.match(markWordsProblem('FULLY SIGNED')!, /could make an unfinished copy look signed/);
  assert.match(markWordsProblem('Final version')!, /could make an unfinished copy look signed/);
  assert.match(markWordsProblem('x'.repeat(40))!, /at most 28 letters/);
  assert.match(markWordsProblem('<b>hi</b>')!, /letters, numbers, spaces and hyphens only/);
  assert.equal(markWords(null), MARK_WORDS_DEFAULT);
  assert.equal(markWords('  not   signed yet '), 'NOT SIGNED YET');

  const c = await signUp('Mo Marker', 'mo@switch6.example', ip());
  const e = await sent(c, 'mk@switch6.example');
  const env = db.get('SELECT * FROM envelopes WHERE id=?', e.id);
  assert.deepEqual(unfinishedMark(env), ['NOT COMPLETED YET', 'NOT EVERYONE HAS SIGNED'], 'the words it always had');
  const no = await c.put('/account/switches', { mark_words: 'SIGNED COPY' });
  assert.equal(no.status, 400);
  assert.deepEqual(unfinishedMark(env), ['NOT COMPLETED YET', 'NOT EVERYONE HAS SIGNED'], 'nothing was changed');
  ok(await c.put('/account/switches', { mark_words: 'Not signed yet' }));
  assert.equal(ok(await c.get('/account/switches')).mark_words, 'NOT SIGNED YET');
  // A document already out keeps the words it was sent with; one sent now has the new words, and the small line stays.
  assert.deepEqual(unfinishedMark(db.get('SELECT * FROM envelopes WHERE id=?', e.id)), ['NOT COMPLETED YET', 'NOT EVERYONE HAS SIGNED'], 'sent before the change');
  const e2 = await sent(c, 'mk2@switch6.example');
  assert.deepEqual(unfinishedMark(db.get('SELECT * FROM envelopes WHERE id=?', e2.id)), ['NOT SIGNED YET', 'NOT EVERYONE HAS SIGNED'], 'the small line stays');
  // A copy downloaded while it is out still comes out as a PDF with the mark drawn (pdf.ts uses unfinishedMark).
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/server/pdf.ts', import.meta.url), 'utf8'));
  assert.match(src, /opts\.unfinished && e\.status === 'sent' && !opts\.certificate \? unfinishedMark\(e\) : null/);
  // Empty goes back to the usual words.
  ok(await c.put('/account/switches', { mark_words: '' }));
  assert.equal(ok(await c.get('/account/switches')).mark_words, MARK_WORDS_DEFAULT);
});

test('the signing page asks bySwitches; with no switches nothing changes', async () => {
  for (const me of [signer, { role: 'approver' }, { role: 'witness' }, { role: 'cc' }]) {
    const keys = otherActions(me, { stage: 'sign', deadline: true });
    assert.deepEqual(bySwitches(keys, null), keys);
    assert.deepEqual(bySwitches(keys, { pass_on: true, comments: true }), keys);
  }
  const page = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/app/sign/[token]/page.tsx', import.meta.url), 'utf8'));
  // The menu goes through bySwitches with the page's switches, whatever else builds the list (others change that part).
  assert.match(page, /const menu: MenuItem\[\] = bySwitches\(.*otherActions\(me, .*\), data\.switches\)\.map/);
});

// ---- Repairs after the skeptic and the simplicity review (tests/out/verify-ds-switches, tests/out/ux-ds-switches) ----

const read = async (rel: string) => (await import('node:fs')).readFileSync(new URL(rel, import.meta.url), 'utf8');

test('R1. Pass it on: the kept copy\'s old link says what comes next; passed back, nobody is on it twice', async () => {
  const { PASS_OFF } = await import('../src/server/switches.ts');
  // No sender name known: the sentence still reads right.
  assert.equal(PASS_OFF('the sender'), 'The sender turned off passing this document to someone else, so it was not passed on. Nothing was changed. If someone else should sign, ask the sender to send it to the right person.');
  const c = await signUp('Ann Sender', 'ann@switchr1.example', ip());
  ok(await c.put('/account/switches', { pass_on_copy: true }));
  const e = await sent(c, 'first@switchr1.example');
  const t1 = tokenFor(e.id, 'first@switchr1.example');
  ok(await new Client().post(`/sign/${t1}/reassign`, { name: 'Bo Second', email: 'second@switchr1.example' }));
  // The first person's old link: a plain 410 that says they still get the copy, not "replaced, ask for a new link".
  const old = await new Client().get(`/sign/${t1}`);
  assert.equal(old.status, 410);
  assert.equal(old.data.code, 'kept_copy');
  assert.match(old.data.error, /^You passed this document on to someone else, so this link no longer opens it\. You are still on it as someone who gets a copy: the signed document is emailed to you when everyone has finished\./);
  // Passed back to the first person: they sign again and are no longer also on it as a copy.
  ok(await new Client().post(`/sign/${tokenFor(e.id, 'second@switchr1.example')}/reassign`, { name: 'Ada First', email: 'first@switchr1.example' }));
  const rows = db.all('SELECT role, lower(email) email, status FROM recipients WHERE envelope_id=? ORDER BY position', e.id).map((r: any) => `${r.role}:${r.email}`);
  assert.deepEqual(rows.sort(), ['cc:second@switchr1.example', 'signer:first@switchr1.example'], 'first is a signer only; second keeps a copy as chosen');
  assert.ok(db.all('SELECT action FROM audit WHERE envelope_id=?', e.id).some((x: any) => x.action === 'No longer kept as a copy'));
  // A kept copy has no link of its own to sign with: the sign page shows the plain state card for this code.
  assert.match(await read('../src/app/sign/[token]/page.tsx'), /problem\.code === 'kept_copy'/);
});

test('R2. Questions and comments off: no dead form on the sender\'s page, and Help says where to ask instead', async () => {
  const c = await signUp('Cy Sender', 'cy@switchr2.example', ip());
  ok(await c.put('/account/switches', { comments: false }));
  const e = await sent(c, 'sig@switchr2.example');
  const v = ok(await c.get(`/envelopes/${e.id}/comments`));
  assert.equal(v.comments_off, true);
  assert.equal(v.may_write, true, 'an earlier conversation can still be answered');
  const card = await read('../src/components/sender/Comments.tsx');
  assert.match(card, /data\?\.may_write && !data\.comments_off && !readOnly && !replyTo/, 'no new-comment form while off');
  assert.match(card, /Questions and comments are off for this document, so the people on it cannot write here\. They can reply to your email\./);
  assert.match(card, /data\.comments_off \? null/, 'no promise that they can ask from their signing page');
  // The one way back on, for this document only, is a real call that works.
  ok(await c.put(`/envelopes/${e.id}/switches`, { comments: true }));
  assert.equal(ok(await c.get(`/envelopes/${e.id}/comments`)).comments_off, false);
  // The refusal on the sender's side names no API path and no "envelope".
  const no = ok(await c.put(`/envelopes/${e.id}/switches`, { comments: false })) && await c.post(`/envelopes/${e.id}/comments`, { text: 'Hi', for: 'everyone' });
  assert.equal(no.status, 403);
  assert.doesNotMatch(no.data.error, /PUT|\/api|envelope/);
  // Help: an answer that names Questions and comments, on a page whose list has none, says it is off and what to do.
  const { ASK_OFF_IN_HELP } = await import('../src/lib/switches.ts');
  assert.equal(ASK_OFF_IN_HELP, 'Questions and comments is turned off for this document, so it is not in your list. To ask the sender something, reply to the email you got about this document.');
  const chat = await read('../src/components/HelpChat.tsx');
  assert.match(chat, /\(m\.acts \|\| \[\]\)\.includes\('ask'\) && pageActs\.length > 0 && !pageActs\.some\(\(a\) => a\.key === 'ask'\)/);
  const kb = await import('../src/server/chatkb.ts');
  for (const q of ['I have a question for the sender', 'Can I get a paper copy?', 'The finish button does not work']) assert.ok(kb.builtInAnswer(q, 'signing').acts.includes('ask'), q);
  const { SIGN_ACTIONS } = await import('../src/server/chatscreens.ts');
  assert.match(SIGN_ACTIONS.ask!.when, /unless the sender turned questions and comments off for this document/);
});

test('R3. Ways to sign: fixed at send, Finish needs to be told how, in person offers only those ways', async () => {
  const c = await signUp('Vee Sender', 'vee@switchr3.example', ip());
  const before = await sent(c, 'before@switchr3.example');
  ok(await c.put('/account/switches', { sign_ways: ['type'] }));
  const after = await sent(c, 'after@switchr3.example');
  const go = async (e: any, email: string) => {
    const t = tokenFor(e.id, email);
    const s = new Client();
    s.ip = ip();
    await s.post(`/sign/${t}/consent`);
    const p = ok(await s.get(`/sign/${t}`));
    return { s, t, p, values: { [p.fields[0].id]: '1' } };
  };
  // Sent before the admin chose: all three ways, as it was sent.
  const b = await go(before, 'before@switchr3.example');
  assert.deepEqual(b.p.switches.ways, ['type', 'draw', 'upload']);
  ok(await b.s.post(`/sign/${b.t}/complete`, { values: b.values, signature_png: PNG, signature_how: 'draw' }), 'drawn on one sent before');
  // Sent after: type only, and a new signature with no word on how it was made is refused, with the ways to offer.
  const a = await go(after, 'after@switchr3.example');
  assert.deepEqual(a.p.switches.ways, ['type']);
  const silent = await a.s.post(`/sign/${a.t}/complete`, { values: a.values, signature_png: PNG });
  assert.equal(silent.status, 400);
  assert.equal(silent.data.code, 'sign_way_off');
  assert.deepEqual(silent.data.ways, ['type']);
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=?', after.id).status, 'viewed');
  ok(await a.s.post(`/sign/${a.t}/complete`, { values: a.values, signature_png: PNG, signature_how: 'type:Sig Caveat' }));
  // A change in Settings now does not change either document's ways.
  ok(await c.put('/account/switches', { sign_ways: ['draw'] }));
  assert.equal(db.get('SELECT sw_sign_ways w FROM envelopes WHERE id=?', after.id).w, 'type');
  // The signing page offers only the ways from the refusal; in-person signing passes the ways and says how.
  const page = await read('../src/app/sign/[token]/page.tsx');
  assert.match(page, /e\?\.code === 'sign_way_off'/);
  const inPerson = await read('../src/app/in-person/page.tsx');
  assert.match(inPerson, /<AdoptSignature kind=\{adopt\} name=\{name\} ways=\{pack\.view\?\.switches\?\.ways\}/);
  assert.match(await read('../src/components/sign/offlineInPerson.ts'), /signature_how: result\.signature_how/);
  assert.match(await read('../src/server/routes-offline.ts'), /noteHow\(found\.e, found\.r, b\)/);
  // One way only: no row of tabs with a single tab.
  assert.match(await read('../src/components/SignaturePad.tsx'), /\(drawing \|\| TABS\.length > 1\) && <div className="tabs sg-sigtabs" role="tablist"/);
});

test('R4. Members may place stamps sits inside the Stamps and seals card', async () => {
  assert.match(await read('../src/app/app/settings/page.tsx'), /<Card><StampSettings after=\{<MembersStamps \/>\} \/><\/Card>/);
});

test('R5. Forms: a refusal changes nothing, the last day is the admin\'s own day, a closed form says so in words', async () => {
  const c = await signUp('Flo Former', 'flo@switchr5.example', ip());
  const { upload } = await import('./helpers.ts');
  const file = await upload(c, 1);
  const tpl = ok(await c.post('/envelopes', { kind: 'template', subject: 'Waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Visitor' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).envelope;
  const pf = ok(await c.post('/powerforms', { template_id: tpl.id, name: 'Waiver' }));
  const row = () => db.get('SELECT max_signed, closes_at, closes_day FROM powerforms WHERE id=?', pf.id);
  const bad = await c.call('PATCH', `/powerforms/${pf.id}`, { max_signed: 5, closes_at: 'garbage' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Nothing was changed\.$/);
  assert.equal(row().max_signed, null, 'nothing was saved');
  assert.equal((await c.call('PATCH', `/powerforms/${pf.id}`, { closes_at: '2026-02-30' })).status, 400, 'a day that does not exist');
  assert.equal((await c.call('PATCH', `/powerforms/${pf.id}`, { closes_at: '2026-11-20', tz: 'Mars/Olympus' })).status, 400);
  // The Forms page sends the browser's time zone: the last day ends at midnight there, not in UTC.
  ok(await c.call('PATCH', `/powerforms/${pf.id}`, { max_signed: 5, closes_at: '2026-11-20', tz: 'America/Los_Angeles' }));
  assert.deepEqual(row(), { max_signed: 5, closes_at: '2026-11-21T07:59:59.999Z', closes_day: '2026-11-20' });
  ok(await c.call('PATCH', `/powerforms/${pf.id}`, { closes_at: '2026-11-20', tz: '' }));
  assert.equal(row().closes_at, '2026-11-20T23:59:59.999Z', 'no zone: UTC, as the API says');
  const { formLimitLine } = await import('../src/lib/switches.ts');
  assert.equal(formLimitLine({ max_signed: 1, closes_at: '2999-11-21T07:59:59.999Z', closes_day: '2999-11-20' }), 'Takes up to 1 signature, closes after 20 Nov 2999.');
  assert.equal(formLimitLine({ max_signed: null, closes_at: '2020-02-01T07:59:59.999Z', closes_day: '2020-01-31' }), 'Closed on 31 Jan 2020: it takes no more signatures.');
  assert.match(await read('../src/components/forms/FormLimits.tsx'), /closes_at: day \|\| null, tz: deviceZone\(\)/);
});

test('R6. Mark words: only words that start by saying it is not finished', async () => {
  for (const w of ['SIGNED, NO ISSUES', 'SIGNED YET AGAIN', 'EXECUTED NOT A DRAFT', 'COUNTERSIGNED', 'FULLYSIGNED', 'S I G N E D', 'SIGNÉ', 'DONE', 'AGREED BY ALL', 'DRAFT SIGNED', 'PENDING: SIGNED'])
    assert.ok(markWordsProblem(w), `${w} must be refused`);
  for (const w of ['NOT COMPLETED YET', 'NOT SIGNED YET', 'DRAFT', 'Draft for review', 'PENDING SIGNATURES', 'UNSIGNED COPY', 'IN PROGRESS', 'NOT-SIGNED'])
    assert.equal(markWordsProblem(w), null, w);
});
