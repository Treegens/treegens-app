# End-to-end tests

The real browser (Playwright, Chromium) against the real backend (`scripts/dev-server.ts`) with
mocked providers (`server/lib/mocks.ts`). Plain Node, no test framework.

## Run

```
node tests/e2e/run.mjs                  # every tests/e2e/*.e2e.mjs
node tests/e2e/run.mjs smoke            # suites whose file name contains "smoke"
node tests/e2e/run.mjs harness -g call  # only scenarios whose name contains "call"
node tests/e2e/run.mjs --list
```

The runner builds the app once, then gives every suite its own dev server, its own empty data
folder and its own log file. Exit code 0 means every scenario of every suite passed.

| Environment | Meaning | Default |
|---|---|---|
| `E2E_PORTS` (or `--ports 8800-8809`) | port range for the dev servers, first free one is used | `8800-8899` |
| `E2E_DIST_DIR` | folder to build into, the app lands in `<dir>/meeting` | `dist` |
| `E2E_SKIP_BUILD=1` | reuse the build that is already there | build every run |
| `E2E_WORK_DIR` | data folders and `server.log` per suite | a fresh temp folder |
| `E2E_TIMEOUT_MS` | how long a browser action may take | `10000` |
| `E2E_SCREENSHOT_DIR` | where screenshots go, a folder per suite | `tests/e2e/screenshots` |

Several people can run at once when each uses their own `E2E_PORTS`, `E2E_DIST_DIR` and
`E2E_WORK_DIR`. Screenshots go to `tests/e2e/screenshots/<suite>/` (not committed).
Playwright is expected as a global package. The browser is started so that it cannot reach
anything but this machine.

## Write a suite

A file `tests/e2e/<name>.e2e.mjs` with a default export:

```js
import { defineSuite } from './lib.mjs';

export default defineSuite('booking', { mockCreds: true }, async (t) => {
  await t.scenario('a visitor books', { reset: true }, async (s) => {
    await s.setClock('2026-11-16T09:00:00.000Z');          // a Monday, 09:00 in London
    await s.setupAdmin({ timezone: 'Europe/London' });      // first-run setup through the API
    const owner = await s.newPage({ signedIn: true, timezoneId: 'Europe/London' });
    await s.connectGoogle(owner, 'jimi@example.com', 'Europe/London', { start: { hostId: 'host_owner' } });

    const page = await s.newPage({ timezoneId: 'America/New_York' });
    await s.step('books the intro call', async () => {
      await page.goto(s.url('/intro'));
      // ... pick a day and a time, fill the form ...
      await s.linger(page);                                  // see "Things that bite"
      await page.getByRole('button', { name: 'Confirm booking' }).click();
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
    });
    await s.settle();
    s.expect(await s.outbox({ kind: 'email', to: 'ada@example.com' }), 'emails to Ada').toHaveLength(1);
  });
});
```

- `mockCreds: true` (default) starts the server with `DEV_MOCK_CREDS=1`: every provider
  credential counts as configured. `false` is a brand new deployment with nothing configured.
  `env` adds environment variables for the server.
- A scenario has its own client address (rate limits do not carry over), its own cookie jar and
  its own pages. Data is shared between the scenarios of a suite unless you pass `{ reset: true }`
  or call `s.reset()`. A failing scenario does not stop the suite.
- `s.step(name, fn)` prints one line per step. When it fails you get the error, a screenshot of
  every open page and the browser console, and the scenario ends. `s.softStep` records the
  failure and carries on.
- **Any console error or uncaught page error fails the scenario**, also when every step passed.
  Chromium logs every 4xx and 5xx answer as a console error, so a scenario that expects one says
  so: `s.allowConsoleErrors(/status of 409/)`, or `s.newPage({ allowConsoleErrors: [...] })`.
- A request to another site fails the scenario too (and is blocked). Web fonts get an empty
  stylesheet.

`smoke.e2e.mjs` is the whole chain in the browser. `harness.e2e.mjs` uses every control once
and is a good place to copy from.

## The public suites

Everything a visitor and an invitee can do, `node tests/e2e/run.mjs public`:

| file | what it covers |
|---|---|
| `public-booking` | booking end to end on desktop and on a 390 px phone: page, stored booking, calendar event, emails, text, reminder jobs |
| `public-timezones` | the same instants from Nairobi, Los Angeles and Kolkata, days shifting over midnight, manual zone, 12/24 hour clock, daylight saving changes |
| `public-hosts` | a collective event offers exactly what both hosts have free (worked out in the test), lands on both calendars; round robin takes turns |
| `public-conflicts` | double booking in two browsers, five requests at once, a joint booking losing its time through one host |
| `public-manage` | the links from the email: view, "I'll be there" (also from the reminder link), reschedule, cancel, dead ends |
| `public-reminders` | every default reminder delivered at its instant; the assistant's call played through the Twilio webhooks (yes, reschedule, two-step cancel, voicemail, calling hours); "C" by text |
| `public-resilience` | Google down, slow or failing on the write, email provider failing, switched-off and unlisted events, honeypot, prefill links, redirect |
| `public-embed` | the Share panel's inline and popup code on a page served from another port under a strict CSP |
| `public-look` | every public screen on desktop and phone in three presets: screenshots to read, plus overflow, cut-off text and contrast checked by program |
| `public-short-links` | `/meet` (Jimi alone, in his look) and `/pod` (Jimi and Ian, only shared free times, everything in Eco Champions: page, emails, text, Google event, call, manage page) on desktop and at 390 px; link previews read without scripts, the headers, no forest while `/pod` loads, closed and moved links |
| `public-no-brand-leak` | with Eco Champions set up and edited, Jimi's own pages and messages show none of it |
| `calendar-copies` | one copy in each calendar: Google invites the booker (page, booking page and email say so, with the "I know the sender" tap, and offer only the calendar file as a backup); a booking made before Google was connected reaches the host's calendar once it is, without a second invitation; Home and Integrations in red without Google; Team, the event editor and Share say so too; Testing mode's end date, before and after; at 390 and 1280 |

`public-helpers.mjs` holds what they share: `prepare(s)` (fresh site, owner signed in, Google
connected), `addCoHost`, `openEvent`, `pickDay`, `pickSlot`, `fillDetails`, `confirmBooking`,
`offeredDays`, `offeredSlots` (the instants on screen, from the buttons themselves), and small
Intl-only time helpers (`wallTime`, `wallDay`, `zoned`) for expectations that do not come from the app.

With the clock frozen every booking made in a scenario has the same creation time, so
`s.bookings()` returns them in no meaningful order: pick by `id`, email or start.
The embed suite serves its page on the highest free port of `E2E_PORTS` (or `E2E_EMBED_PORT`)
from `E2E_EMBED_DIR` (default: `<E2E_WORK_DIR>/embed-host`).

## The admin suites

Every dashboard screen and the co-host page, `node tests/e2e/run.mjs admin`. Each step asserts
the page and then what was stored (or sent), read back through `s.kv`, `s.outbox` or the API.

| file | what it covers |
|---|---|
| `admin-auth` | first run (wrong setup code, short password, checklist, second setup refused), sign out and in with the deep link kept, a password change signing out the other browser; the owner's zone following the device, then Google, then fixed |
| `admin-events` | solo, together and round robin event types made in the browser, every tab of the editor, values kept over a reload, server refusals on the right field and tab, reorder, duplicate, pause, delete refused with upcoming bookings; weekly hours, date overrides and a second schedule against the times the public page offers |
| `admin-design` | every design control, the preview and then the public page read through computed styles, logo and cover upload, wording, custom CSS, undo, discard, the unsaved-changes guard (also with a slow Back), the contrast warning and its Fix |
| `admin-team` | a co-host added, their private link opened in another browser (Google as a different account, calendars, hours, zone, ICS feed), a joint meeting offering only shared free time, one whose hours never meet (said on Home and on the Hosts and Scheduling tabs, and quietly when the check fails), edit details, disconnect and reconnect, a new link, removal refused while in use |
| `admin-integrations` | a server with nothing configured (`mockCreds: false`): credentials pasted, masked and never sent back, badges, every "Send test" against the outbox, field errors, Remove; a refused Google secret, the owner's calendar choice, Cancel at Google |
| `admin-settings` | profile, assistant, booking form defaults and email identity reaching the landing page, the form, the next emails and the TwiML; bookings tabs, search, drawer, cancel, no-show, delete (also when Google could not remove the calendar event), CSV, Home numbers; paging over 45 bookings; Share and embed |
| `admin-look` | every dashboard page and the co-host page at 1440 and 390, light and dark: screenshots to read, plus failed requests, console errors and sideways scrolling checked by program |
| `admin-google-accounts` | several Google accounts per person: added with "Add another Google account" (chooser, no hint), busy time on each closing its time, bookings still going to the main account, an account picked twice, a renamed address and a reused one, removing one (revoked), one that needs a reconnect named on Home, Integrations and the alert, old-shape data stamped by housekeeping, a co-host with two accounts on a joint meeting, "Use a different Google account" without a second invitation, the ceiling of 20, a link replaced mid sign-in, and the rows at 390 |
| `admin-brands` | the one-time setup on data like the live site (and a second run changing nothing), joint meetings made before it, "Your links" on Home with its copy buttons, the Short links card and the chips, the Look section of the editor, the Eco Champions look, logo and sender name in Design, and the `/pod` meeting offered when a co-host is added |

`joint-pod-accounts` covers where several Google accounts and the Eco Champions brand meet: Jimi and Ian
with two accounts each, busy time on either second account closing that time on `/pod` (and `/meet`
minding only Jimi's), a broken second account named on Home and in the alert in Jimi's own name, and the
`/pod` and `/meet` emails each in their own brand, also after "Use a different Google account" leaves both
bookings no longer linked to their events. Integrations, Team, the co-host page, Home and `/pod` at 1280
and at 390.

`admin-helpers.mjs` holds what they share: `MONDAY` (the frozen "now"), `openPage` (through the
sidebar), `expectToast`, `clearToasts`, `expectFieldProblem` (the message a field announces through
`aria-invalid` and `aria-describedby`), `saveAndWait`, `pngFile` (a real PNG to upload),
`openBookingPage`, `openDays` and `offeredTimes` (what the public page offers, from its buttons).

- Controls that save on their own (calendar ticks, zone choices) are driven with `click()` and a
  wait for the new state, not `check()`: the tick only moves once the server has answered.
- A suite that needs the embed address passes `env: { EMBED_BASE_URL: 'http://127.0.0.1:{port}/meeting' }`
  to `defineSuite`; the dev server swaps `{port}` for its own.
- On Integrations a connected card starts closed after a reload; open it before reading inside.

## Helpers

`t` is the suite, `s` a scenario. Everything under "dev controls" exists on both.

**Suite**: `t.scenario(name, [options], fn)`, `t.server` (`origin`, `base`, `api`, `port`,
`dataDir`, `logFile`, `log()`), `t.browser`.

**Requests**

| | |
|---|---|
| `s.api(method, path, { body, query, headers, form })` | one request to `/meeting/api<path>` with this scenario's cookies. Writes carry `Origin` and `X-Requested-With: meeting`. Never throws for a status. Returns `{ status, ok, data, text, headers, location }`. Redirects are not followed. |
| `s.apiOk(...)` | the same, but throws unless 2xx and returns the parsed body |
| `s.visitor()` | another client with its own cookies and address: `visitor.request(...)`, `visitor.ok(...)` |
| `s.url('/intro')` | absolute URL of an app page |
| `s.setupAdmin({ password, timezone })` | first-run setup with the dev setup code, signs this scenario in |
| `s.login(password)` | sign in |
| `s.slots({ slug, duration, from, to })` | bookable start times as ISO strings |
| `s.book({ slug, start, durationMin, name, email, timezone, phone, consent, ... })` | books through the API as a new visitor, returns the raw answer |

**Browser**

| | |
|---|---|
| `s.newPage({ viewport, timezoneId, locale, signedIn, ip, allowConsoleErrors, ...contextOptions })` | a page in a browser context of its own. Defaults: 1280 x 800, UTC, en-US. A phone: `{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }`. `signedIn` reuses the session of `setupAdmin()` / `login()`. |
| `s.connectGoogle(page, email, zone, { flags, gmail, deny, start })` | plays Google's consent screen for that page, see below |
| `s.linger(page, ms = 2000)` | lets time pass on the page without waiting |
| `s.screenshot(page, label)` | full-page screenshot, returns the path |
| `s.screenshotEmail(email, label)` | renders the HTML of an outbox email and saves a screenshot |
| `s.allowConsoleErrors(...patterns)`, `s.allowExternalRequests(...patterns)` | what is expected in this scenario |
| `s.allowLocalOrigin('http://localhost:8899')` | lets pages really load another origin on this machine, for a test that serves its own page (the embed suite does). Anything that is not localhost stays blocked. |

**Assertions**: `s.expect(actual, 'what it is')` with `toBe`, `toEqual`, `toMatchObject` (partial,
RegExp values test strings), `toContain`, `toMatch`, `toBeTruthy`, `toBeFalsy`, `toBeNull`,
`toBeDefined`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toHaveLength`, and `.not`.
`s.eventually(fn, { timeout })` retries until `fn` stops throwing. For the page itself use
Playwright: `await page.getByRole(...).waitFor()`.

**Dev controls**

| | |
|---|---|
| `s.reset()` | wipes all stored data (a fresh first run) and this client's cookies |
| `s.settle()` | waits until the server has finished its background work (the emails sent after a booking answers) |
| `s.outbox(filter)` | what the mocks recorded, oldest first, each with `index`. Filter by function or fields: `{ kind: 'email', to: 'ada@example.com', subject: /Confirmed/ }` |
| `s.clearOutbox()`, `s.waitForOutbox(filter, { count, timeout })` | |
| `s.setClock(iso)`, `s.advanceClock({ days, hours, minutes })`, `s.now()` | the frozen server clock. Open pages follow. `setClock(null)` returns to real time. |
| `s.runJobs()` | what the cron function does (due reminders, housekeeping), then `settle()` |
| `s.runOneTimeMoves()` | the one-time short link setup, which only the published deploy's scheduled function runs (`runJobs()` never does); returns its report, or `'already_done'` |
| `s.shortUrl(name, { origin })`, `s.fetchHtml(url, { userAgent })`, `metaOf(html)` | the address of `/meet` or `/pod` the way jimicohen.com reaches it; a plain request without scripts, as a link preview crawler makes it; the title, meta tags and links of a page's head |
| `s.jobs(filter)`, `s.calls()`, `s.bookings(filter)` | queued jobs, calls placed through mock Twilio (with our call record), every booking with `manageToken` and `manageUrl` |
| `s.kv(key)`, `s.kvKeys(prefix)` | raw look into the store, for example `s.kv('hosts')` |
| `s.putKv(key, value)`, `s.googleAccountsOf(hostId)` | write one raw record (data in the shape an older deploy left it); a host's stored Google accounts as `{ main, extras }` |
| `s.addGoogleAccount(page, region, email, zone)` | presses "Add another Google account" in `region` and signs in as `email`; checks Google was asked for its account chooser with no hint |
| `s.setGoogleBusy(email, [{ start, end, calendarId? }])`, `s.clearGoogleBusy(email)` | busy time of a mock Google account. Also drops the app's one minute free/busy cache. |
| `s.setGoogleAccount(email, { timezone, calendars, revoked })`, `s.googleEvents(email)` | change a mock account, read the events on its calendars. `{ renameTo }` moves the same Google account (same sub, events and busy time) to a new address; `{ newAccount: true }` gives the address to another Google account. A revoke ends every token of that account. |
| `s.failService(service, spec)`, `s.clearFailures(service?)` | failure injection, see below |
| `s.scriptModel([{ say, action }, { stopReason: 'refusal' }, { text }, { status: 529 }])` | the next answers of the mock model, in order |
| `s.setIcsFeed(name, { events: [{ start, end, summary }] })` | a calendar feed served by the mock, returns its https address |
| `s.voice(call, step, fields)` | plays Twilio for a call from `s.calls()`: `'start'`, `'turn'` with `{ SpeechResult }` or `{ Digits }`, `'amd'` with `{ AnsweredBy }`, `'status'` with `{ CallStatus, CallDuration }`. Returns `{ status, xml, said, listens, hangsUp }`. |
| `s.inboundSms(from, body)` | a text sent to our number, returns `{ status, xml, reply }` |

## The mocks

Every outside call the backend makes is answered in-process and recorded in the outbox as
`{ id, at, service, kind, method, url, status, ok, ... }`:

| kind | useful fields |
|---|---|
| `email` (`service` `resend` or `gmail`) | `to` (list), `toRaw`, `from`, `fromEmail`, `replyTo`, `subject`, `text`, `html`, `links`, `hasIcs`, `ics { filename, method, content, inline }`, `attachments`, `messageId`. A repeated send with the same idempotency key is `email_duplicate`. |
| `sms` | `to`, `from`, `body`, `sid` |
| `call`, `call_update` | `to`, `sid`, `callId`, `webhookUrl`; updates carry `twiml`, `text`, `callStatus` |
| `calendar_insert`, `calendar_patch`, `calendar_delete`, `calendar_get` | `account`, `calendarId`, `eventId`, `event` (summary, start, end, attendees, hangoutLink, ...), `meetUrl`, `sendUpdates`, `notified`, `patch`, `moved` |
| `freebusy` | `account`, `timeMin`, `timeMax`, `calendars`, `busy` |
| `token`, `userinfo`, `revoke`, `calendar_list`, `timezone` | `account`, `grant`, `scopes` |
| `llm` | `model`, `caller`, `pendingCancel`, `reply { say, action }`, `stopReason`, `scripted`, `prompt`, `system` |
| `ics_feed` | `feed` |
| `unknown` | a call nobody mocked: answered 501. Add it to `server/lib/mocks.ts`. |

`at` is the frozen dev clock. Failed calls are recorded too (`ok: false`, and `injected` when a
test asked for the failure).

**Google sign-in.** The OAuth code decides who signs in: `mock:<email>:<zone>` is that account
with that Calendar time zone. Extra flags after the zone: `gmail`, `norefresh`, `nocalendar`,
`noidtoken`. `s.connectGoogle(page, email, zone)` arms this for one page: when our own
`GET /google/connect` answers with its redirect to `accounts.google.com`, the harness checks that
authorization request the way Google would (client id, redirect address, scopes, offline access,
state) and sends the browser on to our real callback with the code and the original state. So the
connect route, the signed state, the callback, the token exchange and the first-connection
defaults are all real code. A redirect cannot be intercepted on its way out of the app, which is
why the connect request itself is caught; a page that navigates to `accounts.google.com` directly
gets the same answer.

```js
const google = await s.connectGoogle(page, 'jimi@example.com', 'Europe/London');
await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
const result = await google.done();        // { status: 'connected' | 'error', reason, url, request }
// or without the UI: { start: { hostId, returnTo, gmail, token } } opens the connect link for you
// deny: true plays "Cancel" at Google; gmail: false declines the Gmail permission
```

The Gmail permission is granted when the app asks for it. Events created through the mock are
busy time for the organiser and for invited mock accounts, deleted events free it again.

**Mock model.** Without a script it answers from the caller's latest words: "yes" confirms,
"reschedule" sends the link, "cancel" asks first and a following "yes" cancels, "goodbye" ends.

**Failure injection.** `s.failService(service, spec)` until `s.clearFailures()`:

```js
await s.failService('resend');                                         // answers 500
await s.failService('google-freebusy', { mode: 'timeout', ms: 300 });  // never answers, gives up after 300 ms
await s.failService('twilio-sms', { status: 400, code: 21610 });       // a provider error code
await s.failService('google-events-insert', { status: 503, times: 1 });// once, then back to normal
await s.failService('google-calendar', { account: 'alex@example.com' });// one Google account only
await s.failService('anthropic', { mode: 'delay', ms: 1500 });         // slow, then a normal answer
```

Modes: `error` (default), `timeout` (without `ms` it waits until the caller gives up), `network`,
`delay`. Services, narrow to wide: `google-token`, `google-userinfo`, `google-revoke`,
`google-oauth`, `google-freebusy`, `google-calendar-list`, `google-timezone`,
`google-events-insert`, `google-events-get`, `google-events-patch`, `google-events-delete`,
`google-events`, `google-calendar`, `gmail`, `google`, `resend`, `email`, `twilio-sms`, `sms`,
`twilio-calls`, `twilio-call-update`, `call`, `twilio`, `anthropic`, `llm`, `ics`.

**Wrong credentials.** A client secret, API key or auth token that starts with `invalid` is
turned down the way the real provider turns down a wrong one.

## Things that bite

- **The booking form refuses a submit within 1.5 seconds of opening**, the way it refuses a bot,
  and Playwright fills a form faster than that. Call `await s.linger(page)` before pressing
  "Confirm booking". `s.book()` already sends a human-looking time.
- **Freeze the clock first** (`s.setClock`) so the days and slots are the same on every run.
  The page's clock starts at the server's time and runs on from there.
- With a frozen clock, rate-limit windows and caches stand still. Booking allows 10 an hour per
  address and 6 an hour per email (`s.book()` uses a new address each time, so vary the email or
  advance the clock). Sign-in allows 8 tries per 10 minutes per address and 40 an hour for
  everyone together. `s.reset()` clears all of it.
- Slots shown in the browser use a free/busy answer that is cached for a minute.
  `s.setGoogleBusy` drops that cache. Booking itself always asks afresh.
- Reminder calls are only placed between 8 AM and 9 PM in the invitee's zone. A call that is due
  outside those hours is skipped, not delayed.
- `getByLabel('Name')` also matches the country picker of the phone field (it lists "Namibia").
  Use `getByRole('textbox', { name: 'Name', exact: true })`.
- The summary beside the details form and the recap inside it show the same time. Only one of
  them is visible at a given width.
- Full-page screenshots show a seam where the fixed page background ends. That is the capture,
  not the page.
- `s.settle()` after an action that answers before its emails are sent (booking, cancelling,
  rescheduling). `s.runJobs()` settles by itself.
