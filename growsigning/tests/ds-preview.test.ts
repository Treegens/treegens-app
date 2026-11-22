// "See what each person sees" (src/server/preview.ts, routes-preview.ts): a preview shows the person's own view and
// changes nothing anywhere, opens only for its maker in the browser it was made in, and ends after 15 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, draft, upload, tokenFor, PNG, type Server } from './helpers.ts';
import { t } from '../src/lib/i18n.ts';
import { PREVIEW_NOTHING } from '../src/lib/preview.ts';

let s: Server;
let ipN = 40;
const newIp = () => `198.51.100.${ipN++}`;
const tokenOf = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/sign\//, ''));

// Every row of every table, so a whole preview session can be shown to leave the database exactly as it was.
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name } of s.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[name] = JSON.stringify(s.db.all(`SELECT * FROM "${name}" ORDER BY rowid`));
  }
  return out;
}
function sameRows(before: Record<string, string>, after: Record<string, string>) {
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [], `tables changed by the preview: ${changed.join(', ')}`);
}

const withKey = (key: string) => {
  const c = new Client();
  c.ip = newIp();
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${key}`, ...h });
  return c;
};

test('boot', async () => {
  s = await boot();
});

test('a whole preview session of a draft changes not one row, and shows that person\'s own view', async () => {
  const sender = await signUp('Rosa Sender', 'rosa.preview@example.com', newIp());
  const env = await draft(sender);
  const [ada, ben, cee] = ['Ada Signer', 'Ben Signer', 'Cee Copy'].map((n) => env.recipients.find((r: any) => r.name === n));

  const before = snapshot();
  const made = await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.match(made.data.url, /^http:\/\/test\.local\/sign\/pv\./);
  assert.ok(Date.parse(made.data.expires_at) - Date.now() <= 15 * 60_000 + 1000);
  const tok = tokenOf(made.data.url);

  const v = await sender.get(`/preview/${tok}`);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(v.data.preview.person.name, 'Ada Signer');
  assert.equal(v.data.preview.kind, 'draft');
  assert.equal(v.data.preview.check, null);
  assert.equal(v.data.recipient.status, 'viewed', 'shown as on the day it is her turn, as the page shows it once open');
  assert.equal(v.data.recipient.consented, false, 'the consent screen comes first, as it will for her');
  assert.ok(v.data.language?.locale, 'the consent text is chosen in her language');
  assert.deepEqual(v.data.fields.map((f: any) => f.recipient_id).filter((x: string) => x !== ada.id), [], 'only her own fields');
  assert.equal(v.data.fields.length, 3);
  assert.equal(v.data.preview.people.length, 3, 'the person switch lists everyone');

  // Everything the page can press: consent and saving answer and write nothing; the rest is refused in plain words.
  assert.equal((await sender.post(`/preview/${tok}/consent`, { version: v.data.version })).status, 200);
  assert.equal((await sender.post(`/preview/${tok}/save`, { values: { f2: 'x' } })).status, 200);
  assert.deepEqual((await sender.post(`/preview/${tok}/print-check`, { values: {} })).data.problems, []);
  const doc = await sender.get(`/preview/${tok}/doc/${v.data.documents[0].id}`);
  assert.equal(doc.status, 200);
  assert.ok(doc.data instanceof Uint8Array && doc.data.length > 100);
  const copy = await sender.get(`/preview/${tok}/download?inline=1`);
  assert.equal(copy.status, 200, 'Download or print on the consent screen works in a preview too');
  assert.ok(copy.data instanceof Uint8Array && copy.data.length > 100);
  for (const path of ['complete', 'decline', 'reassign', 'name', 'mute', 'report', 'dispute', 'upload', 'request-extension', 'not-present', 'comments', 'stamp', 'witness', 'take-over', 'mail-again', 'pay-opened', 'summary']) {
    const r = await sender.post(`/preview/${tok}/${path}`, { values: {}, signature_png: PNG, reason: 'x', name: 'Someone Else', email: 'else@example.com' });
    assert.equal(r.status, 403, path);
    assert.equal(r.data.code, 'preview', path);
    assert.match(r.data.error, /preview, so nothing was signed, saved or sent/);
  }
  assert.equal((await sender.get(`/preview/${tok}/comments`)).data.code, 'preview');
  assert.equal((await sender.call('DELETE', `/preview/${tok}/stamp/f1`)).data.code, 'preview');

  // The person switch: Ben, behind an access code and after Ada; Cee, who only gets a copy.
  const benTok = v.data.preview.people.find((p: any) => p.id === ben.id).token;
  const vb = (await sender.get(`/preview/${benTok}`)).data;
  assert.equal(vb.preview.person.name, 'Ben Signer');
  assert.equal(vb.locked, false, 'the access code is described, not asked');
  assert.match(vb.preview.check, /access code on this document/);
  assert.doesNotMatch(vb.preview.check, /you set/, 'an admin may preview a member\'s envelope: the member set the code');
  assert.match(vb.preview.turn, /Ada Signer has finished/);
  assert.equal(vb.preview.expires_at, v.data.preview.expires_at, 'switching never makes a preview last longer');
  const ceeTok = v.data.preview.people.find((p: any) => p.id === cee.id).token;
  const vc = (await sender.get(`/preview/${ceeTok}`)).data;
  assert.equal(vc.recipient.role, 'cc');
  assert.equal(vc.recipient.status, 'completed', 'a copy is shown as the copy they get');
  // Someone who gets a copy is asked for nothing: no turn line, and the band says they do not sign.
  assert.equal(vc.preview.turn, null);
  assert.match(vc.preview.does, /copy to read; they do not sign/);
  assert.doesNotMatch(JSON.stringify(vc.preview), /once everyone has finished|They are asked/);

  sameRows(before, snapshot());
  assert.equal(s.db.get("SELECT COUNT(*) n FROM emails WHERE to_email IN ('ada@example.com','ben@example.com','cee@example.com')").n, 0);
});

test('every role can be previewed, and in person never locks the sender\'s browser', async () => {
  const sender = await signUp('Omar Roles', 'omar.preview@example.com', newIp());
  const file = await upload(sender, 1);
  const roles = ['signer', 'approver', 'viewer', 'cc', 'inperson', 'witness'];
  const r = await sender.post('/envelopes', {
    subject: 'Every role', documents: [{ id: 'd', file_id: file.id, name: 'Roles' }],
    recipients: roles.map((role, i) => ({ id: `p${i}`, role, name: `Person ${role}`, email: `${role}.roles@example.com`, routing_order: 1, ...(role === 'witness' ? { witness_for: 'p0' } : {}) })),
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'p0', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const env = r.data.envelope;
  const before = snapshot();
  for (const role of roles) {
    const who = env.recipients.find((x: any) => x.role === role);
    const made = await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: who.id });
    assert.equal(made.status, 200, `${role}: ${JSON.stringify(made.data)}`);
    const v = await sender.get(`/preview/${tokenOf(made.data.url)}`);
    assert.equal(v.status, 200, `${role}: ${JSON.stringify(v.data)}`);
    assert.equal(v.data.recipient.role, role);
    assert.equal(v.data.preview.person.role, role);
    assert.ok(v.data.preview.does, role);
  }
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE locked_at IS NOT NULL').n, 0);
  sameRows(before, snapshot());
  // The sender's own app still opens: the in-person preview handed nothing over.
  assert.equal((await sender.get('/me')).status, 200);
});

test('an envelope that is out: previewed without a view, a consent or a line in its record; a closed one says so', async () => {
  const sender = await signUp('Tess Out', 'tess.preview@example.com', newIp());
  const env = await draft(sender);
  assert.equal((await sender.post(`/envelopes/${env.id}/send`, {})).status, 200);
  const ada = env.recipients.find((r: any) => r.name === 'Ada Signer');
  const ben = env.recipients.find((r: any) => r.name === 'Ben Signer');
  const before = snapshot();
  const made = (await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ben.id })).data;
  const v = await sender.get(`/preview/${tokenOf(made.url)}`);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(v.data.preview.kind, 'envelope');
  assert.equal(v.data.recipient.status, 'viewed', 'Ben is still waiting for Ada, and is shown as when his turn comes');
  assert.ok(v.data.fields.length > 0);
  const adaMade = (await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id })).data;
  assert.equal((await sender.get(`/preview/${tokenOf(adaMade.url)}`)).status, 200);
  sameRows(before, snapshot());
  assert.equal(s.db.get('SELECT viewed_at FROM recipients WHERE id=?', ada.id).viewed_at, null);

  // Voided: nothing left to preview, from the link already made too.
  assert.equal((await sender.post(`/envelopes/${env.id}/void`, { reason: 'Wrong file' })).status, 200);
  const gone = await sender.get(`/preview/${tokenOf(made.url)}`);
  assert.equal(gone.status, 409);
  assert.match(gone.data.error, /nothing left to preview/);
  assert.equal((await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id })).status, 409);
  // The real signing link of the same person still behaves as before.
  assert.ok(tokenFor(env.id, 'ada@example.com'));
});

test('a template is previewed by role, through /templates/:id/recipient-preview', async () => {
  const sender = await signUp('Tom Template', 'tom.preview@example.com', newIp());
  const file = await upload(sender, 1);
  const t = await sender.post('/envelopes', {
    kind: 'template', subject: 'NDA', documents: [{ id: 'd', file_id: file.id, name: 'NDA' }],
    recipients: [{ id: 'role1', role: 'signer', role_name: 'Client', name: '', email: '' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'role1', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const tpl = t.data.envelope;
  const before = snapshot();
  const made = await sender.post(`/templates/${tpl.id}/recipient-preview`, { recipient_id: tpl.recipients[0].id });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const v = (await sender.get(`/preview/${tokenOf(made.data.url)}`)).data;
  assert.equal(v.preview.kind, 'template');
  assert.equal(v.preview.person.name, 'Client');
  assert.equal(v.fields.length, 1);
  sameRows(before, snapshot());
  // The template path takes templates only, and the envelope path envelopes only.
  assert.equal((await sender.post(`/templates/${tpl.id}/recipient-preview`, {})).status, 400);
  assert.equal((await sender.post(`/envelopes/${tpl.id}/recipient-preview`, { recipient_id: tpl.recipients[0].id })).status, 404);
});

test('a preview opens only for its maker, in the browser it was made in, and only for 15 minutes', async () => {
  const sender = await signUp('Ivy Owner', 'ivy.preview@example.com', newIp());
  const env = await draft(sender);
  const ada = env.recipients.find((r: any) => r.name === 'Ada Signer');
  const made = (await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id })).data;
  const tok = tokenOf(made.url);

  // Nobody signed in (the signer it was forwarded to, say), another account, the same login in another browser.
  const stranger = Object.assign(new Client(), { ip: newIp() });
  const nobody = await stranger.get(`/preview/${tok}`);
  assert.equal(nobody.status, 403);
  assert.equal(nobody.data.code, 'preview_not_yours');
  assert.match(nobody.data.error, /use the link in the email you were sent/);
  const other = await signUp('Max Other', 'max.preview@example.com', newIp());
  assert.equal((await other.get(`/preview/${tok}`)).data.code, 'preview_not_yours');
  assert.equal((await other.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id })).status, 404, 'refused for another account');
  const second = Object.assign(new Client(), { ip: newIp() });
  assert.equal((await second.post('/auth/login', { email: 'ivy.preview@example.com', password: 'correct horse battery' })).status, 200);
  assert.equal((await second.get(`/preview/${tok}`)).data.code, 'preview_not_yours', 'another browser of the same login');
  // Every call under it is checked the same way, not only the view.
  assert.equal((await stranger.get(`/preview/${tok}/doc/d1`)).data.code, 'preview_not_yours');
  assert.equal((await stranger.post(`/preview/${tok}/consent`)).data.code, 'preview_not_yours');

  // A token changed by hand, or the signature cut off.
  const [body, mac] = tok.slice(3).split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
  forged.x += 3600_000;
  const longer = `pv.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`;
  assert.equal((await sender.get(`/preview/${longer}`)).data.code, 'preview_unknown');
  assert.equal((await sender.get(`/preview/pv.${body}`)).data.code, 'preview_unknown');
  // Not a signing link either: the real signing routes do not know it.
  assert.equal((await sender.get(`/sign/${tok}`)).status, 404);

  // After 15 minutes it has ended, and says how to get a new one.
  const real = Date.now;
  try {
    Date.now = () => real() + 15 * 60_000 + 1000;
    const late = await sender.get(`/preview/${tok}`);
    assert.equal(late.status, 410);
    assert.equal(late.data.code, 'preview_expired');
    assert.match(late.data.error, /lasts 15 minutes/);
  } finally {
    Date.now = real;
  }
  assert.equal((await sender.get(`/preview/${tok}`)).status, 200, 'still fine within its time');

  // Signed out: the preview ends with the session.
  assert.equal((await sender.post('/auth/logout')).status, 200);
  assert.equal((await sender.get(`/preview/${tok}`)).data.code, 'preview_not_yours');
});

test('an API key makes the link for its maker, who opens it signed in; the key itself cannot open it', async () => {
  const owner = await signUp('Kim Keys', 'kim.preview@example.com', newIp());
  const env = await draft(owner);
  const ada = env.recipients.find((r: any) => r.name === 'Ada Signer');
  const key = (await owner.post('/api-keys', { name: 'integration' })).data.key;
  const api = withKey(key);
  const made = await api.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const tok = tokenOf(made.data.url);
  assert.equal((await api.get(`/preview/${tok}`)).data.code, 'preview_not_yours', 'a key reads no preview');
  assert.equal((await owner.get(`/preview/${tok}`)).status, 200, 'its maker, in a browser of theirs');
  // A member of the team cannot preview what the owner sent, nor a draft they cannot see.
  assert.equal((await owner.post('/account/invites', { email: 'mo.preview@example.com', role: 'member' })).status, 200);
  const invite = s.db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', 'mo.preview@example.com').token;
  const member = Object.assign(new Client(), { ip: newIp() });
  assert.equal((await member.post('/auth/signup', { name: 'Mo Member', email: 'mo.preview@example.com', password: 'correct horse battery', invite })).status, 200);
  assert.equal((await member.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id })).status, 404);
});

test('the request says what is missing', async () => {
  const sender = await signUp('Una Asks', 'una.preview@example.com', newIp());
  const env = await draft(sender);
  const none = await sender.post(`/envelopes/${env.id}/recipient-preview`, {});
  assert.equal(none.status, 400);
  assert.match(none.data.error, /recipient_id/);
  const gone = await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: 'nobody' });
  assert.equal(gone.status, 404);
  assert.match(gone.data.error, /not on this document/);
  // A person taken off the draft after the link was made: the link says so instead of showing someone else.
  const ada = env.recipients.find((r: any) => r.name === 'Ada Signer');
  const made = (await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ada.id })).data;
  const full = (await sender.get(`/envelopes/${env.id}`)).data.envelope;
  const put = await sender.put(`/envelopes/${env.id}`, { ...full, recipients: full.recipients.filter((r: any) => r.id !== ada.id), fields: full.fields.filter((f: any) => f.recipient_id !== ada.id) });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const after = await sender.get(`/preview/${tokenOf(made.url)}`);
  assert.equal(after.status, 404);
  assert.equal(after.data.code, 'preview_gone');
});

test('a signature a person adopted but has not put on the document stays theirs: the preview does not show it', async () => {
  const sender = await signUp('Pia Held', 'pia.held.preview@example.com', newIp());
  const env = await draft(sender);
  assert.equal((await sender.post(`/envelopes/${env.id}/send`, {})).status, 200);
  const tok = tokenFor(env.id, 'ada@example.com');
  const ada = Object.assign(new Client(), { ip: newIp() });
  assert.equal((await ada.post(`/sign/${tok}/consent`)).status, 200);
  const sv = (await ada.get(`/sign/${tok}`)).data;
  assert.equal((await ada.post(`/sign/${tok}/save`, { version: sv.version, values: {}, signature_png: PNG })).status, 200);
  const adaId = env.recipients.find((r: any) => r.name === 'Ada Signer').id;
  assert.ok(s.db.get('SELECT signature_png FROM recipients WHERE id=?', adaId).signature_png, 'held for her');
  const made = (await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: adaId })).data;
  const v = (await sender.get(`/preview/${tokenOf(made.url)}`)).data;
  assert.equal(v.recipient.signature_png ?? null, null);
  assert.equal(v.recipient.initials_png ?? null, null);
  assert.doesNotMatch(JSON.stringify(v), /data:image\/png;base64/, 'no adopted mark anywhere in the preview');
});

test('the band speaks the sender\'s language, and the person\'s page is never chosen by the sender\'s browser', async () => {
  const sender = await signUp('Lea Lang', 'lea.lang.preview@example.com', newIp());
  const env = await draft(sender);
  const ben = env.recipients.find((r: any) => r.name === 'Ben Signer');
  const made = (await sender.post(`/envelopes/${env.id}/recipient-preview`, { recipient_id: ben.id })).data;
  const v = await sender.call('GET', `/preview/${tokenOf(made.url)}`, undefined, { 'accept-language': 'fr-FR,fr;q=0.9' });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  // The person has no language set: the page is in the default, not whatever the sender's browser asks for.
  assert.notEqual(v.data.language.set_by, 'browser');
  // Every sentence of the band comes from the catalogue (t), with the access code "on this document".
  assert.equal(v.data.preview.check, t('en', 'preview.check.before', { checks: t('en', 'preview.check.access_code') }));
  assert.equal(v.data.preview.turn, t('en', 'preview.turn.one', { name: 'Ada Signer' }));
  assert.equal(v.data.preview.does, t('en', 'preview.role.signer'));
  assert.equal(PREVIEW_NOTHING, t('en', 'preview.nothing'));
  for (const k of ['preview.chip', 'preview.save', 'preview.band.show', 'preview.band.close', 'preview.band.leave']) assert.ok(t('en', k), k);
  assert.doesNotMatch(t('en', 'preview.save'), /^Saved/, 'the save line in a preview never says Saved');
});

test('the screens: a way out that always does something, a person switch that waits for Show, no "Try again" on a refusal', async () => {
  const fs = await import('node:fs');
  const band = fs.readFileSync(new URL('../src/components/sign/PreviewBand.tsx', import.meta.url), 'utf8');
  const problem = fs.readFileSync(new URL('../src/components/sign/PreviewProblem.tsx', import.meta.url), 'utf8');
  const dialogs = fs.readFileSync(new URL('../src/components/sign/dialogs.tsx', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../src/app/sign/[token]/page.tsx', import.meta.url), 'utf8');
  // Close only where the browser lets a page close its tab (opened by the editor); elsewhere a link to the documents.
  assert.match(band, /window\.opener/);
  assert.match(band, /href="\/app"/);
  assert.doesNotMatch(problem, /window\.close\(\)/, 'no bare Close button on the problem card');
  assert.match(problem, /<LeavePreview/);
  // The select only picks; navigation happens on Show (a form submit), never on change.
  assert.doesNotMatch(band, /onChange=\{[^}]*location/);
  assert.match(band, /onSubmit=/);
  // The band names the preview in the top bar, which stays on screen.
  assert.match(band, /export function PreviewChip/);
  // A refusal with code "preview" is shown alone, calmly.
  assert.match(dialogs, /e\?\.code === 'preview'\) setError\(PREVIEW_NOTHING\)/);
  assert.match(dialogs, /children === PREVIEW_NOTHING \? <div className="notice sg-problem" role="status">/);
  assert.match(page, /data\?\.preview \? previewT\('preview\.save'\)/);
});
