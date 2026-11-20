# Sign&Grow

E-signatures that plant trees. Send, sign, track and store agreements without paper.
100% of subscription revenue goes to Treegens tree planting.

This is a standalone project. It shares no code with anything else in Treegens.

## Run it

Needs Node 22.13 or newer. Nothing else: the database is a single SQLite file and uploads live on disk.

```bash
npm install
npm run dev          # http://localhost:3000
```

With no mail server configured, emails are not delivered. They show up at `/dev/outbox` instead, so you can
click the signing links and try every flow on your own machine.

```bash
npm test             # API tests: signing order, access codes, certificate, tamper checks, isolation, billing
npm run build && npm run test:e2e    # drives a real browser through send, sign on a phone, verify, PowerForm, bulk
```

## What is in it

**Sending**
- Upload PDFs, PNGs or JPEGs. Several documents per envelope, reorder and rename them.
- Recipients who sign, approve, only view, get a copy, or sign in person on your device.
- Signing order (sequential, parallel or mixed) or everyone at once.
- Field editor: signature, initials, date signed, name, email, company, title, text, number, date, checkbox,
  radio group, dropdown, signer attachment and sender notes. Click to place, drag to move, resize, nudge with
  arrow keys, duplicate, copy to every page. Required or optional, prefilled, read only, validated.
- Access codes, private notes per recipient, email subject and message.
- Automatic reminders and expiry. Void with a reason. Correct a recipient after sending. Manual reminders.
- Sign a document yourself, clone an envelope, save any envelope as a template, folders, search.

**Signing**
- No account needed. Works on phones.
- Consent to electronic records, guided "Next" through required fields, progress bar.
- Adopt a signature by typing (four handwriting styles), drawing or uploading. Saved signatures for account holders.
- Finish later, decline with a reason, assign to someone else, view or print at any time.
- Sees what earlier signers already filled in.

**After signing**
- Final PDF with every value stamped in, signer attachments appended, and a certificate of completion:
  recipients, timestamps, IP addresses, consent, signature images, document hashes and the full audit trail.
- Audit trail is hash chained. Editing any past event breaks the chain, and the app shows it.
- Public `/verify` page: drop in a PDF and see whether it is an untouched completed document. No account needed.
- Everyone gets the completed copy by email.

**Reuse and scale**
- Templates with named roles, shared with the team.
- Bulk send a template to a pasted or uploaded CSV list (up to 500 per batch).
- PowerForms: a public link anyone can use to fill in and sign a template.

**Team and admin**
- Accounts with owner, admin and member roles, email invitations, multiple accounts per user.
- Branding: logo and colour on emails and the signing screen.
- Contacts saved automatically and suggested while typing.
- Reports: status counts, completion rate, average time to complete, monthly activity, per team member.
- Inbox of documents sent to you (after confirming your email).

**Developers**
- JSON API for everything the app does, API keys, embedded signing links. Reference at `/developers`.
- Webhooks with HMAC signatures, retries and a delivery log. Private network targets are refused.

**Environment**
- Paper, water and CO2e saved shown on every envelope, on the certificate, in emails, in the dashboard, in
  reports, and as live public totals on `/impact`.
- Every number comes from `src/lib/impact.ts`, and the method is published on `/impact`.
- Subscription revenue ledger (from Stripe invoices) shown publicly as money sent to tree planting.

## What is not in it

Being straight about this: DocuSign is a large suite, and this covers its core e-signature product, not all of it.
Not built:

- **Certificate-based digital signatures.** PDFs are not cryptographically signed with a PKI certificate
  (PAdES). Integrity comes from the stored SHA-256 fingerprint, the hash-chained audit trail and `/verify`.
  These are standard electronic signatures with an audit trail, not "advanced" or "qualified" signatures under
  eIDAS. Have a lawyer confirm they fit your use and jurisdiction before relying on them for high-stakes
  documents.
- ID verification (government ID, knowledge-based checks), SMS or phone authentication, SMS delivery.
- Remote online notarisation, payments collected during signing, conditional fields and formulas.
- Word or Google Docs upload (export to PDF first), comments on documents, shared recipient groups.
- Contract lifecycle management, AI contract analysis, clickwrap, document generation.
- Single sign-on (SAML), two-factor login, native mobile apps.
- Ready-made integrations (Salesforce, Google Drive and so on). The API and webhooks are the way in for now.

## Configuration

Copy `.env.example` to `.env.local`. Everything is optional for local use.

| Variable | What it does |
| --- | --- |
| `APP_URL` | Public address, used in email links. Set this in production. |
| `DATA_DIR` | Where the database and files live. Default `./data`. Must be a persistent disk. |
| `APP_SECRET` | Secret for access-code cookies. Generated and stored in `DATA_DIR` if unset. |
| `SMTP_URL`, `MAIL_FROM` | Mail server, for example `smtps://user:pass@smtp.example.com`. Without it nothing is delivered. |
| `CRON_SECRET` | Lets a scheduler call `POST /api/cron` for reminders and expiry on hosts that sleep. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GROVE`, `STRIPE_WEBHOOK_SECRET` | Turns on billing and the free plan limit. Point a Stripe webhook at `/api/stripe/webhook`. |
| `TREE_COST_USD` | If set, the impact page also shows "about N trees funded". |
| `DEV_OUTBOX=1` | Shows the outbox in a production build. Never set this on a public server: it exposes every signing link. |

## Things to decide before launch

- **Prices and limits** in `src/lib/impact.ts` (Grove at $12 a month, Seedling at 5 envelopes a month) are
  placeholders.
- **Impact factors** in the same file are commonly cited estimates. Check them against a source you are happy
  to stand behind publicly.
- **The 100% promise** is a business commitment. The app records Stripe revenue and displays it. Actually
  moving that money to tree planting is something you do, and should be able to show.
- **Stripe** is implemented but has only been tested with simulated webhook events, not a live account.
- **Storage** is SQLite on one disk, which is fine for one server. Back the `DATA_DIR` folder up. Moving to
  Postgres and object storage is the step to take before running more than one instance.

## Layout

```
src/server    database, auth, envelope logic, PDF stamping and certificate, mail, webhooks, API routes
src/app       pages (marketing, app, signing screen) and the single API entry point
src/components  editor, PDF viewer, signature pad, shell
src/lib/impact.ts   every environmental number and the plans
tests         API tests and the browser test
```
