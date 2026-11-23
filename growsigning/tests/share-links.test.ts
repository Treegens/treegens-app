// Share links: growsigning.com/<name>. The rules for a name, the sender's side, the "Who are you?" page with its code,
// what a closed document says, the limits, and public forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Client, signUp, draft, simple, signAll, tokenFor, mailTo, upload } from './helpers.ts';
import { RESERVED, shareNameFrom, shareNameProblem, isShareName, nextFreeName, tidyShareName, shareLinkShown, SHARE_NAME_MAX } from '../src/lib/sharename.ts';
import { SHARE_LOOKUPS_PER_MINUTE, SHARE_CODE_ASKS_PER_HOUR, SIGNER_CODE_TRIES } from '../src/lib/policy.ts';

const s = await boot();
const db = s.db;
const links = await import('../src/server/sharelinks.ts');

let n = 0;
const visitor = () => Object.assign(new Client(), { ip: `198.51.100.${++n}` });
const codeFor = (email: string) => /(\d{6}) is your code/.exec(mailTo(email).filter((m: any) => /^Your code to open/.test(m.subject)).pop()?.html || '')?.[1] || '';
const audits = (eid: string) => db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', eid).map((a: any) => a.action);

// ---- Names ---------------------------------------------------------------------------------------------------------

test('a name comes from the document name: small letters, hyphens, ASCII, 3 to 60 characters', () => {
  assert.equal(shareNameFrom('Garden Agreement'), 'garden-agreement');
  assert.equal(shareNameFrom('  Garden   Agreement (v2).pdf '), 'garden-agreement-v2-pdf');
  assert.equal(shareNameFrom("Müller's Vertrag für Straße 5"), 'mullers-vertrag-fur-strasse-5');
  assert.equal(shareNameFrom('Contrat de Noël: été'), 'contrat-de-noel-ete');
  assert.equal(shareNameFrom('Smørrebrød Łódź'), 'smorrebrod-lodz');
  // No Latin letter at all: nothing comes out, and the server falls back to a plain name.
  assert.equal(shareNameFrom('契約書'), '');
  assert.equal(shareNameFrom('Договор аренды'), '');
  const long = shareNameFrom('word '.repeat(40));
  assert.ok(long.length <= SHARE_NAME_MAX && isShareName(long) && !long.endsWith('-'), long);
  assert.ok(shareNameFrom('x'.repeat(200)).length === SHARE_NAME_MAX);
  // What a sender types or pastes is tidied the same way.
  assert.equal(tidyShareName('https://growsigning.com/Garden Agreement'), 'garden-agreement');
  assert.equal(tidyShareName('/Garden_Agreement/'), 'garden-agreement');
  assert.equal(shareLinkShown('https://growsigning.com/garden-agreement'), 'growsigning.com/garden-agreement');
});

test('only a well-formed name is ever a name', () => {
  for (const ok of ['abc', 'garden-agreement', 'nda-2026', '2026-lease', 'a1b']) assert.equal(shareNameProblem(ok), null, ok);
  for (const bad of ['', 'ab', 'Garden', 'garden agreement', 'garden_agreement', '-garden', 'garden-', 'garden--agreement', 'garden.pdf', 'gärten', 'a/b', '..', 'x'.repeat(61), '12345', '2026-11-23'])
    assert.ok(shareNameProblem(bad), `should be refused: ${bad}`);
  assert.ok(!isShareName('../etc') && !isShareName('a%2Fb') && !isShareName(undefined) && !isShareName('ab'));
});

test('reserved: every folder and file at the top of src/app and public, and the words a site keeps for itself', () => {
  const here = (dir: string) => fs.readdirSync(path.join(import.meta.dirname, '..', dir)).filter((f) => !f.startsWith('['));
  for (const f of [...here('src/app'), ...here('public')]) assert.ok(RESERVED.has(f.toLowerCase()), `src/lib/sharename.ts RESERVED is missing "${f}", which is at the top level of the site`);
  for (const w of ['app', 'api', 'login', 'signup', 'pricing', 'help', 'security', 'sign', 'f', 'verify', 'admin', 'www', 'mail', 'static', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known', 'billing', 'support', 'settings', 'terms', 'privacy'])
    assert.ok(RESERVED.has(w), w);
  for (const w of ['login', 'pricing', 'security', 'admin', 'support', 'billing', 'static', 'verify']) assert.match(shareNameProblem(w) || '', /page of this site/, w);
  // A longer name that only starts like a page is a document's name.
  assert.equal(shareNameProblem('pricing-agreement-2026'), null);
  assert.equal(shareNameProblem('security-deposit-agreement'), null);
});

test('names that read as ours or as a brand are refused', () => {
  for (const w of ['growsigning', 'growsigning-nda', 'grow-signing-team', 'gr0wsigning-help', 'my-growsign-doc', 'treegens-planting', 'official-lease', 'lease-official', 'verified-contract'])
    assert.ok(shareNameProblem(w), `should be refused: ${w}`);
  for (const w of ['billing-support', 'account-security', 'support-team', 'payment-update', 'customer-service-desk', 'login-help']) assert.match(shareNameProblem(w) || '', /page of this service/, w);
  // A real document that happens to use one of those words is fine.
  for (const w of ['billing-agreement', 'support-contract-acme', 'service-level-agreement', 'payment-plan-jones']) assert.equal(shareNameProblem(w), null, w);
  // The fake-notice filter reads the name too (the server's part).
  for (const w of ['paypal-billing', 'pay-pal-invoice', 'microsoft-account-team', 'apple-support', 'paypa1-refund']) assert.ok(links.shareNameRefusal(w), `should be refused: ${w}`);
  assert.equal(links.shareNameRefusal('apple-orchard-lease'), null);
  assert.equal(links.shareNameRefusal('garden-agreement'), null);
});

test('the next free name: garden-agreement, garden-agreement-2, garden-agreement-3', () => {
  const taken = new Set(['garden-agreement', 'garden-agreement-2']);
  assert.equal(nextFreeName('garden-agreement', (c) => !taken.has(c)), 'garden-agreement-3');
  assert.equal(nextFreeName('free-name', () => true), 'free-name');
  const long = 'x'.repeat(SHARE_NAME_MAX);
  const next = nextFreeName(long, (c) => c !== long)!;
  assert.ok(next.length <= SHARE_NAME_MAX && next.endsWith('-2'));
});

// ---- The sender ----------------------------------------------------------------------------------------------------

test('a sender makes the link, and a second document with the same name gets the next free one', async () => {
  const c = await signUp('Olive Owner', 'olive@share.example', '203.0.113.21');
  const e1 = await draft(c, { subject: 'Please sign: Garden Agreement', send: true });
  // Nothing exists until the sender asks: a document has no public address by itself.
  let r = await c.get(`/envelopes/${e1.id}/share-link`);
  assert.deepEqual(r.data, { share_link: null, suggestion: 'garden-agreement', can_share: true });
  assert.equal((await visitor().get('/public/share/garden-agreement')).status, 404);
  assert.equal((await c.get(`/envelopes/${e1.id}`)).data.envelope.share_link, null);

  r = await c.put(`/envelopes/${e1.id}/share-link`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.share_link, { name: 'garden-agreement', url: 'http://test.local/garden-agreement', active: true });
  assert.deepEqual((await c.get(`/envelopes/${e1.id}`)).data.envelope.share_link, r.data.share_link);
  assert.ok(audits(e1.id).includes('Share link made'));

  const e2 = await draft(c, { subject: 'Please sign: Garden Agreement', send: true });
  assert.equal((await c.get(`/envelopes/${e2.id}/share-link`)).data.suggestion, 'garden-agreement-2');
  // Asking for the taken name outright: refused, with the free one.
  r = await c.put(`/envelopes/${e2.id}/share-link`, { name: 'Garden Agreement' });
  assert.equal(r.status, 409);
  assert.equal(r.data.suggestion, 'garden-agreement-2');
  assert.match(r.data.error, /taken by another document.*"garden-agreement-2" is free/);
  assert.equal((await c.put(`/envelopes/${e2.id}/share-link`, {})).data.share_link.name, 'garden-agreement-2');

  // Refused names say why, and nothing is saved.
  const e3 = await simple(c, 'sam@share.example', { subject: 'Billing', send: true });
  assert.equal((await c.get(`/envelopes/${e3.id}/share-link`)).data.suggestion, 'billing-agreement');
  for (const name of ['login', 'growsigning-nda', 'PayPal Billing', 'ab', 'official lease']) {
    r = await c.put(`/envelopes/${e3.id}/share-link`, { name });
    assert.equal(r.status, 422, name);
    assert.equal(r.data.code, 'share_name');
    // The way forward the refusal itself advises ("login" gives "login-agreement"), else a name from the title.
    assert.equal(r.data.suggestion, name === 'login' ? 'login-agreement' : 'billing-agreement', name);
  }
  assert.equal((await c.get(`/envelopes/${e3.id}/share-link`)).data.share_link, null);
  // A document whose name has no Latin letter still gets a plain suggestion.
  const e4 = await simple(c, 'sam@share.example', { subject: '契約書', send: true });
  assert.equal((await c.get(`/envelopes/${e4.id}/share-link`)).data.suggestion, 'document-to-sign');

  // Only for a document that is out: not a draft, not a template, not somebody else's.
  const d = await simple(c, 'sam@share.example', { subject: 'Not sent yet' });
  r = await c.put(`/envelopes/${d.id}/share-link`, {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Send it first/);
  const other = await signUp('Nora Other', 'nora@share.example', '203.0.113.22');
  assert.equal((await other.get(`/envelopes/${e1.id}/share-link`)).status, 404);
  assert.equal((await other.put(`/envelopes/${e1.id}/share-link`, { name: 'mine-now' })).status, 404);
  assert.equal((await new Client().get(`/envelopes/${e1.id}/share-link`)).status, 401);
  // Another account cannot take a name that is in use either.
  const theirs = await simple(other, 'sam@share.example', { subject: 'Garden agreement', send: true });
  assert.equal((await other.put(`/envelopes/${theirs.id}/share-link`, { name: 'garden-agreement' })).status, 409);
  assert.equal((await other.put(`/envelopes/${theirs.id}/share-link`, {})).data.share_link.name, 'garden-agreement-3');
});

test('rename: the old address stops and says so, and nobody else can take it; off and on again', async () => {
  const c = await signUp('Rita Rename', 'rita@share.example', '203.0.113.23');
  const e = await draft(c, { subject: 'Allotment lease', send: true });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  assert.equal((await visitor().get('/public/share/allotment-lease')).data.state, 'open');

  let r = await c.put(`/envelopes/${e.id}/share-link`, { name: 'Plot 7 lease' });
  assert.deepEqual(r.data.share_link, { name: 'plot-7-lease', url: 'http://test.local/plot-7-lease', active: true });
  assert.equal((await visitor().get('/public/share/plot-7-lease')).data.state, 'open');
  // The old name: a plain state, and nothing about the document.
  r = await visitor().get('/public/share/allotment-lease');
  assert.deepEqual(r.data, { state: 'renamed' });
  // Nobody can come in through it.
  assert.equal((await visitor().post('/public/share/allotment-lease/code', { person: 'x' })).status, 409);
  assert.ok(audits(e.id).includes('Share link renamed'));
  // Another account, and another document of the same account, cannot take the old name over.
  const other = await signUp('Nick Other', 'nick@share.example', '203.0.113.24');
  const theirs = await simple(other, 'sam@share.example', { subject: 'Allotment lease', send: true });
  assert.equal((await other.get(`/envelopes/${theirs.id}/share-link`)).data.suggestion, 'allotment-lease-2');
  assert.equal((await other.put(`/envelopes/${theirs.id}/share-link`, { name: 'allotment-lease' })).status, 409);
  const mine2 = await simple(c, 'sam@share.example', { subject: 'Allotment lease', send: true });
  assert.equal((await c.put(`/envelopes/${mine2.id}/share-link`, { name: 'allotment-lease' })).status, 409);
  // The same document may take its own old name back; then the name in between is the one that stopped.
  r = await c.put(`/envelopes/${e.id}/share-link`, { name: 'allotment-lease' });
  assert.equal(r.data.share_link.name, 'allotment-lease');
  assert.equal((await visitor().get('/public/share/allotment-lease')).data.state, 'open');
  assert.deepEqual((await visitor().get('/public/share/plot-7-lease')).data, { state: 'renamed' });

  // Off: the address says it is switched off, nothing more, and nobody gets a code.
  r = await c.put(`/envelopes/${e.id}/share-link`, { active: false });
  assert.deepEqual(r.data.share_link, { name: 'allotment-lease', url: 'http://test.local/allotment-lease', active: false });
  assert.deepEqual((await visitor().get('/public/share/allotment-lease')).data, { state: 'off' });
  const ada = db.get("SELECT COUNT(*) n FROM emails WHERE to_email='ada@example.com' AND subject LIKE 'Your code to open%' AND envelope_id=?", e.id).n;
  assert.equal((await visitor().post('/public/share/allotment-lease/code', { person: 'anything' })).status, 409);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='ada@example.com' AND subject LIKE 'Your code to open%' AND envelope_id=?", e.id).n, ada);
  r = await c.put(`/envelopes/${e.id}/share-link`, { active: true });
  assert.equal(r.data.share_link.active, true);
  assert.equal((await visitor().get('/public/share/allotment-lease')).data.state, 'open');
  for (const a of ['Share link switched off', 'Share link switched on']) assert.ok(audits(e.id).includes(a), a);
  // The emailed invitation is untouched by any of this.
  assert.equal((await new Client().get(`/sign/${tokenFor(e.id, 'ada@example.com')}`)).status, 200);
});

// ---- Who are you? --------------------------------------------------------------------------------------------------

test('who are you: names only, a code to the address the sender gave, then the normal signing page as that person', async () => {
  const c = await signUp('Wanda Sender', 'wanda@share.example', '203.0.113.25');
  const e = await draft(c, {
    subject: 'Please sign: Community orchard', send: true, ordered: false,
    recipients: [
      { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada@orchard.example', routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben@orchard.example', routing_order: 1 },
      { id: 'r3', role: 'cc', name: 'Cee Copy', email: 'cee@orchard.example', routing_order: 1 },
    ],
  });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  const v = visitor();
  const page = (await v.get('/public/share/community-orchard')).data;
  assert.equal(page.state, 'open');
  assert.equal(page.title, 'Community orchard');
  assert.equal(page.sender, 'Wanda Sender');
  assert.deepEqual(page.people.map((p: any) => p.name), ['Ada Signer', 'Ben Signer']);
  // Names and a key that says nothing: no address, no id, no token, anywhere in the answer.
  const raw = JSON.stringify(page);
  for (const secret of ['@', 'orchard.example', tokenFor(e.id, 'ada@orchard.example'), tokenFor(e.id, 'ben@orchard.example'), e.id, 'Cee Copy'])
    assert.ok(!raw.includes(secret), `the page must not hold ${secret}`);
  for (const r of db.all('SELECT id FROM recipients WHERE envelope_id=?', e.id)) assert.ok(!raw.includes(r.id));
  assert.deepEqual(Object.keys(page.people[0]).sort(), ['key', 'name']);

  // Ada picks her name: the code goes to her mailbox and the answer says neither the code nor the address.
  const ada = page.people[0].key, ben = page.people[1].key;
  let r = await v.post('/public/share/community-orchard/code', { person: ada });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { sent: true, digits: 6, minutes: 10, resend_in: 60 });
  const code = codeFor('ada@orchard.example');
  assert.match(code, /^\d{6}$/);
  assert.equal(codeFor('ben@orchard.example'), '');
  assert.ok(!JSON.stringify(r.data).includes(code));

  // The wrong person: Ada's code does not open Ben's name, and a wrong code does not open Ada's.
  r = await v.post('/public/share/community-orchard/code/check', { person: ben, code });
  assert.ok(r.status >= 400 && !r.data.url, JSON.stringify(r.data));
  r = await v.post('/public/share/community-orchard/code/check', { person: ada, code: code === '000000' ? '111111' : '000000' });
  assert.equal(r.status, 401);
  assert.ok(!r.data.url && !JSON.stringify(r.data).includes('@'));
  r = await v.post('/public/share/community-orchard/code/check', { person: ada, code: '12' });
  assert.equal(r.status, 400);
  // A key that is nobody's.
  r = await v.post('/public/share/community-orchard/code', { person: 'not-a-key' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'share_person');

  // The right code: her own signing page, the same one the emailed invitation opens.
  r = await v.post('/public/share/community-orchard/code/check', { person: ada, code });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.url, `/sign/${tokenFor(e.id, 'ada@orchard.example')}`);
  const sign = await v.get(r.data.url);
  assert.equal(sign.status, 200);
  assert.equal(sign.data.recipient.name, 'Ada Signer');
  // A code works once.
  assert.ok((await visitor().post('/public/share/community-orchard/code/check', { person: ada, code })).status >= 400);
  // The record says how she came in, and the check counts as a code passed by email.
  for (const a of ['Share link: code asked for', 'One-time code accepted', 'Share link: opened']) assert.ok(audits(e.id).includes(a), a);
  assert.match(db.get('SELECT checked_how h FROM recipients WHERE envelope_id=? AND email=?', e.id, 'ada@orchard.example').h, /One-time code sent by email to a\*+/);

  // Ada signs: she is no longer offered, Ben still is. The emailed invitation works as before for him.
  assert.equal((await signAll(e.id, 'ada@orchard.example')).status, 200);
  assert.deepEqual((await visitor().get('/public/share/community-orchard')).data.people.map((p: any) => p.name), ['Ben Signer']);
  assert.equal((await visitor().post('/public/share/community-orchard/code', { person: ada })).data.code, 'share_person');
  assert.equal((await new Client().get(`/sign/${tokenFor(e.id, 'ben@orchard.example')}`)).status, 200);
  // Everyone has signed: the link says the document is completed, with no names to pick.
  assert.equal((await signAll(e.id, 'ben@orchard.example')).status, 200);
  const done = (await visitor().get('/public/share/community-orchard')).data;
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.people, []);
  assert.equal((await visitor().post('/public/share/community-orchard/code', { person: ben })).status, 409);
  // The sender cannot rename a closed document's link.
  assert.equal((await c.put(`/envelopes/${e.id}/share-link`, { name: 'orchard-again' })).status, 409);
});

test('signing order: only whoever is up now can be picked, and the access code or the sender\'s own check still stands', async () => {
  const c = await signUp('Oscar Order', 'oscar@share.example', '203.0.113.26');
  // Ada first, then Ben behind an access code (the helper's draft).
  const e = await draft(c, { subject: 'Ordered deed', send: true });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  let page = (await visitor().get('/public/share/ordered-deed')).data;
  assert.deepEqual(page.people.map((p: any) => p.name), ['Ada Signer']);
  assert.equal(page.later, 1);
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  page = (await visitor().get('/public/share/ordered-deed')).data;
  assert.deepEqual(page.people.map((p: any) => p.name), ['Ben Signer']);
  const v = visitor();
  assert.equal((await v.post('/public/share/ordered-deed/code', { person: page.people[0].key })).status, 200);
  const r = await v.post('/public/share/ordered-deed/code/check', { person: page.people[0].key, code: codeFor('ben@example.com') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // The code proved the mailbox. The access code the sender set is a second thing, and is still asked for.
  const sign = await v.get(r.data.url);
  assert.equal(sign.data.locked, true);

  // A person the sender asks for a one-time code by email has typed one from that mailbox: not asked twice.
  const e2 = await simple(c, 'gus@share.example', { subject: 'Checked lease', send: true, recipients: [{ id: 'r', role: 'signer', name: 'Gus Grower', email: 'gus@share.example', verify: 'email_code' }] });
  await c.put(`/envelopes/${e2.id}/share-link`, {});
  const tok = tokenFor(e2.id, 'gus@share.example');
  assert.ok((await new Client().get(`/sign/${tok}`)).data.check, 'the emailed link asks for the code');
  const g = visitor();
  const key = (await g.get('/public/share/checked-lease')).data.people[0].key;
  await g.post('/public/share/checked-lease/code', { person: key });
  const ok = await g.post('/public/share/checked-lease/code/check', { person: key, code: codeFor('gus@share.example') });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const opened = await g.get(ok.data.url);
  assert.ok(!opened.data.check && opened.data.fields, 'this browser passed the check through the share link');
  // Another browser with the bare link is still asked.
  assert.ok((await new Client().get(`/sign/${tok}`)).data.check);
});

test('people who cannot prove themselves by email are not offered: in person, a link the sender passes on', async () => {
  const c = await signUp('Ivy Inperson', 'ivy@share.example', '203.0.113.27');
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Mixed ways', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'a', role: 'signer', name: 'Mail Person', email: 'mail@share.example' },
      { id: 'b', role: 'signer', name: 'Chat Person', link_by_sender: true },
    ],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'g', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.put(`/envelopes/${r.data.envelope.id}/share-link`, {});
  assert.deepEqual((await visitor().get('/public/share/mixed-ways')).data.people.map((p: any) => p.name), ['Mail Person']);
});

test('a finished, voided, declined or expired document: a plain state instead of an error, and no way in', async () => {
  const c = await signUp('Vera Void', 'vera@share.example', '203.0.113.28');
  const made = async (subject: string) => {
    const e = await simple(c, 'sam@share.example', { subject, send: true });
    const link = (await c.put(`/envelopes/${e.id}/share-link`, {})).data.share_link;
    const key = (await visitor().get(`/public/share/${link.name}`)).data.people[0].key;
    return { e, name: link.name, key };
  };
  const closed = async (x: { name: string; key: string }, state: string) => {
    const r = await visitor().get(`/public/share/${x.name}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, state);
    assert.deepEqual(r.data.people, []);
    const ask = await visitor().post(`/public/share/${x.name}/code`, { person: x.key });
    assert.equal(ask.status, 409);
    assert.equal(ask.data.code, 'share_closed');
  };
  const v = await made('To be voided');
  assert.equal((await c.post(`/envelopes/${v.e.id}/void`, { reason: 'Wrong file' })).status, 200);
  await closed(v, 'voided');
  const d = await made('To be declined');
  assert.equal((await new Client().post(`/sign/${tokenFor(d.e.id, 'sam@share.example')}/decline`, { reason: 'Not for me' })).status, 200);
  await closed(d, 'declined');
  const x = await made('To run out');
  db.run("UPDATE envelopes SET status='expired' WHERE id=?", x.e.id);
  await closed(x, 'expired');
  const f = await made('To be finished');
  assert.equal((await signAll(f.e.id, 'sam@share.example')).status, 200);
  await closed(f, 'completed');
  // Paused by its sender: said as that.
  const p = await made('To be paused');
  assert.equal((await c.post(`/envelopes/${p.e.id}/pause`)).status, 200);
  await closed(p, 'paused');
  // A paused account, or a document we hold back: closed, and neither its name nor its sender's is printed.
  const h = await made('Held back');
  db.run('UPDATE envelopes SET held_at=? WHERE id=?', new Date().toISOString(), h.e.id);
  const r = (await visitor().get(`/public/share/${h.name}`)).data;
  assert.deepEqual([r.state, r.title, r.sender], ['unavailable', null, null]);
  // Deleted for good: the same answer as a name nobody ever had, and the name is free again.
  const gone = await made('Soon deleted');
  db.run('DELETE FROM envelopes WHERE id=?', gone.e.id);
  assert.equal((await visitor().get(`/public/share/${gone.name}`)).status, 404);
  const again = await simple(c, 'sam@share.example', { subject: 'Soon deleted', send: true });
  assert.equal((await c.put(`/envelopes/${again.id}/share-link`, {})).data.share_link.name, 'soon-deleted');
});

test('a name nobody has, a malformed one and a reserved one all answer the same, and say nothing more', async () => {
  const answers = [];
  for (const name of ['nobody-has-this', 'login', 'ab', 'UPPER', 'a.b', 'a%2Fb', 'x'.repeat(80)]) {
    const r = await visitor().get(`/public/share/${encodeURIComponent(name)}`);
    answers.push(JSON.stringify([r.status, { ...r.data, request_id: 0 }]));
    const ask = await visitor().post(`/public/share/${encodeURIComponent(name)}/code`, { person: 'k' });
    assert.equal(ask.status, 409);
    assert.equal(ask.data.code, 'share_closed');
  }
  assert.equal(new Set(answers).size, 1, answers.join('\n'));
  assert.match(answers[0], /^\[404,/);
});

test('limits: lookups and code requests for each internet address, and the code\'s own limits', async () => {
  const c = await signUp('Lena Limit', 'lena@share.example', '203.0.113.29');
  const e = await draft(c, { subject: 'Limited lease', send: true, ordered: false, recipients: [
    { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada@limit.example', routing_order: 1 },
    { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben@limit.example', routing_order: 1 },
  ] });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  // Trying names by the hundred from one address stops.
  const guesser = visitor();
  let last = 0;
  for (let i = 0; i <= SHARE_LOOKUPS_PER_MINUTE; i++) last = (await guesser.get(`/public/share/guess-${i}-lease`)).status;
  assert.equal(last, 429);
  assert.equal((await guesser.get('/public/share/limited-lease')).status, 429);
  assert.equal((await visitor().get('/public/share/limited-lease')).status, 200);

  // A second code for the same person inside a minute: wait, said without the address.
  const v = visitor();
  const [ada, ben] = (await v.get('/public/share/limited-lease')).data.people.map((p: any) => p.key);
  assert.equal((await v.post('/public/share/limited-lease/code', { person: ada })).status, 200);
  const soon = await v.post('/public/share/limited-lease/code', { person: ada });
  assert.equal(soon.status, 429);
  assert.equal(soon.data.code, 'wait');
  assert.ok(soon.data.resend_in > 0 && !/@|\*/.test(soon.data.error), soon.data.error);
  // Also from another address: the limit is the mailbox's, so nobody can fill it through the link.
  assert.equal((await visitor().post('/public/share/limited-lease/code', { person: ada })).status, 429);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='ada@limit.example' AND subject LIKE 'Your code to open%'").n, 1);

  // Five wrong codes end the code; the right one no longer works then.
  const code = codeFor('ada@limit.example');
  const wrong = code === '999999' ? '888888' : '999999';
  let r: any;
  for (let i = 0; i < SIGNER_CODE_TRIES; i++) r = await v.post('/public/share/limited-lease/code/check', { person: ada, code: wrong });
  assert.equal(r.status, 423);
  r = await v.post('/public/share/limited-lease/code/check', { person: ada, code });
  assert.equal(r.status, 423);
  assert.ok(!r.data.url);

  // One address asking for code after code, whoever for: stopped by the address limit.
  const greedy = visitor();
  let asked = 0, stopped = 0;
  for (let i = 0; i < SHARE_CODE_ASKS_PER_HOUR + 2; i++) {
    const a = await greedy.post('/public/share/limited-lease/code', { person: ben });
    if (a.status === 429 && a.data.error === 'Too many attempts. Please wait a bit and try again.') stopped++;
    asked++;
  }
  assert.equal(stopped, 2, `${asked} asked`);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='ben@limit.example' AND subject LIKE 'Your code to open%'").n, 1);
});

// ---- Forms ---------------------------------------------------------------------------------------------------------

test('a public form gets a readable address in front of /f/<slug>, which keeps working', async () => {
  const c = await signUp('Fay Forms', 'fay@share.example', '203.0.113.30');
  const file = await upload(c, 1);
  const tpl = (await c.post('/envelopes', {
    kind: 'template', subject: 'Volunteer waiver', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer', name: '', email: '' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  let r = await c.post('/powerforms', { template_id: tpl.id, name: 'Volunteer Waiver 2026' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.share_link, { name: 'volunteer-waiver-2026', url: 'http://test.local/volunteer-waiver-2026', active: true });
  const form = (await c.get('/powerforms')).data.powerforms[0];
  // Copy link and the QR code read "url": the readable address while it is on.
  assert.equal(form.url, 'http://test.local/volunteer-waiver-2026');
  assert.deepEqual(form.share_link, r.data.share_link);
  // The page at that name is the form: which form, by its slug, and its name. The form itself is the /f/ flow.
  const page = (await visitor().get('/public/share/volunteer-waiver-2026')).data;
  assert.deepEqual(page, { state: 'form', slug: form.slug, title: 'Volunteer Waiver 2026' });
  assert.equal((await visitor().get(`/public/powerforms/${form.slug}`)).status, 200);
  // No "who are you" on a form: there is nobody to pick.
  assert.equal((await visitor().post('/public/share/volunteer-waiver-2026/code', { person: 'k' })).status, 409);

  // Rename and off, by whoever may run the form.
  r = await c.put(`/powerforms/${form.id}/share-link`, { name: 'beach-cleanup-waiver' });
  assert.equal(r.data.share_link.name, 'beach-cleanup-waiver');
  assert.deepEqual((await visitor().get('/public/share/volunteer-waiver-2026')).data, { state: 'renamed' });
  assert.equal((await visitor().get('/public/share/beach-cleanup-waiver')).data.slug, form.slug);
  r = await c.put(`/powerforms/${form.id}/share-link`, { active: false });
  assert.equal(r.data.share_link.active, false);
  assert.deepEqual((await visitor().get('/public/share/beach-cleanup-waiver')).data, { state: 'off' });
  // Off: "url" is the slug address again, and that one still opens the form.
  assert.equal((await c.get('/powerforms')).data.powerforms[0].url, `http://test.local/f/${form.slug}`);
  assert.equal((await visitor().get(`/public/powerforms/${form.slug}`)).status, 200);
  assert.equal((await c.put(`/powerforms/${form.id}/share-link`, { name: 'login' })).status, 422);
  // A form and a document share one set of names.
  const e = await simple(c, 'sam@share.example', { subject: 'Beach cleanup waiver', send: true });
  assert.equal((await c.get(`/envelopes/${e.id}/share-link`)).data.suggestion, 'beach-cleanup-waiver-2');
  // Another account cannot touch it; deleting the form lets its names go.
  const other = await signUp('Ned Other', 'ned@share.example', '203.0.113.31');
  assert.equal((await other.put(`/powerforms/${form.id}/share-link`, { name: 'taken-over' })).status, 404);
  assert.equal((await c.call('DELETE', `/powerforms/${form.id}`)).status, 200);
  assert.equal((await visitor().get('/public/share/beach-cleanup-waiver')).status, 404);
  assert.equal((await visitor().get('/public/share/volunteer-waiver-2026')).status, 404);
});

test('SHARE_LINKS_AUTO=1: a sent document has its link the first time its sender looks', async () => {
  const c = await signUp('Avery Auto', 'avery@share.example', '203.0.113.32');
  const e = await simple(c, 'sam@share.example', { subject: 'Automatic lease', send: true });
  process.env.SHARE_LINKS_AUTO = '1';
  try {
    assert.equal((await c.get(`/envelopes/${e.id}/share-link`)).data.share_link.name, 'automatic-lease');
    // Switched off by its sender, it stays off.
    await c.put(`/envelopes/${e.id}/share-link`, { active: false });
    assert.equal((await c.get(`/envelopes/${e.id}/share-link`)).data.share_link.active, false);
    // A draft gets none.
    const d = await simple(c, 'sam@share.example', { subject: 'Automatic draft' });
    assert.equal((await c.get(`/envelopes/${d.id}/share-link`)).data.share_link, null);
  } finally {
    delete process.env.SHARE_LINKS_AUTO;
  }
});

test('the API description and the permission table know the routes', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  for (const p of ['/envelopes/{id}/share-link', '/powerforms/{id}/share-link', '/public/share/{name}', '/public/share/{name}/code', '/public/share/{name}/code/check']) assert.ok(spec.paths[p], `not described: ${p}`);
  const { listRoutes } = await import('../src/server/router.ts');
  const ours = listRoutes().filter((r) => /share-link|\/public\/share/.test(r.path)).map((r) => `${r.method} ${r.path} ${r.level}`).sort();
  assert.deepEqual(ours, ['GET /envelopes/:id/share-link user', 'GET /powerforms/:id/share-link user', 'GET /public/share/:name public', 'POST /public/share/:name/code public', 'POST /public/share/:name/code/check public', 'PUT /envelopes/:id/share-link user', 'PUT /powerforms/:id/share-link user']);
});

// ---- Repairs after review ------------------------------------------------------------------------------------------

test('a stranger with only the share link cannot end, use up or hold back the code a signer asked for on their own page', async () => {
  const c = await signUp('Dora Sender', 'dora@share.example', '203.0.113.40');
  const e = await simple(c, 'gus@lock.example', { subject: 'Locked lease', send: true, recipients: [{ id: 'r', role: 'signer', name: 'Gus Grower', email: 'gus@lock.example', verify: 'email_code' }] });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  const tok = tokenFor(e.id, 'gus@lock.example');
  const own = (subject: RegExp) => mailTo('gus@lock.example').filter((m: any) => subject.test(m.subject)).map((m: any) => /(\d{6}) is your code/.exec(m.html)?.[1]);
  // The signer asks for their code on their own signing page.
  const signer = visitor();
  assert.equal((await signer.post(`/sign/${tok}/code`, {})).status, 200);
  const real = own(/^Your code to open a document from/).pop()!;
  // A stranger asks through the share link, at once: no waiting on the signer's clock, and a code of its own.
  const stranger = visitor();
  const key = (await stranger.get('/public/share/locked-lease')).data.people[0].key;
  assert.equal((await stranger.post('/public/share/locked-lease/code', { person: key })).status, 200);
  const rows = db.all('SELECT stamp, ended_how FROM signer_codes WHERE envelope_id=? ORDER BY id', e.id);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].stamp, rows[1].stamp);
  assert.equal(rows[0].ended_how, null, 'the signer\'s own code is still live');
  // The stranger's wrong tries count against the share link's code only.
  for (let i = 0; i < SIGNER_CODE_TRIES; i++) await stranger.post('/public/share/locked-lease/code/check', { person: key, code: real === '000000' ? '111111' : '000000' });
  // The signer's own code never works on the share link, and the share link's never on the signer's page.
  const shared = own(/^Your code to open Locked lease/).pop()!;
  assert.ok(shared && shared !== undefined);
  // As many more asks as the share link allows in an hour (each from a new address, a minute apart).
  for (let i = 0; i < 8; i++) {
    for (const row of db.all('SELECT id, at FROM signer_codes WHERE envelope_id=?', e.id)) db.run('UPDATE signer_codes SET at=? WHERE id=?', new Date(Date.parse(row.at) - 61_000).toISOString(), row.id);
    await visitor().post('/public/share/locked-lease/code', { person: key });
  }
  assert.equal((await visitor().post('/public/share/locked-lease/code', { person: key })).status, 429, 'the share link itself is used up');
  // None of it touched the signer: the code they were emailed opens the document, and a new one can be asked for.
  const ok = await signer.post(`/sign/${tok}/code/check`, { code: real });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await signer.post(`/sign/${tok}/code`, {})).status, 200);
});

test('the code email asked for through a share link names the document and says what happened, without alarm', async () => {
  const c = await signUp('Mila Mail', 'mila@share.example', '203.0.113.41');
  const e = await simple(c, 'sam@mailwords.example', { subject: 'Please sign: Hedge agreement', send: true });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  const v = visitor();
  const key = (await v.get('/public/share/hedge-agreement')).data.people[0].key;
  assert.equal((await v.post('/public/share/hedge-agreement/code', { person: key })).status, 200);
  const m = mailTo('sam@mailwords.example').filter((x: any) => /^Your code to open/.test(x.subject)).pop();
  assert.equal(m.subject, 'Your code to open Hedge agreement');
  assert.match(m.html, /Someone chose your name on the share link for/);
  assert.match(m.html, /If that was not you, do nothing: the document does not open without this code/);
  assert.ok(!/someone else has the link that was emailed to you/.test(m.html));
});

test('a deleted document or form keeps its name away from every other account', async () => {
  const a = await signUp('Alice First', 'alice@share.example', '203.0.113.42');
  const e = await simple(a, 'sam@share.example', { subject: 'Rent contract', send: true });
  assert.equal((await a.put(`/envelopes/${e.id}/share-link`, {})).data.share_link.name, 'rent-contract');
  db.run('DELETE FROM envelopes WHERE id=?', e.id);
  assert.equal((await visitor().get('/public/share/rent-contract')).status, 404);
  const b = await signUp('Mallory Second', 'mallory@share.example', '203.0.113.43');
  const theirs = await simple(b, 'sam@share.example', { subject: 'Rent contract', send: true });
  assert.equal((await b.get(`/envelopes/${theirs.id}/share-link`)).data.suggestion, 'rent-contract-2');
  const r = await b.put(`/envelopes/${theirs.id}/share-link`, { name: 'rent-contract' });
  assert.equal(r.status, 409);
  assert.equal((await visitor().get('/public/share/rent-contract')).status, 404);
  // The account that had it may give it to another of its own documents.
  const again = await simple(a, 'sam@share.example', { subject: 'Rent contract', send: true });
  assert.equal((await a.put(`/envelopes/${again.id}/share-link`, {})).data.share_link.name, 'rent-contract');

  // The same for a form that is deleted.
  const file = await upload(a, 1);
  const tpl = (await a.post('/envelopes', { kind: 'template', subject: 'Key handover', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant', name: '', email: '' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const form = (await a.post('/powerforms', { template_id: tpl.id, name: 'Key handover form' })).data;
  assert.equal(form.share_link.name, 'key-handover-form');
  const id = (await a.get('/powerforms')).data.powerforms.find((p: any) => p.share_link?.name === 'key-handover-form').id;

  // Switched off by its owner (the form, not the link): the readable address says "off" and gives no name or slug.
  assert.equal((await a.call('PATCH', `/powerforms/${id}`, { active: false })).status, 200);
  assert.deepEqual((await visitor().get('/public/share/key-handover-form')).data, { state: 'off' });
  assert.deepEqual(links.sharePage('key-handover-form'), { state: 'off' });
  assert.equal((await a.call('PATCH', `/powerforms/${id}`, { active: true })).status, 200);
  assert.equal((await visitor().get('/public/share/key-handover-form')).data.state, 'form');

  assert.equal((await a.call('DELETE', `/powerforms/${id}`)).status, 200);
  assert.equal((await visitor().get('/public/share/key-handover-form')).status, 404);
  assert.equal((await b.put(`/envelopes/${theirs.id}/share-link`, { name: 'key-handover-form' })).status, 409);
});

test('names that read as a notice, another service, a look-alike of ours or a page we may get are refused', () => {
  const refused = 'account-suspended your-account-is-suspended password-expired urgent-action-required pay-now invoice-overdue docusign docusign-envelope adobe-sign dropbox-sign '
    + 'irs-tax-refund hmrc-refund bank-of-america chase-bank-alert wells-fargo netflix-payment google-account-security office365-password it-helpdesk it-support '
    + 'trust-and-safety abuse-team legal-team login-page sign-in-here secure-document growslgning grow-slgning-team qrowsigning grovvsigning treegems '
    + 'unsubscribe welcome start get-started onboarding enterprise customers product solutions business sales contact-sales apps offline thanks thank-you done success '
    + 'error complete open view review apple-app-site-association wp-admin wp-login cgi-bin postmaster webmaster hostmaster mailer-daemon noreply no-reply owner ceo founder moderator';
  for (const name of refused.split(' ')) assert.ok(links.shareNameRefusal(name), `should be refused: ${name}`);
  // Ordinary documents keep their names, also ones that hold a word from the lists.
  for (const name of ['garden-agreement', 'apple-orchard-lease', 'visa-application-smith', 'first-lease', 'bank-mandate-acme', 'signing-bonus-letter', 'tree-planting-day', 'groups-charter', 'legal-services-agreement', 'document-to-sign'])
    assert.equal(links.shareNameRefusal(name), null, name);
});

test('a refused name comes with a way forward, never with the name the link already has', async () => {
  const c = await signUp('Nora Names', 'nora-names@share.example', '203.0.113.44');
  const e = await simple(c, 'sam@share.example', { subject: 'Meadow lease', send: true });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  let r = await c.put(`/envelopes/${e.id}/share-link`, { name: 'support' });
  assert.equal(r.status, 422);
  assert.equal(r.data.suggestion, 'support-agreement');
  r = await c.put(`/envelopes/${e.id}/share-link`, { name: 'docusign' });
  assert.equal(r.status, 422);
  assert.notEqual(r.data.suggestion, 'meadow-lease');
  assert.equal((await c.get(`/envelopes/${e.id}/share-link`)).data.share_link.name, 'meadow-lease');
  // A name given out before the lists grew stops opening anything.
  db.run("UPDATE share_links SET name='account-suspended' WHERE name='meadow-lease'");
  assert.equal((await visitor().get('/public/share/account-suspended')).status, 404);
  assert.equal((await visitor().post('/public/share/account-suspended/code', { person: 'k' })).status, 409);
});

test('a closed document: the sender can still switch the link off, and after some days the address no longer prints names', async () => {
  const c = await signUp('Cleo Closed', 'cleo@share.example', '203.0.113.45');
  const e = await simple(c, 'sam@share.example', { subject: 'Salary review', send: true });
  await c.put(`/envelopes/${e.id}/share-link`, {});
  assert.equal((await signAll(e.id, 'sam@share.example')).status, 200);
  let page = (await visitor().get('/public/share/salary-review')).data;
  assert.deepEqual([page.state, page.title, page.sender], ['completed', 'Salary review', 'Cleo Closed']);
  // Later, whoever types the address reads the plain sentence and nothing about the document.
  const { SHARE_CLOSED_NAMED_DAYS } = await import('../src/lib/policy.ts');
  const old = new Date(Date.now() - (SHARE_CLOSED_NAMED_DAYS + 1) * 864e5).toISOString();
  db.run('UPDATE envelopes SET completed_at=?, updated_at=? WHERE id=?', old, old, e.id);
  page = (await visitor().get('/public/share/salary-review')).data;
  assert.deepEqual([page.state, page.title, page.sender], ['completed', null, null]);
  // Renaming is over, switching off is not.
  assert.equal((await c.put(`/envelopes/${e.id}/share-link`, { name: 'other-name' })).status, 409);
  assert.equal((await c.put(`/envelopes/${e.id}/share-link`, { active: true })).status, 409);
  const off = await c.put(`/envelopes/${e.id}/share-link`, { active: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.deepEqual([off.data.share_link.active, off.data.can_share], [false, false]);
  assert.deepEqual((await visitor().get('/public/share/salary-review')).data, { state: 'off' });
});

test('the page decides once for the body, the title and the link preview, and gives no name unless the link is open', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/app/[name]/page.tsx'), 'utf8');
  // One counted lookup, shared: generateMetadata never asks sharePage by itself.
  assert.equal(src.match(/sharePage\(/g)?.length, 1);
  assert.match(src, /const look = cache\(/);
  assert.match(src, /generateMetadata[\s\S]*await look\(name\)[\s\S]*page\.state === 'open' \|\| page\.state === 'form'/);
});
