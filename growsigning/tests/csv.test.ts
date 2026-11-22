// Unit checks for the bulk-send list reader and the wording helpers.
//   node --experimental-strip-types --no-warnings --test tests/out/sender/csv.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, readRecipients, headerFor } from '../src/components/sender/csv.ts';
import { deadlineLine, howLong, joinNames, newDeadline, waitingOn, neverOpened, exportUrl, timeLeft, explain } from '../src/components/sender/lib.ts';

const one = [{ key: 'Volunteer', label: 'Volunteer' }];
const two = [{ key: 'Sponsor', label: 'Sponsor' }, { key: 'Witness', label: 'Witness' }];

test('reads commas, semicolons, tabs, quotes and a byte order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\n"x, y",z\n'), [['a', 'b'], ['x, y', 'z']]);
  assert.deepEqual(parseCsv('a;b\r\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('Lovelace, Ada\tada@example.org'), [['Lovelace, Ada', 'ada@example.org']]);
  assert.deepEqual(parseCsv('"say ""hi""",b\n\n\n'), [['say "hi"', 'b']]);
  assert.deepEqual(parseCsv('"two\nlines",b'), [['two\nlines', 'b']]);
});

test('with a header, columns are matched by name in any order and any case', () => {
  const r = readRecipients('Phone,VOLUNTEER EMAIL,volunteer name\n555,ada@example.org,Ada Lovelace\n556,ben@example.org,Ben', one);
  assert.equal(r.header, true);
  assert.deepEqual(r.ignored, ['Phone']);
  assert.deepEqual(r.rows.map((x) => x.cells.Volunteer), [{ name: 'Ada Lovelace', email: 'ada@example.org' }, { name: 'Ben', email: 'ben@example.org' }]);
  assert.deepEqual(r.rows.map((x) => x.row), [2, 3]);
  assert.ok(r.rows.every((x) => x.problems.length === 0));
});

test('header variants: underscores, e-mail, plain Name and Email for a single role, first and last name', () => {
  assert.deepEqual(readRecipients('volunteer_e-mail;Volunteer_Name\nada@example.org;Ada', one).rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org' });
  assert.deepEqual(readRecipients('Email Address,Full Name\nada@example.org,Ada', one).rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org' });
  assert.deepEqual(readRecipients('First name,Last name,Email\nAda,Lovelace,ada@example.org', one).rows[0].cells.Volunteer, { name: 'Ada Lovelace', email: 'ada@example.org' });
  assert.deepEqual(readRecipients('Volunteer,Email\nAda,ada@example.org', one).rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org' });
});

test('two roles, columns interleaved in any order', () => {
  const r = readRecipients('witness email,Sponsor Name,Witness name,sponsor email\nw@example.org,Sam,Wil,s@example.org', two);
  assert.deepEqual(r.rows[0].cells, { Sponsor: { name: 'Sam', email: 's@example.org' }, Witness: { name: 'Wil', email: 'w@example.org' } });
  assert.deepEqual(r.missing, []);
});

test('a header with a column missing says which one', () => {
  const r = readRecipients('Sponsor name,Sponsor email,Witness name\nSam,s@example.org,Wil', two);
  assert.deepEqual(r.missing, ['Witness email']);
});

test('plain Name and Email are not guessed when there are two roles', () => {
  const r = readRecipients('Name,Email\nSam,s@example.org', two);
  assert.equal(r.missing.length, 4);
});

test('without a header, columns are read by position, and swapped ones are put right', () => {
  const r = readRecipients('Ada,ada@example.org\nBen,ben@example.org', one);
  assert.equal(r.header, false);
  assert.deepEqual(r.rows.map((x) => x.row), [1, 2]);
  assert.equal(r.rows[1].cells.Volunteer.email, 'ben@example.org');
  const s = readRecipients('ada@example.org,Ada\nben@example.org,Ben', one);
  assert.equal(s.swapped, true);
  assert.deepEqual(s.rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org' });
});

test('problems are found per row before anything is sent', () => {
  const r = readRecipients('Volunteer name,Volunteer email\nAda,ada@example.org\n,ben@example.org\nCee,cee-at-example\nDee,\nAda Again,ADA@example.org', one);
  assert.deepEqual(r.rows.map((x) => x.problems), [[], ['name is missing'], ['"cee-at-example" is not a full email address'], ['email is missing'], []]);
  assert.match(r.rows[4].notes[0], /same email as row 2/);
  const m = readRecipients('Sponsor name,Sponsor email,Witness name,Witness email\nSam,s@example.org,,', two);
  assert.deepEqual(m.rows[0].problems, ['Witness: name and email are missing']);
});

test('a list of bare email addresses is understood, and the missing names are pointed out', () => {
  const r = readRecipients('ada@example.org\nben@example.org', one);
  assert.equal(r.rows[0].cells.Volunteer.email, 'ada@example.org');
  assert.deepEqual(r.rows[0].problems, ['name is missing']);
});

test('nothing to read gives nothing back', () => {
  assert.equal(readRecipients('', one).rows.length, 0);
  assert.equal(readRecipients('  \n\n', one).rows.length, 0);
  assert.equal(headerFor(two), 'Sponsor name,Sponsor email,Witness name,Witness email');
});

test('waits and deadlines read like sentences', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (h: number) => new Date(now + h * 3600_000).toISOString();
  assert.equal(howLong(at(-72), now), '3 days');
  assert.equal(howLong(at(-25), now), '1 day');
  assert.equal(howLong(at(-5), now), '5 hours');
  assert.equal(howLong(at(-0.2), now), 'less than an hour');
  assert.equal(timeLeft(at(12 * 24), now), 'in 12 days');
  assert.equal(timeLeft(at(30), now), 'in 30 hours');
  assert.equal(timeLeft(at(-1), now), '');
  assert.match(deadlineLine(at(12 * 24), now), /^Closes on .+, in 12 days$/);
  assert.match(deadlineLine(at(-48), now), /^Closed on /);
  assert.equal(joinNames(['Ada', 'Ben', 'Cee', 'Dee']), 'Ada, Ben and 2 others');
  // More time on an open envelope is added to its deadline; an expired one counts from now.
  assert.equal(newDeadline('sent', at(48), 7, now).toISOString(), at(48 + 7 * 24));
  assert.equal(newDeadline('expired', at(-48), 7, now).toISOString(), at(7 * 24));
});

test('who is holding it up', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const people = [
    { name: 'Ada', email: 'ada@example.org', role: 'signer', status: 'completed', sent_at: '2026-11-10T00:00:00Z' },
    { name: 'Ben', email: 'ben@example.org', role: 'signer', status: 'sent', sent_at: '2026-11-17T12:00:00Z' },
    { name: 'Me', email: 'me@example.org', role: 'signer', status: 'viewed', sent_at: '2026-11-18T12:00:00Z' },
    { name: 'Cee', email: 'cee@example.org', role: 'cc', status: 'pending' },
  ];
  const w = waitingOn(people, 'ME@example.org')!;
  assert.equal(w.label, 'you and Ben');
  assert.equal(w.since, '2026-11-17T12:00:00Z');
  assert.equal(waitingOn(people.slice(0, 1)), null);
  assert.equal(neverOpened(people[1], now), true);
  assert.equal(neverOpened({ ...people[1], sent_at: '2026-11-19T12:00:00Z' }, now), false);
  assert.equal(neverOpened(people[2], now), false);
  assert.equal(exportUrl(['env_a', 'env_b']), '/api/export?ids=env_a,env_b');
  assert.equal(exportUrl(), '/api/export');
});

test('failures always say what to do next', () => {
  assert.equal(explain(Object.assign(new Error('Another contact already uses that email address.'), { status: 400 }), 'Nothing was changed.'), 'Another contact already uses that email address. Nothing was changed.');
  assert.equal(explain(new TypeError('Failed to fetch'), 'Nothing was changed.'), 'We could not reach the server. Nothing was changed. Check your connection and try again.');
});
