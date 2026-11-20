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
| `tests/billing.test.ts` | Paying, against a simulated payment provider (`tests/stripe-fake.ts`): free signatures for a new account, the monthly plan, top-ups, roll-over, renewal reminders, cancelling in the app, from an email link and by card, a charge after cancelling, refunds of unused signatures, a card dispute, an unused plan, free codes. |
| `tests/billing2.test.ts` | Paying when things go wrong: the provider's messages in any order, the provider failing half way, two refund requests at once, replayed checkouts and messages, cancelling while a payment is failing, slow payment methods, reminders on our own timer, a charge higher than the reminder said, the corners of the free code, and the ways round paying for a signature. |
| `tests/billing3.test.ts` | What a second round of attacks found: provider messages handled in the same instant, a refund whose answer is lost on the way back, refunding again when signatures come back, card disputes, top-up invoices and invoices that are not ours, cancelling in the awkward moments, the unused-plan rule, who pays for which signature, and a free code that is switched off. |
| `tests/billing4.test.ts` | What a third round of attacks found: a refund racing against a burst of sends, one customer's slow call not holding up another's, things on a shared provider account that are not ours, disputes the bank decides either way, a refund made by hand settling ours, cancelling when the provider cannot be asked, payments whose message was lost, and the corners of who pays for which signature. |
| `tests/billing5.test.ts` | The last open ends of the payment code: the provider's messages are answered within a few seconds and kept in an inbox until applied (a slow provider, a failure, a restart in between, three days of failing), a plan on hold can pay its open payment from the Plan page and is read back when that was paid elsewhere, an invoice that names no subscription is matched by asking the provider what the customer is subscribed to, and the price rule: a renewal above the price an account is on is refunded the difference unless a notice went out 30 days before, with the operator's announcement and the reminder that states the true amount. |
| `tests/finish.test.ts` | What was still open at the end: a member leaves a team by themselves, public forms on a shared device and on a closing account, the email check recognising codes of deleted documents from a fingerprint, and stored copies of emails going with a deleted person and after 90 days. |
| `tests/integrity.test.ts` | What people sign is what they saw: every signer is shown everything the sender wrote, nothing printed changes after a signature unless the signer is asked to sign again, a signing page left open cannot finish on a document that was changed, the audit trail says what a correction changed, a replaced signer starts with empty fields, a save from an older copy of the editor is refused, a replaced email is still recognised as genuine, a changed signing order is enforced. |
| `tests/trust.test.ts` | Everything built in answer to complaints: correcting a sent envelope, lost links, deadlines, checking an email is genuine, reports and pauses, export, team hand-over, the help form, closing an account. |
| `tests/autoplace.test.ts` | Placing fields automatically from the text of a document. |
| `tests/platform.test.ts` | Platform and security: links in emails never come from a request header, the caller's address behind a proxy, what an API key may do and what it says when it cannot be used, keys when a member is removed, closes their own login or an account is closing, and webhooks (logged before the first try, sent to the address that was checked, sent again, paged). |
| `tests/abuse.test.ts` | Keeping scammers and strangers out: the filter for fake payment notices on every path and in every spelling, the daily limit on people newly emailed, what a paused account can and cannot do, reports that count, who may read a support message, access codes that freeze, public forms that never hand out someone else's document, and reporting an email with its security code. |
| `tests/api.test.ts` | Calls that are repeated or cross each other: an `Idempotency-Key` that belongs to one person and goes with its envelope, a bulk send that is repeated while it runs or finished after the server stopped half way, one audit line a day for an embedded signing link, two Finish, Decline, Void or reassign requests at the same moment, a whole batch reminded or voided while someone in it signs, and signed PDFs made from fillable forms, whether the form was sent or attached by a signer. |
| `tests/lifecycle.test.ts` | Accounts, teams and deleting: someone removed from a team can still sign in (a workspace of their own, the welcome signatures once) and be invited again, nobody removes themselves, a hand-over names a member who stays, takes bulk sends along and is written to each audit trail, a deleted account leaves no names, addresses, email copies or signer files behind and keeps the money records without names, a closing account takes on nothing new and its owner is emailed a week before the end, members use every template but change only their own and see only their own folders and batches, a completed envelope its sender deletes stays with its recipients, help references nobody can misread, a signer's help request that reaches the sender, and sign-in opening the workspace used last. |
| `tests/support.test.ts` | Help requests as tickets: the whole life of a request from both sides, the published response times and the timer's escalation when one is late, reopening and the follow-up after 30 days, the link that works without a login (right secret, wrong secret, another request's secret), what a customer can never see (internal notes, another customer's request, an answer written to somebody else's mailbox), the operator queue and who may work it (nobody else, and no API key), the payment alerts in the same queue, the real median, the limits on the link and the form, and deleting an account with its threads. |
| `tests/signerux.test.ts` | The person who signs, and the email that reaches them: a saved signature is confirmed before it goes on a page and never offered across two people at one address, "Finish later" carries the signature to another device, "Fix my name" cannot turn one signer into another, dead and replaced links tell the sender, "Email me the current link" and "Find my documents" say what they did, scans and pictures are flagged page by page and stay flagged, the sender's field count matches the signer's, emails the mail server refuses are tried again and the audit trail says so, and someone who signed keeps a copy when the envelope is closed. |
| `tests/signin.test.ts` | Signing in and signing up with Google or Microsoft, against a stand-in for both (an RSA key made in the test, their key lists and token endpoints answered by a fetch stub, ID tokens signed and forged there): a new person, a returning one, a state that is missing, made up, from another browser, used twice or too old, every check on the ID token (signature, "none", HS256 keyed with the public key, issuer, Microsoft's organization rule, audience, expiry, nonce), keys cached and fetched again for an unknown key id, an address in a token never opening an existing login unless the provider vouches for it, a login someone else started in a person's name being cut off from them, invitations, free codes, a closing login coming back, a removed member's workspace, connecting and disconnecting under Settings, the last way in, a first password by emailed link, API keys kept out, no redirect off this site, and nothing answering when a provider is not configured. |

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
| The plan renews with no warning, and the email does not say the amount. | Month to month only. A week before and again the day before every renewal an email states the exact amount and date, with a link that stops it. The reminders run on the app's own timer and are written to the plan history. If more is charged than the reminder said, the difference is refunded by the software. Every payment gets a receipt. |
| "I cancelled and was charged anyway." | Cancelling tells the payment provider at once, says "cancelled" only when the provider has confirmed it, and returns a reference that stays on the Plan page. A charge on a plan that already ended, a second charge for the plan, or a charge on a free plan is refunded by the software itself; if the provider is down the refund is retried on the timer for as long as it takes and a person is told when it keeps failing. Cancelling while a payment is failing, or in the hour before a new month's payment is taken, ends the plan the same day and withdraws that payment. Cancelling on the provider's own page gets the same reference and email. If one of the provider's messages is lost, the timer reads the real state back. A card dispute stops all billing, takes the unused signatures of that payment back with the money, and small ones are not contested. |
| There is no cancel button. | One button on the Plan page. A stop link in every email about a payment while a plan renews, which works without logging in (`/billing/stop`) and dies when that admin leaves the team. On `/help`: find every paid plan by email, or stop billing with the card alone (last four digits plus the account email, or plus the date and amount of a charge). |
| Refunds are refused or left to someone's discretion. | One rule, applied by the software and written once (`refundRuleText` in `src/lib/policy.ts`): within `REFUND_DAYS` of a payment, every signature from it that has not been used is refunded at the price paid, for any payment in the window, not only the latest. No form and no approval. Two requests at the same moment pay out once. |
| "I paid and nothing happened." | The plan and its signatures are there the moment checkout finishes, whichever of the provider's messages arrives first, and the page only says thank you for a payment that really arrived. A payment that cannot be matched to an account is flagged to a person at once. |
| Bills for going over the limit. Documents that count even when nobody signed. | People pay for signatures, and one is used only when somebody actually signs. Sending holds one per signer. Voiding, declining and expiring give it back. Running out pauses sending and never creates a charge. |
| Prepaid allowance disappears at renewal. | Signatures never expire. They roll over, also after cancelling. |
| The price went up and nobody said so. | One rule, written once (`priceRuleText` in `src/lib/policy.ts`) and enforced by the server: an account stays on the monthly price it has been paying until every owner and admin has been emailed the new price at least 30 days before the day it starts, with a link that stops the plan. A renewal that charges more without that notice has the difference refunded automatically, the customer still gets the full month, and the operator is told (a week ahead if the provider already shows the higher amount). The operator announces a price on `/app/operator`. |
| "I updated my card and the plan is still on hold." | A plan the provider has stopped retrying says so, and offers "Pay the open payment", which opens the provider's page for exactly that invoice. If it was paid in the meantime the plan is read back instead of offering the payment again. |
| Paying for a plan nobody uses. | A nudge after 60 quiet days. After `DORMANT_AUTO_STOP_DAYS` without a send, the renewal is stopped before the next charge and the owner is told. |
| Support is a chatbot loop, and closed to anyone who cannot log in. | `/help` works without an account: self-service tools, then a contact form that returns a reference and goes to a queue people work from (`/app/operator`, and `SUPPORT_EMAIL` if set). No chatbot. The reference is eight characters nobody can misread. A message about signing that names an envelope the writer is on also reaches its sender, who can usually fix it at once. Help is one click away from the sign-in forms, the public form page and the editor. |
| No answer, no reference, nobody owns the problem, and the ticket is closed without a word. | Every help request is a ticket (see "How support works" below): a reference, a state the customer can see, one operator who has it and whose first name the customer is shown, and a thread. A response time is published (`SUPPORT_FIRST_REPLY_HOURS`, `SUPPORT_URGENT_REPLY_HOURS`), and the confirmation says the actual time a person will have answered by. When that time passes the request says "We are late with this. Sorry.", everyone who answers is emailed, and so is the customer. Every answer is emailed in full, with a private link that opens the request without a login, because the people who need help most are locked out. Nobody closes a request without a written answer, and a reply opens it again. |
| A typo after sending means void and start again. | An envelope that is out can be corrected in place: names, addresses, fields, people. Signatures already collected stay. Once someone has finished, the pages they signed only change if the sender chooses to ask them to sign again: they are told what changed, the first signature stays on record, and it costs no extra signature. A signer whose page is open during a correction cannot finish on the old version. The audit trail says what every correction changed. |
| Signing links expire or stop after a few opens. | A link works for as long as the envelope is open, with no limit on opens. A replaced link offers to send the current one. `/help` emails anyone their documents again. An expired envelope is reopened, not rebuilt, and signers can ask for more time. |
| Signers are pushed to create an account. | Signers never need an account or a password, and are never sent marketing. |
| "I cannot tell a real request from a scam." | Every signing email names the sender and carries a security code that anyone can type into `/check`. Senders must confirm their email. An account that has not paid has a daily limit on how many people it newly emails, however it reaches them, and cannot send what reads like a fake payment notice or send under the name of a well-known brand. Recipients can report a request from the email itself or from the signing page, and enough reports pause the sender until a person has looked. The filter catches the common trick, not every scam: reports and the pause are the backstop. |
| "They say they never got the email." | The envelope shows whether each email left, and the audit trail only says "Sent to recipient" when the mail server took it. An email it would not take is tried again by the timer for about a day and a half, and the sender is told when that fails for good. The sender is told when a request sits unopened, and can copy the signing link, remind one person or correct the address. |
| The account was locked with our contracts in it. | Cancelling, a failed payment or a pause never deletes or locks a document. Pausing stops what emails a recipient (new sends, new or changed recipients, reminders, reopening), and people who already have a document can still sign it. |
| There is no way to get everything out. | One free export of every signed PDF, audit trail and a CSV index, on every plan, also after cancelling (`GET /api/export`). |
| The account belonged to someone who left. | Ownership can be handed over by the owner. When a member is removed, what they sent (envelopes, drafts, templates and bulk sends) passes to a member the admin chooses, and each envelope's audit trail says who handed it to whom. Nobody can remove themselves and stay the sender. The person removed keeps their login: signing in gives them a workspace of their own, and they can be invited again. A paid or shared workspace with one admin shows a prompt on the home page to add a second. Billing can be stopped with the card, without the mailbox. |
| Signers cannot get their copy later. | The completion email links to the signed document and attaches it when small enough, and two people who share an address each get their own. `/help` sends it again for as long as the sender keeps the account, also for a document someone has signed while others have not, and says whose link is whose at a shared address. Someone who signed an envelope that was later voided, declined or expired can still download what they signed: that copy opens with a page saying it was not completed by everyone, and why. A sender who deletes a completed envelope only takes it out of their own lists, search, export and reports: every recipient's link, download and list of documents sent to them keep working. |
| The API costs extra and needs a go-live review. | The API is the same on every plan, and a key works as soon as it is created. Errors say what to do and carry a request id. Retries are safe with an `Idempotency-Key`. |
| Integrations break without anyone noticing. | Every webhook delivery is in the log from before the first try, and the latest 200 of each webhook can be sent again. After three failures in a row the admins get an email. Removing a team member lists the API keys that stop with them and emails the admins. A member who closes their own login is shown the same list first, and the admins get the same email. Stopped keys stay on the admins' list. A key that cannot be used says why. |
| You cannot get off a team without asking someone. | "Leave this team" on the Team tab, for every member and admin: no permission needed. What they sent passes to the member they choose (the owner by default) with a line in each audit trail, their API keys stop and the admins are told which, and they stay signed in, in another workspace of theirs or a new one of their own. The owner hands the account over first. Someone an admin removes is told by email what happened to their work and that their login stays. |
| A real email is called fake once the sender has deleted the document. | The check page keeps a fingerprint of each security code for a year after a document is deleted: no name, no address, no title. Whoever still holds that email learns that it was real and that the document is gone, instead of "treat it as fake". |
| A front-desk tablet locks itself out of its own form. | A public form can be marked as used on a shared device: 30 unfinished starts from one address instead of 3, an abandoned start is cleared after an hour instead of a day, typing counts as being there, and whoever finishes is offered a clean form for the next person. A form of an account that is closing says so before anyone types into it. |
| Closing an account by mistake loses everything. | Closing keeps everything for 30 days, and signing in again undoes it. A week before the end the owner is emailed the date, how to keep the account and how to export first. While it is closing nothing new starts in it: nothing is sent, nobody is invited or joins, its keys are off. |
| "Deleted" does not mean deleted. | When an account is deleted, at once or after the 30 days, its envelopes go with their audit trails, our stored copies of their emails, the files signers attached, replaced links, reports, webhook logs and batch records, and the files come off the disk. What stays is listed on `/security`, `/help` and in Settings from one list (`KEPT_AFTER_DELETION` in `src/lib/policy.ts`): payments, refunds and the signature ledger without names, a help request that is still open until it is answered, and what belongs to other people. |

## What is in it

**Sending**
- Upload PDFs, PNGs or JPEGs. Several documents per envelope, reorder and rename them.
- Recipients who sign, approve, only view, get a copy, or sign in person on your device.
- Signing order (sequential, parallel or mixed) or everyone at once.
- Field editor: signature, initials, date signed, name, email, company, title, text, number, date, checkbox,
  radio group, dropdown, signer attachment and sender notes. Click to place, drag to move, resize, nudge with
  arrow keys, duplicate, copy to every page. Required or optional, prefilled, read only, validated.
- Access codes (at least 4 characters, frozen after 10 wrong tries until the sender sets a new one), private notes
  per recipient, email subject and message.
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
  Someone who is signed in sees every request they sent under the form ("Your requests"): where it stands, who
  has it, by when a person will have answered, everything written on it, and a box to reply.
- `/help/request/...`: one help request, opened from the private link in our emails about it. No login. The
  customer reads the whole thread there, replies and marks it as solved.
- `/check`: type in the security code from a signing email to see whether it is genuine and who sent it, and
  report it from there without opening the document. Every signing email links to it with the code filled in.
- `/billing/stop`: stop a renewal from the link in a billing email. One button.
- `/security`: what the software does to protect signers, senders and documents, and what it does not do.
- `/app/operator`: the queue of help requests, reports and paused accounts, for the people in `OPERATOR_EMAILS`.
  Each request and report shows the account it is about (plan, age, trusted or not), with "Trust this account" to
  lift the daily limit and the fake-notice filter for it, and "Pause this sender". Help requests are answered
  right there, not by email (see "How support works").

**How support works**
- A help request is a ticket: the eight-character reference, a state (open: waiting for us; waiting: we asked the
  customer something; answered; closed), an owner, a priority and a thread. The topic decides the priority:
  cannot log in, charged wrongly, and a stuck document or a near deadline are urgent. Everything else is normal.
- The response times are published on `/help` and counted in real hours, nights and weekends included:
  `SUPPORT_FIRST_REPLY_HOURS` (24) and `SUPPORT_URGENT_REPLY_HOURS` (8). The form, the confirmation email and the
  request itself give the actual time ("by Tuesday 24 November, 14:00"), in the writer's time zone when their
  browser reported one, otherwise in UTC and said so. The clock stops while we wait for the customer's reply to a
  question of ours, and a reply from the customer starts a full new time.
- When a request passes its time, the timer (`POST /api/cron`) emails `SUPPORT_EMAIL` and every operator once,
  emails the customer that we are late, and the request says so on every screen. The queue is sorted by due time,
  so late ones lead. If it is answered, reopened and late again, that is told again.
- With neither `SUPPORT_EMAIL` nor `OPERATOR_EMAILS` set nobody can be reached, so no time is promised anywhere:
  the page, the form and the email say what they said before there were response times.
- Every answer is emailed in full. Each email carries the same private link to the request
  (`/help/request/<id>/<secret>`), which works without a login. The secret is derived from `APP_SECRET`, and only
  its SHA-256 is stored on the request. The link is never given to whoever fills in the form, only to the mailbox: holding it is the proof of having
  the mailbox. Email replies are not read into the thread, and every email says so.
- Anyone can type any address into the form. So the words of a first message from someone who was not signed in
  under that address are neither mailed back nor shown on the linked page until an operator has written back, and
  the person at the address can say "I did not write to you" with one click.
- A request is never closed by an operator without a written answer in its thread, and closing emails that
  answer. The one exception is "Nobody at this address wrote this" for an advert or a scam typed into the form:
  the address gets one short note that says it was closed and how to open it again, with nothing of what was
  typed. It is refused once the request is known to come from the address's owner. A reply to an
  answered or closed request opens it again. More than 30 days after closing, a reply starts a new request that
  names the old one.
- Operators (`/app/operator`) see the queue with late and urgent requests marked, filter it (waiting for us,
  mine, nobody has it, waiting for the customer, all), take a request or hand it to another operator, answer,
  ask the customer something, write a note only operators see, and close with an answer. Next to a request
  stands the account it is about, read-only: plan, paused or not, last payment. Every action is kept in the
  request's history with who and when. The alerts the payment code files by itself are in the same queue: they
  have no customer, so they get a note and are closed with a note, and nobody is emailed.
- `/help` shows the real median time to a first answer over the last 30 days, with how many requests it covers,
  only when that is at least 10. Otherwise it shows the target only.
- Limits: 10 messages a day on one request and 30 a day from one address (new requests and replies together),
  counted in the database, so the link and the form cannot be used to bury the people who answer or to fill a
  stranger's inbox. No API key can use the support routes or the operator routes: they are for people.
- Deleting an account deletes its requests with their threads. One that is still waiting for an answer, or for
  the customer's reply to a question of ours, is kept until it is answered (the answer is emailed, then the request
  is deleted) or, for an unanswered question, for 30 more days.

**Reuse and scale**
- Templates with named roles, shared with the team: everyone can use them, and only the person a template belongs
  to or an admin can change or delete it.
- Bulk send a template to a pasted or uploaded CSV list (up to 500 per batch). Remind or void a batch as one.
- PowerForms: a public link anyone can use to fill in and sign a template. An unfinished start is only given back
  to the browser that made it, never to whoever types the same email address, and is cleared after a quiet day.

**Team and admin**
- Accounts with owner, admin and member roles, email invitations, multiple accounts per user.
- Sign in and sign up with Google or Microsoft next to email and password, once the operator has set them up
  (see "Signing in with Google or Microsoft" under Configuration). Under Settings, Profile, a person sees every way
  into their login, connects or disconnects a provider, and gets a link by email to set a first password. The last
  way in cannot be removed, and the owner of a login is emailed whenever a new way in is connected to it.
- Hand the account to another owner. What a removed member sent passes to a member the admin chooses. Members see
  their own envelopes, folders and bulk sends, admins see all of them. Signing in opens the workspace used last.
- Branding: logo and colour on emails and the signing screen.
- Contacts saved automatically and suggested while typing.
- Reports: status counts, completion rate, average time to complete, monthly activity, per team member.
- Inbox of documents sent to you (after confirming your email).
- Export everything as one ZIP file. Close an account, with 30 days to undo it and a reminder a week before the end.
  Deleting a completed envelope removes it from the sender's side only. Its recipients keep their copy.

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
- Single sign-on for a whole organization (SAML, or making a team sign in one way), two-factor login of our own,
  native mobile apps. Signing in with Google or Microsoft is in; a second step is then whatever that account has.
- Ready-made integrations (Salesforce, Google Drive and so on). The API and webhooks are the way in for now.
- A security certification, or encryption of stored files by the app itself. `/security` says so plainly.
- Staffed support. The software gives everyone a way to reach a person, gives those people a queue, publishes a
  response time and says so when it is missed. Someone still has to read the queue and answer in time.
- Replying to a support email. Answers are written and read on the request's own page (the link in every email),
  not by replying to the email, and the emails say so.

## Configuration

Copy `.env.example` to `.env.local`. Everything is optional for local use. A real deployment must set `APP_URL`,
and `TRUSTED_PROXY_HOPS` if the number of proxies in front of the app is not one.

| Variable | What it does | Default |
| --- | --- | --- |
| `APP_URL` | Public address of the app, for example `https://sign.example.com`. **Required on a real deployment:** every link in every email is built from it. The address of a request is never used for a real host, because a request header can be forged. Without `APP_URL` the app logs a warning and links only work on your own machine. | `http://localhost:3000`, or the localhost address you opened the app on |
| `TRUSTED_PROXY_HOPS` | How many proxies of your own sit in front of the app (load balancer, CDN, the platform's router). The caller's address, used for rate limits and the audit trail, is read that many places from the right of `X-Forwarded-For`; anything further left is whatever the caller typed. `0` means nothing is in front: the header is ignored and every visitor shares one set of rate limits. | `1` |
| `DATA_DIR` | Where the database and files live. Must be a persistent disk. | `./data` |
| `APP_SECRET` | Secret for access-code cookies and stop links. | generated and kept in `DATA_DIR` |
| `SMTP_URL`, `MAIL_FROM` | Mail server, for example `smtps://user:pass@smtp.example.com`. Without it nothing is delivered, and the audit trail of an envelope says "Not emailed" instead of "Sent to recipient". An email the mail server will not take is kept and tried again by the timer (see `CRON_SECRET`): after 5 minutes, 30 minutes, 2 hours, 6 hours and a day, six tries in all. The envelope page and the audit trail say how it goes, and after the last try the sender is told. | none |
| `CRON_SECRET` | Lets a scheduler call `POST /api/cron`. Call it at least once an hour: it sends signer reminders and renewal reminders, tries emails again that the mail server would not take (so the gaps between tries are never shorter than the gap between calls), expires envelopes, retries refunds and cancellations the payment provider could not take the first time, closes accounts, and tells the operators and the customer when a help request has passed its response time. A renewal that is charged with no reminder on record raises an alert. | none |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GROVE`, `STRIPE_WEBHOOK_SECRET` | Turns on paying. Without them nothing is counted and there is nothing to buy. `STRIPE_PRICE_GROVE` is the monthly price. Point a Stripe webhook at `/api/stripe/webhook` and send it these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.upcoming`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`. | none |
| `STRIPE_COLLECT_TAX_ID` | Set to `1` and the payment page asks business buyers for their tax number (VAT, GST and the like) and billing address, and the provider prints both on the invoice. Put your own legal name, address and tax number on invoices in the provider's settings. Off by default: the provider refuses the request unless its settings allow it, so switch it on in test mode first and make one payment. Not tried against the real provider. | off |
| `STRIPE_WEBHOOK_WAIT_MS` | How long a message from the payment provider is worked on before it is answered. The provider counts a late answer as a failure, so a message that takes longer (the provider or the mail server is slow) is answered "received", kept in an inbox table and finished in the background; the timer applies anything left over after a restart or a failure. | `5000` |
| `STRIPE_API_VERSION` | Pins the version of the payment provider's API that calls are made with, for example the one shown in your Stripe dashboard when you tested. Set the webhook endpoint to the same version. Unset, the account's default version is used; both the older and the newer shapes of invoices and subscriptions are read. | account default |
| `ACCEPT_DISPUTES_UP_TO_USD` | A card dispute always stops billing, takes the signatures the disputed payment bought off the balance (also ones held for envelopes that are out), switches new payments off until a person has looked (the operator page has the button to switch them back on), and tells the customer in writing. Disputes up to this amount are also accepted with the payment provider automatically instead of being fought; larger ones are left for a person to decide, and if the bank then lets the payment stand the signatures come back by themselves. `0` (or `ACCEPT_DISPUTES=0`) leaves every dispute to a person. | `25` |
| `SUPPORT_EMAIL` | The address people can write to. It is shown on `/help`, is told about every new help request and every late one (the answer is written in the operator queue, not by replying to that email; without this address those emails go to `OPERATOR_EMAILS`), and gets the alerts that need a person: a payment nobody could be matched to, a refund that keeps failing, a card dispute. Those alerts also go to `OPERATOR_EMAILS` and are kept in the operator queue. Set at least one of the two: with neither, nobody can open the queue and an alert is only a loud line in the server log. When set, the address is also printed in the footer of every public page and in the app's menu. A production server that starts without it logs a loud warning, because the pages promise that a person answers. | none |
| `ABUSE_EMAIL` | Where reports of suspicious documents go. | `SUPPORT_EMAIL` |
| `OPERATOR_EMAILS` | Comma-separated addresses of the people who run the service. Once their email is confirmed they can open `/app/operator`: help requests, reports, pausing or unpausing an account, and marking an account as trusted. They are the people a help request can be taken by or handed to, and they are emailed when one is late. | nobody |
| `SUPPORT_FIRST_REPLY_HOURS` | The published response time: a person answers a help request within this many hours of the message, counted in real hours (nights and weekends included). `/help`, the confirmation email and the request itself quote the actual time. Promised only while `SUPPORT_EMAIL` or `OPERATOR_EMAILS` is set. | `24` |
| `SUPPORT_URGENT_REPLY_HOURS` | The same for urgent requests: cannot log in, charged wrongly, a stuck document or a near deadline. Never longer than `SUPPORT_FIRST_REPLY_HOURS`. | `8` |
| `FREE_PLAN_CODES` | Comma-separated codes that make the monthly plan free for whoever enters one. Set it to an empty value to have none. | `GROWalition` |
| `REFUND_DAYS` | How long after a payment its unused signatures are refunded on request, with no approval. | `30` |
| `NEW_ACCOUNT_DAILY_RECIPIENTS` | How many people an account that has not paid can send to per day during its first week. "Has not paid" is the free plan or a plan free through a code, with no payment that was kept, and not marked as trusted in the operator queue. Everyone newly emailed counts: a first send, a person added or an address changed on an envelope that is out, a bulk row, a visitor to a public form. | `50` |
| `UNPAID_DAILY_RECIPIENTS` | The same limit after the first week. Paying for anything lifts both, and so does "Trust this account" in the operator queue. | `200` |
| `ABUSE_SUSPEND_AFTER` | How many different recipients must report an account within 30 days before its sending is paused for review. Open reports and reports an operator confirmed as abuse both count. | `3` |
| `POWERFORM_IDLE_HOURS` | An unfinished start from a public form that nobody has touched for this long is closed, so it no longer counts against what the form can still take. Typing counts as touching. The visitor can start again. | `24` |
| `POWERFORM_SHARED_IDLE_MINUTES` | The same, for a form its owner marked as filled in on a shared device (a tablet at the front desk, one office network). Such a form also allows 30 unfinished starts from one address instead of 3, and offers "start a new form for the next person" when someone has finished. | `60` |
| `DORMANT_AUTO_STOP_DAYS` | A paid plan that has sent nothing for this long is not renewed. `0` only warns. | `90` |
| `UNOPENED_ALERT_HOURS` | How long a request sits unopened before the sender is told. | `48` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Switches on "Continue with Google" on the sign-in and sign-up pages and under Settings. Both must be set. With either missing, nothing about Google is shown anywhere and its routes answer 404. Register the redirect address `APP_URL` + `/api/auth/google/callback` with Google (see below). | none |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The same for "Continue with Microsoft". Redirect address: `APP_URL` + `/api/auth/microsoft/callback`. | none |
| `MICROSOFT_TENANT` | Who may sign in with Microsoft: `common` (work, school and personal accounts), `organizations` (work and school), `consumers` (personal), or the id of one organization (the "Directory (tenant) ID", a value like `11111111-2222-3333-4444-555555555555`). A domain name is not accepted: Microsoft sign-in then stays off and the server log says why. | `common` |
| `ALLOW_PRIVATE_WEBHOOKS=1` | Accepts webhook addresses that are not public https. Local development only. | off |
| `DEV_OUTBOX=1` | Shows the outbox in a production build. Never set this on a public server: it exposes every signing link. | off |

`/help`, `/` and `/security` quote the refund window and the unused-plan rule. They read them from
`src/lib/policy.ts`, the same file the server enforces them from, so the pages and the code cannot disagree.

### Signing in with Google or Microsoft

Off until it is configured. A provider is on when both of its values are set, and then "Continue with Google" or
"Continue with Microsoft" appears on `/login` and `/signup` and under Settings, Profile. `GET /api/auth/providers`
tells the pages which are on. Nothing here uses an SDK: the code flow is written out with `fetch` in
`src/server/oidc.ts`, and who the person is gets decided in `src/server/routes-signin.ts`.

Register one redirect address with each provider, exactly `APP_URL` followed by the path, with no slash at the end:

| Provider | Where to register it | Redirect address (with `APP_URL=https://sign.example.com`) |
| --- | --- | --- |
| Google | Google Cloud console, APIs and Services, Credentials, an OAuth client of the type "Web application", under "Authorized redirect URIs" | `https://sign.example.com/api/auth/google/callback` |
| Microsoft | Microsoft Entra admin centre, App registrations, your app, Authentication, platform "Web", under "Redirect URIs" | `https://sign.example.com/api/auth/microsoft/callback` |

The app asks for `openid email profile` and nothing more. It never calls another API of the provider and keeps no
token of theirs: it reads the name, the email address and the provider's id for the person out of the ID token once.

How a person is recognised (the rule is at the top of `src/server/routes-signin.ts`):

- By the provider's own id for them, kept in the `identities` table: Google's `sub`, Microsoft's `tid` with `oid`.
  Never by the email address in the token alone, because at Microsoft the admin of any organization can put any
  address there.
- An id we do not know, whose address belongs to a login that exists, is connected to that login only when the
  provider itself stands behind the address. For Google that means `email_verified` is true and Google runs the
  mailbox (gmail.com, or a Google Workspace domain, which the `hd` claim says). For Microsoft it means the optional
  claim `xms_edov` is true. To let Microsoft vouch, add the optional claims `email` and `xms_edov` to the ID token
  of the app registration (its manifest, `optionalClaims`, `idToken`). Without `xms_edov` Microsoft never vouches,
  which is safe and only means more people are asked to confirm their address by our own email.
- When the provider does not vouch, nobody is signed in to the existing login. The page says to sign in with the
  password once and connect the provider under Settings.
- A new person gets a login made exactly as sign-up makes one (a workspace, the welcome signatures, an invitation
  or a free code carried along). It has no password until they set one through a link sent to their address, and
  its address counts as confirmed only when the provider vouched or an invitation was sent there.
- If the provider vouches for an address whose login was never confirmed, that login may have been started by
  someone else in this person's name. The password set before, the browsers signed in, the API keys that login made
  and connections that were not vouched for are all cut off, and the person is told on screen and by email. The same
  cut happens when the address of a never-confirmed login is first proven by a password link.

What is checked on every sign-in: the `state` works once, for ten minutes, and only in the browser that started
(an HttpOnly cookie); PKCE (S256); and the ID token itself, here and not by a library: RS256 and nothing else,
the signature against the provider's published keys (kept for an hour, read once more when a token names a key we
have not seen), issuer (for Microsoft the organization named in the token itself, and `MICROSOFT_TENANT` when it
names one), audience, expiry and the nonce of this sign-in.

## Things to decide before launch

- **Prices** are in `src/lib/impact.ts` (`PRICING`): $9 a month for 9 signatures, $1 for each extra signature,
  10 mangrove trees per dollar. `STRIPE_PRICE_GROVE` has to be a monthly price for the same $9. Top-ups need no
  price in Stripe; the amount is sent with each checkout.
- **Choices made around those prices**, each one line to change in `PRICING` or the settings above: a signature is
  one person signing one envelope; signatures never expire and roll over; a new account gets 3 free ones; top-ups
  need the monthly plan; unused signatures are refunded within 30 days of the payment that bought them, and
  refunding a monthly payment ends the plan; an unused plan stops renewing after 90 days (once per renewal, and
  "keep it" is respected); a small card dispute is accepted rather than contested (`ACCEPT_DISPUTES_UP_TO_USD`);
  someone on a free code who was paying has their paid subscription ended the moment the code is applied; signing
  in person always uses a signature; signing your own document is free only under your own name and address;
  being asked to sign again after a change is free; a public form holds none of its owner's signatures and
  takes one at the moment a visitor finishes: if none is free then, the visitor is told politely, what they filled
  in is kept and the owner is emailed; a form never takes a signature held for an envelope that is out and never
  takes the balance below zero (a stranger can still use signatures up by really signing, 20 starts an hour per
  address); only US dollars are accepted.
- **After someone has signed**, any change to what is printed on the pages asks everyone who finished to sign
  again (the sender has to choose that; nothing changes silently). That lock covers the whole envelope, including
  a new empty field for someone who has not signed yet. It is deliberately strict; loosen it in `printedView()`
  in `src/server/envelopes.ts` if you prefer a per-document rule.
- **Raising the price** has a rule, and the server holds you to it: 30 days of notice (`PRICE_NOTICE_DAYS` in
  `src/lib/policy.ts`). In this order: (1) on `/app/operator`, "Announce a price change" with the new price and a
  first day at least 30 days away. That emails every owner and admin of every paying account and records the
  notice. (2) Change `PRICING.monthlyUsd` for new customers whenever you like. (3) With the payment provider, move
  existing subscriptions to the new price so that it first applies on or after the announced day. Until an account
  has had its notice, a renewal above the price it was on is refunded the difference automatically and you are
  told; it still gets the full month of signatures. A lower price needs no notice.
- **The free code** (`GROWalition` by default) is in this source code. If the repository is public, so is the
  code, and nothing limits how many accounts use it. Change it with `FREE_PLAN_CODES`.
- **Impact factors** in the same file are commonly cited estimates. Check them against a source you are happy
  to stand behind publicly.
- **The 100% promise and the trees per dollar** are business commitments. The app records what was paid and
  displays it. Actually moving that money to tree planting is something you do, and should be able to show.
- **A person has to answer, and in time.** Set `SUPPORT_EMAIL` and `OPERATOR_EMAILS` and decide who reads the
  queue. The public pages promise that a person replies within `SUPPORT_FIRST_REPLY_HOURS` (urgent requests within
  `SUPPORT_URGENT_REPLY_HOURS`), in real hours, nights and weekends included. Set numbers your team can keep: a
  missed one is said out loud to the customer, and the help page shows the real median once there are 10 answers.
  Make sure the timer runs (`CRON_SECRET`), because it is what notices a late request.
- **Stripe** is implemented but has only been tested against a stand-in (`tests/stripe-fake.ts`), never a live
  account. Run through it once in Stripe's test mode before taking money: subscribe, renew with a test clock,
  cancel, refund, a failed payment, a dispute, a top-up (check its invoice shows on the Plan page once, not as a
  second payment). Stopping billing by card and the operators' card lookup use Stripe's charge search, which is
  the least certain part. Finding the card charge behind a monthly payment asks Stripe for the invoice's payment,
  whose shape changed between API versions; both shapes are read, but only test mode will prove it. Card
  statements show only your Stripe account's statement descriptor; set one that people will recognise. If the
  Stripe account is shared with something else: everything Sign&Grow starts there carries its own mark
  (`sg_account` in the metadata), and invoices, checkouts, subscriptions and disputes without that mark or for
  another price are left alone. Also send the webhook these events: `charge.dispute.closed`, `refund.failed`.
- **Signing in with Google or Microsoft** has only been tested against a stand-in (`tests/signin.test.ts`), never
  against the live providers. Before switching it on for real, go through it once with real client ids: sign up,
  sign in again, cancel at the provider, connect and disconnect under Settings, and a Microsoft work account as well
  as a personal one. Three things to know: an unconfirmed login can still be started in someone else's name (with a
  password as before, or now with a Microsoft account that claims their address), and although every way in is cut
  off when the real owner arrives, what that login made stays in it (team members, webhooks, drafts), which is why
  the notice tells them to look; whoever opens our "Confirm your email" link confirms the login it belongs to,
  whoever made it; and closing an account still asks for a password, so someone without one sets one first.
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
