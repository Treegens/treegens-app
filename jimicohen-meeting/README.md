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
jimicohen.com forbids being framed. The dashboard's Share panel already writes the snippets that way.

## Environment variables (Netlify site `jimicohen-meeting`)

| Name | Required | Purpose |
| --- | --- | --- |
| `MEETING_SECRET_KEY` | yes | Master secret (base64, 32 bytes). Sessions, sealed keys and manage links derive from it. Changing it signs everyone out and makes saved provider keys unreadable. |
| `MEETING_SETUP_CODE_HASH` | first run | SHA-256 (hex) of the one-time setup code used to create the dashboard password. |
| `PUBLIC_BASE_URL` | yes | `https://jimicohen.com/meeting`. Every link in emails and texts is built from it. |
| `EMBED_BASE_URL` | recommended | `https://jimicohen-meeting.netlify.app/meeting`. Used for embed snippets. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY` | no | Optional. Provider keys are normally pasted in the dashboard under Integrations, where they are stored encrypted. A value set here wins over the dashboard. |

No secrets live in this repository.

## Connecting the services

All of this is done in the dashboard under **Integrations**, which has step-by-step instructions on screen.

- **Google Calendar**: create an OAuth client (type "Web application") in Google Cloud, enable the Calendar API
  (and the Gmail API if emails should be sent from Gmail), add the redirect URI
  `https://jimicohen.com/meeting/api/google/callback`, and publish the consent screen to **In production**.
  While it is in "Testing", Google ends the connection after 7 days.
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
