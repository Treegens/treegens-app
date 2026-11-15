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
| Shared types | `shared/` | Data model, defaults, theme engine and presets. |

The app is its own Netlify site, `jimicohen-meeting`. The main `jimicohen.com` site proxies `/meeting/*` to it with
two lines in its `_redirects` file:

```
/meeting    https://jimicohen-meeting.netlify.app/meeting/         200!
/meeting/*  https://jimicohen-meeting.netlify.app/meeting/:splat   200!
```

**Keep those two lines in the jimicohen.com source.** A deploy of jimicohen.com without them takes `/meeting` offline
until they are back.

Embeds on other websites load from the app's own address (`https://jimicohen-meeting.netlify.app/meeting`), because
jimicohen.com forbids being framed. The dashboard's Share panel writes the snippets that way: it uses `EMBED_BASE_URL`
when that is set, and otherwise Netlify's own `URL` for the site, which is the same address.

## Environment variables (Netlify site `jimicohen-meeting`)

| Name | Required | Purpose |
| --- | --- | --- |
| `MEETING_SECRET_KEY` | yes | Master secret (base64, 32 bytes). Sessions, sealed keys and manage links derive from it. Changing it signs everyone out and makes saved provider keys unreadable. |
| `MEETING_SETUP_CODE_HASH` | first run, and to reset a forgotten password | SHA-256 (hex) of a setup code. Each code works once: the first one creates the dashboard password, and a new one deployed later replaces a forgotten password (see below). It can stay set. |
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
  The new code then works once. "This setup code was already used" means the new hash has not reached the
  functions yet: check the variable and deploy again.
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
- **Email**: a Resend API key with a verified sender, or "send from my Gmail".
- **Texts and reminder calls**: a Twilio Account SID, Auth Token and phone number. For replies by text, set the
  number's incoming message webhook to `https://jimicohen.com/meeting/api/twilio/sms` (POST).
- **Voice assistant**: an Anthropic API key. Without one the reminder call still works with a simpler scripted menu.

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

**Every deploy of this site uses the live data.** Netlify Blobs belong to the site, not to a deploy: draft deploys
(`netlify deploy` without `--prod`), deploy previews and the permanent link of every earlier deploy read and write
the same bookings, and send real emails, texts and calls. Try changes with `npm run dev`, never on a draft deploy.
Inside the functions the deploy context cannot tell them apart either (a CLI production deploy reports itself as
`deploy-preview`), so the app does not try to.
