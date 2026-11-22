// For developers: fields placed by anchor text and {{tags}} through the API, signing inside a registered website,
// and the sender's screen inside an app (research/docusign-gaps.json, batch "dev-api").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, signUp, simple, tokenFor, upload, Client, PNG, type Server } from './helpers.ts';

let s: Server;
const ready = boot().then((x) => (s = x));

// A page of 612 x 792 points. pdf-lib draws from the bottom left; the API answers from the top left.
async function taggedPdf(lines: { text: string; x: number; y: number }[][]) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const page of lines) {
    const p = d.addPage([612, 792]);
    for (const l of page) p.drawText(l.text, { x: l.x, y: l.y, size: 12, font });
  }
  return d.save();
}
async function uploadPdf(c: Client, bytes: Uint8Array) {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type: 'application/pdf' }), 'Contract.pdf');
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const twoSentences = (msg: string) => {
  // P10: what happened, then what to do (a sentence that starts with a verb, or says what was not done).
  assert.ok(!/—/.test(msg), `no em dash: ${msg}`);
  assert.ok(msg.split(/(?<=\.)\s+/).length >= 2, `two sentences at least: ${msg}`);
};

test('anchor text places fields with offsets, and says what it did not find', async () => {
  await ready;
  const c = await signUp('Ana Anchor', 'ana-anchor@example.com', '198.51.100.11');
  const file = await uploadPdf(c, await taggedPdf([
    [{ text: 'Client signature:', x: 72, y: 600 }, { text: 'Initial here', x: 72, y: 400 }],
    [{ text: 'Initial here', x: 300, y: 500 }],
  ]));
  const r = await c.post('/envelopes', {
    subject: 'Anchored',
    documents: [{ id: 'd1', file_id: file.id }],
    recipients: [{ id: 'r1', name: 'Pat Client', email: 'pat@example.com' }],
    fields: [
      { id: 'sig', document_id: 'd1', recipient_id: 'r1', type: 'signature', anchor: { text: 'client   SIGNATURE:', offset_x: 0, offset_y: 20, units: 'pt' } },
      { id: 'ini', recipient_id: 'r1', type: 'initials', anchor: { text: 'Initial here', occurrence: 'all', offset_x: 80 } },
      { id: 'second', recipient_id: 'r1', type: 'text', anchor: { text: 'Initial here', occurrence: 2 } },
      { id: 'gone', recipient_id: 'r1', type: 'text', anchor: { text: 'Witness name' } },
      { id: 'f9', document_id: 'd1', recipient_id: 'r1', type: 'date_signed', page: 0, x: 0.6, y: 0.1, w: 0.2, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = r.data.anchors;
  // Stored fields get ids of their own; "placed" answers with the ids the request used.
  const where = (id: string) => a.placed.find((p: any) => p.id === id);
  const byId = (id: string) => { const p = where(id); return p && r.data.envelope.fields.find((f: any) => f.page === p.page && Math.abs(f.x - p.x) < 1e-6 && Math.abs(f.y - p.y) < 1e-6 && f.type === p.type); };
  // "Client signature:" sits on the baseline y = 792 - 600 = 192 from the top; its box starts a little above it.
  const sig = byId('sig');
  assert.equal(sig.page, 0);
  assert.ok(Math.abs(sig.x - 72 / 612) < 0.005, `x ${sig.x}`);
  const top = (192 - 0.8 * 12 + 20) / 792;
  assert.ok(Math.abs(sig.y - top) < 0.01, `y ${sig.y} near ${top}`);
  assert.ok(Math.abs(sig.w - 150 / 612) < 0.002 && Math.abs(sig.h - 36 / 792) < 0.002, 'the default size of a signature, in points');
  // "all": one field on each page where the words are, the second id numbered.
  const ini = r.data.envelope.fields.filter((f: any) => f.type === 'initials').sort((p: any, q: any) => p.page - q.page);
  assert.equal(ini.length, 2);
  assert.deepEqual(ini.map((f: any) => f.page), [0, 1]);
  assert.ok(Math.abs(ini[1].x - (300 + 80) / 612) < 0.005, 'offset_x moves it to the right');
  assert.deepEqual(a.placed.filter((p: any) => p.type === 'initials').map((p: any) => p.id).sort(), ['ini', 'ini_2']);
  // A number picks one place, counted in reading order over all documents and pages.
  assert.equal(byId('second').page, 1);
  // An ordinary field is untouched, and a missing anchor places nothing and is named.
  assert.ok(r.data.envelope.fields.some((f: any) => f.type === 'date_signed' && f.x === 0.6));
  assert.equal(r.data.envelope.fields.length, 5);
  assert.equal(byId('gone'), undefined);
  assert.equal(a.not_found.length, 1);
  assert.equal(a.not_found[0].text, 'Witness name');
  assert.match(a.not_found[0].why, /not written in/);
  assert.equal(a.placed.filter((p: any) => p.by === 'anchor').length, 4);

  // With "send": true a missing anchor sends nothing and leaves no draft behind.
  const before = s.db.get('SELECT COUNT(*) n FROM envelopes').n;
  const no = await c.post('/envelopes', {
    send: true, subject: 'Anchored and sent',
    documents: [{ id: 'd1', file_id: file.id }],
    recipients: [{ id: 'r1', name: 'Pat Client', email: 'pat@example.com' }],
    fields: [{ recipient_id: 'r1', type: 'signature', anchor: { text: 'Notary seal' } }],
  });
  assert.equal(no.status, 400);
  assert.equal(no.data.code, 'anchor_not_found');
  assert.match(no.data.error, /^Nothing was sent/);
  twoSentences(no.data.error);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM envelopes').n, before);
  assert.equal(s.db.get("SELECT COUNT(*) n FROM emails WHERE to_email='pat@example.com'").n, 0);
});

test('auto_tags places {{tags}} for the signer each one names', async () => {
  await ready;
  const c = await signUp('Tia Tags', 'tia-tags@example.com', '198.51.100.12');
  const file = await uploadPdf(c, await taggedPdf([[
    { text: 'Buyer: {{signature}}', x: 72, y: 600 },
    { text: 'Seller: {{signature2}}  {{date2}}', x: 72, y: 500 },
    { text: 'Agent: {{signature3}}', x: 72, y: 400 },
  ]]));
  const r = await c.post('/envelopes', {
    auto_tags: true, subject: 'Tagged',
    documents: [{ file_id: file.id }],
    recipients: [
      { name: 'Copy Person', email: 'copy@example.com', role: 'cc' },
      { id: 'buyer', name: 'Bo Buyer', email: 'bo@example.com' },
      { id: 'seller', name: 'Sy Seller', email: 'sy@example.com', routing_order: 2 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.envelope.fields;
  const rid = (name: string) => r.data.envelope.recipients.find((x: any) => x.name === name).id;
  assert.equal(f.filter((x: any) => x.type === 'signature' && x.recipient_id === rid('Bo Buyer')).length, 1);
  assert.equal(f.filter((x: any) => x.recipient_id === rid('Sy Seller')).length, 2);
  assert.ok(f.some((x: any) => x.type === 'date_signed' && x.recipient_id === rid('Sy Seller')));
  // A cc is nobody's tag, and a tag for a third signer the request does not have is named.
  assert.equal(r.data.anchors.not_found.length, 1);
  assert.equal(r.data.anchors.not_found[0].text, '{{signature3}}');
  assert.match(r.data.anchors.not_found[0].why, /signer 3/);

  // A tag under a field that is already there gets no second one.
  const again = await c.post('/envelopes', {
    auto_tags: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'b', name: 'Bo Buyer', email: 'bo@example.com' }, { id: 's', name: 'Sy Seller', email: 'sy@example.com' }],
    fields: r.data.envelope.fields.filter((x: any) => x.type === 'signature').slice(0, 1).map((x: any) => ({ ...x, id: undefined, document_id: 'd', recipient_id: 'b' })),
  });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.envelope.fields.filter((x: any) => x.type === 'signature').length, 2);

  // A template takes them too, and PUT on a draft finds them in the saved document.
  const tpl = await c.post('/envelopes', { kind: 'template', auto_tags: true, documents: [{ file_id: file.id }], recipients: [{ role_name: 'Buyer', name: 'Buyer' }] });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  assert.ok(tpl.data.envelope.fields.some((x: any) => x.type === 'signature'));
  const d = await c.post('/envelopes', { documents: [{ id: 'x', file_id: file.id }], recipients: [{ id: 'p', name: 'Bo Buyer', email: 'bo@example.com' }] });
  const put = await c.put(`/envelopes/${d.data.envelope.id}`, { auto_tags: true });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.envelope.fields.filter((x: any) => x.type === 'signature').length, 1);
});

test('anchors that cannot be read are refused in plain words', async () => {
  await ready;
  const c = await signUp('Rae Refused', 'rae-refused@example.com', '198.51.100.13');
  const file = await uploadPdf(c, await taggedPdf([[{ text: 'Sign:', x: 72, y: 600 }]]));
  const base = { documents: [{ id: 'd1', file_id: file.id }], recipients: [{ id: 'r1', name: 'Pat', email: 'pat@example.com' }] };
  for (const [anchor, said] of [
    [{ text: '' }, /empty/],
    [{ text: 'x'.repeat(101) }, /longer than 100/],
    [{ text: 'Sign:', units: 'px' }, /only be "pt"/],
    [{ text: 'Sign:', occurrence: 0 }, /occurrence/],
    [{ text: 'Sign:', offset_x: 99999 }, /offset_x/],
    ['Sign:', /object/],
  ] as const) {
    const r = await c.post('/envelopes', { ...base, fields: [{ recipient_id: 'r1', type: 'signature', anchor }] });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, said);
    assert.match(r.data.error, /Nothing was saved\.$/);
    twoSentences(r.data.error);
  }
  const t = await c.post('/envelopes', { ...base, auto_tags: 'yes' });
  assert.equal(t.status, 400);
  twoSentences(t.data.error);
  // Somebody else's file is not read: the anchor is simply not found there.
  const other = await signUp('Oz Other', 'oz-other@example.com', '198.51.100.14');
  const theirs = await other.post('/envelopes', { ...base, fields: [{ recipient_id: 'r1', type: 'signature', anchor: { text: 'Sign:' } }] });
  assert.notEqual(theirs.status, 200);
  assert.equal(s.db.get("SELECT COUNT(*) n FROM envelopes WHERE account_id=(SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='oz-other@example.com')").n, 0);
});

// ---- 2. Signing inside a website ---------------------------------------------------------------------------------

const SITE = 'https://portal.example.org';
const withBearer = (t: string) => {
  const c = new Client();
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${t}`, ...h });
  return c;
};

test('an admin lists up to 5 https websites, in plain words', async () => {
  await ready;
  const c = await signUp('Owen Owner', 'owen-embed@example.com', '198.51.100.21');
  assert.deepEqual((await c.get('/account/embed-origins')).data, { origins: [], max: 5, not_used: [] });
  for (const [bad, said] of [['http://portal.example.org', /https:\/\//], ['https://*.example.org', /star/], ['*', /star/], ['not a site', /not a website address/], ['', /Type the address/]] as const) {
    const r = await c.post('/account/embed-origins', { origin: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.data.error, said);
    twoSentences(r.data.error);
  }
  // Written the way a browser compares it: no slash at the end, small letters. The address of a page is cut to its
  // website, and adding a website that is listed changes nothing.
  assert.deepEqual((await c.post('/account/embed-origins', { origin: 'HTTPS://Portal.Example.org/' })).data.origins, [SITE]);
  assert.deepEqual((await c.post('/account/embed-origins', { origin: 'https://portal.example.org/sign' })).data.origins, [SITE]);
  for (let i = 2; i <= 5; i++) assert.equal((await c.post('/account/embed-origins', { origin: `https://site${i}.example.org` })).status, 200);
  const sixth = await c.post('/account/embed-origins', { origin: 'https://six.example.org' });
  assert.equal(sixth.status, 400);
  assert.match(sixth.data.error, /up to 5/);
  twoSentences(sixth.data.error);
  assert.equal((await c.call('DELETE', `/account/embed-origins?origin=${encodeURIComponent('https://site5.example.org')}`)).data.origins.length, 4);
  // The security record has each change.
  assert.ok(s.db.all("SELECT details FROM security_events WHERE kind='settings.changed'").some((x: any) => /embed_origins/.test(x.details)));
  // A member cannot see or change the list.
  const acct = s.db.get("SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='owen-embed@example.com'").account_id;
  const m = await signUp('Mia Member', 'mia-embed@example.com', '198.51.100.22');
  const mid = s.db.get("SELECT id FROM users WHERE email='mia-embed@example.com'").id;
  s.db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", acct, mid, new Date().toISOString());
  s.db.run('UPDATE sessions SET account_id=? WHERE user_id=?', acct, mid);
  assert.equal((await m.get('/account/embed-origins')).status, 403);
  assert.equal((await m.post('/account/embed-origins', { origin: 'https://mine.example.org' })).status, 403);
});

test('a signing link for a frame: framed by that website only, the page tells only it, and the record says so', async () => {
  await ready;
  const { frameAncestors } = await import('../src/server/embed.ts');
  const c = await signUp('Fay Frame', 'fay-frame@example.com', '198.51.100.23');
  await c.post('/account/embed-origins', { origin: SITE });
  await c.post('/account/embed-origins', { origin: 'https://other.example.org' });
  const e = await simple(c, 'sid-signer@example.com', { send: true });
  const rid = e.recipients[0].id;
  // A website that is not listed is refused, and nothing is handed out for it.
  const no = await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid, frame_origin: 'https://evil.example.net' });
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'origin_not_listed');
  twoSentences(no.data.error);
  const r = await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid, frame_origin: SITE });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = new URL(r.data.url);
  assert.equal(u.searchParams.get('embed'), '1');
  assert.equal(u.searchParams.get('origin'), SITE);
  const tok = tokenFor(e.id, 'sid-signer@example.com');
  assert.equal(frameAncestors(u.pathname, u.searchParams), `frame-ancestors ${SITE}`);
  // The same link, but another website of the account it was not handed out for: our own pages only.
  assert.equal(frameAncestors(`/sign/${tok}`, new URLSearchParams({ embed: '1', origin: 'https://other.example.org' })), "frame-ancestors 'self'");
  // Without ?embed=1, or for a link nobody asked a frame for, or a made-up token: our own pages only. Never "*".
  assert.equal(frameAncestors(`/sign/${tok}`, new URLSearchParams()), "frame-ancestors 'self'");
  assert.equal(frameAncestors('/sign/abcdefghijklmnop', new URLSearchParams({ embed: '1', origin: SITE })), "frame-ancestors 'self'");
  assert.equal(frameAncestors('/app/settings', new URLSearchParams()), null);
  for (const p of [u.pathname, `/sign/${tok}`]) assert.ok(!/\*/.test(frameAncestors(p, u.searchParams) || ''));

  // Finish inside the frame: one audit line names the website, printed with the rest of the record.
  const signer = new Client();
  signer.ip = '198.51.100.24';
  await signer.post(`/sign/${tok}/consent`);
  const v = (await signer.get(`/sign/${tok}`)).data;
  const values = Object.fromEntries(v.fields.map((f: any) => [f.id, '1']));
  const done = await signer.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG, frame_origin: SITE });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const lines = s.db.all('SELECT action FROM audit WHERE envelope_id=? ORDER BY seq', e.id).map((x: any) => x.action);
  assert.ok(lines.includes(`Signed inside a frame on ${SITE}`), lines.join(' | '));
  assert.ok(lines.includes('Envelope completed') && lines.indexOf(`Signed inside a frame on ${SITE}`) < lines.indexOf('Envelope completed'), 'before the envelope closes, so the certificate has it');

  // A page that only says it was in a frame, for a link that was never made for one, adds nothing.
  const e2 = await simple(c, 'sue-signer@example.com', { send: true });
  const tok2 = tokenFor(e2.id, 'sue-signer@example.com');
  const s2 = new Client();
  s2.ip = '198.51.100.25';
  await s2.post(`/sign/${tok2}/consent`);
  const v2 = (await s2.get(`/sign/${tok2}`)).data;
  await s2.post(`/sign/${tok2}/complete`, { values: Object.fromEntries(v2.fields.map((f: any) => [f.id, '1'])), signature_png: PNG, initials_png: PNG, frame_origin: SITE });
  assert.ok(!s.db.all('SELECT action FROM audit WHERE envelope_id=?', e2.id).some((x: any) => /inside a frame/.test(x.action)));

  // Removing the website stops the framing of links already handed out for it.
  await c.call('DELETE', `/account/embed-origins?origin=${encodeURIComponent(SITE)}`);
  assert.equal(frameAncestors(u.pathname, u.searchParams), "frame-ancestors 'self'");
});

test('the signing page posts its news to the website around it, and to nobody else', async () => {
  const { tellFrame, frameBody } = await import('../src/components/sign/frame.ts');
  const sent: any[] = [];
  const g = globalThis as any;
  const before = g.window;
  try {
    const parent = { postMessage: (msg: any, target: string) => sent.push([msg, target]) };
    g.window = { parent, location: { search: `?embed=1&origin=${encodeURIComponent(SITE)}` } };
    tellFrame('signing_complete');
    tellFrame('declined');
    tellFrame('saved');
    assert.deepEqual(sent, [[{ source: 'growsigning', event: 'signing_complete' }, SITE], [{ source: 'growsigning', event: 'declined' }, SITE], [{ source: 'growsigning', event: 'saved' }, SITE]]);
    assert.deepEqual(frameBody(), { frame_origin: SITE });
    // Not in a frame, no ?embed=1, or an origin that is not a website: nothing is posted, and "*" never.
    sent.length = 0;
    g.window = { location: { search: `?embed=1&origin=${encodeURIComponent(SITE)}` } };
    g.window.parent = g.window;
    tellFrame('signing_complete');
    g.window = { parent, location: { search: '' } };
    tellFrame('signing_complete');
    g.window = { parent, location: { search: '?embed=1&origin=*' } };
    tellFrame('signing_complete');
    assert.deepEqual(sent, []);
    assert.deepEqual(frameBody(), {});
  } finally {
    g.window = before;
  }
});

// ---- 3. The sender screen inside an app ----------------------------------------------------------------------------

test('the sender screen: one draft, one opening within 5 minutes, framed by its website only', async () => {
  await ready;
  const { frameAncestors } = await import('../src/server/embed.ts');
  const c = await signUp('Sal Sender', 'sal-screen@example.com', '198.51.100.31');
  await c.post('/account/embed-origins', { origin: SITE });
  const file = await upload(c, 1);
  const d = (await c.post('/envelopes', {
    subject: 'From the portal', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', name: 'Rob Reader', email: 'rob-screen@example.com' }],
    fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  const other = (await c.post('/envelopes', { subject: 'Another draft' })).data.envelope;

  // The return address has to be on a listed website.
  const off = await c.post(`/envelopes/${d.id}/sender-view`, { return_url: 'https://evil.example.net/done' });
  assert.equal(off.status, 403);
  twoSentences(off.data.error);
  const none = await c.post(`/envelopes/${d.id}/sender-view`, {});
  assert.equal(none.status, 400);
  twoSentences(none.data.error);

  const made = await c.post(`/envelopes/${d.id}/sender-view`, { return_url: `${SITE}/done?order=42` });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const link = new URL(made.data.url);
  assert.match(link.pathname, /^\/embed\/send\/[A-Za-z0-9_-]{40,}$/);
  assert.ok(Date.parse(made.data.expires_at) - Date.now() <= 5 * 60_000 + 1000);
  const ticket = link.pathname.split('/').pop()!;
  assert.equal(frameAncestors(link.pathname, new URLSearchParams()), `frame-ancestors ${SITE}`);
  assert.equal(frameAncestors('/embed/send/madeup', new URLSearchParams()), "frame-ancestors 'none'");

  // It opens once.
  const visitor = new Client();
  visitor.ip = '198.51.100.32';
  const open = await visitor.post('/embed/sender/open', { ticket });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  assert.equal(open.data.envelope_id, d.id);
  assert.equal(open.data.origin, SITE);
  assert.match(open.data.session, /^tse_/);
  const again = await visitor.post('/embed/sender/open', { ticket });
  assert.equal(again.status, 410);
  assert.equal(again.data.code, 'sender_view_used');
  twoSentences(again.data.error);

  // After 5 minutes a link that was never opened does not open either.
  const late = new URL((await c.post(`/envelopes/${d.id}/sender-view`, { return_url: `${SITE}/done` })).data.url).pathname.split('/').pop()!;
  const { sha256 } = await import('../src/server/util.ts');
  s.db.run('UPDATE sender_views SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), sha256(late));
  assert.equal((await visitor.post('/embed/sender/open', { ticket: late })).status, 410);

  // The session reaches its draft, as the editor does, and nothing else.
  const screen = withBearer(open.data.session);
  assert.equal((await screen.get('/me')).status, 200);
  assert.equal((await screen.get(`/envelopes/${d.id}`)).status, 200);
  const put = await screen.put(`/envelopes/${d.id}`, { subject: 'From the portal, checked' });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  for (const [m, u] of [['GET', '/envelopes'], ['GET', `/envelopes/${other.id}`], ['PUT', `/envelopes/${other.id}`], ['GET', '/api-keys'], ['POST', '/webhooks'], ['GET', '/account/embed-origins'], ['POST', `/envelopes/${d.id}/sender-view`], ['GET', `/files/${file.id}/content`]] as const) {
    const r = await screen.call(m, u, m === 'GET' ? undefined : {});
    if (u === `/files/${file.id}/content`) {
      assert.equal(r.status, 200, 'a file of its own draft opens');
      continue;
    }
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.data.code, 'sender_view_scope');
    twoSentences(r.data.error);
  }

  // Sending works, and the screen ends with it on the server: every later call is refused, the page goes back to
  // the return_url it already holds, and the website can no longer frame the screen.
  const sent = await screen.post(`/envelopes/${d.id}/send`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(s.db.get('SELECT ended_at FROM sender_views WHERE id=?', sha256(ticket)).ended_at, 'ended on the server');
  // GET /me is open to anyone and answers that nobody is signed in.
  assert.equal((await screen.get('/me')).data.user, null);
  for (const [m, u] of [['PUT', `/envelopes/${d.id}`], ['GET', '/contacts'], ['GET', '/groups'], ['GET', `/envelopes/${d.id}`], ['POST', '/embed/sender/close']] as const) {
    const r = await screen.call(m, u, m === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${m} ${u} after sending`);
    assert.equal(r.data.code, 'sender_view_ended');
    twoSentences(r.data.error);
  }
  assert.equal(frameAncestors(link.pathname, new URLSearchParams()), "frame-ancestors 'none'");

  // A draft that has gone out already gets no screen.
  const no = await c.post(`/envelopes/${d.id}/sender-view`, { return_url: `${SITE}/done` });
  assert.equal(no.status, 409);
  twoSentences(no.data.error);
  // Only the person or key that may open the draft can make its screen.
  const stranger = await signUp('Stan Stranger', 'stan-screen@example.com', '198.51.100.33');
  assert.equal((await stranger.post(`/envelopes/${other.id}/sender-view`, { return_url: `${SITE}/done` })).status, 404);
});

// ---- Repairs after the skeptic and the simplicity review ----------------------------------------------------------

test('anchors: more than the most are refused before any document is read, and many anchors over a long document stay quick', async () => {
  await ready;
  const { ANCHOR_FIELDS_MAX } = await import('../src/lib/anchors.ts');
  const c = await signUp('Lou Load', 'lou-load@example.com', '198.51.100.41');
  const page = Array.from({ length: 45 }, (_, i) => ({ text: `Line ${i} with some words to read here`, x: 72, y: 740 - i * 14 }));
  const file = await uploadPdf(c, await taggedPdf(Array.from({ length: 40 }, () => page)));
  const body = (n: number) => ({
    subject: 'Many anchors', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', name: 'Rae Reader', email: 'rae-load@example.com' }],
    fields: Array.from({ length: n }, (_, i) => ({ recipient_id: 'r', type: 'text', anchor: { text: `zz unique ${i}` } })),
  });
  const before = s.db.get('SELECT COUNT(*) n FROM envelopes').n;
  let t = Date.now();
  const many = await c.post('/envelopes', body(ANCHOR_FIELDS_MAX + 1));
  assert.equal(many.status, 400);
  assert.equal(many.data.code, 'too_many_anchors');
  twoSentences(many.data.error);
  assert.match(many.data.error, /Nothing was saved/);
  assert.ok(Date.now() - t < 1500, `refused at once, took ${Date.now() - t} ms`);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM envelopes').n, before);
  // The most there may be, none of them found, over 40 pages of 45 lines: the lines of a page are read once.
  t = Date.now();
  const most = await c.post('/envelopes', body(ANCHOR_FIELDS_MAX));
  const took = Date.now() - t;
  assert.equal(most.status, 200, JSON.stringify(most.data).slice(0, 300));
  assert.equal(most.data.anchors.not_found.length, ANCHOR_FIELDS_MAX);
  assert.ok(took < 8000, `${ANCHOR_FIELDS_MAX} anchors over 40 pages took ${took} ms`);
});

test('findText reads each page once and finds the same places every time', async () => {
  const { findText } = await import('../src/lib/anchors.ts');
  const page = { size: { w: 612, h: 792 }, items: [{ str: 'Sign  here please', x: 72, y: 100, w: 120, h: 12 }, { str: 'and Sign here', x: 72, y: 200, w: 90, h: 12 }] } as any;
  const one = findText(page, 'sign here');
  assert.equal(one.length, 2);
  assert.deepEqual(findText(page, 'SIGN HERE'), one);
  assert.deepEqual(findText(page, 'nowhere'), []);
  // Characters a regular expression would read as rules are read as plain text.
  assert.deepEqual(findText(page, 'sign.*'), []);
});

test('anchors or auto_tags with template_id are refused in words instead of being dropped', async () => {
  await ready;
  const c = await signUp('Tom Template', 'tom-anchor-tpl@example.com', '198.51.100.42');
  const file = await uploadPdf(c, await taggedPdf([[{ text: 'Client signature:', x: 72, y: 600 }]]));
  const tpl = (await c.post('/envelopes', {
    kind: 'template', subject: 'Order form', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }],
    fields: [{ recipient_id: 'r', type: 'signature', anchor: { text: 'Client signature:' } }],
  })).data;
  assert.ok(tpl.envelope?.id, JSON.stringify(tpl));
  assert.equal(tpl.envelope.fields.length, 1, 'a template made with an anchor gets its field');
  const before = s.db.get('SELECT COUNT(*) n FROM envelopes').n;
  for (const extra of [{ fields: [{ type: 'text', anchor: { text: 'Client signature:' } }] }, { auto_tags: true }]) {
    const r = await c.post('/envelopes', { template_id: tpl.envelope.id, recipients: [{ name: 'Cy Client', email: 'cy-tpl@example.com' }], ...extra });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.code, 'anchors_with_template');
    assert.match(r.data.error, /PUT \/envelopes\/\{id\}/);
    twoSentences(r.data.error);
  }
  assert.equal(s.db.get('SELECT COUNT(*) n FROM envelopes').n, before);
});

test('no signing link for a frame for someone with an access code or a one-time code', async () => {
  await ready;
  const c = await signUp('Cora Code', 'cora-code@example.com', '198.51.100.43');
  await c.post('/account/embed-origins', { origin: SITE });
  for (const [col, value] of [['access_code', 'blue-river'], ['verify', 'email_code']] as const) {
    const e = await simple(c, `code-${col}@example.com`, { send: true });
    const rid = e.recipients[0].id;
    s.db.run(`UPDATE recipients SET ${col}=? WHERE id=?`, value, rid);
    const r = await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid, frame_origin: SITE });
    assert.equal(r.status, 400, `${col}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'frame_with_code');
    twoSentences(r.data.error);
    assert.equal(s.db.get('SELECT COUNT(*) n FROM embed_views WHERE recipient_id=?', rid).n, 0, 'nothing handed out for the frame');
    // The ordinary link, for its own tab, still works.
    const plain = await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid });
    assert.equal(plain.status, 200);
    assert.ok(!/embed=1/.test(plain.data.url));
  }
});

test('the signing page says to open its own tab when a frame forgets a right access code', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../src/app/sign/[token]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /await api\(`\$\{base\}\/unlock`, \{ body: \{ code \} \}\);\s*if \(await codeForgottenInFrame\(base\)\) return setFormError\(FRAME_CODE_LOST\);/);
  assert.match(page, /formError === FRAME_CODE_LOST && <OwnTabLink \/>/);
  const { FRAME_CODE_LOST, FRAME_NO_CODES } = await import('../src/lib/embed.ts');
  twoSentences(FRAME_CODE_LOST);
  twoSentences(FRAME_NO_CODES);
  // Outside a frame nothing is asked again: the check only runs inside one.
  const { codeForgottenInFrame } = await import('../src/components/sign/FrameTab.tsx').catch(() => ({ codeForgottenInFrame: null as any }));
  if (codeForgottenInFrame) {
    const g = globalThis as any;
    const before = g.window;
    try {
      g.window = { location: { search: '' } };
      g.window.parent = g.window;
      assert.equal(await codeForgottenInFrame('/sign/x'), false);
    } finally {
      g.window = before;
    }
  }
});

test('the sender screen reads back only its own uploads, and the editor never leaves the frame on a problem', async () => {
  await ready;
  const c = await signUp('Una Upload', 'una-upload@example.com', '198.51.100.44');
  await c.post('/account/embed-origins', { origin: SITE });
  const d = (await c.post('/envelopes', { subject: 'Portal draft' })).data.envelope;
  const ticket = new URL((await c.post(`/envelopes/${d.id}/sender-view`, { return_url: `${SITE}/done` })).data.url).pathname.split('/').pop()!;
  const visitor = new Client();
  visitor.ip = '198.51.100.45';
  const screen = withBearer((await visitor.post('/embed/sender/open', { ticket })).data.session);
  // A colleague's upload after the screen opened: not the screen's to read, even with its id.
  const theirs = await upload(c, 1);
  const no = await screen.get(`/files/${theirs.id}/content`);
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'sender_view_scope');
  // Its own upload it can read back, as the editor does to show it.
  const f = new FormData();
  f.append('file', new Blob([await taggedPdf([[{ text: 'Hello', x: 72, y: 600 }]])], { type: 'application/pdf' }), 'Mine.pdf');
  const mine = await screen.call('POST', '/files', f);
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal((await screen.get(`/files/${mine.data.id}/content`)).status, 200);
  // Closing ends it, and then not even its own file opens.
  assert.equal((await screen.post('/embed/sender/close', {})).data.event, 'closed');
  assert.equal((await screen.get(`/files/${mine.data.id}/content`)).status, 401);

  const fs = await import('node:fs');
  const editor = fs.readFileSync(new URL('../src/components/Editor.tsx', import.meta.url), 'utf8');
  // Every way out of the editor on load goes through onProblem first inside a customer's app.
  const loads = editor.slice(editor.indexOf('api(`/envelopes/${id}`).then'), editor.indexOf("api('/contacts')"));
  assert.equal((loads.match(/router\.replace\(/g) || []).length, 3);
  assert.equal((loads.match(/if \(embedded\?\.onProblem\) return embedded\.onProblem\(said\);/g) || []).length, 3);
});

test('Settings reads a typed website kindly, and a website on this computer only on a server on this computer', async () => {
  await ready;
  const { readTypedOrigin } = await import('../src/lib/embed.ts');
  assert.deepEqual(readTypedOrigin('portal.example.org'), { origin: 'https://portal.example.org' });
  assert.deepEqual(readTypedOrigin('  Portal.Example.org/  '), { origin: 'https://portal.example.org' });
  const page = readTypedOrigin('https://portal.example.org/orders/42?x=1');
  assert.deepEqual(page, { origin: 'https://portal.example.org', note: 'Added https://portal.example.org, the website without the page.' });
  for (const bad of ['http://portal.example.org', '*.example.org', 'https://a:b@portal.example.org/', 'not a website', '']) assert.ok('why' in readTypedOrigin(bad), bad);

  const c = await signUp('Lia Local', 'lia-local@example.com', '198.51.100.46');
  const typed = await c.post('/account/embed-origins', { origin: 'shop.example.org/checkout' });
  assert.equal(typed.status, 200, JSON.stringify(typed.data));
  assert.deepEqual(typed.data.origins, ['https://shop.example.org']);
  const was = process.env.APP_URL;
  try {
    process.env.APP_URL = 'https://sign.example.org';
    const local = await c.post('/account/embed-origins', { origin: 'http://localhost:3000' });
    assert.equal(local.status, 400);
    assert.match(local.data.error, /your own computer/);
    twoSentences(local.data.error);
    process.env.APP_URL = 'http://localhost:4153';
    assert.equal((await c.post('/account/embed-origins', { origin: 'http://localhost:3000' })).status, 200);
  } finally {
    if (was === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = was;
  }

  // The card: focus stays on the list after Remove, what happened is said aloud, a second add says nothing changed.
  const fs = await import('node:fs');
  const card = fs.readFileSync(new URL('../src/components/settings/EmbedSites.tsx', import.meta.url), 'utf8');
  assert.match(card, /role="status" aria-live="polite"/);
  assert.match(card, /is already listed\. Nothing changed\./);
  assert.match(card, /\(next \|\| box\.current\)\?\.focus\(\)/);
});
