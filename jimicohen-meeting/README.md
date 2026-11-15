# Meeting scheduler for jimicohen.com/meeting

A self-hosted scheduling app: public booking pages, a dashboard, joint availability across several people's
calendars, Google Calendar events with Meet links, and reminders by email, text and AI phone call.

Live at **https://jimicohen.com/meeting**. The dashboard is at **https://jimicohen.com/meeting/admin**.

## How it is put together

| Part | Where | Notes |
| --- | --- | --- |
| Front end | `src/` | Vite, React, TypeScript. Built to `dist/meeting/`, served under `/meeting/`. |
| API | `server/`, `netlify/functions/api.mts` | One Netlify Function for everything under `/meeting/api/*`. |
| Scheduled work | `netlify/functions/cron.mts` | Runs every 2 minutes: reminders, calendar retries, housekeeping. |
| Storage | Netlify Blobs | Strong consistency, compare-and-swap on the booking index to stop double booking. |
| Shared types | `shared/` | Data model, defaults, theme engine and presets. Short links in `shared/shortLinks.ts`, the built-in brands in `shared/brands.ts`. |
| Short pages | `scripts/shortPages.ts` | A build step that writes `dist/meet/index.html` and `dist/pod/index.html`: the app's page with each link's title, preview and icon. |
| Brand files | `public/brand/`, `public/og/` | The Eco Champions logo, icons, email logo and preview picture, Jimi's photo and the `/meet` preview picture. |

The app is its own Netlify site, `jimicohen-meeting`. The main `jimicohen.com` site proxies `/meeting/*`, `/meet` and
`/pod` to it with these lines in its `_redirects` file:

```
/meeting    https://jimicohen-meeting.netlify.app/meeting/         200!
/meeting/*  https://jimicohen-meeting.netlify.app/meeting/:splat   200!
# Short links into the scheduling app: each opens one booking calendar (see the app's README).
/meet    https://jimicohen-meeting.netlify.app/meet/         200!
/meet/*  https://jimicohen-meeting.netlify.app/meet/:splat   200!
/pod     https://jimicohen-meeting.netlify.app/pod/          200!
/pod/*   https://jimicohen-meeting.netlify.app/pod/:splat    200!
# The same links typed with capitals (these rules match case exactly).
/Meet    /meet   301!
/MEET    /meet   301!
/Pod     /pod    301!
/POD     /pod    301!
```

**Keep these ten lines in the jimicohen.com source** (the comment lines do not count). A deploy of jimicohen.com
without them takes `/meeting`, `/meet` or `/pod` offline until they are back. The short link lines go below the two
`/meeting` lines and above any catch-all rule. `200!` keeps `jimicohen.com/pod` in the address bar; the targets end in
a slash so the app's site does not add a redirect of its own; the capital forms send people to the one lower-case
address, so there is one address to share and to preview. Query strings pass through, so
`jimicohen.com/pod?name=Ann&email=ann@example.com` still fills in the form.

Embeds on other websites load from the app's own address (`https://jimicohen-meeting.netlify.app/meeting`), because
jimicohen.com forbids being framed. The dashboard's Share panel writes the snippets that way: it uses `EMBED_BASE_URL`
when that is set, and otherwise Netlify's own `URL` for the site, which is the same address.

## Environment variables (Netlify site `jimicohen-meeting`)

| Name | Required | Purpose |
| --- | --- | --- |
| `MEETING_SECRET_KEY` | yes | Master secret (base64, 32 bytes). Sessions, sealed keys and manage links derive from it. Changing it signs everyone out and makes saved provider keys unreadable. |
| `MEETING_SETUP_CODE_HASH` | first run, and to reset a forgotten password | SHA-256 (hex) of a setup code. Each code works once: the first one creates the dashboard password, and a new one deployed later replaces a forgotten password (see below). A code that has set a password never works again. It can stay set. |
| `PUBLIC_BASE_URL` | yes | `https://jimicohen.com/meeting`. Every link in emails and texts is built from it. |
| `EMBED_BASE_URL` | no | `https://jimicohen-meeting.netlify.app/meeting`. Used for embed snippets. Without it, Netlify's `URL` for the site is used, which is the same address. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY` | no | Optional. Provider keys are normally pasted in the dashboard under Integrations, where they are stored encrypted. A value set here wins over the dashboard. |
| `ANTHROPIC_API_KEY` (note) | | Netlify's AI Gateway fills `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `OPENAI_API_KEY` with its own values in every function unless the site sets them (measured on this site: a 366 character value equal to `NETLIFY_AI_GATEWAY_KEY`). The app only takes `ANTHROPIC_API_KEY` from the environment when it is a real Anthropic key (it starts with `sk-ant-`) and is not the gateway's value. Otherwise the key saved under Integrations is used, and the voice assistant always talks to `api.anthropic.com` directly. |
| `MEETING_CLIENT_IP_HEADER` | no | Only when the app is reached through a proxy other than Netlify's: the header that carries the visitor's address. |

No secrets live in this repository.

## Signing in, and a forgotten password

- Sign-in allows 8 tries per 10 minutes per visitor (an IPv6 visitor counts by its /64 network, an IPv4 address
  written as `::ffff:a.b.c.d` as that IPv4 address). Failed sign-ins from everyone together are capped at 300 an
  hour. A browser that signed in before (it keeps a `mtg_device` cookie for about 400 days, also after signing out)
  is not held back by that cap, so strangers cannot lock the owner out of the devices they already use. A brand
  new device can still be told to wait while someone is guessing hard; then sign in from a device you used before,
  wait an hour, or use a new setup code as below (setup codes have no shared cap).
- **Forgot your password?** Choose a new setup code and deploy its hash. The stored dashboard data stays as it is.
  1. Make up a new code, at least 20 random characters, different from every code used before. Work out its hash:
     `printf '%s' 'the-new-code' | shasum -a 256` on a Mac, `printf '%s' 'the-new-code' | sha256sum` on Linux
     (the hash is the 64 characters before the dash).
  2. In Netlify, site `jimicohen-meeting`, Site configuration, Environment variables: set `MEETING_SETUP_CODE_HASH`
     to that hash (or `netlify env:set MEETING_SETUP_CODE_HASH <hash> --site 09d1ead9-b759-4787-98d9-56efba3a2c31`).
  3. Deploy again (see Deploying below). The new value only reaches the functions with a new deploy.
  4. Open `https://jimicohen.com/meeting/admin`, choose **Forgot your password?**, enter the new code and a new
     password. You are signed in, and every other browser is signed out.
  The new code then works once. The dashboard remembers every code that has set a password, so none of them
  works again, also not on an older deploy. "This setup code was already used" means the new hash has not
  reached the functions yet: check the variable and deploy again.
  5. Deploys made before this list was kept (before the final review fixes) do not know about it: on such a deploy
     an older code that was used before still works once more after a reset. After a reset, delete those older
     deploys (`netlify api deleteDeploy --data '{"deploy_id": "<id>"}'`), and never roll back to one of them.
- Do not delete the `auth/admin` record by hand to get back in. The steps above keep everything, remember which
  code was used, and sign every older session out. (Should the record ever be made again anyway, it starts from a
  new random password version, so sessions from before do not open it.)

## Connecting the services

All of this is done in the dashboard under **Integrations**, which has step-by-step instructions on screen.

- **Google Calendar**: create an OAuth client (type "Web application") in Google Cloud, enable the Calendar API
  (and the Gmail API if emails should be sent from Gmail), add the redirect URI
  `https://jimicohen.com/meeting/api/google/callback`, and publish the consent screen to **In production**.
  While it is in "Testing", Google ends the connection after 7 days.
  Press **Connect** on the public address, `https://jimicohen.com/meeting/admin` (a co-host's private link already
  uses it). The connection is checked with a cookie set on that address, and Google always sends you back there, so a
  Connect pressed on the `jimicohen-meeting.netlify.app` address is turned away with a note asking you to press it
  again on the page it opens.
- **More than one Google account**: anyone on the team can connect up to 20 Google accounts, with **Add another
  Google account** (Integrations for you, a co-host's own private page for them; Team lets you remove a co-host's
  accounts, but adding and reconnecting stay on their private page). Busy times
  in every one of them keep those times off the booking page. The first account stays the main one: new meetings,
  your Gmail and "Follow Google Calendar" use it, and "Use a different Google account" still replaces it. An account
  that cannot be read closes that person's times, as one calendar always did, and every warning and alert names it.
  While the consent screen is in "Testing", every Google account you add must be listed there as a test user, and an
  app Google has not verified can be used by at most 100 Google accounts in all, each added account counting.
  Every account a co-host adds on their private page, and every change of their main account there, is emailed to
  them and to you. Changes you make to your own accounts from the dashboard send no email.
- **Rolling back with more than one account**: an older deploy only knows the main account. While it serves (a
  rollback, or the permanent link of an older deploy), times that only another account blocks are offered again,
  and meetings still go to the main account; the accounts are all read again as soon as the current deploy is back.
  The same release brings the Eco Champions brand, which older deploys do not know either, so do not roll back past
  it (see "Older deploys after this release" below). Take a copy of the `hosts` blob before deploying this change,
  for example with `netlify blobs:get meeting hosts`.
- **Email**: a Resend API key with a verified sender, or "send from my Gmail".
- **Texts and reminder calls**: a Twilio Account SID, Auth Token and phone number. For replies by text, set the
  number's incoming message webhook to `https://jimicohen.com/meeting/api/twilio/sms` (POST).
- **Voice assistant**: an Anthropic API key. Without one the reminder call still works with a simpler scripted menu.

## Short links and the Eco Champions brand

- **`jimicohen.com/meet`** opens one meeting with Jimi alone ("Meet with Jimi"), in Jimi's own look.
  **`jimicohen.com/pod`** opens the Eco Champions conversation: Jimi and his co-hosts, only the times when they are
  all free, written into every host's calendar. `/meeting` keeps working as before, with the list of every meeting.
- What each link opens is chosen on the dashboard, under Event types, **Short links** (Home lists both under "Your
  links"). Set to "Nothing for now", a link says it is not open right now.
- **The brand.** A meeting's Basics tab has a Look section: Jimi's own look, or Eco Champions. A meeting in the Eco
  Champions look shows its name, logo, colours and fonts on its pages, and its emails, texts, reminder calls, Google
  Calendar event and calendar file speak for Eco Champions. Each booking remembers the look it was made in, so
  changing a meeting's look later never changes bookings already made. The Eco Champions look, logo and sender name
  are edited in Design ("Look for: Eco Champions"); replies to its emails still go to the site's reply-to address, and
  the consent wording is the site's own. Jimi's dashboard, his own pages and a co-host's private page stay in Jimi's
  look. The built-in logo files are never deleted; "Use the built-in logo" brings them back after an upload.
- **The one-time setup.** After the deploy that brings short links, the scheduled function (`cron.mts`) runs a setup
  once, within about two minutes: "Meeting" becomes "Meet with Jimi" and `/meet` opens it (or the first active meeting
  with Jimi alone), and `/pod` opens a joint meeting whose name says Eco Champions or podcast, else a new unlisted
  "Eco Champions conversation" with Jimi and every co-host, 30 or 60 minutes. It only fills in what is missing, never
  edits the profile, the welcome text, the theme or a choice made since, and leaves a marker
  (`migrations/short-links-v1`) so it never runs again. Nothing a visitor or the dashboard does can start it. Locally,
  `POST /meeting/api/dev/one-time-moves` runs it (the dev server only; production answers 404). Home says "Your short
  links are being set up" until it has run; if that stays longer than a few minutes, read the scheduled function's log
  for "the short link setup".
- **Link previews.** The title, description and picture of each link are part of its static page, so they change
  only with a deploy. `/pod` always previews as Eco Champions and `/meet` as Jimi, whatever meeting they open. The
  pictures are `public/brand/eco-champions/og.png` and `public/og/meet.png`; replacing one means a new file and a
  deploy. LinkedIn keeps a preview for about a week: after a change, run the link through LinkedIn's Post Inspector to
  refresh it. Slack refreshes by itself within about half an hour; iMessage keeps its own copy on each device.
- **Adding a short link name takes four edits**: `SHORT_LINK_NAMES` and `SHORT_LINKS` in `shared/shortLinks.ts`, the
  two blocks per name in `netlify.toml` (the redirect and the headers), and the jimicohen.com `_redirects` lines. A
  unit test ties the first three together; the fourth is on the jimicohen.com site. Names are lower case letters,
  digits and dashes, and the app's own paths (`meeting`, `brand`, `og`, `meet`, `pod`) cannot be used as a meeting's
  link.
- **The canonical header** that jimicohen.com adds to proxied pages is out of scope here: it names
  `/meeting/index.html` for every `/meeting/<slug>` page today, which is an existing jimicohen.com issue. The short
  pages are real files at their own address, so their header names `jimicohen.com/pod/` and `jimicohen.com/meet/`.
- **Older deploys after this release.** An older deploy does not know about brands: if it serves (a rollback, or an
  old permanent link), it shows and sends Eco Champions bookings in Jimi's look, and its site saves can race the
  current ones. Delete older deploys after this release, and never roll back past it.

## Working on it locally

```bash
npm install
npm run build         # front end into dist/meeting
npm run dev           # http://localhost:8788/meeting with mocked providers and file storage in .data/
npm run typecheck
npm test              # unit tests (vitest)
npm run test:e2e      # browser tests against the local server (needs Playwright with Chromium)
```

The local server uses in-process stand-ins for Google, Twilio, Resend and Anthropic and records everything they
would have sent. The first-run setup code locally is `dev-setup-code`.

## Deploying

```bash
npm run build
netlify deploy --prod --no-build --dir dist --functions netlify/functions --site 09d1ead9-b759-4787-98d9-56efba3a2c31
```

After a deploy, `GET https://jimicohen.com/meeting/api/health` should answer `{"ok":true,"storage":"ok"}`.

`--dir dist` publishes the short pages too (`dist/meet/`, `dist/pod/`). The first time short links go live, check in
this order:

1. `npm run build`: `dist/meet/index.html` and `dist/pod/index.html` exist. Take the copy of the `hosts` blob (see
   "Rolling back with more than one account" above), then deploy with the command above.
2. Within about two minutes the dashboard's Home shows both links under "Your links" (the one-time setup ran).
3. On the app's own address: `curl -sI https://jimicohen-meeting.netlify.app/pod/` answers 200 with
   `frame-ancestors 'none'` and `X-Frame-Options: DENY`; `curl -s https://jimicohen-meeting.netlify.app/pod/ | grep -E 'og:|<title>'`
   shows the Eco Champions preview; the same for `/meet/` with Jimi's; `/meeting/brand/eco-champions/og.png` and
   `/meeting/api/assets/builtin_eco_champions_email` answer 200 `image/png`.
4. Add the short link lines to the jimicohen.com `_redirects` file (above) and deploy that site.
5. On jimicohen.com: `/pod` and `/pod/` answer 200 with `X-Frame-Options: DENY`, `/Pod` and `/POD` answer 301 to
   `/pod`, the same for `/meet`, and `curl -s https://jimicohen.com/pod | grep og:` shows the preview.
6. Run both links through LinkedIn's Post Inspector, and paste them into Slack and iMessage.
7. On a phone, book a test meeting on `/pod` with a co-host's calendar connected: the email logo shows in Gmail and
   Apple Mail. Cancel it from the email.
8. `GET https://jimicohen.com/meeting/api/health` as above.

**Every deploy of this site uses the live data.** Netlify Blobs belong to the site, not to a deploy: draft deploys
(`netlify deploy` without `--prod`), deploy previews and the permanent link of every earlier deploy read and write
the same bookings, and send real emails, texts and calls. Try changes with `npm run dev`, never on a draft deploy.
Inside the functions the deploy context cannot tell them apart either (a CLI production deploy reports itself as
`deploy-preview`), so the app does not try to.
