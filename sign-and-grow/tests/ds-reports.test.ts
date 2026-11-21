// Reports (by template, by sender, filters, CSV), the monthly report email, and saved lists for Send to many.
// src/server/reports.ts, routes-reports.ts, bulklists.ts, routes-bulklists.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, signUp, Client, type Server } from './helpers.ts';

let s: Server;
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ok = (r: { status: number; data: any }) => (assert.equal(r.status, 200, JSON.stringify(r.data)), r.data);

const accountOf = (email: string) => s.db.get('SELECT m.account_id a, u.id u FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', email);
let n = 0;
// One envelope as the database holds it, sent at `sent` and finished `hours` later (or not finished).
function seed(account: string, sender: string, o: { status: string; sent: string; hours?: number; template?: string | null; folder?: string; hidden?: boolean; kind?: string; subject?: string }) {
  const eid = `env_seed${++n}`;
  const done = o.status === 'completed' ? new Date(Date.parse(o.sent) + (o.hours ?? 1) * 3600_000).toISOString() : null;
  s.db.run('INSERT INTO envelopes (id, account_id, sender_id, kind, status, subject, created_at, updated_at, sent_at, completed_at, template_id, folder, hidden_at, sheets) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    eid, account, sender, o.kind || 'envelope', o.status, o.subject || 'Seeded', o.sent, o.sent, o.kind === 'template' ? null : o.sent, done, o.template ?? null, o.folder ?? null, o.hidden ? o.sent : null, o.status === 'completed' ? 2 : 0);
  return eid;
}

async function team(prefix: string, ip: string) {
  const owner = await signUp(`${prefix} Owner`, `${prefix}.owner@reports.example`, ip);
  ok(await owner.post('/account/invites', { email: `${prefix}.mem@reports.example`, role: 'member' }));
  const mem = new Client();
  mem.ip = ip.replace(/\d+$/, (d) => String(Number(d) + 1));
  ok(await mem.post('/auth/signup', { name: `${prefix} Member`, email: `${prefix}.mem@reports.example`, password: 'correct horse battery', invite: s.db.get('SELECT token FROM invites WHERE email=?', `${prefix}.mem@reports.example`).token }));
  const o = accountOf(`${prefix}.owner@reports.example`), m = accountOf(`${prefix}.mem@reports.example`);
  return { owner, mem, account: o.a, ownerId: o.u, memId: m.u };
}

test('boot', async () => {
  s = await boot();
});

test('1. numbers per template and per sender on a seeded account, deleted completed ones counted nowhere', async () => {
  const t = await team('ana', '198.51.100.10');
  const day = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h)).toISOString(); // October 2026
  const nda = seed(t.account, t.ownerId, { kind: 'template', status: 'draft', sent: day(1), subject: 'NDA' });
  const lease = seed(t.account, t.ownerId, { kind: 'template', status: 'draft', sent: day(1), subject: 'Lease' });
  // NDA: 4 sent by the owner, 3 finished in 2, 4 and 10 hours, 1 declined. One more finished, deleted by its sender.
  seed(t.account, t.ownerId, { status: 'completed', sent: day(2), hours: 2, template: nda, folder: 'Sales' });
  seed(t.account, t.ownerId, { status: 'completed', sent: day(3), hours: 4, template: nda, folder: 'Sales' });
  seed(t.account, t.ownerId, { status: 'completed', sent: day(4), hours: 10, template: nda });
  seed(t.account, t.ownerId, { status: 'declined', sent: day(5), template: nda });
  seed(t.account, t.ownerId, { status: 'completed', sent: day(6), hours: 1, template: nda, hidden: true });
  // Lease: 3 by the member, 1 finished in 30 hours, 1 waiting, 1 cancelled.
  seed(t.account, t.memId, { status: 'completed', sent: day(7), hours: 30, template: lease });
  seed(t.account, t.memId, { status: 'sent', sent: day(8), template: lease });
  seed(t.account, t.memId, { status: 'voided', sent: day(9), template: lease });
  // Without a template, by the member, ran out of time. A draft is never counted.
  seed(t.account, t.memId, { status: 'expired', sent: day(10), template: null });
  s.db.run("INSERT INTO envelopes (id, account_id, sender_id, kind, status, subject, created_at, updated_at) VALUES ('env_draft_r', ?, ?, 'envelope', 'draft', 'Draft', ?, ?)", t.account, t.ownerId, day(11), day(11));
  // From a template that was deleted since.
  seed(t.account, t.ownerId, { status: 'completed', sent: day(12), hours: 6, template: 'env_gone' });

  const r = ok(await t.owner.get('/reports?from=2026-10-01&to=2026-10-31'));
  assert.equal(r.totals.sent, 9, 'drafts and the deleted completed one are not counted');
  assert.equal(r.totals.completed, 5);
  assert.equal(r.totals.median_hours, 6, 'median of 2, 4, 6, 10 and 30 hours');
  assert.deepEqual(r.byStatus, { sent: 1, completed: 5, declined: 1, voided: 1, expired: 1 });
  const row = (list: any[], name: string) => list.find((x) => x.name === name);
  assert.deepEqual({ ...row(r.templates, 'NDA') }, { key: nda, name: 'NDA', sent: 4, completed: 3, declined: 1, voided: 0, expired: 0, waiting: 0, median_hours: 4 });
  assert.deepEqual(row(r.templates, 'Lease'), { key: lease, name: 'Lease', sent: 3, completed: 1, declined: 0, voided: 1, expired: 0, waiting: 1, median_hours: 30 });
  assert.equal(row(r.templates, 'Sent without a template').sent, 1);
  assert.equal(row(r.templates, 'A template that was deleted').completed, 1);
  assert.equal(r.templates[0].name, 'NDA', 'most sent first');
  assert.equal(row(r.senders, 'ana Owner').sent, 5);
  assert.equal(row(r.senders, 'ana Owner').completed, 4);
  assert.equal(row(r.senders, 'ana Member').sent, 4);
  assert.equal(r.may_see_senders, true);
  assert.deepEqual(r.months, [{ month: '2026-10', sent: 9, completed: 5 }]);
  assert.equal(r.impact.sheets, 10, 'the paper of the finished ones in the period');

  // The member sees their own sending only, with no table by sender, and cannot ask for a colleague's.
  const m = ok(await t.mem.get('/reports?from=2026-10-01&to=2026-10-31'));
  assert.equal(m.totals.sent, 4);
  assert.deepEqual(m.senders, []);
  assert.equal(m.may_see_senders, false);
  assert.deepEqual(m.choices.senders, []);
  assert.deepEqual(m.templates.map((x: any) => x.name).sort(), ['Lease', 'Sent without a template']);
  const peek = await t.mem.get(`/reports?from=2026-10-01&to=2026-10-31&sender=${t.ownerId}`);
  assert.equal(peek.status, 403);
  assert.match(peek.data.error, /Only the admins/);
  assert.equal(ok(await t.mem.get(`/reports?from=2026-10-01&to=2026-10-31&sender=${t.memId}`)).totals.sent, 4, 'their own id is fine');

  // Another account sees none of it.
  const other = await signUp('Oscar Other', 'oscar@reports.example', '198.51.100.30');
  assert.equal(ok(await other.get('/reports?from=2026-10-01&to=2026-10-31')).totals.sent, 0);

  // The summary for Home counts the same way: the deleted completed one is not there.
  const sum = ok(await t.owner.get('/reports/summary'));
  assert.equal(sum.completed, 5);
  assert.equal(sum.byStatus.draft, 1);
});

test('1. filters: dates, status, sender, template, folder and a custom field', async () => {
  const t = await team('flo', '198.51.100.40');
  const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12)).toISOString(); // November 2026
  const tpl = seed(t.account, t.ownerId, { kind: 'template', status: 'draft', sent: day(1), subject: 'Visit form' });
  const a = seed(t.account, t.ownerId, { status: 'completed', sent: day(2), hours: 3, template: tpl, folder: 'North' });
  seed(t.account, t.ownerId, { status: 'sent', sent: day(5), template: tpl, folder: 'South' });
  seed(t.account, t.memId, { status: 'declined', sent: day(10) });
  seed(t.account, t.memId, { status: 'completed', sent: new Date(Date.UTC(2026, 9, 31, 23, 59)).toISOString(), hours: 1 });
  s.db.run("INSERT INTO custom_values (envelope_id, document_id, name, name_key, value, value_key) VALUES (?, '', 'Case number', 'case number', '2026/114', '2026/114')", a);
  const q = async (qs: string) => ok(await t.owner.get(`/reports?from=2026-11-01&to=2026-11-30${qs}`)).totals;
  assert.equal((await q('')).sent, 3, 'the one sent on 31 October is outside');
  assert.equal(ok(await t.owner.get('/reports?from=2026-10-31&to=2026-10-31')).totals.sent, 1, 'a day is a whole UTC day');
  assert.equal((await q('&status=completed')).sent, 1);
  assert.equal((await q('&status=declined')).declined, 1);
  assert.equal((await q(`&sender=${t.memId}`)).sent, 1);
  assert.equal((await q(`&template=${tpl}`)).sent, 2);
  assert.equal((await q('&template=none')).sent, 1);
  assert.equal((await q('&folder=North')).sent, 1);
  assert.equal((await q('&field=Case%20number&value=2026%2F114')).sent, 1);
  assert.equal((await q('&field=Case%20number&value=2027')).sent, 0);
  const r = ok(await t.owner.get('/reports?from=2026-11-01&to=2026-11-30'));
  assert.deepEqual(r.choices.folders, ['North', 'South']);
  assert.deepEqual(r.choices.templates, [{ id: tpl, name: 'Visit form' }]);
  assert.equal(r.choices.senders.length, 2);

  // Without dates: the last 30 days, today included.
  const def = ok(await t.owner.get('/reports'));
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(def.to, today);
  assert.equal((Date.parse(def.to) - Date.parse(def.from)) / 86400_000, 29);

  // What a confused person types is answered in words.
  for (const [qs, words] of [['from=2026-13-01', /not a day we can read/], ['from=2026-11-30&to=2026-11-01', /comes after the last day/], ['status=done', /not a status/], ['from=2000-01-01&to=2026-11-01', /up to 3660 days/]] as const) {
    const bad = await t.owner.get(`/reports?${qs}`);
    assert.equal(bad.status, 400, qs);
    assert.match(bad.data.error, words);
  }
});

test('1. the CSV download holds what the page shows, and a name cannot run as a formula', async () => {
  const t = await team('cia', '198.51.100.50');
  const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12)).toISOString(); // September 2026
  const tpl = seed(t.account, t.ownerId, { kind: 'template', status: 'draft', sent: day(1), subject: '=HYPERLINK("http://evil.example","Click")' });
  seed(t.account, t.ownerId, { status: 'completed', sent: day(2), hours: 5, template: tpl });
  seed(t.account, t.memId, { status: 'declined', sent: day(3), template: tpl });
  const page = ok(await t.owner.get('/reports?from=2026-09-01&to=2026-09-30'));
  const res = await t.owner.get('/reports/csv?from=2026-09-01&to=2026-09-30');
  assert.equal(res.status, 200);
  const text = new TextDecoder().decode(res.data);
  const lines = text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Table,Name,Sent,Finished,Finished (%),Median time to finish (hours),Declined,Cancelled,Ran out of time,Waiting');
  assert.equal(lines[1], 'All,All documents,2,1,50,5.0,1,0,0,0');
  assert.equal(lines.length, 1 + 1 + page.templates.length + page.senders.length);
  assert.ok(lines[2].startsWith('Template,"\'=HYPERLINK('), 'a cell that starts with = gets a quote in front');
  assert.ok(lines.some((l) => l.startsWith('Sender,cia Owner,1,1')));
  // The member's CSV has no sender rows, and only their own documents.
  const mine = new TextDecoder().decode((await t.mem.get('/reports/csv?from=2026-09-01&to=2026-09-30')).data);
  assert.ok(!/\r\nSender,/.test(mine));
  assert.match(mine, /\r\nAll,All documents,1,0,0,,1,0,0,0\r\n/);
});

test('2. the monthly report email: admins who ask, once, last month, no recipient names', async () => {
  const { monthlyReports } = await import('../src/server/routes-reports.ts');
  const t = await team('mon', '198.51.100.60');
  // Asking: off by default, only for admins, offered once the account has sent something. A member is refused in words.
  assert.deepEqual(ok(await t.owner.get('/reports/monthly')), { may: false, on: false }, 'nothing sent yet: not offered');
  seed(t.account, t.ownerId, { status: 'sent', sent: '2026-09-01T10:00:00.000Z' });
  assert.deepEqual(ok(await t.owner.get('/reports/monthly')), { may: true, on: false });
  assert.deepEqual(ok(await t.mem.get('/reports/monthly')), { may: false, on: false });
  const no = await t.mem.put('/reports/monthly', { on: true });
  assert.equal(no.status, 403);
  assert.match(no.data.error, /for the owner and the admins/);
  assert.equal((await t.owner.put('/reports/monthly', { on: 'yes' })).status, 400);
  assert.deepEqual(ok(await t.owner.put('/reports/monthly', { on: true })), { on: true });
  assert.equal(ok(await t.owner.get('/reports/monthly')).on, true);
  s.db.run("UPDATE report_monthly SET on_at='2026-10-15T00:00:00.000Z' WHERE user_id=?", t.ownerId);

  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString(); // October 2026
  const tpl = seed(t.account, t.ownerId, { kind: 'template', status: 'draft', sent: day(1), subject: 'Volunteer form' });
  const e = seed(t.account, t.ownerId, { status: 'completed', sent: day(3), hours: 5, template: tpl });
  seed(t.account, t.memId, { status: 'sent', sent: day(4), template: tpl });
  seed(t.account, t.memId, { status: 'declined', sent: day(5), template: tpl });
  seed(t.account, t.ownerId, { status: 'completed', sent: new Date(Date.UTC(2026, 10, 1, 1)).toISOString(), hours: 1 }); // November: not in October's report
  s.db.run("INSERT INTO recipients (id, envelope_id, name, email) VALUES ('rcp_mon', ?, 'Rita Recipientname', 'rita@private.example')", e);
  const mails = () => s.db.all("SELECT subject, html FROM emails WHERE to_email=? AND subject LIKE '%your report for%'", 'mon.owner@reports.example');

  assert.equal(await monthlyReports(new Date('2026-11-05T08:00:00Z')), 0, 'only on the first days of a month');
  assert.equal(await monthlyReports(new Date('2026-11-01T06:00:00Z')), 1);
  const m = mails();
  assert.equal(m.length, 1);
  assert.equal(m[0].subject, 'mon Owner\'s account: your report for October 2026'.replace("mon Owner's account", s.db.get('SELECT name FROM accounts WHERE id=?', t.account).name));
  assert.match(m[0].html, /Your team sent 3 documents in October 2026\. 1 is finished, 1 declined, and 1 is still waiting for someone\./);
  assert.match(m[0].html, /Volunteer form: 3 sent, 1 finished, 1 declined, 1 still waiting/);
  assert.match(m[0].html, /\/app\/reports\?from=2026-10-01&amp;to=2026-10-31/);
  assert.ok(!/Rita|rita@private/.test(m[0].html), 'never the people documents went to');
  assert.ok(!/\u2014/.test(m[0].html.replace(/<style[\s\S]*?<\/style>/g, '')), 'no em dash');
  // Once: the next ticks of the same days send nothing more.
  assert.equal(await monthlyReports(new Date('2026-11-01T07:00:00Z')), 0);
  assert.equal(await monthlyReports(new Date('2026-11-02T07:00:00Z')), 0);
  assert.equal(mails().length, 1);

  // A member is never sent one, also when a row says so; an admin who is now a member stops getting it.
  s.db.run('INSERT INTO report_monthly (account_id, user_id, on_at) VALUES (?,?,?)', t.account, t.memId, '2026-01-01T00:00:00.000Z');
  s.db.run("UPDATE memberships SET role='member' WHERE user_id=? AND account_id=?", t.ownerId, t.account);
  assert.equal(await monthlyReports(new Date('2026-12-01T06:00:00Z')), 0);
  s.db.run("UPDATE memberships SET role='owner' WHERE user_id=? AND account_id=?", t.ownerId, t.account);
  // A month in which nothing was sent sends nothing.
  assert.equal(await monthlyReports(new Date('2027-02-01T06:00:00Z')), 0);
  // Switching it off.
  assert.deepEqual(ok(await t.owner.put('/reports/monthly', { on: false })), { on: false });
  assert.equal(s.db.get('SELECT COUNT(*) n FROM report_monthly WHERE user_id=?', t.ownerId).n, 0);
});

test('3. saved lists: save, reuse, who made it and when, team rules, limits', async () => {
  const t = await team('lis', '198.51.100.70');
  const csv = 'Volunteer name,Volunteer email\nAda Lovelace,ada@lists.example\nAlan Turing,alan@lists.example\n';
  const made = ok(await t.mem.post('/bulk-lists', { name: '  Volunteers   2026 ', csv, rows: 2 })).list;
  assert.equal(made.name, 'Volunteers 2026');
  assert.equal(made.rows, 2);
  assert.equal(made.created_by, 'lis Member');
  assert.ok(made.created_at && !made.used_at);
  assert.equal(Date.parse(made.deletes_at) - Date.parse(made.created_at), 180 * 86400_000);

  // The whole team sees it and can use it; using it is counted, and gives it another 180 days.
  const seen = ok(await t.owner.get('/bulk-lists'));
  assert.equal(seen.lists.length, 1);
  assert.equal(seen.days, 180);
  assert.match(seen.personal_data, /holds personal data/);
  assert.equal(seen.may_change_days, true);
  assert.equal(ok(await t.mem.get('/bulk-lists')).may_change_days, false);
  const open = ok(await t.owner.get(`/bulk-lists/${made.id}`)).list;
  assert.equal(open.csv, csv, 'kept exactly as it was pasted, so the page checks it against the template again');
  assert.ok(open.used_at);

  // Mistakes and abuse are answered in words, and nothing is saved.
  const refuse = async (b: any, words: RegExp, status = 400) => {
    const r = await t.owner.post('/bulk-lists', b);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, words);
  };
  await refuse({ name: 'volunteers 2026', csv }, /already a list called/, 409);
  await refuse({ name: '', csv }, /Give the list a name/);
  await refuse({ name: 'x'.repeat(81), csv }, /up to 80 characters/);
  await refuse({ name: 'Empty', csv: '  ' }, /The list is empty/);
  await refuse({ name: 'Binary', csv: 'a\u0000b' }, /not a text list/);
  await refuse({ name: 'Huge', csv: 'Name,Email\n' + 'A,a@b.example\n'.repeat(501) }, /up to 500 people/);
  await refuse({ name: 'Heavy', csv: 'x'.repeat(1_000_001) }, /larger than 1 MB/);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM bulk_lists WHERE account_id=?', t.account).n, 1);
  // A row count from the page beyond what the text holds is not believed.
  assert.equal(ok(await t.owner.post('/bulk-lists', { name: 'Counted', csv, rows: 9999 })).list.rows, 2);

  // Another account cannot see, open or delete it.
  const other = await signUp('Olga Other', 'olga@lists.example', '198.51.100.80');
  assert.equal(ok(await other.get('/bulk-lists')).lists.length, 0);
  assert.equal((await other.get(`/bulk-lists/${made.id}`)).status, 404);
  assert.equal((await other.call('DELETE', `/bulk-lists/${made.id}`)).status, 404);
  // A member deletes only their own; an admin any.
  const ownerList = s.db.get("SELECT id FROM bulk_lists WHERE name='Counted'").id;
  const nope = await t.mem.call('DELETE', `/bulk-lists/${ownerList}`);
  assert.equal(nope.status, 403);
  assert.match(nope.data.error, /Only the person who saved this list, or an admin/);
  ok(await t.owner.call('DELETE', `/bulk-lists/${ownerList}`));

  // The number of days: admins only, 30 to 730.
  assert.equal((await t.mem.put('/bulk-lists/settings', { days: 60 })).status, 403);
  for (const d of [29, 731, 'soon', 45.5]) assert.equal((await t.owner.put('/bulk-lists/settings', { days: d })).status, 400, String(d));
  assert.deepEqual(ok(await t.owner.put('/bulk-lists/settings', { days: 30 })), { days: 30, deleting: 0 });
  assert.equal(ok(await t.owner.get('/bulk-lists')).days, 30);

  // In the export, with who saved it.
  seed(t.account, t.ownerId, { status: 'declined', sent: new Date().toISOString() });
  const zip = Buffer.from((await t.owner.get('/export')).data);
  assert.ok(zip.includes(Buffer.from('lists/index.csv')));
  assert.ok(zip.includes(Buffer.from('lists/Volunteers 2026 ')));
  assert.ok(zip.includes(Buffer.from('the lists your team saved for Send to many')));
});

test('3. a list nobody used for the days is deleted; lists go with the account and lose a deleted login\'s name', async () => {
  const { purgeOldLists } = await import('../src/server/bulklists.ts');
  const t = await team('old', '198.51.100.90');
  const csv = 'Name,Email\nAda,ada@old.example\n';
  const a = ok(await t.owner.post('/bulk-lists', { name: 'Used', csv })).list;
  const b = ok(await t.owner.post('/bulk-lists', { name: 'Forgotten', csv })).list;
  const longAgo = new Date(Date.now() - 200 * 86400_000).toISOString();
  s.db.run('UPDATE bulk_lists SET created_at=? WHERE id IN (?,?)', longAgo, a.id, b.id);
  s.db.run('UPDATE bulk_lists SET used_at=? WHERE id=?', new Date(Date.now() - 10 * 86400_000).toISOString(), a.id);
  assert.equal(purgeOldLists(), 1);
  assert.deepEqual(ok(await t.owner.get('/bulk-lists')).lists.map((l: any) => l.name), ['Used']);
  // With 730 days set, the same age stays.
  ok(await t.owner.put('/bulk-lists/settings', { days: 730 }));
  s.db.run('UPDATE bulk_lists SET used_at=? WHERE id=?', longAgo, a.id);
  assert.equal(purgeOldLists(), 0);
  // The timer runs it. Lowering the number so that a list would go is said first, with how many, and changes nothing.
  const warn = await t.owner.put('/bulk-lists/settings', { days: 180 });
  assert.equal(warn.status, 409);
  assert.equal(warn.data.code, 'lists_would_be_deleted');
  assert.equal(warn.data.deleting, 1);
  assert.match(warn.data.error, /^1 saved list was not used in the last 180 days, so it would be deleted at the next check\..*Nothing was changed\.$/);
  assert.equal(ok(await t.owner.get('/bulk-lists')).days, 730);
  assert.deepEqual(ok(await t.owner.put('/bulk-lists/settings', { days: 180, confirm: true })), { days: 180, deleting: 1 });
  const r = await s.cron.tick();
  assert.equal((r as any).lists_deleted, 1);

  // A login that is deleted: its name goes from a team's list, the list stays.
  ok(await t.mem.post('/bulk-lists', { name: 'By member', csv }));
  const { purgeUser } = await import('../src/server/routes-trust.ts');
  purgeUser(t.memId);
  assert.equal(s.db.get("SELECT created_by_name n FROM bulk_lists WHERE name='By member'").n, 'A former team member');
  // The account deleted: its lists go with it.
  s.db.run('DELETE FROM accounts WHERE id=?', t.account);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM bulk_lists WHERE account_id=?', t.account).n, 0);
});

test('repair: monthly switch only for teams, list rows and names, the timer goes on after a failure', async () => {
  const { monthlyReports } = await import('../src/server/routes-reports.ts');
  // A person working alone who has sent something is not offered the monthly email (Reports shows the same).
  const solo = await signUp('Sol Alone', 'sol@solo-reports.example', '198.51.100.120');
  const a = accountOf('sol@solo-reports.example');
  seed(a.a, a.u, { status: 'completed', sent: new Date().toISOString() });
  assert.deepEqual(ok(await solo.get('/reports/monthly')), { may: false, on: false });
  // Switched on through the API anyway, it shows (so it can be switched off) and works.
  ok(await solo.put('/reports/monthly', { on: true }));
  assert.deepEqual(ok(await solo.get('/reports/monthly')), { may: true, on: true });
  ok(await solo.put('/reports/monthly', { on: false }));

  // The footnote says where the switch really is, and no "UTC" alone.
  const t = await team('rep', '198.51.100.130');
  ok(await t.owner.put('/reports/monthly', { on: true }));
  s.db.run("UPDATE report_monthly SET on_at='2026-08-15T00:00:00.000Z' WHERE user_id=?", t.ownerId);
  seed(t.account, t.ownerId, { status: 'sent', sent: '2026-09-10T12:00:00.000Z' });
  assert.equal(await monthlyReports(new Date('2026-10-01T06:00:00Z')), 1);
  const m = s.db.get("SELECT subject, html FROM emails WHERE to_email=? AND subject LIKE '%report for September 2026%'", 'rep.owner@reports.example');
  assert.ok(m);
  assert.match(m.html, /Settings, Profile, Emails about your documents/);
  assert.match(m.html, /world time \(UTC\)/);
  assert.ok(!/Settings, Notifications/.test(m.html));
  // The whole timer goes on when the monthly step fails: cron.ts catches it, and one account's report is tried alone.
  assert.match(read('src/server/cron.ts'), /monthly_reports: await monthlyReports\(\)\.catch\(/);
  assert.match(read('src/server/routes-reports.ts'), /try \{\s+r = buildReport\(/);

  // Rows: never more than the people under the header, and a header alone is not a list.
  const csv = 'Name,Email\nAda,ada@rep.example\n';
  assert.equal(ok(await t.owner.post('/bulk-lists', { name: 'One', csv, rows: 2 })).list.rows, 1, 'one person under a header is 1, whatever the caller says');
  assert.equal(ok(await t.owner.post('/bulk-lists', { name: 'Two', csv: 'Name,Email\nA,a@x.example\nB,b@x.example\n', rows: 0 })).list.rows, 2);
  assert.equal(ok(await t.owner.post('/bulk-lists', { name: 'No header', csv: 'A,a@x.example\nB,b@x.example' })).list.rows, 2, 'without a header row every line is a person');
  const head = await t.owner.post('/bulk-lists', { name: 'Header only', csv: 'Name,Email\n' });
  assert.equal(head.status, 400);
  assert.match(head.data.error, /nobody under it/);
  // Direction marks and other invisible characters are dropped from a name.
  const sneaky = ok(await t.owner.post('/bulk-lists', { name: 'Sneaky\u202etxt.exe\u200b', csv })).list;
  assert.equal(sneaky.name, 'Sneakytxt.exe');
});

test('screens: words, one place each, no promise the code does not keep', () => {
  const page = read('src/app/app/reports/page.tsx') + read('src/components/reports/ReportParts.tsx');
  assert.ok(!/completion rate|KPI/i.test(page));
  const en = JSON.parse(read('src/locales/en.json'));
  const ours = Object.entries(en).filter(([k]) => k.startsWith('reports.')).map(([, v]) => v as string);
  for (const v of ours) assert.ok(!/\u2014|completion rate|KPI/i.test(v), v);
  // Nothing on Home: no report numbers or charts were added there.
  assert.ok(!/ReportTable|ReportFilters|\/reports\?/.test(read('src/app/app/page.tsx')));
  // The monthly switch is for owners and admins only.
  assert.match(read('src/app/app/settings/page.tsx'), /<MonthlyReport \/>/);
  // Only routes this feature documents.
  const api = read('src/server/openapi-reports.ts');
  for (const p of ["'/reports'", "'/reports/csv'", "'/reports/monthly'", "'/bulk-lists'", "'/bulk-lists/{id}'", "'/bulk-lists/settings'"]) assert.ok(api.includes(p), p);
});
