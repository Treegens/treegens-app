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
| `tests/integrity.test.ts` | What people sign is what they saw: every signer is shown everything the sender wrote, nothing printed changes after a signature unless the signer is asked to sign again, a signing page left open cannot finish on a document that was changed, the audit trail says what a correction changed, a replaced signer starts with empty fields, a save from an older copy of the editor is refused, a replaced email is still recognised as genuine, a changed signing order is enforced. A second round covers what a second look found: names and addresses that a field prints are wording too, what a finished signer left empty stays empty, the page loads a replaced file again before Finish works, a hand-over inside one inbox passes on nothing, changes made outside the editor count as a newer version, nothing in a request is dropped or cut short without a word, and whoever signed keeps the document as they signed it. |
| `tests/trust.test.ts` | Everything built in answer to complaints: correcting a sent envelope, lost links, deadlines, checking an email is genuine, reports and pauses, export, team hand-over, the help form, closing an account. |
| `tests/autoplace.test.ts` | Placing fields automatically from the text of a document. |
| `tests/qr.test.ts` | QR codes made by the app itself: every version from 1 to 40 read back by a reader written apart from the encoder (format and version bits, the mask taken off, the blocks put back together, Reed-Solomon checked, the text out), fixed matrices that outside decoders read from pixels, the fixed parts of the picture, the four penalty rules and the choice among all eight masks, the SVG with its light margin and nothing of the text in it, what is refused (too long, not a web link, a user name in front of the address), the words on the dialog and the sheet, the public address a form's code is drawn from, and a personal code that stops opening the document when its link is replaced. |
| `tests/platform.test.ts` | Platform and security: links in emails never come from a request header, the caller's address behind a proxy, what an API key may do and what it says when it cannot be used, keys when a member is removed, closes their own login or an account is closing, and webhooks (logged before the first try, sent to the address that was checked, sent again, paged). |
| `tests/abuse.test.ts` | Keeping scammers and strangers out: the filter for fake payment notices where an email is started and where it is written (first send, correction, reminder, bulk, public form, void, the next person in a signing order, a decline notice, a team invitation), with the spellings it is known to catch (spaced, glued, look-alike letters and digits, phone numbers however they are punctuated) and the honest senders it must let through; a payment that lifts the checks only after 14 days; the daily limit on people newly emailed, with its own count for each public form and for team invitations; what a paused account can and cannot do, and what is held back and released; reports that count, reports through a public form that do not, and reports about documents that were deleted; who may read a support message and who may confirm an address; access codes that freeze; public forms that never hand out someone else's document; and reporting an email with its security code. |
| `tests/api.test.ts` | Calls that are repeated or cross each other: an `Idempotency-Key` that belongs to one person and goes with its envelope, a bulk send that is repeated while it runs or finished after the server stopped half way, one audit line a day for an embedded signing link, two Finish, Decline, Void or reassign requests at the same moment, a whole batch reminded or voided while someone in it signs, and signed PDFs made from fillable forms, whether the form was sent or attached by a signer. |
| `tests/lifecycle.test.ts` | Accounts, teams and deleting: someone removed from a team can still sign in (a workspace of their own, the welcome signatures once) and be invited again, nobody removes themselves, a hand-over names a member who stays, takes bulk sends along and is written to each audit trail, a deleted account leaves no names, addresses, email copies or signer files behind and keeps the money records without names, a closing account takes on nothing new and its owner is emailed a week before the end, members use every template but change only their own and see only their own folders and batches, a completed envelope its sender deletes stays with its recipients, help references nobody can misread, a signer's help request that reaches the sender, and sign-in opening the workspace used last. |
| `tests/support.test.ts` | Help requests as tickets: the whole life of a request from both sides, the published response times and the timer's escalation when one is late, reopening and the follow-up after 30 days, the link that works without a login (right secret, wrong secret, another request's secret), what a customer can never see (internal notes, another customer's request, an answer written to somebody else's mailbox), the operator queue and who may work it (nobody else, and no API key), the payment alerts in the same queue, the real median, the limits on the link and the form, and deleting an account with its threads. |
| `tests/signerux.test.ts` | The person who signs, and the email that reaches them: a saved signature is confirmed before it goes on a page and never offered across two people at one address, "Finish later" carries the signature to another device, "Fix my name" cannot turn one signer into another, dead and replaced links tell the sender, "Email me the current link" and "Find my documents" say what they did, scans and pictures are flagged page by page and stay flagged, the sender's field count matches the signer's, emails the mail server refuses are tried again and the audit trail says so, and someone who signed keeps a copy when the envelope is closed. |
| `tests/signin.test.ts` | Signing in and signing up with Google or Microsoft, against a stand-in for both (an RSA key made in the test, their key lists and token endpoints answered by a fetch stub, ID tokens signed and forged there): a new person, a returning one, a state that is missing, made up, from another browser, used twice or too old, every check on the ID token (signature, "none", HS256 keyed with the public key, issuer, Microsoft's organization rule, audience, expiry, nonce), keys cached and fetched again for an unknown key id, an address in a token never opening an existing login unless the provider vouches for it, a login someone else started in a person's name being cut off from them, invitations, free codes, a closing login coming back, a removed member's workspace, connecting and disconnecting under Settings, the last way in, a first password by emailed link, API keys kept out, no redirect off this site, and nothing answering when a provider is not configured. |
| `tests/signercode.test.ts` | Checking who signs, with the text message provider stood in for (a fetch stub for Twilio and for the generic hook, and the outbox): what each setting switches on and what is refused without one, what a link gives away before the code is typed, the code (ten minutes, five tries, only the newest, never in an answer or in the database), every limit on codes and on texts, "not my number", Twilio and the hook called with the right body and credentials, a provider that fails or refuses, the signing link by text and who is never texted, the daily stop, corrections and passing a document on, templates, bulk rows and public forms, the audit lines and the certificate text. |
| `tests/gaps-nonus-words.test.ts` | What the product says to people outside the United States, and whether it is true: the consent text (what kind of signature this is, never that it equals a handwritten one) and its version in the audit trail, a QR code promised only because the app now draws one, the sentence about English, what "fix my name" really does, every public price written as US$ with the line about currency, the check before sending (which words set it off, which do not, that it warns and never blocks, the `warnings` in the answer to sending and the line in the audit trail), every country note dated and resting on a source the research names, "Where your data is" filled from settings with what was not stated said out loud, the data processing summary, and the line in signing emails for someone who cannot open the page. |
| `tests/gaps-nonus-text.test.ts` | Text, dates, numbers and names outside the US and outside the Latin alphabet: a signed PDF with Chinese, Japanese, Korean, Thai, Hindi, Arabic, Khmer and Cyrillic names read back out of it, a script with no font (flagged to sender and signer, marked on the page, listed in the certificate) and a font file that is missing, right-to-left text with digits and Latin words in it (order, alignment, the typed text kept in the PDF), one date format for typed dates and the date of signing, the account's default format, the date of signing by the signer's own calendar with local time and zone on the certificate, deadlines with time and zone in emails, reminders that wait for a signer's morning, numbers as they are written outside the US, and a signer fixing the spacing of their name or offering it in another script. |

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
| A typo after sending means void and start again. | An envelope that is out can be corrected in place: names, addresses, fields, people. Signatures already collected stay. Once someone has finished, the pages they signed only change if the sender chooses to ask them to sign again. That covers the files, the fields, the sender's wording and any name or address a field prints on the pages, by every route: the editor, the API, the quick correction, a signer passing the document on or fixing their name. They are told what changed, the first signature stays on record together with the document as they signed it, and it costs no extra signature. What a finished signer left empty or unticked is their answer and is never filled in again. A signer whose page is open during a correction cannot finish on the old version: the page loads the changed document again, and Finish stays off until its pages are on the screen. A change made outside the editor (a quick correction, a hand-over, sending) is a newer version too, so an editor that was opened before it cannot undo it. The audit trail says what every correction changed. |
| Signing links expire or stop after a few opens. | A link works for as long as the envelope is open, with no limit on opens. A replaced link offers to send the current one. `/help` emails anyone their documents again. An expired envelope is reopened, not rebuilt, and signers can ask for more time. |
| Signers are pushed to create an account. | Signers never need an account or a password, and are never sent marketing. |
| "I cannot tell a real request from a scam." | Every signing email names the sender and carries a security code that anyone can type into `/check`. Senders must confirm their email, and the confirmation link only works together with the login's session or password, so nobody confirms a login that a stranger made in their name. Until an account has a payment that is 14 days old and was not refunded or disputed (`PAID_TRUST_DAYS` in `src/lib/policy.ts`), or a person has cleared it, it has a daily limit on how many people it newly emails, however it reaches them, and cannot send what reads like a fake payment notice or send or invite under the name of a well-known brand. Paying does not switch that off at once. Recipients can report a request from the email itself or from the signing page, also after the sender has deleted the document, and enough reports pause the sender until a person has looked. The filter (`src/server/fakenotice.ts`) catches the common trick in the spellings the tests list, not every scam: a notice worded another way, or a brand that is not on its list, passes. Reports and the pause are the backstop. |
| "They say they never got the email." | The envelope shows whether each email left, and the audit trail only says "Sent to recipient" when the mail server took it. An email it would not take is tried again by the timer for about a day and a half, and the sender is told when that fails for good. The sender is told when a request sits unopened, and can copy the signing link, remind one person or correct the address. |
| The account was locked with our contracts in it. | Cancelling, a failed payment or a pause never deletes or locks a document. Pausing stops what a sender starts from being emailed (new sends, new or changed recipients, reminders, reopening, team invitations, notices about a change, and people further down a signing order wait until it is lifted). People who already have a document can still sign it and are sent their copy, a document that is out can be given more time, and it can be voided (the people on it are told, without the reason). |
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
| The signing screen says an electronic signature equals a handwritten one, and where I live it does not. | The text every signer agrees to says what this is: a simple electronic signature, usable in many countries for agreements that need no special form, with rules that differ by country and by kind of document, and it tells the signer to ask the sender or a lawyer when unsure. It no longer says that such a signature equals a handwritten one, on the consent screen or under "Adopt and sign". The signer also accepts the electronic method as the way the parties sign. The wording has a version, the audit trail records which version each person agreed to, and `/help` prints the words. Research: `research/gaps-partial.json`, "map:nonus". |
| Nothing warned me that this kind of document cannot be signed electronically in my country. | A check before sending reads the subject, the document names and the text of the documents for words that usually mean a will, a trust deed, a power of attorney, a sale of land or a long lease, a fixed-term employment contract or a notice of termination, or a deed that needs a witness or a notary (one list, `src/lib/paperwork.ts`, in English, German, Spanish, Portuguese and French). The review step of the editor names the word and where it stands, the API answers sending with the same list as `warnings`, and the audit trail records it. It warns and never blocks. `/help` has one section with the documents not to sign here and short notes by country, each with the month it was looked at and its source, and says that none of it is legal advice. A sender whose clock is set to India or Indonesia is told that signing does not pay stamp duty. |
| The price said $9 and I could not tell in which dollars. | Every price on a public page is written as US$, with one line: prices and payments are in US dollars, and a bank may add a fee for converting. |
| I cannot find out where my documents are stored or who else handles them. | `/security` has a block "Where your data is", filled from settings (`OPERATOR_NAME`, `DATA_REGION`, `DATA_HOST`, `DATA_BACKUPS` and the provider settings): where the server is, who else handles data, in which country and what for. A provider is listed only when its switch is on, and whatever the operator has not stated is printed as "has not said ... Ask them." instead of being left out. `/security/processing` is a plain data processing summary to save as a PDF, and says that a signed agreement is between the customer and whoever runs the server. |
| My signer cannot open the page where they are, and nobody says what to do. | Every email that asks someone to sign ends with one line: reply and ask the sender for the document as a PDF. `/help` tells the sender what to do then, and that a signature collected that way is outside the certificate. No claim is made about any country, because none was tested. |
| My signers do not read English and nobody told me. | The landing page, `/help`, `/security` and this file say it in one sentence (`LANGUAGE_NOTE`): the signing screen and the emails are in English for now, and the document can be in any language. `/help` prints the consent text so a sender can translate it. Languages themselves are not built yet. |
| A name in Chinese, Thai or Hindi comes out as empty boxes on the signed document. | The signed PDF and its certificate print Latin (with accents), Greek, Cyrillic, Arabic, Hebrew, Armenian, Georgian, Chinese, Japanese, Korean, Thai, Devanagari (Hindi, Marathi, Nepali) and Khmer, with the letters joined and stacked as the script needs, and only the font files a document uses are embedded in it. For any other script (Tamil or Bengali, say) nothing is printed as an empty box: the sender is told on the envelope page and before sending, the signer in the check before finishing, each such character is printed as the mark �, and the certificate lists them by Unicode number. A font file that is missing after a broken install counts the same way instead of failing the PDF. A typed signature shows four handwriting styles only when the handwriting fonts can write the name, and one plain style otherwise. |
| Hebrew or Arabic typed into a field is reversed, and house number 42 becomes 24. | Right-to-left text is put in reading order on the signed PDF and the certificate, with digits and Latin words inside it left to right, and it starts at the right edge of its box. The fields on the signing page take their direction from what is typed. The words as typed are also written into the PDF next to the glyphs, for programs that copy or search. |
| The dates on my document are in American order, and one page shows two formats. | One format for every date on an envelope: the date each person signs on, and any date they pick in a date field, on the signing page, in what other signers are shown and on the PDF. An account sets the format its new envelopes start with (Settings, Account), and the formats with the month as a word are listed first. Nothing is ever converted to month-first unless the sender chose that. |
| The signing date is a day off from my own calendar, and no time zone is given. | The date of signing is the calendar day where the signer is, by the time zone their device reports with consent and with Finish (falling back to the sender's zone, then UTC). The zone is written to the audit trail, and the certificate prints the signer's local time with its zone next to UTC for each of their steps. A signed PDF is built once and never changes afterwards. |
| The email said the 20th, the page said the 21st, and it closed at 9:40 in the morning. | A deadline is a moment, and it is always given with its time and its zone: in emails in UTC ("closes on 20 March 2027 at 16:40 UTC") and in the signer's own zone as well once their device has told us which it is, on the signing page and the sender's pages in the reader's local time with the zone named. |
| Reminders arrive at one in the morning. | Once a signer's time zone is known, automatic reminders keep to their daytime, 8:00 to 20:00 there. One that falls in their night waits for the morning, and the audit trail says so. Without a known zone it goes out at about the hour the envelope was sent, as before. A reminder the sender sends by hand always goes at once. |
| An amount written 1.234,56 is refused. | A number field takes numbers the way people write them: 1.234,56, 1 234,56, 1'234.56, Indian grouping (1,23,456), a currency sign before or after. The signing page and the server check with one rule (`src/lib/numbers.ts`), and what was typed is printed exactly as typed. |
| My name was cut at the first space, and I could not fix how it is written. | One name as written, everywhere: no screen or share text greets anyone by a guessed first name, and a new workspace is named after the whole name. A signer can fix a letter, the spacing, a hyphen or a dot of their own name ("山田 太郎" to "山田太郎"). A name offered in another script (Cyrillic to Latin, kanji to Latin) goes to the sender to confirm, and the signer is told that it may well be the same name, not that it is a different one. |

## What is in it

**Sending**
- Upload PDFs, PNGs or JPEGs. Several documents per envelope, reorder and rename them.
- Recipients who sign, approve, only view, get a copy, or sign in person on your device. Signing in person needs an
  internet connection from opening the document to pressing Finish: there is no offline mode.
- Signing order (sequential, parallel or mixed) or everyone at once.
- Field editor: signature, initials, date signed, name, email, company, title, text, number, date, checkbox,
  radio group, dropdown, signer attachment and sender notes. Click to place, drag to move, resize, nudge with
  arrow keys, duplicate, copy to every page. Required or optional, prefilled, read only, validated.
- Access codes (at least 4 characters, frozen after 10 wrong tries until the sender sets a new one), private notes
  per recipient, email subject and message.
- A one-time code before the document opens, per recipient: by email, or by text message to a mobile number the
  sender types, and the signing link by text as well (both only where the operator has switched text messages on).
  See "Checking who signs" under Configuration.
- Automatic reminders: a new account starts with one every 3 days to whoever has not finished
  (`DEFAULT_REMINDER_DAYS` in `src/lib/policy.ts`), the last step before sending shows the setting with a way to
  change it or switch it off, and Settings, Account sets what new envelopes start with. An account made before that
  default keeps the number it had, which may be none. A warning before a deadline, more time in one click, reopening
  after expiry.
- Correct an envelope that is already out, without voiding it. Remind one person. Void with a reason.
- A check before sending: when the subject, a document name or the text of a document names a kind of document
  that often needs paper, a witness, a notary or a qualified signature (a will, a power of attorney, a sale of
  land, a fixed-term employment contract and so on), the review step says which word it saw and links to the help
  page. It warns and never blocks, and the audit trail records it. Through the API the same list is `warnings` in
  the answer to sending, and `GET /api/envelopes/:id/warnings` before it.
- Sign a document yourself, clone an envelope, save any envelope as a template, folders, search that also
  looks inside documents.

**Signing**
- No account needed. Works on phones.
- Consent to electronic records before any field opens. The text says what kind of signature this is (a simple
  electronic one), that rules differ by country and by kind of document, and that some documents need more. It
  never says the signature equals a handwritten one. The wording has a version (`CONSENT_VERSION` in
  `src/lib/policy.ts`), the audit trail records which version each person agreed to, and `/help` prints the words.
- Guided "Next" through required fields, progress bar.
- Adopt a signature by typing (four handwriting styles for names in Latin letters, one plain style for other
  scripts), drawing or uploading. Saved signatures for account holders.
- Finish later, decline with a reason, assign to someone else, ask the sender a question, fix a slip in the
  spelling of your own name (a bigger change is passed to the sender), ask for more time, stop reminders, report a
  request. View or print at any time.
- Sees what earlier signers already filled in.

**After signing**
- Final PDF with every value stamped in, signer attachments appended, and a certificate of completion:
  recipients, timestamps (UTC, and the signer's local time with its zone when their device reported one), IP
  addresses, consent, signature images, document hashes and the full audit trail. "Every value" holds for the
  scripts listed under "Scripts and fonts in the signed PDF" below. A character in any other script is printed as
  a visible mark and listed in the certificate, and both sender and signer are told before signing.
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
  Its block "Where your data is" is filled from settings (see Configuration) and says what the operator has not
  stated. `/security/processing` is a data processing summary on one page, made to be saved as a PDF from the
  browser: what is processed, for whom, for how long, where, and how it is deleted. It is a description, not a
  contract.
- `/help#outside-us`: "Signing outside the United States, and documents that should not be signed here". What kind
  of signature this is, the documents not to sign here, the words the check before sending looks for, and short
  notes by country, each dated and with its source. Not legal advice, and it says so.
- `/app/operator`: the queue of help requests, reports and paused accounts, for the people in `OPERATOR_EMAILS`.
  Each request and report shows the account it is about (plan, age, trusted or not), with "Trust this account" to
  lift the daily limit and the fake-notice filter for it, and "Pause this sender". A report stays in the queue
  when its sender has deleted the document since, and a report that came through a public form is marked as such.
  Help requests are answered right there, not by email (see "How support works").

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
- Bulk send a template to a pasted or uploaded CSV list (up to 500 per batch). Remind or void a batch as one. It is
  on both plans, and it costs what signing costs: each person who signs uses one signature, and a batch only goes
  out when all of its signatures are already in the balance (40 people on the monthly plan from an empty balance is
  US$40 before anyone signs). The page shows how many a list holds, how many there are, what is missing and what
  that costs before the Send button, from the server's own count (`POST /api/bulk/check`).
- PowerForms: a public link anyone can use to fill in and sign a template. An unfinished start is only given back
  to the browser that made it, never to whoever types the same email address, and is cleared after a quiet day.
- QR codes, made by the app itself (`src/lib/qr.ts`, no library and no outside service: the code is drawn in the
  browser from the link, so the link is sent nowhere to make it). "QR code" next to each PowerForm opens a sheet to
  print (the name of the form, the code, one line on what scanning does, the link written out) and saves the code
  as a picture. "Show QR code" next to "Copy link" on an envelope lets someone standing next to the sender open
  their own link on their own phone; it says that the code is the link and who may see it, and takes the code off
  the screen after two minutes (`QR_SHOW_SECONDS` in `src/lib/qrlink.ts`). A public form that is open on a big screen offers its own code, for a visitor who
  would rather use their own phone. No code is made for a link longer than 300 characters or for anything that is
  not a plain web link.

**Team and admin**
- Accounts with owner, admin and member roles, email invitations (from a confirmed address, 20 people a day, none
  while sending is paused), multiple accounts per user.
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
- Languages other than English. The signing screen and our emails are in English for now. Your document can be in
  any language. (The sentence the pages print is `LANGUAGE_NOTE` in `src/lib/policy.ts`.)
- ID verification (government ID, knowledge-based checks) and checks by phone call. A one-time code by email or by
  text message is in (see "Checking who signs"); it shows that someone can read a mailbox or holds a phone, not who
  they are. Text messages only exist on a server whose operator has set a provider up.
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

## Scripts and fonts in the signed PDF

On screen and in emails every script works, because the browser and the mail program bring their own fonts. A PDF
has to carry its fonts with it, so what the signed PDF can print is decided here, by `src/server/pdftext.ts`.

- **What prints:** Latin with accents, Greek, Cyrillic, Arabic, Hebrew, Armenian and Georgian from DejaVu Sans
  (package `dejavu-fonts-ttf`, the DejaVu Fonts licence, which is the Bitstream Vera licence with additions).
  Chinese, Japanese, Korean, Thai, Devanagari and Khmer from Noto Sans (packages `@fontsource-variable/noto-sans-sc`,
  `-jp`, `-kr` and `@fontsource/noto-sans-thai`, `-devanagari`, `-khmer`, all under the SIL Open Font License 1.1).
- **How the fonts get there:** `npm install` runs `scripts/copy-assets.mjs`, which calls `scripts/build-fonts.mjs`.
  The Noto packages ship web fonts, which the PDF library cannot embed, so each is written out once as a plain
  TrueType file into `assets/fonts/noto` (340 small files, about 16 MB, about ten seconds the first time). The
  Chinese, Japanese and Korean packages are "variable" fonts whose built-in weight is Thin: they are written out at
  the Regular weight. The packages add about 17 MB to `node_modules`. A signed PDF embeds only the pieces its text
  uses: a test document with all of the scripts above in it is about 60 KB.
- **When a font is not there:** if the font step fails, or a file is missing or unreadable, that script counts as one
  the PDF cannot print. Nothing crashes: the sender and the signer are warned, the characters are printed as the
  mark �, and the certificate lists them by Unicode number. The same happens for every script not listed above
  (Tamil, Bengali, Gujarati, Telugu, Ethiopic and others) and for most emoji. To add a script, add its Noto package
  and one line in `scripts/build-fonts.mjs`, sign a test document and look at it: the letters of many scripts join
  and stack, and only a reader of the script can say whether the result is right.
- **Right to left:** Arabic, Hebrew and Persian are ordered by a small version of the Unicode bidirectional rules
  (`src/server/bidi.ts`): the first letter decides the direction of a field, numbers and Latin words inside stay
  left to right, brackets are mirrored. The certificate is an English page, so there a name, a subject or a file
  name is ordered by itself inside our line. The app's own screens are English and are not mirrored.

Known limits, said plainly:

- Chinese characters are drawn in the Japanese form when the same text has kana in it, in the Korean form when it
  has Hangul, and otherwise in the mainland Chinese form. A Japanese name written only in kanji, and text from
  Taiwan or Hong Kong, therefore get mainland forms. Readable, not always what a native reader expects.
- Scripts from the Noto fonts are printed in regular weight, also where the certificate sets a line in bold.
- Text copied out of the PDF: every line that is not plain left-to-right text carries the words as typed
  (ActualText), which Poppler-based tools use. A program that ignores it (pdf.js is one) gives Hindi and Khmer in
  the order the glyphs are drawn, which for some syllables is not the typing order.
- In the audit trail on the certificate, a right-to-left phrase that is not one of the envelope's names (a reason
  for declining typed in Arabic with a number in it, say) is ordered as part of the English sentence around it.
- The joining of letters is done by `@pdf-lib/fontkit` 1.1.1, with two repairs that live in `pdftext.ts` (a helper
  the library expects and does not ship, and a crash on fonts that leave an attachment point out). If shaping a
  piece of text fails anyway, it is printed letter by letter rather than failing the signed PDF, and the server log
  says so. Drawing also leans on how pdf-lib 1.17 keeps fonts inside a document. `tests/gaps-nonus-text.test.ts`
  builds and reads back a PDF in every supported script, so an upgrade of either library that breaks this fails
  there.

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
| `NEW_ACCOUNT_DAILY_RECIPIENTS` | How many people an account that has not paid can send to per day during its first week. "Has not paid" means: no payment for the plan or a top-up that is at least 14 days old and was neither refunded nor disputed (`PAID_TRUST_DAYS` in `src/lib/policy.ts`), and not marked as trusted in the operator queue. So an account that paid yesterday still has the limit, and its refusals give the day it ends. Everyone a sender newly emails counts: a first send, a person added or an address changed on an envelope that is out, a bulk row. The visitors of a public form are counted apart, against the same number for each form, so a stranger on a form never uses up what its owner may send. Team invitations have a limit of their own, 20 people a day for each account (`TEAM_INVITES_PER_DAY`). | `50` |
| `UNPAID_DAILY_RECIPIENTS` | The same limit after the first week. A payment lifts both once it has stood for 14 days, and so does "Trust this account" in the operator queue, at once. The same two things lift the filter for fake payment notices. | `200` |
| `ABUSE_SUSPEND_AFTER` | How many different recipients must report an account within 30 days before its sending is paused for review. Open reports and reports an operator confirmed as abuse both count, also reports made with the security code of an email whose document was deleted since. Reports from visitors of a public form are shown to operators and never count, because such a visitor typed their own name and address. | `3` |
| `POWERFORM_IDLE_HOURS` | An unfinished start from a public form that nobody has touched for this long is closed, so it no longer counts against what the form can still take. Typing counts as touching. The visitor can start again. | `24` |
| `POWERFORM_SHARED_IDLE_MINUTES` | The same, for a form its owner marked as filled in on a shared device (a tablet at the front desk, one office network). Such a form also allows 30 unfinished starts from one address instead of 3, and offers "start a new form for the next person" when someone has finished. | `60` |
| `DORMANT_AUTO_STOP_DAYS` | A paid plan that has sent nothing for this long is not renewed. `0` only warns. | `90` |
| `UNOPENED_ALERT_HOURS` | How long a request sits unopened before the sender is told. | `48` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Switches on "Continue with Google" on the sign-in and sign-up pages and under Settings. Both must be set. With either missing, nothing about Google is shown anywhere and its routes answer 404. Register the redirect address `APP_URL` + `/api/auth/google/callback` with Google (see below). | none |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The same for "Continue with Microsoft". Redirect address: `APP_URL` + `/api/auth/microsoft/callback`. | none |
| `MICROSOFT_TENANT` | Who may sign in with Microsoft: `common` (work, school and personal accounts), `organizations` (work and school), `consumers` (personal), or the id of one organization (the "Directory (tenant) ID", a value like `11111111-2222-3333-4444-555555555555`). A domain name is not accepted: Microsoft sign-in then stays off and the server log says why. | `common` |
| `OPERATOR_NAME` | Who runs this server: legal name and country. Printed on `/security` ("Where your data is") and on the data processing summary (`/security/processing`), which says that a signed data processing agreement is between the customer and this party. Empty: the pages say "The operator of this server has not said who they are. Ask them." | not stated |
| `DATA_REGION`, `DATA_HOST` | Where the server and its files are (for example `Frankfurt, Germany`) and the hosting company. Plain text, printed as written. Empty: "The operator of this server has not said where it is hosted. Ask them." There is one region for everything, because storage is one disk. | not stated |
| `DATA_BACKUPS` | One sentence on whether and where backups are kept and for how long. Empty: the pages say that this was not stated. | not stated |
| `MAIL_PROVIDER_NAME`, `MAIL_PROVIDER_COUNTRY` | The company behind `SMTP_URL` and the country it handles email in. Listed among "who else handles data" only when `SMTP_URL` is set. | not stated |
| `PAYMENT_PROVIDER_COUNTRY` | The country of the Stripe company the payment account is with. Stripe is listed only when `STRIPE_SECRET_KEY` is set. | not stated |
| `SMS_PROVIDER_NAME`, `SMS_PROVIDER_COUNTRY` | The text message provider and where it handles messages. Listed only when text messages are switched on. The name is known without this setting when the provider is Twilio. | not stated |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | Switches text messages on, sent through Twilio with `fetch` (no SDK). The account id and the token are both needed, and one of a sending number in international form or a messaging service (which wins when both are set). With one of them missing text messages stay off and the server log says which. See "Checking who signs". | none |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | Switches text messages on through any other provider: every text is one `POST` to the address with the JSON body `{"to", "text"}` and `Authorization: Bearer <token>`. Answer 2xx when the text was taken. 400 or 422 means the number can never be texted, which is final. Anything else is tried again by the timer like an email. Twilio wins when both are set up. | none |
| `SMS_DAILY_PER_ACCOUNT` | The most text messages one account can cause in 24 hours: one-time codes, signing links and reminders, every new one counted, also a code that is asked for again. A hard stop, because a text costs the operator money and customers are not charged for it. The refusal says when there is room again. `0` lets none through. | `200` |
| `SMS_DEV_OUTBOX=1` | Development only: text messages are switched on without a provider and are only written to `/dev/outbox`. Ignored on a production server unless `DEV_OUTBOX=1` is set too, because nobody receives anything. | off |
| `ALLOW_PRIVATE_WEBHOOKS=1` | Accepts webhook addresses that are not public https. Local development only. | off |
| `DEV_OUTBOX=1` | Shows the outbox in a production build. Never set this on a public server: it exposes every signing link. | off |

`/help`, `/` and `/security` quote the refund window and the unused-plan rule. They read them from
`src/lib/policy.ts`, the same file the server enforces them from, so the pages and the code cannot disagree.

### Checking who signs

For each recipient the sender chooses what has to happen before the document opens (the editor, step 1, "More"
next to a recipient; in the API `recipients[].verify`, `recipients[].phone` and `recipients[].text_link`):

| Check | What happens | What it proves |
| --- | --- | --- |
| none | The link from the email opens the document. | That the email reached a mailbox. Nothing about who opened it. |
| access code (`access_code`) | A secret the sender chooses and passes on themselves. Works as before and can be combined with a one-time code: it is asked for first. | That whoever opened the document was told the code. |
| one-time code by email (`"verify": "email_code"`) | A 6-digit code goes to the recipient's address when they press the button on the signing page. | That they could read the mailbox at that moment. It is the same mailbox the link went to, so it mainly stops a forwarded or left-open link. |
| one-time code by text message (`"verify": "sms_code"`, `phone`) | The code goes to a mobile number the sender typed, in international form. | That they held that phone at that moment: a second thing besides the mailbox. Only as right as the number the sender typed. |

The four sentences the pages print are `CHECK_PROVES` in `src/lib/checks.ts`. None of this looks at an identity
document.

**The code.** Six digits from `crypto.randomInt`, never stored (only an HMAC of it under `APP_SECRET`), valid for
10 minutes, dead after 5 wrong tries, compared in constant time. A new code at most once a minute and 5 an hour
for one recipient, 15 an hour for one caller address over every link it opens, 15 a day for one mailbox or phone
number whoever asks, all counted in the database (`signer_codes`). The numbers are in `src/lib/policy.ts`. Our
stored copy of a code email or text loses the code once the mail server or the provider has taken it. A device
that passed stays passed for that link for a day, with a cookie made the same way as the one for a correct access
code. Changing the check or the number, or the link passing to another person, makes every device pass again.

**Before the code is typed** `GET /api/sign/:token` answers with less than it does behind an access code alone: no
subject, no message, no documents, no other recipients, no reason for a void, and the email address and the
number only masked (`j***@example.com`, `+44 *** *** 4321`). No answer of any route ever holds the code.

**When the code does not come** the screen has "I do not get the code" and, for a text, "This is not my number".
Both are written to the audit trail and emailed to the sender whatever their notification settings, because only
the sender can fix it. After "not my number" no further code goes to that number until the sender corrects it.

**The record.** The audit trail gets a line when a code is sent (the channel and the masked destination), when a
wrong code is typed, when the check is passed, and for every correction of a check. The certificate of completion
says for each signer how they were checked, for example "One-time code sent by text message to +44 \*\*\* \*\*\*
4321, passed 12 March 2026 14:02 UTC", and "Link sent by email only" when there was no check.

**Text messages** are off until the operator sets a provider up: Twilio, or any other through `SMS_WEBHOOK_URL`
(see the table above). While they are off the editor does not offer them, `GET /api/me` says `text_messages:
false`, and the API refuses `"sms_code"` and `"text_link": true` with a sentence that says the operator has not
switched them on. A text the provider would not take is tried again by the timer like an email (`POST /api/cron`),
a refusal for good (a number that does not exist) ends at once, and either way the envelope page, the audit trail
and an email to the sender say what happened. In development, `SMS_DEV_OUTBOX=1` writes texts to `/dev/outbox`.

**"Also text the signing link"** (`text_link`, off unless chosen) sends a short text when the request goes out:
"Sign&Grow, sent for Ada Sender: "Lease" is waiting for you to sign." and the link. Reminders by text follow at
most once a day, and one number gets at most 4 such texts a day from one account. Someone who declined or reported
the document is not texted again, and someone who switched reminders off gets no reminder by text. A text counts like an email to that person: none while the
sender is paused or the envelope reads like a fake payment notice, and an account under the daily limit on emails
can text as many phone numbers a day as people it may email.

**What a text costs.** Texts are not charged to customers. `SMS_DAILY_PER_ACCOUNT` (200) is a hard stop per account
and 24 hours, every new text counted (`sms_usage`), and deleting an envelope hands nothing back.

**Corrections.** `POST /api/envelopes/:id/correct` and the editor take the check and the number. A change resets
any passed check for that person, clears "not my number", and is written to the audit trail with the numbers
masked. Changing the email address to another person's needs their number in the same call when a text is still
asked for. When a signer passes a document on themselves, the number is dropped, a check by text becomes a code
by email to the new person, and the sender is told.

**Templates, bulk send and public forms.** A template keeps the check of each role. A bulk send takes a `phone`
column (and `"phone"` per role in the API), and a row without one the template needs stops the whole batch before
anything is sent. A public form accepts a one-time code by email for its visitor and refuses a code by text and
"also text the signing link": the number would be typed by a stranger, and every start would send a text at the
operator's cost to any number they like.

**Where the phone number is kept.** On the recipient and nowhere else: not in contacts, not in the audit trail
(masked there), and in the record of a text only until the provider has taken it.

Not tried against a live provider: Twilio and the hook were only tested against a stand-in
(`tests/signercode.test.ts`). Send one real text in the provider's test mode before relying on it.

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
  the notice tells them to look; our "Confirm your email" link confirms a login only in a browser that is signed in
  to it, or together with its password, so the owner of a mailbox cannot confirm a stranger's login by clicking (a
  login without a password, made with Google or Microsoft, is confirmed after signing in); and closing an account
  still asks for a password, so someone without one sets one first.
- **Storage** is SQLite on one disk, which is fine for one server. Back the `DATA_DIR` folder up. Moving to
  Postgres and object storage is the step to take before running more than one instance.
- **`/security`** lists only what the code does. If hosting adds something (disk encryption, backups, a
  certification), add it there once it is true.
- **Where the data is.** Set `OPERATOR_NAME`, `DATA_REGION`, `DATA_HOST`, `DATA_BACKUPS` and the provider
  settings. Until you do, `/security` tells every visitor that the operator has not said, and a production server
  logs it at start. The data processing summary is a description the software can stand behind. A signed data
  processing agreement is yours to offer: have a lawyer write it, the software has none.
- **The notes by country and the consent text** (`src/lib/paperwork.ts`, `src/lib/policy.ts`) were written from
  research that could not open the primary sources (see `could_not_find` under "research:nonus" in
  `research/gaps-partial.json`). Several notes rest on a law firm's or a vendor's summary and are marked as such.
  Have a lawyer read them before launch, and change a note only together with its date.

## Layout

```
src/server    database, auth, envelope logic, PDF stamping and certificate, mail, webhooks, API routes
src/app       pages (public, app, signing screen) and the single API entry point
src/components  editor, PDF viewer, signature pad, shell, public navigation and footer
src/lib/impact.ts   every environmental number and the prices
research      what people complain about in other e-signature tools, with sources
tests         API tests and the browser test
```
