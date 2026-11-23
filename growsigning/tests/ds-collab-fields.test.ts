// Fields anyone on the document can fill in (src/lib/collab.ts, src/server/collab.ts): marking a field so, two people
// changing it, the audit lines with who and the value before, a screen that is out of date never undoing a change,
// refusal after someone finished, the sign-again path, initials on a change, the signed PDF and the certificate.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, tokenFor, mailTo, PNG, type Server } from './helpers.ts';
import { sharedNote, saidValue, isShared, listNames, withoutHeld, initialsFirst, groupOf, holdsChange, SHARED_MAX } from '../src/lib/collab.ts';
import { changerWords } from '../src/lib/recipienttypes.ts';
import { readFileSync } from 'node:fs';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.97.${++n}.7`);

async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push(...(await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str));
    return out.join('\n');
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// Two signers at once and a copy; a shared text field and a shared tick box that asks for initials.
async function envelope(c: Client, tag: string, over: { after?: boolean; ordered?: boolean } = {}) {
  const file = await upload(c);
  const r = await c.post('/envelopes', {
    subject: `Shared ${tag}`, ordered: !!over.ordered,
    documents: [{ id: 'd1', file_id: file.id }],
    recipients: [
      { id: 'r1', role: 'signer', name: 'Ada Shared', email: `ada.${tag}@example.com`, routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Ben Shared', email: `ben.${tag}@example.com`, routing_order: 2 },
      { id: 'r3', role: 'cc', name: 'Cee Copy', email: `cee.${tag}@example.com`, routing_order: 3 },
    ],
    fields: [
      { id: 'fa', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'fb', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'fs', document_id: 'd1', recipient_id: 'r1', type: 'text', label: 'Tree kind', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.03, shared: true, shared_after: !!over.after },
      { id: 'fk', document_id: 'd1', recipient_id: 'r1', type: 'checkbox', label: 'Extra trees', page: 0, x: 0.1, y: 0.6, w: 0.03, h: 0.02, shared: true, shared_initials: true, shared_after: !!over.after },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const fid = (key: string) => e.fields.find((f: any) => f.label === key).id;
  return { id: e.id, text: fid('Tree kind'), box: fid('Extra trees'), ada: `ada.${tag}@example.com`, ben: `ben.${tag}@example.com`, cee: `cee.${tag}@example.com` };
}

async function opened(envelopeId: string, email: string) {
  const c = new Client();
  c.ip = `10.98.${++n}.9`;
  const tok = tokenFor(envelopeId, email);
  assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
  const view = (await c.get(`/sign/${tok}`)).data;
  return { c, tok, view, save: (values: any, more: any = {}) => c.post(`/sign/${tok}/save`, { values, ...more }), reload: async () => (await c.get(`/sign/${tok}`)).data };
}
const finish = (s: { c: Client; tok: string; view: any }, values: any = {}) => s.c.post(`/sign/${s.tok}/complete`, { values: { ...Object.fromEntries(s.view.fields.filter((f: any) => f.type === 'signature').map((f: any) => [f.id, '1'])), ...values }, signature_png: PNG, initials_png: PNG });
const lines = (envelopeId: string) => db.all("SELECT actor, detail FROM audit WHERE envelope_id=? AND action='Field changed by anyone on the document' ORDER BY seq", envelopeId);

test('the words: one note under the field, values said plainly, no em dashes', () => {
  assert.equal(sharedNote({}), 'Anyone on the document can fill it in.');
  assert.equal(sharedNote({ last_by: 'Ada' }), 'Anyone on the document can fill it in. Last changed by Ada.');
  assert.equal(sharedNote({ locked_by: ['Ada', 'Ben'] }), 'Ada and Ben already finished, so this can no longer be changed.');
  assert.match(sharedNote({ sign_again: ['Ada'], initials_on_change: true }), /If you change it, Ada is asked to sign again when you finish\. Changing an answer needs your initials\.$/);
  assert.equal(listNames(['A', 'B', 'C']), 'A, B and C');
  assert.equal(saidValue('checkbox', '1'), 'ticked');
  assert.equal(saidValue('text', ''), 'empty');
  assert.equal(saidValue('text', 'Oak'), '"Oak"');
  assert.ok(!isShared({ type: 'signature', shared: 1 }), 'a signature is never shared');
  for (const s of [sharedNote({ sign_again: ['A'], last_by: 'B', initials_on_change: true }), sharedNote({ locked_by: ['A'] })]) assert.ok(!s.includes('\u2014'));
});

test('marking a field: refused where it cannot work, kept across saves, templates and copies', async () => {
  const s = await person('Sol Sender', 'sol.collab@example.com');
  const file = await upload(s);
  const base = {
    subject: 'Refusals', documents: [{ id: 'd1', file_id: file.id }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Ada', email: 'ada.ref@example.com' }, { id: 'r2', role: 'cc', name: 'Cy', email: 'cy.ref@example.com' }],
  };
  const f = (x: any) => ({ id: 'fx', document_id: 'd1', recipient_id: 'r1', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.03, ...x });
  const no = async (x: any, re: RegExp) => {
    const r = await s.post('/envelopes', { ...base, fields: [f(x)] });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
    assert.match(r.data.error, /Nothing was saved\./);
  };
  await no({ type: 'signature', shared: true }, /Only text, choice, dropdown and tick-box fields/);
  await no({ type: 'text', shared: true, readonly: true }, /read only/);
  await no({ type: 'text', shared: true, recipient_id: 'r2' }, /Cy does not sign/);
  await no({ type: 'text', shared: 'perhaps' }, /"shared" is true or false/);
  await no({ type: 'text', shared: true, link: 'same' }, /Same answer as/);
  // A group of choices is one answer: all of it for anyone or none of it.
  const r = await s.post('/envelopes', { ...base, fields: [f({ type: 'radio', group_name: 'Size', shared: true }), f({ id: 'fy', type: 'radio', group_name: 'Size' })] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /whole group/);
  // Kept, not required, and a save without "shared" keeps it.
  const ok = await s.post('/envelopes', { ...base, fields: [f({ type: 'text', shared: true, shared_initials: true, required: true })] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const e = ok.data.envelope;
  const kept = await s.put(`/envelopes/${e.id}`, { fields: e.fields.map(({ shared: _s, shared_initials: _i, ...x }: any) => x) });
  assert.equal(kept.status, 200, JSON.stringify(kept.data));
  const row = db.get('SELECT shared, shared_initials, required FROM fields WHERE envelope_id=?', e.id);
  assert.deepEqual({ ...row }, { shared: 1, shared_initials: 1, required: 0 });
  // A template keeps it, and so does what is made from it, and a plain copy.
  const tpl = await s.post(`/envelopes/${e.id}/clone`, { kind: 'template' });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  assert.ok(db.get('SELECT 1 x FROM fields WHERE envelope_id=? AND shared=1 AND shared_initials=1', tpl.data.id), 'the template keeps the field for anyone');
  const fromTpl = await s.post('/envelopes', { template_id: tpl.data.id, subject: 'From the template' });
  assert.equal(fromTpl.status, 200, JSON.stringify(fromTpl.data));
  assert.ok(db.get('SELECT 1 x FROM fields WHERE envelope_id=? AND shared=1 AND shared_initials=1', fromTpl.data.envelope?.id || fromTpl.data.id), 'an envelope from the template keeps it');
  const clone = await s.post(`/envelopes/${e.id}/clone`);
  assert.equal(clone.status, 200, JSON.stringify(clone.data));
  assert.ok(db.get('SELECT 1 x FROM fields WHERE envelope_id=? AND shared=1 AND shared_initials=1', clone.data.id || clone.data.envelope?.id));
});

test('two people change it: each change on the record with who and the value before; the page shows who changed it last', async () => {
  const s = await person('Sue Sender', 'sue.collab@example.com');
  const x = await envelope(s, 'two');
  const ada = await opened(x.id, x.ada);
  const ben = await opened(x.id, x.ben);
  // Both get the field to fill in, not as somebody else's.
  for (const v of [ada.view, ben.view]) {
    const f = v.fields.find((g: any) => g.id === x.text);
    assert.ok(f && f.shared && !f.required, JSON.stringify(v.fields.map((g: any) => g.id)));
    assert.ok(!v.others.some((g: any) => g.id === x.text));
  }
  const cee = (await new Client().get(`/sign/${tokenFor(x.id, x.cee)}`)).data;
  assert.ok(!(cee.fields || []).some((g: any) => g.id === x.text), 'someone who gets a copy fills nothing in');

  assert.equal((await ada.save({ [x.text]: 'Oak' })).status, 200);
  const b2 = await ben.reload();
  const seen = b2.fields.find((g: any) => g.id === x.text);
  assert.equal(seen.value, 'Oak');
  assert.equal(seen.last_by, 'Ada Shared');
  const saved = await ben.save({ [x.text]: 'Mangrove' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.shared.changed, 1);
  const l = lines(x.id);
  assert.equal(l.length, 2);
  assert.match(l[0].detail, /Ada Shared changed "Tree kind" on page 1.*Before: empty\. After: "Oak"\./);
  assert.match(l[1].detail, /Ben Shared changed "Tree kind".*Before: "Oak"\. After: "Mangrove"\./);
  assert.equal((await ada.reload()).fields.find((g: any) => g.id === x.text).last_by, 'Ben Shared');

  // Ada's screen still showed "Oak". Her autosave sends it back: that undoes nothing.
  // (What her screen was given when she loaded it, before Ben's change.)
  db.run('UPDATE recipients SET shared_shown=? WHERE email=? AND envelope_id=?', JSON.stringify({ [x.text]: 'Oak', [x.box]: '' }), x.ada, x.id);
  assert.equal((await ada.save({ [x.text]: 'Oak' })).status, 200);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.text).value, 'Mangrove', 'a screen that is out of date never undoes a change');
  // A change typed on top of that old value is refused, and says what it says now.
  const clash = await ada.save({ [x.text]: 'Willow' });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.code, 'changed');
  assert.match(clash.data.error, /Ben Shared changed "Tree kind" while you had the document open\. It now says "Mangrove"\./);
  // Nor does she finish on the value she has not seen.
  const f1 = await finish(ada);
  assert.equal(f1.status, 409, JSON.stringify(f1.data));
  assert.equal(f1.data.why, 'shared');
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', x.id, x.ada).status, 'viewed');
  // Once the page is loaded again she can.
  await ada.reload();
  const f2 = await finish(ada);
  assert.equal(f2.status, 200, JSON.stringify(f2.data));
});

test('refused after someone finished, unless the sender allows it; nothing changes what the earlier signer agreed to', async () => {
  const s = await person('Sid Sender', 'sid.collab@example.com');
  const x = await envelope(s, 'lock');
  const ada = await opened(x.id, x.ada);
  assert.equal((await ada.save({ [x.text]: 'Oak' })).status, 200);
  assert.equal((await finish(ada)).status, 200);
  const ben = await opened(x.id, x.ben);
  const f = ben.view.fields.find((g: any) => g.id === x.text);
  assert.ok(f.readonly && f.locked_by.includes('Ada Shared'), 'the page shows it cannot change, and why');
  const r = await ben.save({ [x.text]: 'Mangrove' }, { sign_again: true });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'shared_locked');
  assert.match(r.data.error, /Ada Shared already finished, so "Tree kind" can no longer be changed\. Nothing was saved\./);
  // Not through Finish either.
  const fin = await finish(ben, { [x.text]: 'Mangrove' });
  assert.equal(fin.status, 409);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.text).value, 'Oak');
  assert.equal(lines(x.id).length, 1);
});

test('the sign-again path: the change waits for a yes, then everyone who finished is asked to sign again', async () => {
  const s = await person('Sam Sender', 'sam.collab@example.com');
  const x = await envelope(s, 'again', { after: true });
  const ada = await opened(x.id, x.ada);
  assert.equal((await ada.save({ [x.text]: 'Oak' })).status, 200);
  assert.equal((await finish(ada)).status, 200);
  const ben = await opened(x.id, x.ben);
  assert.deepEqual(ben.view.fields.find((g: any) => g.id === x.text).sign_again, ['Ada Shared']);
  const ask = await ben.save({ [x.text]: 'Mangrove' });
  assert.equal(ask.status, 409);
  assert.equal(ask.data.code, 'shared_sign_again');
  assert.deepEqual(ask.data.sign_again, ['Ada Shared']);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.text).value, 'Oak', 'nothing changed without the yes');
  const before = mailTo(x.ada).length;
  const yes = await ben.save({ [x.text]: 'Mangrove' }, { sign_again: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.deepEqual(yes.data.shared.sign_again, ['Ada Shared']);
  const a = db.get('SELECT status, signed_before, free FROM recipients WHERE envelope_id=? AND email=?', x.id, x.ada);
  assert.equal(a.status, 'sent', 'Ada is asked again');
  assert.ok(a.signed_before && a.free === 1, 'her first signature is on record and signing again costs nothing more');
  const kept = db.get('SELECT answers, copy_sha256, changed_by FROM earlier_signatures WHERE envelope_id=?', x.id);
  assert.ok(kept.copy_sha256, 'a copy of what she signed is kept');
  assert.match(kept.answers, /Oak/);
  assert.equal(kept.changed_by, 'Ben Shared');
  const mail = mailTo(x.ada).slice(before);
  assert.ok(mail.some((m: any) => /Changed after you finished/.test(m.subject)), JSON.stringify(mail.map((m: any) => m.subject)));
  // Ben signs too: the email never says the sender asked him to check it.
  assert.ok(mail.some((m: any) => /Ben Shared, who also signs it, changed the document/.test(m.html)), mail.map((m: any) => m.html).join('\n'));
  assert.ok(!mail.some((m: any) => /asked to check it/.test(m.html)));
  assert.equal((await opened(x.id, x.ada)).view.recipient.changed_by_signer, true);
  assert.ok(mail.some((m: any) => /Ben Shared/.test(m.html) && /Mangrove/.test(m.html)), 'the email says who changed what');
  assert.ok(db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Asked to sign again'", x.id));
  assert.match(lines(x.id).at(-1).detail, /Before: "Oak"\. After: "Mangrove"\. Ada Shared had already finished and is asked to sign again\./);
  // Ada looks again and signs again; Ben finishes; the PDF prints the final answer and the certificate lists the changes.
  const ada2 = await opened(x.id, x.ada);
  assert.equal(ada2.view.fields.find((g: any) => g.id === x.text).value, 'Mangrove');
  assert.equal((await finish(ada2)).status, 200);
  const bf = await finish(await opened(x.id, x.ben));
  assert.equal(bf.status, 200, JSON.stringify(bf.data));
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', x.id).status, 'completed');
  const pdf = await s.call('GET', `/envelopes/${x.id}/download`);
  assert.equal(pdf.status, 200);
  const text = await pdfText(pdf.data);
  assert.match(text, /Mangrove/);
  assert.match(text, /Changed by anyone/);
  assert.match(text.replace(/\s+/g, ' '), /Ben Shared on .*"Oak" to "Mangrove"/);
});

test('initials on a change: not for the first answer, asked for a change, kept with it, said on the record', async () => {
  const s = await person('Sky Sender', 'sky.collab@example.com');
  const x = await envelope(s, 'ini');
  const ben = await opened(x.id, x.ben);
  assert.ok(ben.view.fields.find((g: any) => g.id === x.box).initials_on_change);
  // The first answer in an empty field needs no initials, on the server and on the page.
  assert.equal(initialsFirst(ben.view.fields.find((g: any) => g.id === x.box), null), false);
  const first = await ben.save({ [x.box]: '1' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(db.get('SELECT initials_png FROM shared_changes WHERE field_id=?', x.box).initials_png, null);
  // Changing an answer that is there does.
  const again = await ben.reload();
  assert.equal(initialsFirst(again.fields.find((g: any) => g.id === x.box), null), true);
  const no = await ben.save({ [x.box]: '' });
  assert.equal(no.status, 400);
  assert.equal(no.data.code, 'initials_for_change');
  assert.match(no.data.error, /Add your initials to change "Extra trees"/);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.box).value, '1');
  const yes = await ben.save({ [x.box]: '' }, { initials_png: PNG });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(db.all('SELECT 1 FROM shared_changes WHERE field_id=? AND initials_png IS NOT NULL', x.box).length, 1);
  assert.match(lines(x.id).at(-1).detail, /Before: ticked\. After: not ticked\. They added their initials to the change\./);
  // Saved initials of theirs count for the next change.
  assert.equal((await ben.save({ [x.box]: '1' })).status, 200);
  assert.equal((await ben.save({ [x.box]: '' })).status, 200);
  assert.equal(db.all('SELECT 1 FROM shared_changes WHERE field_id=? AND initials_png IS NOT NULL', x.box).length, 2);
});

test('abuse: someone who only gets a copy, a field of another envelope, a stranger link, and a flood of values change nothing', async () => {
  const s = await person('Sal Sender', 'sal.collab@example.com');
  const x = await envelope(s, 'abuse');
  const y = await envelope(s, 'other');
  const ben = await opened(x.id, x.ben);
  // A shared field of another envelope: not this one's, ignored.
  assert.equal((await ben.save({ [y.text]: 'Hijack' })).status, 200);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', y.text).value, null);
  // Too long for a text field: refused, nothing written.
  const long = await ben.save({ [x.text]: 'x'.repeat(5000) });
  assert.ok(long.status === 200 || long.status === 400);
  assert.ok((db.get('SELECT value FROM fields WHERE id=?', x.text).value || '').length <= 4000);
  // A link that is not a link.
  assert.equal((await new Client().post('/sign/not-a-token/save', { values: { [x.text]: 'x' } })).status >= 400, true);
  // The sender's correction keeps what people typed.
  assert.equal((await ben.save({ [x.text]: 'Elm' })).status, 200);
  const e = (await s.get(`/envelopes/${x.id}`)).data.envelope;
  const put = await s.put(`/envelopes/${x.id}`, { fields: e.fields.map((f: any) => (f.id === x.text ? { ...f, value: 'Sender says' } : f)) });
  assert.ok(put.status === 200, JSON.stringify(put.data));
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.text).value, 'Elm');
});

// ---- After the skeptic and the simplicity review ---------------------------------------------------------------

// Two signers and a shared group of two choices (Small, Large) and a shared dropdown.
async function radios(c: Client, tag: string, over: { after?: boolean } = {}) {
  const file = await upload(c);
  const r = await c.post('/envelopes', {
    subject: `Group ${tag}`, documents: [{ id: 'd1', file_id: file.id }],
    recipients: [
      { id: 'r1', role: 'signer', name: 'Ada Group', email: `ada.${tag}@example.com` },
      { id: 'r2', role: 'signer', name: 'Ben Group', email: `ben.${tag}@example.com` },
    ],
    fields: [
      { id: 'fa', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06, required: true },
      { id: 'fb', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06, required: true },
      { id: 'ra', document_id: 'd1', recipient_id: 'r1', type: 'radio', group_name: 'Size', label: 'Small', page: 0, x: 0.1, y: 0.3, w: 0.03, h: 0.02, shared: true, shared_after: !!over.after },
      { id: 'rb', document_id: 'd1', recipient_id: 'r1', type: 'radio', group_name: 'Size', label: 'Large', page: 0, x: 0.2, y: 0.3, w: 0.03, h: 0.02, shared: true, shared_after: !!over.after },
      { id: 'dd', document_id: 'd1', recipient_id: 'r1', type: 'dropdown', label: 'Colour', options: ['Red', 'Green'], page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.03, shared: true, shared_after: !!over.after },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const fid = (key: string) => e.fields.find((f: any) => f.label === key).id;
  return { id: e.id, small: fid('Small'), large: fid('Large'), dd: fid('Colour'), ada: `ada.${tag}@example.com`, ben: `ben.${tag}@example.com` };
}

test('a screen that is out of date never takes someone else\'s choice off in a shared group', async () => {
  const s = await person('Gus Sender', 'gus.collab@example.com');
  const x = await radios(s, 'grp');
  const ada = await opened(x.id, x.ada);
  const ben = await opened(x.id, x.ben); // his screen shows the group empty
  assert.equal((await ada.save({ [x.small]: '1', [x.large]: '' })).status, 200);
  // What his page sends when he picks Large: Large on, Small off (pickRadio).
  const r = await ben.save({ [x.large]: '1', [x.small]: '' });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'changed');
  assert.match(r.data.error, /Ada Group changed "Small" while you had the document open\. It now says chosen\./);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.small).value, '1', 'Ada\'s choice stays');
  // Once his page has loaded again, his choice goes through and takes hers off, on the record as his.
  await ben.reload();
  assert.equal((await ben.save({ [x.large]: '1', [x.small]: '' })).status, 200);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.small).value, null);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.large).value, '1');
});

test('a dropdown answer that is not one of its options is refused, never quietly emptied', async () => {
  const s = await person('Dot Sender', 'dot.collab@example.com');
  const x = await radios(s, 'opt');
  const ada = await opened(x.id, x.ada);
  assert.equal((await ada.save({ [x.dd]: 'Red' })).status, 200);
  const r = await ada.save({ [x.dd]: 'Purple' });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'not_an_option');
  assert.match(r.data.error, /"Colour" has no option "Purple"\. Choose one of its options\. Nothing was saved\./);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.dd).value, 'Red');
});

test('one person\'s changes have a limit, said plainly', async () => {
  const s = await person('Lim Sender', 'lim.collab@example.com');
  const x = await radios(s, 'cap');
  const ada = await opened(x.id, x.ada);
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', x.id, x.ada).id;
  for (let i = 0; i < SHARED_MAX; i++) db.run("INSERT INTO shared_changes (envelope_id, field_id, recipient_id, name, at) VALUES (?,?,?,?,?)", x.id, x.dd, rid, 'Ada Group', new Date().toISOString());
  const r = await ada.save({ [x.dd]: 'Green' });
  assert.equal(r.status, 429, JSON.stringify(r.data));
  assert.equal(r.data.code, 'shared_limit');
  assert.match(r.data.error, /which is as many as we keep\. Nothing more was saved\. If something still needs to change, tell Lim Sender/);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.dd).value, null);
  // The other person is not held back by her changes.
  assert.equal((await (await opened(x.id, x.ben)).save({ [x.dd]: 'Green' })).status, 200);
});

test('a Finish that is refused asks nobody to sign again and changes nothing', async () => {
  const s = await person('Fin Sender', 'fin.collab@example.com');
  const x = await radios(s, 'fin', { after: true });
  const ada = await opened(x.id, x.ada);
  assert.equal((await ada.save({ [x.dd]: 'Red' })).status, 200);
  assert.equal((await finish(ada)).status, 200);
  const ben = await opened(x.id, x.ben);
  const before = mailTo(x.ada).length;
  // No signature with Finish.
  const r = await ben.c.post(`/sign/${ben.tok}/complete`, { values: { [x.dd]: 'Green' }, sign_again: true });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /Your signature is missing\. Make it on the page, then finish again\. Nothing was changed\./);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.dd).value, 'Red');
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', x.id, x.ada).status, 'completed');
  assert.equal(mailTo(x.ada).length, before, 'nobody is emailed');
  // With the signature it goes through, and Ada is asked to sign again.
  const ok = await ben.c.post(`/sign/${ben.tok}/complete`, { values: { fb: '1', ...Object.fromEntries(ben.view.fields.filter((f: any) => f.type === 'signature').map((f: any) => [f.id, '1'])), [x.dd]: 'Green' }, signature_png: PNG, sign_again: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', x.dd).value, 'Green');
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', x.id, x.ada).status, 'sent');
});

test('the words of a refusal speak to a person, not to a program', async () => {
  const s = await person('Wes Sender', 'wes.collab@example.com');
  const x = await radios(s, 'words', { after: true });
  assert.equal((await finish(await opened(x.id, x.ada))).status, 200);
  const r = await (await opened(x.id, x.ben)).save({ [x.dd]: 'Green' });
  assert.equal(r.data.code, 'shared_sign_again');
  assert.match(r.data.error, /To go ahead, confirm that Ada Group will be asked to sign again\.$/);
  assert.ok(!/sign_again|true|"/.test(r.data.error.split('Nothing was saved.')[1]), r.data.error);
});

test('the page: the autosave holds a change that asks others to sign again, and the line is shown only while in the field', () => {
  const fields = [{ id: 'a', shared: true, sign_again: ['Ada'] }, { id: 'b', shared: true }, { id: 'c' }];
  assert.deepEqual(withoutHeld(fields, { a: 'Ma', b: 'x', c: 'y' }), { b: 'x', c: 'y' }, 'a half-typed change never asks anyone to sign again');
  assert.equal(holdsChange(fields[1]), false);
  assert.deepEqual(groupOf({ id: 'r1', type: 'radio', group_name: 'G', recipient_id: 'p' }, [{ id: 'r1', type: 'radio', group_name: 'G', recipient_id: 'p' }, { id: 'r2', type: 'radio', group_name: 'G', recipient_id: 'p' }, { id: 'r3', type: 'radio', group_name: 'H', recipient_id: 'p' }]), ['r1', 'r2']);
  assert.equal(changerWords('Ben', 'Liv', true), 'Ben, who also signs it,');
  assert.equal(changerWords('Ed', 'Liv'), 'Ed, who Liv asked to check it,');
  const page = readFileSync(new URL('../src/app/sign/[token]/page.tsx', import.meta.url), 'utf8');
  const flush = page.slice(page.indexOf('const flush = useCallback'), page.indexOf('const res = await fetch(`/api${base}/save`'));
  assert.ok(!/sign_again/.test(flush.replace(/\/\/.*$/gm, '')), 'the autosave never says yes to asking someone to sign again');
  assert.match(flush, /body\.values = autosaved\(heldFields\.current, body\.values\);/);
  const notes = readFileSync(new URL('../src/components/sign/SharedNotes.tsx', import.meta.url), 'utf8');
  assert.match(notes, /if \(!shared\.length \|\| !at\) return null;/, 'no line over the document while the person is elsewhere');
  assert.match(notes, /role="note" tabIndex=\{0\} aria-label=\{said\}/, 'a locked field says what it says and why');
  const css = readFileSync(new URL('../src/app/styles/sign.css', import.meta.url), 'utf8');
  assert.match(css, /\.field\.sg-locked \{/);
  const sheet = readFileSync(new URL('../src/components/sign/dialogs.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /field\.shared \? `Optional\. \$\{sharedNote\(field\)\}`/, 'the phone typing box says it too');
});

test('the editor: no setting the server would refuse, a whole group at once, and a word about signing in order', () => {
  const ed = readFileSync(new URL('../src/components/editor/StepFields.tsx', import.meta.url), 'utf8');
  assert.match(ed, /\{!selected\.shared && <label className="check ed-tap"[^\n]*Read only<\/label>\}/);
  assert.match(ed, /\{!selected\.shared && <FieldLogic /);
  assert.match(ed, /onChange=\{\(e\) => assign\(selected, e\.target\.value\)\}/);
  assert.match(ed, /canvasWho\(f, open,/);
  assert.match(ed, /ordered=\{!!env\.ordered\}/);
  assert.match(readFileSync(new URL('../src/components/editor/FieldLook.tsx', import.meta.url), 'utf8'), /!dateFromOf\(field\) && !field\.shared \?/);
  assert.match(readFileSync(new URL('../src/components/editor/FieldChecks.tsx', import.meta.url), 'utf8'), /\{!field\.shared && <><label className="check ed-tap">/);
  const choice = readFileSync(new URL('../src/components/editor/SharedChoice.tsx', import.meta.url), 'utf8');
  assert.match(choice, /inOrder && !field\.shared_after && <p className="small" role="note"/);
  assert.match(choice, /useDropShared/);
});
