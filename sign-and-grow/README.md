# Sign&Grow

E-signatures that plant trees. Send, sign, track and store agreements without paper.
100% of what customers pay goes to Treegens tree planting.

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
node scripts/dev-seed.mjs http://localhost:3000   # a login, a draft, envelopes out for signature, a voided one

npm test             # every tests/*.test.ts, against a throwaway database
npm run build && npm run test:e2e    # drives a real browser through send, sign on a phone, verify, PowerForm, bulk
```

What the test files cover:

| File | Covers |
| --- | --- |
| `tests/flow.test.ts` | Signing order, access codes, the certificate, tamper checks, isolation between accounts. |
| `tests/billing.test.ts` | Paying, against a simulated payment provider: free signatures for a new account, the monthly plan, top-ups, roll-over, renewal reminders, cancelling in the app, from an email link and by card, a charge after cancelling, refunds of unused signatures, a card dispute, an unused plan, free codes. |
| `tests/trust.test.ts` | Everything built in answer to complaints: correcting a sent envelope, lost links, deadlines, checking an email is genuine, reports and pauses, export, team hand-over, the help form, closing an account. |
| `tests/autoplace.test.ts` | Placing fields automatically from the text of a document. |
| `tests/platform.test.ts` | Platform and security: links in emails never come from a request header, the caller's address behind a proxy, what an API key may do and what it says when it cannot be used, keys when a member is removed or an account is closing, and webhooks (logged before the first try, sent to the address that was checked, sent again, paged). |

## What the bad reviews taught us

Before building further we read the negative reviews of the market-leading e-signature product: review sites,
complaint boards, community forums and developer issue trackers. The notes are in `research/complaints.json`
(167 sourced complaints, merged into 45 themes). Four areas were not researched and are open gaps, not clean
results: mobile app store reviews, users outside the US, account security and signature disputes, and
industry-specific workflows.
Each row is something people complain about again and again, and what this code does instead. Every row is
behaviour in the code, not a line in a policy page, and most rows are pinned down by a test in
`tests/billing.test.ts` or `tests/trust.test.ts`.

| What people complain about | What Sign&Grow does |
| --- | --- |
| The plan renews with no warning, and the email does not say the amount. | Month to month only. Before every renewal an email states the exact amount and date, with a link that stops it. Every payment gets a receipt. |
| "I cancelled and was charged anyway." | Cancelling tells the payment provider at once and returns a reference. A charge on a plan that already ended is refunded by the software itself. A card dispute stops all billing. |
| There is no cancel button. | One button on the Plan page. A stop link in the welcome email and in every renewal reminder, which works without logging in (`/billing/stop`). On `/help`: find every paid plan by email, or stop billing with the last four digits of the card. |
| Refunds are refused or left to someone's discretion. | One rule, applied by the software: within `REFUND_DAYS` of a payment, every signature from it that has not been used is refunded at the price paid. No form and no approval. |
| Bills for going over the limit. Documents that count even when nobody signed. | People pay for signatures, and one is used only when somebody actually signs. Sending holds one per signer. Voiding, declining and expiring give it back. Running out pauses sending and never creates a charge. |
| Prepaid allowance disappears at renewal. | Signatures never expire. They roll over, also after cancelling. |
| Paying for a plan nobody uses. | A nudge after 60 quiet days. After `DORMANT_AUTO_STOP_DAYS` without a send, the renewal is stopped before the next charge and the owner is told. |
| Support is a chatbot loop, and closed to anyone who cannot log in. | `/help` works without an account: self-service tools, then a contact form that returns a reference and goes to a queue people work from (`/app/operator`, and `SUPPORT_EMAIL` if set). No chatbot. |
| A typo after sending means void and start again. | An envelope that is out can be corrected in place: names, addresses, fields, people. Signatures already collected stay. What a finished signer signed is locked. |
| Signing links expire or stop after a few opens. | A link works for as long as the envelope is open, with no limit on opens. A replaced link offers to send the current one. `/help` emails anyone their documents again. An expired envelope is reopened, not rebuilt, and signers can ask for more time. |
| Signers are pushed to create an account. | Signers never need an account or a password, and are never sent marketing. |
| "I cannot tell a real request from a scam." | Every signing email names the sender and carries a security code that anyone can type into `/check`. Senders must confirm their email, new free accounts have a daily recipient limit and cannot send fake payment notices, recipients can report a request, and enough reports pause the sender until a person has looked. |
| "They say they never got the email." | The envelope shows whether each email left. The sender is told when a request sits unopened, and can copy the signing link, remind one person or correct the address. |
| The account was locked with our contracts in it. | Cancelling, a failed payment or a pause never deletes or locks a document. Pausing only stops new sends. |
| There is no way to get everything out. | One free export of every signed PDF, audit trail and a CSV index, on every plan, also after cancelling (`GET /api/export`). |
| The account belonged to someone who left. | Ownership can be handed over. When a member is removed their envelopes pass to the team. Billing can be stopped with the card, without the mailbox. |
| Signers cannot get their copy later. | The completion email links to the signed document and attaches it when small enough. `/help` sends it again at any time. |
| The API costs extra and needs a go-live review. | The API is the same on every plan, and a key works as soon as it is created. Errors say what to do and carry a request id. Retries are safe with an `Idempotency-Key`. |
| Integrations break without anyone noticing. | Every webhook delivery is in the log from before the first try, and the latest 200 of each webhook can be sent again. After three failures in a row the admins get an email. Removing a team member lists the API keys that stop with them and emails the admins. A key that cannot be used says why. |
| Closing an account by mistake loses everything. | Closing keeps everything for 30 days, and signing in again undoes it. |

## What is in it

**Sending**
- Upload PDFs, PNGs or JPEGs. Several documents per envelope, reorder and rename them.
- Recipients who sign, approve, only view, get a copy, or sign in person on your device.
- Signing order (sequential, parallel or mixed) or everyone at once.
- Field editor: signature, initials, date signed, name, email, company, title, text, number, date, checkbox,
  radio group, dropdown, signer attachment and sender notes. Click to place, drag to move, resize, nudge with
  arrow keys, duplicate, copy to every page. Required or optional, prefilled, read only, validated.
- Access codes, private notes per recipient, email subject and message.
- Automatic reminders, a warning before a deadline, more time in one click, reopening after expiry.
- Correct an envelope that is already out, without voiding it. Remind one person. Void with a reason.
- Sign a document yourself, clone an envelope, save any envelope as a template, folders, search that also
  looks inside documents.

**Signing**
- No account needed. Works on phones.
- Consent to electronic records, guided "Next" through required fields, progress bar.
- Adopt a signature by typing (four handwriting styles), drawing or uploading. Saved signatures for account holders.
- Finish later, decline with a reason, assign to someone else, ask the sender a question, fix the spelling of
  your own name, ask for more time, stop reminders, report a request. View or print at any time.
- Sees what earlier signers already filled in.

**After signing**
- Final PDF with every value stamped in, signer attachments appended, and a certificate of completion:
  recipients, timestamps, IP addresses, consent, signature images, document hashes and the full audit trail.
- Audit trail is hash chained. Editing any past event breaks the chain, and the app shows it.
- Public `/verify` page: drop in a PDF and see whether it is an untouched completed document. No account needed.
- Everyone gets the completed copy by email.

**Help and trust (public pages, no login)**
- `/help`: answers for people who sign and people who send, with the tool to fix each thing on the page: find
  my documents, find my subscription, stop billing with my card, and a contact form that reaches a person.
- `/check`: type in the security code from a signing email to see whether it is genuine and who sent it.
- `/billing/stop`: stop a renewal from the link in a billing email. One button.
- `/security`: what the software does to protect signers, senders and documents, and what it does not do.
- `/app/operator`: the queue of help requests, reports and paused accounts, for the people in `OPERATOR_EMAILS`.

**Reuse and scale**
- Templates with named roles, shared with the team.
- Bulk send a template to a pasted or uploaded CSV list (up to 500 per batch). Remind or void a batch as one.
- PowerForms: a public link anyone can use to fill in and sign a template.

**Team and admin**
- Accounts with owner, admin and member roles, email invitations, multiple accounts per user.
- Hand the account to another owner. Envelopes of a removed member pass to the team.
- Branding: logo and colour on emails and the signing screen.
- Contacts saved automatically and suggested while typing.
- Reports: status counts, completion rate, average time to complete, monthly activity, per team member.
- Inbox of documents sent to you (after confirming your email).
- Export everything as one ZIP file. Close an account, with 30 days to undo it.

**Paying**
- People pay for signatures. A new account gets a few free. The monthly plan adds signatures with every
  payment, and extra ones can be bought one at a time. Signatures never expire.
- Month to month. Cancel in the app, from an email link, or with the card. Self-serve refunds.
- Codes that make the monthly plan free for a community (`FREE_PLAN_CODES`), entered at sign-up or on the Plan page.
- Every number (prices, how many signatures, trees per dollar) is in `src/lib/impact.ts`.

**Developers**
- JSON API for everything the app does, API keys, embedded signing links. Reference at `/developers`, and a
  machine-readable description at `/api/openapi.json`.
- API keys have a scope. A key does everyday work (envelopes, templates, files, contacts, bulk sends, reports)
  unless an admin creates it with the "admin" scope. No key can create or revoke keys, remove a member, hand over
  or close the account, or touch the plan and payments. Admins see every key in the account, never the secret.
- Webhooks with HMAC signatures, retries, a delivery log with paging, and redelivery of the latest 200 events of
  each webhook. Private network targets are refused, and a delivery connects to the address that was checked.

**Environment**
- Paper, water and CO2e saved shown on every envelope, on the certificate, in emails, in the dashboard, in
  reports, and as live public totals on `/impact`.
- Every number comes from `src/lib/impact.ts`, and the method is published on `/impact`.
- Payment ledger (from the payment provider's invoices) shown publicly as money sent to tree planting.

## What is not in it

Being straight about this: the market-leading e-signature products are large suites, and this covers the core
e-signature product, not all of it. Not built:

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
- A security certification, or encryption of stored files by the app itself. `/security` says so plainly.
- Staffed support. The software gives everyone a way to reach a person and gives those people a queue. Someone
  still has to read it and answer.

## Configuration

Copy `.env.example` to `.env.local`. Everything is optional for local use. A real deployment must set `APP_URL`,
and `TRUSTED_PROXY_HOPS` if the number of proxies in front of the app is not one.

| Variable | What it does | Default |
| --- | --- | --- |
| `APP_URL` | Public address of the app, for example `https://sign.example.com`. **Required on a real deployment:** every link in every email is built from it. The address of a request is never used for a real host, because a request header can be forged. Without `APP_URL` the app logs a warning and links only work on your own machine. | `http://localhost:3000`, or the localhost address you opened the app on |
| `TRUSTED_PROXY_HOPS` | How many proxies of your own sit in front of the app (load balancer, CDN, the platform's router). The caller's address, used for rate limits and the audit trail, is read that many places from the right of `X-Forwarded-For`; anything further left is whatever the caller typed. `0` means nothing is in front: the header is ignored and every visitor shares one set of rate limits. | `1` |
| `DATA_DIR` | Where the database and files live. Must be a persistent disk. | `./data` |
| `APP_SECRET` | Secret for access-code cookies and stop links. | generated and kept in `DATA_DIR` |
| `SMTP_URL`, `MAIL_FROM` | Mail server, for example `smtps://user:pass@smtp.example.com`. Without it nothing is delivered. | none |
| `CRON_SECRET` | Lets a scheduler call `POST /api/cron` for reminders, expiry, nudges and closing accounts on hosts that sleep. | none |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GROVE`, `STRIPE_WEBHOOK_SECRET` | Turns on paying. Without them nothing is counted and there is nothing to buy. `STRIPE_PRICE_GROVE` is the monthly price. Point a Stripe webhook at `/api/stripe/webhook`. | none |
| `SUPPORT_EMAIL` | The address people can write to. It is shown on `/help`, receives every help request with the sender as reply-to, and gets the alerts that need a person: a payment nobody could be matched to, a card dispute. Without it, requests are still stored and shown in the operator queue. | none |
| `ABUSE_EMAIL` | Where reports of suspicious documents go. | `SUPPORT_EMAIL` |
| `OPERATOR_EMAILS` | Comma-separated addresses of the people who run the service. Once their email is confirmed they can open `/app/operator`: help requests, reports, and pausing or unpausing an account. | nobody |
| `FREE_PLAN_CODES` | Comma-separated codes that make the monthly plan free for whoever enters one. Set it to an empty value to have none. | `GROWalition` |
| `REFUND_DAYS` | How long after a payment its unused signatures are refunded on request, with no approval. | `30` |
| `NEW_ACCOUNT_DAILY_RECIPIENTS` | How many people a free account can send to per day during its first week. | `50` |
| `ABUSE_SUSPEND_AFTER` | How many different recipients must report an account within 30 days before its sending is paused for review. | `3` |
| `DORMANT_AUTO_STOP_DAYS` | A paid plan that has sent nothing for this long is not renewed. `0` only warns. | `90` |
| `UNOPENED_ALERT_HOURS` | How long a request sits unopened before the sender is told. | `48` |
| `ALLOW_PRIVATE_WEBHOOKS=1` | Accepts webhook addresses that are not public https. Local development only. | off |
| `DEV_OUTBOX=1` | Shows the outbox in a production build. Never set this on a public server: it exposes every signing link. | off |

`/help`, `/` and `/security` quote the refund window and the unused-plan rule. They read them from
`src/lib/policy.ts`, the same file the server enforces them from, so the pages and the code cannot disagree.

## Things to decide before launch

- **Prices** are in `src/lib/impact.ts` (`PRICING`): $9 a month for 9 signatures, $1 for each extra signature,
  10 mangrove trees per dollar. `STRIPE_PRICE_GROVE` has to be a monthly price for the same $9. Top-ups need no
  price in Stripe; the amount is sent with each checkout.
- **Choices made around those prices**, each one line to change in `PRICING` or the settings above: a signature is
  one person signing one envelope; signatures never expire and roll over; a new account gets 3 free ones; top-ups
  need the monthly plan; unused signatures from the latest payment are refunded within 30 days; an unused plan
  stops renewing after 90 days.
- **The free code** (`GROWalition` by default) is in this source code. If the repository is public, so is the
  code, and nothing limits how many accounts use it. Change it with `FREE_PLAN_CODES`.
- **Impact factors** in the same file are commonly cited estimates. Check them against a source you are happy
  to stand behind publicly.
- **The 100% promise and the trees per dollar** are business commitments. The app records what was paid and
  displays it. Actually moving that money to tree planting is something you do, and should be able to show.
- **A person has to answer.** Set `SUPPORT_EMAIL` and `OPERATOR_EMAILS` and decide who reads the queue. The
  public pages promise that a person replies, and deliberately promise no response time.
- **Stripe** is implemented but has only been tested with simulated webhook events, not a live account.
- **Storage** is SQLite on one disk, which is fine for one server. Back the `DATA_DIR` folder up. Moving to
  Postgres and object storage is the step to take before running more than one instance.
- **`/security`** lists only what the code does. If hosting adds something (disk encryption, backups, a
  certification), add it there once it is true.

## Layout

```
src/server    database, auth, envelope logic, PDF stamping and certificate, mail, webhooks, API routes
src/app       pages (public, app, signing screen) and the single API entry point
src/components  editor, PDF viewer, signature pad, shell, public navigation and footer
src/lib/impact.ts   every environmental number and the prices
research      what people complain about in other e-signature tools, with sources
tests         API tests and the browser test
```
