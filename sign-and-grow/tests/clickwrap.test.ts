// Click-to-agree ("clickwrap"): terms a website's visitors accept with one click, and the record of who accepted which
// version and when (src/server/clickwrap.ts, src/server/routes-clickwrap.ts, words in src/lib/clickwrap.ts).
// Pinned down: drafts and versions, who has to accept again, our page, the frame, the API and "has this person
// accepted", the link a website signs and every way it can be wrong, the record that never changes and its seal, the
// copy by email, looking up, filtering and the CSV, the certificate, the words before and after the click, the
// monthly limit and its emails, the scam filter, paused and closing accounts, reports, rate limits, and deleting.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, signUp, mailTo, upload, type Server } from './helpers.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const ip = () => `10.${100 + Math.floor(++n / 250)}.${n % 250}.7`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const withKey = (key: string) => {
  const c = from();
  const call = c.call.bind(c);
  c.call = (method: string, url: string, body?: any, headers: Record<string, string> = {}) => call(method, url, body, { authorization: `Bearer ${key}`, ...headers });
  return c;
};
const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const sign = (secret: string, o: any) => {
  const who = Buffer.from(JSON.stringify(o)).toString('base64url');
  return { who, sig: crypto.createHmac('sha256', secret).update(who).digest('base64url') };
};
const soon = () => Math.floor(Date.now() / 1000) + 600;
const TERMS = '# Terms of service\n\nBy using the **garden planner** you agree to these terms.\n\n- Be kind\n- Pay on time\n\n1. First\n2. Second';

// A team with published terms. Answers the owner, the agreement's id, slug and secret.
async function published(name = 'Terms of service', terms = TERMS, who?: Client) {
  const owner = who || (await person('Olive Owner', `olive${++n}@terms.example`));
  const made = await owner.post('/clickwraps', { name, text: terms });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const pub = await owner.post(`/clickwraps/${made.data.id}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const info = (await owner.get(`/clickwraps/${made.data.id}`)).data;
  return { owner, id: made.data.id as string, slug: info.agreement.slug as string, secret: info.secret as string, info };
}
// A visitor opens the page and accepts. `q` is the query of the page (who and sig), `b` more of the body.
async function accept(slug: string, b: any = {}, q = '', c = from()) {
  const page = await c.get(`/public/agree/${slug}${q ? `?${q}` : ''}`);
  if (page.status !== 200 || page.data.closed) return { page, res: page, c };
  // The page passes on what the website put in its address, as the hosted page does.
  const p = new URLSearchParams(q);
  const res = await c.post(`/public/agree/${slug}/accept`, { view: page.data.version && page.data.view, agree: true, who: p.get('who') || undefined, sig: p.get('sig') || undefined, ...b });
  return { page, res, c };
}

// ---- 1. Drafts, versions, who has to accept again ------------------------------------------------------------------

test('a team writes terms, publishes version 1, and any change makes a new version with a note that says who has to accept again', async () => {
  const owner = await person('Vera Versions', 'vera@versions.example');
  const made = await owner.post('/clickwraps', { name: 'Volunteer rules', text: 'Be on time.' });
  assert.equal(made.status, 200);
  const id = made.data.id;
  let info = (await owner.get(`/clickwraps/${id}`)).data;
  assert.equal(info.agreement.state, 'draft', 'nothing is live before it is published');
  assert.equal(info.agreement.current_version, null);
  assert.match(info.secret, /^[\w-]{40,}$/, 'every agreement has a key of its own for the links its website signs');
  // A draft page is not open to anyone yet.
  const before = await from().get(`/public/agree/${info.agreement.slug}`);
  assert.equal(before.data.closed, true);
  assert.equal(JSON.stringify(before.data).includes('Be on time'), false, 'and shows nothing of the draft');

  const v1 = await owner.post(`/clickwraps/${id}/publish`, {});
  assert.equal(v1.status, 200, JSON.stringify(v1.data));
  assert.equal(v1.data.version, 1);
  assert.equal(v1.data.sha256, crypto.createHash('sha256').update('Be on time.').digest('hex'), 'the fingerprint is of the exact terms');
  assert.match(v1.data.again, /first version/);

  // Publishing again without a change is refused, so a version number always means something.
  const same = await owner.post(`/clickwraps/${id}/publish`, { note: 'nothing' });
  assert.equal(same.status, 409);
  assert.match(same.data.error, /Nothing has changed since version 1/);

  // Two people accept version 1.
  const ada = sign(info.secret, { id: 'cust-ada', name: 'Ada', email: 'ada@visit.example', exp: soon() });
  const first = await accept(info.agreement.slug, {}, `who=${ada.who}&sig=${ada.sig}`);
  assert.equal(first.res.status, 200, JSON.stringify(first.res.data));
  assert.equal((await accept(info.agreement.slug, { name: 'Ben Typed', email: 'ben@visit.example' })).res.status, 200);

  // A change to the draft is not shown until it is published.
  assert.equal((await owner.call('PATCH', `/clickwraps/${id}`, { text: 'Be on time. Bring water.' })).status, 200);
  const still = await from().get(`/public/agree/${info.agreement.slug}`);
  assert.equal(still.data.version.number, 1);
  assert.equal(still.data.version.text, 'Be on time.');

  // A second version needs a note of what changed.
  const noNote = await owner.post(`/clickwraps/${id}/publish`, {});
  assert.equal(noNote.status, 400);
  assert.match(noNote.data.error, /what changed/);
  const v2 = await owner.post(`/clickwraps/${id}/publish`, { note: 'Bring water.' });
  assert.equal(v2.status, 200);
  assert.equal(v2.data.version, 2);
  assert.equal(v2.data.asked_again, 2, 'both people who accepted version 1 are asked again');
  assert.match(v2.data.again, /All 2 people who accepted an earlier version are asked to accept version 2/);
  info = (await owner.get(`/clickwraps/${id}`)).data;
  assert.equal(info.to_accept_again, 2);
  assert.deepEqual(info.versions.map((v: any) => [v.number, v.note, v.accepted]), [[2, 'Bring water.', 0], [1, null, 2]]);

  // A correction that changes no meaning can keep earlier acceptances counting: the team says so when it publishes.
  assert.equal((await owner.call('PATCH', `/clickwraps/${id}`, { text: 'Be on time. Bring water!' })).status, 200);
  const v3 = await owner.post(`/clickwraps/${id}/publish`, { note: 'A typo.', ask_again: false });
  assert.equal(v3.data.version, 3);
  assert.equal(v3.data.asked_again, 0);
  assert.match(v3.data.again, /Nobody has to accept again: acceptances of version 2 and later still count/);
  assert.equal((await owner.get(`/clickwraps/${id}`)).data.agreement.counts_from_version, 2);

  // The words next to the box and on the button are part of what is shown: changing them is a version too.
  assert.equal((await owner.call('PATCH', `/clickwraps/${id}`, { button: 'Accept and continue' })).status, 200);
  assert.equal((await owner.post(`/clickwraps/${id}/publish`, { note: 'New button words.' })).data.version, 4);

  // A published version is never changed, whatever code asks.
  assert.throws(() => db.run("UPDATE clickwrap_versions SET body='changed' WHERE clickwrap_id=?", id), /never changed/);
});

test('the draft is checked as it is written: names, lengths, a PDF of the account, yes and no as true and false', async () => {
  const owner = await person('Dana Draft', 'dana@draft.example');
  assert.equal((await owner.post('/clickwraps', { text: 'x' })).status, 400, 'a name is needed');
  const id = (await owner.post('/clickwraps', { name: 'Rules' })).data.id;
  for (const [body, re] of [
    [{ text: 'x'.repeat(100_001) }, /up to 100,000 characters/],
    [{ name: 'n'.repeat(121) }, /up to 120 characters/],
    [{ checkbox: 'c'.repeat(201) }, /up to 200 characters/],
    [{ scroll: 'false' }, /true or false, without quotes/],
    [{ format: 'word' }, /"text" for terms written here or "pdf"/],
    [{ file_id: 'fil_someone_elses' }, /not one of the files uploaded to this account/],
    [{ active: true }, /Publish the terms first/],
  ] as [any, RegExp][]) {
    const r = await owner.call('PATCH', `/clickwraps/${id}`, body);
    assert.ok(r.status >= 400, JSON.stringify(body));
    assert.match(r.data.error, re);
    assert.match(r.data.error, /Nothing was saved/);
  }
  // Empty terms cannot be published.
  const empty = await owner.post(`/clickwraps/${id}/publish`, {});
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /Write the terms first/);
  // Another team's agreement does not exist for this one.
  const other = await person('Otto Other', 'otto@draft.example');
  assert.equal((await other.get(`/clickwraps/${id}`)).status, 404);
  assert.equal((await other.call('PATCH', `/clickwraps/${id}`, { name: 'Mine now' })).status, 404);
  // A member who is not an admin does not manage the team's terms.
  assert.equal((await owner.post('/account/invites', { email: 'mo@draft.example', role: 'member' })).status, 200);
  const inv = db.get('SELECT token FROM invites WHERE email=?', 'mo@draft.example').token;
  const mo = from();
  assert.equal((await mo.post('/auth/signup', { name: 'Mo Member', email: 'mo@draft.example', password: 'correct horse battery', invite: inv })).status, 200);
  assert.equal((await mo.get('/clickwraps')).status, 403);
  assert.equal((await mo.post(`/clickwraps/${id}/publish`, {})).status, 403);
});

// ---- 2. Our page, a frame, the API ----------------------------------------------------------------------------------

test('our page shows the terms and what is recorded before the click; a visitor types who they are, or the website says so in a signed link', async () => {
  const { slug, secret, id, owner } = await published('Garden club terms');
  const c = from();
  const page = await c.get(`/public/agree/${slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.closed, false);
  assert.equal(page.data.version.number, 1);
  assert.equal(page.data.version.text, TERMS);
  assert.equal(page.data.identity, 'typed', 'without a link from the website the visitor types their details');
  assert.match(page.data.recorded, /the name and email address you type, the date and time, your internet address, your browser, the page you came from/);
  assert.match(page.data.shows, /The browser that pressed reported that the box was ticked and the button pressed, on these exact terms/);
  assert.match(page.data.not, /does not show who that person really was/);
  assert.equal(page.data.person, null);

  // Typed: name and address are needed, the box must be ticked.
  const view = page.data.view;
  assert.match((await c.post(`/public/agree/${slug}/accept`, { view, agree: true, name: 'Tia' })).data.error, /Type your name and your email address/);
  assert.match((await c.post(`/public/agree/${slug}/accept`, { view, name: 'Tia Typed', email: 'tia@visit.example' })).data.error, /Tick "I have read these terms and I agree to them\." first/);
  const ok = await c.post(`/public/agree/${slug}/accept`, { view, agree: true, name: 'Tia Typed', email: 'tia@visit.example', page_url: 'https://club.example/join' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.receipt, /^cwr_/);
  const row = db.get('SELECT * FROM clickwrap_acceptances WHERE id=?', ok.data.acceptance.id);
  assert.equal(row.identity, 'typed');
  assert.equal(row.via, 'hosted');
  assert.equal(row.ip, c.ip);
  assert.equal(row.page_url, 'https://club.example/join');
  assert.equal(row.version, 1);
  assert.equal(row.terms_sha256, crypto.createHash('sha256').update(TERMS).digest('hex'));
  assert.ok(row.shown_ms >= 0, 'how long the terms were open is measured by the server');
  assert.equal(row.receipt_hash.length, 64, 'only a fingerprint of the receipt is kept');
  assert.equal(JSON.stringify(row).includes(ok.data.receipt), false);
  // A double press is one record.
  const twice = await c.post(`/public/agree/${slug}/accept`, { view, agree: true, name: 'Tia Typed', email: 'tia@visit.example' });
  assert.equal(twice.data.already, true);
  assert.equal(twice.data.acceptance.id, ok.data.acceptance.id);

  // Signed by the website: the page knows who it is, and the record says where the details came from.
  const ada = sign(secret, { id: 'c-1', name: 'Ada Lovelace', email: 'ada@club.example', exp: soon() });
  const signed = await c.get(`/public/agree/${slug}?who=${ada.who}&sig=${ada.sig}`);
  assert.equal(signed.data.identity, 'website');
  assert.deepEqual(signed.data.person, { id: 'c-1', name: 'Ada Lovelace', email: 'ada@club.example' });
  assert.match(signed.data.recorded, /the name, email address and customer number the website gave us for you/);
  // A visitor cannot put somebody else's name in place of what the website signed.
  const res = await c.post(`/public/agree/${slug}/accept`, { view: signed.data.view, agree: true, who: ada.who, sig: ada.sig, name: 'Mallory', email: 'mallory@evil.example' });
  assert.equal(res.status, 200);
  const r2 = db.get('SELECT * FROM clickwrap_acceptances WHERE id=?', res.data.acceptance.id);
  assert.deepEqual([r2.identity, r2.person_id, r2.name, r2.email], ['website', 'c-1', 'Ada Lovelace', 'ada@club.example']);
  // The same person again is the same record, and the page says they accepted already.
  const again = await c.get(`/public/agree/${slug}?who=${ada.who}&sig=${ada.sig}`);
  assert.equal(again.data.already.id, res.data.acceptance.id);
  assert.equal((await c.post(`/public/agree/${slug}/accept`, { view: again.data.view, agree: true, who: ada.who, sig: ada.sig })).data.already, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM clickwrap_acceptances WHERE clickwrap_id=?', id).n, 2);

  // The page and its words are the same for a team member who opens it: nothing about the account is needed.
  assert.equal((await owner.get(`/public/agree/${slug}`)).data.version.number, 1);
});

test('the link a website signs: forged, changed, expired, in milliseconds, too long, unsigned or naming nobody is refused in words, and a new key stops the old links', async () => {
  const { slug, secret, owner, id } = await published('Signed link terms');
  const c = from();
  const ok = sign(secret, { id: 'p-1', exp: soon() });
  const cases: [string, number, RegExp][] = [
    [`who=${sign('not-the-key', { id: 'p-1', exp: soon() }).who}&sig=${sign('not-the-key', { id: 'p-1', exp: soon() }).sig}`, 403, /not made with the key of these terms/],
    [`who=${sign(secret, { id: 'p-2', exp: soon() }).who}&sig=${ok.sig}`, 403, /changed on the way/],
    [`who=${ok.who}`, 400, /missing half/],
    [`who=${sign(secret, { id: 'p-1', exp: Math.floor(Date.now() / 1000) - 5 }).who}&sig=${sign(secret, { id: 'p-1', exp: Math.floor(Date.now() / 1000) - 5 }).sig}`, 403, /run out/],
    [`who=${sign(secret, { id: 'p-1', exp: Date.now() + 60_000 }).who}&sig=${sign(secret, { id: 'p-1', exp: Date.now() + 60_000 }).sig}`, 400, /milliseconds/],
    [`who=${sign(secret, { id: 'p-1', exp: soon() + 40 * 86400 }).who}&sig=${sign(secret, { id: 'p-1', exp: soon() + 40 * 86400 }).sig}`, 400, /more than 30 days/],
    [`who=${sign(secret, { id: 'p-1' }).who}&sig=${sign(secret, { id: 'p-1' }).sig}`, 400, /no end time/],
    [`who=${sign(secret, { name: 'Nobody', exp: soon() }).who}&sig=${sign(secret, { name: 'Nobody', exp: soon() }).sig}`, 400, /names nobody/],
    [`who=${sign(secret, { id: 'p', email: 'not an address', exp: soon() }).who}&sig=${sign(secret, { id: 'p', email: 'not an address', exp: soon() }).sig}`, 400, /not one/],
  ];
  for (const [q, status, re] of cases) {
    const r = await c.get(`/public/agree/${slug}?${q}`);
    assert.equal(r.status, status, q);
    assert.match(r.data.error, re);
    // Accepting with the same parts is refused the same way, so the page is no way round it.
    const view = (await c.get(`/public/agree/${slug}`)).data.view;
    const p = new URLSearchParams(q);
    const a = await c.post(`/public/agree/${slug}/accept`, { view, agree: true, who: p.get('who'), sig: p.get('sig'), name: 'Fallback', email: 'fallback@visit.example' });
    assert.equal(a.status, status, `accept ${q}`);
  }
  assert.equal(db.get("SELECT COUNT(*) n FROM clickwrap_acceptances WHERE clickwrap_id=? AND name='Fallback'", id).n, 0, 'a bad link never falls back to typed details');
  // A signature in hex (what PHP's hash_hmac gives) is taken as well.
  const hex = crypto.createHmac('sha256', secret).update(ok.who).digest('hex');
  assert.equal((await c.get(`/public/agree/${slug}?who=${ok.who}&sig=${hex}`)).data.identity, 'website');
  // A new key: links made with the old one stop at once.
  const fresh = await owner.post(`/clickwraps/${id}/secret`, {});
  assert.match(fresh.data.note, /stop working now/);
  assert.equal((await c.get(`/public/agree/${slug}?who=${ok.who}&sig=${ok.sig}`)).status, 403);
  const now = sign(fresh.data.secret, { id: 'p-1', exp: soon() });
  assert.equal((await c.get(`/public/agree/${slug}?who=${now.who}&sig=${now.sig}`)).data.identity, 'website');
});

test('"only people the website names": without a signed link the page says how to get one and nothing can be accepted', async () => {
  const { slug, secret, owner, id } = await published('Members only');
  assert.equal((await owner.call('PATCH', `/clickwraps/${id}`, { signed_only: true })).status, 200);
  const c = from();
  const page = await c.get(`/public/agree/${slug}`);
  assert.equal(page.data.closed, true);
  assert.match(page.data.text, /only be accepted through a link from the website/);
  const v = db.get('SELECT id FROM clickwrap_versions WHERE clickwrap_id=?', id).id;
  const { viewToken } = await import('../src/server/clickwrap.ts');
  const r = await c.post(`/public/agree/${slug}/accept`, { view: viewToken(v), agree: true, name: 'Sneaky', email: 'sneaky@visit.example' });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'signed_only');
  const w = sign(secret, { id: 'm-1', exp: soon() });
  assert.equal((await accept(slug, {}, `who=${w.who}&sig=${w.sig}`)).res.status, 200);
});

test('a press always belongs to the version on the screen: terms changed while the page was open, a page left open for a day, a made-up view, scrolling', async () => {
  const { slug, owner, id } = await published('Changing terms');
  const c = from();
  const page = await c.get(`/public/agree/${slug}`);
  assert.equal((await owner.call('PATCH', `/clickwraps/${id}`, { text: `${TERMS}\n\nA new clause.`, scroll: true })).status, 200);
  assert.equal((await owner.post(`/clickwraps/${id}/publish`, { note: 'A new clause, and the terms must be read to the end.' })).status, 200);
  const late = await c.post(`/public/agree/${slug}/accept`, { view: page.data.view, agree: true, name: 'Lena Late', email: 'lena@visit.example' });
  assert.equal(late.status, 409);
  assert.equal(late.data.code, 'terms_changed');
  assert.match(late.data.error, /changed while the page was open\. The page now shows version 2/);
  assert.equal((await c.post(`/public/agree/${slug}/accept`, { view: 'cwv_x.1.abc', agree: true, name: 'Lena Late', email: 'lena@visit.example' })).data.code, 'no_view');
  const { viewToken } = await import('../src/server/clickwrap.ts');
  const v2 = db.get('SELECT id FROM clickwrap_versions WHERE clickwrap_id=? AND number=2', id).id;
  const old = await c.post(`/public/agree/${slug}/accept`, { view: viewToken(v2, Date.now() - 25 * 3600_000), agree: true, name: 'Lena Late', email: 'lena@visit.example' });
  assert.equal(old.data.code, 'view_old');
  // Version 2 asks for the terms to be scrolled to the end first.
  const now = await c.get(`/public/agree/${slug}`);
  assert.equal(now.data.version.scroll, true);
  const noScroll = await c.post(`/public/agree/${slug}/accept`, { view: now.data.view, agree: true, name: 'Lena Late', email: 'lena@visit.example' });
  assert.equal(noScroll.data.code, 'not_scrolled');
  const ok = await c.post(`/public/agree/${slug}/accept`, { view: now.data.view, agree: true, scrolled: true, name: 'Lena Late', email: 'lena@visit.example' });
  assert.equal(ok.status, 200);
  assert.equal(db.get('SELECT scrolled FROM clickwrap_acceptances WHERE id=?', ok.data.acceptance.id).scrolled, 1);
});

test('inside a frame on the website: marked as such, with the page the browser reported and whether the button was covered', async () => {
  const { slug, secret } = await published('Framed terms');
  const w = sign(secret, { id: 'f-1', email: 'fay@shop.example', exp: soon() });
  const page = await from().get(`/public/agree/${slug}?who=${w.who}&sig=${w.sig}&embed=1`);
  assert.match(page.data.shows, /shown inside a frame/);
  const { res } = await accept(slug, { embed: true, page_url: 'https://shop.example/checkout', unobscured: false }, `who=${w.who}&sig=${w.sig}&embed=1`);
  assert.equal(res.status, 200);
  const row = db.get('SELECT * FROM clickwrap_acceptances WHERE id=?', res.data.acceptance.id);
  assert.deepEqual([row.via, row.page_url, row.unobscured], ['embed', 'https://shop.example/checkout', 0]);
  // An address that is not a web page is not kept.
  const odd = await accept(slug, { embed: true, page_url: 'javascript:alert(1)', name: 'Odd', email: 'odd@visit.example' });
  assert.equal(db.get('SELECT page_url FROM clickwrap_acceptances WHERE id=?', odd.res.data.acceptance.id).page_url, null);
  // The frame and the script: the frame may be shown on any site, the rest of the app still may not.
  const config = read('next.config.mjs');
  assert.match(config, /source: '\/agree\/:path\*'/);
  assert.match(config, /frame-ancestors \*/);
  const script = read('public/clickwrap.js');
  assert.match(script, /e\.origin !== origin/, 'the script only listens to our own frame');
  assert.match(script, /signgrow:accepted/);
  assert.equal(/data\.receipt|receipt:/.test(script), false, 'the receipt never reaches the page around the frame');
  const agree = read('src/app/agree/[slug]/page.tsx');
  assert.match(agree, /trackVisibility/, 'where the browser can tell, a covered button cannot be pressed');
  assert.equal(/postMessage\([^)]*receipt/.test(agree), false, 'and the frame never posts the receipt out');
});

test('the API: a website records an acceptance itself, marked as recorded by the website, and asks whether a person has accepted the version that counts', async () => {
  const { slug, owner, id, secret } = await published('API terms');
  const key = (await owner.post('/api-keys', { name: 'Website' })).data.key;
  const site = withKey(key);
  const rec = await site.post(`/clickwraps/${id}/acceptances`, { person: { id: 'u-7', name: 'Una', email: 'una@site.example' }, version: 1, page_url: 'https://site.example/signup', ip: '198.51.100.7', user_agent: 'Firefox' });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  assert.equal(rec.data.acceptance.via, 'api');
  assert.equal(rec.data.acceptance.identity, 'api');
  assert.match(rec.data.acceptance.recorded_by, /Olive Owner <.*>, with an API key/);
  assert.equal(rec.data.acceptance.given_ip, '198.51.100.7');
  assert.equal(rec.data.acceptance.ip, site.ip, 'and the address we saw is the website\'s own');
  assert.equal((await site.post(`/clickwraps/${id}/acceptances`, { person: { id: 'u-7' }, version: 1 })).data.already, true);
  assert.match((await site.post(`/clickwraps/${id}/acceptances`, { person: { name: 'No id' } })).data.error, /id or email is needed/);
  const wrong = await site.post(`/clickwraps/${id}/acceptances`, { person: { id: 'u-8' }, version: 5 });
  assert.equal(wrong.status, 409);
  assert.match(wrong.data.error, /at version 1 now, and the call says version 5/);

  let s = (await site.get(`/clickwraps/${id}/status?person_id=u-7`)).data;
  assert.deepEqual([s.accepted, s.current_version, s.counts_from_version, s.latest.identity], [true, 1, 1, 'api']);
  assert.equal((await site.get(`/clickwraps/${id}/status?person_id=u-404`)).data.accepted, false);
  assert.equal((await site.get(`/clickwraps/${id}/status`)).status, 400);
  // A visitor who types somebody's address is found by address, and the answer says it was typed.
  await accept(slug, { name: 'Pretender', email: 'boss@site.example' });
  s = (await site.get(`/clickwraps/${id}/status?email=BOSS@site.example`)).data;
  assert.equal(s.accepted, true);
  assert.equal(s.latest.identity, 'typed', 'so a website can decide which acceptances it trusts');
  // By the website's own id, a typed acceptance is never found: a visitor cannot type an id.
  assert.equal((await site.get(`/clickwraps/${id}/status?person_id=boss@site.example`)).data.accepted, false);

  // A new version that asks everyone again: "accepted" is no until the person accepts it.
  await owner.call('PATCH', `/clickwraps/${id}`, { text: 'New terms.' });
  await owner.post(`/clickwraps/${id}/publish`, { note: 'Rewritten.' });
  s = (await site.get(`/clickwraps/${id}/status?person_id=u-7`)).data;
  assert.deepEqual([s.accepted, s.counts_from_version, s.versions_accepted], [false, 2, [1]]);
  // The page tells the person what they accepted before and what changed.
  const w = sign(secret, { id: 'u-7', exp: soon() });
  const page = await from().get(`/public/agree/${slug}?who=${w.who}&sig=${w.sig}`);
  assert.equal(page.data.earlier.version, 1);
  assert.deepEqual(page.data.earlier.changes, [{ number: 2, note: 'Rewritten.' }]);
  await accept(slug, {}, `who=${w.who}&sig=${w.sig}`);
  assert.equal((await site.get(`/clickwraps/${id}/status?person_id=u-7`)).data.accepted, true);

  // A "send" key records and asks, and nothing more: the list of acceptances and the key are for admins.
  assert.equal((await site.get('/clickwrap-acceptances')).status, 403);
  assert.equal((await site.get(`/clickwraps/${id}`)).status, 403);
  // Another account's key cannot see or record anything here.
  const other = await person('Oscar Other', `oscar${++n}@terms.example`);
  const otherKey = withKey((await other.post('/api-keys', { name: 'x' })).data.key);
  assert.equal((await otherKey.post(`/clickwraps/${id}/acceptances`, { person: { id: 'x' } })).status, 404);
  assert.equal((await otherKey.get(`/clickwraps/${id}/status?person_id=u-7`)).status, 404);
});

// ---- 3. The record: never changed, a copy for the person, looking up, CSV, the certificate ----------------------------

const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);

test('an acceptance is never changed afterwards, and a record that was changed behind the app\'s back says so', async () => {
  const { slug, owner } = await published('Sealed terms');
  const { res } = await accept(slug, { name: 'Sid Sealed', email: 'sid@visit.example' });
  const aid = res.data.acceptance.id;
  assert.throws(() => db.run("UPDATE clickwrap_acceptances SET name='Someone else' WHERE id=?", aid), /never changed/);
  let one = (await owner.get(`/clickwrap-acceptances/${aid}`)).data;
  assert.equal(one.acceptance.intact, true);
  // Somebody with the database in hand takes the guard away and changes the name: the seal no longer fits.
  db.run('DROP TRIGGER clickwrap_acceptances_fixed');
  try {
    db.run("UPDATE clickwrap_acceptances SET name='Someone else' WHERE id=?", aid);
  } finally {
    db.run("CREATE TRIGGER clickwrap_acceptances_fixed BEFORE UPDATE ON clickwrap_acceptances BEGIN SELECT RAISE(ABORT, 'An acceptance is never changed.'); END");
  }
  one = (await owner.get(`/clickwrap-acceptances/${aid}`)).data;
  assert.equal(one.acceptance.intact, false);
  const cert = await owner.get(`/clickwrap-acceptances/${aid}/certificate`);
  assert.match(await pdfText(cert.data), /CHANGED: this record no longer fits its seal/);
});

test('the person gets a copy of what they accepted by email when the website gave the address, and can download it; nobody else can', async () => {
  const { slug, secret, id } = await published('Copy terms');
  const cora = sign(secret, { id: 'c-cora', name: 'Cora Copy', email: 'cora@visit.example', exp: soon() });
  const { res, c } = await accept(slug, {}, `who=${cora.who}&sig=${cora.sig}`);
  assert.equal(res.data.email, true, 'the page offers the copy');
  const sent = await c.post('/public/agree/receipt/email', { receipt: res.data.receipt });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.to, 'c***@visit.example');
  const mail = mailTo('cora@visit.example').at(-1);
  assert.equal(mail.subject, 'Your copy: Copy terms');
  const words = text(mail.html);
  assert.match(words, /accepted version 1 of "Copy terms"/);
  assert.match(words, /does not show who that person really was/);
  assert.match(words, /We send one copy for each acceptance, only when it is asked for on the page, and only to an address the website gave us/);
  assert.equal(/nothing else will come of it/.test(words), false, 'no promise the code does not keep');
  assert.match(words, /Report this page/);
  const row = db.get("SELECT about_user, payload FROM emails WHERE to_email='cora@visit.example' ORDER BY id DESC");
  assert.equal(row.about_user, `clickwrap:${id}`, 'our copy is marked, so it goes with the account');
  // Once for each acceptance, ever.
  const twice = await c.post('/public/agree/receipt/email', { receipt: res.data.receipt });
  assert.equal(twice.status, 409);
  assert.equal(twice.data.code, 'copy_sent');
  assert.match(twice.data.error, /emailed to c\*\*\*@visit\.example on .* Download the copy instead/);
  // A receipt that is not one finds nothing.
  assert.equal((await from().post('/public/agree/receipt/email', { receipt: 'cwr_made_up' })).status, 404);
  // The certificate by receipt: the terms are in it, and what the record shows and does not.
  const pdf = await from().get(`/public/agree/receipt/${res.data.receipt}/certificate`);
  assert.equal(pdf.status, 200);
  const t = await pdfText(pdf.data);
  for (const re of [/Record of acceptance/, /Copy terms/, /Cora Copy/, /cora@visit\.example/, /Given by the website in a signed link/, /does not show who that person really was/, /garden planner/, /Unchanged since it was recorded/, /depends on the country/])
    assert.match(t, re);
  // An address typed on the page is anybody's: no copy goes to it, and the page does not offer one.
  const typed = await accept(slug, { name: 'Tom Typed', email: 'tom@visit.example' });
  assert.equal(typed.res.data.email, false);
  const refused = await typed.c.post('/public/agree/receipt/email', { receipt: typed.res.data.receipt });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'not_vouched');
  assert.match(refused.data.error, /typed on the page, and we cannot know that it is yours/);
  assert.equal(mailTo('tom@visit.example').length, 0);
  assert.equal((await typed.c.get(`/public/agree/receipt/${typed.res.data.receipt}/certificate`)).status, 200, 'the download still works');
  // No address, no email: the person is told to download instead.
  const w = sign(secret, { id: 'no-mail', exp: soon() });
  const quiet = await accept(slug, {}, `who=${w.who}&sig=${w.sig}`);
  const none = await quiet.c.post('/public/agree/receipt/email', { receipt: quiet.res.data.receipt });
  assert.equal(none.status, 409);
  assert.match(none.data.error, /nowhere to send a copy\. Download the copy instead/);
});

test('terms in a PDF: shown as pages, fingerprinted as the file, and the certificate carries the pages', async () => {
  const owner = await person('Pia Pdf', `pia${++n}@terms.example`);
  const file = await upload(owner, 2);
  const made = await owner.post('/clickwraps', { name: 'PDF terms', file_id: file.id });
  assert.equal(made.status, 200);
  const pub = await owner.post(`/clickwraps/${made.data.id}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.sha256, db.get('SELECT sha256 FROM files WHERE id=?', file.id).sha256);
  const slug = (await owner.get(`/clickwraps/${made.data.id}`)).data.agreement.slug;
  const page = await from().get(`/public/agree/${slug}`);
  assert.equal(page.data.version.format, 'pdf');
  assert.equal(page.data.version.pages, 2);
  const shown = await from().get(page.data.version.pdf.replace(/^\/api/, ''));
  assert.equal(shown.status, 200);
  assert.equal((await PDFDocument.load(shown.data)).getPageCount(), 2);
  const { res } = await accept(slug, { name: 'Pat Pages', email: 'pat@visit.example' });
  const cert = await owner.get(`/clickwrap-acceptances/${res.data.acceptance.id}/certificate`);
  const doc = await PDFDocument.load(cert.data);
  assert.ok(doc.getPageCount() >= 3, 'the record, then the two pages of the terms');
  assert.match(await pdfText(cert.data), /Agreement page 2/);
});

test('the team looks acceptances up, filters them and exports them as CSV; a typed name cannot become a formula', async () => {
  const { slug, owner, id, secret } = await published('Lookup terms');
  await accept(slug, { name: '=HYPERLINK("http://evil.example","click")', email: 'eve@visit.example' });
  await accept(slug, { name: 'Gus Green', email: 'gus@visit.example' });
  const w = sign(secret, { id: 'L-9', name: 'Lou Linked', exp: soon() });
  await accept(slug, { embed: true }, `who=${w.who}&sig=${w.sig}`);
  const all = (await owner.get(`/clickwrap-acceptances?agreement=${id}`)).data;
  assert.equal(all.total, 3);
  assert.equal(all.acceptances[0].person.name, 'Lou Linked', 'newest first');
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&q=gus`)).data.total, 1);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&q=L-9`)).data.total, 1);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&via=embed`)).data.total, 1);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&identity=typed`)).data.total, 2);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&version=2`)).data.total, 0);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&from=${today}&to=${today}`)).data.total, 3);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&to=2020-01-01`)).data.total, 0);
  assert.match((await owner.get(`/clickwrap-acceptances?from=yesterday`)).data.error, /YYYY-MM-DD/);
  assert.match((await owner.get(`/clickwrap-acceptances?via=email`)).data.error, /one of: hosted, embed, api/);
  // A % in the search is a percent sign, not "anything".
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}&q=%25`)).data.total, 0);
  // Pages of two.
  const p1 = (await owner.get(`/clickwrap-acceptances?agreement=${id}&limit=2`)).data;
  assert.equal(p1.acceptances.length, 2);
  const p2 = (await owner.get(`/clickwrap-acceptances?agreement=${id}&limit=2&before=${p1.next_before}`)).data;
  assert.equal(p2.acceptances.length, 1);
  assert.equal(p2.next_before, null);
  // CSV.
  const csv = await owner.call('GET', `/clickwrap-acceptances/export?agreement=${id}`);
  const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csv.data);
  assert.ok(body.startsWith('﻿"acceptance_id","agreement","version","terms_sha256","accepted_at","identity","person_id","name","email"'));
  assert.equal(body.trim().split('\r\n').length, 4);
  assert.match(body, /"'=HYPERLINK\(""http:\/\/evil\.example"",""click""\)"/, 'a cell that starts with = is written with a quote mark in front');
  assert.match(body, /"Lou Linked"/);
  // Another account sees none of it.
  const other = await person('Ola Other', `ola${++n}@terms.example`);
  assert.equal((await other.get(`/clickwrap-acceptances?agreement=${id}`)).data.total, 0);
  assert.equal((await other.get(`/clickwrap-acceptances/${all.acceptances[0].id}`)).status, 404);
  assert.equal((await other.get(`/clickwrap-acceptances/${all.acceptances[0].id}/certificate`)).status, 404);
});

// ---- 4. Honest words -------------------------------------------------------------------------------------------------

test('the words say what is recorded before the click, what a record shows and does not, and never promise that a click binds anyone', async () => {
  const lib = await import('../src/lib/clickwrap.ts');
  for (const via of ['hosted', 'embed'] as const) {
    const w = lib.recordShows('typed', via, 'shop.example');
    assert.match(w.shows, /The browser that pressed reported/);
    assert.match(w.not, /does not show who that person really was, that they read the terms, or whether a person or a program pressed/);
  }
  const api = lib.recordShows('api', 'api');
  assert.match(api.shows, /did not show these terms to the person and did not see a click/);
  assert.match(lib.CLICK_LAW, /depends on the country, on the kind of agreement/);
  assert.match(lib.CLICK_LAW, /Check what applies to yours/);
  assert.match(lib.NOT_A_SIGNATURE, /not a signature and uses none of your signatures/);
  for (const f of ['src/lib/clickwrap.ts', 'src/server/clickwrap.ts', 'src/server/routes-clickwrap.ts', 'src/app/agree/[slug]/page.tsx', 'src/app/app/agreements/page.tsx', 'src/app/app/agreements/[id]/page.tsx', 'public/clickwrap.js']) {
    const s = read(f);
    assert.equal(/legally binding|is valid|will hold up|enforceable/i.test(s), false, `${f} promises nothing about the law`);
    assert.equal(s.includes('\u2014'), false, `${f} has no em dash`);
  }
  // The hosted page prints what is recorded and the line about the law before the button.
  const page = read('src/app/agree/[slug]/page.tsx');
  assert.ok(page.indexOf('data.recorded') > 0 && page.indexOf('data.recorded') < page.indexOf('type="submit"'), 'what is recorded stands before the button');
  assert.match(page, /data\.law/);
  // Formatting: headings, lists, bold, nothing else (no links, no HTML).
  assert.deepEqual(lib.termBlocks('# Title\n\nSome **bold** text\n- a\n- b\n\n1. one\n2. two\n<script>x</script>'), [
    { kind: 'h1', items: [[{ text: 'Title' }]] },
    { kind: 'p', items: [[{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' text' }]] },
    { kind: 'ul', items: [[{ text: 'a' }], [{ text: 'b' }]] },
    { kind: 'ol', items: [[{ text: 'one' }], [{ text: 'two' }]] },
    { kind: 'p', items: [[{ text: '<script>x</script>' }]] },
  ], 'a tag is only text: the page prints it as text, never as HTML');
});

// ---- 5. Money and the monthly limit -----------------------------------------------------------------------------------

test('an acceptance is not a signature and uses none; the monthly limit answers clearly and the admins are emailed at 80 percent and when it is reached', async () => {
  const { available } = await import('../src/server/credits.ts');
  const { slug, owner, id } = await published('Limited terms');
  const me = (await owner.get('/me')).data;
  const acc = me.account.id;
  const had = available(acc);
  const was = process.env.CLICKWRAP_MONTHLY_LIMIT;
  process.env.CLICKWRAP_MONTHLY_LIMIT = '5';
  try {
    for (let i = 1; i <= 3; i++) assert.equal((await accept(slug, { name: `Visitor ${i}`, email: `v${i}@limit.example` })).res.status, 200);
    assert.equal(available(acc), had, 'no signature is held or used');
    assert.equal(mailTo(me.user.email).filter((m: any) => /percent of this month/.test(m.subject)).length, 0);
    await accept(slug, { name: 'Visitor 4', email: 'v4@limit.example' });
    const warn = mailTo(me.user.email).filter((m: any) => /80 percent of this month's click-to-agree acceptances used/.test(m.subject));
    assert.equal(warn.length, 1, 'told at 80 percent');
    assert.match(text(warn[0].html), /4 of 5 acceptances used this month/);
    await accept(slug, { name: 'Visitor 5', email: 'v5@limit.example' });
    const full = mailTo(me.user.email).filter((m: any) => /no more click-to-agree acceptances this month/.test(m.subject));
    assert.equal(full.length, 1, 'and when it is reached');
    // The visitor is told plainly that nothing was recorded, and nothing about the account.
    const sixth = await accept(slug, { name: 'Visitor 6', email: 'v6@limit.example' });
    assert.equal(sixth.res.status, 429);
    assert.equal(sixth.res.data.code, 'monthly_limit');
    assert.match(sixth.res.data.error, /cannot be accepted here right now\. Nothing was recorded/);
    // The website's server is told the numbers and the day it starts again.
    const key = withKey((await owner.post('/api-keys', { name: 'Website' })).data.key);
    const api = await key.post(`/clickwraps/${id}/acceptances`, { person: { id: 'over' } });
    assert.equal(api.status, 429);
    assert.match(api.data.error, /recorded 5 click-to-agree acceptances this month, and 5 is the most this server records for one account in a month\. Nothing was recorded\. The count starts again on \d{4}-\d{2}-01/);
    assert.equal(db.get('SELECT COUNT(*) n FROM clickwrap_acceptances WHERE clickwrap_id=?', id).n, 5);
    assert.equal(mailTo(me.user.email).filter((m: any) => /no more click-to-agree/.test(m.subject)).length, 1, 'once a month, not at every refusal');
    const list = (await owner.get('/clickwraps')).data;
    assert.deepEqual([list.usage.used, list.usage.limit], [5, 5]);
    assert.match(list.usage.line, /5 of 5 acceptances used this month, counted for the whole account/);
    // 0 records none.
    process.env.CLICKWRAP_MONTHLY_LIMIT = '0';
    assert.match((await owner.get('/clickwraps')).data.usage.line, /records no acceptances at all/);
  } finally {
    if (was === undefined) delete process.env.CLICKWRAP_MONTHLY_LIMIT;
    else process.env.CLICKWRAP_MONTHLY_LIMIT = was;
  }
  const { clickwrapMonthlyLimit } = await import('../src/lib/policy.ts');
  assert.equal(clickwrapMonthlyLimit({}), 1000, 'the default');
  assert.equal(clickwrapMonthlyLimit({ CLICKWRAP_MONTHLY_LIMIT: 'lots' }), 1000);
});

// ---- 6. Abuse -----------------------------------------------------------------------------------------------------------

const NOTICE = 'PayPal invoice: your payment of $499.99 was charged. To cancel call +1 (888) 555-0142 now.';

test('the fake payment notice filter reads the terms of an account that has not earned trust: refused at publish, and a page that reads like one is closed', async () => {
  const owner = await person('Fran Filter', `fran${++n}@terms.example`);
  const made = await owner.post('/clickwraps', { name: 'Billing terms', text: NOTICE });
  const pub = await owner.post(`/clickwraps/${made.data.id}/publish`, {});
  assert.equal(pub.status, 422);
  assert.match(pub.data.error, /read like a payment notice from a well-known brand.*PayPal.*Nothing was published/);
  const brand = await owner.post('/clickwraps', { name: 'PayPal Billing', text: 'Be kind.' });
  assert.match((await owner.post(`/clickwraps/${brand.data.id}/publish`, {})).data.error, /reads like PayPal/);
  // A PDF the filter cannot read (a picture) is refused for such an account too.
  const png = new FormData();
  png.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'scan.png');
  const f = (await owner.call('POST', '/files', png)).data;
  const scan = await owner.post('/clickwraps', { name: 'Scanned terms', file_id: f.id });
  assert.match((await owner.post(`/clickwraps/${scan.data.id}/publish`, {})).data.error, /cannot read the words of this PDF/);
  // An account that earned trust may publish what it likes; if it loses that trust, the page closes by itself.
  const acc = (await owner.get('/me')).data.account.id;
  db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), acc);
  assert.equal((await owner.post(`/clickwraps/${made.data.id}/publish`, {})).status, 200);
  const slug = (await owner.get(`/clickwraps/${made.data.id}`)).data.agreement.slug;
  assert.equal((await from().get(`/public/agree/${slug}`)).data.closed, false);
  db.run('UPDATE accounts SET trusted_at=NULL WHERE id=?', acc);
  const closed = await from().get(`/public/agree/${slug}`);
  assert.equal(closed.data.closed, true);
  assert.equal(JSON.stringify(closed.data).includes('PayPal'), false, 'the page prints nothing of it');
  assert.equal(JSON.stringify(closed.data).includes('Fran'), false, 'nor the account');
  assert.equal((await owner.get(`/clickwraps/${made.data.id}`)).data.agreement.state, 'stopped');
  assert.match((await owner.get(`/clickwraps/${made.data.id}`)).data.agreement.why, /payment notice/);
  await from().get(`/public/agree/${slug}`);
  const told = mailTo((await owner.get('/me')).data.user.email).filter((m: any) => /could not be accepted/.test(m.subject));
  assert.equal(told.length, 1, 'the team is told why, once a day');
});

test('a paused or closing account\'s terms are closed everywhere; closing terms by hand keeps the records', async () => {
  const { slug, owner, id } = await published('Pause terms');
  const acc = (await owner.get('/me')).data.account.id;
  const key = withKey((await owner.post('/api-keys', { name: 'Website' })).data.key);
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='reports' WHERE id=?", new Date().toISOString(), acc);
  assert.equal((await from().get(`/public/agree/${slug}`)).data.closed, true);
  const v = db.get('SELECT id FROM clickwrap_versions WHERE clickwrap_id=?', id).id;
  const { viewToken } = await import('../src/server/clickwrap.ts');
  assert.equal((await from().post(`/public/agree/${slug}/accept`, { view: viewToken(v), agree: true, name: 'P', email: 'p@visit.example' })).status, 503);
  const api = await key.post(`/clickwraps/${id}/acceptances`, { person: { id: 'x' } });
  assert.equal(api.status, 409);
  assert.match(api.data.error, /Sending is paused on this account.*click-to-agree pages are closed too/);
  await owner.call('PATCH', `/clickwraps/${id}`, { text: 'changed' });
  assert.equal((await owner.post(`/clickwraps/${id}/publish`, { note: 'x' })).status, 403);
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', acc);
  assert.equal((await from().get(`/public/agree/${slug}`)).data.closed, false);
  db.run('UPDATE accounts SET closing_at=? WHERE id=?', new Date(Date.now() + 9 * 864e5).toISOString(), acc);
  assert.equal((await from().get(`/public/agree/${slug}`)).data.closed, true);
  db.run('UPDATE accounts SET closing_at=NULL WHERE id=?', acc);
  // Closing by hand.
  await accept(slug, { name: 'Kept', email: 'kept@visit.example' });
  assert.equal((await owner.call('PATCH', `/clickwraps/${id}`, { active: false })).status, 200);
  assert.equal((await from().get(`/public/agree/${slug}`)).data.closed, true);
  assert.equal((await owner.get(`/clickwrap-acceptances?agreement=${id}`)).data.total, 1, 'the records stay');
  // Terms someone accepted cannot be deleted; terms nobody accepted can.
  const del = await owner.call('DELETE', `/clickwraps/${id}`);
  assert.equal(del.status, 409);
  assert.match(del.data.error, /cannot be deleted\. Close them instead/);
  const spare = (await owner.post('/clickwraps', { name: 'Never used' })).data.id;
  assert.equal((await owner.call('DELETE', `/clickwraps/${spare}`)).status, 200);
});

test('"report this page" reaches the people who review reports, never pauses the account by itself, and the operator queue names the page', async () => {
  const { slug, owner } = await published('Reported terms');
  process.env.OPERATOR_EMAILS = 'opal@operator.example';
  try {
    const op = await person('Opal Operator', 'opal@operator.example');
    for (let i = 0; i < 4; i++) {
      const r = await from().post(`/public/agree/${slug}/report`, { reason: 'phishing', detail: 'Looks like a bank', email: `r${i}@visit.example` });
      assert.equal(r.status, 200);
    }
    const acc = (await owner.get('/me')).data.account.id;
    assert.equal(db.get('SELECT suspended_at s FROM accounts WHERE id=?', acc).s, null, 'four reports from strangers pause nothing');
    const q = (await op.get('/operator/queue')).data.reports.filter((r: any) => r.account_id === acc);
    assert.equal(q.length, 4);
    assert.equal(q[0].clickwrap_name, 'Reported terms');
    assert.equal(q[0].clickwrap_slug, slug);
    assert.equal(q[0].envelope_deleted, false);
    // The same person twice is one report.
    const c = from();
    await c.post(`/public/agree/${slug}/report`, { reason: 'spam', email: 'same@visit.example' });
    assert.equal((await c.post(`/public/agree/${slug}/report`, { reason: 'spam', email: 'same@visit.example' })).data.already, true);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
  const page = read('src/app/agree/[slug]/page.tsx');
  assert.match(page, /Report this page/);
});

test('rate limits per address: ten acceptances an hour on one agreement from one machine', async () => {
  const { slug } = await published('Busy terms');
  const c = from();
  let last: any;
  for (let i = 0; i < 11; i++) last = (await accept(slug, { name: `Same Machine ${i}`, email: `same${i}@visit.example` }, '', c)).res;
  assert.equal(last.status, 429, 'ten an hour on one agreement from one address');
  assert.match(last.data.error, /Too many attempts/);
});

// ---- 7. Deleting -----------------------------------------------------------------------------------------------------

test('acceptances belong to the account and go when it is deleted, with the versions, the reports and our copies of the emails', async () => {
  const { purgeUser } = await import('../src/server/routes-trust.ts');
  const { slug, owner, id, secret } = await published('Deleted terms');
  const del = sign(secret, { id: 'del-1', name: 'Del Visitor', email: 'del@visit.example', exp: soon() });
  const { res, c } = await accept(slug, {}, `who=${del.who}&sig=${del.sig}`);
  assert.equal((await c.post('/public/agree/receipt/email', { receipt: res.data.receipt })).status, 200);
  await from().post(`/public/agree/${slug}/report`, { reason: 'spam', email: 'rep@visit.example' });
  const me = (await owner.get('/me')).data;
  assert.ok(db.get("SELECT 1 x FROM emails WHERE about_user=?", `clickwrap:${id}`));
  purgeUser(me.user.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM clickwraps WHERE id=?', id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM clickwrap_versions WHERE clickwrap_id=?', id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM clickwrap_acceptances WHERE clickwrap_id=?', id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE about_user=?', `clickwrap:${id}`).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM abuse_reports WHERE clickwrap_id=?', id).n, 0);
  assert.equal((await from().get(`/public/agree/${slug}`)).status, 404);
  assert.equal((await from().get(`/public/agree/receipt/${res.data.receipt}/certificate`)).status, 404);
  const { DELETED_WITH_ACCOUNT } = await import('../src/lib/policy.ts');
  assert.ok(DELETED_WITH_ACCOUNT.some((x) => /click-to-agree terms with every version, every acceptance/.test(x)), 'the pages say so');
  assert.match(read('src/server/routes-trust.ts'), /forgetClickwraps\(a\.id\)/);
});

// ---- 8. Documented, and taken out of "What is not in it" --------------------------------------------------------------

test('every click-to-agree route is in the API description, the setting is documented, and nothing says clickwrap is missing', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const { listRoutes } = await import('../src/server/router.ts');
  const spec: any = openapi();
  const documented = new Set(Object.entries<any>(spec.paths).flatMap(([p, item]) => ['get', 'post', 'patch', 'delete'].filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${p}`)));
  const ours = listRoutes().filter((r) => /clickwrap|\/agree/.test(r.path));
  assert.ok(ours.length >= 18);
  for (const r of ours) assert.ok(documented.has(`${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`), `not documented: ${r.method} ${r.path}`);
  assert.match(read('.env.example'), /CLICKWRAP_MONTHLY_LIMIT/);
  const readme = read('README.md');
  assert.match(readme, /\| `CLICKWRAP_MONTHLY_LIMIT` \|/);
  assert.match(readme.slice(readme.indexOf('## Things to decide before launch')), /Click-to-agree acceptances/);
  const notIn = readme.slice(readme.indexOf('## What is not in it'), readme.indexOf('## ', readme.indexOf('## What is not in it') + 5));
  assert.equal(/clickwrap/i.test(notIn), false, 'clickwrap is no longer listed as missing');
  for (const f of ['src/app/page.tsx', 'src/app/help/page.tsx', 'src/app/security/page.tsx', 'src/app/developers/page.tsx'])
    assert.equal(/no clickwrap|clickwrap is not|not.{0,40}click-to-agree/i.test(read(f)), false, `${f} does not say it is missing`);
});

// ---- 9. Repairs after the skeptic's report (research/verify-new.json, "verify:clickwrap") ----------------------------

test('the scam filter reads every word the page shows: the box, the button and the notes of what changed, and the details in a signed link', async () => {
  const owner = await person('Una Unpaid', `una${++n}@terms.example`);
  // A fake notice as the words next to the box, over harmless terms.
  const box = await owner.post('/clickwraps', { name: 'Membership terms', text: 'Be kind to each other.', checkbox: NOTICE, button: 'Call +1 (888) 555-0142' });
  const p1 = await owner.post(`/clickwraps/${box.data.id}/publish`, {});
  assert.equal(p1.status, 422, JSON.stringify(p1.data));
  assert.match(p1.data.error, /words shown with them \(next to the box, on the button, in a note of what changed\), read like a payment notice.*PayPal.*Nothing was published/);
  // Split over three: the brand by the box, the money on the button, the phone number in the terms.
  const split = await owner.post('/clickwraps', { name: 'Shop rules', text: 'Questions? +1 (888) 555-0142', checkbox: 'I accept the PayPal terms', button: 'Pay $499.99' });
  assert.equal((await owner.post(`/clickwraps/${split.data.id}/publish`, {})).status, 422);
  // A version note: every returning visitor is shown it.
  const { id, slug, secret } = await published('Club terms', 'Version one.', owner);
  const w = sign(secret, { id: 'p1', exp: soon() });
  assert.equal((await accept(slug, {}, `who=${w.who}&sig=${w.sig}`)).res.status, 200);
  await owner.call('PATCH', `/clickwraps/${id}`, { text: 'Version two.' });
  const p3 = await owner.post(`/clickwraps/${id}/publish`, { note: NOTICE });
  assert.equal(p3.status, 422);
  assert.equal(db.get('SELECT COUNT(*) n FROM clickwrap_versions WHERE clickwrap_id=?', id).n, 1, 'nothing was published');
  // An honest shop that names a brand, with no phone number to call, publishes.
  const honest = await owner.post('/clickwraps', { name: 'Checkout terms', text: 'Pay within 30 days.', checkbox: 'I agree to pay with PayPal or a card', button: 'Pay now' });
  assert.equal((await owner.post(`/clickwraps/${honest.data.id}/publish`, {})).status, 200);
  // Published while the account was trusted, then trust is lost: the page closes by itself, labels or note alike.
  const acc = (await owner.get('/me')).data.account.id;
  db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), acc);
  assert.equal((await owner.post(`/clickwraps/${box.data.id}/publish`, {})).status, 200);
  const boxSlug = (await owner.get(`/clickwraps/${box.data.id}`)).data.agreement.slug;
  assert.equal((await owner.post(`/clickwraps/${id}/publish`, { note: NOTICE })).status, 200);
  db.run('UPDATE accounts SET trusted_at=NULL WHERE id=?', acc);
  for (const s of [boxSlug, slug]) {
    const page = await from().get(`/public/agree/${s}`);
    assert.equal(page.data.closed, true, s);
    assert.equal(JSON.stringify(page.data).includes('555-0142'), false);
  }
  // A website that puts the notice into the name of its signed link: the page would print it, so it is refused.
  const { slug: s2, secret: k2, id: id2 } = await published('Garden terms', 'Questions? Call +1 (888) 555-0142.', owner);
  const lure = sign(k2, { id: 'v1', name: 'PayPal: $499.99 charged to your card', email: 'victim@inbox.example', exp: soon() });
  const page = await from().get(`/public/agree/${s2}?who=${lure.who}&sig=${lure.sig}`);
  assert.equal(page.data.closed, true);
  assert.equal(JSON.stringify(page.data).includes('PayPal'), false, 'the page prints nothing of it');
  const view = (await from().get(`/public/agree/${s2}`)).data.view;
  assert.equal((await from().post(`/public/agree/${s2}/accept`, { view, agree: true, who: lure.who, sig: lure.sig })).status, 503);
  assert.equal(db.get('SELECT COUNT(*) n FROM clickwrap_acceptances WHERE clickwrap_id=?', id2).n, 0);
  const told = mailTo((await owner.get('/me')).data.user.email).filter((m: any) => /Garden terms" could not be accepted/.test(m.subject));
  assert.match(text(told.at(-1).html), /signed link for one visitor/);
  // The same page for a visitor with an ordinary name is open.
  const fine = sign(k2, { id: 'v2', name: 'Ada Lovelace', exp: soon() });
  assert.equal((await from().get(`/public/agree/${s2}?who=${fine.who}&sig=${fine.sig}`)).data.closed, false);
});

test('the receipt and the copy go only to the browser that accepted: a replayed signed link learns that the person accepted, and nothing more', async () => {
  const { slug, secret, owner } = await published('Receipt terms');
  const cass = sign(secret, { id: 'cust-1', name: 'Cass Customer', email: 'cass@inbox.example', exp: soon() });
  const q = `who=${cass.who}&sig=${cass.sig}`;
  const mine = from();
  const { page, res } = await accept(slug, {}, q, mine);
  assert.match(res.data.receipt, /^cwr_/, 'her own browser gets it in the answer to its press');
  // The same page load pressing twice (an answer that never arrived) gets it again.
  const again = await mine.post(`/public/agree/${slug}/accept`, { view: page.data.view, agree: true, who: cass.who, sig: cass.sig });
  assert.deepEqual([again.data.already, again.data.receipt], [true, res.data.receipt]);
  // Somebody else with the same link: a forwarded email, a shared screen, a browser history.
  const other = from();
  const seen = await other.get(`/public/agree/${slug}?${q}`);
  assert.equal(seen.data.already.id, res.data.acceptance.id, 'they are told she accepted');
  assert.equal(JSON.stringify(seen.data).includes('cwr_'), false, 'and get no receipt from the page');
  const pressed = await other.post(`/public/agree/${slug}/accept`, { view: seen.data.view, agree: true, who: cass.who, sig: cass.sig });
  assert.equal(pressed.data.already, true);
  assert.equal(pressed.data.receipt, undefined, 'nor from pressing');
  assert.equal(pressed.data.email, false);
  // A paused account sends no copy; the person can still download the record.
  const acc = (await owner.get('/me')).data.account.id;
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='reports' WHERE id=?", new Date().toISOString(), acc);
  const paused = await mine.post('/public/agree/receipt/email', { receipt: res.data.receipt });
  assert.equal(paused.status, 409);
  assert.equal(paused.data.code, 'closed');
  assert.match(paused.data.error, /cannot send a copy by email right now\. Nothing was sent\. Download the copy instead/);
  assert.equal(mailTo('cass@inbox.example').length, 0);
  assert.equal((await mine.get(`/public/agree/receipt/${res.data.receipt}/certificate`)).status, 200);
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', acc);
  // One copy, ever: also hours later and from other addresses.
  const real = Date.now;
  let shift = 0;
  Date.now = () => real() + shift;
  try {
    const statuses: number[] = [];
    for (let h = 0; h < 4; h++) {
      shift = h * 3601_000;
      statuses.push((await from().post('/public/agree/receipt/email', { receipt: res.data.receipt })).status);
    }
    assert.deepEqual(statuses, [200, 409, 409, 409]);
  } finally {
    Date.now = real;
  }
  assert.equal(mailTo('cass@inbox.example').length, 1);
  // Two presses of "Email me a copy" at the same moment send one.
  const dan = sign(secret, { id: 'cust-2', name: 'Dan', email: 'dan@inbox.example', exp: soon() });
  const d = await accept(slug, {}, `who=${dan.who}&sig=${dan.sig}`);
  const both = await Promise.all([from().post('/public/agree/receipt/email', { receipt: d.res.data.receipt }), from().post('/public/agree/receipt/email', { receipt: d.res.data.receipt })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(mailTo('dan@inbox.example').length, 1);
  // The page never hands the receipt out and keeps it in the browser that accepted.
  const agree = read('src/app/agree/[slug]/page.tsx');
  assert.equal(/already\.receipt/.test(agree), false);
  assert.match(agree, /localStorage/);
});

test('copies by email from an account that has not earned trust count against a daily limit of their own', async () => {
  const { slug, secret, owner } = await published('Busy copy terms');
  const { dailyCap } = await import('../src/server/envelopes.ts');
  const acc = db.get('SELECT * FROM accounts WHERE id=?', (await owner.get('/me')).data.account.id);
  const cap = dailyCap(acc).cap;
  let ok = 0, refused: any = null;
  for (let i = 0; i <= cap; i++) {
    const w = sign(secret, { id: `cap-${i}`, email: `cap${i}@inbox.example`, exp: soon() });
    const { res, c } = await accept(slug, {}, `who=${w.who}&sig=${w.sig}`);
    const r = await c.post('/public/agree/receipt/email', { receipt: res.data.receipt });
    if (r.status === 200) ok++;
    else refused = r;
  }
  assert.equal(ok, cap);
  assert.equal(refused.status, 429);
  assert.match(refused.data.error, /cannot send more copies by email for this organisation today\. Nothing was sent/);
});
