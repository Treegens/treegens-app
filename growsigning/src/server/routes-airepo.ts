// Key dates (src/server/airepo.ts). Every route answers 403 with "code": "key_dates_off" while Key dates is off for
// the account, so with zero setup nothing here sends anything anywhere.
//   GET    /account/key-dates                      the switch: possible, on, since, older
//   PUT    /account/key-dates                      { on: boolean }, admins in a browser
//   POST   /account/key-dates/older                "Look through older documents", admins
//   GET    /key-dates                              completed documents with their dates (?within=90: ending in 90 days)
//   GET    /key-dates/calendar.ics                 the confirmed dates as a calendar file
//   GET    /envelopes/:id/key-dates                the terms of one envelope, the reminder and whether it was read
//   POST   /envelopes/:id/key-dates/find           "Find the dates and amounts": the AI reads it and proposes
//   POST   /envelopes/:id/key-dates                { kind, value }: one the sender adds, confirmed at once
//   PUT    /envelopes/:id/key-dates/:term          { value? }: confirm it, or correct it (then confirmed)
//   DELETE /envelopes/:id/key-dates/:term          take it off (and its detail on the envelope)
//   PUT    /envelopes/:id/key-dates-reminder       { days: 1..365 | null }: "Remind me", or stop
import { route } from './router.ts';
import { bad, now } from './util.ts';
import { mine } from './routes-envelopes.ts';
import {
  keyDatesSetting, setKeyDates, lookOlder, assertKeyDates, keyDatesList, calendarFor, termsOf, termView, findTerms,
  confirmTerm, addTerm, removeTerm, setReminder, reminderOf, scanOf, keyDatesOn,
} from './airepo.ts';
import { NOTHING_FOUND, NOT_LEGAL } from '../lib/keydates.ts';

route('GET', '/account/key-dates', (c) => keyDatesSetting(c.account.id));

route('PUT', '/account/key-dates', async (c) => {
  const b = await c.body();
  if (typeof b.on !== 'boolean') throw bad('Send "on" as true or false. Nothing was changed.');
  return setKeyDates(c, b.on);
}, 'admin');

route('POST', '/account/key-dates/older', (c) => lookOlder(c), 'admin');

route('GET', '/key-dates', (c) => keyDatesList(c));

route('GET', '/key-dates/calendar.ics', (c) =>
  new Response(calendarFor(c), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="key-dates-${now().slice(0, 10)}.ics"` } }));

const view = (c: any, e: any) => {
  const terms = termsOf(e.id);
  return { on: keyDatesOn(e.account_id), terms: terms.map(termView), reminder: reminderOf(e.id, c.user.id), scan: scanOf(e.id), note: NOT_LEGAL };
};

route('GET', '/envelopes/:id/key-dates', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  assertKeyDates(c.account.id);
  return view(c, e);
});

route('POST', '/envelopes/:id/key-dates/find', async (c) => {
  const e = mine(c, c.params.id, 'envelope');
  const r = await findTerms(e, { ip: c.ip });
  return { ...view(c, e), found: r.found, ...(r.found ? {} : { message: NOTHING_FOUND }) };
});

route('POST', '/envelopes/:id/key-dates', async (c) => {
  const e = mine(c, c.params.id, 'envelope');
  const t = addTerm(c, e, await c.body());
  return { term: termView(t), ...view(c, e) };
});

route('PUT', '/envelopes/:id/key-dates/:term', async (c) => {
  const e = mine(c, c.params.id, 'envelope');
  const t = confirmTerm(c, e, c.params.term, await c.body());
  return { term: termView(t), ...view(c, e) };
});

route('DELETE', '/envelopes/:id/key-dates/:term', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  removeTerm(e, c.params.term);
  return view(c, e);
});

route('PUT', '/envelopes/:id/key-dates-reminder', async (c) => {
  const e = mine(c, c.params.id, 'envelope');
  const b = await c.body();
  setReminder(c, e, b.days ?? null);
  return view(c, e);
});
