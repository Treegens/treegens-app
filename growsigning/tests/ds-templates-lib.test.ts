// Ready-made templates (src/lib/starters/, src/server/starters.ts, routes-starters.ts): every starter is written
// as the brief says, renders on one or two pages with its fields inside the page and on the right roles, can be
// made into a template and sent, carries its note, and is checked before sending like any other document.
import { readEnglish } from './words.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { boot, signUp, signAll, Client, type Server } from './helpers.ts';

let S: Server;
let lib: typeof import('../src/lib/starters/index.ts');
let render: typeof import('../src/server/starters.ts');
let text: typeof import('../src/server/text.ts');
before(async () => {
  S = await boot();
  lib = await import('../src/lib/starters/index.ts');
  render = await import('../src/server/starters.ts');
  text = await import('../src/server/text.ts');
});

const valuesFor = (s: any, org = 'Green Roots Community Group') =>
  Object.fromEntries(lib.asksOf(s).map((a) => [a.key, a.key === 'organisation' ? org : a.example || 'something']));

test('1. every starter file has what the brief asks for, in plain words', () => {
  assert.equal(lib.STARTERS.length, 10);
  const ids = new Set<string>();
  for (const s of lib.STARTERS) {
    assert.ok(!ids.has(s.id), `${s.id} twice`);
    ids.add(s.id);
    assert.ok(s.title && s.purpose && !s.purpose.includes('\n'), s.id);
    assert.match(s.written, /^\d{4}-\d{2}-\d{2}$/);
    // Nobody has reviewed these yet, so none may claim a country.
    assert.equal(s.place, 'No particular country');
    assert.equal(s.reviewedBy, '');
    const blocks = new Set(s.blocks.map((b) => b.id));
    const roles = new Set(s.roles.map((r) => r.key));
    for (const f of s.fields) {
      assert.ok(blocks.has(f.after), `${s.id}: field "${f.label}" is placed after "${f.after}", which is not a block`);
      assert.ok(roles.has(f.role), `${s.id}: field "${f.label}" is for "${f.role}", which is not a role`);
      assert.ok(f.label.length <= 120 && !/\{/.test(f.label), `${s.id}: label "${f.label}"`);
    }
    // Everyone who is asked to sign has a signature to place.
    for (const r of s.roles) assert.ok(s.fields.some((f) => f.role === r.key && f.type === 'signature'), `${s.id}: ${r.key} signs nothing`);
    const all = JSON.stringify(s);
    assert.ok(!/[\u2014\u2013]/.test(all), `${s.id} has a dash we do not use`);
    // Every {word} in the text is one the sender is asked for.
    const keys = new Set(lib.asksOf(s).map((a) => a.key));
    for (const m of all.matchAll(/\{([a-z]+)\}/g)) assert.ok(keys.has(m[1]), `${s.id}: {${m[1]}} is never asked for`);
    // Left out on purpose: tax wording, wills, deeds and powers of attorney.
    assert.ok(!/\btax|\bwill and testament|\bdeed\b|power of attorney|notar/i.test(all), `${s.id} has wording the brief leaves out`);
  }
  assert.deepEqual([...ids].sort(), ['confidential', 'equipment', 'event', 'gift', 'grant', 'parental', 'photos', 'planting', 'share-data', 'volunteer']);
  // The photo consent says how to withdraw it; the planting consent covers land, trees, visits, time and ending.
  assert.match(JSON.stringify(lib.starterById('photos')), /withdraw/i);
  const plant = JSON.stringify(lib.starterById('planting'));
  for (const w of ['owns', 'planted', 'visit', 'years', 'end this agreement']) assert.ok(plant.includes(w), `planting lacks "${w}"`);
});

test('2. every starter renders on one or two pages, its fields inside the page, apart, and on the right roles', async () => {
  for (const s of lib.STARTERS) {
    const r = await render.renderStarter(s, valuesFor(s));
    const pdf = await PDFDocument.load(r.pdf);
    assert.equal(pdf.getPageCount(), r.pages);
    assert.ok(r.pages >= 1 && r.pages <= 2, `${s.id} has ${r.pages} pages`);
    assert.equal(r.fields.length, s.fields.length, s.id);
    for (const f of r.fields) {
      assert.ok(f.page >= 0 && f.page < r.pages, `${s.id}: ${f.label} on page ${f.page}`);
      assert.ok(f.x >= 0.05 && f.y >= 0.05 && f.x + f.w <= 0.95 && f.y + f.h <= 0.93, `${s.id}: ${f.label} at ${JSON.stringify(f)}`);
      // Above the foot of the page, where a signed copy adds its strip.
      assert.ok((1 - f.y - f.h) * render.PAGE.H > 40, `${s.id}: ${f.label} too low`);
    }
    for (let i = 0; i < r.fields.length; i++) for (let j = i + 1; j < r.fields.length; j++) {
      const a = r.fields[i], b = r.fields[j];
      const apart = a.page !== b.page || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${s.id}: "${a.label}" and "${b.label}" overlap`);
    }
    // The words are real text, so the document can be searched and read aloud, with the organisation's name in it.
    const words = (await text.extractPages(r.pdf)).join(' ');
    assert.ok(words.includes('Green Roots Community Group'), s.id);
    assert.ok(!/\{[a-z]+\}/.test(words), `${s.id} printed a placeholder`);
  }
});

test('2b. a name in another script prints as written, and the preview shows what is still to write in', async () => {
  const s = lib.starterById('volunteer')!;
  const r = await render.renderStarter(s, { organisation: 'جمعية الأشجار الخضراء' });
  assert.equal(r.pages <= 2, true);
  const p = await render.renderStarter(lib.starterById('share-data')!, {});
  const words = (await text.extractPages(p.pdf)).join(' ');
  assert.ok(words.includes("[Your organisation's name]") && words.includes("[The partner's name]"), words.slice(0, 300));
});

test('3. using a starter makes a normal template that can be sent and signed; the note is there; the check before sending runs', async () => {
  const ana = await signUp('Ana Silva', 'ana@starters.test', '198.51.100.31');
  const list = (await ana.get('/starters')).data;
  assert.equal(list.starters.length, 10);
  // The account is still called "Ana Silva's workspace": that is not an organisation's name, so nothing is guessed.
  assert.equal(list.organisation, '');
  for (const s of list.starters) {
    assert.equal(s.note, 'A starting point written by GrowSigning, not legal advice. Not reviewed by a lawyer.');
    assert.equal(s.place, 'No particular country');
    assert.equal(s.reviewed_by, null);
    assert.equal(s.asks[0].key, 'organisation');
  }
  for (const s of lib.STARTERS) {
    const made = await ana.post(`/starters/${s.id}/use`, valuesFor(s));
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const t = made.data.template;
    assert.equal(t.kind, 'template');
    assert.equal(t.subject, s.title);
    assert.equal(t.starter_id, s.id);
    assert.equal(t.starter_note, made.data.note);
    assert.equal(made.data.edit_url, `/app/templates/${t.id}/edit`);
    assert.deepEqual(t.recipients.map((r: any) => r.role_name).sort(), s.roles.map((r) => r.name).sort());
    assert.equal(t.fields.length, s.fields.length);
    // Each field belongs to the person of its role.
    const byName = new Map(t.recipients.map((r: any) => [r.id, r.role_name]));
    for (const role of s.roles) {
      const want = s.fields.filter((f) => f.role === role.key).map((f) => f.label).sort();
      assert.deepEqual(t.fields.filter((f: any) => byName.get(f.recipient_id) === role.name).map((f: any) => f.label).sort(), want, `${s.id}: ${role.name}`);
    }
    // The person who picked it owns it, and everyone on the team may use it (the usual rule).
    const access = (await ana.get(`/envelopes/${t.id}/access`)).data.access;
    assert.equal(access.use, 'team');
    assert.equal(S.db.get('SELECT sender_id FROM envelopes WHERE id=?', t.id).sender_id, S.db.get("SELECT id FROM users WHERE email='ana@starters.test'").id);
    // Sent like any template, with the people filled in by role, and checked before sending.
    const fill = Object.fromEntries(t.recipients.map((r: any, i: number) => [r.id, { name: `Person ${i + 1}`, email: `p${i + 1}.${s.id}@example.com` }]));
    const sent = await ana.post('/envelopes', { template_id: t.id, recipients: fill, send: true });
    assert.equal(sent.status, 200, `${s.id}: ${JSON.stringify(sent.data)}`);
    assert.ok(Array.isArray(sent.data.warnings));
    // None of them is a kind of document that needs a notary, a witness or paper.
    assert.deepEqual(sent.data.warnings.map((w: any) => w.kind ?? w.id), [], `${s.id}: ${JSON.stringify(sent.data.warnings)}`);
    assert.ok(S.db.all('SELECT action FROM audit WHERE envelope_id=?', t.id).some((a: any) => a.action === 'Made from a ready-made template'));
  }
  // The check reads the starter's own words like any document's: a name that points to a kind of document that needs
  // paper is found in the PDF's text, said in the answer and written in the trail.
  const odd = (await ana.post('/starters/gift/use', { organisation: 'Power of Attorney Helpers' })).data.template;
  const oddSent = await ana.post('/envelopes', { template_id: odd.id, recipients: { [odd.recipients[0].id]: { name: 'Pat Donor', email: 'pat@example.com' } }, send: true });
  assert.equal(oddSent.status, 200, JSON.stringify(oddSent.data));
  assert.deepEqual(oddSent.data.warnings.map((w: any) => w.kind), ['attorney']);
  assert.ok(S.db.all('SELECT action FROM audit WHERE envelope_id=?', oddSent.data.envelope.id).some((a: any) => a.action === 'Checked for documents that often need paper'));
  // One of them signed all the way through, by both people in order.
  const vol = S.db.get("SELECT id FROM envelopes WHERE kind='envelope' AND subject='Volunteer agreement'").id;
  assert.equal((await signAll(vol, 'p1.volunteer@example.com')).status, 200);
  const second = S.db.get("SELECT email FROM recipients WHERE envelope_id=? AND email<>'p1.volunteer@example.com'", vol).email;
  assert.equal((await signAll(vol, second)).status, 200);
  assert.equal(S.db.get('SELECT status FROM envelopes WHERE id=?', vol).status, 'completed');
  // Afterwards the list says which templates were made from each starter, so a second pick by mistake is easy to see.
  const again = (await ana.get('/starters')).data.starters.find((s: any) => s.id === 'volunteer');
  assert.equal(again.made.length, 1);
});

test('4. abuse and mistakes: unknown starter, missing or odd words, a brand name, other accounts', async () => {
  const ben = await signUp('Ben Okafor', 'ben@starters.test', '198.51.100.32');
  const count = () => S.db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='template'").n;
  const before = count();
  const r404 = await ben.post('/starters/../../etc/use', { organisation: 'X' });
  assert.ok(r404.status === 404 || r404.status === 405, String(r404.status));
  assert.equal((await ben.post('/starters/will/use', { organisation: 'X' })).status, 404);
  const none = await ben.post('/starters/volunteer/use', {});
  assert.equal(none.status, 400);
  assert.match(none.data.error, /Write your organisation's name\. It is printed in the document\. Nothing was made\./);
  const missingPartner = await ben.post('/starters/share-data/use', { organisation: 'Riverside Trust' });
  assert.match(missingPartner.data.error, /partner's name/);
  assert.equal((await ben.post('/starters/volunteer/use', { organisation: ['a'] })).status, 400);
  assert.match((await ben.post('/starters/volunteer/use', { organisation: 'x'.repeat(101) })).data.error, /most that fits is 100/);
  const brand = await ben.post('/starters/gift/use', { organisation: 'PayPal Billing' });
  assert.equal(brand.status, 400);
  assert.match(brand.data.error, /PayPal/);
  assert.equal(count(), before, 'a refusal leaves nothing behind');
  // Line breaks and control characters cannot push words onto the page out of place.
  const ok = await ben.post('/starters/volunteer/use', { organisation: 'Okafor\nYouth\u0007 Club ' });
  assert.equal(ok.status, 200);
  const f = S.db.get('SELECT f.text FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', ok.data.template.id);
  assert.ok(f.text.includes('Okafor Youth Club'), f.text.slice(0, 200));
  // Another account sees none of Ben's templates in its list.
  const cy = await signUp('Cy Tan', 'cy@starters.test', '198.51.100.33');
  assert.equal((await cy.get('/starters')).data.starters.find((s: any) => s.id === 'volunteer').made.length, 0);
  assert.equal((await cy.get(`/envelopes/${ok.data.template.id}`)).status, 404);
  // Signed out, nothing.
  assert.equal((await new Client().get('/starters')).status, 401);
  // An account with a real name gets it suggested.
  S.db.run("UPDATE accounts SET name='Tan Family Farm Cooperative' WHERE id=(SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='cy@starters.test')");
  assert.equal((await cy.get('/starters')).data.organisation, 'Tan Family Farm Cooperative');
  // The preview is a PDF and saves nothing.
  const n = count();
  const pv = await cy.get('/starters/photos/preview?organisation=Tan%20Farm');
  assert.equal(pv.status, 200);
  assert.ok(pv.data instanceof Uint8Array && pv.data.length > 1000);
  assert.equal(count(), n);
});

test('5. a template made from a starter keeps the note it was made with, and copies of it work like any template', async () => {
  const dee = await signUp('Dee Moyo', 'dee@starters.test', '198.51.100.34');
  const t = (await dee.post('/starters/photos/use', { organisation: 'Moyo Arts' })).data.template;
  const copy = await dee.post(`/envelopes/${t.id}/clone`, { kind: 'template' });
  assert.ok(copy.status === 200, JSON.stringify(copy.data));
  const got = (await dee.get(`/envelopes/${t.id}`)).data.envelope;
  assert.equal(got.starter_note, 'A starting point written by GrowSigning, not legal advice. Not reviewed by a lawyer.');
  // A reviewed starter would say who reviewed it, for which country.
  assert.equal(lib.starterNote({ reviewedBy: 'A. Lawyer', place: 'Kenya' }), 'A starting point written by GrowSigning, not legal advice. Reviewed by A. Lawyer for Kenya.');
});

test('6. repair: brand words and our own name are refused in plain words, the preview never prints them, a copy keeps its note', async () => {
  const eve = await signUp('Eve Ndlovu', 'eve@starters.test', '198.51.100.35');
  const count = () => S.db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='template'").n;
  const before = count();
  // The refusal says what happened, then what to do.
  const paypal = await eve.post('/starters/gift/use', { organisation: 'PayPal Billing' });
  assert.equal(paypal.status, 400);
  assert.equal(paypal.data.error, '"PayPal Billing" reads like the name of PayPal, so nothing was made. Write the name of your own organisation.');
  // A document headed with our own name, old or new, reads as if it came from us.
  for (const name of ['GrowSigning', 'GrowSigning Support', 'Grow Signing Team', 'G r o w s i g n i n g', 'Sign' + '&Grow', 'Sign and ' + 'Grow Billing', 'GrowSigner']) {
    const r = await eve.post('/starters/volunteer/use', { organisation: name });
    assert.equal(r.status, 400, name);
    assert.equal(r.data.code, 'poses_as', name);
    assert.match(r.data.error, /reads like the name of GrowSigning, so nothing was made\. Write the name of your own organisation\./, name);
  }
  // Also as a partner or event name, not only the organisation.
  assert.equal((await eve.post('/starters/share-data/use', { organisation: 'Riverside Trust', partner: 'GrowSigning Data Team', data: 'names', purpose: 'reports' })).status, 400);
  assert.equal(count(), before, 'nothing was made');
  // Ordinary names that hold the same letters elsewhere are not refused.
  assert.equal(render.posesLike('Grow Together Signing Club'), null);
  assert.equal(render.posesLike('Evergreen Growers'), null);
  // The preview prints a brand-like word as its label in brackets, so it is no way to get a branded PDF.
  const gift = lib.starterById('gift')!;
  for (const org of ['PayPal Billing', 'GrowSigning Support']) {
    const v = render.previewValues(gift, new URLSearchParams({ organisation: org }));
    assert.equal(v.organisation, '');
    const r = await render.renderStarter(gift, v);
    assert.ok(!/paypal|growsigning support/i.test(r.text), r.text.slice(0, 200));
    const pv = await eve.get(`/starters/gift/preview?organisation=${encodeURIComponent(org)}`);
    assert.equal(pv.status, 200);
  }
  assert.equal(render.previewValues(gift, new URLSearchParams({ organisation: 'Ndlovu Gardens' })).organisation, 'Ndlovu Gardens');
  // A copy of a template made from a starter keeps the note and where it came from; a document sent from it does not.
  const t = (await eve.post('/starters/photos/use', { organisation: 'Ndlovu Arts' })).data.template;
  const copy = await eve.post(`/envelopes/${t.id}/clone`, { kind: 'template' });
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  const cid = S.db.get("SELECT id FROM envelopes WHERE kind='template' AND id<>? AND account_id=(SELECT account_id FROM envelopes WHERE id=?) ORDER BY created_at DESC, rowid DESC LIMIT 1", t.id, t.id).id;
  const c = (await eve.get(`/envelopes/${cid}`)).data.envelope;
  assert.equal(c.starter_note, t.starter_note);
  assert.equal(c.starter_id, 'photos');
  const sent = await eve.post('/envelopes', { template_id: cid, recipients: { [c.recipients[0].id]: { name: 'Sam Ito', email: 'sam@example.com' } }, send: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(S.db.get('SELECT starter_note FROM envelopes WHERE id=?', sent.data.envelope.id).starter_note, null);
});

test('7. repair: the list does not lengthen the way to Use a template, has one filled button, and says its note once', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../src/app/app/templates/page.tsx', import.meta.url), 'utf8');
  // The same page with its English put back: it asks the catalogue for its words since lang-sender-rest (tests/words.ts).
  const pageEn = readEnglish('src/app/app/templates/page.tsx');
  const comp = fs.readFileSync(new URL('../src/components/templates/Starters.tsx', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/app/styles/starters.css', import.meta.url), 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  // With templates, the header has only New template: the link shows under "Nothing matches" and in the empty list.
  const head = page.slice(page.indexOf('className="rmt-headbtns"'), page.indexOf('sn-newtpl'));
  assert.ok(!head.includes('StartersLink'), 'no ready-made link in the header');
  assert.match(pageEn.slice(pageEn.indexOf('<h3>Nothing matches</h3>'), pageEn.indexOf('<h3>Nothing matches</h3>') + 900), /StartersLink/);
  // While the list is open on an empty account, no second "No templates yet" card with its own filled button.
  assert.match(page, /rows\.length === 0 && ready \?[\s\S]{0,300}starters\.or_own/);
  // Row buttons are secondary: the only filled one is Make the template.
  assert.equal((comp.match(/btn[^"'`]*primary/g) || []).length, 1, 'one primary button in the list');
  assert.match(comp, /className="btn primary" disabled=\{busy\}>\{busy \? t\(ui, 'starters\.making'\)/);
  // Every target is at least 44 px, the "Open it" link too.
  assert.match(css, /\.rmt-made a \{ min-height: 44px; display: inline-flex/);
  // The lead promises nothing the editor cannot do: the wording stays, the fields can change.
  assert.ok(!/change, use/.test(en['starters.lead']));
  assert.match(en['starters.lead'], /wording stays as written/);
  assert.equal(en['starters.place_none'], 'Not written for any one country.');
});
