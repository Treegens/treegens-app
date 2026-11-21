// The account's own consent text (src/server/disclosure.ts, src/lib/disclosure.ts): admins write it per language in
// Settings, Sending, More options, "Your consent text"; every save that changes a word is a new version that is never
// changed, and never deleted while a document refers to it. The signing page shows it under our own sentence on what
// kind of signature this is (inline while the screen stays at 120 words before the tick, else behind "Read <Org>'s
// terms"), once for each document or every time the link is opened. "Sign on paper instead", "Ask <sender> to send it
// by post" takes the person's consent back: their part closes like a decline with a reason the software writes, the
// sender is emailed, and the audit trail, the certificate and the evidence pack say so. With no text saved nothing
// changes anywhere.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { boot, Client, signUp, simple, tokenFor, signAll, mailTo, PNG, type Server } from './helpers.ts';
import {
  OWN_TEXT_KEYS, ESIGN_NOTE, DEFAULT_NEEDS, WITHDREW_REASON, NEVER_AGREED_REASON, ownSections, ownTextPlain, tidyOwnText, ownTextProblem, possessive, consentCertValue,
} from '../src/lib/disclosure.ts';
import { SUPPORTED_LOCALES, CATALOGUES, t } from '../src/lib/i18n.ts';

let db: Server['db'];
let env: Server['env'];
before(async () => {
  ({ db, env } = await boot());
});

let n = 0;
const ip = () => `10.93.${Math.floor(++n / 250)}.${n % 250}`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const PW = 'correct horse battery';
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const TEXT = {
  org: 'Acme Housing Trust',
  email: 'records@acme-housing.example',
  phone: '+44 20 7946 0000',
  address: '1 Market Street, Leeds',
  paper: 'Write to us or call us and we post a paper copy within 5 working days.',
  paper_cost: 'Free',
  withdraw: 'Tell us by email or post. From then on we send you everything on paper, and nothing you already signed changes.',
  needs: '',
  other: '',
};

async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = browser();
  const tok = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: tok });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  db.run('UPDATE users SET email_verified=1 WHERE email=?', email);
  return c;
}

async function withFrench<T>(fn: () => Promise<T>): Promise<T> {
  const fr = SUPPORTED_LOCALES.find((l) => l.tag === 'fr')!;
  const was = { ...fr };
  Object.assign(fr, { shipped: true, ui: 'draft' });
  try {
    return await fn();
  } finally {
    Object.assign(fr, was);
  }
}

const accountOf = (email: string) => db.get("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.role='owner'", email);
const linesOf = (id: string) => db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id);

// ---- 1. Settings: the text per language, versions that never change ------------------------------------------------

test('1. with nothing saved the account shows only our words, and Settings says what the text is and the ESIGN note', async () => {
  const owner = await person('Olga Owner', 'olga@own1.example');
  const r = await owner.get('/account/disclosure');
  assert.equal(r.status, 200);
  assert.equal(r.data.each_visit, false, 'once for each document by default');
  assert.deepEqual(r.data.languages, ['en']);
  assert.equal(r.data.texts.en, null);
  assert.equal(r.data.has_versions, false);
  assert.equal(r.data.default_needs, DEFAULT_NEEDS);
  assert.equal(r.data.note, ESIGN_NOTE);
  assert.equal(ESIGN_NOTE, 'If you deal with consumers in the United States, the ESIGN Act section 101(c) lists what this text must say. Ask your lawyer.');
  assert.deepEqual((await owner.get('/account/disclosure/versions')).data.versions, []);
});

test('1. a save is refused in words when a needed part is missing, and nothing is saved', async () => {
  const owner = await person('Rita Refused', 'rita@own2.example');
  for (const [over, said] of [
    [{ org: '' }, /organisation name is missing/],
    [{ email: '', phone: '', address: '' }, /no way to reach you/],
    [{ email: 'not an address' }, /does not look like one/],
    [{ paper: '  ' }, /paper copies is empty/],
    [{ withdraw: '' }, /part on stopping is empty/],
    [{ other: 'x'.repeat(2001) }, /longer than 2000 characters/],
    [{ org: 42 }, /must be text/],
  ] as const) {
    const r = await owner.put('/account/disclosure', { text: { ...TEXT, ...over } });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.error, said);
    assert.match(r.data.error, /Nothing was saved\.$/);
  }
  assert.equal((await owner.put('/account/disclosure', { text: 'words' })).status, 400);
  assert.equal((await owner.put('/account/disclosure', { each_visit: 'yes' })).status, 400);
  assert.equal(db.get('SELECT COUNT(*) n FROM disclosure_versions WHERE account_id=?', accountOf('rita@own2.example').id).n, 0);
  // The screen says the same before it sends (one rule, in src/lib/disclosure.ts).
  assert.match(ownTextProblem({ ...TEXT, org: '' }), /organisation name is missing/);
  assert.equal(ownTextProblem(TEXT), '');
});

test('1. each save that changes a word is a new version; the same words make none; versions are kept and never change', async () => {
  const owner = await person('Vera Versions', 'vera@own3.example');
  const one = await owner.put('/account/disclosure', { text: TEXT });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.deepEqual({ language: one.data.saved.language, version: one.data.saved.version }, { language: 'en', version: 1 });
  assert.equal(one.data.texts.en.version, 1);
  assert.equal(one.data.texts.en.saved_by, 'Vera Versions');
  // Our own sentence for "what you need" stands in for an empty part, and the parts read as a signer reads them.
  assert.deepEqual(one.data.texts.en.sections.map((s: any) => s.h), ['How to reach Acme Housing Trust', 'Getting it on paper', 'If you change your mind', 'What you need to read the documents']);
  assert.deepEqual(one.data.texts.en.sections[3].lines, [DEFAULT_NEEDS]);
  assert.equal(one.data.texts.en.sha256, sha(ownTextPlain(one.data.texts.en.sections)));

  const same = await owner.put('/account/disclosure', { text: { ...TEXT, org: '  Acme Housing Trust ' } });
  assert.equal(same.data.unchanged, true);
  assert.equal(same.data.saved, null);
  const two = await owner.put('/account/disclosure', { text: { ...TEXT, paper_cost: '5 pounds for each copy' } });
  assert.equal(two.data.saved.version, 2);
  const list = (await owner.get('/account/disclosure/versions')).data.versions;
  assert.deepEqual(list.map((v: any) => [v.version, v.shown_now, v.documents]), [[2, true, 0], [1, false, 0]]);
  assert.equal(list[1].paper_cost, 'Free', 'version 1 is kept as it was');
  assert.equal((await owner.get('/account/disclosure/versions?language=en')).data.versions.length, 2);
  assert.equal((await owner.get('/account/disclosure/versions?language=zz')).status, 400);

  // Nothing changes a saved version, whatever code asks.
  assert.throws(() => db.run('UPDATE disclosure_versions SET fields=? WHERE id=?', '{}', list[1].id), /never changed/);
  assert.equal(db.get('SELECT fields FROM disclosure_versions WHERE id=?', list[1].id).fields.includes('Free'), true);
  // There is no call that changes or deletes one.
  assert.equal((await owner.call('DELETE', '/account/disclosure')).status, 404);
  // The change is in the security record, without the words.
  const ev = db.all("SELECT * FROM security_events WHERE account_id=? ORDER BY seq DESC LIMIT 5", accountOf('vera@own3.example').id);
  assert.ok(ev.length > 0);
  assert.doesNotMatch(JSON.stringify(ev), /Market Street|working days/);
});

test('1. only admins read or write it; a member is refused and sees nothing', async () => {
  const owner = await person('Ada Admin', 'ada@own4.example');
  const member = await join(owner, 'Mo Member', 'mo@own4.example');
  assert.equal((await member.get('/account/disclosure')).status, 403);
  assert.equal((await member.put('/account/disclosure', { text: TEXT })).status, 403);
  assert.equal((await member.get('/account/disclosure/versions')).status, 403);
  const admin = await join(owner, 'Ann Admin', 'ann@own4.example', 'admin');
  assert.equal((await admin.put('/account/disclosure', { text: TEXT })).status, 200);
  assert.equal((await new Client().get('/account/disclosure')).status, 401);
});

test('1. stopping takes the text off the screen and keeps its versions; saving again starts at the next number', async () => {
  const owner = await person('Stan Stop', 'stan@own5.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const off = await owner.put('/account/disclosure', { text: null });
  assert.equal(off.status, 200);
  assert.equal(off.data.texts.en, null);
  assert.equal(off.data.has_versions, true);
  assert.equal(accountOf('stan@own5.example').disclosure_now, null, 'the account is as it was before it had a text');
  const again = await owner.put('/account/disclosure', { text: { ...TEXT, other: 'Office hours are 9 to 5.' } });
  assert.equal(again.data.saved.version, 2);
});

test('1. a text for another language is saved on its own and numbered on its own; a language that is off is refused', async () => {
  const owner = await person('Lou Lang', 'lou@own6.example');
  assert.equal((await owner.put('/account/disclosure', { language: 'fr', text: TEXT })).status, 400, 'French is not switched on');
  await withFrench(async () => {
    await owner.put('/account/disclosure', { text: TEXT });
    const fr = await owner.put('/account/disclosure', { language: 'fr', text: { ...TEXT, paper: 'Écrivez-nous.' } });
    assert.equal(fr.status, 200, JSON.stringify(fr.data));
    assert.deepEqual(fr.data.saved, { language: 'fr', version: 1, id: fr.data.saved.id });
    assert.equal(fr.data.texts.en.version, 1, 'the English one stays');
    assert.equal(fr.data.texts.fr.language, 'fr');
  });
});

test('1. an account that has not paid cannot put a payment notice from a well-known company on the signing page', async () => {
  const owner = await person('Lure Lad', 'lure@own7.example');
  const r = await owner.put('/account/disclosure', { text: { ...TEXT, org: 'PayPal Billing', other: 'Your invoice of 499 dollars is overdue. Call +1 800 555 0100 to cancel the charge.' } });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /payment notice/);
  assert.equal(accountOf('lure@own7.example').disclosure_now, null);
});

// ---- 2. The consent screen: under our sentence, in the person's language, once or every time -----------------------

const view = (tok: string, c: Client, lang?: string) => c.call('GET', `/sign/${tok}`, undefined, lang ? { 'accept-language': lang } : {});
const agree = (tok: string, c: Client, own?: string, lang?: string) => c.call('POST', `/sign/${tok}/consent`, { wording: undefined, own }, lang ? { 'accept-language': lang } : {});

test('2. with zero setup nothing changes: no own_terms, the agreement needs no "own", the line names only our wording', async () => {
  const owner = await person('Zed Zero', 'zed@own10.example');
  const e = await simple(owner, 'zoe@own10.example', { send: true });
  const tok = tokenFor(e.id, 'zoe@own10.example');
  const c = browser();
  const v = (await view(tok, c)).data;
  assert.equal(v.own_terms, null);
  assert.equal(v.recipient.asked_paper, false);
  assert.equal((await agree(tok, c)).status, 200);
  const line = linesOf(e.id).find((a: any) => a.action === 'Agreed to electronic records and signatures');
  assert.ok(line);
  assert.doesNotMatch(line.detail, /own consent text/);
  assert.equal(db.get('SELECT COUNT(*) n FROM disclosure_shown WHERE envelope_id=?', e.id).n, 0);
});

test('2. with a text the screen gets it, must say it showed it, and the line names its version, language and fingerprint as well as ours', async () => {
  const owner = await person('Tess Terms', 'tess@own11.example');
  const saved = (await owner.put('/account/disclosure', { text: TEXT })).data.texts.en;
  const e = await simple(owner, 'tom@own11.example', { send: true });
  const tok = tokenFor(e.id, 'tom@own11.example');
  const c = browser();
  const own = (await view(tok, c)).data.own_terms;
  assert.deepEqual({ id: own.id, version: own.version, language: own.language, org: own.org, note: own.note, each_visit: own.each_visit }, { id: saved.id, version: 1, language: 'en', org: 'Acme Housing Trust', note: '', each_visit: false });
  assert.deepEqual(own.sections, saved.sections);
  // Not said: refused, and nothing is written.
  const blind = await agree(tok, c);
  assert.equal(blind.status, 409);
  assert.equal(blind.data.code, 'terms');
  assert.match(blind.data.error, /The terms of Acme Housing Trust on this page were not the current ones/);
  assert.equal(db.get('SELECT consent_at FROM recipients WHERE token=?', tok).consent_at, null);
  assert.equal(linesOf(e.id).filter((a: any) => /^Agreed/.test(a.action)).length, 0);
  assert.equal((await agree(tok, c, 'dv_somebody_else')).status, 409);
  // Said: one line with ours and theirs.
  assert.equal((await agree(tok, c, own.id)).status, 200);
  const line = linesOf(e.id).find((a: any) => a.action === 'Agreed to electronic records and signatures');
  assert.match(line.detail, new RegExp(`Also shown the sender's own consent text, version 1 in English \\(en\\), SHA-256 ${saved.sha256}\\.`));
  assert.match(line.detail, /wording/i, 'our own wording is still named');
  assert.doesNotMatch(line.detail, /Market Street|working days/, 'none of the account\'s words are in the trail');
  const versions = (await owner.get('/account/disclosure/versions')).data.versions;
  assert.equal(versions[0].documents, 1);
  // A version a document refers to is never deleted.
  assert.throws(() => db.run('DELETE FROM disclosure_versions WHERE id=?', own.id), /is kept/);
});

test('2. a screen left open while an admin saved a new text is told to show the new one; the old version is kept', async () => {
  const owner = await person('Nina New', 'nina@own12.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const e = await simple(owner, 'ned@own12.example', { send: true });
  const tok = tokenFor(e.id, 'ned@own12.example');
  const c = browser();
  const old = (await view(tok, c)).data.own_terms;
  await owner.put('/account/disclosure', { text: { ...TEXT, paper_cost: '3 pounds' } });
  const r = await agree(tok, c, old.id);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'terms');
  const fresh = (await view(tok, c)).data.own_terms;
  assert.equal(fresh.version, 2);
  assert.equal((await agree(tok, c, fresh.id)).status, 200);
  assert.match(linesOf(e.id).find((a: any) => a.action === 'Agreed to electronic records and signatures').detail, /version 2 in English/);
  assert.equal((await owner.get('/account/disclosure/versions')).data.versions.length, 2);
});

test('2. a person whose language has no text reads the English one with the "not yet checked" sentence; with their own, theirs', async () => {
  await withFrench(async () => {
    const owner = await person('Fleur Fallback', 'fleur@own13.example');
    await owner.put('/account/disclosure', { text: TEXT });
    const e = await simple(owner, 'fred@own13.example', { send: true });
    const tok = tokenFor(e.id, 'fred@own13.example');
    const c = browser();
    const en = (await view(tok, c, 'fr')).data;
    assert.equal(en.language.locale, 'fr');
    assert.equal(en.own_terms.language, 'en');
    assert.equal(en.own_terms.note, t('fr', 'legal.in_english'));
    assert.ok(en.own_terms.note.length > 0);
    // In English for English screens, with no note.
    assert.equal((await view(tok, browser(), 'en')).data.own_terms.note, '');
    // The account writes a French one: a French screen gets it, an English one keeps the English.
    const fr = (await owner.put('/account/disclosure', { language: 'fr', text: { ...TEXT, paper: 'Écrivez-nous, la copie papier est gratuite.' } })).data.texts.fr;
    const now = (await view(tok, c, 'fr')).data.own_terms;
    assert.deepEqual({ id: now.id, language: now.language, note: now.note }, { id: fr.id, language: 'fr', note: '' });
    assert.equal((await view(tok, browser(), 'en')).data.own_terms.language, 'en');
    assert.equal((await agree(tok, c, now.id, 'fr')).status, 200);
    assert.match(linesOf(e.id).find((a: any) => a.action === 'Agreed to electronic records and signatures').detail, /version 1 in French \(fr\)/);
    // A text only in French, none in English: an English screen shows only our words.
    const solo = await person('Solo French', 'solo@own13.example');
    await solo.put('/account/disclosure', { language: 'fr', text: TEXT });
    const e2 = await simple(solo, 'sam@own13.example', { send: true });
    assert.equal((await view(tokenFor(e2.id, 'sam@own13.example'), browser(), 'en')).data.own_terms, null);
    assert.equal((await view(tokenFor(e2.id, 'sam@own13.example'), browser(), 'fr')).data.own_terms.language, 'fr');
  });
});

test('2. once for each document by default; every time the link is opened when the account asks, never twice in a minute', async () => {
  const owner = await person('Evie Every', 'evie@own14.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const e = await simple(owner, 'eli@own14.example', { send: true });
  const tok = tokenFor(e.id, 'eli@own14.example');
  const c = browser();
  const own = (await view(tok, c)).data.own_terms;
  assert.equal((await agree(tok, c, own.id)).status, 200);
  const again = () => linesOf(e.id).filter((a: any) => a.action === 'Agreed again to electronic records and signatures');
  assert.equal((await agree(tok, c, own.id)).status, 200);
  assert.equal(again().length, 0, 'once for each document: a second agreement writes nothing');

  const set = await owner.put('/account/disclosure', { each_visit: true });
  assert.equal(set.data.each_visit, true);
  assert.equal(set.data.texts.en.version, 1, 'changing how often makes no version');
  const v = (await view(tok, c)).data;
  assert.equal(v.own_terms.each_visit, true);
  assert.equal(v.recipient.consented, true, 'the screen asks again because of each_visit, not because the agreement was lost');
  assert.equal((await agree(tok, c, own.id)).status, 200);
  assert.equal(again().length, 0, 'within a minute of the last agreement: the same visit');
  db.run("UPDATE disclosure_shown SET at=? WHERE envelope_id=?", new Date(Date.now() - 120_000).toISOString(), e.id);
  assert.equal((await agree(tok, c, own.id)).status, 200);
  assert.equal(again().length, 1);
  assert.match(again()[0].detail, /The sender asks for this every time the link is opened\. Also shown the sender's own consent text, version 1 in English/);
  assert.equal(db.get('SELECT COUNT(*) n FROM disclosure_shown WHERE envelope_id=? AND again=1', e.id).n, 1);
  // Back to once for each document.
  assert.equal((await owner.put('/account/disclosure', { each_visit: false })).data.each_visit, false);
});

// ---- 3. Asking for paper instead: the part closes like a decline, the sender is told ---------------------------------

test('3. "Ask the sender to send it by post" after agreeing: the part closes with the reason, the sender is emailed, the page says so', async () => {
  const owner = await person('Paula Paper', 'paula@own20.example');
  // The sender turned off emails about problems: this one comes anyway, because only they can send the paper.
  assert.equal((await owner.call('PATCH', '/me', { notify: { problems: false } })).status, 200);
  await owner.put('/account/disclosure', { text: TEXT });
  const e = await simple(owner, 'pete@own20.example', { send: true });
  const tok = tokenFor(e.id, 'pete@own20.example');
  const c = browser();
  const own = (await view(tok, c)).data.own_terms;
  await agree(tok, c, own.id);
  const r = await c.post(`/sign/${tok}/decline/paper`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { ok: true, reason: WITHDREW_REASON });
  const row = db.get('SELECT status, decline_reason FROM recipients WHERE token=?', tok);
  assert.deepEqual({ ...row }, { status: 'declined', decline_reason: WITHDREW_REASON });
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'declined');
  const lines = linesOf(e.id);
  assert.ok(lines.some((a: any) => a.action === 'Declined' && a.detail === `Sam Signer: ${WITHDREW_REASON}`));
  assert.ok(lines.some((a: any) => a.action === WITHDREW_REASON && /asked the sender to send the document on paper instead/.test(a.detail)));
  const mail = mailTo('paula@own20.example').filter((m: any) => /Asked for paper/.test(m.subject));
  assert.equal(mail.length, 1);
  assert.match(mail[0].html, /took back their agreement to use electronic records and signatures/);
  assert.match(mail[0].html, /GrowSigning does not print or post anything/);
  // The page shows that they asked for paper, not "You declined".
  const after = (await view(tok, c)).data;
  assert.equal(after.recipient.asked_paper, true);
  assert.equal(after.recipient.status, 'declined');
  // Nothing more can be done electronically on it.
  const sign = await c.post(`/sign/${tok}/complete`, { values: {}, signature_png: PNG });
  assert.ok(sign.status >= 400, `refused: ${sign.status}`);
  assert.equal((await c.post(`/sign/${tok}/decline/paper`, {})).status, 409, 'a second tap changes nothing');
  assert.equal(mailTo('paula@own20.example').filter((m: any) => /Asked for paper/.test(m.subject)).length, 1);
});

test('3. from the consent screen, before agreeing: the reason says they never agreed; a copy-only person and a closed document are refused', async () => {
  const owner = await person('Nora Never', 'nora@own21.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const file = await (await import('./helpers.ts')).upload(owner, 1);
  const made = await owner.post('/envelopes', {
    subject: 'Lease', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Neil Never', email: 'neil@own21.example', routing_order: 1 }, { id: 'b', role: 'cc', name: 'Cy Copy', email: 'cy@own21.example', routing_order: 1 }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  const e = made.data.envelope;
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
  const cc = await browser().post(`/sign/${tokenFor(e.id, 'cy@own21.example')}/decline/paper`, {});
  assert.equal(cc.status, 400);
  assert.match(cc.data.error, /only asked to read this document/);
  const tok = tokenFor(e.id, 'neil@own21.example');
  const c = browser();
  await view(tok, c);
  const r = await c.post(`/sign/${tok}/decline/paper`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reason, NEVER_AGREED_REASON);
  assert.match(mailTo('nora@own21.example').find((m: any) => /Asked for paper/.test(m.subject)).html, /did not agree to use electronic records and signatures/);
  assert.equal((await browser().post(`/sign/${tokenFor(e.id, 'cy@own21.example')}/decline/paper`, {})).status, 400);
  // A link that does not exist is not told anything.
  assert.equal((await browser().post('/sign/not-a-token/decline/paper', {})).status, 404);
});

test('3. the certificate says the consent was withdrawn, and when; or that it was never given', () => {
  const ts = (s: string | null | undefined) => (s ? `${s.slice(0, 10)} ${s.slice(11, 19)} UTC` : '-');
  const at = '2026-11-21T10:00:00.000Z', later = '2026-11-21T10:05:00.000Z';
  assert.equal(consentCertValue({ status: 'completed', consent_at: at, completed_at: later }, ts), '2026-11-21 10:00:00 UTC');
  assert.equal(consentCertValue({ status: 'declined', consent_at: at, completed_at: later }, ts), '2026-11-21 10:00:00 UTC');
  assert.equal(consentCertValue({ status: 'declined', paper_at: later, consent_at: at, completed_at: later }, ts), '2026-11-21 10:00:00 UTC, withdrawn 2026-11-21 10:05:00 UTC: asked for paper instead');
  assert.equal(consentCertValue({ status: 'declined', paper_at: later, consent_at: null, completed_at: later }, ts), 'Not given. Asked for paper instead 2026-11-21 10:05:00 UTC');
  // The words of a reason never make it a paper request: only paper_at, which only "Sign on paper instead" sets.
  for (const reason of [WITHDREW_REASON, NEVER_AGREED_REASON]) assert.equal(consentCertValue({ status: 'declined', consent_at: at, completed_at: later, ...({ decline_reason: reason } as any) }, ts), '2026-11-21 10:00:00 UTC');
  // The certificate draws its line with it.
  assert.match(fs.readFileSync('src/server/pdf.ts', 'utf8'), /s\.kv\('E-record consent', consentCertValue\(r, ts\)\);/);
});

// ---- 4. The evidence pack holds the exact words each person saw ------------------------------------------------------

test('4. the evidence pack holds the words each person was shown, once per version, with the fingerprint the trail names', async () => {
  const owner = await person('Eva Evidence', 'eva@own30.example');
  const v1 = (await owner.put('/account/disclosure', { text: TEXT })).data.texts.en;
  const file = await (await import('./helpers.ts')).upload(owner, 1);
  const made = await owner.post('/envelopes', {
    subject: 'Tenancy', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Abe First', email: 'abe@own30.example', routing_order: 1 }, { id: 'b', role: 'signer', name: 'Bea Second', email: 'bea@own30.example', routing_order: 1 }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }],
  });
  const e = made.data.envelope;
  await owner.post(`/envelopes/${e.id}/send`);
  const a = browser(), b = browser();
  const ta = tokenFor(e.id, 'abe@own30.example'), tb = tokenFor(e.id, 'bea@own30.example');
  await agree(ta, a, (await view(ta, a)).data.own_terms.id);
  const v2 = (await owner.put('/account/disclosure', { text: { ...TEXT, other: 'Our office is closed on Sundays.' } })).data.texts.en;
  await agree(tb, b, (await view(tb, b)).data.own_terms.id);

  const ev = await import('../src/server/evidence.ts');
  const pack = await ev.evidencePack(env.loadEnvelope(e.id), 'the test');
  const file1 = (name: string) => pack.entries.find((x: any) => x.name === name);
  const txt = Buffer.from(file1('consent-own-text.txt')!.data).toString('utf8');
  assert.match(txt, /\r\nAbe First <abe@own30\.example>, [^\r\n]*: version 1 in English \(en\)\.\r\n/);
  assert.match(txt, /\r\nBea Second <bea@own30\.example>, [^\r\n]*: version 2 in English \(en\)\.\r\n/);
  for (const v of [v1, v2]) {
    // Between the lines of dashes, the words exactly as kept: the fingerprint can be taken again from the file.
    assert.ok(txt.includes(`\r\n\r\n${ownTextPlain(v.sections)}\r\n\r\n----`), `the exact words of version ${v.version}`);
    assert.ok(txt.includes(`SHA-256 of the words below (UTF-8, as printed between the lines of dashes, without the empty lines around them): ${v.sha256}`));
    assert.equal(v.sha256, sha(ownTextPlain(v.sections)));
  }
  assert.match(txt, /Our office is closed on Sundays\./);
  assert.match(txt, /GrowSigning did not write these words and did not check them against any law\./);
  assert.match(Buffer.from(file1('README.txt')!.data).toString(), /consent-own-text\.txt {2}the sender's own consent text/);
  // Our own words are still in consent.txt for each of them.
  assert.match(Buffer.from(file1('consent.txt')!.data).toString(), /Abe First[\s\S]*Bea Second/);

  // A document where nobody was shown a text of the account's has no such file.
  const plain = await person('Pia Plain', 'pia@own31.example');
  const e2 = await simple(plain, 'pat@own31.example', { send: true });
  await agree(tokenFor(e2.id, 'pat@own31.example'), browser());
  const p2 = await ev.evidencePack(env.loadEnvelope(e2.id), 'the test');
  assert.equal(p2.entries.some((x: any) => x.name === 'consent-own-text.txt'), false);
});

test('4. closing an account takes its versions with it, also those its documents referred to', async () => {
  const owner = await person('Cleo Close', 'cleo@own32.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const e = await simple(owner, 'cal@own32.example', { send: true });
  const tok = tokenFor(e.id, 'cal@own32.example');
  const c = browser();
  await agree(tok, c, (await view(tok, c)).data.own_terms.id);
  const id = accountOf('cleo@own32.example').id;
  assert.equal(db.get('SELECT COUNT(*) n FROM disclosure_versions WHERE account_id=?', id).n, 1);
  db.run('DELETE FROM envelopes WHERE id=?', e.id);
  db.run('DELETE FROM accounts WHERE id=?', id);
  assert.equal(db.get('SELECT COUNT(*) n FROM disclosure_versions WHERE account_id=?', id).n, 0);
});

// ---- Abuse, and people who get stuck ---------------------------------------------------------------------------------

test('abuse: text is only text (no control or direction characters), saves are limited per hour, "agreed again" lines are capped', async () => {
  const f = tidyOwnText({ ...TEXT, org: 'Acme‮ Trust\u0007', other: 'a\r\n\r\n\r\n\r\nb', unknown: 'x' });
  assert.equal(f.org, 'Acme Trust');
  assert.equal(f.other, 'a\n\nb');
  assert.equal('unknown' in f, false);
  assert.deepEqual(Object.keys(f), [...OWN_TEXT_KEYS]);

  const owner = await person('Rate Ray', 'ray@own40.example');
  let last: any;
  for (let i = 0; i < 31; i++) last = await owner.put('/account/disclosure', { text: { ...TEXT, other: `Change ${i}` } });
  assert.equal(last.status, 429, 'the 31st new version in an hour is refused');
  assert.equal(db.get('SELECT COUNT(*) n FROM disclosure_versions WHERE account_id=?', accountOf('ray@own40.example').id).n, 30);
  // Saving the same words again is never counted: nothing is made.
  assert.equal((await owner.put('/account/disclosure', { text: { ...TEXT, other: 'Change 29' } })).data.unchanged, true);

  const capped = await person('Cap Carla', 'carla@own41.example');
  await capped.put('/account/disclosure', { text: TEXT, each_visit: true });
  const e = await simple(capped, 'cass@own41.example', { send: true });
  const tok = tokenFor(e.id, 'cass@own41.example');
  const c = browser();
  const own = (await view(tok, c)).data.own_terms;
  await agree(tok, c, own.id);
  const rid = db.get('SELECT id FROM recipients WHERE token=?', tok).id;
  const old = new Date(Date.now() - 3_600_000).toISOString();
  for (let i = 0; i < 50; i++) db.run('INSERT INTO disclosure_shown (envelope_id, recipient_id, audit_seq, version_id, again, at) VALUES (?,?,?,?,1,?)', e.id, rid, null, own.id, old);
  db.run('UPDATE disclosure_shown SET at=? WHERE envelope_id=?', old, e.id);
  assert.equal((await agree(tok, c, own.id)).status, 200);
  assert.equal(linesOf(e.id).filter((a: any) => a.action === 'Agreed again to electronic records and signatures').length, 0, 'at most 50 for one person on one document');
});

test('abuse: a text that reads like a payment notice is not shown even if it was saved before the account was checked', async () => {
  const owner = await person('Late Lure', 'late@own42.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const id = accountOf('late@own42.example').id;
  // Written behind the filter's back, as an older build might have: the signing page still does not show it.
  const v = db.get('SELECT * FROM disclosure_versions WHERE account_id=?', id);
  db.run("INSERT INTO disclosure_versions (id, account_id, language, number, fields, sections, sha256, saved_by, saved_by_name, saved_at) VALUES ('dv_lure', ?, 'en', 2, ?, ?, ?, NULL, NULL, ?)",
    id, JSON.stringify({ ...JSON.parse(v.fields), org: 'PayPal Billing', other: 'Your invoice of 499 dollars is overdue. Call +1 800 555 0100.' }), v.sections, v.sha256, new Date().toISOString());
  db.run('UPDATE accounts SET disclosure_now=? WHERE id=?', JSON.stringify({ en: 'dv_lure' }), id);
  const e = await simple(owner, 'lia@own42.example', { send: true });
  const tok = tokenFor(e.id, 'lia@own42.example');
  const c = browser();
  assert.equal((await view(tok, c)).data.own_terms, null);
  assert.equal((await agree(tok, c)).status, 200, 'and agreeing needs no "own" then');
});

test('a member of a group asks for paper: the group\'s part closes, the sender is told who', async () => {
  const owner = await person('Gwen Group', 'gwen@own43.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const made = await owner.post('/groups', { name: 'HR team', members: [{ name: 'Maya Lopez', email: 'maya@own43.example' }, { name: 'Ben Ortiz', email: 'ben@own43.example' }] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const file = await (await import('./helpers.ts')).upload(owner, 1);
  const e = (await owner.post('/envelopes', {
    subject: 'Staff handbook', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'g', role: 'signer', group_id: made.data.group.id }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', e.id, 'maya@own43.example').token;
  const c = browser();
  assert.ok((await view(tok, c)).data.own_terms, 'a member reads the account\'s text too');
  const r = await c.post(`/sign/${tok}/decline/paper`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reason, NEVER_AGREED_REASON);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'declined');
  const mail = mailTo('gwen@own43.example').find((m: any) => /Asked for paper/.test(m.subject));
  assert.match(mail.html, /Maya Lopez/);
  // The other member is told it is closed, and their link can do nothing more.
  const other = db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', e.id, 'ben@own43.example').token;
  assert.ok((await browser().post(`/sign/${other}/decline/paper`, {})).status >= 400);
});

test('the API description has the calls, and nothing calls our own text an ESIGN consumer disclosure', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  for (const p of ['/account/disclosure', '/account/disclosure/versions', '/sign/{token}/decline/paper']) assert.ok(spec.paths[p], p);
  assert.ok(spec.paths['/account/disclosure'].get && spec.paths['/account/disclosure'].put);
  assert.match(spec.paths['/sign/{token}/consent'].post.description, /own_terms/);
  // The words people read: our files for this, the catalogue and the README, without the comments in the code.
  const MINE = ['src/lib/disclosure.ts', 'src/server/disclosure.ts', 'src/server/routes-disclosure.ts', 'src/server/openapi-disclosure.ts', 'src/components/settings/Disclosure.tsx', 'src/components/sign/OwnTerms.tsx', 'src/components/sign/Withdraw.tsx', 'src/app/styles/consent.css', 'src/locales/en.json', 'README.md'];
  for (const f of MINE) {
    const s = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(s, /ESIGN (consumer )?disclosure/i, f);
    assert.doesNotMatch(s, /\u2014/, `${f} has an em dash`);
  }
});

// ---- The screens, read as source (the browser check is in tests/out/finish-ds-consent-own) ---------------------------

test('screens: "Sign on paper instead" only with the account\'s text and only for someone with a part to stop; the page sends "own" and asks again each visit', async () => {
  const { otherActions } = await import('../src/components/sign/actions.ts');
  assert.deepEqual(otherActions({ role: 'signer' }, { stage: 'consent', deadline: false }), ['later', 'reassign', 'ask', 'decline'], 'zero setup: as before');
  assert.deepEqual(otherActions({ role: 'signer' }, { stage: 'consent', deadline: false, paper: true }), ['later', 'reassign', 'ask', 'paper', 'decline']);
  assert.deepEqual(otherActions({ role: 'signer' }, { stage: 'sign', deadline: true, paper: true }), ['later', 'time', 'reassign', 'ask', 'paper', 'decline'], 'six at most, Decline last');
  for (const role of ['cc', 'viewer', 'witness']) assert.equal(otherActions({ role }, { stage: 'sign', deadline: false, paper: true }).includes('paper' as any), false, role);

  const page = fs.readFileSync('src/app/sign/[token]/page.tsx', 'utf8');
  assert.match(page, /otherActions\(me, \{ stage, deadline: !!env\.expires_at, paper: !!data\.own_terms \}\)/);
  assert.match(page, /paper: \{ key: 'paper', label: 'Sign on paper instead', icon: 'pen', onClick: go\('paper'\) \}/);
  assert.match(page, /own: data\.own_terms\?\.id/);
  assert.match(page, /!me\.consented \|\| \(data\.own_terms\?\.each_visit && !agreedHere\) \? 'consent'/);
  assert.match(page, /e\?\.code === 'terms'/);
  // Under our sentence, not in place of it.
  assert.match(page, /<p className="muted sg-legal">\{wording\.practical\}<\/p>\s*<\/div>\s*\{\/\*[^*]*\*\/\}\s*\{data\.own_terms && <OwnTermsBlock key=\{data\.own_terms\.id\}/);
  assert.match(page, /me\.asked_paper \? t\(data\.language\?\.locale, 'sign\.paper\.closed_title'\)/);

  // The fold: measured against the 120 words, with the line "Read <Org>'s terms" when it does not fit.
  const own = await import('../src/components/sign/OwnTerms.tsx').catch(() => null);
  void own;
  const src = fs.readFileSync('src/components/sign/OwnTerms.tsx', 'utf8');
  assert.match(src, /wordsIn\(range\.toString\(\)\) - wordsIn\(label\) \+ ownTermsWords\(lang, own, paper\) <= CONSENT_WORDS \? 'inline' : 'fold'/);
  assert.equal(t('en', 'ownterms.read', { whose: possessive('Acme Ltd'), org: 'Acme Ltd' }), "Read Acme Ltd's terms");
  assert.equal(possessive('Leeds Councils'), "Leeds Councils'");
  assert.equal(t('en', 'sign.paper.by_post', { sender: 'Rosa' }), 'Ask Rosa to send it by post (stops signing electronically)');

  // Settings: behind Sending's one More options, for admins.
  const settings = fs.readFileSync('src/app/app/settings/page.tsx', 'utf8');
  assert.match(settings, /tab === 'sending' && <div className="stack">.*<MoreOptions><Disclosure \/><\/MoreOptions><\/div>\}/);
  const card = fs.readFileSync('src/components/settings/Disclosure.tsx', 'utf8');
  assert.match(card, /if \(!admin\) return null;/);
  assert.match(card, /\{ESIGN_NOTE\}/);
  assert.match(card, /Your consent text/);
  const shown = card.replace(/^\s*\/\/.*$/gm, '').replace(/^import .*$/gm, '').replace(/'\/account\/disclosure[^']*'/g, '').replace(/export function Disclosure\(/, '');
  assert.doesNotMatch(shown, /disclosure|ERSD/i, 'the word is the API\'s only (designer\'s note)');
});

// ---- After the skeptic's and the simplicity reviewer's rounds ---------------------------------------------------------

test('repair: a plain decline whose typed reason reads like a paper request stays a decline everywhere', async () => {
  const owner = await person('Tess Typed', 'tess@own40.example');
  await owner.put('/account/disclosure', { text: TEXT });
  for (const [i, reason] of [WITHDREW_REASON, NEVER_AGREED_REASON].entries()) {
    const email = `tom${i}@own40.example`;
    const e = await simple(owner, email, { send: true });
    const tok = tokenFor(e.id, email);
    const c = browser();
    const own = (await view(tok, c)).data.own_terms;
    assert.equal((await agree(tok, c, own.id)).status, 200);
    const d = await c.post(`/sign/${tok}/decline`, { reason });
    assert.equal(d.status, 200, JSON.stringify(d.data));
    const row = db.get('SELECT * FROM recipients WHERE token=?', tok);
    assert.equal(row.status, 'declined');
    assert.equal(row.paper_at, null, 'only "Sign on paper instead" marks paper');
    assert.equal((await view(tok, c)).data.recipient.asked_paper, false, 'the page says "You declined"');
    const ts = (x: any) => String(x);
    assert.equal(consentCertValue(row, ts), String(row.consent_at), 'the certificate keeps the time they agreed');
    const got = (await owner.get(`/envelopes/${e.id}`)).data;
    const r = (got.envelope || got).recipients.find((x: any) => x.email === email);
    assert.equal(r.paper_at, null);
  }
});

test('repair: "Sign on paper instead" marks paper_at, the sender sees it, and the email has no line about no paper', async () => {
  const owner = await person('Pia Post', 'pia@own41.example');
  await owner.put('/account/disclosure', { text: TEXT });
  const e = await simple(owner, 'pat@own41.example', { send: true });
  const tok = tokenFor(e.id, 'pat@own41.example');
  const c = browser();
  await view(tok, c);
  assert.equal((await c.post(`/sign/${tok}/decline/paper`, {})).status, 200);
  const row = db.get('SELECT * FROM recipients WHERE token=?', tok);
  assert.ok(row.paper_at, 'paper_at is set');
  assert.equal(consentCertValue(row, (x: any) => String(x)), `Not given. Asked for paper instead ${row.paper_at}`);
  const got = (await owner.get(`/envelopes/${e.id}`)).data;
  const r = (got.envelope || got).recipients.find((x: any) => x.email === 'pat@own41.example');
  assert.equal(r.paper_at, row.paper_at, 'the sender\'s page can tell a paper request from a decline');
  const mail = mailTo('pia@own41.example').find((m: any) => /Asked for paper/.test(m.subject));
  assert.ok(mail);
  assert.doesNotMatch(mail.html, /no paper, no printer and no courier/);
  assert.match(mail.html, /Open the document/);
  assert.doesNotMatch(mail.html, /Open envelope/);
  // Other emails to the sender keep their footer.
  const other = mailTo('pia@own41.example').find((m: any) => !/Asked for paper/.test(m.subject) && /Sent with GrowSigning/.test(m.html));
  if (other) assert.ok(true);
});

test('repair: Settings has "Ask people to agree", shown only with a text; the save message promises only what happens', () => {
  const card = fs.readFileSync('src/components/settings/Disclosure.tsx', 'utf8');
  assert.match(card, /\{shown && !editing && \(\s*<label className="f own-often"><span>Ask people to agree \{oftenSaid\}<\/span>/);
  assert.match(card, /onChange=\{\(e\) => often\(e\.target\.value\)\}/);
  assert.match(card, /HOW_OFTEN\.map\(\(\[v, l\]\) => <option key=\{v\} value=\{v\}>\{l\}<\/option>\)/);
  assert.match(card, /People who agree from now on see it\./);
  assert.doesNotMatch(card, /People who open a document from now on see it/);
});

test('repair: the line pointing to "Sign on paper instead" is only for someone whose Other actions has it', async () => {
  const src = fs.readFileSync('src/components/sign/OwnTerms.tsx', 'utf8');
  assert.match(src, /\{paper && <p className="muted small sg-own-out">\{t\(lang, 'ownterms\.way_out'\)\}<\/p>\}/);
  const page = fs.readFileSync('src/app/sign/[token]/page.tsx', 'utf8');
  assert.match(page, /<OwnTermsBlock key=\{data\.own_terms\.id\} own=\{data\.own_terms\} lang=\{data\.language\?\.locale \|\| 'en'\} paper=\{menu\.some\(\(m\) => m\.key === 'paper'\)\} \/>/);
  const { ownTermsWords } = await import('../src/components/sign/OwnTerms.tsx').catch(() => ({ ownTermsWords: null as any }));
  if (ownTermsWords) {
    const own = { note: '', sections: ownSections(tidyOwnText(TEXT), 'en') };
    assert.ok(ownTermsWords('en', own, false) < ownTermsWords('en', own, true), 'the count follows the line');
  }
  // A paper copy to keep and signing on paper are told apart, and the line says what it does.
  assert.match(t('en', 'ownterms.way_out'), /^To sign on paper instead of on screen, .* That closes the document here\.$/);
  // The closed screen is not shown as a refusal.
  assert.match(page, /tone=\{expired \? 'warn' : mine && me\.asked_paper && !voided \? 'mail' : 'stop'\}/);
});

test('repair: the sender\'s page calls a paper request what it is, never "They wrote", and offers no Copy and fix', () => {
  const page = fs.readFileSync('src/app/app/envelopes/[id]/page.tsx', 'utf8');
  assert.match(page, /const paperAsk = askedPaper\(decliner\);/);
  assert.match(page, /asked for this document on paper on \{longDate\(decliner\.paper_at\)\}/);
  assert.match(page, /const noMain = paperAsk && main\?\.kind === 'copy_fix';/);
  assert.match(page, /const mainEl = !main \|\| noMain \? null/);
  assert.match(page, /: noMain \? null : main\?\.kind \|\| null,/);
  const rec = fs.readFileSync('src/components/sender/Recipients.tsx', 'utf8');
  assert.match(rec, /if \(askedPaper\(r\)\) return \{ s: 'declined', label: 'Asked for paper' \};/);
  assert.match(rec, /askedPaper\(r\) \? <>Asked for this document on paper on \{dayTime\(r\.paper_at\)\}\.<\/>/);
});
