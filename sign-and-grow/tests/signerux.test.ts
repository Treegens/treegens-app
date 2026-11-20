// The person who signs, and the email that reaches them. Every test here pins down something an independent audit
// found (research/audit-2.json, "audit:signer", and the mail part of "audit:sender"). Each failed before its fix.
// What a screen decides is kept in plain functions (src/components/sign/fields.ts, src/lib/scans.ts) so it can be
// tested here without a browser. The last test reads a few promises straight from the source of the screens, for
// the things that are only markup or styling.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, PNG, draft, simple, upload, tokenFor, signUp, signAll, mailTo, type Server } from './helpers.ts';
import { accountMarks, tapOnMark, restoreMarks, saveBody, sameName, pageTitle, placeFlag, buildItems, keepTitle, readKept, writeKept } from '../src/components/sign/fields.ts';
import { scanWarning, pageList } from '../src/lib/scans.ts';
import { extractPages } from '../src/server/text.ts';
import { MAIL_RETRY_MINUTES } from '../src/server/mail.ts';
import { ACCESS_CODE_TRIES } from '../src/lib/policy.ts';

let db: Server['db'];
let env: Server['env'];
let cron: Server['cron'];
let jo: Client;
before(async () => {
  ({ db, env, cron } = await boot());
  jo = await signUp('Jo Sender', 'jo@example.com', '198.51.100.1');
});

// Public forms are limited per address, so everyone here comes from their own.
let n = 0;
const visitor = () => Object.assign(new Client(), { ip: `198.51.${100 + (++n >> 8)}.${n & 255}` });
const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
const toJo = (prefix: string) => mailTo('jo@example.com').filter((m) => m.subject.startsWith(prefix));
// A second, different one-pixel picture, so two signatures can be told apart.
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Two people who share one inbox, each with a signature of their own to place.
async function couple(subject: string, address = 'rivera.family@example.com') {
  const file = await upload(jo, 1);
  const r = await jo.post('/envelopes', {
    subject, ordered: false, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Alex Rivera', email: address }, { id: 'b', role: 'signer', name: 'Blair Rivera', email: address }],
    fields: [
      { id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.55, y: 0.5, w: 0.3, h: 0.06 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await jo.post(`/envelopes/${r.data.envelope.id}/send`)).status, 200);
  const [alex, blair] = db.all('SELECT id, name, token FROM recipients WHERE envelope_id=? ORDER BY position', r.data.envelope.id);
  return { id: r.data.envelope.id as string, alex, blair };
}
const expire = async (id: string) => {
  db.run('UPDATE envelopes SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), id);
  await cron.tick();
};

// ---- 1. A stored signature is shown before it is used --------------------------------------------------------------

test('a saved signature is never put on a page unseen, and never offered to the other person at a shared address', () => {
  const alexAccount = { email: 'rivera.family@example.com', name: 'Alex Rivera', signature_png: PNG, initials_png: PNG2 };
  // Blair opens her own link in the browser where Alex is signed in. Same address, another name: nothing is offered.
  assert.deepEqual(accountMarks(alexAccount, { email: 'Rivera.Family@example.com', name: 'Blair Rivera', role: 'signer' }), { signature: null, initials: null });
  // Alex, on his own link, is offered his own. Case, accents and spaces in the name make no difference.
  assert.deepEqual(accountMarks(alexAccount, { email: 'RIVERA.family@example.com', name: '  alex   RIVERA ', role: 'signer' }), { signature: PNG, initials: PNG2 });
  assert.equal(sameName('José Núñez', 'Jose Nunez'), true);
  assert.equal(sameName('', ''), false, 'two missing names are not a match');
  // Never in person (that device belongs to the host), and never for someone who is not signed in.
  assert.equal(accountMarks(alexAccount, { email: alexAccount.email, name: 'Alex Rivera', role: 'inperson' }).signature, null);
  assert.equal(accountMarks(null, { email: alexAccount.email, name: 'Alex Rivera', role: 'signer' }).signature, null);

  // The first tap with an account signature on offer opens the dialog with it as a choice. Nothing is applied.
  assert.deepEqual(tapOnMark({ current: null, seen: false, account: PNG }), { apply: false, offer: { image: PNG, from: 'account' } });
  // The same for a signature that was saved with this document on another device.
  assert.deepEqual(tapOnMark({ current: PNG, seen: false, account: PNG2 }), { apply: false, offer: { image: PNG, from: 'document' } });
  // Nothing stored: the dialog opens empty.
  assert.deepEqual(tapOnMark({ current: null, seen: false, account: null }), { apply: false, offer: null });
  // Only a mark made or confirmed in this tab goes straight onto the page.
  assert.deepEqual(tapOnMark({ current: PNG, seen: true, account: PNG2 }), { apply: true, offer: null });
});

// ---- 2. "Finish later" keeps the signature ---------------------------------------------------------------------------

test('autosave carries the adopted signature and initials, another device gets them back, and opening never wipes a mark', async () => {
  const file = await upload(jo, 1);
  const e = (await jo.post('/envelopes', {
    subject: 'Finish later', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'later@example.com' }],
    fields: [
      { id: 's1', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.06 },
      { id: 's2', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'i1', document_id: 'd', recipient_id: 'r', type: 'initials', page: 0, x: 0.6, y: 0.5, w: 0.1, h: 0.05 },
      { id: 't1', document_id: 'd', recipient_id: 'r', type: 'text', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.03 },
    ],
  })).data.envelope;
  await jo.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'later@example.com');
  const one = visitor(), two = visitor();
  await one.post(`/sign/${tok}/consent`);
  const first = (await one.get(`/sign/${tok}`)).data;
  const id = (type: string, i = 0) => first.fields.filter((f: any) => f.type === type)[i].id;

  // Device one: nothing stored yet. The person signs the first signature field, initials, and types an answer.
  const start = restoreMarks(first.fields, first.recipient, { sig: null, ini: null });
  assert.deepEqual([start.sig, start.ini, start.seen], [null, null, { signature: false, initials: false }]);
  const values = { ...start.values, [id('signature')]: '1', [id('initials')]: '1', [id('text')]: 'half way' };
  const body = saveBody(values, first.version, { sig: PNG, ini: PNG2 }, start.saved);
  assert.equal(body.signature_png, PNG, 'the signature goes with the autosave');
  assert.equal(body.initials_png, PNG2, 'and so do the initials');
  assert.equal((await one.post(`/sign/${tok}/save`, body)).status, 200);
  // Once the server has them they are not sent again with every keystroke.
  const again = saveBody({ ...values, [id('text')]: 'half way there' }, first.version, { sig: PNG, ini: PNG2 }, { sig: PNG, ini: PNG2 });
  assert.equal('signature_png' in again || 'initials_png' in again, false);

  // Device two, a fresh browser: the marks made on device one are there, with the signature to show for them.
  const second = (await two.get(`/sign/${tok}`)).data;
  const here = restoreMarks(second.fields, second.recipient, { sig: null, ini: null });
  assert.equal(here.sig, PNG);
  assert.equal(here.ini, PNG2);
  assert.equal(here.values[id('signature')], '1', 'the field signed on the first device is still signed');
  assert.equal(here.values[id('initials')], '1');
  assert.equal(here.values[id('signature', 1)], '', 'and the one not signed yet is still empty');
  assert.equal(here.values[id('text')], 'half way');
  assert.deepEqual(here.seen, { signature: false, initials: false }, 'a signature from another device is confirmed before a tap uses it');
  // Merely opening changes nothing: what the screen starts from is what counts as saved, and no mark is sent back.
  assert.equal(here.baseline, JSON.stringify(here.values));
  const idle = saveBody(here.values, second.version, { sig: here.sig, ini: here.ini }, here.saved);
  assert.equal('signature_png' in idle || 'initials_png' in idle, false);
  const progress = async () => (await full(jo, e.id)).envelope.recipients[0].progress;
  assert.deepEqual(await progress(), { fields: 4, filled: 3, required_left: 1, ready: false });

  // A field that was saved as signed with no signature to show for it (an older save) is asked for again on this
  // screen, but that is not written back by opening the page.
  db.run('UPDATE recipients SET signature_png=NULL WHERE envelope_id=?', e.id);
  const third = (await visitor().get(`/sign/${tok}`)).data;
  const bare = restoreMarks(third.fields, third.recipient, { sig: null, ini: null });
  assert.equal(bare.values[id('signature')], '');
  assert.equal(bare.baseline, JSON.stringify(bare.values), 'nothing counts as changed, so nothing is saved by itself');
  assert.equal((await progress()).filled, 3, 'the mark on the server is still there');
  // A mark made in this tab wins over the stored one after a reload.
  assert.equal(restoreMarks(second.fields, second.recipient, { sig: PNG2, ini: null }).sig, PNG2);
  assert.deepEqual(restoreMarks(second.fields, second.recipient, { sig: PNG2, ini: null }).seen, { signature: true, initials: false });
});

// ---- 3. "Fix my name" ------------------------------------------------------------------------------------------------

test('"Fix my name" fixes a spelling, cannot turn one signer into another, and the sender always hears', async () => {
  // The sender has switched off "When something needs you". A name change still reaches them.
  assert.equal((await jo.call('PATCH', '/me', { name: 'Jo Sender', notify: { problems: false } })).status, 200);
  try {
    const c = await couple('Whose name');
    const names = () => db.all('SELECT name FROM recipients WHERE envelope_id=? ORDER BY position', c.id).map((x: any) => x.name);

    // Blair opened the email for Alex by mistake and "fixes" the name to her own.
    const taken = await visitor().post(`/sign/${c.alex.token}/name`, { name: 'Blair Rivera' });
    assert.equal(taken.status, 200);
    assert.equal(taken.data.applied, false);
    assert.match(taken.data.message, /We did not change it/);
    assert.match(taken.data.message, /someone else on this document/);
    assert.match(taken.data.message, /Jo Sender/, 'the signer is told whom we asked');
    assert.deepEqual(names(), ['Alex Rivera', 'Blair Rivera'], 'nobody was renamed');
    // Also when it only borrows the other person's first name. (Asked through Blair's own link this time.)
    assert.equal((await visitor().post(`/sign/${c.blair.token}/name`, { name: 'Alex B. Rivera' })).data.applied, false);
    // A name with nothing in common with what the sender wrote is a different person, not a spelling.
    const other = await visitor().post(`/sign/${c.alex.token}/name`, { name: 'Morgan Lee' });
    assert.equal(other.data.applied, false);
    assert.match(other.data.message, /Only a small slip can be corrected here.*"Morgan Lee" differs from "Alex Rivera" by more than that/);
    assert.deepEqual(names(), ['Alex Rivera', 'Blair Rivera']);
    const asked = toJo('Name change asked for: Whose name');
    assert.equal(asked.length, 3, 'each one went to the sender as a question, whatever their email settings');
    assert.match(asked[0].html, /open the envelope, choose Correct next to Alex Rivera/);
    const trail = (await full(jo, c.id)).audit;
    assert.equal(trail.filter((a: any) => a.action === 'Name change asked for').length, 3);
    assert.equal(trail.some((a: any) => a.action === 'Signer corrected their name'), false);

    // A real spelling fix is applied, also a one-letter one in a single word, and the sender is told all the same.
    const fixed = await visitor().post(`/sign/${c.alex.token}/name`, { name: 'Alexander Rivera' });
    assert.deepEqual([fixed.data.applied, fixed.data.name], [true, 'Alexander Rivera']);
    assert.equal(toJo('Name corrected: Whose name').length, 1, 'although "When something needs you" is off');
    assert.ok((await full(jo, c.id)).audit.some((a: any) => a.action === 'Signer corrected their name'));
    const solo = await simple(jo, 'jon@example.com', { subject: 'One word', recipients: [{ id: 'r', role: 'signer', name: 'Jhon', email: 'jon@example.com' }] });
    await jo.post(`/envelopes/${solo.id}/send`);
    assert.equal((await visitor().post(`/sign/${tokenFor(solo.id, 'jon@example.com')}/name`, { name: 'John' })).data.applied, true);

    // A fix is measured against the name the sender wrote, so a name cannot be walked away in small steps:
    // "Alexander Smith" shares a word with the name as it stands now, but none with "Alex Rivera".
    const drift = await visitor().post(`/sign/${c.alex.token}/name`, { name: 'Alexander Smith' });
    assert.equal(drift.data.applied, false);
    assert.deepEqual(names(), ['Alexander Rivera', 'Blair Rivera']);

    // Passing the document on is the sender's business too, whatever their settings.
    assert.equal((await visitor().post(`/sign/${c.blair.token}/reassign`, { name: 'Casey Cole', email: 'casey@example.com' })).status, 200);
    assert.equal(toJo('Reassigned: Whose name').length, 1);
  } finally {
    await jo.call('PATCH', '/me', { name: 'Jo Sender', notify: { problems: true } });
  }
});

// ---- 4. The sender hears about links that do not open ---------------------------------------------------------------

test('a dead link is news again after more time, behind an access code, and when a replaced link is opened', async () => {
  // Expired: the first open tells the sender, the second does not.
  const e = await simple(jo, 'late@example.com', { subject: 'Runs out' });
  await jo.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'late@example.com');
  await expire(e.id);
  const told = () => toJo('Could not open: Runs out').length;
  await visitor().get(`/sign/${tok}`);
  await visitor().get(`/sign/${tok}`);
  assert.equal(told(), 1);
  // The sender reopens it, the new deadline passes too, and the signer runs into it again: that is news again.
  assert.equal((await jo.post(`/envelopes/${e.id}/extend`, { days: 5 })).status, 200);
  await expire(e.id);
  await visitor().get(`/sign/${tok}`);
  await visitor().get(`/sign/${tok}`);
  assert.equal(told(), 2, 'more time cleared the mark');

  // An expired document behind an access code that was never typed: the sender still hears.
  const coded = await simple(jo, 'coded@example.com', { subject: 'Runs out locked', recipients: [{ id: 'r', role: 'signer', name: 'Cody Code', email: 'coded@example.com', access_code: '7777' }] });
  await jo.post(`/envelopes/${coded.id}/send`);
  await expire(coded.id);
  const locked = await visitor().get(`/sign/${tokenFor(coded.id, 'coded@example.com')}`);
  assert.equal(locked.data.locked, true);
  assert.equal(toJo('Could not open: Runs out locked').length, 1);

  // The wrong-code alert has its own mark: it is not silenced by an earlier "could not open", nor the other way round.
  assert.equal((await jo.post(`/envelopes/${coded.id}/extend`, { days: 5 })).status, 200);
  const cody = visitor(), codyTok = tokenFor(coded.id, 'coded@example.com');
  db.run('UPDATE recipients SET dead_link_alerted_at=? WHERE envelope_id=?', new Date().toISOString(), coded.id);
  for (let i = 0; i < 3; i++) await cody.post(`/sign/${codyTok}/unlock`, { code: 'nope' });
  assert.equal(toJo('Could not open: Runs out locked').length, 2, 'three wrong codes are told although the other mark was set');
  assert.equal(db.get('SELECT code_fails n FROM recipients WHERE envelope_id=?', coded.id).n, 3);
  db.run('UPDATE recipients SET dead_link_alerted_at=NULL WHERE envelope_id=?', coded.id);
  await expire(coded.id);
  await visitor().get(`/sign/${codyTok}`);
  assert.equal(toJo('Could not open: Runs out locked').length, 3, 'and the deadline is told although the code alert was given');

  // A link that was replaced is opened: the sender hears once, and the record says so.
  const moved = await simple(jo, 'old@example.com', { subject: 'Moved on' });
  await jo.post(`/envelopes/${moved.id}/send`);
  const old = tokenFor(moved.id, 'old@example.com');
  const rid = (await full(jo, moved.id)).envelope.recipients[0].id;
  assert.equal((await jo.post(`/envelopes/${moved.id}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'new@example.com' })).status, 200);
  assert.equal((await visitor().get(`/sign/${old}`)).status, 410);
  assert.equal((await visitor().get(`/sign/${old}`)).status, 410);
  const heard = toJo('Old link opened: Moved on');
  assert.equal(heard.length, 1, 'once for each replaced link');
  assert.match(heard[0].html, /before the address was changed to new@example\.com/);
  assert.equal((await full(jo, moved.id)).audit.filter((a: any) => a.action === 'Replaced link opened').length, 1);

  // Sending again clears the mark too: a reminder, and an address that is corrected.
  const mark = () => db.get('SELECT dead_link_alerted_at at FROM recipients WHERE envelope_id=?', moved.id).at;
  db.run('UPDATE recipients SET dead_link_alerted_at=? WHERE envelope_id=?', new Date().toISOString(), moved.id);
  assert.equal((await jo.post(`/envelopes/${moved.id}/remind`)).data.reminded, 1);
  assert.equal(mark(), null);
  db.run('UPDATE recipients SET dead_link_alerted_at=? WHERE envelope_id=?', new Date().toISOString(), moved.id);
  assert.equal((await jo.post(`/envelopes/${moved.id}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'newer@example.com' })).status, 200);
  assert.equal(mark(), null);
});

// ---- 5. "Email me the current link" says what it did ------------------------------------------------------------------

test('"Email me the current link" only says sent when an email went out, and says plainly when none will', async () => {
  const count = () => db.get('SELECT COUNT(*) n FROM emails').n;
  // The address was corrected: the current link goes to the new address, and the answer says sent.
  const moved = await simple(jo, 'was@example.com', { subject: 'Current link' });
  await jo.post(`/envelopes/${moved.id}/send`);
  const old = tokenFor(moved.id, 'was@example.com');
  const rid = (await full(jo, moved.id)).envelope.recipients[0].id;
  await jo.post(`/envelopes/${moved.id}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'is@example.com' });
  const sent = await visitor().post('/public/links/resend', { token: old });
  assert.deepEqual([sent.status, sent.data.sent, sent.data.result], [200, true, 'sent']);
  assert.equal(mailTo('is@example.com').length, 2, 'the request and the fresh link');
  assert.equal(mailTo('was@example.com').length, 1, 'nothing more goes to the old address');

  // The person was taken off the envelope: there is no current link, and the answer does not say "sent".
  const e = await draft(jo, { ordered: false, subject: 'Taken off' });
  await jo.post(`/envelopes/${e.id}/send`);
  const benTok = tokenFor(e.id, 'ben@example.com');
  const cur = (await full(jo, e.id)).envelope;
  const ben = cur.recipients.find((r: any) => r.email === 'ben@example.com');
  assert.equal((await jo.put(`/envelopes/${e.id}`, { subject: cur.subject, message: cur.message, ordered: cur.ordered, documents: cur.documents, recipients: cur.recipients.filter((r: any) => r.id !== ben.id), fields: cur.fields.filter((f: any) => f.recipient_id !== ben.id) })).status, 200);
  let before = count();
  const removed = await visitor().post('/public/links/resend', { token: benTok });
  assert.deepEqual([removed.status, removed.data.sent, removed.data.result], [200, false, 'removed']);
  assert.equal(count(), before, 'and indeed no email was written');

  // The envelope was voided after the link was replaced: nothing to send, and the answer says the document is closed.
  await jo.post(`/envelopes/${moved.id}/void`, { reason: 'No longer needed' });
  before = count();
  const closed = await visitor().post('/public/links/resend', { token: old });
  assert.deepEqual([closed.data.sent, closed.data.result], [false, 'closed']);
  assert.equal(count(), before);
  // Not a link of ours at all.
  assert.deepEqual((await visitor().post('/public/links/resend', { token: 'not-a-link' })).data, { ok: true, sent: false, result: 'unknown' });
  // The answers tell the holder of an old link nothing about who is on the document.
  for (const r of [removed, closed]) assert.doesNotMatch(JSON.stringify(r.data), /example\.com|Sam|Ben|Jo Sender/);
});

// ---- 6. "Find my documents" ------------------------------------------------------------------------------------------

test('"Find my documents" lists what someone signed while others have not, names people at a shared address, and says how to get the rest', async () => {
  // Ada signed, Ben has not: her document is in the list, and the line says where it stands.
  const half = await draft(jo, { ordered: false, subject: 'Half done', recipients: [
    { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada.half@example.com', routing_order: 1 },
    { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben.half@example.com', routing_order: 1 },
    { id: 'r3', role: 'cc', name: 'Cee Copy', email: 'cee.half@example.com', routing_order: 1 }] });
  await jo.post(`/envelopes/${half.id}/send`);
  assert.equal((await signAll(half.id, 'ada.half@example.com')).status, 200);
  let before = mailTo('ada.half@example.com').length;
  assert.equal((await visitor().post('/public/links/find', { email: 'ada.half@example.com' })).status, 200);
  let got = mailTo('ada.half@example.com').slice(before);
  assert.equal(got.length, 1, 'an email went out');
  assert.match(got[0].html, /Half done/);
  assert.match(got[0].html, /you signed it, others have not finished yet/);
  assert.match(got[0].html, new RegExp(`/sign/${tokenFor(half.id, 'ada.half@example.com')}`));
  // Voided later: what she signed is still hers to fetch, and the line says it was not completed.
  await jo.post(`/envelopes/${half.id}/void`, { reason: 'Changed plans' });
  before = mailTo('ada.half@example.com').length;
  await visitor().post('/public/links/find', { email: 'ada.half@example.com' });
  assert.match(mailTo('ada.half@example.com').slice(before)[0].html, /you signed it, and it was not completed by everyone/);
  // Ben never signed: a closed document is not sent to him.
  before = mailTo('ben.half@example.com').length;
  await visitor().post('/public/links/find', { email: 'ben.half@example.com' });
  assert.equal(mailTo('ben.half@example.com').length, before);

  // Two people on one address: every line says whose link it is.
  const c = await couple('Joint return', 'shared.inbox@example.com');
  before = mailTo('shared.inbox@example.com').length;
  await visitor().post('/public/links/find', { email: 'shared.inbox@example.com' });
  got = mailTo('shared.inbox@example.com').slice(before);
  assert.match(got[0].html, /for Alex Rivera · from Jo Sender · waiting for you/);
  assert.match(got[0].html, /for Blair Rivera · from Jo Sender · waiting for you/);
  assert.match(got[0].html, /More than one person uses this address/);
  const alexLine = got[0].html.split('</p>').find((p: string) => p.includes('for Alex Rivera'))!;
  assert.ok(alexLine.includes(c.alex.token) && !alexLine.includes(c.blair.token), 'the name stands with the link it belongs to');

  // More documents than fit in one email: it says how many are left and how to get them, and the next one carries on.
  const file = await upload(jo, 1);
  for (let i = 0; i < env.LINKS_PER_EMAIL + 2; i++) {
    const r = await jo.post('/envelopes', { subject: `Batch ${i + 1}`, send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Max Many', email: 'many@example.com' }],
      fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  before = mailTo('many@example.com').length;
  await visitor().post('/public/links/find', { email: 'many@example.com' });
  const first = mailTo('many@example.com').slice(before)[0].html;
  assert.equal(first.split('/sign/').length - 1, env.LINKS_PER_EMAIL);
  assert.match(first, /These are numbers 1 to 50 of 52/);
  assert.match(first, /2 more did not fit in this email\. To get them, ask again within a day/);
  await visitor().post('/public/links/find', { email: 'many@example.com' });
  const rest = mailTo('many@example.com').slice(before)[1].html;
  assert.equal(rest.split('/sign/').length - 1, 2, 'the second email holds the two that were left');
  assert.match(rest, /numbers 51 to 52 of 52/);
  assert.match(rest, /That was the last of them/);
});

// ---- 7. Scans and pictures -------------------------------------------------------------------------------------------

test('a picture is always flagged as a scan, a PDF says which pages have no text, and the flag stays with the file', async () => {
  const up = async (bytes: Uint8Array, name: string, type: string) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type }), name);
    const r = await jo.call('POST', '/files', f);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  // A PNG of a contract is a picture, whatever is on it.
  const photo = await up(png, 'photo-of-contract.png', 'image/png');
  assert.deepEqual([photo.is_scan, photo.scan_pages], [true, [1]]);
  // Page 1 typed, page 2 a picture, page 3 typed: the second page is named.
  const mixed = await PDFDocument.create();
  mixed.addPage([300, 300]).drawText('Cover page', { x: 20, y: 200 });
  mixed.addPage([300, 300]).drawImage(await mixed.embedPng(png), { x: 0, y: 0, width: 300, height: 300 });
  mixed.addPage([300, 300]).drawText('Last page', { x: 20, y: 200 });
  const some = await up(await mixed.save(), 'mixed.pdf', 'application/pdf');
  assert.deepEqual([some.is_scan, some.scan_pages], [true, [2]]);
  // A typed PDF is not flagged.
  const typed = await upload(jo, 2);
  assert.deepEqual([typed.is_scan, typed.scan_pages], [false, []]);

  // The flag is kept with the file: a draft that is opened again later still says it, document by document.
  const made = await jo.post('/envelopes', { subject: 'Scans', documents: [{ id: 'a', file_id: photo.id }, { id: 'b', file_id: some.id }, { id: 'c', file_id: typed.id }] });
  const docs = (await full(jo, made.data.envelope.id)).envelope.documents;
  assert.deepEqual(docs.map((d: any) => [d.is_scan, d.scan_pages]), [[true, [1]], [true, [2]], [false, []]]);
  // And the words the editor shows for each, at upload, on reopening and at Review, come from that.
  assert.match(scanWarning(docs[0]), /^This looks like a scan or a photo/);
  assert.match(scanWarning(docs[1]), /^Page 2 of this document has no real text/);
  assert.equal(scanWarning(docs[2]), '');
  assert.equal(pageList([3, 1, 2]), 'pages 1, 2 and 3');
  assert.equal(pageList([1, 2, 3, 4, 5, 6, 7, 8, 9]), 'pages 1, 2, 3, 4, 5, 6 and 3 more');
  // A file a signer attaches is not judged.
  const e = await simple(jo, 'attach@example.com');
  await jo.post(`/envelopes/${e.id}/send`);
  const f = new FormData();
  f.append('file', new Blob([png], { type: 'image/png' }), 'id.png');
  assert.equal((await visitor().call('POST', `/sign/${tokenFor(e.id, 'attach@example.com')}/upload`, f)).data.is_scan, false);
});

// ---- 8. Small things on the signing screen ---------------------------------------------------------------------------

test('the sender counts a radio group once, like the signer; the tab names the document; the pointer keeps off the text', async () => {
  const file = await upload(jo, 1);
  const box = { document_id: 'd', recipient_id: 'r', page: 0, w: 0.03, h: 0.02 };
  const e = (await jo.post('/envelopes', {
    subject: 'Choices', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Rae Radio', email: 'rae@example.com' }],
    fields: [
      { ...box, type: 'radio', group_name: 'Plan', label: 'Small', x: 0.1, y: 0.2 }, { ...box, type: 'radio', group_name: 'Plan', label: 'Large', x: 0.2, y: 0.2 },
      { ...box, type: 'checkbox', x: 0.1, y: 0.3, required: false },
      { document_id: 'd', recipient_id: 'r', type: 'full_name', page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.03 },
      { document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    ],
  })).data.envelope;
  await jo.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'rae@example.com');
  const rae = visitor();
  await rae.post(`/sign/${tok}/consent`);
  const v = (await rae.get(`/sign/${tok}`)).data;
  // What the signer's screen counts: the group, the tick box and the signature. The name is filled in for them.
  const items = buildItems(v.fields, (f: any) => !!f.value);
  assert.equal(items.length, 3);
  const progress = async () => (await full(jo, e.id)).envelope.recipients[0].progress;
  assert.deepEqual(await progress(), { fields: 3, filled: 0, required_left: 2, ready: false }, 'the sender sees the same three');
  await rae.post(`/sign/${tok}/save`, { values: { [v.fields.find((f: any) => f.label === 'Large').id]: '1' } });
  assert.deepEqual(await progress(), { fields: 3, filled: 1, required_left: 1, ready: false }, 'one choice in the group fills the group');

  // The browser tab says which document this is.
  assert.equal(pageTitle('Lease for 12 Elm Street'), 'Lease for 12 Elm Street · Sign&Grow');
  assert.equal(pageTitle(''), 'Sign&Grow');

  // "Sign here" goes above the field when nothing is there.
  const field = { x: 0.3, y: 0.4, w: 0.25, h: 0.05 }, flag = { w: 0.25, h: 0.03 }, gap = { x: 0.02, y: 0.01 };
  assert.equal(placeFlag(field, flag, gap, []), 'above');
  // A heading sits right above the field (the case in the audit): the pointer goes elsewhere, not over the words.
  const heading = { x: 0.1, y: 0.35, w: 0.4, h: 0.03 };
  assert.equal(placeFlag(field, flag, gap, [heading]), 'below');
  // Another field sits below as well: beside the field, on the right.
  const below = { x: 0.3, y: 0.47, w: 0.25, h: 0.05 };
  assert.equal(placeFlag(field, flag, gap, [heading, below]), 'right');
  // Words on the right too: the left is free.
  assert.equal(placeFlag(field, flag, gap, [heading, below, { x: 0.56, y: 0.4, w: 0.3, h: 0.04 }]), 'left');
  // A field at the very top of the page has no room above it.
  assert.equal(placeFlag({ x: 0.3, y: 0.01, w: 0.25, h: 0.05 }, flag, gap, []), 'below');
  // Text on every side: the side that covers least is used, never a worse one.
  const crowded = [heading, below, { x: 0.56, y: 0.4, w: 0.3, h: 0.04 }, { x: 0.02, y: 0.42, w: 0.01, h: 0.01 }];
  assert.equal(placeFlag(field, flag, gap, crowded), 'left');
});

// ---- 9. Emails the mail server will not take -------------------------------------------------------------------------

test('a refused email is tried again with growing gaps, the record says the truth, and the sender is told when it fails for good', async () => {
  // A stand-in for the mail server that can be switched off. The real one is never contacted.
  const g = globalThis as any;
  const taken: any[] = [];
  let up = false;
  process.env.SMTP_URL = 'smtp://mail.invalid';
  g.__tsmail = { sendMail: async (m: any) => { if (!up) throw new Error('connect ECONNREFUSED 127.0.0.1:25'); taken.push(m); } };
  const due = () => db.run("UPDATE emails SET next_try_at=? WHERE status='failed' AND next_try_at IS NOT NULL", new Date(Date.now() - 1000).toISOString());
  const actions = async (id: string) => (await full(jo, id)).audit.map((a: any) => a.action);
  try {
    const e = await simple(jo, 'far@example.com', { subject: 'Will leave later' });
    assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
    let d = await full(jo, e.id);
    // Not called sent: the record, and so the certificate, says the email could not be sent yet.
    assert.equal(d.audit.some((a: any) => a.action === 'Sent to recipient'), false);
    const line = d.audit.find((a: any) => a.action === 'Email could not be sent yet');
    assert.match(line.detail, /"Simple agreement"|"Will leave later"/);
    assert.match(line.detail, /Sam Signer <far@example\.com>.*ECONNREFUSED.*tried again automatically/);
    assert.deepEqual([d.deliveries[0].status, d.deliveries[0].tries], ['failed', 1]);
    const wait = Date.parse(d.deliveries[0].next_try_at) - Date.now();
    assert.ok(wait > (MAIL_RETRY_MINUTES[0] - 1) * 60_000 && wait <= MAIL_RETRY_MINUTES[0] * 60_000, 'the next try is a few minutes away');

    // The timer leaves it alone until it is due. Then it tries again, and the gap to the next try is longer.
    assert.deepEqual((await cron.tick()).mail, { sent: 0, failed: 0, dropped: 0 });
    due();
    assert.deepEqual((await cron.tick()).mail, { sent: 0, failed: 1, dropped: 0 });
    d = await full(jo, e.id);
    assert.equal(d.deliveries[0].tries, 2);
    assert.ok(Date.parse(d.deliveries[0].next_try_at) - Date.now() > (MAIL_RETRY_MINUTES[1] - 1) * 60_000, 'growing gaps');
    assert.equal(d.audit.filter((a: any) => a.action === 'Email could not be sent yet').length, 1, 'one line, not one for each try');

    // The mail server is back: the next try goes through, with everything the first one carried.
    up = true;
    due();
    assert.deepEqual((await cron.tick()).mail, { sent: 1, failed: 0, dropped: 0 });
    d = await full(jo, e.id);
    assert.deepEqual([d.deliveries[0].status, d.deliveries[0].tries, d.deliveries[0].next_try_at], ['sent', 3, null]);
    assert.match(d.audit.find((a: any) => a.action === 'Email sent').detail, /to Sam Signer <far@example\.com>, on try 3/);
    assert.equal(taken.length, 1);
    assert.equal(taken[0].to, 'far@example.com');
    assert.match(taken[0].from, /Jo Sender via Sign&Grow/);
    assert.equal(taken[0].replyTo, 'jo@example.com');
    assert.match(taken[0].text, new RegExp(`/sign/${tokenFor(e.id, 'far@example.com')}`));
    // With the mail server up, "Sent to recipient" is written, and only then.
    const fine = await simple(jo, 'near@example.com');
    await jo.post(`/envelopes/${fine.id}/send`);
    assert.ok((await actions(fine.id)).includes('Sent to recipient'));

    // Down for good: after the last try nobody tries again, the record says so, and the sender is told.
    up = false;
    const lost = await simple(jo, 'nowhere@example.com', { subject: 'Never leaves' });
    await jo.post(`/envelopes/${lost.id}/send`);
    for (let i = 0; i < MAIL_RETRY_MINUTES.length; i++) {
      due();
      await cron.tick();
    }
    d = await full(jo, lost.id);
    const mail = d.deliveries.find((m: any) => m.to_email === 'nowhere@example.com');
    assert.deepEqual([mail.status, mail.tries, mail.next_try_at], ['failed', MAIL_RETRY_MINUTES.length + 1, null]);
    assert.match(d.audit.find((a: any) => a.action === 'Email could not be sent').detail, /after 6 tries.*No more tries are made/);
    const alert = toJo('Email not delivered: Never leaves');
    assert.equal(alert.length, 1);
    assert.match(alert[0].html, /choose Correct next to their name/);
    due();
    assert.equal((await cron.tick()).mail.failed, 1, 'only the note to the sender is still being tried');
    assert.equal((await full(jo, lost.id)).deliveries.find((m: any) => m.to_email === 'nowhere@example.com').tries, MAIL_RETRY_MINUTES.length + 1);
    db.run("UPDATE emails SET next_try_at=NULL WHERE status='failed'");

    // A reminder the mail server will not take is not written down as a reminder sent.
    assert.equal((await jo.post(`/envelopes/${fine.id}/remind`)).data.reminded, 0);
    assert.equal((await actions(fine.id)).includes('Reminder sent'), false);
    db.run("UPDATE emails SET next_try_at=NULL WHERE status='failed'");

    // An email left "queued" because the process stopped while sending it is picked up too.
    up = true;
    taken.length = 0;
    db.run("INSERT INTO emails (to_email, subject, html, status, at, payload) VALUES ('stuck@example.com', 'Left behind', '<p>hello</p>', 'queued', ?, ?)", new Date(Date.now() - 20 * 60_000).toISOString(), JSON.stringify({ text: 'hello' }));
    db.run("INSERT INTO emails (to_email, subject, html, status, at, payload) VALUES ('busy@example.com', 'Going out now', '<p>hello</p>', 'queued', ?, '{}')", new Date().toISOString());
    assert.equal((await cron.tick()).mail.sent, 1);
    assert.deepEqual(taken.map((m) => m.to), ['stuck@example.com'], 'the one that is being sent this minute is left alone');
    db.run("DELETE FROM emails WHERE to_email='busy@example.com'");

    // A one-time link is never sent after it has run out: a password reset is good for an hour.
    up = false;
    taken.length = 0;
    assert.equal((await visitor().post('/auth/forgot', { email: 'jo@example.com' })).status, 200);
    const reset = db.get("SELECT id, status, expires_at FROM emails WHERE subject LIKE 'Reset your%' ORDER BY id DESC LIMIT 1");
    assert.equal(reset.status, 'failed');
    assert.ok(Date.parse(reset.expires_at) > Date.now());
    db.run('UPDATE emails SET expires_at=?, next_try_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), reset.id);
    up = true;
    assert.deepEqual((await cron.tick()).mail, { sent: 0, failed: 0, dropped: 1 });
    assert.equal(taken.length, 0, 'the expired link stayed where it was');
    assert.match(db.get('SELECT error, next_try_at FROM emails WHERE id=?', reset.id).error, /had expired/);

    // A signing link that was replaced meanwhile is not sent either: the new address has its own email.
    up = false;
    const moved = await simple(jo, 'typo@example.com', { subject: 'Wrong address' });
    await jo.post(`/envelopes/${moved.id}/send`);
    const rid = (await full(jo, moved.id)).envelope.recipients[0].id;
    up = true;
    taken.length = 0;
    assert.equal((await jo.post(`/envelopes/${moved.id}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'right@example.com' })).status, 200);
    due();
    assert.equal((await cron.tick()).mail.dropped, 1);
    assert.deepEqual(taken.map((m) => m.to), ['right@example.com']);

    // The completed document is attached on a later try as well.
    up = false;
    const done = await simple(jo, 'signs@example.com', { subject: 'Attach me' });
    up = true;
    await jo.post(`/envelopes/${done.id}/send`);
    up = false;
    taken.length = 0;
    assert.equal((await signAll(done.id, 'signs@example.com')).status, 200);
    up = true;
    due();
    await cron.tick();
    const copy = taken.find((m) => m.to === 'signs@example.com' && m.subject === 'Completed: Attach me');
    assert.equal(copy.attachments.length, 1);
    assert.equal(Buffer.from(copy.attachments[0].content).subarray(0, 4).toString(), '%PDF');
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
    db.run("UPDATE emails SET next_try_at=NULL WHERE status='failed'");
  }
  // With no mail server at all nothing is delivered, and the record does not say "sent" either.
  const none = await simple(jo, 'outbox@example.com');
  await jo.post(`/envelopes/${none.id}/send`);
  const trail = (await full(jo, none.id)).audit;
  assert.equal(trail.some((a: any) => a.action === 'Sent to recipient'), false);
  assert.match(trail.find((a: any) => a.action === 'Not emailed').detail, /No mail server is set up, so no email went out/);
});

// ---- 10. What someone signed stays theirs ----------------------------------------------------------------------------

test('someone who signed can still download it after the envelope is voided or expires, marked as not completed', async () => {
  const e = await draft(jo, { ordered: false, subject: 'Closed after signing', recipients: [
    { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada.kept@example.com', routing_order: 1 },
    { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben.kept@example.com', routing_order: 1 },
    { id: 'r3', role: 'cc', name: 'Cee Copy', email: 'cee.kept@example.com', routing_order: 1 }] });
  await jo.post(`/envelopes/${e.id}/send`);
  assert.equal((await signAll(e.id, 'ada.kept@example.com')).status, 200);
  const ada = tokenFor(e.id, 'ada.kept@example.com'), ben = tokenFor(e.id, 'ben.kept@example.com'), cee = tokenFor(e.id, 'cee.kept@example.com');
  const open = await visitor().get(`/sign/${ada}/download`);
  assert.equal(open.status, 200);
  const pagesBefore = (await PDFDocument.load(open.data)).getPageCount();

  await jo.post(`/envelopes/${e.id}/void`, { reason: 'We changed the terms' });
  const kept = await visitor().get(`/sign/${ada}/download`);
  assert.equal(kept.status, 200, 'what Ada signed is still hers to download');
  assert.equal((await PDFDocument.load(kept.data)).getPageCount(), pagesBefore + 1, 'with a page in front');
  const words = await extractPages(kept.data);
  assert.match(words[0], /Not completed by everyone/);
  assert.match(words[0], /was not completed by everyone, so this is not a finished agreement/);
  assert.match(words[0], /Jo Sender cancelled \(voided\) it/);
  assert.match(words[0], /We changed the terms/);
  assert.match(words[0], /what Ada Signer signed on/);
  assert.match(words[1], /NOT COMPLETED BY EVERYONE/, 'and every page of the document carries it');
  // Someone who had not signed, or only had a copy, gets nothing from a closed envelope, as before.
  assert.equal((await visitor().get(`/sign/${ben}/download`)).status, 403);
  assert.equal((await visitor().get(`/sign/${cee}/download`)).status, 403);
  assert.equal((await visitor().get(`/sign/${ada}/doc/${e.documents[0].id}`)).status, 403, 'the unsigned original stays closed');

  // The same when the deadline passes.
  const late = await draft(jo, { ordered: false, subject: 'Ran out after signing', recipients: [
    { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada.late@example.com', routing_order: 1 },
    { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben.late@example.com', routing_order: 1 }] });
  await jo.post(`/envelopes/${late.id}/send`);
  await signAll(late.id, 'ada.late@example.com');
  await expire(late.id);
  const after = await visitor().get(`/sign/${tokenFor(late.id, 'ada.late@example.com')}/download`);
  assert.equal(after.status, 200);
  assert.match((await extractPages(after.data))[0], /The deadline passed on .* before everyone had finished/);
});

test('two signers on one address each get their own completion email with their own link', async () => {
  const c = await couple('Both of us', 'both@example.com');
  for (const [who, png] of [[c.alex, PNG], [c.blair, PNG2]] as const) {
    const s = visitor();
    await s.post(`/sign/${who.token}/consent`);
    const v = (await s.get(`/sign/${who.token}`)).data;
    assert.equal((await s.post(`/sign/${who.token}/complete`, { values: { [v.fields[0].id]: '1' }, signature_png: png })).status, 200);
  }
  const done = mailTo('both@example.com').filter((m) => m.subject === 'Completed: Both of us');
  assert.equal(done.length, 2, 'one each, not one for the address');
  const forAlex = done.find((m) => m.html.includes('For Alex Rivera: Your document is complete'))!;
  const forBlair = done.find((m) => m.html.includes('For Blair Rivera: Your document is complete'))!;
  assert.ok(forAlex.link.endsWith(c.alex.token) && forBlair.link.endsWith(c.blair.token), 'each carries the link of the person it names');
  assert.match(forBlair.html, /This link is for Blair Rivera only/);
  // Someone alone on their address gets the plain heading.
  const solo = await simple(jo, 'alone@example.com', { subject: 'Just me' });
  await jo.post(`/envelopes/${solo.id}/send`);
  await signAll(solo.id, 'alone@example.com');
  assert.match(mailTo('alone@example.com').find((m) => m.subject === 'Completed: Just me')!.html, /<h1[^>]*>Your document is complete</);
  // "Signers are never sent marketing": no email about a document carries the line about what a dollar buys.
  for (const m of [...mailTo('both@example.com'), ...mailTo('alone@example.com')]) assert.doesNotMatch(m.html, /every dollar plants/);
  assert.match(mailTo('alone@example.com')[0].html, /Sent with Sign&amp;Grow\./);
  // An email to an account's own person about the account keeps it.
  assert.match(mailTo('jo@example.com')[0].html, /every dollar plants/);
});

// ---- Promises that are only markup or styling ------------------------------------------------------------------------
// These cannot be run without a browser. They were checked on a phone-sized screen by hand, and are read from the
// source here so that a later edit which drops one of them is noticed.

test('the signing screens keep what they promise in markup: new tab, labels, real controls, thumb-sized links, honest words', () => {
  const read = (p: string) => fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  const page = read('app/sign/[token]/page.tsx');
  // The impact card on the finished screen: "How we count" opens in a new tab, and nothing there is about paying.
  const impact = read('components/sign/parts.tsx').split('export function Impact')[1].split('export ')[0];
  assert.match(impact, /href="\/impact" target="_blank" rel="noreferrer">How we count/);
  assert.doesNotMatch(impact, /paid to Sign&Grow/);
  // Document view: told once that Text view has the whole document as text, and the page pictures are labelled.
  assert.match(page, /className="sg-vh">The pages below are shown as pictures.*choose Text view/);
  assert.match(read('components/PdfDoc.tsx'), /<canvas ref=\{canvas\} role="img" aria-label=\{`Page \$\{index \+ 1\} of/);
  // Tick boxes and radio buttons in Document view are the browser's own, and radio buttons sit in a named group.
  assert.match(page, /<input type="checkbox" className="sg-vh" checked=/);
  assert.match(page, /<input type="radio" className="sg-vh" name=/);
  assert.match(page, /role="radiogroup" aria-label=\{members\[0\]\.group_name/);
  assert.doesNotMatch(page, /role="checkbox"|role="radio" /);
  // The tab title, and the signature that is confirmed before use.
  assert.match(page, /useEffect\(\(\) => keepTitle\(data\?\.envelope\?\.subject\), \[data\?\.envelope\?\.subject\]\)/);
  assert.match(page, /tapOnMark\(\{ current: kind === 'signature' \? sig : ini, seen: seen\[kind\], account: account\[kind\] \}\)/);
  assert.doesNotMatch(page, /setSig\(\(s\) => s \|\| m\.user\.signature_png/, 'the account signature is no longer applied by itself');
  // Autosave is built by saveBody, which carries the signature.
  assert.match(page, /saveBody\(valuesRef\.current, version\.current/);
  // The access code screen: a refusal that names no time and no person is given both.
  assert.match(page, /Wait 10 minutes, then try again\. If you do not have the code, ask \$\{sender\.name\} for it: \$\{sender\.email\}/);
  // The consent text no longer promises a copy "at any time".
  assert.doesNotMatch(page, /download or print a copy at any time/);
  // "Email me the current link": the page has words for every answer that is not "sent".
  const dead = read('components/sign/deadEnds.tsx');
  for (const result of ['delayed', 'waiting', 'removed', 'closed', 'unknown']) assert.match(dead, new RegExp(`\\n  ${result}: \\[`));
  assert.match(dead, /state === 'sent' && result !== 'sent'/);
  // Stand-alone secondary links are 44 px tall on a phone.
  const css = read('app/styles/sign.css');
  assert.match(css, /\.sg-foot-links \.sg-link, \.sg-review \.sg-link, \.sg-more \{ display: inline-flex; align-items: center; min-height: 44px; \}/);
  // The scan warning is shown on reopening (it reads the stored flag) and once more at Review.
  assert.match(read('components/editor/StepAdd.tsx'), /scanWarning\(d\) && <p className="notice warn small"/);
  assert.match(read('components/editor/StepReview.tsx'), /docs\.filter\(\(d\) => scanWarning\(d\)\)\.map/);
});

// ---- After the second look (research/verify-owed-partial.json, "verify2:signerux") -----------------------------------
// Each test below failed on the code that look was made against, and holds the fix. The new tests have senders of
// their own, so the people they reach do not count towards the daily limit of the sender above.

let ipN = 0;
const sender = (name: string, email: string) => signUp(name, email, `192.0.2.${++ipN}`);
// Alex opens a request at the inbox a family shares, agrees, signs, initials and types an answer, and the page saves
// it all, as it does by itself ("Finish later").
async function startedByAlex(by: Client, subject: string) {
  const file = await upload(by, 1);
  const r = await by.post('/envelopes', {
    subject, send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'a', role: 'signer', name: 'Alex Rivera', email: 'home.rivera@example.com' }],
    fields: [
      { document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { document_id: 'd', recipient_id: 'a', type: 'initials', page: 0, x: 0.6, y: 0.5, w: 0.1, h: 0.05 },
      { document_id: 'd', recipient_id: 'a', type: 'text', label: 'Account number', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.envelope.id as string;
  const rec = db.get('SELECT id, token FROM recipients WHERE envelope_id=?', id);
  const alex = visitor();
  await alex.post(`/sign/${rec.token}/consent`);
  const v = (await alex.get(`/sign/${rec.token}`)).data;
  const values = Object.fromEntries(v.fields.map((f: any) => [f.id, f.type === 'text' ? 'Alex private 12345' : '1']));
  assert.equal((await alex.post(`/sign/${rec.token}/save`, saveBody(values, v.version, { sig: PNG, ini: PNG2 }, { sig: null, ini: null }))).status, 200);
  return { id, rid: rec.id as string, token: rec.token as string };
}
// What a fresh browser on that link finds, once it has agreed: the answers by field type, and the marks the screen starts from.
async function openedFresh(token: string) {
  const c = visitor();
  const first = (await c.get(`/sign/${token}`)).data;
  if (!first.recipient.consented) await c.post(`/sign/${token}/consent`);
  const v = (await c.get(`/sign/${token}`)).data;
  const start = restoreMarks(v.fields, v.recipient, { sig: null, ini: null });
  const by = (type: string) => start.values[v.fields.find((f: any) => f.type === type).id];
  return { c, agreed: first.recipient.consented as boolean, v, start, answers: [by('signature'), by('initials'), by('text')], marks: [v.recipient.signature_png, v.recipient.initials_png] };
}

test('a signature and answers stay with the person who made them: another person at the same address starts empty, a new spelling keeps them', async () => {
  const kim = await sender('Kim Sender', 'kim.marks@example.com');
  // The sender corrects the name with Correct to Blair, who shares the inbox. The link stays (it went to that inbox),
  // but nothing Alex agreed to, typed or signed is on Blair's page, and she cannot finish with Alex's signature.
  const a = await startedByAlex(kim, 'Marks belong to their maker');
  assert.equal((await kim.post(`/envelopes/${a.id}/correct`, { recipient_id: a.rid, name: 'Blair Rivera' })).status, 200);
  assert.equal(db.get('SELECT token FROM recipients WHERE id=?', a.rid).token, a.token);
  let b = await openedFresh(a.token);
  assert.equal(b.agreed, false, 'Blair agrees for herself');
  assert.equal(b.v.recipient.name, 'Blair Rivera');
  assert.deepEqual(b.marks, [null, null]);
  assert.deepEqual(b.answers, ['', '', ''], "nothing of Alex's is on Blair's page");
  assert.deepEqual([b.start.sig, b.start.ini], [null, null]);
  assert.equal((await full(kim, a.id)).envelope.recipients[0].progress.filled, 0, 'and the sender sees nothing filled in');
  const fin = await b.c.post(`/sign/${a.token}/complete`, { values: Object.fromEntries(b.v.fields.map((f: any) => [f.id, f.type === 'text' ? 'Blair 1' : '1'])), version: b.v.version });
  assert.equal(fin.status, 400);
  assert.match(fin.data.error, /Adopt a signature/);
  assert.match((await full(kim, a.id)).audit.find((x: any) => x.action === 'Recipient corrected').detail, /another person at the same address, so nothing that Alex Rivera had agreed to, filled in or signed was kept/);

  // A browser tab both of them use keeps its copy under the name it was made for, and never hands it to the other.
  const store = new Map<string, string>();
  const tab = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  writeKept(a.token, PNG, PNG2, 'Alex Rivera', tab);
  assert.deepEqual(readKept(a.token, 'Blair Rivera', tab), { sig: null, ini: null });
  assert.deepEqual(readKept(a.token, 'Alex Rivera', tab), { sig: PNG, ini: PNG2 });

  // The same through the editor (Edit envelope, PUT /envelopes/{id}).
  const ed = await startedByAlex(kim, 'The editor clears them too');
  const cur = (await full(kim, ed.id)).envelope;
  const put = await kim.put(`/envelopes/${ed.id}`, { subject: cur.subject, message: cur.message, ordered: cur.ordered, documents: cur.documents, recipients: cur.recipients.map((r: any) => ({ ...r, name: 'Casey Rivera' })), fields: cur.fields });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  b = await openedFresh(ed.token);
  assert.deepEqual([b.agreed, b.v.recipient.name, b.marks, b.answers], [false, 'Casey Rivera', [null, null], ['', '', '']]);

  // A spelling fixed by the sender is the same person: everything stays, also the agreement.
  const s = await startedByAlex(kim, 'A spelling keeps them');
  assert.equal((await kim.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, name: 'Alexander Rivera' })).status, 200);
  b = await openedFresh(s.token);
  assert.deepEqual([b.agreed, b.marks, b.answers], [true, [PNG, PNG2], ['1', '1', 'Alex private 12345']]);

  // "Fix my name" cannot hand Alex's request to Casey (the sender is asked, and Alex's marks stay on Alex's request),
  // and a spelling of Alex's own keeps what Alex did.
  const f = await startedByAlex(kim, 'Fix my name keeps them');
  assert.equal((await visitor().post(`/sign/${f.token}/name`, { name: 'Casey Rivera' })).data.applied, false);
  assert.deepEqual((await openedFresh(f.token)).marks, [PNG, PNG2]);
  assert.equal((await visitor().post(`/sign/${f.token}/name`, { name: 'Alex Riviera' })).data.applied, true);
  b = await openedFresh(f.token);
  assert.deepEqual([b.agreed, b.v.recipient.name, b.marks, b.answers], [true, 'Alex Riviera', [PNG, PNG2], ['1', '1', 'Alex private 12345']]);
});

test('"Fix my name" keeps the sender\'s own free signature free only under the name on their account, and never counts anything itself', async () => {
  const was = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_signerux'; // signatures are counted; nothing here calls the payment provider
  try {
    const mo = await sender('Maria Garcia', 'maria.own@example.com');
    const acct = (await mo.get('/me')).data.account.id;
    const balance = () => db.get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', acct).n;
    const start = balance();
    const own = async (subject: string) => {
      const e = await simple(mo, 'maria.own@example.com', { subject, recipients: [{ id: 'r', role: 'signer', name: 'Maria Garcia', email: 'maria.own@example.com' }] });
      assert.equal((await mo.post(`/envelopes/${e.id}/send`)).status, 200);
      const tok = tokenFor(e.id, 'maria.own@example.com');
      const c = visitor();
      await c.post(`/sign/${tok}/consent`);
      return { id: e.id, tok, c, row: () => db.get('SELECT name, free FROM recipients WHERE token=?', tok) };
    };
    const a = await own('My own lease');
    assert.deepEqual(a.row(), { name: 'Maria Garcia', free: 1 });
    // One word more is still a spelling of the same person, but it is not the name on her account, so the signature
    // would be somebody else's. Not applied: she is told what she can do, and asked by email.
    const longer = (await a.c.post(`/sign/${a.tok}/name`, { name: 'Maria Garcia Lopez' })).data;
    assert.equal(longer.applied, false);
    assert.match(longer.message, /This is Maria Garcia's own document, and signing it is free under the name on their account only/);
    assert.match(longer.message, /If you are Maria Garcia: change your name under Settings first/);
    assert.deepEqual(a.row(), { name: 'Maria Garcia', free: 1 });
    const asked = mailTo('maria.own@example.com').filter((m) => m.subject === 'Name change asked for: My own lease');
    assert.equal(asked.length, 1);
    assert.match(asked[0].html, /choose Correct next to Maria Garcia and type the name yourself\. It is then that person&#39;s signature and is counted like one/);
    // A one-letter change is another name here too.
    assert.equal((await a.c.post(`/sign/${a.tok}/name`, { name: 'Mario Garcia' })).data.applied, false);
    // Her own name in capitals is still the name on her account (isSelf in credits.ts decides): applied, still free.
    assert.equal((await a.c.post(`/sign/${a.tok}/name`, { name: 'MARIA GARCIA' })).data.applied, true);
    assert.deepEqual(a.row(), { name: 'MARIA GARCIA', free: 1 });
    const v = (await a.c.get(`/sign/${a.tok}`)).data;
    assert.equal((await a.c.post(`/sign/${a.tok}/complete`, { values: { [v.fields[0].id]: '1' }, signature_png: PNG, version: v.version })).status, 200);
    assert.equal(balance(), start, 'her own signature used nothing');
    assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", acct).n, 0);

    // What the refusal says works: with the longer name on her account, the same fix is applied and stays free.
    const b = await own('My second lease');
    assert.equal((await mo.call('PATCH', '/me', { name: 'Maria Garcia Lopez' })).status, 200);
    assert.equal((await b.c.post(`/sign/${b.tok}/name`, { name: 'Maria Garcia Lopez' })).data.applied, true);
    assert.deepEqual(b.row(), { name: 'Maria Garcia Lopez', free: 1 });
    assert.equal(balance(), start);
  } finally {
    if (was === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = was;
  }
});

test('"Fix my name" sees through look-alike letters, added titles and invisible characters, is fair to short names, and asks the sender once for each name', async () => {
  const lu = await sender('Lu Sender', 'lu.names@example.com');
  let k = 0;
  // Each name is tried on an envelope of its own: one person can ask five times an hour.
  const onPair = async (name: string) => {
    const file = await upload(lu, 1);
    const e = (await lu.post('/envelopes', { subject: `Look alike ${++k}`, send: true, documents: [{ id: 'd', file_id: file.id }],
      recipients: [{ id: 'a', role: 'signer', name: 'Alex Rivera', email: 'pair.rivera@example.com' }, { id: 'b', role: 'signer', name: 'Blair Rivera', email: 'pair.rivera@example.com' }],
      fields: ['a', 'b'].map((rid, i) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1 + i * 0.45, y: 0.5, w: 0.3, h: 0.06 })) })).data.envelope;
    const alex = db.get("SELECT token FROM recipients WHERE envelope_id=? AND name='Alex Rivera'", e.id).token;
    const r = (await visitor().post(`/sign/${alex}/name`, { name })).data;
    return { ...r, names: db.all('SELECT name FROM recipients WHERE envelope_id=? ORDER BY position', e.id).map((x: any) => x.name) };
  };
  const onSolo = async (written: string, name: string) => {
    const e = await simple(lu, 'solo.names@example.com', { subject: `Solo ${++k}`, recipients: [{ id: 'r', role: 'signer', name: written, email: 'solo.names@example.com' }] });
    await lu.post(`/envelopes/${e.id}/send`);
    const tok = tokenFor(e.id, 'solo.names@example.com');
    return { ...(await visitor().post(`/sign/${tok}/name`, { name })).data, stored: db.get('SELECT name FROM recipients WHERE token=?', tok).name, tok };
  };
  // Another recipient's name in letters that look the same, one letter off, or cut down to what they share.
  for (const name of ['Вlair Rivera', 'Blaır Rivera', 'Ｂlair Rivera', 'Blaire Rivera', 'Bliar Rivera', 'B. Rivera', 'Rivera']) {
    const r = await onPair(name);
    assert.equal(r.applied, false, name);
    assert.deepEqual(r.names, ['Alex Rivera', 'Blair Rivera'], name);
  }
  // A word written in two alphabets at once, with nobody else on the document to look like.
  const mixed = await onSolo('Sam Signer', 'Sаm Signer');
  assert.deepEqual([mixed.applied, mixed.stored], [false, 'Sam Signer']);
  assert.match(mixed.message, /written in two alphabets at once/);
  // Titles and claims added to a name are not a spelling of it.
  for (const name of ['Sam Signer, President of the United States', 'Sam Signer (on behalf of Blair Rivera, CEO)'])
    assert.deepEqual([(await onSolo('Sam Signer', name)).applied, (await onSolo('Sam Signer', name)).stored], [false, 'Sam Signer'], name);
  // Characters nobody can see are taken out before anything is compared or stored.
  const turned = await onSolo('Sam Signer', 'Sam Signer‮');
  assert.deepEqual([turned.applied, turned.stored], [true, 'Sam Signer']);
  const hidden = await onSolo('Sam Signer', 'Sam Signr​');
  assert.deepEqual([hidden.applied, hidden.stored], [true, 'Sam Signr']);
  // Short names: a letter added is a spelling fix. "Li" to "Lee" changes two letters, and says so, not "a different name".
  assert.equal((await onSolo('Jo', 'Joe')).applied, true);
  assert.equal((await onSolo('Al', 'Ali')).applied, true);
  const li = await onSolo('Li', 'Lee');
  assert.equal(li.applied, false);
  assert.match(li.message, /Only a small slip can be corrected here, such as a letter missing or two swapped, and "Lee" differs from "Li" by more than that/);
  assert.doesNotMatch(li.message, /different name/);

  // The same question is put to the sender once; another name is another question.
  const q = await onSolo('Sam Signer', 'Morgan Lee');
  for (let i = 0; i < 2; i++) assert.equal((await visitor().post(`/sign/${q.tok}/name`, { name: 'Morgan Lee' })).data.applied, false);
  await visitor().post(`/sign/${q.tok}/name`, { name: 'Morgan Leigh' });
  const subject = db.get('SELECT e.subject s FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.token=?', q.tok).s;
  assert.equal(mailTo('lu.names@example.com').filter((m) => m.subject === `Name change asked for: ${subject}`).length, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM audit a JOIN recipients r ON r.envelope_id=a.envelope_id WHERE r.token=? AND a.action='Name change asked for'", q.tok).n, 2);
});

test('"Find my documents" carries on after the last line it sent, so a document that arrives or changes in between is never left out', async () => {
  const ny = await sender('Ny Sender', 'ny.docs@example.com');
  const file = await upload(ny, 1);
  const ids: Record<string, string> = {};
  const sendOne = async (i: number) => {
    const subject = `Nora ${String(i).padStart(3, '0')}`;
    const r = await ny.post('/envelopes', { subject, send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Nora Newman', email: 'nora.docs@example.com' }],
      fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids[subject] = r.data.envelope.id;
  };
  for (let i = 1; i <= 55; i++) await sendOne(i);
  const ask = async () => {
    const before = mailTo('nora.docs@example.com').length;
    assert.equal((await visitor().post('/public/links/find', { email: 'nora.docs@example.com' })).status, 200);
    const m = mailTo('nora.docs@example.com').slice(before);
    assert.equal(m.length, 1);
    return { html: m[0].html as string, listed: [...m[0].html.matchAll(/>(Nora \d{3})</g)].map((x: any) => x[1]) };
  };
  const first = await ask();
  assert.equal(first.listed.length, 50);
  assert.deepEqual([first.listed[0], first.listed[49]], ['Nora 055', 'Nora 006']);
  assert.match(first.html, /These are numbers 1 to 50 of 55, newest first/);
  // Between the two asks a new document arrives, and one from the first email is signed (so it moved to the top).
  await sendOne(56);
  assert.equal((await signAll(ids['Nora 030'], 'nora.docs@example.com')).status, 200);
  const second = await ask();
  assert.deepEqual(second.listed, ['Nora 030', 'Nora 056', 'Nora 005', 'Nora 004', 'Nora 003', 'Nora 002', 'Nora 001']);
  assert.match(second.html, /The first 2 below are new, or changed, since the last email\. After them the list carries on where that email stopped, with numbers 52 to 56 of 56, newest first\./);
  assert.match(second.html, /That was the last of them/);
  // Between them, the two emails reached every document, and only the changed one twice.
  const all56 = new Set([...first.listed, ...second.listed]);
  assert.equal(all56.size, 56);
  assert.equal(first.listed.length + second.listed.length, 57);
});

test('an email tried again later never asks someone who has finished, never carries a withdrawn invitation, and the sender\'s own is on the record', async () => {
  // A stand-in for the mail server that refuses whatever `refuse` says. The real one is never contacted.
  const g = globalThis as any;
  const taken: any[] = [];
  let refuse: (m: any) => boolean = () => true;
  process.env.SMTP_URL = 'smtp://mail.invalid';
  g.__tsmail = { sendMail: async (m: any) => { if (refuse(m)) throw new Error('421 try again later'); taken.push(m); } };
  const due = () => db.run("UPDATE emails SET next_try_at=? WHERE status='failed' AND next_try_at IS NOT NULL", new Date(Date.now() - 1000).toISOString());
  const to = (email: string) => taken.filter((m) => m.to === email).map((m) => m.subject);
  try {
    const mi = await sender('Mi Sender', 'mi.mail@example.com');
    // The request cannot be sent. The sender passes the link on by hand, and the person signs with it. When the mail
    // server is back, the completed copy goes out, and the request that asks them to sign does not.
    const e = await simple(mi, 'byhand.mail@example.com', { subject: 'Signed by hand' });
    assert.equal((await mi.post(`/envelopes/${e.id}/send`)).status, 200);
    assert.equal((await signAll(e.id, 'byhand.mail@example.com')).status, 200);
    refuse = () => false;
    due();
    await cron.tick();
    assert.deepEqual(to('byhand.mail@example.com'), ['Completed: Signed by hand']);
    assert.match(db.get("SELECT error FROM emails WHERE to_email='byhand.mail@example.com' AND subject='Signed by hand'").error, /the person it asks had already finished/);
    assert.equal((await full(mi, e.id)).audit.some((a: any) => a.action === 'Email sent' && a.detail.startsWith('"Signed by hand"')), false, 'and the record does not say it was sent');

    // A reminder that could not be sent is not delivered to the one who signed in the meantime, only to the other.
    const two = await draft(mi, { ordered: false, subject: 'Reminder after signing', recipients: [
      { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada.mail@example.com', routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben.mail@example.com', routing_order: 1 }] });
    assert.equal((await mi.post(`/envelopes/${two.id}/send`)).status, 200);
    refuse = () => true;
    await mi.post(`/envelopes/${two.id}/remind`);
    refuse = () => false;
    assert.equal((await signAll(two.id, 'ada.mail@example.com')).status, 200);
    taken.length = 0;
    due();
    await cron.tick();
    assert.deepEqual(to('ada.mail@example.com'), [], 'Ada is not reminded of what she signed');
    assert.deepEqual(to('ben.mail@example.com'), ['Reminder: Reminder after signing'], 'Ben still is');

    // A copy asks nothing, so a copy that could not be sent still goes out later.
    refuse = () => true;
    const copied = await simple(mi, 'signs.copy@example.com', { subject: 'With a copy', recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'signs.copy@example.com' }, { id: 'c', role: 'cc', name: 'Cee Copy', email: 'cee.copy@example.com' }] });
    await mi.post(`/envelopes/${copied.id}/send`);
    refuse = () => false;
    taken.length = 0;
    due();
    await cron.tick();
    assert.deepEqual(to('cee.copy@example.com'), ['With a copy']);

    // A team invitation that was withdrawn, or replaced by a newer one, is not delivered late. The newer one is.
    refuse = () => true;
    assert.equal((await mi.post('/account/invites', { email: 'gone.invite@example.com' })).status, 200);
    assert.equal((await mi.call('DELETE', `/account/invites/${db.get("SELECT id FROM invites WHERE email='gone.invite@example.com'").id}`)).status, 200);
    await mi.post('/account/invites', { email: 'twice.invite@example.com' });
    await mi.post('/account/invites', { email: 'twice.invite@example.com' });
    refuse = () => false;
    taken.length = 0;
    due();
    await cron.tick();
    assert.deepEqual(to('gone.invite@example.com'), []);
    const twice = taken.filter((m) => m.to === 'twice.invite@example.com');
    assert.equal(twice.length, 1);
    assert.ok(twice[0].html.includes(`invite=${db.get("SELECT token FROM invites WHERE email='twice.invite@example.com'").token}`), 'the one that still works');

    // The sender's own request on their own document is on the record like anyone's when it cannot be sent.
    refuse = () => true;
    const self = await simple(mi, 'mi.mail@example.com', { subject: 'My own, refused', recipients: [{ id: 'r', role: 'signer', name: 'Mi Sender', email: 'mi.mail@example.com' }] });
    await mi.post(`/envelopes/${self.id}/send`);
    const line = (await full(mi, self.id)).audit.find((a: any) => a.action === 'Email could not be sent yet');
    assert.match(line?.detail || '', /"My own, refused" to Mi Sender <mi\.mail@example\.com>.*tried again automatically/);
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
    db.run("UPDATE emails SET next_try_at=NULL WHERE status='failed'");
  }
});

test('a frozen access code on a closed envelope can be replaced, so the signer reaches their copy again; a damaged PDF is refused in words; a fresh link to a finished document says view', async () => {
  const fe = await sender('Fe Sender', 'fe.code@example.com');
  const e = await draft(fe, { ordered: false, subject: 'Frozen after closing', recipients: [
    { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada.code@example.com', routing_order: 1, access_code: '123456' },
    { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben.code@example.com', routing_order: 1 }] });
  assert.equal((await fe.post(`/envelopes/${e.id}/send`)).status, 200);
  const ada = db.get("SELECT id, token FROM recipients WHERE envelope_id=? AND email='ada.code@example.com'", e.id);
  const own = visitor();
  await own.post(`/sign/${ada.token}/unlock`, { code: '123456' });
  await own.post(`/sign/${ada.token}/consent`);
  const v = (await own.get(`/sign/${ada.token}`)).data;
  const values = Object.fromEntries(v.fields.map((f: any) => [f.id, f.type === 'text' ? 'x' : '1']));
  assert.equal((await own.post(`/sign/${ada.token}/complete`, { values, signature_png: PNG, initials_png: PNG, version: v.version })).status, 200);
  assert.equal((await fe.post(`/envelopes/${e.id}/void`, { reason: 'Plans changed' })).status, 200);
  // Wrong codes typed on the closed document, from anywhere, freeze the code. The right one opens nothing now.
  for (let i = 0; i < ACCESS_CODE_TRIES; i++) await visitor().post(`/sign/${ada.token}/unlock`, { code: `wrong${i}` });
  const phone = visitor();
  const frozen = await phone.post(`/sign/${ada.token}/unlock`, { code: '123456' });
  assert.equal(frozen.status, 423);
  assert.match(frozen.data.error, /Fe Sender has been told and can set a new code\. Ask them for the new one/);
  assert.equal((await phone.get(`/sign/${ada.token}/download`)).status, 401);
  // What that screen says can be done, can be done: "Ask the sender" goes through on a closed envelope ...
  assert.equal((await phone.post(`/sign/${ada.token}/ask-code`)).status, 200);
  const toFe = (s: string) => mailTo('fe.code@example.com').filter((m) => m.subject === `${s}: Frozen after closing`);
  assert.equal(toFe('Access code needed').length, 1);
  assert.match(toFe('Access code frozen')[0].html, /choose Correct next to their name and type a new access code/);
  // ... the envelope page offers Correct for the code once the envelope is closed ...
  assert.match(fs.readFileSync(new URL('../src/components/sender/Recipients.tsx', import.meta.url), 'utf8'), /e\.status !== 'draft' && !!r\.access_code && \([\s\S]{0,200}onCorrect\(\{ \.\.\.r, code_only: true \}\)/);
  // ... and Correct takes a new code there. Only the code: who the person is cannot change once it is closed.
  const renamed = await fe.post(`/envelopes/${e.id}/correct`, { recipient_id: ada.id, name: 'Ada Other', email: 'ada.code@example.com' });
  assert.equal(renamed.status, 400);
  assert.match(renamed.data.error, /no longer out for signature, so the name and the address of Ada Signer can no longer be changed\. Nothing was changed/);
  assert.equal((await fe.post(`/envelopes/${e.id}/correct`, { recipient_id: ada.id, access_code: '654321' })).status, 200);
  assert.equal((await phone.post(`/sign/${ada.token}/unlock`, { code: '654321' })).status, 200);
  const copy = await phone.get(`/sign/${ada.token}/download`);
  assert.equal(copy.status, 200, 'her copy, from a new phone, after the envelope was voided');
  assert.equal(Buffer.from(copy.data.slice(0, 5)).toString(), '%PDF-');

  // A file that starts like a PDF and is cut short is the person's file, not our fault: 400 in words, never 500.
  const live = await simple(fe, 'attach.code@example.com', { subject: 'Attach a file' });
  await fe.post(`/envelopes/${live.id}/send`);
  const cut = new TextEncoder().encode('%PDF-1.4 this is not really a pdf');
  const asFile = () => {
    const f = new FormData();
    f.append('file', new Blob([cut], { type: 'application/pdf' }), 'cut-short.pdf');
    return f;
  };
  for (const r of [await visitor().call('POST', `/sign/${tokenFor(live.id, 'attach.code@example.com')}/upload`, asFile()), await fe.call('POST', '/files', asFile())]) {
    assert.equal(r.status, 400);
    assert.match(r.data.error, /That file could not be read as a PDF\. It looks damaged or cut short/);
  }

  // "Email me the current link" for a document everyone has finished: the email offers to view it, not to sign.
  const done = await simple(fe, 'was.code@example.com', { subject: 'Done later' });
  await fe.post(`/envelopes/${done.id}/send`);
  const old = tokenFor(done.id, 'was.code@example.com');
  await fe.post(`/envelopes/${done.id}/correct`, { recipient_id: (await full(fe, done.id)).envelope.recipients[0].id, name: 'Sam Signer', email: 'is.code@example.com' });
  assert.equal((await signAll(done.id, 'is.code@example.com')).status, 200);
  assert.equal((await visitor().post('/public/links/resend', { token: old })).data.result, 'sent');
  const fresh = mailTo('is.code@example.com').pop()!;
  assert.match(fresh.html, /You asked for a fresh link/);
  assert.match(fresh.html, /View completed document/);
  assert.doesNotMatch(fresh.html, /Review and sign/);
});
