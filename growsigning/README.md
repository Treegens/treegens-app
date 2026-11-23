# GrowSigning

E-signatures without paper: send, sign, track and store agreements on screen.
What customers pay, less card fees, goes to Treegens tree planting.

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
| `tests/billing.test.ts` | Paying, against a simulated payment provider (`tests/stripe-fake.ts`): free signatures for a new account, the monthly plan, top-ups, renewal reminders, cancelling in the app, from an email link and by card, a charge after cancelling, refunds of unused signatures, a card dispute, an unused plan, free codes. |
| `tests/billing2.test.ts` | Paying when things go wrong: the provider's messages in any order, the provider failing half way, two refund requests at once, replayed checkouts and messages, cancelling while a payment is failing, slow payment methods, reminders on our own timer, a charge higher than the reminder said, the corners of the free code, and the ways round paying for a signature. |
| `tests/billing3.test.ts` | What a second round of attacks found: provider messages handled in the same instant, a refund whose answer is lost on the way back, refunding again when signatures come back, card disputes, top-up invoices and invoices that are not ours, cancelling in the awkward moments, the unused-plan rule, who pays for which signature, and a free code that is switched off. |
| `tests/billing4.test.ts` | What a third round of attacks found: a refund racing against a burst of sends, one customer's slow call not holding up another's, things on a shared provider account that are not ours, disputes the bank decides either way, a refund made by hand settling ours, cancelling when the provider cannot be asked, payments whose message was lost, and the corners of who pays for which signature. |
| `tests/billing5.test.ts` | The last open ends of the payment code: the provider's messages are answered within a few seconds and kept in an inbox until applied (a slow provider, a failure, a restart in between, three days of failing), a plan on hold can pay its open payment from the Plan page and is read back when that was paid elsewhere, an invoice that names no subscription is matched by asking the provider what the customer is subscribed to, and the price rule: a renewal above the price an account is on is refunded the difference unless a notice went out 30 days before, with the operator's announcement and the reminder that states the true amount. |
| `tests/billing6.test.ts` | What a third review of the payment core found: a plan set to end on the provider's page is worked out from what the provider says and survives a failed call, a payment that was waiting when a plan was stopped is never kept, a charge is never matched to one of ours by its amount alone (a refund or dispute of another product on a shared provider account changes nothing and a person is asked), a dispute's decision waits for the dispute itself, messages neither wait for ever nor hide newer ones from the timer, a refund the provider refuses three times goes to a person and the customer is told, a refund made by hand is emailed, free signatures count as used first, a $0 first invoice and an undelivered reminder are said as they are, the provider's early tax figure is quoted, and a silent mail server is given up on in seconds. |
| `tests/billing7.test.ts` | The terms around the price, and what a third review found: a returning customer pays what their new checkout showed, every account has its price written down (also the ones from before), a price notice goes to every plan in any state and counts only once it left for every owner and admin, a lower notice withdraws a rise and says so, the day of a change is the same day everywhere, tax inside a price is not counted twice, the stop page and the emails quote the account's own price, a paused plan and a code that ended read as what they are, a member cannot stop the team's plan by card, other products' invoices on a shared provider account never crowd out or delete ours, a form visitor told to come back keeps what they filled in and is emailed, a form with a second signer and the emails at two and at none, a refund still on its way when an account is closed at once, and one signature per person at a shared address. |
| `tests/billing10.test.ts` | What the earlier rounds left open about expiring signatures, with a fake clock: a signature used out of a top-up in the hour between the end of a month and its renewal payment moves to the new month when the payment arrives, only as far as the month has room, never twice, and not for a plan started again days later; one rule for "would the next signatures come out of a payment that stands" behind the tree sentence at review (a refunded payment promises nothing); two swaps to another person at the same moment with one signature free end as one done and one refused. |
| `tests/billing9.test.ts` | Signatures expire (decided 2026-11-20), with a fake clock: a month's 9 at the end of their billing period (also after cancelling, and a free code's at the end of the calendar month), top-ups 12 months after their payment, the trial's 30 days after the account was made; the soonest to expire is used first; a held one does not expire while held and is gone if let go after its date; the timer writes an "expired" history line; the ledger sums add up; an expired signature is not refunded, and a refund or dispute takes its own payment's first; the Plan page and the API show the reset date and each top-up's date; reminders say how many will expire; top-ups are emailed 30 and 3 days before, only when some are unused; trees count the money, not the signatures; `paidSignatureFor`; no page promises that signatures never expire; a held one whose date has passed does not pass to another person or to other documents (parking), and that is refused through every door when there is none of today's; the history tells "held and let go" from "expired unused"; the gap before a renewal payment arrives is said; and whoever sees 0 reads how many expired and when. |
| `tests/billing8.test.ts` | What a fourth review found: another product's invoice, refund or dispute on a shared provider account never mails, ends, takes or concedes anything of ours (also for a stranger), one that cannot be told apart goes to a person, and our own refund never goes to a charge found by its amount; a refund reported before its payment waits for it; a refund we owe that a person sends by hand in parts settles once they add up, with one email that says each part (also with a person after three refusals, and when we send the rest ourselves), and a closing account is told of one with a person; a mail server that stalls never holds Cancel (the emails follow from the outbox, and the timer sends one left behind); a price notice counts from when its email left; Cancel pressed and not confirmed survives the pay page being opened, a fresh read that is not set to end ends nothing, a second Cancel after a resume elsewhere asks the provider, and a second press after the plan ended says the same cancellation again; the stored price of an old row is a full-price month before its own tax; the Plan page reads an unwritten price like the money does; a small refund of our own leaves the limits lifted; two form visitors at once never take the balance below zero; "you can finish now" keeps the rules of every email and does not wait for ever behind a visitor who stays away; and a signer renamed away and back pays once. |
| `tests/ds-delegate.test.ts` | Someone who signs for you while you are away: off by default, the admins' switch, the dates, the sender's "Only the person named may sign" (before and after sending), whoever agrees first takes it, the person told when the delegate takes it on, signs or declines, the certificate line in the signed PDF, the person's saved signature never offered, one recipient and one signature, the one-time code, no passing it on or renaming, and not for in-person signing, self-sent documents or a delegate already on the envelope. After a skeptic's and a simplicity review: a delegation ends by itself after its last day (no reminder, no taking on), the delegate's code never ends the person's, the delegate's name follows the certificate name rules, side calls before agreeing, a correction back to the person restoring the sender's check, step 3 told who is away (never a delegate's address, never for witnesses, in person, groups or public forms), and the words (no "delegate" on the cards, sentences of at most 20 words on the signing page). |
| `tests/ds-colleagues.test.ts` | Working for a colleague: each level allows exactly its actions, dates respected, an ended share stops at once (owner, colleague, admin; not another member), a share ends for good when someone leaves (also when they are invited back) and never crosses accounts, drafts made with Send for go back to their maker when a share ends, See opens no file, a list that shows shared documents with their level, audit lines "Ana Silva <...> for Ben Okoro" and a "for" in the security record, moving one or many envelopes and templates (refused for others, the first sender kept on the certificate), sending for someone (share, admin-scope key, step 3's "Send for") with both names in the email, on the signing page and in the signed PDF, members without a share see nothing. |
| `tests/groups.test.ts` | Signing groups: who may keep and use them, a group on a draft, one email and one link per member, the first who agrees takes it on and two at once, handing back and giving back, asking to take over, declining for the group, reminders, the not-opened alert, the access code, Find my documents and the security code, a member's email that comes back, one signature per group, the group as it was sent, corrections to its members, templates, bulk sends, public forms, and the screens; and the repairs after a skeptic's check: a member's spam mark or report stops every email to that member, hand-back notes stay with the sender, a member who cannot act freezes only their own link, the sender signing for their own group is free, and what the sender is told always matches what was emailed. |
| `tests/ds-reports.test.ts` | Reports: numbers per template and sender on a seeded account (deleted finished documents and drafts counted nowhere, a member sees only their own), every filter, words for days and statuses that cannot be read, the CSV with formula cells quoted; the monthly email once, only on the first days, only to owners and admins who asked, not offered to a person working alone, never naming the people documents went to, the footnote naming where the switch is; saved lists saved, opened, refused in words (a header row alone too), people counted by the server, direction marks dropped from names, deleted by their maker or an admin, deleted after the account's days, a smaller number refused until confirmed, in the export, gone with the account. |
| `tests/finish.test.ts` | What was still open at the end: a member leaves a team by themselves, public forms on a shared device and on a closing account, the email check recognising codes of deleted documents from a fingerprint, and stored copies of emails going with a deleted person and after 90 days. |
| `tests/integrity.test.ts` | What people sign is what they saw: every signer is shown everything the sender wrote, nothing printed changes after a signature unless the signer is asked to sign again, a signing page left open cannot finish on a document that was changed, the audit trail says what a correction changed, a replaced signer starts with empty fields, a save from an older copy of the editor is refused, a replaced email is still recognised as genuine, a changed signing order is enforced. A second round covers what a second look found: names and addresses that a field prints are wording too, what a finished signer left empty stays empty, the page loads a replaced file again before Finish works, a hand-over inside one inbox passes on nothing, changes made outside the editor count as a newer version, nothing in a request is dropped or cut short without a word, and whoever signed keeps the document as they signed it. |
| `tests/gov-g18.test.ts` | Signing at a service counter: nobody has the counter permission until an admin gives it, person by person (API keys never); a template is a counter template only with someone who signs in person; the queue, Start from a template (an email for the copy required), taking over a colleague's person, other accounts seeing nothing; the signing page opens nothing (423) until the official records the identity check, each way checked (document with type, exactly 4 last characters and issuer, "known to me", eID refused as not set up) with the statement in the official's name and the "cannot check an ID" line; typed values hidden from the official unless the template allows it; a mark needs a witness and the official is not the witness unless the account allows it (checked again at Finish); someone signing for the person waits for a second official with their own login; read aloud and interpreter need a language and a name; help taken back leaves the certificate but stays in the trail; every statement on the certificate and in the evidence pack; the person's screen connects with a code once, for ten minutes, a new code replacing an unused one, guesses limited, waits before the check, gets the link after it and never again once finished, and Next person disconnects it; the hand-over lock on the official's own device; the receipt (ID, fingerprint, where the copy goes, /verify, the agency's contact); an ID picture only with encrypted files, encrypted in the database, in the evidence pack, and gone with a purged document; a pen on the pad; the words. |
| `tests/gov-g19.test.ts` | The full export and bringing documents in: data.json validated against the published schema, every file by its SHA-256, the manifest, evidence packs and no secret in it (no password hash, signing link, security or access code, webhook secret); owners, admins and an admin key only, also while paused or unpaid; a large export in the background with one email, the `export.ready` webhook, 7 days and then gone; a round trip into a fresh account with equal data and every id mapped; envelopes out for signature refused with a list and brought in once finished; a changed history line "not verified", a changed file or a schema mismatch refusing the whole import; a forged export that tries to open a template, switch on deletion, add people or set an access code; DocuSign PDFs, the envelope CSV, a ZIP of them and a template (FIXTURES from the documented layouts in `tests/fixtures/docusign/`, not real exports), the banner, no certificate said as such, `/verify` never saying completed here, and records deleted with their files. Also: a forged export naming another server is marked only as what the file says, a carried-over record never keeps its own banner or chain mark, a PDF with nothing of DocuSign in it is not brought in, a redacted line is skipped only when it shows the removal, an upload without a length is stopped at the limit, and direct exports are limited per hour. |
| `tests/trust.test.ts` | Everything built in answer to complaints: correcting a sent envelope, lost links, deadlines, checking an email is genuine, reports and pauses, export, team hand-over, the help form, closing an account. |
| `tests/autoplace.test.ts` | Placing fields automatically from the text of a document. |
| `tests/place-labels.test.ts` | Place fields for me on a document with no tags, blanks or form fields: a signature table (labels down the left, one column per person) gets a field in every empty cell and none in a filled one, with or without drawn borders; bare labels ("Signature:", "By:", a label under a drawn line, a label with no room beside it); two blocks side by side or under party headings are two people; a signer's name over a column or by a block wins over the order of the columns; sentences, headings, a table of contents, a data table with a Date column, a sign-in sheet and a filled-in form get nothing; a PDF made here and one exported by LibreOffice, both read with pdf.js. Second round, from the reviewers' finds: a heading, an indented line or a place and date just above the table is not taken for its header; a lead-in line such as "Signed by the parties:" gets no field of its own; signer numbers are worked out per table, so nobody becomes "Signer 3" while both signers have a column; nobody gets two columns and the closest name wins; a company over the name in a header cell and names typed into a Name row still match by name; two plain signature lines and two signers get one each; side by side blocks without colons, labels that wrap, labels under a typed or drawn line with the name between; sign-in sheets and staff lists with tall rows, definitions, bullet lists, an index of words and a plan table with an empty column get nothing; three more LibreOffice PDFs in `tests/fixtures/`. |
| `tests/bounces.test.ts` | Knowing when an email did not arrive: the ids every email carries, the address for the mail provider and its secret, one sample of each provider read like our own shape, hard and soft bounces, complaints and deliveries, matching by id (also after the envelope was deleted) and by address (only when one sender wrote to it), reminders that stop and start again, a complaint that no correction or new envelope undoes and only a code from the person's mailbox does, emails waiting for another try, news in any order, mail server text kept from customers, the warning before sending to an address that bounced, a login whose own address bounces, odd, huge and slow batches, and the Amazon SNS confirmation. |
| `tests/qr.test.ts` | QR codes made by the app itself: every version from 1 to 40 read back by a reader written apart from the encoder (format and version bits, the mask taken off, the blocks put back together, Reed-Solomon checked, the text out), fixed matrices that outside decoders read from pixels, the fixed parts of the picture, the four penalty rules and the choice among all eight masks, the SVG with its light margin and nothing of the text in it, what is refused (too long, not a web link, a user name in front of the address), the words on the dialog and the sheet, the public address a form's code is drawn from, and a personal code that stops opening the document when its link is replaced. |
| `tests/platform.test.ts` | Platform and security: links in emails never come from a request header, the caller's address behind a proxy, what an API key may do and what it says when it cannot be used, keys when a member is removed, closes their own login or an account is closing, and webhooks (logged before the first try, sent to the address that was checked, sent again, paged). |
| `tests/abuse.test.ts` | Keeping scammers and strangers out: the filter for fake payment notices where an email is started and where it is written (first send, correction, reminder, bulk, public form, void, the next person in a signing order, a decline notice, a team invitation), with the spellings it is known to catch (spaced, glued, look-alike letters and digits, phone numbers however they are punctuated) and the honest senders it must let through; a payment that lifts the checks only after 14 days; the daily limit on people newly emailed, with its own count for each public form and for team invitations; what a paused account can and cannot do, and what is held back and released; reports that count, reports through a public form that do not, and reports about documents that were deleted; who may read a support message and who may confirm an address (and that a new password confirms it too); access codes that freeze; public forms that never hand out someone else's document, and whose page never prints a fake payment notice; and reporting an email with its security code. |
| `tests/api.test.ts` | Calls that are repeated or cross each other: an `Idempotency-Key` that belongs to one person and goes with its envelope, a bulk send that is repeated while it runs or finished after the server stopped half way, one audit line a day for an embedded signing link, two Finish, Decline, Void or reassign requests at the same moment, a whole batch reminded or voided while someone in it signs, and signed PDFs made from fillable forms, whether the form was sent or attached by a signer. |
| `tests/lifecycle.test.ts` | Accounts, teams and deleting: someone removed from a team can still sign in (a workspace of their own, the welcome signatures once) and be invited again, nobody removes themselves, a hand-over names a member who stays, takes bulk sends along and is written to each audit trail, a deleted account leaves no names, addresses, email copies or signer files behind and keeps the money records without names, a closing account takes on nothing new and its owner is emailed a week before the end, members use every template but change only their own and see only their own folders and batches, a completed envelope its sender deletes stays with its recipients and can be found and put back by the admins, help references nobody can misread (alerts too, and the queue finds one by the reference read out), a signer's help request that names the document from the help link and reaches the sender, sign-in opening the workspace used last, a bulk send that stops when its sender is removed, the welcome signatures once per address also after deleting, public forms and contacts that are their maker's, and webhook logs that go with their webhook. |
| `tests/chat.test.ts` | The help chat, against a stand-in for the model (a fetch stub, never the network): the provider from the settings, the answer streamed with little thinking and no temperature, one more try without the tuning after a refusal, the built-in answers when there is no key, the model is down, slow or says nothing (and said as such), every limit (an internet address a minute and a day, an IPv6 /64 as one, a signing link, an account, everyone together), what is taken out before a question leaves and what stays, only the screen going along, answers the page made up, the hand-over to a person with the chat attached and checked, nothing else stored or logged, the system prompt built from `policy.ts` with the help topics and "What is not in it" read from the page and this file as they are now, the correcting line for "valid" and refund promises in the phrasings models use, the answer cut at its longest and a huge question refused, an answer checked only under the question it answered, a closed dialog stopping its answer (also before the model has begun), the built-in answers for what a signer and a sender most often ask, each naming the control on the screen the person is on, every label the helper names read out of the source of its screen, and the provider on `/security`. |
| `tests/support.test.ts` | Help requests as tickets: the whole life of a request from both sides, the published response times and the timer's escalation when one is late, reopening and the follow-up after 30 days, the link that works without a login (right secret, wrong secret, another request's secret), what a customer can never see (internal notes, another customer's request, an answer written to somebody else's mailbox), the operator queue and who may work it (nobody else, and no API key), the payment alerts in the same queue, the real median, the limits on the link and the form, and deleting an account with its threads. Also what a review proved broken and is fixed: a stranger who types your address can neither fill your inbox nor shut you out, "send me the links again" takes the same time whatever it finds, no API key or post from another site files a request as you, an alert never shows the operator's own account, deleting a login leaves a request it wrote under another address to that mailbox, a refused or given-up answer is told to the operator, old rows are filled in, odd input gets plain answers, and requests that belong to no login do not stay for ever. |
| `tests/signerux.test.ts` | The person who signs, and the email that reaches them: a saved signature is confirmed before it goes on a page and never offered across two people at one address, "Finish later" carries the signature to another device, "Fix my name" cannot turn one signer into another, dead and replaced links tell the sender, "Email me the current link" and "Find my documents" say what they did, scans and pictures are flagged page by page and stay flagged, the sender's field count matches the signer's, emails the mail server refuses are tried again and the audit trail says so (never a request to someone who has finished, never a withdrawn invitation), someone who signed keeps a copy when the envelope is closed, also when its access code froze afterwards, and a new person at a shared address starts with an empty request. |
| `tests/signin.test.ts` | Signing in and signing up with Google or Microsoft, against a stand-in for both (an RSA key made in the test, their key lists and token endpoints answered by a fetch stub, ID tokens signed and forged there): a new person, a returning one, a state that is missing, made up, from another browser, used twice or too old, every check on the ID token (signature, "none", HS256 keyed with the public key, issuer, Microsoft's organization rule, audience, expiry, nonce), keys cached and fetched again for an unknown key id, an address in a token never opening an existing login unless the provider vouches for it, a login someone else started in a person's name being cut off from them, invitations, free codes, a closing login coming back, a removed member's workspace, connecting and disconnecting under Settings, the last way in, a first password by emailed link, API keys kept out, no redirect off this site, nothing answering when a provider is not configured, and the repairs after review: everything a stranger set up in a login made in someone's name removed or switched off when the owner takes it back (with a provider or a password link) and listed for them, a signed-in person never made a second login, a Connect that ran out going back to Settings, the email naming only a password the login has, started sign-ins cleared, Google's Workspace domain matched to the address, and no provider sign-in skipping two-step login. |
| `tests/signercode.test.ts` | Checking who signs, with the text message provider stood in for (a fetch stub for Twilio and for the generic hook, and the outbox): what each setting switches on and what is refused without one, what a link gives away before the code is typed, the code (ten minutes, five tries, only the newest, never in an answer or in the database), every limit on codes and on texts, "not my number", Twilio and the hook called with the right body and credentials, a provider that fails or refuses, the signing link by text and who is never texted, the daily stop, corrections and passing a document on, templates, bulk rows and public forms, the audit lines and the certificate text. Also the skeptic's findings: a text tried again by the timer is decided again, a pass never goes to another person at the same address and lasts 24 hours on the server, limits are counted per sender, no text while paused, "not my number" for the whole account, premium-rate numbers refused. |
| `tests/gaps-nonus-words.test.ts` | What the product says to people outside the United States, and whether it is true: the consent text (what kind of signature this is, never that it equals a handwritten one) and its version in the audit trail, a QR code promised only because the app now draws one, the sentence about English, what "fix my name" really does, every public price written as US$ with the line about currency, the check before sending (which words set it off, which do not, that it warns and never blocks, the `warnings` in the answer to sending and the line in the audit trail), every country note dated and resting on a source the research names, "Where your data is" filled from settings with what was not stated said out loud, the data processing summary, and the line in signing emails for someone who cannot open the page. |
| `tests/gaps-mobile-send.test.ts` | Sending from a phone: the camera's orientation note read in both byte orders, a photo upright in the stored and in the signed PDF for all eight values of the note (drawn with pdf.js and checked corner by corner), several pictures joined in the order chosen, a session that slides while it is used and the list of where someone is signed in, the switch after sending, the lock on a device handed to someone who signs in person (the password, five tries, who is and who is not locked), the 44 pixel tap areas in the editor, the list of fields without a label, and the warning for a document that is slow to open on a phone. |
| `tests/ds-reading-view.test.ts` | Easy reading: sample PDFs read by pdf.js and put back together (one column, two columns, lists, a table, a form line), fields placed in reading order, a title and a section heading kept apart, long parts foldable, a page with no text, words the page does not show left out; the first use of each view in the audit trail once, the certificate's "Read as" line, and the refusals of `POST /api/sign/:token/view`. |
| `tests/gaps-mobile-sign.test.ts` | Signing on a phone: the legacy build of the PDF viewer opening a document with `Promise.withResolvers` taken away, a browser that cannot show the document told so in words with three ways on, the browsers on `/help`, the email link opening the page with no account and no cookie, a tap or a speck refused as a signature and a blank or solid picture refused as an upload, Finish without a connection (nothing signed, answers kept in the tab, sent again by itself, a lost answer not signing twice), long documents giving their memory back and Next jumping to a far field, the page sizes and pinch zoom, two fields of one person on top of each other refused in the editor and by the server, and the adopt dialog keeping its buttons on screen. |
| `tests/ds-sso-oidc.test.ts` | Single sign-on for an organisation, against a stand-in OpenID Connect service made in the test (an RSA and a P-256 key, its discovery document, key list and token endpoint answered by a fetch stub) and a DNS stub: the issuer refused unless https, public, and named the same in its discovery document with PKCE S256 and RS256 or ES256; the secret kept only encrypted and never sent back; a domain claimed by its TXT record (in pieces too), a DNS that does not answer proving nothing, one account per domain; nothing on the sign-in page before an admin tried it; a good token, and wrong issuer, wrong audience, expired, no iat, bad nonce, unknown key, forged signature, "none", HS256 with the public key and an ES256 signature in DER all refused; a rotated key fetched again; an address outside the domains or marked unconfirmed refused; an existing login connected and emailed, a second person for it refused; joining as a member on first sign-in off by default; "everyone signs in through it" only after a try, with a domain and the owner's two-step login; then password, sign-up and Google refused with the reason, "Forgot password" saying how to sign in, browsers ending within `SSO_SESSION_HOURS`; the owner's way back with password and code written to the security record; a lost record pausing it, emailing the admins and coming back by itself; a domain taken over by the account whose record is there now; and words for every security record line. After the review: a discovery document fetched again that names a private token or key-list host, or a service name that moved to a private address, refused before anything is sent; issuer refusals in the card's own words; a new login made through the service said on the landing page; while enforced, two-step off for the owner and handing the account to someone without it refused, and the domain switch and removal asking for the code; way_back answered the same for a member's right and wrong password; removing the service or changing its client id connecting people again instead of "taken"; the outside-services list naming organisations' sign-in services. |
| `tests/ds-sso-saml-scim.test.ts` | SAML 2.0 sign-in and members from a directory (SCIM 2.0), against a stand-in identity provider made in the test (its key and certificate, its metadata, and responses signed with xml-crypto) and a DNS stub: our metadata served at the entity id; identity provider metadata refused when it is not metadata, has a DOCTYPE, offers no HTTP-Redirect sign-in, an http address, an unreadable or only ended certificates, or several providers; nothing on the sign-in page before a try; a good answer signing in once, only in the browser that started; an answer the provider started by itself, or finished in another browser, signing nobody in; unsigned, wrongly signed, changed after signing, two kinds of signature wrapping, expired, another audience, another recipient, another issuer, an answer to another request and a replayed assertion all refused; an address outside the claimed domains refused; new certificates of the same provider keeping it tried, another provider refused while enforced. SCIM: a token only after single sign-on was tried, only by a person signed in, kept as its hash and replaced at once; wrong, missing and old tokens refused in SCIM form; create (a login at once, someone new at their first sign-in, nobody outside the domains, no doubles), filter by userName and externalId, replace, a userName that cannot change, roles never touched, deactivate (Entra's "False") and delete removing the person like an admin would, with their work passing to the owner or the chosen member, keys stopped, emails and security record lines; the owner never removed (nor kept as switched off when first sent so); "Members are managed by your directory" stopping invitations by hand, and lifted while single sign-on is removed; a role an admin made, without Team or even with it, refused the token and the card; a failed SAML try telling the admin why. |
| `tests/twostep-repair.test.ts` | Repairs to two-step login after a skeptic's probes: switching it on needs a confirmed address, and a password reset or Google never takes it away or gives a session without the code; Google connects nothing before the code; the reset by email needs the password (also after Google), waits 7 days, emails a stop link every day that works signed out, is on every signed-in browser's `GET /me`, stops on a sign-in with a code or a remembered device and on a password change, makes a new one wait 7 days after any other stop, is one at a time and three emails a day at most, signs every browser out when it takes effect, and can be switched off with a code; a stranger without the password cannot pause the owner and gets the same words and count, the owner on the same network still gets in, wrong codes sent at once get five tries, a pause from signing in never blocks Settings; an admin resets only a member who owns no workspace and is an admin of no other; waiting sign-ins end on a password change, a reset or signing out others; no key changes the password or reads two-step login; withdrawing a device signs it out; a required team still opens sessions and closing the login. |
| `tests/ds-templates-lib.test.ts` | Ready-made templates: every starter file has its title, purpose, date, place and reviewer, its fields after real paragraphs and on real roles and nothing a will, deed, power of attorney or tax form would need; each renders on one or two pages as searchable text with its fields inside the page and apart; each makes a template owned by the person and usable by the team, that is sent and (one of them) signed by both people, with no paper warning; a name like "Power of Attorney Helpers" is caught by the check before sending; the note in the list and on the template; refusals for an unknown starter, missing, too long or non-text words, a brand name and our own name (said with what to do), with nothing made; a preview prints a brand-like word as its label; a copy of such a template keeps its note; line breaks cleaned; other accounts see nothing. |
| `tests/ds-ai-assist.test.ts` | AI help when sending and signing, with a stub model: no model, the account's AI switch off, a daily limit of 0 or a hosted model under the government profile means no call and nothing offered; "Let the AI read document text" is off by default, admins only, never by API key, on the security record, and without it no page text and no document text is sent; suggested fields send text with positions and never a picture, and an answer is checked (unknown kind, a page not sent, off the page, backwards, a signer who does not exist, on top of a field or of another suggestion: dropped; labels made plain); the summary is written once per file, carries its warning, loses links and claims that it binds anyone, is said once on the record with no AI words, goes when the sender switches it off, and gives a plain sentence and the ask back when the model is down; a drafted message uses only names and people without the switch, the text with it, never reads someone else's envelope, and a lure (a brand, money and a phone number) is refused without using up the day; a line or sentence with a phone number, an email address or a request for payment details is left out of the summary and the draft; the summary is not shown once the person finished, so its record line never follows a signature; kept summaries are sealed when a key is set and rewritten when no key opens them; the security pages say Draft a message sends the sender's and people's names; the daily limit and the model down say what to do. |
| `tests/ds-ai-repo.test.ts` | Key dates, with a stub model: with zero setup nothing is offered or sent and `/api/me` says nothing; the switch needs "Let the AI read document text", is off by default, admins only, never by API key (nor "Look through older documents"), on the security record, and goes with the read switch and stays off when it comes back; the text goes as text in pages, and a proposal whose words are not on a page, an unknown kind, a date that is no real day, a second of a kind, a value with a phone number, or words that do not hold the date, amount or names are dropped; the page is the page the words are on; proposals are in no filter, calendar or detail until confirmed; confirm and correct make an envelope detail never on the certificate and never over a detail the sender has; finding again keeps what was confirmed; reminders are refused until a date is confirmed, sent once N days before, again for a corrected date, never for a proposal, not while switched off and not to someone who can no longer open the document; `ends_within` and the list filter; the calendar file is escaped and folded; the timer reads new completed documents and older ones only after "Look through older documents", with at most half the day's AI requests; Remind me is refused when every date has passed; a member sees only their own; every route is in the API description. |
| `tests/write-contract.test.ts` | Writing a document here: every starter is stopped by its blanks and renders once they are filled; tags become fields for Signer 1 and 2 in order and the PDF carries no tag; Letter when asked; the record says "Written in GrowSigning" and nothing about an AI; the source is kept for its own account only, a new text goes on a draft, and after sending only as a correction that asks for the sign-again choice and says "Wording changed"; headings, lists, bold, Arabic, Hebrew and Latin in one PDF and a warning for a script it cannot print; a brand title and too long a text refused; with a stub model: a draft streamed and made safe (no links, no HTML, no web or email address the person did not type, and none of the tested phrasings that say it binds anyone or that a lawyer or court approved it), the same on Stop through /write/tidy, a REFUSE answer of any length refused, a failed call not counted, the chat's limit said in writing words, the title taken from it, and only the description sent; a change of a selected passage sends only the passage and puts it back where it was selected, even when the same words stand earlier; signer numbers counted again without gaps; honest receipts and filled forms naming a payment service or a shop are not refused; AI off (no model, the account switch, a limit of 0, government with a hosted model) means no call; the daily limit per account, unconfirmed and signed-out people, sizes, the model down; deceptive asks refused before any call while ordinary ones naming a company pass; the legal hand-over; Stop aborts the model. |
| `tests/ds-a11y.test.ts` | Accessibility: text read from scanned pages with a stub reader (in the background, in the account's language, a PNG or JPEG of the page handed over without a shell, cleaned, found by search, on the signing page only with the warning and only when the documents may be read, a reader that hangs stopped and given up after 3 tries, the service variant with a stubbed fetch, gone with its file, nothing at all with zero setup); the statement at `/accessibility` dated and in the footer, the draft report's lines; with `A11Y_URL` set, axe-core on 26 states, keyboard-only signing at 3 widths and the editor without dragging in Chromium (`tests/a11y/`). |
| `tests/mobile-repair.test.ts` | Repairs to the phone work after a skeptic's probes: forty unlock tries sent at once get five password checks and the fifth wrong one signs the browser out, a session ending 90 days after sign-in however often it is used, or after 30 days without use (also one that slid past that before), "Sign out everywhere else" ending remembered two-step devices, Finish that only says nothing was signed when that is known and treats a second Finish as done, a public form's own 503 shown in its own words and not retried, two fingers on the signature pad making no signature, overlapping fields drawn smaller on top with templates and public forms checked, and all eight camera orientations upright in three real file layouts and both byte orders, on the page and in the signed PDF. |
| `tests/gaps-nonus-text.test.ts` | Text, dates, numbers and names outside the US and outside the Latin alphabet: a signed PDF with Chinese, Japanese, Korean, Thai, Hindi, Arabic, Khmer and Cyrillic names read back out of it, a script with no font (flagged to sender and signer, marked on the page, listed in the certificate) and a font file that is missing, right-to-left text with digits and Latin words in it (order, alignment, the typed text kept in the PDF, every box a signer types words into taking its direction from what is typed), one date format for typed dates and the date of signing, the account's default format, the date of signing by the signer's own calendar with local time and zone on the certificate, deadlines with time and zone in emails (the warning three days before too) and in the Give more time dialog, reminders that wait for a signer's morning, numbers as they are written outside the US, and a signer fixing the spacing of their name or offering it in another script. |
| `tests/encrypt.test.ts` | Encryption of stored files by the app itself: writing and reading with and without a key, old plain files beside new encrypted ones, a wrong key, a changed byte, a cut-short file, a file copied under another name, an upload that only looks encrypted, the server that stores nothing new when it finds files it has no key for (and says so at start), a key that is not a key, changing the key with the old one listed, the script on a folder with every kind of file (run twice, stopped half way, a leftover half-written copy, a file the server deleted meanwhile), and a whole send, sign, download, export and delete with the key set, with the files on the disk unreadable without it and the pages saying what is and is not encrypted. |
| `tests/qr-encrypt-repair.test.ts` | Repairs after a skeptic's probes of QR codes and encryption: the text read from uploaded PDFs encrypted with the file key (none of it in the database file on the disk, older text sealed and overwritten at start, moved to a new key), search, the check before sending and the click-to-agree filter still reading it, the pages listing what stays readable in the database, five envelopes whose signed PDF cannot be made never blocking the others (sender and operators told once, made when the file is back), a code or link shown again being the one that works now, a witness's code saying what it lets its holder do, emails retried without an unreadable attachment, a locked file in the export called locked, a click-to-agree record that says its terms could not be read, a signer's damaged attachment never left out of the sealed PDF, the signer told the server's words instead of a download that would fail, and a QR code for every member of a group. |
| `tests/ds-pay-collect.test.ts` | Payments while signing, against a stand-in for Stripe: connecting the account's own Stripe account (a one-time answer for the person who started it, admins only, not before trust), the amount (fixed or from a field, refused in words when it cannot be read, no web address in what it is for), one way to ask (card or link), a template's payment on each copy, pay before finishing (Finish waits, nothing is signed, one Stripe page at a time, the part completes on Stripe's confirmed message), unpaid, forged, stale, wrong-account and replayed messages, refunds and disputes on the document page, the signing record line, nobody stuck when Stripe was disconnected, paid while the document changed, no fee and the mobile money stub. |
| `tests/gaps-industry.test.ts` | What agents, clinics, contractors, HR teams and small firms ran into: who can really open a document (a forwarded link, the account's admins, exactly what the people who run the server see), no health information agreement said in three places from one text, reminders on by default and said before every send (the editor, a bulk batch, a public form), what a bulk send holds and costs before the Send button in the numbers the send is held to, two people finishing the same envelope at the same moment (two addresses, one shared address, a late autosave crossing Finish), "filled in everything but has not pressed Finish", searching and moving templates, a "Strike out" field through to the signed PDF and the sign-again rule, and a link to the sender's own payment page after Finish (who may set one, the addresses refused by name and by where the DNS says they lead, shorteners, never before Finish, never to the sender's own team, never in an email, an attached certificate, an export or an evidence pack, gone when trust goes or when the person who set it leaves, who saw which address after a change, a deleted envelope); also a % or _ in the template search. |
| `tests/gaps-disputes-evidence.test.ts` | What happens around the certificate when a signature is disputed: what `/verify` and `/security` may claim (and what the hash chain really stops, checked against the code), the fingerprint kept for a year after an account is deleted, the public lookup by envelope ID (what it says and never says, its limit), the fingerprint in every completion email, the record of the completed copy (handed to the mail server, first opened, later visits once a day), the closed copy marked large across every page, "I did not sign this" from the check page and the signing link, the help topic that never reaches the sender, the evidence pack (the chain recomputed from it, no live links in its emails) and the page that explains each line of the certificate. Then the repairs after a skeptic's review: disputing with the code of any email we sent, also after the sender put another address under the name or someone passed it on; a dispute that stops the sender deleting for good and outlives the account as an id, a fingerprint, a day and a state until a person closes it; the sender getting the words and never the internet address or browser; marks that cover every corner and survive a black-and-white copy, also on copies made while out; and the first open after an upgrade not called the first. |
| `tests/comments.test.ts` | Questions and comments: private to the sender unless everyone is chosen, nobody reading a private thread they are not in (by its id, after a hand-over, on the device of someone who signs in person), the old "ask" being a private comment, one email to the sender at most every 10 minutes with the comments in it, an answer emailed to the person answered and nobody else, the rules of every email in the sender's name (a fake payment notice refused, held while paused), who is never emailed and why, the count before Finish and who may settle, nothing of the words on the signed PDF or in the audit trail, the export and evidence pack, read-only after completion, gone with the envelope, the limits, and the API with its webhook. |
| `tests/comments-repair.test.ts` | Repairs to comments after a skeptic's probes: two people signing in person one after the other on one device (Back to the earlier page, after they finished, a tablet that is not signed in, a forged cookie), the fake payment notice filter across a day of comments and the names beside them (one writer to several people, several writers to one reader, an admin's name, a form visitor's name, a recipient writing for everyone, and an honest office it lets through), an answer turned down at sending dropped with a note and the next one sent, settling limited with one audit line an hour, the webhook log after deleting and sending again, refused requests not using up the burst, the same comment twice, who is really emailed, and an admin reading a removed envelope. |
| `tests/ds-perm-profiles.test.ts` | What each role can do: every route that needs a person has a line in the table of src/server/perm.ts, and the table says what Owner, Admin and Member always did (a new route without a line fails); the built-in roles refuse and allow exactly as before; a role made from Admin without "See every document" sees only its own documents, cannot export everything or open documents brought in, and never the plan; a role made from Member without "Send documents" makes templates and is refused sending in words; nobody gives a role (through a group too, themselves included), narrows or renames a role, or changes a person, that can do more than they can; a Member copy with nothing left out and an unknown role on an invitation are refused; only real admins count as a second admin; an API key is capped by its maker's role at once; a group of members chosen for a template, out of the group out of the template, a group that gives its role, a role in use cannot be deleted, and every change in the security record. |
| `tests/templates.test.ts` | Who can use and change each template, and the lock on its wording: every route that lists, reads, uses, sends in bulk, copies, publishes as a public form, changes or deletes a template, for the owner of the account, an admin, the template's owner, a chosen member and another member, each by browser and by API key; the lock through the editor's whole save and through the plain API (what can be filled in, everything else refused with who to ask, nothing saved), once out too, unlocking and deleting the template; copies of templates and of locked envelopes; bulk sends and public forms; leaving and being removed; a database from before this. |
| `tests/ds-tpl-combine.test.ts` | Several templates in one document: files in order, a role with the same name as one person with all its fields, every field carried over, one invitation; refusals with nothing made (two jobs for one role, two named people, one template, the same twice, with template_id, as a template, one not found, one the person may not use); a locked part kept locked (its note, file, added field, person and the message) while the open part changes, also after the template is deleted, on a copy (also the second locked part for someone who may change the first), and against someone who can change the document on their turn (file, later person and notes of the locked part stay; their own part's file can be replaced); a template made from it refused when a later part is locked or not for everyone, made locked for an admin; a part locked after the document was made is not locked and is not copied for whoever the lock is for. "This looks like your template": the line without a number, the number in What is different; offered at 80 (the usual), not below, not at 90 or 95 when an admin asks for them (members cannot), refused levels; a 95-word form with one word changed or a name and date written in still offered, a short template inside a long different file not; the same file at 100 percent; the page count, changed pages and words listed; scans and other words never matched; another account's file not found; templates the person may not use never offered nor their fields handed out; Use it changes nothing by itself, gives people merged by role and fields on the file, fields on missing pages left out and counted; a locked template offered as itself ("Start from ...", the file stays in Drafts) and its fields refused. |
| `tests/ds-recipient-types.test.ts` | People who change the envelope on their turn and do not sign: "Chooses who comes next" names a place the sender left open and changes a later person (never anyone before them, never half a list, never after finishing, the fake-notice filter and the pause on the names), and cannot finish with a place still open; "Can change the document" changes and adds the people after them, never the subject, the message or the people before, cannot slip in another file of the account, cannot take off a file someone before them has fields on, and a replaced file that someone signed asks them to sign again only with resign, in the record under the editor's name; refusals at sending (no order, nobody after them, fields of their own); the audit lines ("Mia Chen named Paul Ade ... as the signer for Landowner") and the certificate lines; templates allowed, public forms and Send to many refused; the API description; after the reviews: a chooser with "Only when" refused at sending, an empty place never counted as reminded, later choosers and editors locked, the sender's finish email naming each change, signers told the editor's name, no email to the editor about their own change, their waiting page, the last person after an editor kept, and the words on the screens. |
| `tests/witness.test.ts` | A witness for one signer: tied to one person who signs and every way that cannot work, asked straight after that signer whatever the order and holding nobody up, no signature held or used, the block and what prints when, the signer naming the witness before Finish (themselves, a party, a pause, the cap, the daily count), the statement as the witness's own words and a stale one refused, no decline and no hand-over for a witness, "I was not there" and naming the person who was, the certificate (the witness under the signer, the statement, its time, the note), the marks for the same address, the same browser and the same internet address and browser, reminders, the not-opened alert, Find my documents, the completed copy, declining, passing on, corrections, signing again, templates, bulk sends, public forms and the API description. The repairs: a finished witness set aside and asked again with the signature they saw, moving one needs the sign-again choice, no device fingerprint to any sender and none that links envelopes, no self-witness or party through Correct, an API key or a hand-over, the sender's choice kept after "I was not there" and in a copy, who was told said as it is, the witness's note to the sender only, the witness name read by the fake-notice filter, the deadline warning, the "same name" mark, and no fields of a party for a witness. |
| `tests/ds-fields-kinds.test.ts` | More kinds of field: first and last name from the name with the signer's change kept and their name untouched; a drawing kept only as a PNG of ours, printed as a picture, listed as a drawing and never a signature; Approve and Decline buttons only for someone who signs or approves, never required, holding nothing, Approve finishing and Decline declining; same answer for one person and one kind, one value whatever the browser sends, mixed kinds refused; dates from dates across month ends, leap years, years and time zones, never taken from the browser, waiting on a draft and refused at send; text style limits, the serif font in the PDF and the usual font for Cyrillic; the team's text style for new fields only; saved fields for admins, read by the team, replaced by name, never a value or a person; templates and bulk carrying all of it. |
| `tests/ds-collab-fields.test.ts` | Fields anyone on the document can fill in: refused for a signature, a read-only, linked or hidden field and someone who does not sign, a radio group whole or not at all, kept across saves, templates and copies; two people change it with who and the value before on the audit trail and who changed it last on the page; an out-of-date screen never undoes a change (also a choice in a group) and cannot finish on an old value; a dropdown answer outside its options refused; a limit per person; a refused Finish asks nobody to sign again; the sign-again email says the changer also signs it; refused after someone finished; the sign-again path (yes needed, first signature and a copy kept, email, no second signature); initials on a change; the final value in the signed PDF and every change on the certificate. |
| `tests/ds-fields-checks.test.ts` | Field checks: patterns of the sender's own read first (long, unreadable, back-references, repeats inside repeats and repeated choices that start alike refused with why, an old slow pattern never run, on the page or the server), every format on the page and on the server (email, phone, letters of every language, a date in the envelope's format, my own pattern with my own message, the old words), numbers with smallest, largest, decimals and a currency with its sign, kept as typed and as a number, the character limit at every save and at Finish (a count shown only for a limit the sender set), number fields with only a currency or only decimals, an impossible tick-box rule refused at send, fixed size worked out from the box, tick-box groups (at least, at most, exactly, boxes not shown), hidden values (dots for the next signer on screen and in their copy, the sender sees it, the completed copy as typed or "(hidden by the sender)" with the certificate line), a half-typed pattern kept on a draft and refused at send, templates and bulk sends that carry every check, and the API's old and new forms. |
| `tests/ds-routing-if.test.ts` | "Only when..." for people: the decision from stored values (a hidden field counts as empty, a calculated value by its number), skip and alternative, a chain of rules, the record and the signing record lines, the held signature given back, a correction before and after the step, a group, templates and bulk sends, refusals in two sentences, nothing in To sign or Find my documents for someone not asked, someone asked before a correction told they are no longer needed (never recorded as never emailed), a hidden answer kept out of the reason and the certificate, a reminder for someone not asked refused in words, and the editor's "Put Max after Ana" hint. |
| `tests/logic.test.ts` | Conditional fields and formulas: the formula reader (order of operations, brackets, sum and round, what it refuses in words, nothing run as code), numbers as people write them and the result written the same way, empty inputs, dividing by 0, numbers too big or too small, rules that chain and loops (refused when saved, naming the fields), what the review step warns about, a browser that lies about a hidden required field or a calculated value, a signature field that an answer hides, the signed PDF, someone else's answer counting once they have finished and a signed result never changing, sign-again after a rule or a formula changes (predicted the same way in the editor), templates, copies, public forms, bulk send rows that fill a field, and the lock on a template's wording. After the skeptic's review: a result with three decimals read back as the same number (PDF pictures and words, the sender's counts, the next person's formula), no Finish as signed without a picture, nothing learned about an unfinished answer from Finish errors, a total that changed under an open page, two radio buttons chosen at once, number rule values written two ways, a very long line of fields, long numbers in a formula, and digits of every script. |
| `tests/stamps.test.ts` | Company stamps: the processing steps as pure functions on pixels made in the test (paper removed under light that falls off by half and on grey, yellow, kraft and canary paper, a desk round the sheet, a hard shadow, ruled lines and a noisy faint stamp, one ink in every pixel with a little variation, a thin line kept thin, a design's tint printed solid, faint small print kept in a photo, black print left out and the stroke it crossed filled in, the ink chosen after cutting off the edges, a logo's colours kept apart, an oval made round, the texture sized in millimetres with full-ink cores, lost coverage with hard edges and no pale wash, words that keep their ink in every millimetre, a heavier side, voids and darker rims, no stroke gone at screen, phone and print size, a small seal kept dense, a solid printed dense, a stroke on a ruled line kept whole, a crease, a glare and paper fibres, the ink found and other colours left out, a logo said to have several colours, the same impression for the same seed and another for another, trimmed with a small margin, a tilt from -4 to 4 turned by the page and not drawn in, a texture that keeps the ink readable, a see-through design, a seal that fills the picture, a dark table at the edge of a photo), which files can be a stamp, the account's stamps (up to ten, admins only, names checked for an unpaid account, anything but a see-through PNG refused in words, text, camera notes, a palette and anything packed after the pixels taken out of the file, a damaged file and a file that is not a PNG each told what is wrong with it), a margin that is never cut flat for 24 seeds, a second stamp field that takes the same stamp without a second upload, a field sized by the stamp chosen for it, the adjustments behind one fold with no greyed-out button, a signer's stamp (Finish later keeps it, the answers never set it, required before Finish, the audit line with its fingerprint), the signed PDF (multiplied in at 97 percent and turned by its tilt, the words under it still in the file, the certificate lines and the honest sentence), changing and deleting a stamp, saved stamps from the signer's own account and who may not use them, the limits and who may see a picture, money, signing again after a change, templates, bulk sends, public forms, signing groups, the evidence pack, the export, deleting, and the API description. |
| `tests/clickwrap.test.ts` | Click-to-agree terms: drafts and versions, our page, the frame (only `?embed=1`) and the API, the signed link a website makes, the record that never changes and its seal, what the certificate says the browser reported, the receipt and one copy by email only for the browser that accepted and an address the website gave, the scam filter on every word the page shows, the two monthly counts and the limits per address (offices, IPv6 blocks), paused accounts, reports, members and keys, and deleting with the files. |
| `tests/ds-dev-api.test.ts` | For developers: fields placed by anchor text with offsets, "all" and a numbered place, text that is not found named and nothing sent with `send: true`, `auto_tags` for each signer a tag names and none under a field already there, templates and PUT on a draft; the websites of Signing inside your site (https only, 5, admins, the security record); a signing link for a frame framed by that website only and never `*`, the message posted to that website only, the audit line before the envelope closes; the sender screen link opening once within 5 minutes, reaching its one draft only, ending when sent or closed. |
| `tests/seal.test.ts` | The digital seal of a completed PDF, checked by poppler's `pdfsig`, `openssl cms -verify` and `openssl ts -verify` where they are installed (each test that needs one is skipped otherwise) and by pdf.js: no settings leave the file byte for byte as it was and write nothing down; a sealed file is covered to its last byte and the stored SHA-256 is of it; one changed byte breaks the seal and a byte added after it is told apart; keys from a .p12 (as OpenSSL 3 writes it, and the old triple DES and RC2 kind) and from PEM, RSA-PSS and ECDSA P-256; an expired, not yet valid, wrong-purpose, mismatched, too small or unchained key refused with the file made as before and the operators told once; a time-stamp service made in the test (B-T, its token verified by OpenSSL), and every way a time-stamp can fail falling back to B-B at once, with the certificate saying so; several services in order and a 3-second timeout (4 in all); `/verify` on the sealed file, an added-to file, a changed file, a file sealed by someone else and one sealed with an earlier key; envelopes completed before the seal never sealed afterwards; a voided copy unsealed and saying so; an uploaded PDF that already carries signatures. The screens: one history line "Sealed by" and the certificate's name without technical names, `seal` on the page of the document, the admins' status line from `GET /seal` (admins only, never the reason a key is refused, never the time-stamp service's address), and none of it without settings. Repairs: a file put together around a real seal (the seal moved with other pages in its place, bytes hidden after it, a seal lifted into another file) is never said to hold; a time stamp a stranger adds afterwards is never shown or called trusted; a service that lies about the time is not used; without `TSA_TRUST` nothing says "trusted"; the user name and password never go over plain http; `certificate.pdf` in an evidence pack carries no seal field; the public pages say nothing about a seal without a seal key. |
| `tests/seal-csc.test.ts` | The cloud seal (`src/server/sealcsc.ts`) against a fake CSC service with a throwaway authority, offline: a completed PDF sealed with the service's certificate, `pdfsig` and `openssl cms -verify` saying it holds, the whole chain in the CMS, `GET /seal` and the record naming that certificate; only the SHA-256 of the signed attributes in the two signing calls and nothing of the PDF; the token kept, fetched again after it expires and after a 401; the chain fetched again after a day; a one-time code (RFC 6238) that works and a wrong one that completes the file unsealed with the reason; a service that is down, slow or answers a bad signature, each completing unsealed at once with the reason logged; half-set and doubled settings refused with a `[config]` line; the outside list. Part B: a document time stamp over a completed PDF without a seal, checked by `openssl ts -verify`, and "Not time-stamped" when the service fails; `TSA_TRUST=bundled` matching `deploy/tsa-roots.pem` and the published fingerprints, and a root sent as a copy issued by an older root still leading to the listed one. After review: a slow but working service still gets B-T with one signing (the seconds for the seal's time stamp start when the signature is there); a time stamp that fails after a cloud signature keeps that signature at B-B, never a second paid signing, with a certificate line true either way; two builds of one file wait for each other; a render thrown away for PDF/A is not sealed; one operator alert per reason during an outage; a renewed key behind the credential fetched again before the next seal; one password grant for seals that start together; an ECDSA signature in raw form whose first byte is 0x30; a one-time code refused at the turn of its 30 seconds; the outside list naming every setting sent. |
| `tests/seal-csc-sandbox.test.ts` | Runs `scripts/seal-sandbox.ts` against SSL.com's real eSigner sandbox, skipped with a message when it cannot be reached. |
| `tests/ds-seal-ltv.test.ts` | Long-term checking of the seal and the record's time stamp, with a stub OCSP responder, a stub revocation list and a stub time-stamp service made in the test: B-LTA (a `/DSS` with an OCSP answer for the seal certificate and its issuer and the revocation list of the time-stamp unit, then a document time stamp over the whole file that `openssl ts -verify` accepts), `pdfsig` still saying the seal is valid, `/verify` matching and calling it whole; B-LT when the document time stamp fails, said in the history; a responder that hangs past `LTV_WAIT_MS` leaving B-T with nothing half written and the page saying so; revoked, a stranger's signature, an old nonce, a refusal, an old answer, a listed serial and a list signed by someone else all refused; nothing tried for certificates that name no address, and nothing asked without a time-stamp service; a turned page, a changed byte and a document time stamp over other bytes after the seal never accepted as check data. Repairs: an empty `/DSS`, one holding other bytes or about other certificates, and a time stamp field carrying an action are "saved after the seal" on `checkSeal` and `/verify`; a document time stamp from a service nobody listed holds but its name and time are not given; addresses such as `localhost.`, `*.internal.` and names the DNS says lead inside are never asked; the document time stamp shares `LTV_WAIT_MS`; `LTV_WAIT_MS=0` turns the step off; a host refused by the outside-connections guard is named with `OUTBOUND_ALLOW`; a time-stamp unit with no address does not block the seal's own checks. The record: the chain head time-stamped with one certificate line, the token verified by `openssl ts -verify` over the head and refused for another, the evidence pack with the token, the head and the command; a rewrite of the record with every hash recomputed shown against the time stamp; a swapped-in token from a service of one's own named from the token, said unchecked, and not holding with `TSA_TRUST`; no line and the reason kept when the service fails; no technical text on the page and the record line in History. |
| `tests/ds-pdfa.test.ts` | Archive format (PDF/A): `toPdfA` writing the PDF/A-2b XMP (part 2, conformance B, the title escaped and the same as the information dictionary, the dates agreeing), the sRGB output intent with the profile from `assets/icc` and its licence beside it, a document ID, no JavaScript open action, no page actions, hidden annotations taken away and the rest printable, a link that ran JavaScript running nothing and a web link kept; every font in the signed PDF this server renders embedded, other scripts included; an uploaded file with a font that is not inside it (also one named only in a filled-in form's appearance), printing-press colours, or a movie found; with no `VERAPDF_CMD` the switch not offered, refused with 409 and nothing changed; with the switch off nothing changed and veraPDF never run; only an admin signed in may switch it (not an API key), and the security record says who did; with veraPDF (a stand-in that answers in veraPDF's report format) passing, the stored file PDF/A and the certificate, the page of the document and the history saying "PDF/A-2b, checked with veraPDF"; failing, a font missing, a checker that cannot start and one that takes longer than `VERAPDF_TIMEOUT_MS`, each made as a normal PDF that says why, and the document always completing; the seal still valid for `pdfsig` and `checkSeal` after the PDF/A step, with the metadata and output intent kept; a font only listed and never drawn with not counted, one drawn with (also by a #-escaped name) counted; the last signer's Finish answering at once while a check runs, the timer's build of the same envelope waiting for that run (one check, one history line), and the "completed" email going out with the file once it is made; eight documents of one account completing at once running at most 2 checks at a time, at most 4 of that account in the line and the rest "the check was busy"; a next step under every "not PDF/A" and the history saying "signing record"; the Settings card saying when the last check could not be done, and when veraPDF was taken away with the switch on (switch off still works, switch on refused); the real veraPDF when installed (`VERAPDF_TEST_CMD`: a file with other scripts, a sealed one, and a bad one failed), skipped otherwise. |
| `tests/seclog.test.ts` | The security record: each kind of event written once, to the right accounts, with the right person and address (the team, sign-ins and their failures to every account of the person, logins, two-step login, keys and their new addresses, settings, webhooks, deletions, template rules, the export, the owner handed over, the GrowSigning team), a wrong password and a wrong code written the same way for a login with two-step login, nothing secret in any line (the test's passwords, keys, tokens, codes and addresses looked for), members and send keys refused, an admin key paging in order, filters and the CSV, names only when shared, lines that cannot be changed or deleted, a forged line found by the chain, the purge after `SECURITY_LOG_DAYS` and with the account, the alerts once an hour and switched off by a person only, and the opt-in webhook. After the reviews: `INSERT OR REPLACE` over a line refused; a record re-chained without the server's secret, the newest lines removed and a changed note of the newest line all shown as changed; a key in the browser name left out; someone who left the team not named by the API, the download or the screen; fifteen switch-offs one email; a second key within the hour named when the hour is over; lines for a withdrawn invitation, new recovery codes, withdrawn devices, signing up and Google connected, used and removed; the search box; names in a signed-in admin's download and ids for a key; the export in files of a set size; and the words of the screen (no envelope, recipient, purge or events, details as sentences, never an id). |
| `tests/impact.test.ts` | Trees: "10 mangroves" said only for a signature that was paid for (next to Finish, in the email that asks someone to sign, on the finished screen, on the signing record) and never for a free one (the trial, a free code, a sender's own signature, a server that takes no payments), nothing said to an approver, a viewer or a copy, the first time a person signs and an account sends (once, remembered by the server, by address also after an envelope is deleted), "10 more" and the count afterwards, a payment that went back no longer counting, what a link gives away before its access code, the forecast at the review step, the switch "Trees on the signing record" (admins only, in the security record, the box left off), totals hidden until 1,000 sheets or 10 trees, no share of a tree anywhere, and the green claims rules read from the source (no generic words, no carbon figure or claim anywhere, no CO2 field in any API answer, estimates called estimates with their sources). The payment provider is the stand-in of the billing tests. |
| `tests/gov-g01.test.ts` | The honesty guard and the account's switches: the registry of certifications in `src/lib/claims.ts` (all not held; held only with a registry link, number, scope, dates not run out and who checked; in progress only with a signed engagement), `/security/certifications` built from it alone, and a scan (`tests/claims-scan.ts`) of every page, email, PDF text, README, `.env.example`, `docs/` and `public/` for certification names and words such as certified, compliant or qualified signature, each hit on the reviewed list `tests/claims-allow.json` with its reason or failing, printed with file and line; "Trees on screens and emails" and "AI answers in the help chat" (defaults under both profiles, owners and admins only, never an API key, each change in the security record, what disappears from screens, emails, the finished screen and the review step, the count going on); `DEPLOYMENT_PROFILE=government` (no trees on the signing record, read from the PDF with pdf.js, an earlier record never rebuilt, no hosted AI service ever asked). The AI model is a stub and the payment provider the stand-in of the billing tests. |
| `tests/gov-g20.test.ts` | The help chat's model inside the server's own boundary: with `DEPLOYMENT_PROFILE=government` or `OUTSIDE_CALLS` listed, none or a typo, OpenRouter and Moonshot AI are never used (also when listed), only `SUPPORT_CHAT_BASE_URL` at a private network address (plain http allowed) or a host in `OUTBOUND_ALLOW`, never a link-local or public address; the start-up line that says why; `OUTSIDE_CALLS=none` keeping that one private address and no other; the account's switch for its people, its signers and its forms and agreement pages, and an organisation forcing it off; no table but `chat_counts` growing, the question in no table and no log line; the security pages, the DPA template and the model line (signed-in app only). The model is a stub. |
| `tests/gov-g14.test.ts` | Government billing (with the repairs after review: 55 new people and 22 invitations on day one in deployment mode, the fake-notice filter lifted only by a person, `signed` a real boolean, a share rounding to 0% refused, statements inside their year and contract, `/me` carrying the agreement, `/public/billing-mode`, no money words on deployment pages, the calculator's words and checks): `BILLING_MODE=deployment` with payment settings given by mistake (taken away, so the signature ledger, holds, lots and payments stay empty through sign-up, more sends than the welcome signatures and signing, no tree line per signature, no call to the payment provider, every plan route 404 in words, the agreement line with parts left out, a passed date and odd input, warnings at start, and the default counting again); the price table and its rules with nothing invented; tree commitments (operator only, each field checked, signed contracts only on `/impact`, a statement per year with https evidence); `/pricing/government` built from the table alone; the cost calculator's arithmetic for 1M, 10M and 100M signatures. The network is a stub that refuses every call. |
| `tests/gov-g03.test.ts` | The procurement documents: each one listed on `/procurement` exists, is dated and starts with "What this is not"; every file any of them cites exists; the honesty scan finds nothing in them and no em dash; the crypto inventory of the whitepaper names exactly the files under `src/server` and `scripts` that call each `node:crypto` primitive (scrypt, AES-GCM, HKDF, PBKDF2, HMAC, hashes, sign and verify, random values, timing-safe compare), so a new use fails until it is written down, and every file that imports `node:crypto` is named; the data processing terms carry a note on every clause, name the help chat's provider and promise no hours; the alerts and export folders the documents name match the code; `/procurement/<document>` serves only the listed files, refuses `../` and broken escapes, and says so when a server has no docs folder; `/security/subprocessors` lists only what is switched on, the AI host with its country; the bill of materials lists pdf-lib. |
| `tests/retention.test.ts` | Keeping closed envelopes for a set time: the rule off by default, only admins change it, 30 to 9,999 days, a level, a template's own period and a dry run that counts; the due date for each way of closing (completed, voided, declined, expired) and none while out; one email 14 days before to the sender and the admins, not twice, and nothing purged sooner; a rule switched off or a level raised after the email; Keep it with its reason in the audit trail; legal holds on an envelope and a folder (members refused, a reason needed, the sender's delete, Purge now, the timer and the purge itself refused and recorded, a folder hold that follows an envelope out of it), lifting with a reason, closing the account and the timer refused with the list of holds (recorded once a day), the two-person lift by the people who run the server; what each level removes and nothing more (pages, signed PDF and attachments off the disk, a template's file kept, values and signature pictures, names, addresses, internet addresses, browsers, the subject's names, our email copies); `/verify` by file and by ID, the signing link, the email's security code, downloads, the evidence pack and copies after a purge; a redacted trail said as redacted, while any other change still shows; Purge now and calling it off within the 14 days; an open dispute; the retention record never changed and without names after the account goes; the export; and today's delete and restore as they were. After the repair: the two lines (completed, and cancelled, declined and expired) each with their own days; the email at most once a week for an account, listing what is due in the next 21 days, with a Keep link on each row and no word of the first vocabulary; the disputed mark still on `/verify` by file and by number after a deletion; decline and cancel reasons gone from our stored emails at the "answers" level while who got which email stays; a held draft frozen and a held document refused by Delete even when deleting would only take it out of the lists; nothing of keep and delete on the page with no schedule, one Delete with one; every shared sentence and every refusal in plain words that say what to do; what recipients keep said with the day their link stops; and `?ask=` opening only what applies. |
| `tests/archivemail.test.ts` | Copies of every email for an account's archive addresses: an address gets nothing until someone with its inbox confirms it, and opening the link confirms nothing; only admins who are signed in add or remove one (no API key); five at most; "No, do not send copies" or a spam mark on the asking email stops the asking for 30 days, for the address with or without a "+tag"; a login with an unconfirmed address and an address that is not plain are refused; every kind of email about an envelope is copied to each confirmed address as an email of its own (no Bcc), with the same attachments; no signing link, security code or one-time code in the html, text or subject of any copy; nothing copied for other accounts and no account emails; copies not counted towards the daily limit; three copies that come back pause the address and never mark a recipient; copies wait while sending is paused; our stored copies and the signed PDF they carried go when the envelope is deleted or purged at any level, and a copy still waiting then is not sent; `SMTP_REQUIRE_TLS` reaches the mail library and nothing in `SMTP_URL` switches it off; the pages and the card say only what the code does. |
| `tests/customfields.test.ts` | The account's own details on envelopes (custom fields): up to 20, text or a list of choices, only admins change them and the change is in the security record; names told apart in any script and letter case; values of one line and up to 100 characters; characters nobody can see (zero-width and format characters, blank fillers, lone variation selectors, text-turning marks) refused in names and values, except a joiner between letters or in an emoji, and a value with nothing to read counting as no value; a required one checked at send with a code and the missing names for the screens, on bulk rows and for public forms; a template's values as the start and a bulk column that fills them; `documents[].fields`; never in what a signing link answers; a value put right on an envelope that is out with a line in its audit trail and fixed once completed; the list filter (start of a text value, whole choice of a list) and column, the export's columns with formulas defused in cells and header; webhook payloads; the certificate block with only the fields marked for it; the fake-notice filter over the printed ones; changing or deleting a field leaving sent envelopes as they were; a purge of personal details taking the values; the API description; what the "Use" dialog of a template asks for; the plain refusal for a value of a deleted detail; a short answer to a request naming thousands of details; a note when a printed detail holds letters the certificate cannot print. |
| `tests/ds-page-tools.test.ts` | Pages removed, turned and moved: each operation and its refusals, fields that follow their page and stay on the same words on a turned page, a page already turned in the upload, removal refused with the list of fields unless they go too, drafts and templates, someone else's envelope, a completed one, an envelope that is out (a correction, and the sign-again choice once someone finished), the audit line, the signing record's fingerprint of the new file, the editor's way (only the file, then the normal save, two rounds in a row, never a file not made from the document) and a replaced file not called a page change; a converted file keeping its original, the sign-again words naming the pages, the hourly limit counting only stored changes, page numbers sent as text, and a file made from a held-back template refused. |
| `tests/ds-offline-inperson.test.ts` | Signing in person without signal: getting it ready (only the sender in their own browser, never an API key, only for someone who signs in person whose turn it is, nothing marked viewed and the account not locked), parts that need a connection refused with the reason, the copy kept under a PIN in a pretend IndexedDB (nothing readable without it, PIN rules, a wrong PIN counted, the fifth wiping it), the real key (PBKDF2 SHA-256, 600,000 rounds, AES-GCM), signing with no signal (kept with the device's clock, nothing signed, a Wi-Fi sign-in page counted as no answer), sending it, the record and the certificate line, sent twice signing once, a changed envelope refused with the host's sentence and the copy wiped, an unknown, cancelled, replaced or voided copy refused, 7 days on the device and on the server, one person per device with an unsent result never replaced, the words; and after review: pay before finishing refused, field checks on the device, a refusal that keeps the copy with a way out, own initials, the in-person page and its files kept by the service worker and checked, the no-connection link only with a copy, dialog focus. |
| `tests/ds-phone-app.test.ts` | GrowSigning on a phone's home screen: the manifest (name, icons with a maskable one, start at /app, colours, share target, the iPhone tags); the service worker run with a pretend browser, which never answers or keeps anything under /sign, /api, /f, /agree, /embed, a page, an address with a query or a token, an answer marked no-store, an error or a redirect, gives the app's pages the offline page with no connection, and drops older caches; sharing into a new draft (refused without a session and from another website, PDFs and photos in one draft, a file that is not taken named, nothing made on a refusal); scan cleanup on sample photos (corners found within 3%, paper white and writing dark, written to `tests/out/build-ds-phone-app/` to look at; no page, a page filling the photo, a plain picture and a round plate left alone); the photo kept with the file, in the evidence pack with its line, Undo cleanup, another account's file, a part that is no picture, and the photo off the disk once its file is gone. |
| `tests/convert.test.ts` | Office files turned into PDF: every kind recognised from bytes built in the test (Word, Excel, PowerPoint, OpenDocument, the old binary formats, RTF, HTML, text, TIFF) and never from the name, the unknown kinds and what each is told, passwords, ZIPs that unpack to more than 100 MB or 20 times their size (also when they lie about it, and one entry listed eighteen times), the test converter through a whole send, sign and evidence pack (the audit line with both fingerprints, the original kept encrypted, in `originals/`, kept while another account has it and deleted with the account), a correction that puts a converted file on, the notes (tracked changes, comments, sheets, outside content but not web links, macros), a name that reads like a payment notice left out of the record, no converter set up, a signer's attachment, several files at once, a TIFF that would lose pages, a stand-in for LibreOffice that hangs (killed with what it started, its folder gone), shows its environment (no secrets) and its network (none), the queue and the limit per account, the real LibreOffice when it is installed, and the repairs: a web page cleaned of everything it names outside itself however it is spelled (and a picture on the server's disk that does not reach the PDF, with the box and without it), the box itself (what a job can see: LibreOffice, its folder, nothing else), a 1 KB sheet of a thousand million cells stopped by the memory limit, a text file with no words, the original downloaded again by its account only, one note line with the rest folded, and the refusal without a converter in one plain sentence. |
| `tests/i18n.test.ts` | Languages: the catalogue parser and its placeholders, plural rules for English, French, Arabic and Russian, the fallback from pt-BR to pt to English, a missing or broken text shown in English and never as its key, right to left, the statuses of each language, the choice of language (the sender's, the browser's, English), legal texts in English with one sentence until a person has checked them, the language recorded in the audit line and read back by the evidence pack, `recipients[].locale` and `default_locale` refused in words when a language is not available, templates, copies, bulk rows and public forms, the bulk list's language column, `<html lang>` and `dir` (read from the request only once a second language ships), dates and numbers by language with the Gregorian calendar and the signed PDF unchanged, `npm run i18n:check` failing on a catalogue that does not match (repeated keys, hidden direction characters, web addresses, dropped plurals), a person a document is passed or corrected to starting without the first person's language, `language` read like `locale`, and the evidence pack reading the wording from the end of the audit line whatever the person's name says. |
| `tests/ds-lang-mail.test.ts` | Emails and texts in the recipient's language: every `mail.*` text reads and has no em dash, an English email word for word as before with `lang` and `dir`, the footer from a test catalogue with its html parts escaped once, a request and a reminder in a test French with every line of ours translated and the sender's subject and message untouched, `emails.locale` kept, a catalogue that says the same as English giving the English email word for word, senders and English recipients in English, a language that is not switched on never used, text parts (GSM 160/153, UCS-2 70/67, the extension signs, emojis), an Arabic text counted in parts on the row and against the daily limit, the one-time code by email in French with our copy still losing the code, and the fake-notice filter refusing the same envelope for a French recipient. |
| `tests/ds-lang-signing.test.ts` | The signing page in the signer's language: every refusal the signing routes say with a code has its text in `en.json` and the English answer is that text, the page says it from the code in the signer's language and in the server's own words when there is no text, the header menu absent with one language and listing each language in its own name with two, `POST /sign/:token/locale` saving on the person with one audit line (refused for a language not switched on, behind an access code, and past 20 an hour), consent in a language without checked legal text shown in English with the note and recorded as English, the certificate's language line, logical CSS with the document, the pad and the zoom never mirrored, the test languages en-XA and ar-XB keeping every placeholder and plural, and the files that are done showing no English written into the code. |
| `tests/ds-lang-sender.test.ts` | The sender's language: nothing to choose and nothing written with English alone, `PATCH /me` "locale" refusing a language that is not a sender language, a test language or nonsense with a code and nothing saved (the name in the same call included), the choice saved and a draft marked once French is switched on for a test, the browser's language noted for emails and cleared again, a choice no longer used once its language is switched off, the emails to a sender (declined, signed, completed, the comment digest with where a comment is pinned) in a test French with every paragraph of ours translated and the sender's subject, a signer's reason and a comment as written, the same emails in English as before (with "document" for "envelope"), the signer's own emails untouched, names listed as before in English, refusals said from their code, the test languages en-XA and ar-XB, an account name with digits kept whole next to a bold part, a regional tag saved as its language, the language card saving on change with no button, the empty Home in one whole sentence per layout, and the finished sender screens showing no English written into the code with every key they ask for in `en.json`. |
| `tests/ds-lang-sender-rest.test.ts` | The rest of the sender's screens and the public pages in the catalogue: the finished files (most of Settings' cards, the stamp screens, Team's roles and groups, Keep and delete, Organisation, Templates, Send to many and what a batch holds, Forms, Website terms, Contacts and signing groups, Reports, To sign, the sign-in forms, the home page and the top of `/impact`) showing no English written into the code and asking for their words in the screen's language, every key they ask for in `en.json`, reading in the test languages en-XA and ar-XB, the English texts word for word what the screens said (plurals included), the ink names and what a role can do equal to `src/lib`, no "envelope" or "void" and no em dash in the new texts, the public pages following the browser and reading the request only once a second language ships, the files still to do (`LEFT`) each named in "What is not in it" and each still holding English, so none is forgotten or wrongly listed, and the `tests/words.ts` helper that lets older tests read those screens with their English put back. |
| `tests/brand.test.ts` | The GrowSigning brand: brand.css loaded last, no leftover data URI icon, the four icon files and the link preview picture the same as the brand kit with its alt text, `metadataBase` from `APP_URL` (a broken one falls back instead of taking pages down), one web app manifest whose icons are the sizes it says, the drawn logo in every place that showed the leaf beside the typed name and never the mark beside the typed name, the email logo picture (a sender's own logo or name still first, escaped), the logo above the card on the pages reached from an email and our own page for an address that does not exist, a page title that does not say signing plants trees, the email logo on a tile of the email's ground colour, the stamp with the envelope ID line beside it in the lowest 17 points of every page of a signed copy turned 0, 90, 180 and 270 degrees (nothing at the top, the line made smaller on a narrow page) and at the foot of the certificate with its deep green band and logo (drawn with poppler, pixels counted), no old name and no old web address (growsigner) anywhere, and a browser signed out after 30 idle days or 90 days from signing in. |
| `tests/open-platform.test.ts` | What earlier reports on the help chat, stamps, self-hosting, email archive copies, the security record, deleting and languages left open, finished: Help as one button in the signing page's top bar; a stamp design of hairlines printed with even ink from the start, and said so; Settings sections named "Stamps and seals" and "Records and data" everywhere; 44 px footer and palette targets; "A person replies" only where someone reads the requests, on /help and in the email that confirms a request too; the compose example's converter on a network with no way out; one Gmail inbox however dotted; asking stopped after three strangers mark it as spam, also when the address was removed first, until the day it names; no link or code in the copies of bulk sends, corrections, reminders and disputes; a security-record webhook said as such under Developers; the security record downloaded in pages and noted outside the database once a day; a held draft frozen through every door; "Keep it until <day>" in the Delete dialog's own row, only when it keeps the document longer; the deletion record as a spreadsheet or a PDF and in an admin's export; a fold at the end of a dialog reached with Tab; days written out in history; the language of a place that goes to another person; digits 0 to 9; and every text key built at run time present. |
| `tests/open-public.test.ts` | What earlier reports left open, finished: the stamp and the envelope ID line never on a document's own text, pictures, drawn lines and shapes (a ruled line, a frame, words drawn as outlines; white and the sheet behind everything do not count) or filled-in fields (left when the foot is clear, right or in a gap when it is not, on a margin added under the page when the foot is in use from side to side or the page could not be read; pictures found inside forms and inline, on turned pages; the signed copy drawn with poppler and compared pixel by pixel with the document as uploaded), a narrow page, and the stamp on pages a signer attached; an install made with `--ignore-scripts` still gets its fonts and viewer at build; tab titles of the email landing pages; Details explained on /help; Undo after removing a person in the editor; a Microsoft sign-up confirmed with the 6-digit code; Send to many, Documents, Reports, /help and /verify saying document and cancelled; every moment in a message, email or record written "21 Nov 2026 05:40:12 UTC" and every screen date day first in an English browser; /pricing and /features short (two plans, three rules, the comparison and the nine promises folded). |
| `tests/selfhost.test.ts` | Running it yourself: `/api/health` when everything works (and nothing about any account in the answer) and with each failure on its own (a full disk, a folder that cannot be written to, a database that does not open, a stopped file store, a timer that never ran, hangs, failed or is late); a backup made while a document is uploaded, with its manifest and no key anywhere in it; a restore that gives back the database byte for byte and every stored file, checks every chain, and says which key is missing or wrong; every way a backup is not whole (stopped half way, no manifest, a changed byte, a missing file, a cut database, a manifest that names a file outside it) and a folder that is not empty; the hosts the settings imply for several configurations; what `all`, `listed` and `none` allow and what a typo does; `none` switching each service off; a stubbed outside call refused before it is made and a listed one allowed, logged once an hour; `net`, `tls`, `http` and `https` held too, and nodemailer reaching a relay by its looked-up address through a mail server on this machine; webhooks at saving and at delivery; every file in `src/server` that opens a connection being on the list; security.txt and the disclosure page; the bill of materials and the licence gate; the words of `docs/controls.md` and `docs/runbooks.md` (no claim of a scheme, every cited file exists); the Dockerfile, the compose example and the chart read as text (not root, a health check, one replica, egress denied). With `SBOM_BUILD_CHECK=1` after a build, the served bill of materials. No network. |
| `tests/simplify-start.test.ts` | The way in, Home and the menu made simpler: the confirmation email has a 6-digit code and at most 50 words, the code confirms only in a browser signed in to that login, a new code replaces the old one, a code runs out after 24 hours, 10 wrong codes in all close codes for a login for good and leave the button in the email, and something that is not 6 digits costs no guess; Home has no start button of its own and lists what was completed with a Download for each; the menu has nine entries with the five that moved inside More, a member does not get Website terms (and the server refuses them too), no total of paper under 1,000 sheets; a document is named after its file in words ("planting-partnership.pdf" becomes "Planting partnership") and a name the sender typed is kept. After the skeptic's and the simplicity reviewer's rounds: Send from an unconfirmed address is refused in words the review step turns into the code box; wrong codes count per address across a deleted login; a pause after 5 tries in a minute says how long; digits in other scripts; no API key before confirming; sign-up limit in plain words; lists and downloads without "Please sign:"; the phone menu, the skip link, tab titles and the words on the pages inside More. |
| `tests/note-text.test.ts` | "Fill in" and "Your text": the names and one-line hints in every place a kind is named, the stored types unchanged; a new "Your text" box starts empty; an empty one (no value, an empty string, spaces or line breaks) is saved with no value through the API, a template, a copy and a bulk send, reaches no signer on the page or in the text view, is not on the signed PDF, and never stops a send; a box with words still reaches everyone; the review list and what it brings up; the label of a Fill in field as the signer's hint and "Type here" without one, while a sentence calls it "Text box"; "Let them type here" turns a "Your text" box into a blank in the same place; a note sent through the API for a person and with no words is refused with the way out; boxes that still held the old starting word "Note" are emptied once in drafts and templates, envelopes already sent are left alone; no em dash in the new words. |
| `tests/simplify-editor.test.ts` | The editor made simpler: step 1 opens with one empty person row that is never saved, sent or counted while nobody typed into it; a person row is a name, a wide email box and one More; the lines of that More for every role (never one with a single answer, at most 6 with nothing set up and 8 with everything), five roles with signing in person as a way of signing; the subject, the message, reminders (asked once), the deadline and the date format on step 3 under one More options; six kinds of field with the rest behind More fields; a field's Assigned to, Required and Label with the rest under its More options; keyboard help behind a fold and no tag jargon; the saving of one document in pages with no fraction of a tree; and Sign now: offered only when the one person is the sender, no invitation email, the record says so, and it cannot skip anybody else's email, hand a colleague someone's link or skip an access code (the sender's own API key gets the link, a colleague's does not). After the review: nobody is called "Unnamed" and only a template says an address is filled in later; Next with no file or nobody typed in stays on step 1 and says so in place; the editor's words say document, file and person; "Check who signs" is one list and what a locked template asks for cannot be picked away; the text-message tick is under "How they get it"; the line next to step 3's More options (reminders always, the rest only when it differs, a payment link when signers will see one, nothing about reminders for Sign now); a field's More options closes for every other field. |
| `tests/simplify-envelope.test.ts` | The document page, completed documents and Templates made simpler: one main button by state (Continue, Remind with the person's name, Sign now, Download, Reopen, Copy and fix) and never two filled buttons; everything else in the page's one More in a fixed order, at most nine lines in any state, one Delete, Keep it and Hold only when a deletion schedule applies; a second Remind for one person only when two or more wait; each person one line and one More, with the ways to share their link under "Share the link yourself"; comments, History (the emails in the same list), Files, Details and checks folded and closed; no internet address or fingerprint among the lines the page draws while the API and the full record keep them; one Download on a completed document; Templates with Use on the row and the other five in its More; the Sent banner and the way back to Templates after sending from one; a toast lifted off anything that can be pressed; and that every call the old page made still answers, and none of them for a stranger. |
| `tests/simplicity-r6.test.ts` | The sixth walk through the whole product as a new sender and as a signer on a phone (`src/lib/simplicity.ts`): the done screen has one main button, Download, and says "signing record"; buttons, step tabs, boxes and the public pages' links are 44 px tall at every width; step 3 shows who gets it before the email; Documents explains its line, asks to tick boxes only when there are boxes, shows the ZIP button only once something was sent and has a search hint that fits a phone; the email switches have one line each; the login address is said once; a file row's page count is its Pages button; the signing page's top bar and the document page name the document the way the lists do (no "Please sign: "); the sender's screens say document, History and Send to many (never envelope, audit trail or bulk send); Help's buttons start with a verb. |
| `tests/ds-witness-two.test.ts` | Two witnesses for one signer: named by the sender (both asked at once after the signer, Ben waits for neither, never charged, each their own statement, the certificate with both under the signer and each statement), more than two refused, one person as both refused (the same address, the same name, another spelling) and a party refused, named by the signer (both before Finish, each place by its id, the other one never again), one "not there" and replaced while the other's statement stands, both set aside on the record when the signature is and both asked again, the same-device mark per witness, and the screens' words. |
| `tests/ds-paper.test.ts` | Signing on paper: off by default with nothing on the signing page, the print and the upload refused and "On paper only" refused in words; who may (signers and approvers, "On screen only", never in person, a group, a witness or a signer with one, a public form, a payment before finishing); the print with a cover page, the marks and the envelope ID, "Page x of y" and the code on every page, a new code after a change; photos as one document, the audit line, the sender's email, the order and reminders waiting, Finish on screen refused; Ask again with a reason (needed, emailed, shown, a new scan then); Accept (the person finished from the scan's address, "Signed on paper" in the trail, one signature used, the next person asked, a second Accept refused); the signed PDF (the divider right after the documents, the places pointing to it, the certificate sentence and status, no "Signed without paper"); "On paper only" with Finish refused and a scan of an older version not accepted; other accounts refused; the API description. After review: sign again after an accepted scan needs consent and a new signature (a forged body cannot claim the paper path) and keeps the new values; a scan set aside after a correction to another person and never accepted as theirs; no "signed on screen" in the completion emails; no link and no badge on the print; the asked-again reason in the facts and on both screens, also after paper is switched off; a reminder refused with the true reason; Other actions on the paper screens. |
| `tests/ds-consent-own.test.ts` | The account's own consent text: refusals in words with nothing saved, a version for each save that changes a word and none for the same words, versions that a trigger keeps from being changed and that are never deleted while a document refers to them, admins only, stopping keeps the versions, a text per language numbered on its own, the payment-notice filter at saving and at showing; on the signing page nothing changes with zero setup, the screen must name the version it showed (409 otherwise, also for a screen left open while a new one was saved), the audit line names version, language and SHA-256 next to our wording and none of the account's words, English with the "not yet checked" sentence for a language without a text, once for each document or every time (never twice in a minute, at most 50); "Sign on paper instead" closes the part with the right reason before or after agreeing, emails the sender even with problem emails off, refuses a copy-only person and a second tap, works for a member of a group, and the certificate line says withdrawn; the evidence pack prints the exact words of each version with the fingerprint the trail names; closing an account takes the versions along; the API description; and the screens (Other actions only with a text and only for someone with a part to stop, the fold at 120 words, Settings behind More options). |
| `tests/consent-short.test.ts` | The consent screen since 23 November 2026: one short sentence with one tick ("I agree to sign this document electronically.") and nothing of ours above it, the link "How electronic signing works" that opens the rest in place, every fact the wording before it said still said behind that link, the new version `2026-11-23` in the audit line with the time and the IP address, the evidence pack printing the sentence as shown and the rest as what could be opened, the earlier wordings kept word for word and still recorded for people who agreed under them, Finish refused before agreeing, Decline without agreeing, a witness shown and recorded with the same sentence and their own way out ("I was not there"), and each kind of recipient told only a way to say no that their screen has. |
| `tests/ds-web-forms.test.ts` | A form as questions: the open role's fields as questions in reading order with sections, help and choices, the same checks and "Only show when" rules in the browser and on the server, answers kept for one browser for a day (never for another browser or a forged cookie) and gone after, an abandoned form that makes nothing and sends nothing, the whole document with the answers drawn in before anything is made, the envelope made only on going on to sign with the answers as the person's own and a line on its history, a paused form that keeps nothing, the size limit, 20 sets per connection, the fake-notice filter over the answers, a form with no questions as before, the QR link; a second start in the same browser signs the changed answers, the document opens only with the key of the latest save (never for the next person at a shared tablet), a larger save allowance on shared-device forms, and unlabelled fields kept on the document. |
| `tests/ds-visibility.test.ts` | "Each person sees only their files": the rule (fields, ticks, a witness, no fields, roles that see everything, one file, off), a file someone is not shown absent from every answer of their link and 404 by its address like one that does not exist, its notes, fields, files to read and pinned comments left out, their own completed copy (made through the finishing steps, stored, different for each person, verified by file and listed by ID, attached to their email with its own fingerprint, made again if missing and never replaced by the full one), the certificate line with the fingerprint and no name, names taken out of their trail and their screen, the sender's copy and the evidence pack with everything, ticks that add files, a finished person's files fixed through a correction, groups, witnesses, templates and sign again, the preview, and the account default. |
| `tests/open-r6.test.ts` | What the repair rounds left open, finished: 44 px targets in every Settings section; a number read two ways said under its own field, about the signer's answer only; a scanned file an editor brings in held until its pictures are read, then checked by the fake-notice filter; who sees which files, and "Everyone else sees every file."; times on the sender's screens (Send button, Documents, Home, the envelope page) in the viewer's zone and order, like the time box; the keys and webhooks section named Developers; old localhost websites shown apart so they can be removed; the must-tick tag kept after a file is opened; the summary refusal worded for people who did not sign. |

## Running it yourself

For a public body or a company that wants its own copy, in its own country, on its own servers. One container, one
volume, nothing that calls home (the framework's own usage statistics are switched off in the image and by
`npm run build` and `npm run dev`; if you call `npx next build` or `npx next dev` yourself, set
`NEXT_TELEMETRY_DISABLED=1`, or the framework sends its statistics to telemetry.nextjs.org). Nothing here is audited or certified by anyone: `docs/controls.md` is a
self-assessment by the authors and says so in its first line.

**One container.** `Dockerfile` builds it on Node 24 (the long-term-support line; Node 22 leaves support on 30 April
2027). It runs as a user without privileges, and `docker-compose.example.yml` and the Helm chart in
`deploy/helm/growsigning` give it a read-only root file system, no capabilities and two small in-memory folders for
temporary files. `--build-arg WITH_LIBREOFFICE=1` puts LibreOffice in, for `CONVERTER=soffice`; in this container
LibreOffice then has whatever network the container has and can read whatever files the container's user can
(the stored documents and the database among them), because `unshare`, which takes the network away from it and
builds the box it otherwise sees only its own job folder in, is not permitted with the capabilities dropped (run
here: "Operation not permitted"). So deny egress in the network before you switch it on, and know that in this
container an uploaded office file is kept from the server's files only by LibreOffice's own setting that blocks
links from untrusted documents, and a web page by our cleaning of it ("Turning office files into PDF" below). The
safer way in Docker is the other one the compose example carries: leave LibreOffice out of this image and start its
`gotenberg` service (`docker compose --profile office up -d`, with `CONVERTER_URL=http://gotenberg:3000` in `.env`).
It runs in a container of its own on a network marked `internal`, which has no route out: only this app reaches it,
and it cannot see this app's files. That file is checked with `docker compose config`; we have not run the office
profile in Docker ourselves. The base image is a
build argument so that you can pin it to a digest you checked; the Dockerfile says how.

```bash
cp .env.example .env                         # every setting, with what it does
npm run setup                                # writes a new FILE_ENCRYPTION_KEY into .env; keep a copy of it apart from the server
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
docker compose ps                            # "healthy" once /api/health answers 200
```

**One volume**, at `/data` (`DATA_DIR`): the database `sign.db` and the stored files in `blobs/`. Everything else
in the container can be thrown away.

**One copy of it, never two.** The database is SQLite, which has one writer. The chart fixes the Deployment at one
replica with strategy Recreate and `values.yaml` says why. An update means a short stop. More than one copy needs
Postgres, which is not built.

**The settings that matter:** `APP_URL` (the public https address), `TRUSTED_PROXY_HOPS`, `APP_SECRET` and
`FILE_ENCRYPTION_KEY` (make both, keep both in a secret store of your own, apart from the server and the backups),
`SMTP_URL` for your mail relay, and the settings under "Where the data is", which `/security` prints. TLS is the
job of the reverse proxy in front: the app speaks plain http.

**Monitoring.** `GET /api/health` answers 200 only when the database opens, `DATA_DIR` can be written to, more than
1 GB is free on its disk (a tenth of the disk when it is smaller than 10 GB), storing files is not stopped and the internal timer finished a run in the last 30
minutes. Otherwise it answers 503 and says which of these failed, in words. It also says whether a mail server is
set up, which is not a failure. It says nothing about any account. The image's HEALTHCHECK and the chart's
readiness probe use it.

**Every outside service is optional, and listed.** `/security` has "What this server connects to": the mail relay,
the payment provider, Google and Microsoft sign-in, the text message provider, the time-stamp service, the AI model
of the help chat, the document converter, the list of leaked passwords, Amazon SNS confirmations and webhooks, each
on or off from the settings this server runs on, with the hosts. The server logs the same list when it starts. The
list is in one file, `src/lib/outside.ts`, and a test fails when code in `src/server` opens a connection that is not
on it. WhatsApp (Meta or Twilio) and calls with a code (Twilio) are on that list and are only called where the
operator set them up. Certificate revocation checks and any kind of analytics are not in the software, so nothing
calls them.

**`OUTSIDE_CALLS`** holds the server to that list from the inside:

- `all` (the default): nothing is held.
- `listed`: only the hosts the settings imply and those in `OUTBOUND_ALLOW`; webhooks only to
  `WEBHOOK_ALLOW_HOSTS`. Anything else is refused before a byte is sent, with an error that names the host and the
  setting, and logged once an hour for each host.
- `none`, for a closed network: only the mail relay and `OUTBOUND_ALLOW`. Payments, Google and Microsoft sign-in,
  text messages, time-stamps and an AI model on another host are switched off when the server starts, so each is
  absent exactly as on a server where it was never set up, and `/security` shows it as switched off.
- Any other value is read as `none`, and the log says so.

This is a second line of defence, not a firewall. It covers `fetch`, every TCP and TLS connection Node opens (it
stands at `net.Socket.prototype.connect`, where `net`, `tls`, `http`, `https` and `http2` all end, which is how the
mail relay and webhooks connect) and UDP (`dgram`). An address with no name passes only when it came from looking
up an allowed name or is listed itself; an allowed TLS server name does not make an address allowed. In mode `none`
a name that is not allowed is not looked up either, so a payment link can only be checked, and so shown, when its
host is in `OUTBOUND_ALLOW`; in mode `listed` names are still looked up, because that is how a payment link is
checked. It cannot see what a program the server starts does (LibreOffice), or native code, and code written to
get around it (a saved copy of the original functions, a worker started before it) could pass it. **Deny egress in the network as well:**
the chart's NetworkPolicy denies all of it by default, with a list to allow. `/security` keeps the two facts apart:
what the software is configured to connect to, and what the network allows, which the page cannot see.

**With no network at all.** Tested on 21 November 2026 with `scripts/container-smoke.sh`: the image was built,
started with `docker run --network none --read-only` and `OUTSIDE_CALLS=none`, and through the API an account was
made, a PDF uploaded, an envelope sent to a person without an email address ("I will send the link myself"), the
signing link fetched (`recipient-view`), the document signed, the signed PDF downloaded and checked by the server's
own verify call. That is all that was tested there. Not tested: a real closed network with a mail relay inside it,
Kubernetes (the chart was written and read, never installed, and `helm` was not at hand to render it), and the
LibreOffice layer. One thing a closed network must have: **a mail relay inside it**, because a new login confirms
its address by email before it can send. (The smoke test reads that email from the outbox with `DEV_OUTBOX=1`,
which must never be set on a real server.)

**Backups.** `node scripts/backup.mjs <folder>` (or `docker compose run --rm backup`, after
`mkdir -p backups && sudo chown 1000:1000 backups`, because the container runs as uid 1000 and Docker would make
the folder as root) makes a consistent copy while
the server runs: every stored file, then the database in one step with SQLite's own online backup (`VACUUM INTO` on
a Node without it), then the files that arrived meanwhile, then a manifest with the SHA-256 of each. The folder
only gets its dated name when it is whole. **The keys are never in a backup:** `FILE_ENCRYPTION_KEY` and
`APP_SECRET` are settings, and the file `DATA_DIR/secret` (the secret a server makes when `APP_SECRET` is not set)
is left out too, loudly. Keep them in a secret store of your own. The database inside a backup is readable to
whoever has it, so encrypt the copies.

**Restore.** `node scripts/restore.mjs <backup> <new empty folder>` refuses a backup that is not whole (stopped
half way, no manifest, a file missing, cut short or changed) and copies nothing then. It never writes into a
folder that has anything in it. After copying it recomputes every audit trail's chain and every account's security
record chain with the server's own code, opens every stored file with the keys you gave and compares it with the
SHA-256 it is named by, and tells you when a key is missing or `APP_SECRET` is not the one the backup was made
with. `--verify` only looks. `tests/selfhost.test.ts` runs the whole round trip.

**A security contact.** Set `SECURITY_CONTACT` and the server answers `/.well-known/security.txt` (RFC 9116: the
contact, an expiry 360 days ahead, the canonical address, the policy). `/security/disclosure` ("Report a
weakness", linked from the footer and from `/security`) says where to write and promises an answer within
`SECURITY_REPLY_DAYS` only when you set that. Without a contact there is no security.txt and the page sends people
to the help address. It promises no reward and no safe harbour.

**What it is built from.** `npm run build` first runs `scripts/sbom.mjs`: a software bill of materials in CycloneDX,
made by npm itself (`npm sbom`, without development packages), served at `/security/sbom.json`, and a plain list of
licences at `/security/third-party-licences.txt`. The build stops when a package names no licence or one that
nobody has read against EUPL-1.2 (the list is in the script; it makes a person look, it is not legal advice).

**Papers for a security team.** `docs/controls.md`: for each theme of ISO/IEC 27001:2022 Annex A and each of the
14 UK NCSC Cloud Security Principles, what the software does (with the file) and what the operator must do.
`docs/runbooks.md`: making and restoring a backup, rotating `FILE_ENCRYPTION_KEY` and `APP_SECRET` (and what
rotating `APP_SECRET` breaks, which is a lot), a leaked key, a breach, rebuilding the same image, running with no
network.
The procurement documents (a security whitepaper, data processing terms as a template for a lawyer, an impact
assessment pack, a transfer assessment template, an exit plan and an incident response document) are in
`docs/procurement/`, and `/procurement` serves every one with its date. `/security/subprocessors` lists who else
handles data on this server, from its settings.

## What the bad reviews taught us

Before building further we read the negative reviews of the market-leading e-signature product: review sites,
complaint boards, community forums and developer issue trackers. The notes are in `research/complaints.json`
(167 sourced complaints, merged into 45 themes). Four areas were not researched and are open gaps, not clean
results: mobile app store reviews, users outside the US, account security and signature disputes, and
industry-specific workflows.
Each row is something people complain about again and again, and what this code does instead. Every row is
behaviour in the code, not a line in a policy page, and most rows are pinned down by a test in
`tests/billing.test.ts` or `tests/trust.test.ts`.

| What people complain about | What GrowSigning does |
| --- | --- |
| Two parties had to fill in the same box on a contract and could not: each field belonged to one person, so the sender voided and resent, or someone wrote the change in the margin. | A text, choice, dropdown or tick-box field can be for "Anyone on the document". Every signer can fill it in, the page says who changed it last, every change is in the audit trail with the value before, and once someone has finished a change is refused unless the sender allowed it, and then whoever finished is asked to sign again when the person who changed it finishes, so nobody's agreement changes under them. Tests in `tests/ds-collab-fields.test.ts`. |
| On a phone the document is a tiny page to pinch and drag, and the fields are hard to find. | View, Easy reading shows the words in one column with headings, lists and tables, and the person's fields in place as large controls. It says it is a reading aid and that the pages are what is signed, leaves out words the pages do not show, every part links back to its spot on the page and back again, and the certificate says which view each person used (`tests/ds-reading-view.test.ts`). |
| A public body on a fixed budget is billed per envelope, runs out mid-year, pays overage, and finds the price rose at renewal. | With `BILLING_MODE=deployment` nothing is counted: one fixed fee a year, no limit on senders or signatures, no overage, nothing charged to citizens, and the plan's screens and routes are gone. `/pricing/government` states the contract rules (rises capped at the consumer price index with 90 days' notice, no renewal at a new price without written acceptance), and `/tco` adds up the real cost from the agency's own numbers, the licence at 0 (`tests/gov-g14.test.ts`). |
| When someone is away or leaves, nobody else can look after their envelopes; moving them is in a different admin area, only some of them move, and templates stay with the person who left. | A member shares their documents with a colleague at a level (see, manage, send for them) for set days, in Settings, Away and sharing, and anyone of the two or an admin ends it at once. Everything done through it names both people in the audit trail and the security record. The person a document belongs to, or an admin, moves envelopes and templates to another member: from the document's More, a template's More, several ticked in Documents, or all at once in Settings, Team after seeing how many; the certificate keeps the first sender. Leaving the account ends every share for good. Sending in someone's name shows recipients both names, never only the owner's (`tests/ds-colleagues.test.ts`). |
| I was on leave, documents waited for me, and the way to let someone sign for me was hidden and did not stop when I came back. | With an admin's switch on, a person names someone who signs for them on set days (Settings, Away and sharing). A document sent to them from the account on those days goes to both; whoever agrees first takes it on, signs with their own name and signature, and the certificate says who signed for whom and that GrowSigning does not know whether they had the authority. It stops by itself after the last day. A sender sees one choice about it, only when someone on the envelope is away, naming who (`tests/ds-delegate.test.ts`). |
| Single sign-on is missing from my plan or sold as an add-on, the admin cannot find it, and someone who left keeps access. | Single sign-on with your own OpenID Connect service is in every plan, under Settings, Security, "Single sign-on", on a server that keeps secrets encrypted (`FILE_ENCRYPTION_KEY`). Claim your email domain with one DNS line, add the service, try a sign-in, then switch on "Everyone at these domains signs in through ...": passwords, Google and Microsoft are refused for those addresses with the reason, and their browsers stay signed in for at most `SSO_SESSION_HOURS` (12), so a closed login at your organisation ends access here within that time. API keys a leaver made keep working until they are removed from the team. The owner keeps a password with two-step login as the way back in, cannot switch it off while the rule is on, and each use is in the security record (`tests/ds-sso-oidc.test.ts`). |
| Setting up SAML or directory sync needs a sales call, and when IT removes someone in the directory they keep access here. | SAML 2.0 sits in the same Single sign-on card as OpenID Connect, chosen with one switch: give your identity provider our two addresses, paste its metadata, try a sign-in. "Members from your directory" gives your directory (SCIM 2.0) a token; someone it switches off or deletes leaves the team at once, the way an admin removes them: what they sent passes to the owner or to the member you chose, their API keys stop, and the security record says it was the directory. With "Members are managed by your directory" on, nobody is invited by hand (`tests/ds-sso-saml-scim.test.ts`). |
| Too many screens and too much to read before I can sign, and the invitation email is a wall of text. | The consent screen names the sender once and asks for one tick next to one sentence, "I agree to sign this document electronically." Everything else we say about electronic signing is one tap away under "How electronic signing works", under Continue, so the screen has 15 words before its tick with a one-line message (114 before 23 November 2026, measured the same way at 390 by 844 and 1440 by 900; never more than 120), fits one phone screen, and opening the link moves neither the box nor Continue. Next goes to the field and opens it, the "Sign here" pointer keeps clear of printed labels, and the view, the page size and the download are behind one More. The dialog is called "Your signature" and its button "Sign". Finish signs without a second confirmation unless something needs a look. The invitation has one short footer for the security code, Report this email and the copy of the link, and a deadline is said in the reader's own time once their device has told us the zone (in UTC, and marked as UTC, until then, unless the same address told the same sender its zone on an earlier document). Measured with `tests/ux/flows.cjs`; ceilings in `tests/ux/ceilings.json`. |
| The broker who knows who the buyer will be had to sign an empty field, or I had to void and resend when the landowner turned out to be someone else, and nothing recorded who chose them. | A person can be "Chooses who comes next": the sender leaves the places after them empty and they type the names on their turn, or change someone who has not started yet. "Can change the document" lets a lawyer replace the file or change the people after them, and anyone who already signed is asked to sign again, never silently. Neither signs, neither can touch the subject, the message or the people before them, and the record says who named whom: "Mia Chen named Paul Ade as the signer for Landowner". Whoever is asked to sign again is told who changed it, and neither role can hand its power to another address (`tests/ds-recipient-types.test.ts`). |
| I sent it too early, could not stop it while we renegotiated, and the reminders kept going; scheduling meant a third-party add-on. | Send later is in step 3's More options, and the draft is checked again when it goes out, so a balance that ran out or a paused account stops it with an email that says why instead of a silent failure. Pause stops filling in, signing, finishing, declining and every reminder at once (reading, questions and asking for more time stay open), never says "expired" to the signer, and Resume gives back exactly the time it was paused (`tests/ds-timing.test.ts`). |
| I have no document yet, and the AI contract writer makes up terms, adds a governing law I never chose and says it binds us. | "No document yet? Write one": starters with [blanks] that must be filled before the PDF is made, and, only where an AI is set up and switched on, a draft from your own words that leaves blanks for what you did not say, names no law or country you did not name, prints no web or email address you did not type, and has "binding", "valid", "enforceable" and "approved by a lawyer" taken out. The line above the draft says it can be wrong and is not legal advice; the line under the box says where the text goes. |
| The AI helper reads my whole contract without asking, places fields wherever it likes, and its summary reads as if it were the agreement. | Nothing reads a document until an admin switches on "Let the AI read document text" (off by default, with one line on what it is used for and the model, its host and the host's country). Suggested fields come only for pages where Place fields for me found nothing, from the page text (never a picture), each checked, drawn on the page as a dashed outline marked Suggested and added by the sender one by one or all at once. Nothing the AI writes keeps a phone number, an email address or a request for payment details. A signer's summary is offered only when the sender switched it on, sits behind one closed link above the document, says "Made by an AI. It may be wrong. It is not the agreement and not legal advice. Read the document.", and never changes what is signed. |
| Signed agreements sit in a folder and nobody notices the renewal or the notice date until it has passed; the "AI insights" fill in dates nobody checked. | Key dates, when an admin switches it on (its own switch, after "Let the AI read document text"): the AI reads completed documents and proposes the parties, dates and amounts, each with its page and the words it came from, and drops anything whose words are not in the document or do not hold the value itself (the date written out, the numbers of the amount, the names). Each one says "Found by AI on page 3. Check it." and is used for nothing until the sender confirms or corrects it. Then it is a detail of the document, in the filter "With a date in the next 90 days", in a calendar file, and "Remind me" emails the sender N days before. |
| The app greets me with a wall of buttons and a menu full of words I do not know, and I had to leave the page to confirm my address. | One start button, "Send a document": at the top of the menu, and on a phone as Send in a bar at the bottom next to Home, Documents, To sign and Menu. The menu has nine entries in plain words; Send to many, Forms, Website terms, Reports and Trees planted sit in More, which opens by itself on those pages and stays open for someone who opened it. Home shows what waits for you, what waits for others and what was completed lately, each with Download. A new address is confirmed with a 6-digit code typed in the same tab (the email has at most 50 words and still carries the button), and the banner goes by itself when the address is confirmed anywhere. Whoever presses Send first finds the code box on the review step, next to Send. A document is named after its file in words, so the subject reads "Please sign: Planting partnership" and the lists and the downloaded file read "Planting partnership", not "planting-partnership". A total of paper saved is shown only from 1,000 sheets (`TOTALS_FROM` in `src/lib/impact.ts`). Signing your own document starts from the same button: "Add me", and the review step's button reads "Sign now". |
| My manager cannot see which forms stall, and the team retypes the same list of people for every bulk send. | Reports shows, for the days you choose, what was sent, what is finished and how long that took, by template and by sender, with Download CSV of exactly that. Owners and admins can get last month's numbers by email on the first of the month. A list pasted into Send to many can be saved for the team and used again, checked against the template each time; it says it holds personal data, and one nobody uses is deleted after 180 days. |
| An envelope for several people shows everyone everything, so the employee sees the salary sheet meant for HR, or each party needs an envelope of their own. | "Each person sees only their files": each person's link shows only the files with their fields (and those ticked for them), refuses the others by address, never names them in its subject or its emails, and their completed copy holds only their files, with the others listed by fingerprint so it still verifies. The sender keeps the full copy (`tests/ds-visibility.test.ts`). |
| Signers forward my contract to whoever they like, comment threads I never wanted, and nobody can say whether a signature was typed or drawn. | Each is a plain switch under Settings, Sending, "When people sign", that starts as it always worked: passing it on (and keeping the first person as a copy), questions and comments, and the ways to make a signature, with the certificate saying how each was made, as the signing page reported it. Beside the ways: "Drawing does not make a signature stronger in law." Each document keeps the switches it was sent with, so a change later never surprises someone who is signing. (`tests/ds-switches.test.ts`) |
| A privacy notice or terms have to go with the document, but the only way is to staple them in as pages to sign, and nobody can tell who saw them. | A file can be "To read, not sign" with a rule before Finish: none, must open it, or must tick "I have been given it". The record says Opened or Acknowledged, with the time, and never claims it was read. The completed copy keeps them after the signed pages behind a divider unless the sender leaves them out, and the certificate gives each its SHA-256 (`tests/ds-supplements.test.ts`). |
| The plan renews with no warning, and the email does not say the amount. | Month to month only. A week before and again the day before every renewal an email states the exact amount and date, with a link that stops it. The reminders run on the app's own timer and are written to the plan history. If more is charged than the reminder said, the difference is refunded by the software. Every payment gets a receipt. |
| "I cancelled and was charged anyway." | Cancelling tells the payment provider at once, says "cancelled" only when the provider has confirmed it, and returns a reference that stays on the Plan page. A charge on a plan that already ended, a second charge for the plan, or a charge on a free plan is refunded by the software itself; if the provider is down the refund is retried on the timer for as long as it takes and a person is told when it keeps failing. Cancelling while a payment is failing, or in the hour before a new month's payment is taken, ends the plan the same day and withdraws that payment. Cancelling on the provider's own page gets the same reference and email. If one of the provider's messages is lost, the timer reads the real state back. A card dispute stops all billing, takes the unused signatures of that payment back with the money, and small ones are not contested. |
| There is no cancel button. | One button on the Plan page. A stop link in every email about a payment while a plan renews, which works without logging in (`/billing/stop`) and dies when that admin leaves the team. On `/help`: find every paid plan by email, or stop billing with the card alone (last four digits plus the account email, or plus the date and amount of a charge). |
| Refunds are refused or left to someone's discretion. | One rule, applied by the software and written once (`refundRuleText` in `src/lib/policy.ts`): within `REFUND_DAYS` of a payment, every signature from it that has not been used is refunded at the price paid, for any payment in the window, not only the latest. No form and no approval. Two requests at the same moment pay out once. |
| "I paid and nothing happened." | The plan and its signatures are there the moment checkout finishes, whichever of the provider's messages arrives first, and the page only says thank you for a payment that really arrived. A payment that cannot be matched to an account is flagged to a person at once. |
| Bills for going over the limit. Documents that count even when nobody signed. | People pay for signatures, and one is used only when somebody actually signs. Sending holds one per signer. Voiding, declining and expiring give it back, unless that signature's own date passed while it was held: then it is gone instead of coming back (a held one never expires while it is held). Running out pauses sending and never creates a charge. |
| Prepaid allowance disappears at renewal. | It does here too, and we say so: since 2026-11-20 a month's 9 signatures belong to that month and the unused ones expire at the renewal (or at the end of the paid month after cancelling), top-ups 12 months after their payment, and the 3 free ones 30 days after the account was made (`expiryRuleText` in `src/lib/policy.ts`). To be fair about it: the date and time is shown everywhere signatures are counted (the Plan page says "6 of 9 left, they reset on 3 December 2026 at 14:00 UTC" and lists each top-up with its own date, and every receipt and renewal reminder says how many will expire and when); the one that expires soonest is always used first, so nobody loses one that could have been used; a signature held for an envelope that is out does not expire while it is held; top-ups get an email 30 days and 3 days before they expire, if any are unused; someone who then has too few to send with is told in that same message how many expired and when; and the trees are planted from the money either way, used or not. On the Plan page the dates stay in sight and the long rules sit closed under "How signatures work"; the count is also under the account name and on Home, and whoever sees 0 there reads how many expired and when. A held signature is for the person and the documents that were sent: putting another person in, or other documents, after its date takes one of that day's (and is refused in plain words when there is none), so a month cannot be kept by parking it on placeholder envelopes. In the hour or so between the end of a month and the renewal payment arriving, the page and the "too few" message say that the new 9 are on their way. |
| The price went up and nobody said so. | One rule, written once (`priceRuleText` in `src/lib/policy.ts`) and enforced by the server: an account stays on the monthly price it has been paying until every owner and admin has been emailed the new price at least 30 days before the day it starts, with a link that stops the plan. A renewal that charges more without that notice has the difference refunded automatically, the customer still gets the full month, and the operator is told (a week ahead if the provider already shows the higher amount). The operator announces a price on `/app/operator`. |
| "I updated my card and the plan is still on hold." | A plan the provider has stopped retrying says so, and offers "Pay the open payment", which opens the provider's page for exactly that invoice. If it was paid in the meantime the plan is read back instead of offering the payment again. |
| Paying for a plan nobody uses. | A nudge after 60 quiet days. After `DORMANT_AUTO_STOP_DAYS` without a send, the renewal is stopped before the next charge and the owner is told. |
| Support is a chatbot loop, and closed to anyone who cannot log in. | An AI helper answers at once, on the public pages, in the app and from Other actions on the signing page, signed in or not, and a person is always one click away: "Talk to a person" is under every answer and opens the contact form with the chat attached (the writer sees it and can take it off). The helper offers a person by itself for money taken or owed, "I did not sign this", a security problem, a lockout, anything legal (whether to sign included), an upset person and a second answer that did not help (the server reads the words in English and the common ones in five other languages; beyond those it relies on the model, which is told the same). It answers from the same rules the pages print, says it is an AI and can be wrong, gives no legal advice, takes no action and points to the tools that do (see "The help chat"). Without a model set up, or past a limit, the built-in answers reply instead and say so; they name the control on the screen the person is on, so a signer who types "I cannot sign this today" is pointed to Finish later and Ask for more time in Other actions instead of being told nothing was found. `/help` works without an account: self-service tools, then a contact form that returns a reference and goes to a queue people work from (`/app/operator`, and `SUPPORT_EMAIL` if set). The reference is eight characters nobody can misread. The Help link on the signing screen and in every signing email carries that email's security code (never the signing link itself), so the form shows the signer which document their message is about before they send it, the people who answer see it, and its sender, who can usually fix it at once, is told that the signer needs help. Someone who arrives another way can type the code. The words of the message only go to the sender when the writer is signed in under the confirmed address they wrote from; otherwise the sender only learns that the person needs help. Help is one click away from the sign-in forms, the public form page and the editor. |
| No answer, no reference, nobody owns the problem, and the ticket is closed without a word. | Every help request is a ticket (see "How support works" below): a reference, a state the customer can see, one operator who has it and whose first name the customer is shown, and a thread. A response time is published (`SUPPORT_FIRST_REPLY_HOURS`, `SUPPORT_URGENT_REPLY_HOURS`), and the confirmation says the actual time a person will have answered by. When that time passes the request says "We are late with this. Sorry.", everyone who answers is emailed, and so is the customer. Every answer is emailed in full, with a private link that opens the request without a login, because the people who need help most are locked out. Nobody closes a request without a written answer, and a reply opens it again. A stranger who types your address into the form can send you at most three emails a day that way and can never use up what you can send us yourself. When the mail server refuses an answer, the person who wrote it is told at once, and again if it is given up, so nobody believes an answer arrived that did not. |
| A typo after sending means void and start again. | An envelope that is out can be corrected in place: names, addresses, fields, people. Signatures already collected stay. Once someone has finished, the pages they signed only change if the sender chooses to ask them to sign again. That covers the files, the fields, the sender's wording and any name or address a field prints on the pages, by every route: the editor, the API, the quick correction, a signer passing the document on or fixing their name. They are told what changed, the first signature stays on record together with the document as they signed it, and it costs no extra signature. What a finished signer left empty or unticked is their answer and is never filled in again. A signer whose page is open during a correction cannot finish on the old version: the page loads the changed document again, and Finish stays off until its pages are on the screen. A change made outside the editor (a quick correction, a hand-over, sending) is a newer version too, so an editor that was opened before it cannot undo it. The audit trail says what every correction changed. |
| Two people share one email address, and one person's signature ended up on the other's line. | A signature, initials, typed answers and the agreement to sign electronically belong to the person who made them. When the sender puts another person's name on a request at the same address (with Correct or in the editor), the request starts empty for that person on the same link, and they agree for themselves. A spelling fix of the same person keeps everything. "Fix my name" takes only a spelling of the name the sender wrote: never one that is, looks like (letters of another alphabet that look Latin, one letter off) or borrows from another person's on the document, and never a name that would turn the sender's own free signature into somebody else's. A browser tab keeps a signature only under the name it was made for. |
| A Word file has to be exported to PDF first, or comes out different after the upload converted it, and nobody noticed before it was signed. | On a server with a converter, Word, Excel, PowerPoint and similar files are taken and turned into a PDF at upload, and the sender sees that PDF before placing a field, with one line under it, "Converted from Contract.docx. Check every page before you send: the PDF is what people sign, and text can move.", and a word about tracked changes, comments, split sheets, outside pictures and macros where the file has them (the most urgent shown, the rest folded). Without a converter the refusal is one sentence: "This is a Word file. Save it as a PDF and add it again." The audit trail names the original by its SHA-256 and the tool, and the evidence pack keeps the original. Nothing says the layout is the same. |
| Signing links expire or stop after a few opens. | A link works for as long as the envelope is open, with no limit on opens. A replaced link offers to send the current one. `/help` emails anyone their documents again. An expired envelope is reopened, not rebuilt, and signers can ask for more time. |
| Signers are pushed to create an account. | Signers never need an account or a password, and are never sent marketing. |
| A signer has no way to ask about a clause before signing, and the answer is lost somewhere in email. | "Questions and comments" next to the document: a question goes to the sender's side (the sender and the admins of their account) privately unless the signer chooses everyone, the sender answers on the envelope page, and the answer is on the signing page and in one email when we can email that person (not someone signing in person, without an address, or whose address bounced or marked us as spam, and the page says so). Nobody else on the envelope ever reads a private thread, also not the next person handed the same device to sign in person. The sender sees who waits for an answer, and someone who presses Finish with a question unanswered is told so and can still finish. Comments are not part of what is signed, and the audit trail records who wrote and when, never the words. |
| The text message code never arrives, my number is refused, and only the sender can change the check. | A sender can ask for a one-time code by email, or by text message to a mobile number they type where the operator has switched texts on. A number is checked for its country code when the sender types it, with one rule for every screen and the API, so a number that cannot be texted is caught before anything is sent. The code screen shows where the code went (masked) and when a new one can be asked for, and offers "I do not get the code" and "This is not my number": both reach the sender at once, whatever their email settings, and tell the signer honestly that only the sender can fix it. After "not my number" no more codes or links go to that number from that sender, on any envelope. A text the provider would not take is tried again like an email, decided again at that moment (a corrected number, a decline, the pause), and the sender is told when it never goes through. Limits on codes are counted per sender, so nobody can lock a person out of another sender's documents, and a whole office behind one internet connection gets its codes. Texts are not charged to customers. See "Checking who signs". |
| "I cannot tell a real request from a scam." | Every signing email names the sender and carries a security code that anyone can type into `/check`. Senders must confirm their email, and the confirmation link only works together with the login's session or password, so nobody confirms a login that a stranger made in their name. Until an account has a payment that is 14 days old and was not refunded or disputed (`PAID_TRUST_DAYS` in `src/lib/policy.ts`), or a person has cleared it, it has a daily limit on how many people it newly emails, however it reaches them, and cannot send what reads like a fake payment notice or send or invite under the name of a well-known brand. A public form named like such a notice is refused, because its page would print it on our address to anyone with the link. Paying does not switch that off at once. Recipients can report a request from the email itself or from the signing page, also after the sender has deleted the document, and enough reports pause the sender until a person has looked. The filter (`src/server/fakenotice.ts`) catches the common trick in the spellings the tests list, not every scam: a notice worded another way, or a brand that is not on its list, passes. Reports and the pause are the backstop. A click-to-agree page is read the same way, every word it shows (the box, the button, the notes of what changed, the name a website signs into its link), and a copy of an acceptance is emailed only to an address the website vouched for, once, so a stranger cannot make us write to anyone. |
| "They say they never got the email." | The envelope shows whether each email left, and the audit trail only says "Sent to recipient" when the mail server took it. An email it would not take is tried again by the timer for about a day and a half, and the sender is told when that fails for good. The sender is told when a request sits unopened, and can copy the signing link, remind one person or correct the address. |
| An email bounced and nobody said so: reminders kept going to a dead address, and the sender found out weeks later. | On a server connected to its mail provider (`MAIL_EVENTS_TOKEN`), an email that comes back for good tells the sender at once, says "Could not be delivered" with the reason in plain words on the envelope and in the list, and stops reminders to that address until the sender corrects it or chooses "Try again". For 30 days a new envelope to the same address warns first and goes out when the sender says so. Someone who marks our email as spam is not emailed by that account again, also after a correction away and back or on a new envelope, unless they ask on a signing page with a code we email them (the sender holds the link, so the link alone is not enough), and it counts as a report like the "Report this email" link, also after the sender deleted the envelope. That holds for each member of a signing group by themselves: no reminder, notice or copy goes to that member, the sender is told it was a member of the group and that the others are not affected, and the member who took a document on and bounced is never told to use a Correct that groups do not have. News that names no email of ours, or only an address that two senders wrote to, touches nobody. What a recipient's mail server wrote is never shown or emailed to a customer, only our own words for it. When our own emails to a customer come back, every page of the app says so, with a way to move the login to another address. "Delivered" only ever means that their mail server took it. |
| The account was locked with our contracts in it. | Cancelling, a failed payment or a pause never deletes or locks a document. Pausing stops what a sender starts from being emailed (new sends, new or changed recipients, reminders, reopening, team invitations, notices about a change, and people further down a signing order wait until it is lifted). People who already have a document can still sign it and are sent their copy, a document that is out can be given more time, and it can be voided (the people on it are told, without the reason). |
| There is no way to get everything out. | One free export of every signed PDF, audit trail and a CSV index, on every plan, also after cancelling ("Download signed PDFs (ZIP)" on Documents, `GET /api/export`). Owners and admins also get everything as data in a published, versioned format (Settings, Records and data, Export everything): templates, contacts, groups, settings, every history with its chain values, evidence packs and files by SHA-256, emailed as a link when it is large. Another GrowSigning server, and an archive of DocuSign downloads, can be brought in under the same card, each record marked with where it was signed. |
| The account belonged to someone who left. | Ownership can be handed over by the owner. When a member is removed, what they sent (envelopes, drafts, templates and bulk sends) passes to a member the admin chooses, and each envelope's audit trail says who handed it to whom. Nobody can remove themselves and stay the sender. The person removed keeps their login: signing in gives them a workspace of their own, and they can be invited again. A paid or shared workspace with one admin shows a prompt on the home page to add a second. Billing can be stopped with the card, without the mailbox. |
| Signers cannot get their copy later. | The completion email links to the signed document and attaches it when small enough, and two people who share an address each get their own. `/help` sends it again for as long as the sender keeps the account, also for a document someone has signed while others have not, and says whose link is whose at a shared address. Someone who signed an envelope that was later voided, declined or expired can still download what they signed: that copy opens with a page saying it was not completed by everyone, and why. A sender who deletes a completed envelope only takes it out of their own lists, search, export and reports: every recipient's link, download and list of documents sent to them keep working. The account is a party too: its admins still find it under Envelopes, "Removed by its sender", and can put it back. |
| The API costs extra and needs a go-live review. | The API is the same on every plan, and a key works as soon as it is created. Errors say what to do and carry a request id. Retries are safe with an `Idempotency-Key`. A request that cannot be carried out as it is written is refused with the part named, never half done or guessed at: "false" in quotes is not taken for yes, and a field placed at "left" is not put in the corner. |
| Integrations break without anyone noticing. | Every webhook delivery is in the log from before the first try, and the latest 200 of each webhook can be sent again. After three failures in a row the admins get an email. Removing a team member lists the API keys that stop with them and emails the admins. A member who closes their own login is shown the same list first, and the admins get the same email. Stopped keys stay on the admins' list. A key that cannot be used says why. |
| You cannot get off a team without asking someone. | "Leave this team" on the Team tab, for every member and admin: no permission needed. What they sent passes to the member they choose (the owner by default) with a line in each audit trail, their API keys stop and the admins are told which, and they stay signed in, in another workspace of theirs or a new one of their own. The owner hands the account over first. Someone an admin removes is told by email what happened to their work and that their login stays. |
| A real email is called fake once the sender has deleted the document. | The check page keeps a fingerprint of each security code for a year after a document is deleted: no name, no address, no title. Whoever still holds that email learns that it was real and that the document is gone, instead of "treat it as fake". |
| A front-desk tablet locks itself out of its own form. | A public form can be marked as used on a shared device: 30 unfinished starts at a time and 120 starts an hour from one address (ordinary forms: 3 at a time, 20 an hour), an abandoned start is cleared after an hour instead of a day, typing counts as being there, and whoever finishes is offered a clean form for the next person. That button replaces the page, so Back brings up nothing of the person before, and the form does not offer their name or address to the next one. Whoever returns to a cleared start is offered a fresh form, and the owner gets no "deadline passed" email about it. Every limit says what it is and how long to wait. A form of an account that is closing says so before anyone types into it. |
| Someone deleted their login and another customer's emails vanished with it. | Deleting a login removes only our copies of emails sent to its own address and those marked as being about it when they were sent. Never one where a stranger typed that name or address, and never one still waiting to be delivered. |
| A team was left with no owner after two clicks at the same moment. | Leaving a team and handing it over are decided inside one transaction from the rows as they are then: an account always has exactly one owner, envelopes only ever pass to someone still on the team, and pressing Leave twice sends one email. |
| Closing an account by mistake loses everything. | Closing keeps everything for 30 days, and signing in again undoes it. A week before the end the owner is emailed the date, how to keep the account and how to export first. While it is closing nothing new starts in it: nothing is sent, nobody is invited or joins, its keys are off. |
| "Deleted" does not mean deleted. | When an account is deleted, at once or after the 30 days, its envelopes go with their audit trails, our stored copies of their emails, the files signers attached, replaced links, reports, webhook logs and batch records, and the files come off the disk. What stays is listed on `/security`, `/help` and in Settings from one list (`KEPT_AFTER_DELETION` in `src/lib/policy.ts`): payments, refunds and the signature ledger without names, a help request that is still open until it is answered, and what belongs to other people. |
| I have to keep contracts for exactly as long as the law says and no longer, and the e-signature tool either keeps everything for ever or deletes the evidence with nobody told. | The card "Keep and delete" under Settings, Records and data, off by default: two lines, "Delete completed documents after [ ] days" and "Delete cancelled, declined and expired ones after [ ] days" (30 to 9,999, counted from the day each ended; a template can have its own period), and at the end either delete the files or also remove names and answers and keep the record. The sender and the admins get one email at least 14 days before, at most one a week, with a Keep link on each row; keeping asks for a reason, which goes into the history. An admin can put a document or a folder on hold: the software then refuses to delete it and records each attempt. Settings, the document page and `/security/processing` say what stays, and the email says it in one sentence: the record with its fingerprint, copies people already have, and backups until the operator's cycle ends. Never "deleted everywhere". |
| Our records office has to file every email we send about a document, and the only way was a hidden copy that carried a working signing link into a shared mailbox. | Under Settings, Records and data, "Copies of every email", an admin names up to 5 addresses. Each one is asked by email and gets nothing until someone with that inbox confirms. Then every email the account sends about its documents also goes there as an email of its own, with the same attachments, and with every signing link and code replaced by words such as "(link removed in this copy)", so nobody can open or sign a document from the archive. Three copies that come back pause an address, and the admins are told (`tests/archivemail.test.ts`). |
| The signing screen says an electronic signature equals a handwritten one, and where I live it does not. | The signer ticks one sentence, "I agree to sign this document electronically." The link under Continue, "How electronic signing works", says what this is: a simple electronic signature, with rules that differ by country and by kind of document, some of which need a handwritten, witnessed, notarised or qualified signature, and it tells the signer to ask the sender or a lawyer when unsure. Nothing says that such a signature equals a handwritten one, on the consent screen or next to "Sign" in the signature dialog. The signer also accepts the electronic method as the way the parties sign. The wording has a version that covers the sentence and what the link opens, the audit trail records which version each person agreed to, and `/help` prints the words of every version. The wording shown before versions were recorded is kept word for word (`UNVERSIONED_CONSENT`), so the evidence pack prints for such a person what they saw, marked as inferred, never today's words. Research: `research/gaps-partial.json`, "map:nonus". |
| Nothing warned me that this kind of document cannot be signed electronically in my country. | A check before sending reads the subject, the document names and the text of the documents for words that usually mean a will, a trust deed, a power of attorney, a sale of land or a long lease, a fixed-term employment contract or a notice of termination, or a deed that needs a witness or a notary (one list, `src/lib/paperwork.ts`, in English, German, Spanish, Portuguese and French). Document names are read the way file names are written ("Power_of_Attorney.pdf", "PowerOfAttorney.pdf"), and German typed without umlauts ("Kuendigung") is found too. The review step of the editor names the word and where it stands, the API answers sending with the same list as `warnings`, and the audit trail records it. It warns and never blocks. `/help` has one section with the documents not to sign here and short notes by country, each with the month it was looked at and its source, and says that none of it is legal advice. A sender whose clock is set to India or Indonesia is told that signing does not pay stamp duty. |
| A deed needs a witness who was in the room, and the e-signature tool had nowhere to put one: a witness added as a second signer used a paid signature and recorded nothing about being there. | A recipient can be a witness for one person who signs. They are asked straight after that person has signed, whatever the signing order says, never use a signature, and fill in a block the sender places next to that signature (signature, name, address, occupation, date). The sender names the witness, or the signer does on their review screen, next to one paragraph on who may witness. The witness's first screen is their own statement, "I was physically present and saw Ann Lee sign this document on 20 November 2026", to tick before they can sign, or "I was not there", which tells the sender, and the signer when we can email them (never with what the witness wrote), and lets the signer name the person who was. The certificate lists the witness under the signer with the statement and its time, and marks a witness at the signer's email address, under the signer's name at another address, or in the browser the signer signed in, which the sender is told about. For the device the sender only ever sees "same device: yes or no", with what that can show: the browser cookie behind it is fingerprinted per envelope and never leaves the server. A statement belongs to one signature: when that signature is set aside (sign again, or the place goes to another person) or the witness is moved, the statement is set aside too, written to the audit trail, and the witness is asked again. A witness cannot be the signer, a party, or someone with a party's fields, whether by sending, Correct, an API key or a signer passing the document on. Every screen and the help page say that GrowSigning records what the witness states, cannot check that they were in the room, and that whether a document witnessed this way is accepted depends on the law that applies: for a deed, check first. Some documents need two witnesses: a signer can have one or two, each asked at once, each with their own statement, both on the certificate, never one person twice. Rules and words in `src/lib/witness.ts`, the server side in `src/server/witness.ts`. Research: `research/gaps.json`, "map:nonus". |
| The price said $9 and I could not tell in which dollars. | Every price on a public page is written as US$, with one line: prices and payments are in US dollars, and a bank may add a fee for converting. |
| I cannot find out where my documents are stored or who else handles them. | `/security` has a block "Where your data is", filled from settings (`OPERATOR_NAME`, `DATA_REGION`, `DATA_HOST`, `DATA_BACKUPS` and the provider settings): where the server is, who else handles data, in which country and what for. A provider is listed only when its switch is on, and whatever the operator has not stated is printed as "has not said ... Ask them." instead of being left out. `/security/processing` is a plain data processing summary to save as a PDF, and says that a signed agreement is between the customer and whoever runs the server. |
| My signer cannot open the page where they are, and nobody says what to do. | Every email that asks someone to sign ends with one line: reply and ask the sender for the document as a PDF. `/help` tells the sender what to do then, and that a signature collected that way is outside the certificate. No claim is made about any country, because none was tested. |
| My signers live in WhatsApp, not email, and a recipient cannot exist without an address. | Tick "I will send the link myself": a name and no address. We never write to that person, the envelope page hands the sender the link and the ways to share it, the sender gets the turn, the reminders and the copy in their place, and the certificate says "Link shared by the sender" instead of claiming an email went out. They count towards the limits like anyone. Their own page never promises them an email: asking for more time says the sender will reach them the way they sent the link, and the sender's email says there is no address to reply to. |
| My signers do not read English and nobody told me. | `/features`, `/help`, `/security` and this file say it in one sentence (`LANGUAGE_NOTE`): the signing screen and the emails are in English for now, and the document can be in any language. `/help` prints the consent text so a sender can translate it. The foundation for other languages is built (catalogues, a language per recipient, legal texts in English until a person has checked a translation, the language each person agreed in on the audit line), and no screen is translated yet. The signing page is being moved into the catalogue: it sets its language and direction, mirrors for right-to-left languages without turning the document around, gets a language menu once a second language is switched on, and the certificate names the language of each person's page and consent. The request, its reminders, the one-time code and the texts can follow the same language, with the sender's own words untouched and set apart as theirs, and a text in another script is counted in the parts a provider bills. Recipients' emails switch language only once every one of them, and the pages they link to, is translated (`mail: true`), which none is yet, so a signer never gets the request in one language and the completed copy in another. A sender's own Home, menu and the emails we send them (declined, completed, comments and the like) follow the language they choose under Settings, Profile, once a second language ships, and so do most of Settings' cards, the stamp screens, Templates, Send to many, Forms, Contacts, Reports and To sign; the sign-in forms, the home page and `/impact` follow the visitor's browser. The editor, the document page and the Settings page itself are not translated yet. |
| A name in Chinese, Thai or Hindi comes out as empty boxes on the signed document. | The signed PDF and its certificate print Latin (with accents), Greek, Cyrillic, Arabic, Hebrew, Armenian, Georgian, Chinese, Japanese, Korean, Thai, Devanagari (Hindi, Marathi, Nepali) and Khmer, with the letters joined and stacked as the script needs, and only the font files a document uses are embedded in it. For any other script (Tamil or Bengali, say) nothing is printed as an empty box: the sender is told on the envelope page and before sending, the signer in the check before finishing, each such character is printed as the mark �, and the certificate lists them by Unicode number. A font file that is missing after a broken install counts the same way instead of failing the PDF. A typed signature shows four handwriting styles only when the handwriting fonts can write the name, and one plain style otherwise. |
| Hebrew or Arabic typed into a field is reversed, and house number 42 becomes 24. | Right-to-left text is put in reading order on the signed PDF and the certificate, with digits and Latin words inside it left to right, and it starts at the right edge of its box. The fields on the signing page take their direction from what is typed. The words as typed are also written into the PDF next to the glyphs, for programs that copy or search. |
| The dates on my document are in American order, and one page shows two formats. | One format for every date on an envelope: the date each person signs on, and any date they pick in a date field, on the signing page, in what other signers are shown and on the PDF. A new envelope starts with 20 Nov 2026 (D MMM YYYY), and an account can set another format for its new envelopes (Settings, Sending); the formats with the month as a word are listed first. Nothing is ever converted to month-first unless the sender chose that. |
| The signing date is a day off from my own calendar, and no time zone is given. | The date of signing is the calendar day where the signer is, by the time zone their device reports with consent and with Finish (falling back to the sender's zone, then UTC). The zone is written to the audit trail, and the certificate prints the signer's local time with its zone next to UTC for each of their steps. A signed PDF is built once and never changes afterwards. A zone belongs to its person: after a hand-over, a correction to someone else or a hand-back to a group, the new person starts without one. The audit trail names it the first time and once more at Finish if it changed, so nobody holding a link can fill the certificate with zone lines. A zone named after an offset (Etc/GMT-14) is printed as its offset (UTC+14:00). |
| The email said the 20th, the page said the 21st, and it closed at 9:40 in the morning. | A deadline is a moment, and it is always given with its time and its zone: in emails in UTC ("closes on 20 March 2027 at 16:40 UTC") and in the reader's own zone as well once we know it (a signer's from their device, a sender's from the app), on the signing page and the sender's pages (also when giving more time) in the reader's local time with the zone named. |
| Reminders arrive at one in the morning. | Once a signer's time zone is known, automatic reminders keep to their daytime, 8:00 to 20:00 there. One that falls in their night waits for the morning, and the audit trail says so. Without a known zone it goes out at about the hour the envelope was sent, as before. A reminder the sender sends by hand always goes at once. One that waits is dropped if the sender turns reminders off before morning. |
| An amount written 1.234,56 is refused. | A number field takes numbers the way people write them: 1.234,56, 1 234,56, 1'234.56, Indian grouping (1,23,456), a currency sign before or after. The signing page and the server check with one rule (`src/lib/numbers.ts`), and what was typed is printed exactly as typed. |
| The security page said only the right people can open a document, and nothing about who else can. | `/security` has a block "Who can see your documents", from one list (`WHO_CAN_SEE` in `src/lib/policy.ts`): whoever holds a signing link (which is why access codes and one-time codes exist), the sender, the owner and admins of the account, the people who run the server (exactly what their queue shows, no document; and that the disk is another matter, under a rule the software cannot enforce), the companies that carry it, and nobody else. |
| Public forms sold for consent forms, and no word that there is no health information agreement. | One statement (`NO_BAA_TEXT` in `src/lib/policy.ts`) on `/security`, under the pricing rules and on `/help`: there is no HIPAA business associate agreement at any price, so a US healthcare provider must not put patient information through it, and what would have to exist first. There is deliberately no click-through agreement. |
| Bulk send "on every plan", and the price only showed up after the Send button. | The bulk page shows what a batch holds, what you have, what is missing and what that costs before the Send button, from the count the send is held to (`POST /api/bulk/check`), and `/features` and `/pricing` say the cost next to the feature. |
| Everything was filled in, nobody pressed Finish, and the deal waited for days. | Once nothing required is left the main button turns into Finish, asks to be pressed once, and signs without a second step (no dialog opens by itself). The sender's envelope page says "filled in everything but has not pressed Finish", and the reminder to that person says one button is left. New accounts remind every 3 days by default, shown before every send. |
| Fifty waiver templates and no way to find the right one. | The templates page has a search over every word of the name, roles, folder and the document itself, a folder filter, and Move, like the envelope list. |
| Admin or nothing: to let our office manager run the team we had to let her see every contract and the billing too. | Besides Owner, Admin and Member, which work exactly as before, an admin can make a role under Settings, Team, More options, "What each role can do": it starts from Admin or Member and leaves out what it should not do (sixteen plain things, such as "See every document", "Send to many" or "Account settings"; the full export needs "See every document" too). The plan and payments never go with a made role. Nobody can give a role (also through a group), change a role, or change a person, that can do more than they can themselves, an API key never does what its maker's role leaves out, and every change is in the security record. Groups of members can be chosen as a whole for a template, and can give everyone in them a role. |
| Anyone on the team could open our HR letters, and a salesperson sent the contract with the liability clause changed. | Each template says who can use it (everyone, admins only, chosen members) and who can change it, and its wording can be locked: whoever may not change it fills in names, addresses and the empty fields, and the editor shows the rest as locked from the start instead of refusing at the end. A template someone may not use is not in their list, and a refusal names who to ask. A copy is no way round it: a copy of a locked or restricted template stays with its owner, and an envelope from before the lock cannot be copied into an unlocked one. The note and the identity check the template gives a signer stay too. The owner and admins of the account, and the template's own owner, are never locked out. |
| Our onboarding is five templates, so every new volunteer meant five envelopes, and nobody noticed an uploaded contract was just our template again. | One document can start from several templates ("Add another template"), with a role of the same name as one person, so the volunteer gets one email and signs once per file. An upload whose words are close to a template the sender may use gets one line, "This looks like your template ... Use it?", with what differs; nothing is applied without a yes, and a locked template's lock still holds for its own part. |
| To strike a word from a form I had to edit the PDF somewhere else. | A "Strike out" field draws a line through printed wording, the same on the signing screen and in the signed PDF, and counts as wording: once someone has signed, it only changes if they are asked to sign again. |
| A deposit is due at signing, and collecting it needs the top plan or a second tool. | An account that has earned trust can add a link to its own payment page. Each person who signs sees it after Finish, with the name of whoever set it and the full address, and the page says GrowSigning takes no part in the payment and does not check where that page sends them next. The address is never in an email, an attached certificate or an export; shorteners and private-network addresses are refused; the link goes when the person who set it leaves the team. The record says who was shown which address and who pressed it. |
| My name was cut at the first space, and I could not fix how it is written. | One name as written, everywhere: no screen or share text greets anyone by a guessed first name, and a new workspace is named after the whole name. A signer can fix a letter, the spacing, a hyphen or a dot of their own name ("山田 太郎" to "山田太郎"). A name offered in another script (Cyrillic to Latin, kanji to Latin) goes to the sender to confirm, and the signer is told that it may well be the same name, not that it is a different one. |
| My phone photo of a paper page came out sideways in the signed PDF, and the fields were off. | A phone camera writes a note into a JPEG that says which way up it is. The server reads it (`src/server/exif.ts`, no library), puts the picture on a page that suits it the way the note says, and sets the note to "upright", so the page is the same way up in the editor, on the signing page and in the signed PDF, and a field is where it was placed. The test draws the signed PDF with pdf.js and checks the corners for all eight values of the note. |
| I photographed five pages and got five documents, each of them huge. | When several pictures are chosen at once the editor asks whether they are one document, shows them in the order chosen with a way to change it, and joins them into one PDF, a page for each (up to 50). A picture larger than a page needs is made smaller in the browser before it is uploaded (2,000 pixels on the long side). |
| My phone keeps asking me to sign in. | Signing in on another device signs nothing out (unless a team switched on its "One session at a time" rule), and Settings, Security lists every browser that is signed in, with the device, the browser, the last use and the day it is signed out by itself, and has "Sign out everywhere else" (which also ends the other devices' skipping of two-step login). Two rules sign a browser out, whichever comes first: 30 days without use (`SESSION_DAYS`), or 90 days after it signed in, however often it is used (`SESSION_MAX_DAYS`). A phone used every week stays signed in for 12 weeks and then asks once; a copied sign-in that kept being used once a month used to stay alive for ever, and now dies 90 days after the sign-in at the latest. |
| A client of mine was locked out, and was told only their admin could help. | Two-step login (an authenticator app, `src/server/twostep.ts`) comes with ten recovery codes, shown once. Without phone and codes, an owner or admin of the team switches it off under Settings, Team: the person is emailed at once, and their record says who did it. Someone who owns a workspace (whom nobody else may reset) or anyone else resets it by email, after the right password: it takes effect after 7 days, with an email every day that can stop it without signing in and a notice on every page, and a sign-in with a code or a remembered device stops it. A password reset or Google never takes it away, and a stranger who does not know the password cannot pause it. The screen where it is switched on, the sign-in screen and `/help` say all of this before anyone is stuck. |
| At the office the official signed for me and nobody wrote down that I had asked them to. (Assisted signing at a counter.) | At a service counter the official records, with their own login, how they knew who was in front of them and each kind of help: a mark with a witness, someone signing for a person who cannot (only after a second official confirms it with their own login), reading aloud and an interpreter. Each is printed on the certificate as that official's statement, with the line that GrowSigning cannot check an identity document. A counter document opens on no device before the identity check is recorded, and after Finish the link used at the counter stops working. |
| I handed my tablet to a client to sign, and my whole account was a tap away. | Opening the signing page of someone who signs in person locks the host's account in that browser until the host types their password, and the signer's last screen asks them to hand the device back. Five wrong passwords sign that browser out, counted on the server before each password is checked, in one statement, so forty guesses sent at once from the browser's console get five checks, not forty; one address can try 30 times in 15 minutes. What the lock does not cover (the rest of the device, a password the browser offers to fill in, a Google or Microsoft session) is said next to "Host signing now" and on `/security`. |
| I ended up with two accounts and nobody could merge them. | Pressing "Continue with Google" or "Continue with Microsoft" while already signed in never makes a second login on the way. The person is sent to Settings, which says to connect that account to the login they are in, or to sign out first for a separate one, and the sign-in page says who is signed in instead of offering the buttons. A Connect that took too long, or was replaced in another tab, goes back to Settings too. |
| On my phone I never hear that someone signed. | The page after sending has one switch, "Email me each time someone signs". It sets the same preference as the switches under Settings, Profile. |
| The home page says "all you need" and then gives a long list. | The home page says one thing: a signature that is paid for plants 10 mangroves with Treegens. One button (Start free), three short points, and the video of Treegens' AI counting planted seedlings. The top bar has four entries (Pricing, Help, Sign in, Start free). Prices, their rules and the comparison are on `/pricing`, what the product does on `/features`, and checking an email or a signed document, security and the API are in the footer. No total of paper or trees is shown anywhere until it means something (1,000 sheets, 10 trees), so a new server never says 0. |
| I could not find where to change my password. Settings was eight tabs of everything. | Settings has sections named for what they hold: Profile (name, email address, signature, which emails you get), Security (password, ways to sign in, two-step login, where you are signed in, and for admins the security record), Account, Sending (what new documents start with: reminders, deadline, date format, details), Team, Stamps and seals, Plan, Records and data, Developers. An owner or admin sees these nine; a member sees four (Profile, Security, Team, Developers), and a member who follows a link to a section of the admins is told in words whose it is. "Saved" appears next to the button or switch that saved. The long lists (what is kept when an account closes, the plan rules) are closed until someone opens them. Old links to what moved still land on it (`src/lib/settingsnav.ts`). |
| The date on my contract was 2026-03-04. Is that March or April? | A new document writes dates as 20 Nov 2026, with the month as a word, unless the account chose another format under Settings, Sending (year-month-day is still one of the five). Days in sentences on screens and in emails, and the moments on the signing record, are written the same way, with the time in UTC next to them on the record. File names, the API and CSV exports keep 2026-11-20, which sorts. A document made before 21 November 2026 that never chose a format keeps the one it was stamped with. |
| Fields in the editor are too small to grab with a finger. | On a touch screen every field answers a tap over at least 44 by 44 pixels (a tick box is drawn about 9 pixels wide at phone width), so does the resize corner, and every button of the editor on a phone is at least 44 pixels tall. |
| A blind signer hears "Text, required" and cannot know what to type. | The last step before sending lists every field a signer fills in that has no label, says why that matters to someone who uses a screen reader, and opens each one with the cursor in its Label box. It warns and never blocks. |
| A blind signer's screen reader only announced pages, the readable version was behind a hidden link, and a scanned contract had nothing to read at all. | The first thing the keyboard reaches on the document is "Read the document as text instead"; every field says its name, required or optional and its page; a whole document was signed with the keyboard alone. With `OCR_CMD` or `OCRMYPDF_URL`, scanned pages get text read by a machine, always under a warning that it may contain mistakes and that the page is what is signed. `/accessibility` says what works and what does not, dated, "Checked by the authors with axe-core and by hand; not audited.", with a draft report (`tests/ds-a11y.test.ts`). |
| The upload said 25 MB was fine, and my signers' phones sat on a blank page. | A signer's phone downloads the whole file, and we measured how long that takes on a slow mobile connection: about 5.7 seconds a megabyte (`PHONE_SECONDS_PER_MB` in `src/lib/policy.ts`, Chromium at phone size with Chrome's "Slow 4G", not a real phone). The upload box says so next to the limits, and a document of 5 MB or more gets a warning under it and again before sending, with the wait for its size and what to do. On a phone the box says "Tap to choose files or take a photo", not "drop" or "click". |
| The signing page stayed blank on my older iPhone. | The PDF viewer is the legacy build of pdf.js, which runs wherever the app itself runs (iOS 16.4, Chrome 111); the modern build needed iOS 17.4. A browser that still cannot show the document gets a notice in words with three ways on: copy the link into another browser, download the PDF, ask the sender. `/help` lists the browsers and says what was tested. |
| A tap on the screen went onto the contract as my signature. | A drawing whose lines add up to less than a quarter of the width of the box, that fits in 40 by 12 pixels, or that covers nearly half the box is refused in words, with Type offered instead; so is an uploaded picture with no ink or almost nothing but ink (`src/lib/ink.ts`). It judges the size of a mark only, never whether it looks like anyone's signature, and only in the browser. |
| I collect consent in villages with no signal, and the app is useless there. | For someone who signs in person: "Get ready to sign without signal" while you still have signal, a PIN of your own, and the person signs on your device with none. It is kept encrypted, sent when there is signal, and refused (with a plain sentence to the host) if the document changed meanwhile. The certificate says the device's clock time was not checked, and when the server received it (`tests/ds-offline-inperson.test.ts`). |
| "Failed to fetch. Go back, put it right." I had no signal, and nothing to put right. | Finish without a connection says that nothing was signed only when that is known (the device was offline before it was sent, or the server says so); when the answer was lost on the way it asks the server, shows the done screen if it went through, and otherwise says plainly that we cannot tell yet and that nothing typed is lost. A Finish sent again after one that went through is simply done, with no error. A public form that has no signature free says so in its own words (we email the visitor when it can take their signature) instead of "could not reach GrowSigning", and is not sent again every 15 seconds. It says that the answers are safe on the page, keeps the last step open and sends it again by itself when the device is back online (and every 15 seconds while it says it is online). Answers not saved yet are kept in the browser tab too, so a reload does not lose them. Nothing is shown as signed before the server has said so. The landing page, `/help` and the in-person notice say that signing needs a connection to open the document and to finish. |
| A 100 page contract crashed my phone, and Next stopped past the field. | Pages more than three screens away give their picture back and are drawn again when they come near. Measured on 100 pages at 390 by 844 (Chromium, not a real phone): 277 MB of page pictures after scrolling to the end before, 19 MB after. Next jumps to a far field instead of gliding, and checks where it landed when the scrolling stops: from page 1 to a field on page 51 it now lands on screen at the first tap. |
| My scan came out sideways with a blank page in the middle, and the only fix was to edit the PDF somewhere else and start again. | Pages on the file's row in step 1: Turn, Remove and move with the arrows (or the arrow keys, or by dragging with a mouse), with Undo until saved; Escape or a tap outside never drops changes that are not saved. The fields go with their pages and stay on the same words on a turned page. A page with fields is only removed after saying which fields go with it, and the audit trail, and the email to anyone asked to sign again, say what was removed or turned (`tests/ds-page-tools.test.ts`). |
| There is no proper app on my phone, and my photo of the lease went out crooked and grey with the table around it. | Home on a phone offers, on the first three visits, to add GrowSigning to the home screen, and says it is the website saved as an app, not an app store app. On Android a PDF or photos can be shared straight into a new draft. Photos of a page are found, straightened and made readable in the browser before they are uploaded, with Undo cleanup, and the photo before cleanup (made smaller in the browser when it is large) is kept and in the evidence pack (`tests/ds-phone-app.test.ts`). |
| The print is tiny on a phone, and there is no zoom. | 100, 150 and 200 percent under More on the signing page, drawn again at that size at the phone's own density (up to 3, within 6 million points a page), sliding sideways in a strip of their own so the bars stay put. Pinch zoom is never switched off. |
| I put a Note field in a table cell so the signer could type their email there. The signed document just says "Note". | The two kinds were easy to mix up, and a new box started out holding the word "Note". Now the blank a signer types into is called **Fill in** ("They type here") and the sender's own words are **Your text** ("You type, they read"), with that line under the name where the kind is chosen; the stored types are still `text` and `note`. A new "Your text" box starts empty with the cursor in it. An empty one is shown to nobody who signs and is never printed (the server keeps no value for it, also when only spaces were sent), and the last step says so in one line and lists each one with "Write it", "Let them type here" (the same box, in the same place, becomes a Fill in field) and "Remove". Drafts and templates from before this that still held only the starting word "Note" are emptied once when the server starts, so a template used through bulk, a form or the API prints nothing there either; an envelope already sent is left as its signers saw it. A Fill in field shows who types there, and its label is the hint the signer reads in the empty blank ("Type here" when it has none). `src/lib/fieldkinds.ts` section 8, `src/components/editor/NoteCheck.tsx`, `tests/note-text.test.ts`. |
| Two signature boxes on top of each other, and the signer could never finish. | The signing page draws the smaller of two overlapping fields on top, so a tick box inside the end of a text field, as paper forms have it, can be tapped and so can the text field. Sending, correcting, saving a template and making a public form refuse a field of one person that more than 60 percent of is hidden under that person's fields drawn over it, naming the person and the page, in the review step of the editor and on the server (`src/lib/stacked.ts`). A public form made before this rule keeps taking visitors (Easy reading reaches every field) and its owner is emailed what to move, instead of every visitor being told the form cannot take signatures. On an envelope that was out before, Next that keeps coming back to the same field points to Easy reading. |
| I put two fingers on the signature box to zoom, and that zigzag became my signature. | The pad draws with one finger at a time. A second finger that lands while one is drawing takes that line away and says "That was two fingers at once, so it was not kept", and nothing draws until every finger is off. A palm resting next to a pen is ignored (`onePen` in `src/lib/ink.ts`). |
| A 50 megapixel photo sent through the API froze the signer's phone. | The app's editor makes photos smaller before they leave the phone; the server does not. So a JPEG may have up to 13 million pixels (a 12 megapixel phone photo), because every signer's phone unpacks the whole picture to show its page, and a larger one is refused with its size and what to do. The API description says so. |
| On my phone held sideways, or with large text, the Sign button was off the screen. | The end of the signature dialog (a problem, the sentence agreed to, Cancel and Sign) is pinned to its bottom edge. Checked at 390 by 844, 844 by 390, 320 by 568 and 195 by 422 (a phone at 200 percent). Below 300 px the title of the document gets a line of its own and the bar at the bottom stacks. |
| The verify page called a file "authentic" when the sender had signed it for three of the four people. | `/verify` says "Unchanged since signing finished" and that this does not show who was behind each signature. "No match" lists its causes: changed, saved again by a viewer, printed or scanned, deleted long ago, never completed here. |
| The sender closed their account, and my untouched signed copy turned into "no match". | The SHA-256 of each completed signed PDF, its envelope ID and its day stay for a year after the account is deleted, and nothing else. `/verify` then says the file was completed here on that day and deleted since, and that it is disputed while a dispute about it is open. |
| All I have is a printed copy, and nothing to check it against. | The envelope ID at the foot of every page can be looked up on `/verify`: status, day, pages, signers, the fingerprint of the signed file to compare a file with, and whether it is disputed. Never a name or an address. The fingerprint is also in every completion email. |
| Nobody could tell whether the signed copy ever reached the other side, or was opened. | Audit lines for the completed copy handed to the mail server for each person, the first time each opens or downloads it (with internet address and browser), and later visits, once a day at most. |
| The sender's own copy of a voided agreement showed every signature and no sign that it was voided. | That copy, and the signer's, opens with a page that says why it was not completed and carries "VOIDED, NOT A SIGNED DOCUMENT" large across every page, again in small dark rows over the whole page (corners included, and kept by a black-and-white copier), at the top and the bottom, and over every signature. A copy downloaded while the envelope was still out says "NOT COMPLETED YET" the same way, because voiding it later cannot change that file. |
| Someone signed in my name, and there was no way to say so. | "I did not sign this, or this was not me" on the signing page and on `/check`, also after completion, and with the security code of any email we sent that person: also after the sender put another address under their name and signed, or someone passed it on through their link. The envelope is marked as disputed wherever it is shown, the sender is told when and what was written, word for word, the operators are told the same with the internet address and browser (the sender never gets those, and the screen says so before sending), and nothing is deleted: while it is open the sender cannot delete the envelope for good, and deleting the account keeps the envelope ID, the file's fingerprint, the day and the state, with no names, until a person at GrowSigning closes it. The help topic of that name is never passed to the sender, and its answer says exactly what we give out and to whom. |
| Our lawyer told us to keep our own evidence, and all we could download was the PDF. | "Full record for disputes", in More on the document's page: the signed PDF, the certificate alone, the audit trail as text and as data with everything needed to recompute its chain, every email we stored about it with what became of it, and the consent wording each person agreed to. |
| After sending I land on a page with a dozen buttons and a wall of log lines, and cannot tell what to do next. | The document's page has one sentence, one main button for its state and one More; each person has one line; history, files and comments are folded; addresses and fingerprints are in the full record, not on the page. |
| Our security team could not see who signed in or who changed what, and could not feed it to our own systems. | Settings, Security: who signed in or failed to, and who changed logins, the team, keys, webhooks, exports, deletions and settings, with the address and browser, as sentences, with one search box. No password, code or key is written to it. The app never changes a line, and lines are kept `SECURITY_LOG_DAYS`. A download, an API an admin key pages through, an opt-in webhook, and five alerts by email that a person can switch off. It says plainly that nobody watches it: the alerts are emails. |
| Nobody would explain what the lines of the certificate mean. | `/security/certificate` goes through every line: where it comes from, what it shows, what it does not. Dated, to attach to a letter. |
| A field hidden by a rule still blocked Finish as "required", and a total the browser added up could not be trusted. | "Only show when..." and "Calculate from..." on any field, each said back as a sentence ("Shown when 'Has a co-signer' is ticked"). The server works out what is shown and every total again from what is stored, on every save and at Finish: a hidden field is not required, keeps no answer and prints nothing, and a calculated value the browser sends is not taken. A loop is refused with the fields named, empty fields count as 0, dividing by 0 says so on screen, the result keeps the way its numbers are written (1.234,50) and is kept as a plain number too, so a total of 1,233 is never read back as 1233, and a changed rule needs the sign-again choice once someone has finished (`src/lib/logic.ts`, `src/server/logic.ts`). |
| A manager who only needed to sign big orders was emailed every one, and routing rules were hard to read and showed skipped people as if they had signed. | "Only when..." in a person's More, said back as a sentence ("Only when Amount is more than 1000"), decided by the server from the stored answers. Someone whose rule is not met is not emailed (someone asked before a correction is told they are no longer needed), gets no link, and their held signature goes back; the record and the signing record say "Not asked: Max Manager, because Amount was 800 (rule: more than 1000)." (`src/server/routing.ts`). |
| A signer saw one total and another was signed under their name, because a co-signer finished in between. | Finish carries a key for the other people's answers the screen counted. If someone finished since, nothing is signed: the page says who finished, shows the new total and any field that comes with it, and the person finishes after looking (`formulaInputs` in `src/server/logic.ts`). |
| Sending one document means wading through options most people never need, and the same question asked twice. | The editor has three steps and each asks only what a first send needs (research/ux-charter.md, measured by `tests/ux/flows.cjs`). Step 1, "Files and people", opens with one empty person row: a name and an email. The role, how they get it, the check, how they sign and a private note are one line each in that person's More, each showing what it is set to. Step 2 shows six kinds of field, with every other kind behind "More fields", and a field's panel shows who it is for, Required and Label. Step 3 has the subject and message, and one More options with reminders (asked once), the deadline and the date format. A first send went from 19 actions over 10 screens and 193 choices on the way to 18 actions over 8 screens and about 125. Nothing was taken away: it moved behind a More. |
| "Plants a tree with every signature" turned out to mean nothing I could check, and the same line was shown for documents nobody paid for. | "10 mangroves" is said only where a signature was paid for: next to Finish, in the email that asks someone to sign, on the finished screen and on the signing record. A person who signs with a free signature is told nothing about planting; the signing record then says only that GrowSigning gives what it earns from its plans to planting mangroves with Treegens, and a server that takes no payments does not say even that. Nothing says trees are planted already: a signature "plants", mangroves "are being planted". Paper and water are called estimates, with their sources and the working on `/impact`, which also says that no receipts for the money sent to Treegens are published yet, and what is not claimed: no offset. Totals are hidden until they mean something, and no share of a tree is shown. |
| Our security team asked where the data goes, what the server talks to, how we back it up and who to report a hole to, and the vendor sent a brochure. | You can run it yourself: one container, one volume, in your own country. `/security` lists every outside service with the hosts, from the settings the server runs on, and `OUTSIDE_CALLS=none` switches all but your mail relay off. `/api/health` for your monitor, a backup and restore pair that checks every file and every audit chain and never holds a key, `/.well-known/security.txt` from your own contact, a bill of materials at `/security/sbom.json`, and two documents for the security team that say "a self-assessment by the authors, not audited, not certified" at the top. For procurement, `/procurement` has a dated whitepaper, data processing terms as a template for a lawyer with the code behind each clause, an exit plan and an incident response document, each saying first what it is not, and `/security/subprocessors` lists only the providers this server has switched on. |
| Years later the PDF reader says the signature on our contract cannot be checked, because its certificate expired. | On a server with a time-stamp service, the signed PDF also carries, from the moment it is completed, what a reader needs to check the server's seal after its certificate has expired: the answers of the places each certificate names to check it, and a time stamp over the whole file. When one of those places does not answer within 20 seconds, the file goes out without them, and the page of the document says so. The record's last value at completion is time-stamped too, so a rewrite of the history up to completion shows against a value the service signed, not us, when that time stamp is checked with OpenSSL against the service's own root (the page's own check can be fooled by whoever runs the database unless `TSA_TRUST` is set). Not yet tried in Acrobat or the EU DSS validator (`src/server/ltv.ts`, `src/server/auditstamp.ts`). We do not call either qualified. |
| My clients live in WhatsApp and never open email, and my grandmother cannot read a text with a code. | Where the operator set it up, a sender can also send the link by WhatsApp, only after ticking that the person agreed (in the audit trail), never together with the text link and never for a group, a copy or a public form. Every message names the sender and says to reply STOP, and STOP stops WhatsApp to that number from the account whose message it answers, not from anyone else. Another person or another number ends WhatsApp, also when a signer passes the document on, so the certificate never names a message that went to someone else. Where it is set up, "How they get it" is one list: Email, Email and a text message, Email and WhatsApp, I will send the link myself. The sender reads "Sent" and "Delivered to the phone", never "read". The finished document goes as a link, never as a file. "Call me with the code" reads a code by text message out on a call instead, slowly and twice, with the same tries and limits (`tests/ds-channels.test.ts`). |
| Embedded signing broke in ways nobody could diagnose: the frame stayed over our app after Agree, and the event that says signing ended never fired. | The page tells the website around it `signing_complete`, `declined` or `saved` the moment it happens, with `postMessage` to that website alone, and the sender screen goes back to your `return_url` when it is sent or closed. A signing link is shown inside another website only when an admin listed that website and the link was asked for it; every other page can only be shown by our own pages, never by any site. The record names the website the page was signed on. An anchor or tag that is not found is named in the answer with the reason, and a document with one missing is never sent (`tests/ds-dev-api.test.ts`). |
| I could not see what my signer would see before sending, so I sent it, then had them screenshot it, or voided and resent after they found a field in the wrong place. | Step 3 of the editor has one link, "See what each person sees": the signing page as that person gets it, in a new tab, with a band to switch person and to say that nothing there is recorded or sent. Nothing is: no audit line, no view, no consent, no email, and not one row of the database changes (`tests/ds-preview.test.ts`). The link lasts 15 minutes and opens only in the browser that made it (a link made with an API key: in any browser of the key's maker). |
| A volunteer on a phone has to pinch and zoom to find twenty little boxes on a form, and a half-filled form vanished when the page reloaded. | A form whose signer fills in fields asks them as questions, one at a time, with the checks and conditions the sender set, keeps the answers for that browser for a day, then shows the whole document with exactly the answers that will be signed in it before anything is made or any signature used; a field with no label is never turned into a meaningless question (`tests/ds-web-forms.test.ts`). |
| Some of the people I send to cannot sign on a screen, and the only way out was to decline and start again on paper. | Where an admin switches on "People may sign on paper" (off by default, nothing changes without it), a signer can print the document from their own link, sign it by hand and send photos back through the same page; the sender looks at the scan and accepts it as signed by that person or asks again with a reason that is emailed and shown where they land. The print has their places marked and a code on every page, and no signing link. A scan stays with the person who sent it: a correction to someone else sets it aside, and signing again after a change needs a new signature. The signed PDF carries the scan after a page that says so, and nothing calls it an electronic signature or checks the handwriting (`tests/ds-paper.test.ts`). |

## What is in it

**Sending**
- The editor has three steps: "Files and people", "Fields", "Review and send". Step 1 opens with one empty person row
  (a name and an email); a row nobody typed into is not saved, sent or counted. Everything else about a person is
  in their More, one line for each choice with its value: Role (Needs to sign, Needs to approve, Gets a copy, Must
  open it, Is a witness), How they get it, Check who signs, How they sign (on screen, or in person with the sender),
  the language when there are two or more, and a private note. A choice with one possible answer is not listed.
  Check who signs is one list (none, an access code, a code by email, or both). Next with no file, or with a file
  and nobody typed in, stays on step 1 and says what is missing where it goes.
  Under "Does not sign" the role list has two more roles (`src/server/agents.ts`, rules in
  `src/lib/recipienttypes.ts`). "Chooses who comes next": on their turn they fill in the name and email of the
  people after them, or change someone the sender named who has not started; the sender can leave those rows empty
  ("Mia Chen can fill this in"), and an empty place is listed under its template role or as "Chosen by Mia Chen"
  until then. "Can change the document": on their turn they can replace a file and change, add or take off the
  people after them (and, through the API, place those people's fields), under the rules of the sender's own Edit:
  when that touches what someone already signed they are asked first, and that person signs again with the first
  signature kept on record. A file they upload goes out under the sender's name, so its words are read by the
  fake-notice filter like the sender's own, and one that reads like a payment notice is refused. Neither can change
  the subject, the message, or anyone at or before their own place.
  Picking either role turns on the signing order. Each finishes with one button and is emailed "asked you to choose
  who signs next" or "asked you to check and, if needed, change". Every change is in the audit trail under their
  name ("Mia Chen named Paul Ade <paul@example.com> as the signer for Landowner"), and the certificate lists them
  as "Finished their step", never as signed, with "Named by" under each person they named. The people asked to sign
  again are told who made the change ("Ed Lawyer, who Rosa Diaz asked to check it"), the person who made it is not
  emailed about it, and their own page says who signs again first. A replaced file keeps the document's name. The
  sender's email when someone finishes their step lists each person they named or changed, a copy recipient too.
  Their screen has the same Other actions as any signer (Finish later, Ask for more time, Questions and comments,
  Decline). Neither may change a later person who also has one of these roles: only the sender chooses who has
  that power. A person who chooses who comes next cannot carry an "Only when" rule (sending says so), because a
  skipped chooser would leave a place nobody fills; a place that is still empty is not counted as reminded, and
  Remind says to use Correct. Names are typed with an email address only: a phone number is not offered for them.
  Allowed in templates; refused for public forms and Send to many, where nobody comes after the visitor.
  A file's row has Pages: the pages as small pictures, each with Turn and Remove, moved by dragging, the arrow keys
  or the arrow buttons, with Undo until "Save pages" (`src/components/editor/PageTools.tsx`); Escape or a tap
  outside the dialog says the changes are not saved instead of dropping them, and Cancel leaves them. Saving makes a new
  file and leaves the old one as it was; fields go with their pages, and on a turned page a field stays on the same
  words, upright and the same size (`src/lib/pages.ts`). Removing a page with fields asks first, with the list.
  The audit trail says "Page 3 removed from "Contract"" with the new page count and fingerprint, and the signing
  record fingerprints the new file. On a document that is out it is a correction like any other, with the same
  sign-again question; the API is POST /envelopes/:id/documents/:doc/pages (`src/server/routes-pages.ts`).
  A file's More has Replace, Move and Remove, and, once a document has two files or more, "To read, not sign" for a
  privacy notice or terms that go with the document: it has no fields, and its one choice "Before they finish" is
  "Nothing, it is there to read", "Must open it", or "Must tick 'I have been given it'", with "Put it in the signed
  copy" (on by default). The file's row then says the rule in one line, step 3 counts the files to read, and the
  envelope page marks them; when every file is to read, step 2 says so and leads back to step 1. The signing page
  lists such files above the document under "Also for you"; a file opens in a dialog. Each file still to open or
  tick counts as a place left: Next goes to it, the line above says "Open Privacy notice above the document, then
  choose Finish.", and Finish only shows once nothing is left (the server checks again). A rule changed by a
  correction while the document is out goes in the audit trail, and the certificate says who finished before it. The audit
  trail says "Opened Privacy notice" (the file was opened or downloaded by that link, through either route, never "read") and
  "Acknowledged receiving Privacy notice". The completed copy puts them after the signed pages behind a page
  "Given with this document, not signed", unless the sender left them out, and the certificate lists each with its
  SHA-256 and who opened and acknowledged it, when. A witness has no rule to meet; whoever takes another person's
  place, or agrees again after a correction, opens and ticks afresh. The API is documents[].supplemental, carried by
  templates and bulk sends (`src/server/supplements.ts`, `tests/ds-supplements.test.ts`).
  **Each person sees only their files.** With two or more files, step 3's More options has "Each person sees only
  their files", with a tick per person and file to add one; an admin can make it the start for new documents
  (Settings, Sending, the open card "When people sign"). On, each person is shown the files with their own fields,
  the ones ticked for them, and for a witness what the person they witness is shown. A file to read that nobody is
  ticked for goes to everyone, so a rule such as "acknowledge" is never skipped; ticked for someone, only those
  ticked get it. Someone with no field and
  nothing ticked, and someone who can change the document or chooses who comes next, sees every file. Their link
  knows nothing else: a file they are not shown is in no answer, its fields and the comments pinned to it are left
  out, and fetching it by its address answers 404 like a file that does not exist. Their subject never names such a
  file: when the subject is empty or names one (also the automatic "Please sign: <first file>"), their link, emails
  and file names say "Please sign: <the first file they are shown>", and step 3 shows that subject under them. A
  correction to a file they are not shown is not emailed to them and not in their "what changed". The sender's
  envelope page says, in its folded Files, who sees only which files ("Hugo Payroll sees only: Salary sheet"). A
  WhatsApp message (when that channel is set up) uses their own subject too. When everyone has finished, each
  such person gets a completed copy of their own, made through the same finishing steps as the sender's (archive
  format, seal): their files and the certificate, which lists each other file as "One other document you were not
  shown" with its SHA-256 and no name, and a trail that calls it "a document you were not shown" where one of our
  lines names it in quotes (other words are left alone, so a file called "Signed" does not change the word Signed);
  the line about sending leaves out the page count of the whole envelope. Each copy is stored, its SHA-256 kept,
  and /verify matches it by file and by ID, and says it is the copy made for one person, holding only their files. That copy is what their link
  downloads and their email attaches. The sender, admins, the sender's copy and the evidence pack (which holds each
  own copy too) always have everything. Who sees which file is said under each person in "Who gets it". Once
  someone has finished, which files they see can no longer change unless they are asked to sign again. Templates,
  sign again, bulk sends and forms keep it (`src/server/visibility.ts`, `src/lib/owndocs.ts`,
  `tests/ds-visibility.test.ts`).
  The step's More options has Set signing order and groups. Step 2
  offers six kinds of field (Signature, Initials, Date signed, Name, Text, Checkbox) and the rest under "More
  fields" (a kind already on the document stays in view); a field shows Assigned to, Required and Label, and the
  rest under its More options. Step 3 has the
  subject and message, who gets it, and one More options: reminders, the deadline, how dates are written and, where
  offered, a payment link. Next to the closed More options it says the reminders, and the deadline, the date format
  and a payment link only when they differ from the account's own or will be shown to signers. It says what sending this document on screen saves in pages of paper, with the water
  estimate behind "How we work this out" (`src/lib/editorux.ts`, `tests/simplify-editor.test.ts`).
- The document's page (after sending, and for every document in the list) has the title, one sentence that says
  where it stands ("Waiting for Ana Silva to sign. Sent 2 hours ago."), and one main button for its state:
  Continue (a draft), "Remind Ana Silva" (waiting; "Sign now" when it waits for you, "Host signing now" for someone
  signing in person), Download (completed: the signed PDF with its signing record pages), Reopen (expired), Copy
  and fix (declined), Copy (cancelled). Everything else is in one More: Open the PDF, Full record for disputes,
  Edit, Give more time, Copy, Save as template, Cancel the request, Delete, and Keep it and Hold only when a
  deletion schedule applies to the document. Each person has one line and a More of their own with what became of
  their email, Change person and "Share the link yourself" (Copy link, QR code, Share on WhatsApp, Text: these open your own
  apps, we send nothing). A Remind for one person appears there only when two or more people wait at once.
  Questions and comments, History (the emails about the document are lines of it), Files, Details and Checks on
  the file are folded and closed each time the page opens. The page shows no internet addresses or fingerprints;
  they are kept, and are in the full record. Templates has Use on each row and Send to many, Edit, Move, Who can
  use this and Delete in the row's More; after sending from a template the page says "Sent." and its way back is
  Templates. A toast sits at the bottom and is lifted off anything that can be pressed
  (`src/lib/envelopepage.ts`, `src/lib/toastplace.ts`, `tests/simplify-envelope.test.ts`).
- Several templates in one document: the Use dialog of a template has one quiet "Add another template", and the API
  takes `template_ids` (2 to 5) on `POST /envelopes`. The files come one after the other; a role with the same name
  (capitals and spaces do not matter) is one person with every field the templates give it. Each template is
  checked for who may use it, and one whose wording is locked keeps its own part locked (its files, fields, fixed
  wording and people, and then the message and the order) while the other parts can still change. The parts stay
  locked on a copy, and a person who "can change the document" on their turn cannot replace or change a locked part
  unless that part's own template gave them the role. Saving it as one template is refused when one of its templates
  is not for everyone or is locked and the sender may not set its rules, because one template cannot keep each
  part's rules; the sender uses the templates together again instead. Each added template is listed in the dialog
  with a Remove, and choosing in the list adds nothing until Add is pressed. A role with two
  different jobs, or two different named people, is refused with what to change and nothing is made
  (`src/server/tplcombine.ts`, `tests/ds-tpl-combine.test.ts`).
- "This looks like your template Volunteer agreement. Use it?": the one note line under a file just
  uploaded to a draft, when its words are close to a template the sender may use. Runs of 5 words are compared
  (how many the two share out of the runs of the longer one), and 80 percent is enough, so a one-page form with a
  name, a date and a word changed is still offered. An admin can ask for 90 or 95 through the API
  (`PUT /account/template-match`); there is no setting for it on a screen. "What is different" says how much is the
  same and lists the pages and a few words on each side. Nothing is used
  until "Use it" is pressed: then the template's people (merged by role name) and fields go on the file, and the
  sender checks them. "Hide this" puts the line away for that file on this browser. A template whose wording is
  locked for the sender is offered as itself, and the line says so: "Start from Volunteer agreement" starts a new
  document from the template, and the draft with the file stays in Drafts. Files with no words
  (scans nobody read) are never compared, and templates the sender may not use are never named
  (`src/server/tplmatch.ts`, `GET /files/{id}/template-match`).
- Sign now: when the only person on a document is its sender, signing at their own sign-in address, step 3's button
  reads "Sign now". It sends the document and opens the signing page in the same tab. The step then asks for a
  document title, with no message to write and nothing said about reminders, because nobody is invited. No invitation email is
  written to them, and the record says so. Anyone else on the document, another role, or a colleague pressing Send
  for them: an ordinary Send with the usual emails. An access code or one-time code is still asked for. In the API:
  `"sign_now": true` on `POST /envelopes/{id}/send`, answered with `sign_url` (`src/server/signnow.ts`).
- Upload PDFs, PNGs or JPEGs. Several documents per envelope, reorder and rename them. A phone photo is turned
  upright from the camera's note, several pictures chosen at once can become one document, and pictures are made
  smaller in the app's editor before they leave the phone. A PNG can have up to 25 million pixels and a JPEG up to
  13 million (a 12 megapixel phone photo), read from the header before anything is unpacked. The server does not
  make pictures smaller, so a photo sent through the API reaches every signer's phone as it was sent, and the
  limit keeps it to what a phone can open. A document of 5 MB or more is pointed out as slow on a phone.
- Word, Excel and PowerPoint files (also the old .doc, .xls and .ppt), OpenDocument texts, spreadsheets and
  presentations, RTF, plain text (UTF-8), web pages and TIFF, on a server whose operator set up a converter (see
  "Turning office files into PDF"). The file is recognised by its bytes, never by its name, and turned into a PDF
  before anything else happens; from then on it is a PDF like any other (500 pages, 25 MB, text for search, the scan
  warning). The sender sees that PDF before placing a field, and under the document and over its pages the editor
  says one line, "Converted from Contract.docx. Check every page before you send: the PDF is what people sign, and
  text can move.", with the rest folded into "1 more note": when the file has tracked changes or comments (Word,
  OpenDocument text, RTF; this one is shown first, because it is something to do before sending), is a spreadsheet
  ("A sheet may be split across pages."), names pictures or files outside itself (Word, Excel, PowerPoint,
  OpenDocument, RTF and HTML; a web link someone can click does not count; "They may be missing from the PDF.") or
  has macros (LibreOffice is set not to run them; see "Turning office files into PDF" for what that is worth). A web
  page is converted without anything it names outside itself, and a text file with no words in it is refused. The
  original is kept with the PDF as a stored file (encrypted when `FILE_ENCRYPTION_KEY` is set), the audit trail says "Converted
  from Contract.docx (SHA-256 ...) to PDF by LibreOffice 24.2.7.2" when the envelope is sent or a correction puts the
  document on it, the evidence pack carries it under `originals/`, the sender can download it again from More next to the file in
  the editor (`GET /files/{id}/original`, drafts and templates too), and it is deleted with the account. A ZIP-based
  file that unpacks to more than 100 MB or 20 times its own size is refused before anything opens it, and so is a
  file protected with a password. A file a signer attaches is never converted. Without a converter these files are
  refused with one sentence that says what the file is and what to do ("This is a Word file. Save it as a PDF and add
  it again."); that a converter can be set up is said to operators only (`operator_hint` in the API answer, and here). Rules in `src/server/convert.ts`, words in
  `src/lib/convert.ts`, tests in `tests/convert.test.ts`.
- Recipients who sign, approve, only view, get a copy, or sign in person on your device. Signing in person needs an
  internet connection from opening the document to pressing Finish, unless the sender got it ready to sign without
  signal (below).
- Signing in person without signal (`src/server/offlinesign.ts`, `src/components/sign/offlineInPerson.ts`, the page
  `/in-person`, tests in `tests/ds-offline-inperson.test.ts`). In the More of someone who signs in person, while the
  envelope is out and it is their turn, "Get ready to sign without signal" (absent where the browser cannot keep a
  copy). The host chooses a PIN (at least 6, not a run or one digit repeated) on the device the person will sign on,
  while it has signal. The device keeps the document, that person's part and later their signature in IndexedDB,
  encrypted with AES-GCM under a key made from the PIN with PBKDF2 (SHA-256, 600,000 rounds). 5 wrong PINs in a row
  wipe it; so do 7 days, sending it, and "Remove it from this device". One person at a time per device: getting
  another ready on it (also another person of the same envelope) replaces the first, and the dialog says so. While it
  has signal the device also keeps the page `/in-person` and every file it loads (the service worker is registered
  for `/in-person` and asked to fetch them, `src/components/sign/offlinePage.ts`), and the page says plainly when
  this did not work. Offline, the host opens `/in-person` (the installed app's no-connection page links to it when a
  copy is there), types the PIN and hands over; the account locks in that browser (at once with signal, else the first time the app opens with signal).
  The person agrees (above the consent words the device says that its own clock is recorded and not checked, and
  that the time received and the IP address are recorded when the device has signal again), reads the pages (a tap
  on a field marked there goes to its control), fills in a simple form of their part with the same field checks as
  the signing page, makes their own signature and their own initials, and finishes; the page says "Saved on this
  device. It is sent when the device has signal again. Nothing is signed until then." Back stays on the page while
  the person holds the device. With signal it is sent by itself (every 15 seconds while the page is open, or Send now after the PIN).
  The server signs it only if the copy is the one got ready, at most 7 days old, and the envelope's content version
  is unchanged; otherwise nothing is signed and the host reads, for example, "Nothing was signed for Amina Okello,
  because the document was changed after it was kept on this device. Open the document with a connection and let
  Amina Okello sign it again." A refusal for another reason keeps the copy, and the page offers "Change <name>'s
  part" and "Remove it from this device"; the waiting screen can remove it too, so a host is never stuck with it. A
  part that pays before finishing needs a connection and is not got ready. The audit trail and the certificate say: "Signed in person on the host's device without a
  connection. The device's clock said <time>; this was not checked. The server received it at <time>." Consent and
  Finish are recorded at the time the server received them, so the date of signing on the pages is that day. Only
  for parts without an access code or a code we send, groups, witnesses, files to read, attachments, stamps,
  drawings, payments or fields that depend on other answers. A copy waiting on a lost phone can be ended from the
  same dialog on the envelope page.
- Signing at a service counter (`src/server/counter.ts`, Counter under More, only for people an admin gave the
  counter permission in Settings, Team, More options, Service counter). Officials see a queue of the people waiting on documents
  from templates an admin marked for the counter, and Start someone new. Before the document opens the official
  answers "Which ID did you see?" (a document with its kind, the last 4 characters of its number and who issued
  it, or "I know this person") and ticks "I checked this person's identity as recorded above"; GrowSigning cannot
  check an identity document and every Counter screen says so. Help with signing, each written on the certificate
  as the official's statement: a mark with a witness (the official may be that witness only where the account
  allows it), someone signing for a person who cannot (a second official confirms with their own login before
  Finish), the document read aloud in a language, an interpreter. The person signs on a screen facing them,
  connected by a short code or its QR code (one use, ten minutes), or on the official's device with the hand-over
  lock. After Finish the link used at the counter stops working, so the next person cannot open the document from
  the browser's history; the person's copy is emailed to them with a new link, and "Next person" clears the screen.
  The Counter screen shows progress, not what the person types, unless an admin allows it for the template; the
  official who started a document is its sender and can still open it. A document from a counter template opens on
  no device until an official has pressed Start and recorded the identity check. After Finish a receipt prints at 80 mm or on A4: envelope ID, fingerprint, where the
  copy goes, how to check it at /verify, and the agency's contact. A signature pad that the browser sees as a pen
  draws on the pad; only the drawn picture is kept, not pressure or speed. A picture of the ID document is kept
  only when the account switches that on, which needs `FILE_ENCRYPTION_KEY`; it is stored encrypted with the visit
  and is in the evidence pack.
- Signing order (sequential, parallel or mixed) or everyone at once.
- A witness for one person who signs (the role `witness` with `witness_for`): asked straight after that person has
  signed, whatever the order, and holding nobody up; never charged; a block the editor places next to the signature
  (signature, name, address, occupation, date). The sender names the witness or leaves it to the signer
  (`named_by_signer`), who names them on the review screen before Finish. The witness first ticks their own statement
  that they were physically present and saw the signature, or says "I was not there", and the signer can then name
  the person who was. The certificate lists the witness under the signer with the statement, and marks a witness at
  the signer's address, under the signer's name, or in the signer's browser ("same device: yes or no"). A statement
  is set aside with the signature it saw. GrowSigning records what the witness states and cannot check it.
  One or two witnesses for one person who signs: under the first witness the editor offers "Add a second witness"
  (the same person who signs, named the same way). Both are asked at the same time straight after the signer, each
  makes their own statement or says "I was not there" (the other one's statement stands), each is set aside with the
  signature they saw, each is compared with the signer's browser, and the certificate lists both under the signer.
  Where the signer names them, they name both on the review screen, each in its own box. The two cannot be one person
  (the same email address, or the same name also in another spelling), and never more than two.
- "I will send the link myself": a recipient with a name and no email address, for someone who lives in WhatsApp or
  text messages. We never email that person (no invitation, reminder or copy). The envelope page shows their link
  with copy, QR code and share buttons, also after they finished, because the same link opens the completed
  document. The sender is told when it becomes their turn, gets the reminders in their place and hears when the
  link sits unopened. The certificate and the audit trail say "Link shared by the sender". They count towards the
  daily limit and the automatic pause like anyone, and a signature from them is never the sender's free one.
  Without an address, "Find my documents" cannot find it for them, and their screens say so. Not for templates,
  groups, people who only get a copy, or in-person signers (`link_by_sender` in the API, rules in
  `src/lib/bysender.ts`).
- Signing groups: a recipient that is a group of 2 to 20 people, any one of whom can act for it ("HR team",
  "Accounts payable"), as signer, approver, viewer or copy, not in person. Admins keep the groups under Contacts
  (`/groups` in the API) and everyone on the team can use them, also in templates and bulk sends. When the
  envelope is sent, every member gets their own email with their own link and security code, so it is always known
  who opened and who acted. The first member who agrees to the consent screen takes it on; the others' links then
  say who has it and offer only to ask the sender to give it back. The one who has it can hand it back before
  signing, and the sender can give it back to the whole group; either way what they filled in is cleared. One
  member declining declines for the group, and the screen says so first. The audit trail and the certificate name
  the person and the group ("Maya Lopez, for HR team") and list the members it went out with. It is one recipient
  everywhere else: one place in the order, one access code, one signature held while it is out and one used when
  it signs. The sender who takes it on for a group they are in, under their own name and address, signs free, as
  for any document of their own; a group put in the place of another group (or of a person) pays its own. The
  group as it was sent is what counts: changing or deleting it later changes no envelope that is out, and members
  are changed on such an envelope with Edit envelope; someone added is emailed their link at once if the group can
  act, and otherwise when it comes back to the group. Reminders go to each member who can still act: not to one
  who turned them off, whose email came back, who marked our email as spam or who reported the document. A member
  who marked our email as spam or reported it gets nothing more by email about it (no reminder, notice or copy)
  until they ask for our emails again on their own signing page, with a code sent to their own address, and the
  sender's email and the envelope page say which member it was. A note typed when handing back goes to the sender
  and into the record, never into the other members' inboxes. Hand-backs are limited per member (3 a day) and per
  document (6 a day). Once a colleague has it, or when the group only gets a copy, a member's wrong access codes
  freeze only that member's own link, and asking the sender for the code is counted per member. Each member
  counts as a person reached in the daily limit, and a one-time code or texted link is refused because it goes to
  one person. Public forms cannot name a group: anyone could make every member get an email. Rules in
  `src/server/groups.ts`, tests in `tests/groups.test.ts`.
- Someone who signs for you while you are away (delegated signing). Off until an admin turns it on, under
  Settings, Team, More options (offered on accounts with 2 or more members only). Then Settings, "Away and
  sharing" has the card "Documents sent to me: someone signs for me while I am away", where a person with a
  confirmed address names one delegate (a name and an address) for up to 92 days, both included; the delegate is
  emailed at once that they were named, and the person can stop it any time. It stops by itself after the last day,
  in the person's own time zone: links nobody acted on stop working and reminders stop going to the delegate. The
  name follows the rules of a name on a certificate: never the person's own, never someone else's in the account
  at another address, no characters nobody sees, no < or >, no letters of two alphabets in one word. Only requests (signer or approver) sent from that
  same account to the person's address on those days are affected: documents from anyone else still go to the
  person only. Such a request goes to the person as always, and their email and signing page say the delegate has
  it too; the delegate gets a link of their own and always types a one-time code sent to their own address before
  it opens. Whoever agrees first takes it on, like a signing group, and the other one's link then says so. A
  delegate signs with their own name and their own signature: the person's saved signature is never offered to
  them, and they cannot pass it on or change their name on it. The person is emailed when the delegate takes it on,
  finishes or declines. It stays one recipient: one place in the order, one signature. The certificate says "Signed
  by Bob Reyes for Ana Silva, under a delegation Ana Silva set on 1 March 2027 for 3 March 2027 to 14 March 2027.
  GrowSigning does not know whether Bob Reyes has the authority to sign for Ana Silva." and the audit trail names
  him as "Bob Reyes, for Ana Silva". A sender sees "Only the person named may sign" in step 3, More options, only
  when someone on the envelope is away and named a person to sign for them, with who ("Ana Silva is away and named
  Bob Reyes to sign for them"); it can be ticked after sending too, which stops a delegate who has not acted yet.
  A delegate's code screen says the person named them, and the delegate's code never ends the person's own. If the
  sender corrects a request the delegate took on to another address, it is no longer the delegate's, the check the
  sender chose comes back, and it does not go to that delegate again. Never for
  in-person signing, witnesses, groups, public forms, a document a person sends themselves, or when the delegate is
  already on the envelope or is its sender. API: `/account/delegation`, `/me/delegate`, `/envelopes/{id}/away`, `/envelopes/{id}/only-named`.
  Rules in `src/server/delegation.ts` and `src/lib/delegation.ts`, tests in `tests/ds-delegate.test.ts`.
- Working for a colleague. On a team (2 or more members) a member shares the documents they send with one colleague
  in the same account (Settings, Away and sharing; for a member it is at the end of Team, so a member keeps 4
  sections), at a level: See (follow them: who has signed, and their history; no file, no change, no download),
  Manage (also remind, correct a person, give more time, pause, send an email again, cancel, download, and write in
  Questions and comments) or Send for me (also make, change and send documents in their name), from a first day to
  an optional last day in their own time zone. Shares given and received are listed there with "End now"; the
  person who shared, the colleague and an admin of the team can end one, and it stops for the very next request.
  Leaving the account (removed, left, or closed the login) ends every share of that person for good: being invited
  back does not bring one back. When a share ends, drafts the colleague made and handed over with "Send for" (not
  sent, not set to go later) go back to them. A share never reaches another account. In Documents, a colleague's
  shared documents are in the list next to one's own, each marked "Ben Okoro's, shared with you", and "Sent by"
  offers "Sent by me" and "Shared with me by Ben Okoro". Everything done through a share is in the audit trail as
  "Ana Silva <ana@...> for Ben Okoro" and in the security record with a "for" detail; what the level does not cover
  is refused in words (deleting and a person's signing link are never through a share), and the document page, its
  people and its comments, and the list rows offer only what the level allows. "Move to a colleague" in a
  document's More, in a template's More on Templates, and for several documents ticked in Documents (for the person
  they belong to and admins; a document deleted after somebody signed only by an admin), and "Move a member's
  documents" in Settings, Team, More options (asked first with how many documents and templates) give envelopes and
  templates to another member: the audit trail says "Moved from Ben Okoro to Ana Silva by ...", and the certificate
  keeps naming whoever sent it first. With a Send for me share, step 3's More options has "Send for Ben Okoro"; the
  API takes `on_behalf_of` on `POST /envelopes` (templates too, through the API only), also from an API key with
  the admin scope for any member. People on such a document read "Ben Okoro (sent by Ana Silva)" in the From line
  of each email and of the signing page, "Ana Silva sent this for Ben Okoro." at the foot of each email from the
  sender, and on the certificate ("Sent by"): who pressed Send is never hidden. The emails about it go to Ben, and
  the screen after Send says so. API: `/me/shares`, `/me/sends-for`, `/envelopes/{id}/send-for`,
  `/envelopes/{id}/move`, `/envelopes/move`, `/account/members/{id}/move-documents`. Rules in `src/server/shares.ts`
  and `src/lib/shares.ts`, tests in
  `tests/ds-colleagues.test.ts`.
- Field editor: signature, initials, date signed, name, email, company, title, text, number, date, checkbox,
  radio group, dropdown, signer attachment and sender notes. Click to place, drag to move, resize, nudge with
  arrow keys, duplicate, copy to every page. Required or optional, prefilled, read only, validated.
- Conditional fields and formulas. "Only show when..." shows a field only after another field of the same person
  has a certain answer (ticked or not, a choice, filled in, equal to, more or less than), and rules can chain.
  "Calculate from..." works a number field out from other number fields with + - * /, brackets, `sum()` and
  `round(x, decimals)`, for totals on order forms and quotes. The parser is our own (`src/lib/logic.ts`): nothing in
  a formula is ever run as code. The signing page shows, hides and adds up live and says so to a screen reader; the
  server works it all out again from what is stored (`src/server/logic.ts`) and the signed PDF prints only what was
  shown, with the calculated values. What is shown at Finish is worked out once, from the stored answers, and that
  one result decides what is required, which signature needs a picture and what is printed. A calculated result is
  kept as shown (1,233) and as a plain number (1.233), and everything after reads the number. Someone else's answer
  counts in a formula once they have finished, and a result never changes after its signer has finished; if that
  person finishes while your page is open, Finish signs nothing, says who finished, and shows the new result first.
- Only when... for people (`src/server/routing.ts`, `src/lib/routing.ts`, the editor's `RecipientRule.tsx`). With a
  signing order on and an answer of someone earlier in the order on the document, a person's More has "Only when:"
  (with an answer of someone else but no order yet, the line says "Always asked" and offers one button, "Put Max
  Manager after Ana Asker", which turns the order on; starting a rule saves nothing until it is complete):
  ask them only when that answer is ticked, a choice, filled in, equal to, or more or less than a value (the
  conditions of "Only show when"), or only instead of someone in the same step ("Manager A when Amount is more than
  1000, otherwise Officer B", one button under Manager A's rule). Off by default: everyone is asked. A set rule is one line under the person in step 3.
  When the step is reached the server decides from the stored answers; a field its own rule hides counts as empty,
  and so does an answer of someone who was not asked, so rules can chain. A person whose rule is not met is "Not
  asked": not emailed, no link, no completed copy, not in To sign or Find my documents, nobody to write a comment
  to, and the signature held for them goes back by itself. The record and the signing record say "Not asked: Max
  Manager, because Amount was 800 (rule: more than 1000)." and never show them as having signed or approved; their
  fields print nothing. An answer the sender hid from the others is never written there, only that it did or did not
  meet the rule. A number that can be read two ways and would ask different people ("1.200" is 1200 in Germany and
  1.2 in England) is refused at Finish with both readings, said under that field on the signing page (which opens it),
  about their answer only: '"1.200" in Amount could mean 1200 or 1.2. Type the one you mean: 1200 or 1.2.'
  Someone who had already been emailed or opened it before a correction asked an earlier person again,
  and who is then not needed, is "No longer needed", is emailed so (or the sender is told to tell them), and the
  record says they had been asked. A reminder for someone not asked is refused in words (409 "not_asked"). Templates, copies, bulk sends, public forms and the API (`recipients[].only_when`) carry it.
  A change to the document can change the rule of a step not reached yet, and is refused for one that was; when
  someone earlier is asked to sign again, a person who was not asked is decided again when their step comes back.
  Tests in `tests/ds-routing-if.test.ts`.
- Fill in and Your text (`src/lib/fieldkinds.ts` section 8). In step 2 the blank a signer types into is "Fill in"
  (stored as `text`), one of the six common fields, with "They type here" under its name. The sender's own words
  printed on the page are "Your text" (stored as `note`), under More fields, with "You type, they read". Email, also
  under More fields, says "Filled in for them", and on the page in the editor it reads "Ana's email" with no star. Dropping "Your text" opens its settings with the cursor
  in "Your words"; until something is typed the box is dashed and reads "Type your text" in the editor only. An empty
  box is kept with no value (spaces alone are no words), is left out of what every signer is sent and of the signed
  PDF, and is listed in step 3 with "Write it", "Let them type here" and "Remove"
  (`src/components/editor/NoteCheck.tsx`); it warns and never blocks. "Let them type here", also in the box's own
  settings, turns the box into a Fill in field for the selected person where it stands. The API refuses a `note` sent
  with a `recipient_id` and no words, and says to use `text`. Once, at start, boxes in drafts and templates that
  still hold only the word "Note" from the old editor are emptied (`sweepLeftoverNotes` in `src/server/db.ts`). A Fill in field reads "Ana types here" on the page in the editor until it has a label; the label is
  what the signer reads in the empty blank, and "Type here" stands there when it has none (in a sentence such a
  field is called "Text box"). On a phone the bar under a dropped Fill in field says who types there and offers
  "Add a label". Tests in
  `tests/note-text.test.ts`.
- More kinds of field and text style (`src/lib/fieldkinds.ts`, `src/server/fieldkinds.ts`). The six common fields
  are unchanged; the new ones are under More fields in step 2. A Name field's "Which name" holds the full name, the
  first name (the first word of the name the sender typed) or the last name (the last word); the signer sees it
  filled in, with "Check your first name" in small words under the field while it is unchanged (on a phone also in
  the box it types in), and can change it: only that field changes, never
  their name. Drawing: a box the signer draws in with the same pad as a signature, without the words about signing;
  only a PNG picture is kept, printed as a picture and listed on the certificate as "Drawings: 1 drawing made in a
  Drawing field. A drawing is a picture on the page, not a signature." Approve button and Decline button: placed on
  a page for someone who signs or approves; Approve does what Finish (or Approve) does, Decline opens the same
  decline as Other actions; they are never required, hold no answer, and on a phone take a 44 px tap (hit-tested at 390x844 in
  `tests/out/repair-ds-fields-kinds/approver.cjs`); for each, the editor says the words its person sees ("For Mary
  this button reads Finish"). "Same answer
  as" (More options): fields of one person and one kind share an answer, typing in one fills the others, and the
  server gives them one value at every save. "Date from another date": a date worked out from a date of the same
  person or from the day they sign (in their device's time zone, as the date signed prints), plus or minus days,
  weeks or months on the Gregorian calendar, with month ends held (31 January plus 1 month is the last day of
  February); the rule ("30 days after the date you sign") is said in small words under the field, in a grey box
  that asks nothing of the signer, and its screen-reader label, Easy reading and the editor add "Counted on the
  calendar. GrowSigning does not track it or remind anyone of it." Placed when its person has only one date, it
  counts from that one; its panel and its tag on the page say "Date from another date" and its rule. It cannot also
  share an answer ("Same answer as"). The server works it out, whatever the browser sends; a draft keeps one that
  counts from nothing yet, and sending says which. "Text style" (More options): Sans, Serif or Typewriter, 8 to 24 points
  (smaller only when it does not fit), black, dark blue or the account's brand colour (offered only once the account has one), bold. Serif and Typewriter
  are the standard PDF fonts and have Latin letters only, so other writing prints in Sans and a character no font
  has gets the visible mark as everywhere. Settings, Sending, More options: "Saved fields and text style" (a closed fold with zero setup, a card once
  the team has a saved field or a style), with
  "Text style for new fields" (admins; fields already placed keep theirs, and a field sent back through the API
  without "look" keeps its own). Members see the card only once the team has a saved field. An admin saves a field from its More options
  ("Save for the team": kind, label, format, size and text style, never a value or a person), everyone finds it at
  the end of More fields, and the same name replaces it. Templates, copies, bulk sends and the API (`fields[].link`,
  `fields[].date_from`, `fields[].look`, `/saved-fields`) carry all of these. Tests in `tests/ds-fields-kinds.test.ts`.
- Fields anyone on the document can fill in (`src/lib/collab.ts`, `src/server/collab.ts`). In step 2, a text,
  choice, dropdown or tick-box field's "Assigned to" ends with "Anyone on the document" once two or more people
  sign; chosen, it says "Anyone on the document can fill it in. Nobody has to fill it in." with two ticks: "Ask for
  initials when someone changes it" and "Allow changes after someone has finished" ("Whoever already finished is then
  asked to sign again."). With people signing in order it also says that once the first person has finished, nobody
  else can change it unless changes after that are allowed. A choice in a group goes for anyone with its whole group;
  for such a field the editor does not offer Read only, "Only show when", "Same answer as" or "Hide what they type",
  and a field for anyone goes back to its person when fewer than two people sign. On the editor's page it is drawn in
  grey and named "for anyone on the document". Every signer gets the field to fill in. While they are in it, one line
  under it says "Anyone on the document can fill it in. Last changed by Ada." (also in its screen-reader name, in the
  phone's typing box and in Easy reading); the line is not drawn while they are elsewhere, so it never covers the
  document. Each change is in the audit trail ("Field changed by anyone on the document": who, the value before and
  after, initials if given). A screen that was given an older value never undoes a newer change, also for a group of
  choices: sending that old value back changes nothing, typing or choosing over it is refused with who changed it and
  what it says now, and Finish waits until the page has been loaded again, so nobody finishes on a value they did not
  see. Once anyone has finished, a change is refused ("Ada already finished, so this can no longer be changed.", said
  to a screen reader too, and the field shows "Left empty" when it is) unless the sender allowed changes after that;
  then the line says who is asked to sign again when the person finishes. Such a change is not autosaved: it goes
  with Finish, so a pause while typing asks nobody anything, and a Finish that is refused (a missing signature, say)
  changes nothing. It then asks everyone who had finished to sign again by the same rule a sender's change uses
  (first signature set aside and kept, a copy of what they signed kept, an email saying who changed what and that
  they also sign it, no second signature used). With initials asked for, changing an answer that is there waits for
  the person's initials, which are kept with the change; the first answer in an empty field needs none. A dropdown
  answer that is not one of its options is refused. One person can make up to 200 changes to these fields on one
  document; after that a change is refused and they are told to ask the sender. The signed PDF prints the final answer and the certificate lists every
  change under "Changed by anyone". Templates, copies, bulk sends and the API (`fields[].shared`,
  `fields[].shared_initials`, `fields[].shared_after`) carry it; deleting an envelope's values takes the changes'
  values too. Tests in `tests/ds-collab-fields.test.ts`.
- Field checks, under a field's More options, "Format and limits" (`src/lib/fieldrules.ts`, shared by the editor,
  the signing page and the server). A text field's Format: None, Email address, Number, Phone number, Letters only,
  Date (in the envelope's date format) or My own pattern, with the words people see when it does not match (the
  pattern itself is never shown on screen, though the signer's browser receives it to check as they type). A pattern
  is read by our own reader before it is saved: at most 200 characters, no back-references, no repeat inside a
  repeat such as (a+)+, no repeated choice whose parts can start alike such as (a|a)+, at most 3 open-ended repeats,
  and a field with a pattern takes at most 100 characters; a refused one is explained. On the server every pattern
  check also has a time limit of a quarter of a second, so a pattern that slipped past the reader cannot hold up
  the server. A character limit from 1 to 4,000; Fixed size (text shrinks to fit its box, below 7 point for wide
  capitals, so it is never cut off or printed past the box, and no more can be typed than fits at 7 point; the
  signer sees "12 of 40 characters" under the box while typing, on a phone and on a computer); Hide what they type (dots for every other person while the document is out,
  the sender's own copy shows it; with "Also hide it in the completed copy" the completed copy prints "(hidden by the
  sender)", the certificate says a value was hidden by the sender's choice, and the value stays with the document
  and in the API; it is a screen mask, not encryption). A number field: smallest, largest, decimal places and a
  currency (an ISO code, printed with its sign; the value is kept as typed and as a plain number, `typed_num`). Tick
  boxes with the same group name: tick at least, at most or exactly N, with an optional message, said to the signer
  beside the boxes before they finish; a rule never asks for more boxes than are shown, and one nobody could meet
  (at most or exactly fewer boxes than are required) is refused at send and listed on the review step. The server checks the limits at every save and everything at Finish; templates,
  bulk sends and the API carry it (`fields[].validation` as an object, the old word or pattern still works). It
  only checks the format of what is typed: "checked the format", never "verified".
  Templates, copies, public forms, bulk send (a column named
  like a field fills it) and the API (`fields[].show_when`, `fields[].formula`) all carry them.
- Access codes (at least 4 characters, frozen after 10 wrong tries until the sender sets a new one), private notes
  per recipient, email subject and message.
- A one-time code before the document opens, per recipient: by email, or by text message to a mobile number the
  sender types, and the signing link by text as well (both only where the operator has switched text messages on).
  See "Checking who signs" under Configuration.
- Automatic reminders: a new account starts with one every 3 days to whoever has not finished
  (`DEFAULT_REMINDER_DAYS` in `src/lib/policy.ts`), the last step before sending shows the setting with a way to
  change it or switch it off, and Settings, Sending sets what new envelopes start with. An account made before that
  default keeps the number it had, which may be none. A warning before a deadline, more time in one click, reopening
  after expiry.
- Correct an envelope that is already out, without voiding it (Edit, in More on its page; Change person in a person's More). Remind one person. Cancel the request with a reason (the API calls it void).
- A check before sending: when the subject, a document name or the text of a document names a kind of document
  that often needs paper, a witness, a notary or a qualified signature (a will, a power of attorney, a sale of
  land, a fixed-term employment contract and so on), the review step says which word it saw and links to the help
  page. It warns and never blocks, and the audit trail records it. Through the API the same list is `warnings` in
  the answer to sending, and `GET /api/envelopes/:id/warnings` before it.
- Sign a document yourself, clone an envelope, save any envelope as a template, folders, search that also
  looks inside documents.
- Ten ready-made templates (Templates, "Start from a ready-made one", in the empty list and when a search finds no
  template of your own, so the way to Use a template is no longer; also from Help, which links `/app/templates?ready=1`):
  a volunteer agreement; consent to photos, video and stories (with how to withdraw it); consent to share personal
  data with a named partner; a donation or gift declaration; consent to plant trees on community or private land;
  event participation and risks; parental consent for a child's participation; a simple confidentiality agreement;
  acknowledgement of grant terms; an equipment loan. One file each in `src/lib/starters/`, with its purpose, the date
  it was written, the place it is written for ("No particular country") and who reviewed it (nobody yet). Picking one
  asks for the organisation's name (and for three of them a partner, an event or an activity), shows it as a PDF if
  wanted ("See it first"), and makes a normal template of one or two A4 pages with roles and fields placed under the
  paragraphs they belong to (`src/server/starters.ts`), owned by the person, for everyone on the team, opened in the
  editor. The list (once, at its top) and the editor say "A starting point written by GrowSigning, not legal advice.
  Not reviewed by a lawyer."; the wording of the PDF stays as written, its fields can be changed; the editor's note is kept as it read the day the template was made. The check before sending reads them
  like any document. A name that reads like a well-known company, or like GrowSigning, is refused. API: `GET /api/starters`,
  `GET /api/starters/:id/preview`, `POST /api/starters/:id/use`.
- Writing a document here instead of uploading one. Under the drop zone in editor step 1 one link, "No document yet?
  Write one" (and "Write a template" on the empty Templates page), opens a writing view in step 1: a title and the
  text, with the same marks as click-to-agree terms (# heading, - list, **bold**), a preview beside it (a Preview
  toggle on a phone), five short starters (an agreement between two people, a freelance job, confidentiality, a
  permission form, a receipt) and Undo and Redo. {{signature}}, {{date}}, {{name}}, {{text:Label}} and the other
  tags of "Place fields for me" mark where people sign or fill in ({{signature2}} for the second signer, and
  "Add a place to sign" writes them); the preview shows them as "Signature, Person 1", the word step 2 uses. The
  numbers are counted again from 1 without gaps, so {{signature9}} alone is Person 1 and adds no empty rows. [Blanks] are marked; clicking one selects it to type over, and "Use
  this document" refuses while any is left ("Fill in or delete the 3 blanks first", with a jump to the first). The
  server makes the PDF (`src/server/writedoc.ts`: A4 or Letter, page numbers, our fonts, every script the signed PDF
  prints, a warning naming characters it cannot), adds it like an upload, and the tags become fields for the people
  of step 1 in order, adding a row for a signer step 1 does not have yet. The text is kept with the file (encrypted
  with `FILE_ENCRYPTION_KEY`), so "Edit the text" in the file's More brings it back; once sent, saving a new text is
  a correction with the sign-again rule and the record says "Wording changed". The record says "Written in
  GrowSigning" and never names an AI; only the sender's file row says "Written in GrowSigning, with AI help". With
  the help chat's model set up and the account's AI switch on, two more boxes: "Describe what you need" with "Write
  it" (a draft streamed in, with Stop) and "Ask for a change" (the whole text or the passage selected at that moment, put back where
  it was; shown as added and struck-out words without the marks, with "Keep the change" and "Undo the change";
  typing after it keeps the change). Back keeps what was written for when the view opens again in that tab. The model is the chat's own (same settings, same client,
  same per-minute limits) and gets only what was typed in that view. Its text loses links, HTML, and web and email
  addresses that the person did not type, and words saying the document is binding, valid or enforceable, approved by
  a lawyer or a court, or meets the law are taken out with a note (a backstop that reads English phrasings, not a
  guarantee); Stop keeps what came only after the server has done the same to it (`POST /api/write/tidy`); a model
  answer that starts with REFUSE is never kept; a call that brings nothing back does not count against the day; a request for a fake or for
  a paper posing as a real company is refused before anything is sent; a question about the law gets the chat's
  legal hand-over. `WRITE_AI_DAILY_LIMIT` per account per day. API: `GET /api/write`, `POST /api/write/draft`,
  `POST /api/write/change`, `POST /api/write/tidy`, `POST /api/write/render`, `GET /api/write/source/:file`.
- AI help when sending and signing, with the help chat's own model, client and limits (`src/server/aiassist.ts`),
  only where a model answers and the account's AI switch is on; with zero setup none of it shows. Settings, Account:
  "Let the AI read document text" (admins, off by default, saves by itself, names the model, its host and the
  country the operator gave). Step 2: Place fields for me asks the AI only for pages where it found nothing, sending
  their text with positions, never a picture; every suggestion is checked on the server (a known kind, inside the
  page, a signer who exists, no overlap), drawn on the page as a dashed outline marked "Suggested" and listed with
  Add and Add all; nothing is placed without the sender, and undo takes it away. Step 3: "Draft a message" beside the message box writes a subject and message from the
  document names and the people (the document text only with the read switch), through the fake-notice and claims
  filters and with no sentence that gives a phone number, an email address or asks for payment or account details,
  with "Put back what was there"; More options: "Plain summary for signers" (only with the read switch).
  Signing page: "Summary (written by AI, check it)", one closed link above the document, opening a panel with the
  warning, until the person finishes; lines with a phone number, an email address or a request for payment or
  account details are left out; written once per file and kept with it (encrypted with `FILE_ENCRYPTION_KEY`, deleted with the file); the
  record says once that a summary the sender offered was shown and that it is not part of what was signed, with no
  AI words. `AI_ASSIST_DAILY_LIMIT` per account per day, the chat's limits on top, a plain sentence when the model is
  down. `/security`, `/security/processing` and the list of outside services say what is sent. API: `GET
  /api/ai/assist`, `PUT /api/account/ai-read`, `POST /api/ai/fields`, `POST /api/ai/draft`, `GET` and `PUT
  /api/envelopes/:id/ai-summary`, `POST /api/sign/:token/summary`.
- Key dates of completed agreements (`src/server/airepo.ts`, `src/lib/keydates.ts`), only where the AI may read
  document text and an admin switched on "Key dates" on the AI card in Settings, Account (off by default; it never
  comes on with the read switch, and turning the read switch off turns it off too, so turning that on again does not
  bring it back). From then the timer reads documents completed after that, `KEY_DATES_PER_TICK` a run, using at most
  half of the account's AI requests of the day; "Look through older documents" (signed in, never by API key) adds the
  older ones. Where the timer cannot read (`KEY_DATES_PER_TICK=0`, or a daily limit of 1) the screens say so and that
  button is absent. On a completed document's page a closed "Key dates" fold:
  "Find the dates and amounts" (one AI request of the day), then the parties, start, end, renewal and notice dates and
  amounts, each "Found by AI on page N. Check it." with the words it came from (a proposal whose words are not on a
  page of the document, or do not hold its date, amount or names, is dropped; so is a date the AI worked out from a
  period), with Confirm, Correct and Remove, and "Add a date or amount" by hand. A
  confirmed value is a detail of the envelope ("End date", never on the certificate, never over a detail the sender
  already has); the page shows it in the Key dates fold only, not a second time under Details. "Remind me" (once an
  end, notice or renewal date still to come is confirmed) emails that person N days before each
  such date, once per date, by their own day; nothing for a proposal, nothing while Key dates is off. Sidebar More,
  "Key dates": the completed documents with their dates, the nearest first, each with its coming end, notice and
  renewal dates, "With a date in the next 30, 90, 180 or 365 days", Remind me on each, and "Download a calendar
  file" of the confirmed dates once there is one. Values and quotes are kept
  encrypted with `FILE_ENCRYPTION_KEY`, and go with a purge that removes personal details. API: `GET` and `PUT
  /api/account/key-dates`, `POST /api/account/key-dates/older`, `GET /api/key-dates`, `GET
  /api/key-dates/calendar.ics`, `GET` and `POST /api/envelopes/:id/key-dates`, `POST /api/envelopes/:id/key-dates/find`,
  `PUT` and `DELETE /api/envelopes/:id/key-dates/:term`, `PUT /api/envelopes/:id/key-dates-reminder`, and
  `GET /api/envelopes?ends_within=90`.
- A "Strike out" field: a line through printed wording (a cross over a box taller than a line), on the signing
  screen and in the signed PDF, written to the audit trail, and counted as wording by the sign-again rule.
- The sender sees who filled in everything but has not pressed Finish, and the reminder to that person says so.
- Send later, pause and a wait before a person (`src/server/timing.ts`, `src/server/waits.ts`, `src/lib/timing.ts`,
  `tests/ds-timing.test.ts`). Step 3's More options has "When it goes out": Send now (the default) or Send later, a
  day and time in the sender's own time, 5 minutes to 30 days ahead; the one Send button then reads "Send at 9:00 on
  3 December". It stays a draft until then and holds nothing. The timer takes it up on its next round after that
  time (every 15 minutes, or as often as your scheduler calls `POST /api/cron`), so the screens say "soon after"; it
  sends it with every check a
  send by hand has; if one stops it, nothing goes out, the sender is emailed why, and the document page says "Not
  sent at 9:00 on 3 December:" with the reason and Send now. A draft with a time has Send now as its main button, and Edit,
  Change the time and "Do not send at that time" in More; the Documents list says "Sends at" the time, and Home
  counts it apart from drafts that were not sent. A time chosen and then passed is never sent at once instead: Send
  says "Pick a later time". An API time needs its zone (`Z` or an offset). An envelope that is out has Pause in More:
  nobody can fill in, sign, finish, decline, stamp or remove a stamp, hand it on or change their name, no reminders
  go out, nobody further down the order is asked, it does not expire, and
  each link says "Paused by" the sender's name "on" the day, then "You will get an email when it can be signed again." Resume is then the
  page's main button: the deadline moves on by exactly the time paused (said in the history), and whoever's turn it
  is gets an email. With a signing order on, a person's More has "Wait before this person" (1 hour to 30 days after
  the person before them finishes, not for the first step); the review step shows it under the person, the
  document page says when they are asked ("It goes out 2 days after Ana Silva has finished"), templates carry it,
  and a send, or a correction to an envelope that is out, whose waits would run to the deadline is refused in
  words. A signer can still read the document and its comments, ask a question, ask for more time, mute reminders
  and turn our emails back on while it is paused. API: `"send_at"` on `POST
  /api/envelopes/:id/send`, `POST` and `DELETE /api/envelopes/:id/send-later`, `POST /api/envelopes/:id/pause` and
  `/resume`, `"wait_hours"` on a recipient, webhooks `envelope.paused` and `envelope.resumed`.
- **See what each person sees** (`src/server/preview.ts`, `routes-preview.ts`). One link on step 3, above Who gets
  it, for a draft, a template or an envelope that is out (not when you are the only signer: Sign now opens that very
  page). It saves the draft and opens the signing page as the first person in a new tab, under a band that says
  "Preview. Nothing here is recorded or sent.", what that person is asked to do, the check they get before the
  document opens (an access code, a code by email or text: described, not asked), when their turn comes, and a
  "Whose view" list with Show to switch person, and "Close preview" (or, where the browser does not let a page close
  its tab, "Go to your documents"); the top bar keeps a "Preview" label while the document scrolls, and the save line
  says "Not saved: this is a preview". Someone who gets a copy is described as reading their copy, with no turn. The page is the signing page's own view: their documents, their fields, the
  others' values, notes, the consent text in their language, Download or print. Consent and "save as you go" answer
  and write nothing; Finish says it is a preview; every other button is refused. No audit line, no "viewed", no
  consent, no signature held or used (a signature a person adopted and has not put on the document yet is not
  shown), no email, text or webhook: not one row of the database changes
  (`tests/ds-preview.test.ts` compares every table before and after a whole session, for every role). The link
  lasts 15 minutes, opens only for the login that made it, signed in, in the browser it was made in (a key's maker
  in any browser of theirs), and stops when that login can no longer open the document. On an envelope that is out
  it shows what is saved, and says so when you have unsaved changes. API: `POST /api/envelopes/:id/recipient-preview`
  and `POST /api/templates/:id/recipient-preview` with `recipient_id`, which return the URL.

**Signing**
- No account and no app needed. Works in the browser of a phone or computer from 2023 or later (iOS 16.4, Chrome,
  Edge and Firefox 111: the floor of Next.js; the PDF viewer is the legacy build of pdf.js, which runs there too). A
  browser that cannot show the document says so, with a download, a link to copy into another browser and a way to
  ask the sender. `/help` lists the browsers (`src/lib/mobile.ts`).
- Consent to electronic records before any field opens: one tick next to one sentence, "I agree to sign this
  document electronically." (someone who approves or only reads: "I agree to review this document
  electronically."). One link under Continue, "How electronic signing works", opens the rest in place, so the
  box and the button never move: what kind of
  signature this is (a simple electronic one), what is recorded (the time, the IP address, each step), that rules
  differ by country and by kind of document and some documents need more than this, how to get a copy or paper,
  and how to say no, each person by the name their own screen gives it (a witness: "I was not there"; an
  approver: "Decline to approve"; someone who only reads has nothing to decline). The screen and the evidence pack
  ask one rule for whose words to use (`consentPart` in `src/lib/policy.ts`). Nothing says the signature equals a
  handwritten one. The wording has a version (`CONSENT_VERSION` in `src/lib/policy.ts`, `2026-11-23`) that names
  both the sentence and what the link opens. The audit trail records which version each person agreed to, with the
  time and the IP address, `/help` prints the words of every version ever shown, and the evidence pack prints for
  each person the sentence they ticked and, marked as such, what they could open. People who agreed under an
  earlier wording keep that one in their record. The screen refuses Continue until the box is ticked, and the server refuses
  Finish for anyone who has not agreed.
- Guided "Next" through required fields, which also opens the signature dialog or the stamp when that is what the
  field needs, progress bar. Pages at 100, 150 or 200 percent, Easy reading and the download under View. A tap on the pad is not
  taken as a signature. Finish without signal says nothing was signed and goes again by itself when the
  connection is back.
- "Your signature": made by typing (four handwriting styles for names in Latin letters, one plain style for other
  scripts), drawing or uploading. Saved signatures for account holders.
- Other actions, the same short list on the consent screen and on the document, never more than six: Finish later,
  ask for more time, pass to someone else, questions and comments (below), decline. Under it: Help, and the name you
  sign as with "Fix my name" (a bigger change is passed to the sender). Stop reminders is in the note after Finish
  later and in every reminder; report a request is in the footer. Download or print before agreeing and afterwards.
- Finish signs and sends at once. One more step comes only when something needs a look, and its title says what: a
  question of yours nobody answered, a witness to name, a typed signature that reads as another name than the one on
  the document (also after a reload of the page), characters the signed PDF cannot print, or a Finish that did not
  get through. When the check of the characters itself could not be made, the step opens and says so. Its button is
  Finish, the same word as on the page.
- The consent screen holds 120 words or fewer before its tick, counted on the screen itself (19 with a
  one-line message, since our own text went behind its link). A sender's message or
  private note that would take it over waits behind "Read the message", one tap away. A member of a signing group
  reads "For HR team." where the others read their own name, and what agreeing does for the group ("If you
  continue, you take this on for HR team...") stands between the tick and Continue; the full explanation of how a
  group works is in the email. Who it is for when it is not a signature takes three words ("Asked to approve",
  "Asked to read", "Asked to witness"). Measured at 390 px: 99 to 119 words for a signer, an approver, a reader, a
  witness, a group's member, someone checked by a one-time code and someone signing in person, with and without a
  message. Not held to that number: a very long subject or very long names. At 320 px wide the screen is about one
  and a half screenfuls.
- The first invitation gives the deadline in UTC, says so, and says that the signing page shows it in the reader's
  own time. When the same address told the same sender its zone on an earlier document, the invitation gives the
  deadline in that zone, named, and still points to the signing page (`src/server/zonememo.ts`; never from another
  sender or account, and never in an email to the host of an in-person signing). Once the person's device has told
  this document its zone, emails give their own time. The security code in the
  footer of a signing email is drawn again when it would spell a rude word.
- Sees what earlier signers already filled in.
- Questions and comments while the envelope is out (`src/server/comments.ts`, `src/server/routes-comments.ts`): from
  "Questions and comments" next to the document and in Other actions, each person on it and the sender's side write,
  about the whole document or a page of it. A comment is for everyone on the envelope or private between one person
  and the sender's side, and private is the usual for a person on it. Nobody ever reads a private thread they are not
  in: not on the page, in an email, through the API or in anything a recipient downloads. A private thread is with
  the person, not their place, so whoever takes a place over later (a hand-over, a corrected address) never sees it.
  Someone who signs in person on the sender's device sees the threads for everyone and their own, and the host's
  account is locked in that browser. When several people sign in person one after the other on one device, each
  one's private threads show only while that person holds it (`src/server/handlive.ts`): the next one going Back
  to an earlier page sees only what is for everyone and cannot write there. The sender gets one email about new
  comments, at most one every 10 minutes for each envelope (`COMMENT_MAIL_MINUTES`), with the comments in it; a
  person on the envelope is emailed when the sender's side answers them, under the rules of every email in the
  sender's name: nothing while sending is paused (it goes out once the pause is lifted), and the fake payment notice
  filter reads what that side wrote on the envelope in the last day together, with the names it is printed under,
  so a notice split over several comments or put in an admin's name is refused (`src/server/commentrules.ts`).
  Answers that the filter turns down at the moment of sending are not emailed, the sender is told by email and on
  the page, and later answers still go. What someone on the envelope writes for everyone, and what a public form's
  visitor writes, is read the same way with their name; a visitor's words reach the owner from us, never under the
  visitor's name or with the address they typed as the reply address. Someone with no address, who signs in
  person, marked our email as spam or whose address bounced is not emailed, and the screens and emails say so. The
  sender's envelope page lists the threads, who waits for an answer, and has Answer and Mark as settled. When
  someone presses Finish with a question of theirs unanswered, the check before finishing says so and lets them
  finish anyway. Comments are not printed on the document and are not part of what is signed: the audit trail says
  that a comment was written, by whom and when, never its words, and the export and evidence pack carry the threads
  in full. Once the envelope is no longer out they are read-only, and they go with the envelope, also out of the
  webhook log (a delivery sent again after that has no words and no name). Limits: 2,000 characters, 50 comments
  for each person on one envelope, 10 in 10 minutes for each signing link (`src/lib/policy.ts`), counted only for
  comments that are stored; the same words sent twice within seconds are kept once; marking a conversation as
  settled or open again 10 times an hour for each person, and one line about it in the audit trail an hour.
  The old "Ask the sender a question" is this now, so there is one way to ask.
- Company stamps and seals next to a signature (`src/server/stamps.ts`, `src/server/routes-stamps.ts`,
  `src/lib/stampink.ts`, `src/components/stamps`). A stamp looks like ink from a rubber stamp, not a picture pasted
  on top. When a picture is chosen (PNG, JPEG, or WebP where the browser reads it, up to 8 MB, from a file or straight
  from a phone camera; SVG, PDF and the rest are refused in words), the browser turns it into an impression on a
  canvas: the paper goes, judged for every part of the picture against the paper around it, so uneven light, a
  hard shadow and grey or coloured paper (brown kraft, yellow copy paper) go too; a desk round the sheet, solid dark
  areas at the edge of a photo, the ruled lines of lined paper, the crease of a folded sheet, the fibres of recycled
  paper and sensor noise go, without taking the ink that lies on them; a design prints solid, as rubber
  does, while a photo keeps the unevenness of the real impression, with the cut set part by part so faint small print
  stays; the marks become one ink (blue, red, purple, black or green), the likely one found in the picture and chosen
  first, and in a photo marks in another colour (printed black text beside a blue stamp) are left out unless asked
  for, with the stroke filled in where text crossed it; a design in several colours keeps every mark, with a thin gap
  where two colours meet; a round seal photographed at a slant can be made round again. Then the texture of a
  hand-pressed rubber stamp, sized in millimetres at the size it prints so it still shows at 150 pixels on a screen:
  one side pressed harder, patches short of ink, paper grain, small voids, rough edges with a little ink spread,
  and darker rims where ink squeezes to the edge of a stroke. Where a stamp is short of ink the paper shows through
  in grain and specks with hard edges; nothing fades to a paler tint, and the ink is one dull pad-ink colour, a
  little darker here and there. The words of a stamp keep at least about two thirds of their ink in every part; only
  its ring or frame may print thin, with a short stretch missing; a small seal gets less of all of it. The small
  natural tilt (between -4 and 4 degrees) is not drawn in: the page turns the picture when it prints it, so the stamp
  keeps the exact size of its field. All of it comes from a seed that is stored with the stamp, so the same settings
  give the same impression. The ink keeps the same small margin of paper round it whatever margin the picture came
  with, so a design cropped right at its outer ring is not cut flat at the edge. A before and after on a page of text
  shows it with the ink found and chosen; every other adjustment (what counts as paper, texture, tilt, cutting off
  the edges) is behind one closed fold, "Adjust the look", and the button that finishes stays in view at the bottom
  of the dialog. When much of a design is hairline at the size it prints at (small type, thin rings: lines under
  0.15 mm along 30 percent or more of its line work, `fineShare` in `src/lib/stampink.ts`), one line under the
  pictures says the rubber texture can break them up and to move "Rubber texture" towards "Even ink"; it goes once
  the texture is low enough, and it never stops anyone finishing. Someone with a second stamp field on the same document is offered the stamp they just put on
  ("Use the same stamp"), so it is made once. It is stored as a transparent PNG, written again by the server from
  its pixel data alone (no text, camera notes, palette or other chunk of the file is kept, and nothing after its
  pixels), and on the signing page and in
  the signed PDF it is multiplied into the page at 97 percent, so the words under it show through and there is
  never a box around it. Admins keep up to 10 stamps under
  Settings, Stamps and seals (a name, the picture, the ink, the seed and the real size, 40 mm across to start with); a
  stamp name typed by an account the checks apply to is checked like any other name. In the editor a Stamp field
  is either the sender's own stamp, part of the document from the start (a change after someone has signed needs
  the sign-again choice), or a signer's, who puts their own on when they sign from a picture, a photo or a saved
  stamp of their own account (only when signed in at the address the document went to, never on a device handed over
  in person). Changing or deleting a stamp never changes a document it is on. A stamp field is required or optional,
  Finish later keeps it, it is put on again when someone is asked to sign again, and it works in templates, bulk
  sends, public forms, signing groups and Easy reading. The audit trail says who put which stamp on which field and
  when, with the SHA-256 of the picture, the certificate lists it under that person, and the evidence pack and the
  export carry the pictures. A picture from a signing link is shown to nobody outside that envelope, one field holds
  one, and a link can put on 20 an hour. A stamp uses no signature. What it is, said wherever one is offered: a
  picture of a stamp that a person put on the document; GrowSigning does not check that they may use it, it is not a
  certified electronic seal, and it pays no stamp duty.
- **The account's own consent text.** Admins write it under Settings, Sending, More options, "Your consent text",
  one per language that is switched on: the organisation's name, how to reach it (email, phone or postal address,
  at least one), how to ask for a paper copy and what it costs, how to stop agreeing to electronic documents and what
  follows, what a person needs to read the documents (our own sentence when left empty) and anything else. Each save
  that changes a word is a new version, numbered per language; a saved version is never changed (a database trigger
  refuses it) and never deleted while a document refers to it. Settings lists the earlier versions with the number
  of documents next to each, and says: "If you deal with consumers in the United States, the ESIGN Act section
  101(c) lists what this text must say. Ask your lawyer." GrowSigning shows the words as written and does not check
  them against any law. On the consent screen the text sits above the box, and our own link, "How electronic signing works",
  always stays under Continue: in full while the screen stays at 120 words before the tick, otherwise behind "Read
  <Org>'s terms". A person whose language has no text reads the English one with the sentence that it is in English;
  with no English one they see only our words. Under the text, "Ask people to agree" chooses once for each document (the
  default) or every time the link is opened ("Agreed again" in the audit trail, at most once a minute and 50 times
  for one person on one document). The screen sends back which version it showed; a screen left open while an admin
  saved a new one is shown the new one first. The consent line of the audit trail names that version, its language
  and its SHA-256 next to our own wording, and the evidence pack holds the exact words each person was shown
  (`consent-own-text.txt`). With a text, Other actions has "Sign on paper instead", whose one choice "Ask <sender> to
  send it by post (stops signing electronically)" closes that person's part like a decline, with the reason
  "Withdrew consent to electronic records" (or "Did not agree to electronic records" before they agreed), emails the
  sender whatever their notification choices, and puts "withdrawn" and the time on the certificate's E-record
  consent line. Only that action marks a person as asking for paper (`paper_at`), never the words of a reason, so a
  decline that types the same words stays a decline. The sender's document page then says "asked for this document
  on paper" with no Copy and fix button, and the line pointing to Other actions is shown only to someone who has
  that entry (not a viewer, a copy or a witness). An account that has not paid yet cannot save a text that reads like a payment notice from a
  well-known company. API: `GET` and `PUT /api/account/disclosure`, `GET /api/account/disclosure/versions`,
  `POST /api/sign/:token/decline/paper`. With no text saved nothing on any screen, line or file changes.
- **Signing on paper** (`src/server/paper.ts`, `src/lib/paper.ts`): off until an admin switches on "People may sign
  on paper" in Settings, Sending, card "When people sign". Then a signer or approver may print the document, sign it
  by hand and send back a photo or a scan through their own link, unless the sender chose "On screen only" in that
  person's More ("How they sign"); "On paper only" leaves them no electronic signing (Finish is refused, 409
  `paper_only`). Never for someone who signs in person, a signing group, a witness or a signer with a witness, a public
  form, a document that asks for a payment before finishing, or a delegate's link. On the signing page Other actions
  has one entry, "Sign on paper instead": "Print it and send a photo", and, with the account's own consent text, the
  existing "Ask <sender> to send it by post". The print is a cover page that says how to send it back, then the
  document with the person's places marked ("Sign here", "Initial here", a dashed box to write in), and on every page
  the envelope ID, "Page x of y", their name and a security code that changes whenever the document changes. The
  upload takes a PDF or up to 50 JPEG or PNG photos (made smaller in the browser, never cleaned or changed), up to
  25 MB, as one document. The person then shows "Signed on paper, waiting for the sender to check": nobody after them
  is asked, no reminder goes to them, and the sender is emailed. The envelope page's main button becomes "Look at the
  scan", with "Accept as signed by <name>" (refused for a scan of an older version) and "Ask again" with a reason,
  which is emailed (through the same fake-notice guard as every email, and not to an address that marked ours as spam)
  and shown where they land on their page, above the agreement or the document, with "Send them again". Home and
  Documents list a waiting scan as "Waiting for you: look at the scan" with "Look at the scan" in place of Remind, and
  a reminder asked for anyway is refused with that reason. A scan belongs to the person who sent it: after a correction
  to another person (another address, or another name at the same one) it is set aside and kept on record, and
  cannot be accepted as the new person's; someone asked to sign again after an accepted scan signs the new version
  again, on screen or on paper. The print carries no signing link (paper lies about) and no "Signed with" badge. The
  sender, an admin
  or a colleague with a "manage" share may decide. Accepting finishes the person through the one completion path, as
  of that moment and from the address the scan came from, so it uses a signature like any finished signer. The signed
  PDF has their scan after a page "Signed on paper by <name>", their places read "Signed on paper: see page N", and
  the certificate gives the status "Signed on paper", "E-record consent: Not asked: signed on paper" when they never
  agreed, and "Signed on paper. A scan was uploaded through this person's link on <time> from <address> and accepted
  by <sender> on <time>. GrowSigning did not check the handwriting." Such a document's certificate leaves out the
  "Signed without paper" box, and their Done screen leaves out the paper-saved card. API: `allow_paper` and
  `require_paper` per recipient, `GET`/`PUT /api/account/paper`, `GET /api/sign/:token/paper/print`,
  `POST /api/sign/:token/paper`, `GET /api/envelopes/:id/paper`, `GET /api/envelopes/:id/recipients/:rid/paper/scan`,
  `POST /api/envelopes/:id/recipients/:rid/paper/accept` and `/reject`.

**After signing**
- Final PDF with every value stamped in, signer attachments appended, and a certificate of completion:
  recipients, timestamps (UTC, and the signer's local time with its zone when their device reported one), IP
  addresses, consent, signature images, document hashes and the full audit trail. "Every value" holds for the
  scripts listed under "Scripts and fonts in the signed PDF" below. A character in any other script is printed as
  a visible mark and listed in the certificate, and both sender and signer are told before signing.
- Audit trail is hash chained. Editing a past event without recomputing every later one breaks the chain, and the
  app shows it. The chain has no secret key and lives in the same database, so whoever can write to that database
  could rewrite it unnoticed by the app; the chain head printed on the certificate in everyone's copy is what would
  show it, for the lines up to completion only: lines written after it (the copy emailed and opened, visits,
  disputes) are protected by nothing outside the database (`CHAIN_TRUTH` in `src/lib/evidence.ts`, which the pages
  quote).
- Public `/verify` page: drop in a PDF and see whether it is, byte for byte, a completed document we hold. A match
  shows the file is unchanged since signing finished, not who was behind each signature. No account needed. A "no
  match" lists its possible causes. After a sender deletes their account, the SHA-256 of each completed signed PDF,
  its envelope ID and its day are kept for a year (`forgotten_files`, nothing else), so the page can still say "completed
  here on that day, deleted since". A dispute that was open at the deletion keeps the envelope ID, the file's
  fingerprint, the day of the dispute and the state of the envelope (`forgotten_disputes`, no names) until a person at
  GrowSigning closes it, so both lookups keep saying "disputed".
- `/verify?id=env_...`: the holder of a printed copy looks the envelope up by the ID at the foot of every page:
  completed, voided, declined or ran out of time and when, pages, how many were asked to sign and did, the
  fingerprint of the signed file with "Choose the file to compare" (hashed in the browser), and whether it is
  disputed. Never a name, an address or the title. 60 lookups an hour per connection (`GET /api/public/verify/:id`).
- Everyone gets the completed copy by email, with the SHA-256 fingerprint of the signed PDF in the email itself.
- What happens after signing is in the live audit trail (the certificate is sealed at completion): the completed
  copy handed to the mail server for each person (or not emailed, and why), the first time each person opens or
  downloads it (with internet address and browser), and later visits, at most one line a day for each person. For
  an envelope completed before this was written down, the first open recorded says it is the first since then.
- A digital seal of the server in every completed PDF, when the operator sets a seal certificate: an invisible PAdES
  signature (B-B, or B-T with a time-stamp service) that a PDF reader checks by itself (checked here with poppler
  and OpenSSL; not yet opened in Acrobat), a "Digital seal" line on the certificate saying what it is and is not,
  and `/verify` checking the seal of a dropped file next to the byte-for-byte answer, including a file someone saved
  more into after the seal, and never vouching for a file put together around a seal taken from another. See "The digital seal of a
  completed PDF". With a time-stamp service, the seal also carries what is needed to check it after its certificate
  has expired (B-LT, B-LTA), and the record's chain head at completion is time-stamped, printed in one certificate
  line and put in the evidence pack with the OpenSSL command that checks it (see "Long-term checking and the
  record's time stamp"). An uploaded PDF that already carries signatures is said to lose them: the signed copy is made from
  the pages as they look.
- Completed files as PDF/A-2b, an archive format some archives require, when the operator installed veraPDF and an
  admin switched on "Archive format (PDF/A)" (Settings, Records and data, More options; off by default). The file is
  called PDF/A only when veraPDF passed the stored file itself: "Archive format: PDF/A-2b, checked with veraPDF
  <version>" on the certificate and under "Checks on the file". Otherwise it is made as a normal PDF that says why in
  a few words and what to do next time. The last signer is not kept waiting for the check. See "Archive format
  (PDF/A)".
- A copy of an envelope that was voided, declined or ran out of time, whether the sender or a signer downloads it,
  opens with a page that says why and is marked across every page ("VOIDED, NOT A SIGNED DOCUMENT"): large in the
  middle, in small dark rows over the whole page so a corner cut off or a black-and-white copy keeps it, at the top
  and the bottom, and over every signature, initials and stamp (`src/server/stamp.ts`). A copy made while it is still
  out is marked "NOT COMPLETED YET, NOT EVERYONE HAS SIGNED" the same way.
- "I did not sign this, or this was not me", on the signing page and with the security code on `/check`, also for a
  completed document, and with the code of any email we sent that person, also after the sender changed the address,
  took them off, or someone passed it on through their link: the envelope is marked as disputed (its page, `/verify`),
  the audit trail says who said it as far as we know (no internet address or browser on that line), the sender is
  told when and what was written, the operators the same plus the internet address and browser, in their queue, and
  nothing is changed or deleted. While a dispute is open its sender cannot delete the envelope for good. A person at
  GrowSigning closes it from the queue, or with `POST /api/operator/disputes/:id` as "handled" or "in_error" (filed in
  error, which `/verify` then says next to the mark). A help topic of the same name is never passed on to the sender.
- "Full record for disputes", in More on the document's page (`GET /api/envelopes/:id/evidence`, called the evidence pack in the API): the signed PDF, the certificate
  alone, the audit trail as text and as JSON with every chain value and how to recompute them, every stored email
  about it with its hand-off result (signing links and security codes taken out), the consent wording each person
  agreed to, the disputes with what each person wrote, and a README that says whether a person or an API key made it.
- `/security/certificate`: "How to read a GrowSigning signing record", every line it prints, where it comes from, what it
  shows and does not, dated (`CERTIFICATE_PAGE_VERSION` in `src/lib/evidence.ts`). A test fails when the certificate
  prints a line the page does not explain.
- Keep and delete (`src/server/records.ts`, the words in `src/lib/retention.ts`; on screen the words are Delete
  after, Keep it, Hold and Deletion record, the API keeps `retention`, `purge` and `level`). Settings, Records and data, the
  card "Keep and delete", for admins, off by default: two lines, "Delete completed documents after [ ] days" and
  "Delete cancelled, declined and expired ones after [ ] days" (`days` and `stopped_days`, each 30 to 9,999 days
  counted from the day the document ended; empty keeps them), then "At the end": delete the files (pages unless a
  template or another document uses the file, the signed PDF, copies from before a correction, signer attachments,
  stamp pictures, email attachments), or also remove names and answers and keep the record (answers, signature and
  initials pictures, comment words, decline and cancel reasons, the words of our stored emails; names, addresses,
  phone numbers, internet addresses and browsers replaced by "Removed on" and the day, the message, names in the
  title, our email copies, the text and webhook logs, and the name and words of a person who disputed it in the
  account's copy). A level in between, files and answers, is offered by the API only. The long rules are behind
  "How this works"; a schedule name and code, templates with a period of their own, and "Delete one document's
  files for good" are behind the card's More options. A save that would reach documents at once says how many
  first. The timer emails the sender and every admin at least 14 days before: one email for an account at most
  every 7 days, listing what is due in the 21 days after it, each row with a Keep link that opens the Keep dialog
  on the document's page (`?ask=keep`). Nothing goes sooner than 14 days after its email, a level raised after it
  applies from the next one, and switching a line off calls off what it announced. On the document page there is
  no card and no banner: one sentence under the status says the day its files are deleted (with "Keep it" once it
  is announced), that someone asked for it (with "Call it off"), that it is on hold, or that its files were
  deleted; with nothing set up the page shows none of it. With a schedule on, the page's More lists "Keep it"
  (sender or admin, a reason in the history, one more period) and, for admins, "Hold", and the one Delete dialog
  says the day the links of the people on it stop, offers "Keep it until <day>" when keeping gives it longer than the
  schedule already does (not on a document completed today), and links to "Delete its files for
  good" (sender or admin, 14 days, called off until then, then for good; the people on it are not told). With no
  schedule the Delete dialog is as it was, and an admin holds a document or deletes one document's files from
  Settings. Holds (Settings, "Hold a document" by its name or "Hold a folder", with a reason and an optional case
  reference): a folder hold covers what is in it, what is put in it later and what leaves it afterwards. While a
  hold is on, Delete (also when it would only take the document out of its sender's lists), deleting its files,
  the timer, closing the account (refused with the list of holds) and `purgeUser` are refused and each attempt is
  in the record; a held draft cannot be changed; the page offers no Delete; a member sees that it is held, not
  why. An admin lifts a hold with a reason; the people who run the server can lift one when a court order or their
  legal duty requires it, as two people (one asks, another confirms within 7 days, `POST
  /api/operator/holds/:id/lift`), and the admins are emailed. An open dispute also keeps a document from having
  its files deleted, and a closed one stays marked: `/verify` by file and by number still says it is disputed
  after the files are gone. After a deletion the document keeps its record: the history with its chain values,
  the changed lines marked, so the page says "Some details were removed on <day>. The record can no longer be
  recomputed for those lines." instead of "Record was altered" (any other change still shows; a mark counts only
  with the time of that deletion, and like the rest of the chain it does not stop someone who can write to the
  database, who could mark more lines or rewrite them all); the fingerprint of
  its signed PDF, so `/verify` says completed here and deleted since; recipients' links say the sender deleted it;
  downloads, the full record and copies say why they are not there; the export lists it. What stays is listed in
  full, including the address book (Contacts keeps the people you sent to). Every schedule change, keep, hold,
  lift, deletion and refused attempt is in the account's deletion record (never changed; "Download the deletion
  record" in Settings once it has a line, a CSV with the fingerprint of each deleted PDF, and the same record as a PDF to
  print or file, `src/server/deletionpdf.ts`; an admin's export carries it as `deletion-record.csv`, so closing the account
  does not take the only readable copy), and in the security
  record. API: `GET`/`PUT /api/account/retention`, `POST`/`DELETE /api/envelopes/:id/hold`, `POST`/`DELETE
  /api/envelopes/:id/purge`, `POST /api/envelopes/:id/keep`, `GET /api/envelopes/:id/retention`, `POST
  /api/account/retention/holds`, `DELETE /api/account/retention/holds/:id`,
  `GET /api/account/retention/log`.
- Copies of every email for a records office (`src/server/archivemail.ts`, `src/server/routes-archive.ts`, the rules
  and words in `src/lib/archivemail.ts`). Off until an admin adds an address under Settings, Records and data, "Copies of
  every email": up to 5. Each address is emailed a link (it works for 7 days) and gets nothing else until someone
  with that inbox presses Confirm on the page it opens (`/archive-confirm`); opening the page changes nothing, and
  "No, do not send copies" there, or marking that email as spam, stops that account from asking the inbox again
  for 30 days. The email that asks can only be sent by a login that confirmed its own address, to one plain
  address (no name, brackets, quotes or comma), 3 times a day for one inbox and 10 for the account; the limits and
  the "no" hold for the address with or without a "+tag", and at Gmail with or without its full stops (gmail.com
  and googlemail.com count as one), though not for other spellings a mail service may treat as the same inbox (an
  alias, a second address that forwards). A name of the account or the person that reads like a well-known brand
  or a payment notice is refused while the account's checks apply, and left out of that email for any other
  account. An address that marked an earlier email from the account as spam
  cannot be added. Once 3 different inboxes have marked the asking email as spam within 30 days, the account asks
  no address at all until the oldest of those marks is 30 days old (confirmed addresses keep their copies); the
  marks do not pause the account's sending. From then on every email the
  account sends about one of its envelopes (requests, reminders, deadline warnings, the completed copy with its
  PDF, declined, voided, corrected, comments, and the emails to witnesses and group members) also goes to each
  confirmed address, as an email of its own and never as a Bcc header, once the email it copies has left. The copy
  starts with "Archive copy of an email sent to <address> on <time>", carries the same attachments, and has every
  link that opens something replaced by "(link removed in this copy)" and every security code and one-time code by
  "(code removed in this copy)". Copies are stored and tried again like other emails, are not one of the
  envelope's own emails (not on its page, in its record or in the evidence pack), never count towards the daily
  sending limits, never mark a recipient as bounced, and wait while sending is paused on the account. Three copies
  that come back for good with none arriving in between, or a copy marked as spam, pause the address: the admins are
  emailed and see it in Settings, and emails sent meanwhile are not copied there later. That needs
  `MAIL_EVENTS_TOKEN`; without news from the mail provider an address that stopped working is not noticed. Adding
  and removing needs a person signed in as an admin (an API key can only read), is written in the security record,
  and the owner and admins are emailed when an address starts taking copies, is removed or is paused. Members see
  one line saying that copies go somewhere. Signers are not told; `/security` lists archive addresses under "Who
  can see your documents". Our stored copies go when the envelope is deleted or purged at any level, with the
  files only they held, and a copy still waiting then is not sent. API: `GET`/`POST
  /api/account/archive-addresses`, `DELETE /api/account/archive-addresses/:id`.
- Refusing to hand an email over unencrypted (`SMTP_REQUIRE_TLS=1`, `src/lib/mailtls.ts`). The mail library is
  told `requireTLS`, and nothing in `SMTP_URL` switches that off: a mail server that offers no STARTTLS gets
  nothing, the email is kept and tried again, and the envelope page says why in our words. `/security` says
  whether the rule is on. It covers one step, from this server to the mail provider in `SMTP_URL`. How the
  provider carries each email on to the recipient's mail server is decided by the provider and the recipient's
  side (MTA-STS or REQUIRETLS there), not by this software, and none of it is end to end encryption.
- Details on each envelope, such as a case number, a cost centre, a grant or a ward (custom fields:
  `src/server/customfields.ts`, the rules in `src/lib/customfields.ts`). Nothing is shown anywhere until an admin
  adds one under Settings, Sending, "Details on each document": up to 20, each a line of text or one of a list of
  up to 50 choices, required when sending or not, printed on the certificate or not (printed unless switched off).
  Whoever sends fills them in on the last step of the editor, under Details, right below the title; a required one
  without a value stops the send, and the screen says which and puts the cursor in its box. Sending straight from
  a template ("Use", "Send now") asks in that dialog for the required ones the template does not fill in. A
  template carries starting values; in a bulk send a column named like a detail fills
  it for that row, and every row is checked before anything is sent; a public form uses its template's values,
  and a form whose template lacks a required one takes nobody and its owner is told. Values are one line of up to
  100 characters, in any script; characters that cannot be seen or that turn text around are refused in names and
  values (a joiner between two letters, as Persian and the scripts of South Asia need, stays), and a value with
  nothing in it to read is no value. Two names that differ only by such a character are one name. Names that look
  alike because they mix scripts (a Cyrillic letter in place of a Latin one) are not told apart. On a document
  that is out a value can be put right on its own page, under Details, with a line in the audit trail, and nobody
  signs again; once it is completed the values can no longer be changed. A value under a detail that was deleted
  since can be taken off and not changed. The list of documents filters by one detail behind "More options"
  (capitals do not matter; a text value by how it starts, a list by the whole choice), and can show one as a
  column; the envelope page lists them in a folded "Details"
  section; `envelopes.csv` in the export has a column for each, and a cell or header that starts like a formula
  gets an apostrophe in front; webhook payloads carry them. The certificate of completion prints the ones marked
  for it under "Details given by the sender (their words)", with a line saying nobody checked them. A printed
  detail in a script the certificate has no font for (see "Scripts the signed PDF can print") shows there as
  replacement marks: the admin is told when adding it, and the sender on the last step and on the document's page.
  They are never on the signing page. For the accounts the fake-notice filter reads, the printed ones go
  through it like any other words of the sender. Changing a detail's name or choices follows into drafts and
  templates and never into an envelope that was sent; deleting one keeps the values on sent envelopes, which can
  still be filtered and exported by the old name. A purge at the level that removes personal details removes the
  values as well. Through the API a document can also carry up to 20 name and value pairs of its own
  (`documents[].fields`), which are kept, copied with templates and sent in webhooks, and are not shown on any
  screen. API: `GET`/`POST /api/custom-fields`, `PATCH`/`DELETE /api/custom-fields/:id`, `custom_fields` on
  `POST`/`PUT /api/envelopes`, `PUT /api/envelopes/:id/custom-fields`, `GET /api/envelopes?field=&value=`. A send refused for a missing
  required detail answers 400 with `"code": "details_missing"` and the names in `"missing"`.

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
  its SHA-256 is stored on the request. Our stored copies of the emails about the request hold the link, like every
  email we keep, until they are deleted with the request or after 90 days (`MAIL_COPY_DAYS`). The link is never given to whoever fills in the form, only to the mailbox: holding it is the proof of having
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
- `/help` shows the real median time to a first reply from a person (an answer, or a question back to the writer,
  which is also what stops the clock) over the last 30 days, with how many requests it covers,
  only when that is at least 10. Otherwise it shows the target only.
- Limits, counted in the database, so the link and the form cannot be used to bury the people who answer or to
  fill a stranger's inbox, and so a stranger can never shut the owner of an address out. What the owner writes
  (signed in under the address as a confirmed one, or through the link): 10 messages a day on one request and 30 a
  day from the address. What anyone else types under an address: 3 requests a day, and 3 open at once, whichever
  device they come from (`SUPPORT_OTHERS_PER_ADDRESS` in `src/lib/policy.ts`); each sends the address one email, so
  that is all a stranger can send someone. The two never mix, and the answer to a question of ours is always taken.
  No API key can use the support routes or the operator routes, and the form refuses a key and a post from another
  site that carries a session: they are for people.
- "Send me the links again" (`POST /api/public/support/find`) answers before it looks anything up, so it takes the
  same time whether or not the address has written to us. The email follows a moment later, without the requests
  the address said it did not write or that we closed as not theirs.
- When the mail server will not take an email to the customer, the operator's screen says so, the request's
  history says so, and the email is tried again by itself. If an email with an answer, a question or a closing
  answer is given up, whoever has the request (or else `SUPPORT_EMAIL` or the operators) is emailed; any other
  email that is given up is noted in the history and on the opened request. The opened request shows the whole
  address the answers go to.
- Deleting an account deletes its requests with their threads. One that is still waiting for an answer, or for
  the customer's reply to a question of ours, is kept until it is answered (the answer is emailed, then the request
  is deleted once the mail server has taken that email) or, for an unanswered question, for 30 more days. A
  request written while signed in under somebody else's address stays with that address. The alerts filed under
  an operator's address stay when that operator leaves.
- A closed request that belongs to no login is deleted 90 days after it was closed (`SUPPORT_KEEP_DAYS`), with its
  thread and our copies of the emails about it.

**The help chat**
- One entry on a screen, called "Help": in the public header (in the menu on a phone), at the foot of the app's
  menu, in the editor's bar, and in Other actions on the signing page, where it never floats over Finish or the
  fields. The help page is a link inside it ("The help page"). What a person sees first is the question box with
  three suggested questions for that screen. Above the conversation there is nothing, unless a model answers:
  then one line, "Answers are written by AI and can be wrong. Do not type passwords or card numbers." What is
  kept is behind "What we keep" at the foot. "Talk to a person" is under the latest answer (in the foot before
  there is one), and the form it opens does not ask a signer or a signed-in member who they are again. A dialog
  (`src/components/HelpChat.tsx`): focus stays inside, Escape closes it, answers are read out a sentence at a time
  as they arrive, 44 px targets, reduced motion respected. Nothing on the page underneath is touched. Closing it
  while an answer is on its way stops the request, and the server stops the model, so nothing more is paid for;
  the next time it opens, a note in place of the answer says it was stopped.
- Who answers: an AI model through any host that speaks the OpenAI chat API, from the settings, first match wins
  (`SUPPORT_CHAT_API_KEY` with `SUPPORT_CHAT_BASE_URL` and `SUPPORT_CHAT_MODEL`, then `MOONSHOT_API_KEY`, then
  `OPENROUTER_API_KEY`), by default Kimi K3, the open-weights model treegens.app uses. No temperature is sent
  (Kimi K3 refuses any but 1), little thinking is asked for, and asked once more without that after a refusal;
  1200 tokens, because thinking counts. Without a key, past a limit, or when the model is down, slow (55 seconds)
  or says nothing, the built-in answers reply (`src/server/chatkb.ts`), and the answer says which. With
  `DEPLOYMENT_PROFILE=government` or `OUTSIDE_CALLS` listed or none, only a model inside the server's own boundary
  answers: `SUPPORT_CHAT_BASE_URL` at a private network address (not a known cloud metadata address) or a host in
  `OUTBOUND_ALLOW`, never OpenRouter or Moonshot AI however their address is written (a dot at the end, a port, any
  name under openrouter.ai, moonshot.ai or moonshot.cn) (`src/lib/chatboundary.ts`; running vLLM, llama.cpp or
  Ollama for it: `docs/self-hosted-model.md`). `/security` says "nothing is sent to train a model" only for a model
  at a private address; for a hosted one it says that the provider's own terms decide what it keeps and trains on.
  An account's "AI answers in the help chat" switch (or its organisation's) holds for its people, its signers and
  the people who came from its forms and agreement pages (`?form=` on /help, `src/server/chattenant.ts`). In the
  app, the foot of the dialog says "Answers come from <model> on <host>."; signers and visitors never see a model
  or host name, and the API does not send them one. A visitor who opens /help without the `?form=` of the page they
  came from is not known to belong to that account, so the account's switch cannot reach them there.
- What it knows: a system prompt built on the server from `src/lib/policy.ts` and `src/lib/impact.ts` (prices,
  the refund and price rules, cancelling, deadlines, limits, closing and what is kept, who can see documents, the
  consent wording, no BAA, the language note), every topic of `/help` and "What is not in it" below, both read
  from the help page's source and from this file while the server runs (`src/server/chatsources.ts`, so an edit
  reaches the next question; on a server that ships neither file the helper is told it does not have them and
  offers a person), and the built-in answers. It also knows what is on the screens, by label
  (`src/server/chatscreens.ts`): the entries of Other actions on the signing page, typed against the page's own
  list so a new entry does not compile until the helper has words for it, and the buttons of the app a sender
  uses, each read out of the source of its screen in the tests. The built-in answers cover what a signer and a
  sender most often ask ("I cannot sign this today", declining, passing it on, a question for the sender, where to
  sign, a Finish that will not go, sending, adding people, who has signed, voiding, templates, the team) and name
  the control on the screen the person is on: "On this page, choose Other actions, then Finish later" on the
  signing page, how to get there anywhere else. They are chosen by the words typed, in English only, and by the
  screen: on the signing page only a signer's answers are given (never a price, a plan or a word like
  "envelope"; "Do I have to pay?" gets "Signing is free for you"; a sender's question is pointed to the help page
  and to a person), and "I did not get the email" is answered for a signer there, for a sender in the app, and
  for either on the help page. Each is a few short sentences; the edge cases are on the help page. On the signing
  page an answer about Finish later, more time, passing it on, a question for the sender, declining or the
  spelling of a name comes with a button for that entry of Other actions: the server names only the entry's key,
  the page supplies its own label (with the sender's name) and its own action, and pressing it closes the help
  and does what that entry does. A link that only opens something to read is labelled "Read: ...". It says it is an AI
  and can be wrong, that the rules on the pages count, gives no legal advice, never judges whether a signature is valid or enough for a
  document, never promises a refund, answers in the person's language and says the screens are English. An
  answer that still reads as saying a signature is valid, binding or enforceable or sure to stand in a dispute, or as promising a
  refund, gets a correcting line at its end (`src/server/chatguard.ts`), unless the words just before the claim
  take it back ("not", "whether"), or the sentence is about how long a link or a code works ("your code is valid
  for 10 minutes"). It knows English and the common phrasings in French, German, Spanish,
  Portuguese and Italian, so it is a backstop, not a guarantee. Em dashes are taken out. An answer is cut at 8000
  characters, and a host that sends more is stopped there.
- What it sends: only the typed chat (the latest 12 messages, each cut to 1500 characters) and which kind of screen
  it is (`CHAT_SCREENS` in `src/lib/chat.ts`). Before a question leaves the browser, and again on the server,
  what looks like a card number (also with full stops between the groups), a private link, a code from our emails
  (also in small letters), a password (also a plain word after "my password is", several words in double quotes,
  the word for a password in German, French, Spanish or Portuguese, or after a login written as
  "name / password") or an email address is taken out, and the person is told. It catches the usual ways of writing
  them, not every one, and the dialog says so. Names, street addresses, phone numbers and bank account numbers are
  not looked for. Only answers the server signed, together with the question they answered, go back to the model as
  the helper's, and only those are marked as checked for the operators.
- What it keeps: nothing of the chat. Counts of questions, under keyed fingerprints of the internet address, the
  signing link and the account (`chat_counts`), for up to two days. A chat sent to a person is stored with that
  help request (`support_requests.chat`), shown to the operators with each helper line marked as checked or not,
  never emailed and never passed to a document's sender.
- Limits (`src/lib/chat.ts`): 8 questions a minute and 60 a day from one internet address (an IPv6 /64 counts as
  one), 40 a day from one signing link, 300 a day from one account, and `SUPPORT_CHAT_DAILY_LIMIT` for everyone.
  Past any of them the built-in answers reply and the person is told which limit and until when. More than 60 a
  minute from one address is refused, and so is a question whose conversation is over 512 KB (the dialog never
  sends that much). `SUPPORT_CHAT_DAILY_LIMIT=0` means no model at all, said as for no key. API keys and posts
  from other sites are refused: the routes
  (`GET` and `POST /api/public/chat`) are for the app's own dialog and are not part of the public API.
- It takes no action. Under each answer are the tools that fit (Find my documents, Find my subscription, Stop
  billing with my card, Check an email, Verify a document, Fix my name, Ask for more time and a few help topics) and
  "Talk to a person".

**Reuse and scale**
- Templates with named roles, shared with the team: everyone can use them, and only the person a template belongs
  to or an admin can change or delete it. The templates page searches every word of the name, roles, folder and
  document, filters by folder and moves templates between folders.
- What each role can do (Settings, Team, More options; src/server/perm.ts). Owner, Admin and Member behave as they
  always did. An admin can make up to 20 roles of the team's own: each starts from Admin (and sees the admins'
  screens) or from Member, and leaves out any of sixteen things (send documents, use templates, make templates,
  change other people's templates, see every document, Send to many, Forms, website terms, contacts, contact
  groups, stamps and seals, reports, API keys of their own, webhooks and team-wide keys, team, account settings).
  Exporting everything and bringing documents in need both "See every document" and "Account settings". A made
  role never has the plan and payments, and handing the account over stays with the owner. Made roles appear in the
  same role list as Admin and Member, on the Team list and on an invitation. Every route of the API is checked
  against one table, route by route, and a test fails when a new route has no line in it. An API key keeps its
  scope and never does what its maker's role leaves out. Nobody gives a role (on an invitation, on the Team list or
  through a group, themselves included), changes a role, or changes or removes a person, that can do more than their
  own; the role lists offer only what the person may give. A role in use cannot be deleted, and a role from Member
  that leaves nothing out is refused as the same as Member. Groups of members (named sets of people of
  the team) can be chosen as a whole under a template's "Who can use this", and a group can give everyone in it one
  of the team's roles. Every change to roles, groups and who is in them is a line in the security record.
- Who can use a template: everyone on the team (the usual), admins only, or chosen members. Who can change it: its
  owner and admins (the usual), chosen members as well, or everyone. And a lock on its wording: someone who may not
  change it fills in names, addresses and the fields left empty, and cannot change the documents, the fixed
  wording, the fields, the message, the payment link, who signs in what order (no signing group in a person's
  place) or the private note and the checks the template gives each person; the subject stays theirs. Set by the
  person it belongs to and admins under "Who can use this" (a sentence says the rule, the list shows "Admins
  only", "Chosen members" or "Wording locked"), written to the template's history, and kept for a browser and an API key alike everywhere a
  template is listed, read, used, sent in bulk, copied, published as a public form or deleted. A template someone
  may not use is not listed, its documents cannot be opened by their file id either, and a refusal says who to
  ask. A copy keeps the rule and the chosen people, and a copy of a template that is locked or not for everyone,
  made by someone who may not set its rules, stays with its owner, with a history line saying who made it. The
  owner and admins of the account can always use and change everything, and a bulk column may change the
  template's own values for them. Locking holds for envelopes started from then on (one started before cannot be
  copied into a new unlocked one by someone the lock is for), unlocking frees the ones already started, and
  deleting the template leaves them locked for everyone but admins and the person it belonged to. Someone who
  leaves or is removed comes off every list of chosen members, with a line in each template's history.
  (`src/server/tplroles.ts`, the columns `tpl_use`, `tpl_change`, `tpl_locked`, `wording_from`, `wording_fixed`,
  `wording_people` and `wording_owner` on `envelopes`, and the table `template_members`;
  `GET` and `PUT /api/envelopes/:id/access`.)
- A link to the sender's own payment page ("Pay the deposit", "Pay the retainer", "Pay the fee", "Make the
  payment"), set on the last step of the editor, on an envelope or a template (`src/server/routes-paylink.ts`).
  Only for an account with a payment at least 14 days old that was not refunded or disputed, or one a person
  cleared, and checked again every time it would be shown, so a pause, a dispute or lost trust takes every link off
  at once. It must be https on a public site name: no IP address, port, name or password in it, not this server,
  no name kept for private networks and no link shortener or forwarding page (the list is in `src/lib/paylink.ts`),
  at most 500 characters as the browser opens it. Its name is asked of the DNS when it is saved and again each time
  it would be shown (`src/server/paydns.ts`), so a name that leads into a private network is never shown. Each
  person who signs and is not on the sender's team sees it after Finish, with the name of whoever saved it and the
  full address, never once the envelope was voided, declined, expired or deleted. The address is never put in an
  email, a certificate, an export, an evidence pack or a webhook: the audit trail names it by a fingerprint
  (`src/server/paydrop.ts`). A link belongs to whoever saved it and is taken off when they leave the team, which
  the envelope page says. GrowSigning takes no part in the payment, cannot tell whether anyone paid and does not
  check where the payment page sends people next; the envelope page says who was shown which address and who was
  recorded pressing it, and the owner and admins are emailed once when signers stop being shown the account's
  links. Once an envelope is completed or closed the link can only be removed.
- Payments while signing (`src/server/collect.ts`, `src/server/routes-collect.ts`, words in `src/lib/collect.ts`;
  tests in `tests/ds-pay-collect.test.ts`). Only on a server with `STRIPE_CONNECT_CLIENT_ID`,
  `STRIPE_CONNECT_WEBHOOK_SECRET` and a platform key, and never with `BILLING_MODE=deployment`; elsewhere nothing
  offers it. An admin connects the account's own Stripe account (Settings, Sending, "Take payments", Stripe's
  connect page; the answer is used once, by the person who started it, within 15 minutes), and can disconnect it
  there. The same trust rule as the payment link decides whether an account may connect and ask. On the last step
  of the editor, More options, "Ask for a payment" is then one card: no payment, by card here, or the link to your
  own payment page (one or the other, never both). A payment has an amount (fixed, or the amount in a number or
  calculated field of the document), a currency, what it is for, and when: after finishing (signing never waits; the
  Pay screen comes between Finish and Done, with "Not now" going on to Done, where one line keeps "Pay now") or before finishing (Finish answers "pay first", nothing is signed, and the
  person's part completes only once Stripe confirms; what they signed is kept until then). It goes with a template
  to every document made from it. Each person who signs and is not on the sender's team is asked; the document
  screen says so in one line before they sign. They pay on Stripe's own Checkout page, made on the connected
  account (a direct charge: the charity is the merchant, GrowSigning never sees card details and takes no fee), in
  the same tab, and come back through `/paid`, so Stripe is never given the signing link. One Stripe page is open
  per person at a time; pressing Pay again opens the same one. When the amount changed (a field), the earlier page
  is closed at Stripe before a new one is made (no new page while Stripe cannot be reached), and every page made is
  kept, so a payment on an earlier one still counts for what was paid; a second payment for the same person is
  written in the history and emailed to the sender to refund. The Pay screen keeps Other actions (Decline) and
  Help, opens by itself once per page load, and "Back to the document" stays there. The editor's card saves by
  itself, "No payment" takes a saved payment off, and Send stops in words when a typed payment could not be saved.
  The sender's page says "Waiting for payment" for someone who pressed Finish, and so does their reminder. "Paid" only after Stripe's signed message
  (`/api/collect/webhook`, at most 5 minutes old, each event once) names that session on that connected account and
  Stripe, asked again, says it is paid for that amount and currency; until then the page and the document page say
  "Payment started, not confirmed." Refunds and disputes in Stripe show on the document page and in its history.
  The signing record prints "Payment of 25.00 EUR to Green Trust confirmed by Stripe at 20 March 2027 at 16:40 UTC."
  and never says paid without that. Nobody is stuck: when a payment cannot be asked (Stripe disconnected, trust
  lost, the amount field gone), the person finishes without paying and the history says why. When someone paid and
  the document changed meanwhile, nothing is signed unseen: they are emailed to look again and finish, and are not
  asked to pay twice; when the document closed first, the sender is emailed to refund in Stripe if they want to.
  Not done: an email receipt from GrowSigning (Stripe sends its own when the account has receipts on), a webhook
  to the account's own systems for payments, and a check against live Stripe (only a stand-in in the tests).
- Bulk send a template to a pasted or uploaded CSV list (up to 500 per batch). Remind or void a batch as one. It is
  on both plans, and it costs what signing costs: each person who signs uses one signature, and a batch only goes
  out when all of its signatures are already in the balance (40 people on the monthly plan from an empty balance is
  US$40 before anyone signs). The page shows how many a list holds, how many there are, what is missing and what
  that costs before the Send button, from the server's own count (`POST /api/bulk/check`).
- PowerForms: a public link anyone can use to fill in and sign a template. An unfinished start is only given back
  to the browser that made it, never to whoever types the same email address, and is cleared after a quiet day.
  Publishing a template as a form, and pausing, changing or deleting the form, is for whoever may change that
  template (the person it belongs to, admins, and whoever its rule lets change it); everyone else who may use the
  template sees whose form it is and can hand out its link.
  A form whose open role fills in fields asks them first as questions, one at a time on every screen
  (`src/lib/webforms.ts`, `src/server/webforms.ts`, `src/server/routes-webforms.ts`): text, numbers, dates, tick
  boxes, choices and lists, in the order they are read on the pages, under the page they go on, with their own
  checks (format, limits, the sender's own message) and "Only show when" rules; a question that is not shown is
  skipped and its answer not kept. Signatures, initials, stamps and files stay on the signing page. Then the person
  sees the whole document with their answers in it ("Your answers fill in the document. What you sign is the
  document."), and the button to go on to sign is under the last page. Only then is the envelope made, with the
  answers in it as the person's own (they can still change them on the signing page) and a "Form answered" line on
  its history; the signature is used when they finish, as before. Until then nothing is made, sent or used: what
  they typed is kept in their own browser and, for as long as an unfinished start is kept (a day, or the minutes of
  a shared-device form), on the server for that one browser (`form_drafts`), so a person who closes the page finds
  their answers again. Starting checks every answer again with the same rules and reads the answers with the
  fake-notice filter, because the address typed is shown them. One connection keeps at most 20 unfinished answer
  sets (the oldest goes) and saves at most 600 times an hour (3000 on a shared-device form). The document shown is
  drawn from the save the page made last, opened by a key only that page holds, and those same answers are what go
  into the envelope; if that save fails the person stays on the last question and is told. Coming back in the same
  browser with the same name and address to a start not finished yet (to fix an answer) picks that start up with the
  new answers ("Form answered again"). Phone Back goes back one question. Questions are asked only when every one of
  those fields has a label (and every radio button a group name); otherwise the form opens as the document, as
  before, and the Forms list says how many fields need a label. A form with no such fields works exactly as before.
  Forms are made on Forms (More in the sidebar); each row has Copy link, QR code and a More with Open the form,
  "Used on a shared device: Yes/No", Pause and Delete.
- QR codes, made by the app itself (`src/lib/qr.ts`, no library and no outside service: the code is drawn in the
  browser from the link, so the link is sent nowhere to make it). "QR code" next to each PowerForm opens a sheet to
  print (the name of the form, the code, one line on what scanning does, the link written out) and saves the code
  as a picture. "Show QR code" next to "Copy link" on an envelope lets someone standing next to the sender open
  their own link on their own phone; it says that the code is the link and who may see it, and takes the code off
  the screen after two minutes (`QR_SHOW_SECONDS` in `src/lib/qrlink.ts`). A public form that is open on a big screen offers its own code, for a visitor who
  would rather use their own phone. No code is made for a link longer than 300 characters or for anything that is
  not a plain web link.
- Click-to-agree terms ("clickwrap") under Click-to-agree, for the owner and admins (`src/server/clickwrap.ts`,
  `src/server/routes-clickwrap.ts`, words in `src/lib/clickwrap.ts`). Terms written as plain text with simple
  formatting (headings, lists, bold, nothing that could carry a link or a script) or a PDF shown as pages, a tick box
  and a button, and optionally a rule that the terms are scrolled to the end first. Publishing makes version 1; any
  change to what the page shows is a new version with a note of what changed, and says how many people have to
  accept again (or, for a correction that changes no meaning, that earlier acceptances still count). Three ways in:
  the page `/agree/<slug>`; a frame on the customer's own site, pasted as an iframe or as `public/clickwrap.js`, which
  sizes the frame and fires `growsigning:accepted`; and the API (`POST /api/clickwraps/:id/acceptances`, and
  `GET /api/clickwraps/:id/status` for "has this person accepted the version that counts?"). The website names its
  visitor in a link it signs with the key of the agreement (base64url JSON with an end time, HMAC-SHA256), so nobody
  can accept as somebody else; without one the visitor types a name and an email address, and "Only people the
  website names" turns that off. Each acceptance holds the version, the SHA-256 of the exact terms, who as given,
  where that came from, when, the internet address, the browser, the page, how long the terms were open, whether
  the press came from the address and browser the terms were handed to and, inside a frame, whether the browser
  reported the button covered: each said as what the browser reported, never as what we saw. Only `?embed=1` may be
  framed. It is written once (a trigger refuses any change) and sealed with the server's secret. The person can
  download a certificate in the browser they accepted in (nobody else who opens the same link gets it), and get one
  copy by email, only to an address the website put in its signed link; an address typed on the page is never
  written to. The scam filter reads every word the page shows: the terms, the box, the button, the notes of what
  changed and the name a website signs into its link. The team can search, filter, export CSV and download a
  certificate (PDF, with the terms) for each one, under the name of the version that was accepted. An acceptance is
  not a signature and costs none; `CLICKWRAP_MONTHLY_LIMIT` is the limit instead, counted apart for visitors who type
  their own details and for the people the website vouches for, so strangers cannot use up what the website needs.

**Team and admin**
- A browser is signed out after 30 days without use (`SESSION_DAYS`), or 90 days after it signed in however often it
  is used (`SESSION_MAX_DAYS`, both in `src/lib/policy.ts`), whichever comes first, and signing in on another device signs nothing out unless the team's sign-in rules below say otherwise. Settings, Security lists where you are signed in and signs out one browser
  or all the others. Hosting a signing in person locks your account in that browser until you type your password.
- Single sign-on for an organisation (Settings, Security, "Single sign-on", owner and admins; only on a server with
  `FILE_ENCRYPTION_KEY`): its email domains claimed with a DNS line and checked daily, its own OpenID Connect sign-in
  service, "Continue with <name> sign-in" in place of the password box on the sign-in page, and, when switched on,
  everyone at those domains signing in through it with browsers ending within `SSO_SESSION_HOURS`, the owner's
  password with two-step login as the way back in. See "Single sign-on for an organisation".
- SAML 2.0 as the other kind of sign-in service in the same card (our metadata and reply address to give the
  identity provider, its metadata pasted or uploaded, signatures checked by `@node-saml/node-saml`), and "Members
  from your directory": SCIM 2.0 at `APP_URL/api/scim/v2` with one token per account, adding people at the claimed
  domains and removing them like an admin would, and "Members are managed by your directory" to stop invitations by
  hand. See "SAML 2.0 and members from your directory".
- Sign-in rules for a team (Settings, Security, "Sign-in rules", owner and admins; `src/server/secpolicy.ts`), all
  off until someone sets them. Shortest password, 8 to 64 characters: it applies when someone joins and whenever a
  password is chosen, and a member whose password is shorter is asked for a longer one the next time they sign in
  with it, on a screen that has the form, "Forgot password", their other workspaces and Sign out; nothing else of
  that team opens for them until then (lowering the rule holds such a member until their password is next typed,
  because we never keep its length). Sign out after (Never, or 15 minutes to 8 hours of no use): two minutes before, a line at the
  top of every page says so with "Stay signed in" (any key or tap also counts as use), and the sign-in page says
  why it happened. One session at a time: arriving in the team in another browser signs the earlier one out, and
  that browser's sign-in page says why. A rule applies to a browser while it works in that team; for someone on
  several teams, the one their browser is in decides. API keys are not affected. The owner is never held by the
  password rule (the card tells them instead) and can always sign in again. The card also says whether everyone
  must use two-step login (changed under Team) and why there is no forced password change or rule about capitals
  and digits (NIST SP 800-63B advises against both). Each change, and every browser a rule signs out, is a line of
  the security record. With "Sign out after" set, the team's signing pages check their link again on the first
  action after a break that long, keep every answer, and say "You were away for a while, so we checked the link
  again."; nothing covers the page and nothing pops up on a timer.
- Every new password, for everyone (sign-up, the emailed link, Settings), is looked up in the Pwned Passwords list of
  passwords from data leaks and refused with "This password has appeared in a data leak. Choose another one." Only
  the first 5 characters of its SHA-1 fingerprint leave the server; the rest is compared here. When the list does not
  answer in 3 seconds, the password is allowed and nothing says it was checked (`PWNED_CHECK`, `HIBP_RANGE_URL`).
  When `OUTSIDE_CALLS=none` or `PWNED_CHECK` switches it off, /app/operator says so in one line.
- Accounts with owner, admin and member roles, email invitations (from a confirmed address, 20 people a day, none
  while sending is paused), multiple accounts per user.
- Sign in and sign up with Google or Microsoft next to email and password, once the operator has set them up
  (see "Signing in with Google or Microsoft" under Configuration). Under Settings, Security, a person sees every way
  into their login, connects or disconnects a provider, and gets a link by email to set a first password. The last
  way in cannot be removed, and the owner of a login is emailed whenever a new way in is connected to it.
- Hand the account to another owner. What a removed member sent passes to a member the admin chooses. Members see
  their own envelopes, folders and bulk sends, admins see all of them. Signing in opens the workspace used last.
- Branding: logo and colour on emails and the signing screen.
- Contacts saved automatically and suggested while typing.
- Reports (More, Reports): for the last 30 days unless you choose other days, how many documents were sent, how
  many are finished and the median time to finish, a table by template (sent, finished, time to finish, declined;
  "Sent without a template" and "A template that was deleted" are rows of their own) and, for owners and admins, a
  table by sender. Dates and status in one row; sender, template, folder and a custom field behind More options.
  Download CSV gives the same numbers as the tables, with a few more columns (cancelled, ran out of time, waiting,
  finished %); not the month chart or By status. Counted by the day each document was sent, in world time (UTC). A
  member sees their own sending only; By sender shows once there are two senders to compare. With nothing sent in the
  period the page says so once, under the filters. A link with a day that cannot be read, or too long a period,
  shows why, the filters to fix it and "Show the last 30 days". A filter set under More options keeps the panel open
  and the button reads "Clear these filters", so closing it never changes the numbers by itself. A finished document
  its sender deleted from their lists is counted nowhere, as in the lists, the export and `GET /reports/summary`
  (`src/server/reports.ts`, `routes-reports.ts`).
- The monthly report (Settings, Profile, "Emails about your documents"; owners and admins of a team of two or more
  that has sent something; off by default): early on the 1st of each month (or the 2nd or 3rd, if the timer did not
  run before; a month the timer misses on all three days is skipped), last month's totals and the five templates sent
  most, with templates where fewer than half were finished. It names templates, never team members or the people
  documents went to, and a month with nothing sent sends nothing. Someone in more than one account is told which
  account to switch to before opening Reports.
- Lists for Send to many: the link "Save this list for next time" under the list box opens a name field and keeps a
  pasted or uploaded list under a name; "Choose a list from Contacts, or paste one below" puts it back in the box,
  where it is checked against the chosen template like any list (the existing check). A group from Contacts can be
  picked there too when the template has one role to fill and sends no text messages. A list saved shows in that
  picker at once. Contacts shows the lists, once there is one, next to the groups, with how many people, who saved
  each and when, and "Send to this list". Everyone on the team can use a list; the person who saved it or an admin
  can delete it. The server counts the people in a list itself, and refuses a header row alone. A list nobody opened
  for 180 days is deleted by the timer; an admin sets 30 to 730 in Settings, Records and data (shown once a list
  exists), and a smaller number that would delete lists says how many and asks first (409 for the API without
  `confirm`). Lists are in the export (`lists/`), go with the account, and lose the name of a login that is deleted.
  Screens say that a list holds personal data and that the team can see it (`src/server/bulklists.ts`,
  `/bulk-lists`).
- Confirming a new address with a 6-digit code typed in the tab you signed up in (`POST /api/auth/verify-code`,
  `src/server/confirmcode.ts`, the rules in `src/lib/confirm.ts`): the code works for 24 hours and only in a browser
  signed in to that login, a new code replaces the one before, and after 10 wrong codes in all no code works for that
  login and only the button in the email confirms it. The 10 also count per email address for 30 days (table
  `confirm_guesses`, a keyed hash of the address), so deleting the login and signing up again gives no new guesses.
  More than 5 tries in a minute are asked to wait a minute. The button in the email works as before. Someone who
  presses Send before confirming finds the same code box on the review step of the editor. Until the address is
  confirmed a login cannot send, invite, add a webhook or create an API key.
- Every page of the app has its own tab title ("Documents · GrowSigning") and starts with a "Skip to content" link.
  On a phone the open menu leaves the bottom bar in place, where Menu reads Close, and lists only what the bar does
  not have. Lists and downloaded files name a document without the "Please sign:" of the invitation email
  (`listName` in `src/lib/docname.ts`).
- One menu (`src/lib/nav.ts`): Send a document, Home, Documents, To sign, Templates, Contacts, More (Send to many,
  Forms, Website terms for owners and admins, Reports, Trees planted), Settings and Help. On a phone a bar at the
  bottom has Home, Documents, Send, To sign and Menu.
- Home: what waits for you, what waits for others, and the five documents completed last, each with Download.
- A document is named after its file in words (`src/lib/docname.ts`): underscores and the hyphens of a name without
  spaces become spaces and a first small letter becomes a capital. Nothing else changes, and a name you type is kept.
- "To sign": the documents sent to you (after confirming your email).
- Export everything as one ZIP file. Close an account, with 30 days to undo it and a reminder a week before the end.
- **The full export, and bringing documents in** (Settings, Records and data, for owners and admins; `src/server/exportfull.ts`,
  `src/server/importer.ts`, `src/server/importer-docusign.ts`, the schema in `docs/schema/growsigning-export-v1.schema.json`
  and at `/api/public/export-schema/v1`). "Export everything" makes one ZIP: `data.json` in the published format
  (JSON Schema 2020-12, version 1, checked before it is written), every file under `files/<sha256>`, an evidence pack per
  envelope sent, the schema, a README and `manifest-sha256.txt`. Settings go without anything about payments, webhooks
  without their secrets, and nobody's password, link or code is in it. It is made in the background and emailed as a
  link to the signed-in page (not to the file), downloadable for 7 days; `GET /api/export/full` answers straight away
  for a small account, and the `export.ready` webhook fires when a background one is ready. "Bring in documents"
  takes such a ZIP from another server: the manifest and every file are checked first; templates, drafts, contacts,
  groups and five plain settings come in through the editor's own checks (a template's rules only get stricter);
  finished envelopes come in as archived records with their history checked again and marked "Imported on <date>
  from an export that says it was made on <server>; chain verified" or "not verified" (the server is only what the
  file says; chain verified means only that the history and files inside it agree). Records the other account had
  itself brought in come along with a banner written here, never the file's own. Envelopes out for signature are
  refused with a list. From DocuSign it takes the combined PDFs with certificate, the envelope report CSV and
  template JSON (or a ZIP of them): completed ones become archived records with the banner "Imported from DocuSign
  on <date>. Signed there, not here. Its evidence is DocuSign's certificate inside the file."; one with an envelope
  ID but no certificate says nothing shows whether it was signed; a PDF with neither is not brought in. Templates
  come in with the fields that match. Records brought in are never counted, never sent or signed again, and
  `/verify` says only that an account here uploaded the file and what the upload said it was, never "completed
  here". For an admin, an empty Documents list has one link: to bring documents in, or, once there are some, to
  "Documents brought in (N)", which also shows under a list that has documents. The quick export on Documents is
  called "Download signed PDFs (ZIP)", so "Export everything" names only the full one.
  Deleting a completed envelope removes it from the sender's side only. Its recipients keep their copy.
- Settings, Security (owner and admins only; a member's Security section has only their own sign-in): one card,
  the account's security record. "Who signed in and what changed, kept for N days (`SECURITY_LOG_DAYS`, 400).
  Nobody watches it for you: the alerts are emails." Newest first, with one search box (a name, what happened, a
  key's name, an internet address), a folded Filter (what happened, who, from, until; each applies when it is
  chosen) and Download. Each line says what happened, when, who (a person, an API key, the GrowSigning team or the
  server itself), about whom, from which internet address and on what ("Mac, Safari"), and the details as
  sentences ("Role changed from admin to member."), never an id. Written for: sign-ins that worked or failed
  (to every account the person belongs to), a new login signing in for the first time, signing out (one browser or
  everywhere else), password changed or reset, email address changed, two-step login on, off or reset, new
  recovery codes, remembered devices withdrawn, Google or Microsoft connected or removed, members invited, an
  invitation withdrawn, joined, removed, role changed or left, the owner handed over, API keys made or revoked, a
  key used from a new internet address (at most 50 such lines per key a day), webhooks added or removed, exports,
  documents taken out of the lists, deleted for good or put back, template rules, account settings (by name with
  the old and new value; the logo by name only), how long documents are kept and holds, closing started or undone,
  and the GrowSigning team pausing, resuming or trusting the account. Deliberately not written: asking for a
  password link (anyone can ask for anyone, so it would let a stranger fill the record), a request with a key that
  does not exist (it belongs to no account), a person changing their own name, signature or email choices, and
  the plan and payments, which have their own history under Settings, Plan.
  What is stored: ids, never a name or an email address. No password, sign-in code, token or API key is written,
  and a value that looks like a key or a signing secret is left out, also from the browser's name. Words a person
  typed as a setting (an account's name, a key's name) are stored as typed, and nothing from a document is stored.
  For a login with two-step login a wrong password and a wrong code are written as one reason, as the sign-in
  screen says them, so an admin of a team that person is on cannot use the record to find out whether a password
  was right. Someone who has left the team is no longer named: lines about them say "someone who is no longer on
  the team", and the API gives their id only.
  Keeping it unchanged, and what that does and does not show: the app never changes a line. Database triggers
  refuse an UPDATE, a DELETE before the days are over (unless the account is deleted) and an INSERT over a number
  already used. Each line carries a fingerprint of itself and the line before, keyed with the server's secret
  (`APP_SECRET`), and the newest line of each account is noted under the same key. When an admin opens the screen,
  the newest 20,000 lines are checked, and the screen says so when a line does not match or the newest lines are
  missing. That shows a change by someone who can write the database but does not have the secret. It does not
  show a change by someone who has both, or an older copy of the whole database put back, unless the people who run
  the server named a folder outside the database (`SECURITY_HEADS_DIR`): then the timer notes there, once a day,
  the number and fingerprint of each account's newest line, and the screen also holds the record against the
  newest 7 of those notes. That is worth as much as the folder is out of reach of whoever changed the database.
  For a copy nobody at the server can change, send the record to your own system.
  Behind the card's More options: Alerts, and "Send to your security system (SIEM)". Five alerts email the owner
  and admins, each at most once an hour and each switched off by a person signed in (never a key): 10 failed
  sign-ins in an hour for one person or from one address, an API key made, the owner handed over, everything
  exported, 20 documents or templates deleted in an hour. When an alert fires again within its hour, one more
  email after the hour lists what else happened (a second key made minutes after the first is named there; the
  timer sends it). Switching an alert off is emailed to the other admins, at most once an hour for each alert, and
  again when the hour is over if it is still off. A security system pulls the record in order with an admin key
  (`GET /api/account/security-events?after=&limit=`, up to 1,000 a call; `/developers` says how), or gets each
  line as the webhook event `security.event`, which only a webhook that lists it receives; the address is added in
  the same place and its signing secret is shown there. Machines get people by id, and by name and email address
  only when an admin switches that on; an admin who is signed in gets the names the screen shows in their download
  and export. The admin's export carries the record as `security/security-events.csv` (several files of 50,000
  lines when it is long); deleting the account deletes it.

- **Part of the database encrypted** (`tests/ds-db-encrypt.test.ts`): with `FILE_ENCRYPTION_KEY`, signatures and
  initials, typed answers (also as plain numbers), public form drafts, comments, stored emails, decline reasons and
  help messages with their attached chats are kept encrypted in the database too, with a key for each column; names, addresses, subjects and the audit trail stay readable for search
  and joins, and `/security` lists both. `npm run setup` writes a key into `.env` for a new install; without one the
  server says so at start and on `/app/operator`. Details under "Encrypting stored files".

**Paying**
- People pay for signatures. A new account gets a few free. The monthly plan adds signatures with every
  payment, and extra ones can be bought one at a time. Signatures expire: a month's at the end of that month,
  top-ups 12 months after their payment, the free ones 30 days after the account was made. Each lot of signatures is
  kept with its source and its expiry (`credit_lots`), the soonest to expire is used first, a held one does not
  expire while held, the timer writes an "expired" line to the plan history, and the ledger accounts for every
  signature (`ledgerSums` in `src/server/credits.ts`: bought or given = used + held + refunded + expired + left).
- Month to month. Cancel in the app, from an email link, or with the card. Self-serve refunds.
- Codes that make the monthly plan free for a community (`FREE_PLAN_CODES`), entered at sign-up or on the Plan page.
- Every number (prices, how many signatures, trees per dollar) is in `src/lib/impact.ts`.
- For governments (`BILLING_MODE=deployment`, `src/lib/billingmode.ts`): one fixed fee a year per deployment, no
  signature counted, held or expiring, no limit on senders or signatures and no daily limit on people or team
  invitations (the pause and the fake-notice filter stay, lifted by a person, never by a payment), no call to the
  payment provider, the plan's routes 404 and the operator's money tools are not drawn, the home page, `/pricing`,
  `/help`, `/impact` and the footer say nobody pays per signature there in place of prices, top-ups and trees per
  signature, and Settings, Plan is one line naming the agreement (`LICENSE_HOLDER`, `AGREEMENT_REF`,
  `AGREEMENT_UNTIL`). Citizens never pay in any mode. `/pricing/government` is the public price list, built only from
  `src/lib/govpricing.ts`: bands by signatures a year, the fee per band (not published until the owner decides, and
  said so), what every fee includes, the contract rules (rises capped at the consumer price index with 90 days'
  notice, multi-year holds, no renewal at a new price without written acceptance, yearly invoicing, ending for
  convenience) and that self-hosting under EUPL-1.2 is free. `/tco` adds up a year of running it from the visitor's
  own numbers (servers, staff, support, text messages, email; servers needed "not yet measured" until G26), for
  1M, 10M, 100M or any number of signatures, with the licence at 0 per signature, a comparison with a price per
  envelope the visitor types, and a printable view. Trees in a government contract are per contract, never per
  signature or tied to use, and never a gift to anyone: the operator records each signed contract and its yearly
  planting statement (sites, dates, species, counts, evidence links) in the Review queue, and `/impact` lists signed
  ones only (`tests/gov-g14.test.ts`).

**Developers**
- JSON API for everything the app does, API keys, embedded signing links. Reference at `/developers`, and a
  machine-readable description at `/api/openapi.json`.
- Fields placed through the API by the words of the document: a field with `anchor` (`text`, `occurrence` "all"
  or a number, `offset_x`, `offset_y` in points) goes where that text is written, and `"auto_tags": true` turns
  `{{signature}}`, `{{date2}}`, `{{text:Label}}` tags into fields of the signer each names, with the editor's own
  tag rules. The answer lists what was placed and what was not found; with `"send": true` a missing one sends
  nothing. Up to 200 anchored fields per request, counted before any document is read; together with
  `template_id` they are refused, not dropped (`src/server/anchors.ts`, `src/lib/anchors.ts`).
- Signing inside your site: an admin lists up to 5 https websites under Settings, Developers. A signing link
  asked for with `frame_origin` may be shown inside a page of that website and of no other (a Content-Security-Policy
  `frame-ancestors` per request, `src/proxy.ts`); the page tells that website `signing_complete`, `declined` or
  `saved` and nobody else, and the audit trail says "Signed inside a frame on <website>". Every other signing page
  can only be shown by our own pages (`src/server/embed.ts`). A person with an access code or a one-time code gets
  no link for a frame, because the browser keeps no cookie there to remember the code; if a code is added after
  the link was made, the page says to open it in its own tab instead of asking again.
- The sender screen in your app: `POST /api/envelopes/:id/sender-view` gives a link to the editor of one draft,
  without our menus, that opens once within 5 minutes and works for an hour, for that draft alone. It goes back to
  a `return_url` on one of the listed websites when the draft is sent or closed, and only that website may frame it.
  Sending from it or closing it ends it on the server. It reads back only its draft's files and the files it
  uploaded itself. "Sign now" is not offered there.
- API keys have a scope. A key does everyday work (envelopes, templates, files, contacts, bulk sends, reports)
  unless an admin creates it with the "admin" scope. No key can create or revoke keys, remove a member, hand over
  or close the account, or touch the plan and payments. Admins see every key in the account, never the secret.
- Webhooks with HMAC signatures, retries, a delivery log with paging, and redelivery of the latest 200 events of
  each webhook. Private network targets are refused, and a delivery connects to the address that was checked.
- Comments for a key of either scope: `GET` and `POST /api/envelopes/:id/comments` (every thread, and the sender's
  side of them) and `POST /api/envelopes/:id/comments/:thread/settle`; the `comment.created` webhook carries what
  was written (until the envelope is deleted: then the log keeps the delivery without the words and the name).

**Environment**
- What one document saves is said where a person sends or finishes it: "This saves 15 pages of paper from a
  tree" at the review step, "Paper saved: 15 pages." in the card of the envelope page that says who it is waiting
  on, and on the signer's finished screen, with water behind "How we work this out", as an estimate. No
  share of a tree anywhere.
- Trees are said only where they are true. A signature that was paid for funds 10 mangroves: the person who signs
  reads "10 mangroves will be planted when you finish." next to Finish and in the email that asks them, and nothing
  on the consent screen. A free signature (the 3 a new account starts with, a free code, a sender signing their
  own document, a server that takes no payments) is told nothing about planting. An approver, a viewer, a copy and
  a witness are told nothing either. The email for a signing in person goes to the host and names the person who
  signs. The server decides all of it (`src/server/impact.ts`, with `paidSignatureFor` in `credits.ts`); the
  pages only draw, and the words are in `src/lib/impactwords.ts`. The words keep one tense: a signature "plants",
  mangroves "are being planted". Nothing says the planting has already happened, because at that moment it has
  been paid for and Treegens does it afterwards.
- The first time a person signs on this server (no earlier finished signature from their address) a picture plays
  once on the finished screen, under the buttons to view and download: a shoreline and ten mangrove seedlings
  rising, about 2.5 seconds, SVG and CSS. It covers nothing and delays nothing, has a Close button, closes on
  Escape or a tap, is one sentence to a screen reader and a still picture with "reduce motion". For a free
  signature no seedlings are drawn and nothing is said to be planted; someone whose first signature was free sees
  the seedlings once, the first time a signature of theirs is paid for. The first envelope an account ever sends
  plays the same picture, small, inside the "Sent." card at the top of the envelope page: no card of its own and
  nothing to close. Either picture starts when it is on the screen, and that is when the server notes it was shown
  (under a keyed hash of the address, never the address). Later times get one small card: "10 more mangroves",
  said only when there were some before, and the count of what that address's signatures fund, from finished paid
  signatures only; a payment that went back stops counting.
- A finished signature is counted by Finish itself, so the counts do not depend on anyone opening a screen or on
  "Trees on the signing record". People who sign in person are counted for the document and the account and
  never added together: the address on their row is the host's.
- Totals (the sidebar, Reports, the landing page, `/impact`, Trees planted) are shown only from 1,000 sheets or
  10 trees. Until then nothing stands in their place.
- "Trees on the signing record" (Settings, Account; admins; on by default): off leaves the box "Signed without
  paper" off the signing record of documents completed from then on, for organisations that want nothing but
  the record there. Screens and emails are not changed by it (`GET` and `PUT /api/account/impact-record`).
- "Trees on screens and emails" and, where a model answers the help chat, "AI answers in the help chat"
  (Settings, Account; owners and admins, signed in; on by default under every profile; `GET` and
  `PUT /api/account/policy`, never with an API key, each change in the security record). Trees off: the line by
  Finish, the finished screen, the invitation and completion emails, the review step, the envelope page and the
  footer of the account's public forms and terms pages say nothing about trees or paper; what was planted is
  still counted. AI off: the account's people and the people
  who sign its documents get the built-in answers and Talk to a person, and nothing they type goes to the model.
  `GET /api/me` and `GET /api/sign/:token` carry `policy: { impact_display, ai_helper, white_label }`
  (`src/server/tenantpolicy.ts`, the one reader), where `ai_helper` is `on` only when a model really answers. `DEPLOYMENT_PROFILE=government` takes trees off every signing
  record and never uses a hosted AI service; it does not change the screens.
- Every number comes from `src/lib/impact.ts`, and `/impact` says how each is worked out, where the factors come
  from (and that the water figure is toward the upper end of the published range), what Treegens itself says about checking a planting and about its average cost of ten
  cents a tree (attributed to its two public pages with the day they were read, 21 November 2026, and said to be
  Treegens' own account that nobody checked for us; the words each sentence rests on are quoted in a note in
  `src/components/ImpactView.tsx`, with the water report and the Conservatree page, which were opened that day too), what a reader cannot check yet (no receipts for the money
  sent to Treegens are published), and what is not claimed (no offset, nothing that says a
  signature undoes harm). A server that takes no payments says nothing about
  giving or planting, on any screen or signing record.
- Payment ledger (from the payment provider's invoices) shown publicly as money sent to tree planting.

**On a phone's home screen** (`tests/ds-phone-app.test.ts`)
- The website saved as an app, not an app store app: the manifest (`src/app/manifest.ts`, contents in
  `src/lib/site.ts`) with the brand icons (192, 512 and a maskable 512), start at /app and the brand colours, and the
  iPhone tags in the layout. Home on a phone shows one line, "Add GrowSigning to your home screen", on the first 3
  visits or until it is dismissed, never on a computer and never in the saved app; it opens Android's own question
  when the browser offers one, else the Help answer with the steps for iPhone and Android, which says "This is the
  website saved as an app. It is not in the app stores." and what it does not do.
- A service worker (`public/sw.js`), registered by the app's pages only, for /app: it keeps the built scripts and
  styles, the fonts, the brand icons and one offline page, and nothing else. No page, no document, no API answer,
  nothing under /sign, /api, /f or /agree, and no address with a query or a token is ever kept; with no connection
  the app's pages show "No internet connection" with Try again. A new version drops the older cache.
- Sharing into GrowSigning on Android: a PDF or photos shared from another app open the editor of a new draft
  with them (photos shared together are one document, a page each). Only for a person signed in on that phone;
  without a session the page says the file was not kept and to sign in and share again.
- Cleaner photos of paper: when photos are added in step 1, the browser looks for the page in each one (the
  largest bright four-sided shape), straightens it and makes the paper white and the writing dark, before
  anything is uploaded (`src/components/editor/scan.ts`, no library). A photo with no clear page is left as it was.
  The line under the file says what was done, with Undo cleanup, which makes the document again from the photos
  (asked twice, it gives the same new file back). The photos before cleanup (made smaller in the browser when they
  are large, like every photo added, so not the camera's own files) are kept with the document, never shown to
  signers, and are in the evidence pack (scan-photos/), which says they are the photos the sender's browser sent and
  that GrowSigning does not check that a page was made from its photo; they leave the disk with their file.
  On an iPhone the saved app keeps its own sign-in, apart from Safari, so the person signs in once more inside it.

**Brand**
- The GrowSigning logo (`src/components/Brand.tsx`, drawn inline, never a typed name beside a leaf) in the public
  header and footer, the sign-in pages, the app's side bar and phone bar, and the signing page, which ends with
  "sent with growsigning"; headings in Lora. On a 320 px phone the public header's logo is 20 px tall and its menu
  button an icon, so nothing is cut off. The kit and its rules are in `brand/README.md`.
- Browser and home-screen icons and a link preview picture with its alt text (files in `src/app/`), and a web app
  manifest at `/manifest.webmanifest`, so a phone can put GrowSigning on its home screen.
- Emails without a sender's own logo or name show the logo as a picture from `APP_URL` (the words "GrowSigning" until
  the app is public). The certificate has the logo on a deep green band, and every page of a signed copy and of the
  certificate has a small "Signed with growsigning" stamp at its foot, drawn as shapes, so no words are added to the
  PDF's text. On a page of a signed copy the envelope ID line stands beside the stamp, both in one strip 17 points
  deep at the foot; nothing of ours is printed at the top. Before printing, the server looks at the foot of each
  page: the page's own text, its pictures, its drawn lines and shapes, and the fields filled in on it
  (`src/server/footplace.ts`). The strip goes
  on the left when that is clear, else on the right or in a clear stretch between, and on a page whose foot is in
  use from side to side (a scan that is one picture to its edges, a footer the whole width) the page is made 17
  points taller and the strip is printed on that new margin. So the stamp and the ID never stand on the document's
  words or pictures, and the document's content keeps its place and size. Pages a signer attached carry the strip
  too.
- The pages reached from an email (confirm an address, change an address, reset two-step login) show the logo above
  their card, and an address that does not exist gets our own page with the public header and ways on.

**Languages (the foundation; only English is switched on)**
- Catalogues of our own words as flat JSON, one file per language in `src/locales/<tag>.json`, with `en.json` as the
  source (keys like `settings.language.button`). `t(locale, key, vars)` in `src/lib/i18n.ts` fills in `{name}` and
  `{count, plural, one {# day} other {# days}}` with a small parser of our own and `Intl.PluralRules`; nothing in a
  catalogue is ever run as code. A text is looked for in the person's language, then without its region (pt-BR, pt),
  then in English; a missing or broken text shows the English one and never the key. `dir()` is right to left for
  Arabic, Hebrew, Persian, Urdu, Pashto, Sindhi, Uyghur, Central Kurdish, Yiddish and Dhivehi. A value given as a
  number is written as an amount (1,234); a year, an id or a code is given as a string. No library, so it works in
  pages and on the server alike.
- `SUPPORTED_LOCALES` lists each language with two statuses: its screens and its legal texts (the consent, what kind
  of signature this is, the adopt line, witness statements, `STAMP_IS`, `CHECK_PROVES`), each `reviewed` by a person,
  a machine `draft`, or `missing`. English is the only one switched on. French, Amharic (in Ethiopic script) and
  Afaan Oromo are listed with nothing translated; a language is switched on in the code when a person has checked it.
- Which language a person sees: the one the sender set for them, else what their browser asks for among the languages
  switched on, else English (`src/server/locales.ts`). The signing page is told the language, its direction and who
  chose it (`language` in `GET /api/sign/:token`). Only the sender's choice (and, for a public form, the language
  the visitor's browser asked for when they started) is stored on `recipients.locale`; a signer's browser language
  on an ordinary envelope is worked out on each request and not stored, so an email cannot know it yet (that is for
  the batch that translates the emails). Someone a document is passed to, or a recipient corrected to another
  person, starts without the language chosen for the person before. `<html lang>` and `dir` are `en` and `ltr`
  while English is the only language; the layout reads the request's `Accept-Language` only once a second language
  is switched on, so until then the layout makes no page be built per request: `/login`, `/check`, `/verify` and
  the app's own pages are static again. (`/`, `/help`, `/security`, `/pricing` and `/features` are still built per
  request and sent with `no-store`, by their own `force-dynamic`, because they print this server's settings; that
  was so before languages and is not changed here.)
- Legal texts are kept by version and by language beside their words in `src/lib/policy.ts`, never in a catalogue,
  so no translation tool can change them. A language whose legal texts no person has checked shows them in English
  with one sentence in the reader's language: "This part is in English because its translation has not yet been
  checked by a person." A machine translation of a legal text is never shown as the text. The audit line of each
  person's consent names the wording and the language of the words they were shown ("Wording 2026-11, in English
  (en), ..."), and the evidence pack prints those words and names that language. The pack reads the wording and
  the language from the fixed end of the audit line, never from the person's name in front of it.
- The sender's side: `recipients[].locale` in the API (`language` is read as the same field; a language that is not
  switched on is refused with a 400 that names the ones that are), also on `POST /envelopes/:id/correct`, a Language
  choice per person in the editor under More, and the account's `default_locale` under Settings, Account ("Language
  for the people you send to"), which new recipients start with. Templates and copies keep it, a bulk
  list may have a "language" column (a code or a name; one we do not have is left out with a note on that row), and a
  public form takes the visitor's browser language. While English is the only language there is nothing to choose,
  so the editor, Settings and the bulk page show nothing about it at all. Those two selects have therefore only
  been seen in a browser with a second language patched in for a test (see `tests/out/repair-ds-lang-core/`). The sender's own subject, message, notes and
  documents are never translated.
- Dates and numbers for a screen in the reader's language: `dateOnScreen`, `momentOnScreen` in `src/lib/dates.ts`
  and `numberOnScreen` in `src/lib/numbers.ts` write them through `Intl`, in one place. The calendar is the
  Gregorian one and the digits are 0 to 9 for every language, as in the signed PDF, unless a calendar is asked for
  there (the Ethiopian one is `ethiopic`). No screen calls these yet: screens still use `fmtDate` in
  `src/components/ui.tsx` and their own `Intl` calls, and move over as each is translated. The signed PDF prints
  what it printed.
- The signing page in the signer's language (`src/lib/signlang.ts`, `src/components/sign/lang.tsx`): the page's
  root, and while the page is open the whole document with its dialogs and toasts, carries `lang` and `dir`. The
  Shell, the consent screen, the hand-back card and the in-person lock screen ask `useT()` for their words; the
  rest of the page does not yet (see "What is not in it"). Refusals from the signing routes (`routes-sign`,
  `routes-signercode`, `routes-stamps`, `routes-comments`, apart from the comment held back as a fake payment
  notice) carry a stable `code` and the facts in them; the English `error` is made from the same
  `sign.error.<code>` text in `en.json`, so the API reads as before. The consent screen says them in the signer's
  language (`shownError`), or in the server's words when no text has that code; the other screens still show the
  server's English. A language menu in the header lists the languages switched on, each in its own name, and is
  not there at all while English is the only one. The choice is saved on the person (`POST /sign/:token/locale`,
  after the access code and one-time code, at most 20 changes an hour from one connection and 40 in all), so their
  next visit follows it, and a change is one audit line ("Sam Signer chose to read the page in French (fr).").
  A group member's choice, a choice made after the person finished, and one on a document no longer out for
  signing change only the page in that tab: nothing is saved or written to the record, and the page says so. The consent shows the wording of the page's language where a person has checked it, else English with the
  one sentence, and says which language it showed. The certificate has a line per person: "Signing page in English
  (en); consent wording in English (en)" (`recipients.page_locale`, set when they agree or choose, and kept as it
  was when they finished: nothing said afterwards changes it). Right to left:
  `src/app/styles/sign.css` uses start and end, so Arabic or Hebrew mirror the screens, and the document pages, the
  signature pad and the zoom never turn around. On a development server, `?lang=en-XA` (accented, 40 percent
  longer, in brackets) and `?lang=ar-XB` (written right to left) show every word that did not go through the
  catalogue and every button that overflows; a production build never offers them and the server never saves them.
- Emails and texts in the recipient's language (`src/server/maillang.ts`, `requestmail.ts`, `textlang.ts`): the
  language of an email to a recipient is the one set for them, else the one they read the signing page in, else
  English, and only ever one that is switched on. The footer of every email (how to check it, report it, get help,
  the button's link, "Page will not open where you are?", where it came from), the text part, our subjects, the
  request and every reminder, "expires soon", "updated", "reopened", "changed after you finished" and a fresh link,
  the one-time code by email and the texts (the signing link, the reminder, the one-time code) come from `mail.*`
  and `text.*` in `en.json`. The email's `<html>` carries `lang` and `dir`, and `emails.locale` keeps the language
  (NULL for English). The sender's subject, message and notes are never translated, and the message is set apart
  as a quote with a line down its left side, under one line in the reader's language, "Ada's message:", in English
  too. An email is in one language: a request to a witness, to the host of an in-person signing, to a member of a
  group, or one that carries what changed in our English words, is written in English as a whole. Emails to senders
  follow the sender's language (see the next point). The completed copy, declined, voided, witness, group, comment-answer, Find my documents and
  mail-again emails, and the pages the emails link to (`/check`, `/verify`, signer help), have no keys yet, so a
  language reaches recipients' emails only when its entry in `SUPPORTED_LOCALES` says `mail: true`, and none does:
  until those are translated, every recipient reads every email in English, rather than a request in one language
  and the completed copy in another.
  A text with one character outside the GSM alphabet (Arabic, Amharic, most accented letters) is sent as UCS-2, 70
  characters a part, and `SMS_DAILY_PER_ACCOUNT` counts parts, as a provider bills them (`src/lib/smsparts.ts`,
  `texts.parts`, `sms_usage.parts`): a text goes only when all its parts fit in what is left, and curly quotes and
  long dashes are sent as plain ones first. With only English switched on every email and text reads as before,
  apart from the quoted message.
- For translators: `npm run i18n:check` checks every catalogue against `en.json`. Every English key has to be in
  each catalogue, translated or marked missing with `""` (shown in English); no key may be left over; the
  placeholders must be the ones in English, and a plural stays a plural with every branch its language needs; no
  key twice in one file; no HTML, entities, links or web addresses; no em dash, no invisible control character and
  none that turns the reading direction around; and it warns when a button or another short text is more than 40
  percent longer than in English. It exits with 1 on an error, so it can run in CI. The files are in the
  format Weblate calls "JSON file" (flat, monolingual): add the project with `src/locales/en.json` as the
  monolingual base file and `src/locales/*.json` as the file mask, use the "ICU MessageFormat" check, and run
  `npm run i18n:check` on what Weblate commits. Legal texts are not in these files: a person who can answer for
  them checks each language in `src/lib/policy.ts`.
- The sender's own screens and emails in the sender's language (`src/lib/senderlang.ts`, `src/components/senderLang.tsx`,
  `src/server/senderlocale.ts`): Settings, Profile, "Language of your screens" (`users.locale`, `PATCH /me` "locale"),
  listed only once a second sender language ships; until then nothing is shown and nothing is saved. The list saves as
  soon as it changes, with "Saved" next to it, and its hint says the other screens stay in English for now; a
  regional code such as "en-US" is saved as its language. Without a choice
  the browser decides among the sender languages, then English, and the emails follow the language the browser asked
  for when the app was last opened (`users.seen_locale`). A language has a status of its own for the sender's side
  (`sender` in `SUPPORTED_LOCALES`), so its sender screens can be a draft nobody has checked while the signer's are; a
  draft is marked "(draft translation)" in the list and says so under it. The app's frame (sidebar, phone bar, page
  titles, the paused banner), Home and the language card go through the catalogue, carry `lang` and `dir` on the whole
  document and mirror for right-to-left languages. The emails to senders that are written from the catalogue as a
  whole: opened, signed (and approved, witnessed, viewed) with who is still waiting, declined, completed, expired, not
  opened yet, your turn to pass a link on, the reminder to pass it on, and the digest of questions and comments (with
  where on the page a comment is pinned); in English each reads as before, except that it says "document" where it
  said "envelope" and "cancel" where it said "void", as the charter's words ask. The sender's subject, a
  signer's reason and a comment are never translated. A refusal on these screens is said from its code
  (`sender.error.<code>`) in the sender's language, else in the server's words. On a development server `?lang=en-XA`
  or `?lang=ar-XB` on any page of the app shows the test languages for that tab (`?lang=` ends it); see
  `tests/out/build-ds-lang-sender/`.
- The rest of the sender's screens and the public pages in the catalogue too (`tests/ds-lang-sender-rest.test.ts`):
  under Settings the cards in `src/components/settings/` (Sending's new documents, Team's roles and groups of
  members, delegating, sharing and moving work, Keep and delete, the security rules, the archive, export and import,
  the consent text, the counter, the AI switch and Key dates, the Organisation tab) and the stamp screens
  (`src/components/stamps/`, which speak the signer's language on the signing page and the sender's in Settings);
  the "When people sign" switches, the monthly report line; Templates with its ready-made list, Send to many and what
  a batch holds, Forms, Website terms (the list), Contacts with signing groups (the group rule too), Reports, To
  sign; and, for visitors who are not signed in, the sign-in, sign-up and password forms (`AuthForm.tsx`), the home
  page and the top of `/impact`, which follow the browser (`src/components/publicLang.tsx`, and
  `src/components/requestLang.tsx` for a page drawn on the server, which reads the request only once a second
  sender language ships). In English every one of them reads as before, except that the batch screens say
  "cancel" where they said "void". On a development server `?lang=en-XA` or `?lang=ar-XB` shows the test languages
  there too; see `tests/out/build-ds-lang-sender-rest/`.

- **Running it yourself** (see the section of that name near the top): a Dockerfile and a compose example, a Helm
  chart with egress denied by default, `GET /api/health`, `scripts/backup.mjs` and `scripts/restore.mjs`, one list of
  every outside service on `/security` with `OUTSIDE_CALLS` to hold the server to it, `/.well-known/security.txt`
  and `/security/disclosure` from `SECURITY_CONTACT`, a bill of materials at `/security/sbom.json`, and
  `docs/controls.md` and `docs/runbooks.md`. No screen in the app changed for it.
- **Procurement documents** (`/procurement`, linked from `/security` and the footer): the papers a buyer's
  procurement and security people ask for on day one, each dated and each starting with what it is not. A security
  whitepaper (architecture, data flows, a data inventory, every use of cryptography with its files, sessions, rate
  limits, logging, backups, what is not done), the control self-assessment, data processing terms as a template for
  a lawyer (each clause noted with the code that makes it true, or "a promise only"; the help chat's AI provider
  named as a sub-processor), a pack for an impact assessment, a transfer assessment template, an exit plan and an
  incident response document, all under `docs/procurement/`, plus the runbooks. `/security/subprocessors` lists who
  else handles data on this server, from the same settings as `/security`: only what is switched on, with its
  country. `tests/gov-g03.test.ts` fails when a document cites a file that is gone, or when a file uses a
  cryptographic call the whitepaper does not list for it. No screen in the app changed for it.
- **Accessibility** (`/accessibility`, in the footer): a statement in the order public bodies publish theirs: what
  works, what does not yet, how to report a problem (a help request with the topic "Accessibility"), and the date
  and method of the last check ("Checked by the authors with axe-core and by hand; not audited."). Its words are in
  `src/lib/a11y.ts`. Behind it: `docs/a11y-checks.md` (the steps and what they found: axe-core on 26 states of the
  signing page, the editor and the envelope page at 320 and 1280 pixels; signing with the keyboard alone; the editor
  without dragging; scripts in `tests/a11y/`) and `docs/acr.md`, a draft report on the VPAT 2.5 INT template, headed
  "Self-assessed, not audited", both also under `/procurement`. Fixed on the way: two colours below 4.5 to 1, the
  editor's missing main landmark and heading, each field's page now said to a screen reader (a group per page), and
  small tick boxes on a large screen take a 24 pixel click. No separate accessible mode and no claim of conformance.
- **Text for scanned pages** (`OCR_CMD` or `OCRMYPDF_URL`; off without them): pages without text (a scan, a photo,
  a PNG or JPEG upload) are read by a machine in the background (`src/server/ocr.ts`), in the language of a person on
  an envelope that uses the file or the account's language, else English. `OCR_CMD` is handed the page's own picture
  (the JPEG as it is, other pictures as PNG; a page that is not one picture is skipped) and is run without a shell;
  `OCRMYPDF_URL` is sent the PDF and answers with a text layer. Each page has `OCR_TIMEOUT_MS`; a failed file is tried
  3 times, then left as it was, and each failure is written to the server log. When the command fails in the
  document's language (often a missing language pack) it is tried in English, with a line in the log. A picture that
  would unpack to more than its own size is skipped, never unpacked. The timer waits at most 20 seconds for a batch;
  a longer one goes on by itself. The text is added to the file's kept text for search (encrypted with
  `FILE_ENCRYPTION_KEY` like the rest), shown in the signing page's Easy reading under "Text read by a machine from a
  picture of the page. It may contain mistakes. What you sign is the page." (`GET /sign/{token}/ocr`), and deleted
  with its file. The page that is signed is never changed, and nothing is written into the PDF. The editor's note on
  a scan says when the text is being read or was read.
- **Organisations above accounts** (Settings, Organisation, only for an admin of one; `src/server/orgs.ts`): one
  server for a whole government. Whoever runs it makes the top organisation and names its first admin
  (`POST /api/operator/orgs`). Its admins make ministries and departments below it and agencies (each its own
  account), invite each agency's first owner by email (they join by accepting, so a login someone made with an
  official's address and never confirmed gets nothing), and set rules that every account below gets at once and can
  tighten but never loosen: two-step login for everyone, shortest password, sign out when not used, one browser at a
  time, no tree lines (on screens, in emails and on the signing record), no AI answers (shown only where a model
  answers the chat). Each Settings card, and the two-step screen, says who set a value. A rule that can lock people
  out is asked once with how many agencies and people it reaches, and taking a rule away gives each agency back what
  it had before, unless it changed that setting itself. They see each agency's people, change admins, reset a
  member's two-step login under the usual rules, switch an agency's sending off (asked once; every page of the
  agency then says so), and read counts per agency (sent, completed, days to complete) with no titles or names.
  They never see an agency's documents: an organisation admin is never an owner or admin of an agency below it, by
  any route (the organisation's own, an invitation, accepting one, a role change, handing the account over, moving
  an agency), and the router treats one that slipped through as a member, who sees only what they send themselves.
  Emergency access to one document exists only where the operator allowed it for that organisation: it asks for a
  reason, emails the agency's owners at once and stays in its security record, with the title in the agency's
  record only. Only the operator moves an agency to another organisation. Every action is in the record.
  `tests/gov-g13.test.ts` asks every document route of the router as an organisation admin, and every reading route
  as an organisation admin who is also on the agency's team, and finds no title.
- **Certifications, said once** (`/security/certifications`, linked from `/security` and the footer): every
  certification, authorization, listing and legal status a public buyer asks about (ISO/IEC 27001 and its
  family, SOC 2, FedRAMP, GovRAMP, BSI C5, ENS, SecNumCloud, IRAP, eIDAS trust services, FIPS 140-3, an
  accessibility audit, a HIPAA agreement and more), one sentence each from one registry, `src/lib/claims.ts`.
  All read "not held". An entry reads as held only with the official registry link, the number, the scope, dates
  that have not run out and who checked, and only the owner may mark one so; the day after it expires it reads
  as not held again. A test fails when a page, an email, the PDF text or the docs name one of them in a sentence
  nobody reviewed.
- **WhatsApp and codes by phone call** (off until the operator sets them up; `src/server/whatsapp.ts`,
  `src/server/voice.ts`, `src/lib/channels.ts`): the signing link also by WhatsApp for one person who agreed, and
  "Call me with the code" on the code screen. See "WhatsApp and codes by phone call" under Configuration.

- **Easy reading on the signing page:** View, "How to read the document": Page (the default) or Easy reading. Easy
  reading puts the words of each page in one column at phone size (`src/components/sign/reflow.ts`): paragraphs are
  joined across lines, larger type or a short line in a type of its own is a heading, lines that start with a bullet
  or a number are a list, rows that line up in cells are a table said row by row, and two columns are read left column
  first. The person's fields stand where they sit in that reading order, as large controls. A banner says "A reading
  aid. What you sign is the pages of the document." Each part with words has "See this on the page" (named after its
  heading for a screen reader), which opens the page view at that spot with the focus on that page; "Back to Easy
  reading" above the document then returns to the same part, with the parts the person folded still folded. A part
  longer than about 1500 characters can be folded; nothing is folded when it opens, and folding hides only words, never
  a field. Words in the file that do not show on the page (white or see-through text, text covered over or placed off
  the page) are left out, and that page says so (`src/components/sign/visible.ts`). A page with no text says so (or
  shows the text a machine read, with its warning, when OCR is set up). The first time each view is on the screen is
  in the audit trail ("Opened the document as pages"), and the certificate says in one line, "Read as", which views
  each person used (`POST /api/sign/:token/view`). The choice is remembered for that signing link only.

- **Switches for how people sign** (Settings, Sending, "When people sign", owners and admins; `src/server/switches.ts`,
  `src/lib/switches.ts`, `GET/PUT /api/account/switches`, `PUT /api/envelopes/:id/switches`). Each starts as the
  product always worked. "People may pass it to someone else" (on): off takes Pass to someone else off the signing page
  and the call is refused; with "They keep a copy" (off until chosen) the person who passed it on stays on the envelope
  as someone who gets a copy and gets the signed copy at the end, both in the audit trail. "Allow questions and
  comments" (on): off takes Questions and comments off the signing page and refuses new comments, with words that say
  to reply to the email instead; what was written stays readable, and the sender can still answer it. "Ways to make a
  signature" (Type, Draw, Upload a picture; at least one), beside "Drawing does not make a signature stronger in law.":
  the signing page and signing in person offer only those ways, a saved signature is offered only with all three on,
  and Finish refuses a new signature or initials made another way or sent with no word on how it was made (the page
  always says; this is the page's own report, which cannot be proved). The certificate says how each signature and
  initials was made ("typed, style Caveat, as their signing page reported"; nothing when the page did not say). "Mark
  pages until everyone has signed": the large words across a copy downloaded while it is out (NOT COMPLETED YET until
  changed); the words must start by saying it is not finished (NOT, DRAFT, PENDING, UNSIGNED and a few more), and
  only after NOT may they name signing or completing, so nothing can make it look signed; the small line "NOT
  EVERYONE HAS SIGNED" never changes. An envelope takes all of these when it is sent and keeps them, so a change in
  Settings never changes a document that is out; the API changes pass-on and comments for one envelope, and the
  sender's envelope page has "Allow them on this document" when comments were off. Someone who passed it on and was
  kept as a copy finds their old link says so; passed back to them, they sign again and are no longer also a copy.
  Settings, Stamps and seals: "Members may place stamps" (on): off, a member's editor has no Stamp field and the API
  refuses a new one; stamp fields already placed stay. Forms, More, "Limit and closing date": the most people who may
  sign a form and its last day, which ends at midnight in the admin's own time zone; after either the form says it is
  closed and who to write to (the template's sender), and whoever started can still finish. People filling it in
  count toward the most until they finish or their start is cleared (a day), and the form then says it is "full for
  now", not full of signatures. Nothing about a switch that is off is said on the signing page itself; if the person
  opens Help and an answer names Questions and comments, Help says it is off for this document and to reply to the
  email, and "Ask the sender" on a document the page cannot show opens a note that says the same.

## What is not in it

Being straight about this: the market-leading e-signature products are large suites, and this covers the core
e-signature product, not all of it. Not built:

- **For the phone:** a listing in the App Store or Google Play, notifications, reading the chip of an ID card or
  passport, signing by link without a connection (only someone who signs in person on the host's device can, see
  "Signing in person without signal"), and sharing a file into GrowSigning on an
  iPhone (Safari offers no way for a website to receive one; open GrowSigning and upload instead). The service worker
  is not used during development. Scan cleanup straightens a page turned up to about 45 degrees; a photo taken
  sideways or upside down comes out that way (Pages turns it), a page whose edges are hidden (a hand, the edge of the
  photo) or that lies on a white table is left as it was, and a creased or curled page is straightened only as a
  flat one. It was checked on drawn sample photos and in Chromium, not yet on a range of real phone photos.

- **For more kinds of field:** a date worked out from another person's
  date or from a worked-out date; a font of the account's own (only Sans, Serif and Typewriter, and Serif and
  Typewriter have Latin letters only); a text style shown at its size in the editor (the editor shows font, colour
  and bold, the size only in the PDF); drawing in Easy reading (it says to open View and choose Page, and the
  Approve and Decline buttons are only in the bar there). An Approve button prints "Approved" (or "Finished" for a
  signer) once its person is done, and a Decline button prints nothing. The first and
  last name rule is the first and the last word of the name as typed, which is wrong for names written family name
  first: the signer changes it.

- **For fields anyone on the document can fill in:** signatures and initials that more than one person makes; a
  field anyone fills in that is required (each is optional); one that hides, is worked out, shares an answer or is
  read only; the format checks of a text field (a pattern, an email address) for such a field, which take only the
  length limit; anyone but people who sign (an approver, a viewer, a witness or someone who gets a copy cannot change
  it). Two tabs of the same person count as one screen. A change that asks others to sign again is kept only on the
  screen until Finish: a page closed before Finish loses it. Through the API, each save sent with "sign_again": true
  asks again, also when a later save puts back what they had signed. A field for anyone starts with someone who signs: when that
  person is taken off, given to someone at another address, or not asked, the field goes with them as their fields do.
- **For forms as questions:** a form that ends without a signature (that is click-to-agree, a separate thing), a
  form sent to one named person by email (send the template to them instead), and sections of the sender's own
  naming: a question's section is the page it goes on. The server does not check that the person scrolled to the
  last page; the page only puts the button to sign there. Signatures, initials, stamps, files and worked-out numbers
  are not asked as questions. Help text of the sender's own for a question (the
  help line is the field's checks, in the editor's words), and asking only the labelled fields of a role whose other
  fields have no label (such a form opens as the document). After going on to sign, the signing page shows the
  document again, so the person sees it twice.

- **For Easy reading:** it works from the text pdf.js reads, so bold type is only seen as a heading when the font
  of a short line differs from the body text; tables with merged cells, text set in three or more columns, rotated
  pages and footnotes are read in their plain top-to-bottom order; pictures and drawings are not shown in it. Hidden
  words are found by looking at the page as drawn: words hidden on top of other visible words, or words in a picture
  that differ from the text layer over it, are not caught. A
  member of a signing group, and anyone after finishing, leaves no "Read as" record.
- **For several templates in one document and for "This looks like your template":** matching a scan: a file with no
  words is never compared, and the editor does not ask about a file that is all scanned pages, even once the
  background reader has read it; matching an upload against more than the 300 most recently changed templates; carrying "Only show when"
  rules and formulas of a template's fields onto an uploaded file with Use it (the fields come, their rules do not);
  showing a partly locked document in the editor part by part (the editor shows the whole document as locked, the
  server lets the open parts change through the API); one template made from a combined document that keeps a
  different rule for each part (it is refused instead when a rule would be lost); a template's own reminders and deadline for the later
  templates of a combined document (the first template's are used).
- **For government billing:** invoicing (governments invoice through their own systems), procurement vehicle
  listings, published fees, currencies, support hours and response times (open until the owner decides; the page
  says "not published yet"), hosting by us or a partner (not offered), measured servers per signature volume (G26),
  and a deployment's own tree commitment on its signing pages. Who may make an account on a deployment server is not
  restricted by the product: there is no daily limit on people there, so an operator who opens sign-up to the public
  relies on the pause, the fake-notice filter and reports alone. Public pages learn the mode from
  `/public/billing-mode` in the browser, so on a deployment server the footer's money line shows for a moment before
  it goes.
- **For files brought in by an editor:** pages that are pictures (a scan) are checked by the fake-notice filter only
  once the server has read their words, which needs OCR (`OCR_CMD` or `OCRMYPDF_URL`). While that reading is going on,
  the file is not taken ("Try again in a minute or two"). Without OCR, or when the reading failed, a picture's words
  are not read, so a scanned fake notice is not caught there; the file's name still is. There is also no screen for an
  editor to place fields for the people after them: that waits for a designer's note.
- **For delegated signing:** a delegate who is a group, a delegate who names a delegate of their own, more than one
  delegate at a time, a delegation that reaches documents from other accounts, asking "Only the person named may
  sign" when sending straight from a template, copying or sending in bulk (those go to both), a way for the person to take a request back from their delegate (the
  sender can correct that recipient), and sending the person a copy of what their delegate signed (they are told to
  ask the sender). GrowSigning records who signed for whom; it does not check whether the delegate has the authority
  to sign for the person.
- **For working for a colleague:** sharing across accounts, sharing one envelope or one folder rather than
  everything a person sends, more than one level per colleague, a share of a share, bulk sends and forms in a
  colleague's name, an email that tells the colleague they were given a share (they find it in Settings), a
  read-only view of a document's file at the See level, and a screen to make a template in a colleague's name (the
  API can). A document sent for a colleague before this release (no envelopes.sent_for_id) and moved later still
  has its certificate say it was sent for the person it was moved to; one sent since keeps the person it was sent for.

- **Previewing the emails** a person gets: "See what each person sees" shows the signing page only, not the
  invitation, reminders or the copy email. The one-time code and the access code are described in the preview, not
  asked, and a preview cannot be shared with a colleague: it opens only in the browser that made it (a link made with
  an API key: in any browser of the key's maker).

- **For people who change the document on their turn:** placing fields on the page from the signing link (the
  screen replaces files and changes people; fields of the people after them can be changed only through the API),
  adding a new person from the signing screen (the API can), naming a person by phone number instead of email,
  a role that changes the sender's subject or message, chains where someone who changes the document makes another
  such person, and passing that role on to someone else (a later person with one of these roles is locked for them).
- **At the service counter:** checking an eID on the counter device (the identity check offers it once the server
  checks eIDs, G09), document scanners and reading ID documents by OCR, biometric data from signature pads (pressure,
  speed), and a person with no email address (Start asks for one, for their copy). The agency's own rules for
  checking ID and for people who cannot sign are policy, not software: the counter records what the official
  states.
- **Permissions per folder, and roles that add to Member.** A role the team makes starts from Admin or Member and
  only leaves things out, so its people always see the screens of the role it started from; a role that can do one
  admin thing starts from Admin and leaves the rest out. Nothing is set per folder. The sidebar, the phone's bottom
  bar, Home, Settings and Team follow the made role; other screens still show some buttons by the built-in role (the
  server refuses them in words). Taking someone out of a group of members leaves them the role it gave them: change
  it on the Team list.

- **Hiding pages, or parts of one file, from some people.** "Each person sees only their files" works per file:
  someone shown a file sees all its pages. The names in their copy's audit trail are taken out for the files they
  were not shown, and a subject that names one is replaced for them, but other words the sender typed (the message,
  a note on a page they are shown) are never changed. A file the sender shares in full by other means (the sender's own download, an export) holds everything.

- **One file given to read shared by many documents.** A file to read ("To read, not sign") belongs to its own
  document; sending the same privacy notice with many documents means adding it to each, or to a template. Nothing
  says whether it was read or understood: only that it was opened, downloaded or acknowledged.

- **Importing from other vendors, live sync, and a check against real DocuSign downloads.** Only our own export and
  DocuSign's downloads come in, once each time someone brings them in. The DocuSign reader follows DocuSign's
  documented layouts and was tested on fixtures made from them, not yet on real downloads. A template's anchors
  (fields placed by text), formulas, conditions, payment and approve fields, and recipients such as editors are
  listed as not imported. An import does not bring team members, webhooks, click-to-agree terms, legal holds, a
  deletion schedule or sign-in rules: it lists each with what to do. "Chain verified" means the history is
  consistent and names the file the export says; this server did not see the signing, and exports are not signed
  with a server key, so nothing shows where an export came from or that it was not changed and its chain worked
  out again. DocuSign files are not checked either: what they say is kept as they say it. `/verify` tells anyone who
  checks such a file that an account here uploaded it. Records brought in are not found by the Documents search;
  they have their own list, linked from Documents. One upload is at most 300 MB
  and one export is one classic ZIP (about 4 GB or 60,000 files); what does not fit is named in its README. A
  background export waits on the server's disk for 7 days without the file encryption key's protection: the server
  writes it as a plain ZIP.

- **A JavaScript library for embedding, signing inside a frame for a group, and the template editor in an app.**
  Signing inside your site and the sender screen are plain links and `postMessage`; there is no script to load. A
  group recipient cannot sign inside a frame (each member has a link of their own), and the sender screen opens
  drafts, not templates. Anchors find text on one line only and nothing on scanned pages. Someone with an access
  code or a one-time code cannot sign inside a frame on another website (a browser keeps no cookie there).

- **Shared libraries across agencies, and some rules from above.** An organisation has no template library,
  group directory or directory of staff addresses that its agencies share yet: each agency keeps its own. The rules
  an organisation passes down are the six in Settings, Organisation; single sign-on, signature levels, keeping
  periods, outside services and where the security record goes are still set by each account or by whoever runs the
  server. Billing across agencies is not here either.
- **Field checks against anything outside the document, and formats for one country.** A format is checked as
  written, never looked up: an email address is not tried, a number is not matched to an account, and there are no
  postcode or ID formats per country (write your own pattern for those). The words a signer is shown when a check
  is not met are in English only for now, also on a signing page in another language.
- **More than plain text when writing a document here.** No tables, no pictures, no importing a Word file, no
  clause library, no negotiating the text with the other side, no wording for a particular country and no legal
  review: the AI draft is a draft, and the view says so above it. Bold inside a right-to-left line that mixes
  weights is printed in the line's own weight.
- **Ready-made templates checked by a lawyer, for a country, or in another language.** The ten starters are plain
  starting points in English, reviewed by nobody, with no wording for any one country; no will, deed or power of
  attorney is among them. Their wording is fixed in the PDF: to change it, edit the PDF elsewhere and add it to the
  template instead.
- **Rules on later answers, loops and flowcharts for who is asked.** "Only when..." reads only answers of people
  earlier in the order, never someone's own or a later one, and never sends the document back to an earlier step.
  A person who was not asked cannot be asked after all from the document's page: add them again with Edit. One
  rule per person, no "and" or "or" between rules, and a rule on a witness is refused.
- **Sending on a repeating schedule.** Send later sends one draft once, at one time. There is no "every month", no
  send window and no pause that ends by itself. Resuming sends an email only: no text message and no WhatsApp
  message, also for someone who got their link that way. A wait before a person is counted from when the step before finished; it cannot wait for
  a date, and the deadline keeps running during it.
- **Reports you design yourself, or that arrive on a schedule you choose.** Reports has fixed tables (by template, by
  sender), the filters and a CSV; the only email is the monthly one. No new charts were added, and none are on Home.
- **Trees planted, promised before sending.** The review step says how many pages of paper this document saves,
  and adds "Plus: 10 mangroves are planted for each person who signs" only when every signature of the draft
  would come out of a payment as the account stands. That is a forecast from the draft as saved; what is true is
  asked again once a signature is held for each signer. A mixed case (some paid, some free) says nothing there.
- **Proof of each planting.** GrowSigning counts what was paid and says what that funds. It does not show which
  trees were planted for which signature, and it has not checked Treegens' plantings itself: `/impact` links to
  Treegens for that, and repeats only what Treegens' own pages say about how it checks them (filmed in the
  Treegens app with the place recorded, voted on by verifiers who stake its token; treegens.app and treegens.org,
  read again on 21 November 2026), as Treegens' account and not ours. No receipts for the money sent to Treegens
  are published yet, and `/impact` says so. A payment disputed
  long after a signature stops counting only while that envelope still exists. The first-time picture for a
  person with no address of their own (a link the sender passed on, a signing in person) is per document.
- Nor does the review step fold several warnings into one line: each warning is shown in full.

- **Consent texts per template, and signing on paper.** The account's own consent text is one per language for the
  whole account, not per template. "Sign on paper instead" is in Other actions only when the account has its own
  consent text (to ask for it by post) or has switched on "People may sign on paper" (to print it and send a photo);
  the by-post choice asks the sender to post the document and closes the person's part. Printing it, signing by hand and
  sending a photo back is built (see "Signing on paper"), but GrowSigning reads nothing on the scan: no handwriting
  check, no check that the person who wrote on the paper is the person on the document, no fax, and nothing by post.
  The scan is not part of the evidence pack or the full export yet, a scan waiting when the document closes is not
  cleaned up on its own, and a sender who switches paper off later leaves a waiting scan reviewable but offers paper
  to nobody new. A person who agreed once is not asked again when an admin saves a new version later, unless the
  account asks every time the link is opened, and that choice is kept by the signing page, not enforced by the
  server for programs that call the signing API themselves (they must send the version they showed, or are refused).
- **Certificate-based signatures of the people who sign.** A completed PDF can carry a digital seal of the server
  (see "The digital seal of a completed PDF"), but the people who sign do not sign with certificates of their own.
  Without a seal set up, integrity comes from the stored SHA-256 fingerprint, the hash-chained audit trail and
  `/verify` alone. These are standard electronic signatures with an audit trail, not "advanced" or "qualified"
  signatures under eIDAS. Have a lawyer confirm they fit your use and jurisdiction before relying on them for
  high-stakes documents. Not built around the seal: renewing the archive time stamp over the years (the long-term
  data and one document time stamp are added once, at completion; renewing them would change the file people hold),
  long-term data for a seal without a time stamp, an organisation's own seal,
  keys in an HSM or a cloud KMS, an outbound allowlist for the time-stamp request (its address is an operator
  setting, never a user's), and keeping signatures that an uploaded PDF already carries.
- **PDF/A beyond PDF/A-2b, and for documents completed before.** The archive format makes PDF/A-2b only: not
  PDF/A-1, not PDF/A-3, not the "accessible" levels (2a, 2u). Documents completed before the switch was turned on are
  not converted afterwards. An uploaded file with a font that is not inside it, colours for a printing press, or
  sound, video, 3D or an attached file is not re-made through the office converter to fix that, because that would
  change how the pages people signed look: the document is made as a normal PDF and says why. Without veraPDF on the
  server there is no PDF/A at all.
- **A security monitoring service.** The security record (Settings, Security) is a record and five email alerts.
  Nobody watches it, there is no detection of unusual behaviour beyond those five counts, and nothing is pushed to
  syslog or a log platform by us: a security system pulls it with an admin key or takes the `security.event`
  webhook. Not built from the government brief (G12): delivery over syslog with TLS and over HTTPS batches with a
  retry queue, the envelope audit trail as a second stream, an OCSF mapping, sending the daily note of where
  each record stood (`SECURITY_HEADS_DIR` writes it to a folder) to an outside service by itself,
  alerts on a new country (that needs a location database we do not ship) and on sends far above an account's own
  pattern, retention set per account (an admin who could shorten it could wipe the record of what they did), events
  of the server itself that belong to no account, and lines for a rate limit that was hit. Google or Microsoft
  sign-ins that fail at the provider are not written, because they name no login of ours.
- **More than plain details on an envelope.** A detail is a line of text or one choice from a list: no dates,
  numbers or tick boxes with their own checks, no detail that is filled from another system, and none that a
  signer sees or fills in. The list filters by one detail at a time and by the exact value, not by a part of it,
  and the search box does not read them. Reports do not filter by them yet. A document's own name and value
  pairs are for the API only. A member of the team reads the names of all details, also of ones deleted since,
  but only the values on envelopes they may see.
- **An archive of everything, or a journal.** Archive addresses get copies of the emails about envelopes only: not
  billing emails, not emails about help requests, not team invitations, sign-in or account emails, and no text
  messages. An email that never left our server is not copied, and emails sent before an address was confirmed or
  while it was paused are not sent later. There is one list per account, not one per document, folder or sender.
  A copy shows what our server handed over, not that the original arrived. There is no SMTP journaling format, no
  export to a records system, and the copies are ordinary emails: the mail provider and the archive's mail
  service can read them. A confirmed address cannot switch the copies off by itself: whoever reads it asks the team
  to remove it, or marks a copy as spam, which pauses it on a server that hears from its mail provider.
- **Encrypted email to the recipient.** `SMTP_REQUIRE_TLS` covers the step from this server to its mail provider
  and nothing after it. There is no S/MIME or PGP, no check of the recipient domain's MTA-STS policy and no
  REQUIRETLS request passed along: whether the last step is encrypted is up to the mail provider and the
  recipient's mail server.
- **Records management beyond the deletion schedule.** There is one schedule per account (two lines: completed, and
  cancelled, declined and expired) and one period per template, not per document type, folder or tag; the end of a
  period deletes (no "review" queue and no "transfer to archive"); there is no archive export in BagIt layout, no
  records officer role, and the deletion record (CSV, or a PDF of at most 5,000 lines) is written by the software
  itself: nobody outside has checked or signed it. Holds are
  placed on one document or one folder, not by search, person or dates. The people on a document are not told when
  its files are deleted: their link then says the sender deleted it. A member who is not an admin can delete the
  files of one of their own documents from its Delete dialog only while a schedule is on; with none, an admin does
  it from Settings (the API takes it from the sender either way). A hold freezes a draft against saving and deleting, not against being
  sent. An email about a document that was still waiting for the mail server when its files were deleted keeps its
  words until it has gone out.
  A hold is a rule of this software: it does not reach the database, the disk or the backups of the people who run
  the server, so held documents are not kept out of backup rotation unless they arrange it.
- **Anything certified, and more than one server.** No audit, no certification and no penetration test stands
  behind the self-hosting papers: `docs/controls.md` is the authors' own reading of their code. There is no
  Postgres and no second replica (SQLite has one writer), no hardware security module, no signed release bundle
  for carrying an image into a closed network (build the image inside, or carry it with `docker save` and your
  own checksum), the procurement documents are written by the authors and checked by nobody else (the data
  processing terms are a template for a lawyer, not a contract, and leave the hours for a breach notice blank until
  someone is on call), the accessibility report is a draft the authors wrote about their own screens (`docs/acr.md`, not audited), and the NIST SP 800-53 controls are not mapped. The software's own hold on
  outside connections (`OUTSIDE_CALLS`) is not a firewall. A closed network still needs a mail relay inside it,
  because a new login confirms its address by email.
- **Chatting with signers, files by WhatsApp, WhatsApp instead of email.** WhatsApp carries only the four
  messages below, each with a link; replies other than STOP and START are not read, documents are never sent as
  attachments, and a person still needs an email address (or the sender sends the link themselves). WhatsApp is
  not offered on templates, bulk sends or public forms, and Change person can only switch it off (the editor's
  correction switches it on, with the tick). There is no price or extra limit for accounts that have not paid: each
  account can send up to `WHATSAPP_DAILY_PER_ACCOUNT` messages a day at the operator's cost. A call with a code is never tried again, and not offered for a check by email.
- **More than two witnesses, and witnesses compared with each other.** A person who signs has one or two witnesses,
  never three. Each witness is compared with the signer's browser and address, not with the other witness. Nothing
  says which documents need two: the sender decides.
- **Electronic seals.** A company stamp here is a picture of a stamp that a person puts on the page (see
  "Signing"). Nothing checks that they may use it, and it is not an electronic seal backed by a certificate (an
  "advanced" or "qualified" seal under eIDAS). It pays no stamp duty and is not an e-stamp certificate or an
  e-meterai. The digital seal of a completed PDF is the server's, not a company's.
- Languages other than English. The signing screen and our emails are in English for now. Your document can be in
  any language. (The sentence the pages print is `LANGUAGE_NOTE` in `src/lib/policy.ts`.) The foundation is built
  (see "Languages" above). Only the Settings security record and the few words of the language choice itself read
  their words from the catalogue, and nothing is translated. Of the emails to recipients, the footer, the request
  and its reminders, the one-time code and the texts go through the catalogue; the completed copy, declined,
  voided and corrected notices, the witness request, group emails, comment answers, Find my documents and the
  code to get emails again still have their English written into the code, and so do `/check`, `/verify` and the
  signer parts of `/help`, which follow the browser for `<html lang>` only. Until they are translated no language is
  marked `mail: true`, so every email to a recipient stays English, even for one whose signing page is in another
  language.
  On the signing page, the Shell, the consent screen, the hand-back card, the in-person lock screen and the refusals of
  the signing routes go through the catalogue; the rest of the page and its dialogs (the document screen, the adopt
  dialog, review, done, comments, witness, stamps, codes) still have their English written into the code, and
  refusals made in `envelopes.ts`, `signercode.ts`, `groups.ts` and `witness.ts` have no code yet. The adopt line, witness
  statements, `STAMP_IS` and `CHECK_PROVES` are not yet kept by language, a name in another script on an English
  page has no `lang` of its own,
  the certificate is English only, and there is no `LANGUAGES_ENABLED` setting: a language is switched on in
  `SUPPORTED_LOCALES`. Nothing calls a translation service.
  On the sender's side, the app's frame, Home and the Profile language card go through the catalogue; the editor
  (`Editor.tsx`, `src/components/editor/`), the documents list and the document page (`src/app/app/envelopes/`,
  `src/components/sender/`), Home's usage card and its "goes out by itself" line, dates written by `fmtDate`, and the
  Settings page itself (`src/app/app/settings/page.tsx`: Profile, Security with `SignedIn.tsx` and `TwoStep.tsx`,
  Notifications, Account, Team's list, Developers, Plan, Records and data) still have their English written into the
  code, and the server's other refusals on these screens have no code yet. So do these parts of the batch
  "lang-sender-rest": one website terms page (`/app/agreements/<id>`), the form's printable sheet, the template dialogs
  `WhoCanUse.tsx` and `AddTemplate.tsx`, `FormLimits.tsx`, saved lists (`SavedLists.tsx`), `/help`, `/security`, and
  the totals and the "How we count" working on `/impact` (`ImpactView.tsx`, whose claims about trees and paper stay
  as written in English, as the legal texts do). Because the Settings page around the cards is English, no Settings
  tab reads in one language yet, so a second sender language should not be switched on before that page, the
  sentences from `src/lib` below and the files above are done (`tests/ds-lang-sender-rest.test.ts` lists them as
  `LEFT`).
  Sentences the screens take from `src/lib` (the retention levels, the organisation rules, the reminder line,
  `STATE_LABEL`, the stamp honesty lines) and the server's own answers stay English, and so do page
  titles (`metadata`), the home page in a test language (it is drawn on the server, which does not read `?lang`), and
  the legal texts, which stay English until a person has checked a translation. Of the emails to a sender, "expires soon", problem emails (not delivered, could not open, access
  code, held back), name changes, reassignments, more time, paper requests and billing emails are still English
  as a whole.
- ID verification (government ID, knowledge-based checks), and a check of its own by phone call: "Call me with the
  code" only reads out the code of a check by text message, where the operator set calls up. A one-time code by email or by
  text message is in (see "Checking who signs"); it shows that someone can read a mailbox or holds a phone, not who
  they are. Text messages only exist on a server whose operator has set a provider up.
- Merging documents into one, cropping pages, and turning a page by less than a quarter. Pages can be removed,
  turned by quarters and moved within one document (see "Pages" in the editor above).
- Remote online notarisation. GrowSigning never holds money: a trusted account can
  show a link to its own payment page after Finish (see "Reuse and scale"), or, on a server set up for it, ask for a
  payment by card that goes straight into its own Stripe account ("Payments while signing" below). Subscriptions,
  invoices and payment plans are not in. Mobile money (M-Pesa and the like) is not in: `src/server/collect.ts` has
  the shape an adapter would fill (`PayProvider`) and a stub that is never set up, and nothing offers it.
- A HIPAA business associate agreement, at any price. US healthcare providers must not put patient information
  through it (`NO_BAA_TEXT` in `src/lib/policy.ts`).
- Google Docs and cloud drives: download a Google Doc as Word or PDF first. Word and other office files are turned
  into PDF only on a server with a converter, and the PDF can differ from what the program shows (fonts that are
  not installed, page breaks, a sheet split across pages): the PDF is the record, so check it. Tracked changes and
  outside links are not looked for in the old binary .doc, .xls and .ppt formats. An honest spreadsheet whose
  contents pack more than 20 times is refused like a ZIP bomb (the refusal says to save it as a PDF). The account
  export under Settings holds the originals of converted files for envelopes that were sent (in `originals/`, a
  folder for each envelope), not those of drafts: download a draft's from the editor. Documents cannot be edited here,
  and HEIC photos are not taken (phones hand over a JPEG when a photo is chosen).
- Contract lifecycle management, AI contract analysis, document generation, obligation workflows and an intake desk.
  Key dates finds dates and amounts and reminds; it does not track duties, assign tasks or say what a clause means.
  The AI help that is in (suggested
  fields, a signer's summary, a drafted message, key dates) answers no legal questions and never changes a document; a summary
  is not kept for templates, is not shown to the sender before sending, and a template does not carry the summary
  switch to the envelopes sent from it.
- SAML single logout, SAML sign-ins started from the identity provider's own portal, signed AuthnRequests and
  encrypted assertions, SCIM groups, SCIM bulk requests and filters other than `userName eq` and `externalId eq`,
  single sign-on for sub-domains of a claimed domain, and an OpenID Connect service that only works without a client
  secret. Single sign-on with OpenID Connect and SAML 2.0, and SCIM for users, are in (see "Single sign-on for an
  organisation" and "SAML 2.0 and members from your directory"), so are Google and
  Microsoft and two-step login with an authenticator app (see "Two-step login"); native mobile apps, codes by text
  message, passkeys and security keys for signing in are not. Leaving the organisation ends access within
  `SSO_SESSION_HOURS`, not at once: nothing tells us the moment a login there is closed.
- Passwords that expire after some weeks, rules about capitals, digits and signs, security questions, and locking a
  login after wrong passwords. NIST SP 800-63B advises against the first three; sign-in tries are limited instead,
  30 in 15 minutes from one internet address and 10 for one email address. A separate idle time for signing pages or for phones is not there either: the team's one "Sign
  out after" is used for both.
- Signing by link without a connection. Opening the document and Finish need one; a connection that drops in between
  is fine, and Finish goes again by itself when it is back. Signing in person without signal has limits: the page is
  in English only, a person who chooses Decline on the device is not recorded as declining (nothing is sent, the
  device says so, and the host is told the document still waits for them; the host declines for them with a
  connection), only one person at a time can be kept on a device (two people of one envelope sign one per trip, or
  on two devices), fields are filled in as a form under the pages rather than on
  them, the device's clock is recorded but never trusted, an unsent signature is wiped with the copy after 7 days, and
  the page opens without signal only in the production build with its service worker (not during development), in a
  browser that keeps a service worker's files (not every private window does: the page then says to keep it open). A PIN
  guards the copy on the device against someone who finds it, not against someone who copies the browser's storage
  and has time to try PINs.
- Ready-made integrations (Salesforce, Google Drive and so on). The API and webhooks are the way in for now.
- A security certification, and encryption of the whole database by the app itself. With `FILE_ENCRYPTION_KEY` the
  app encrypts the stored files, the text read from uploaded PDFs, and signatures, typed answers, comments, stored
  emails, form drafts, decline reasons and help messages in the database (see "Encrypting stored files"), never names, addresses,
  subjects or the audit trail, so encrypt the disk as well. `/security` says so plainly and lists both. The copies of
  text and WhatsApp messages are not encrypted yet either.
- Staffed support. The software gives everyone a way to reach a person, gives those people a queue, publishes a
  response time and says so when it is missed. Someone still has to read the queue and answer in time.
- Replying to a support email. Answers are written and read on the request's own page (the link in every email),
  not by replying to the email, and the emails say so.
- Day-first dates in the plan emails and on the Plan page. Everywhere else a person reads a date it is written day
  first with the month as a word ("21 Nov 2026", "21 Nov 2026 05:40:12 UTC" in messages, emails and records), but the
  days in plan emails (`src/server/routes-billing.ts`) and the start day of a new price (`priceChangeDay` in
  `src/lib/policy.ts`) still read "March 7, 2031" until the payment code is changed. CSV files, file names and the
  API keep 2026-11-21.
- A dark-mode email. Every email is drawn light, and `public/brand/email-logo-dark.png` is not used. The logo picture
  carries a tile of the email's own light ground, so a mail program that darkens a light email by itself (Gmail on a
  phone does) shows the logo on a small light tile. This was checked in a browser, not in those mail programs.
- Keeping the stamp and the envelope ID line clear of colour gradients and of comments a PDF reader draws on top of
  a page. The server keeps them off a page's text, its pictures, its drawn lines and shapes (a ruled line, a page
  border, words drawn as outlines) and the filled-in fields (see the brand notes under "What is in it"). It counts
  neither white nor a shape filled over most of the page, which is the sheet behind everything. A page whose foot is
  in use from side to side comes out 17 points taller than it went in (an A4 page of 842 points becomes 859), so a
  signed copy can have pages of slightly different heights.
- A helper that acts. The help chat answers and points to the tools that do things (see "The help chat"); it cannot
  see or change a document, an account or a payment, never says whether a signature is enough or valid, and can be
  wrong: the rules on the pages are what count. It answers in the person's language, while the screens stay English.
- A model shipped with the server, fine-tuning, or a helper that reads documents. For a government or closed-network
  server the operator runs their own open-weight model (`docs/self-hosted-model.md`); the software was tested with a
  stand-in model only, not with a real open-weight model. The helper never sees documents, so there is no search
  over them. The software cannot check who runs the machine behind `SUPPORT_CHAT_BASE_URL`, or what it logs.
- Switches per template, and proof of how a signature was made. The switches for how people sign are the
  account's, and one envelope's through the API; a template has no switches of its own. How a signature was made is
  what the signing page reported: a browser can say "typed" for a picture it drew, so the certificate says "as their
  signing page reported" and nothing more. The in-person and offline signing pages do not report it yet.

## Scripts and fonts in the signed PDF

On screen and in emails every script works, because the browser and the mail program bring their own fonts. A PDF
has to carry its fonts with it, so what the signed PDF can print is decided here, by `src/server/pdftext.ts`.

- **What prints:** Latin with accents, Greek, Cyrillic, Arabic, Hebrew, Armenian and Georgian from DejaVu Sans
  (package `dejavu-fonts-ttf`, the DejaVu Fonts licence, which is the Bitstream Vera licence with additions).
  Chinese, Japanese, Korean, Thai, Devanagari and Khmer from Noto Sans (packages `@fontsource-variable/noto-sans-sc`,
  `-jp`, `-kr` and `@fontsource/noto-sans-thai`, `-devanagari`, `-khmer`, all under the SIL Open Font License 1.1).
- **How the fonts get there:** `npm install` runs `scripts/copy-assets.mjs`, which calls `scripts/build-fonts.mjs`.
  `npm run build` and `npm run dev` run it again first, so an install made with `--ignore-scripts` still gets the
  PDF fonts, the heading font (Lora), the signature fonts and the PDF viewer before anything is built or served.
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
| `APP_URL` | Public address of the app, for example `https://sign.example.com`. **Required on a real deployment:** every link in every email is built from it. The address of a request is never used for a real host, because a request header can be forged. Without `APP_URL` the app logs a warning and links only work on your own machine. It is also the address of link previews (`og:image`) and of the GrowSigning logo in emails that have no sender's logo (`/brand/email-logo.png`; until the app is public, mail programs show the words instead). | `http://localhost:3000`, or the localhost address you opened the app on |
| `TRUSTED_PROXY_HOPS` | How many proxies of your own sit in front of the app (load balancer, CDN, the platform's router). The caller's address, used for rate limits and the audit trail, is read that many places from the right of `X-Forwarded-For`; anything further left is whatever the caller typed. `0` means nothing is in front: the header is ignored and every visitor shares one set of rate limits. The limit on one-time codes per caller address (see "Checking who signs") is not counted at all then, and with `1` on a server that has no proxy in front a caller can name any address; the limits per recipient and per mailbox or number hold either way. | `1` |
| `DATA_DIR` | Where the database and files live. Must be a persistent disk. | `./data` |
| `APP_SECRET` | Secret for access-code cookies and stop links. | generated and kept in `DATA_DIR` |
| `FILE_ENCRYPTION_KEY` | Encrypts every file the app stores from now on (uploaded documents, signed PDFs, attachments) with AES-256-GCM. 32 random bytes as base64: make one with `openssl rand -base64 32` or `npm run setup` (writes it into `.env` when none is set), and keep a copy apart from the server and its backups. The text read from uploaded PDFs for search is encrypted with it too, and so is a picture of an ID document kept at the service counter (which is only offered with this set), and in the database signatures, typed answers, public form drafts, comments, stored emails, decline reasons and help messages with their chats; names, addresses, subjects and audit trails are not. See "Encrypting stored files" for what it protects and what it does not, how to encrypt the files stored before, and what happens when the key does not fit the files. Set to something that is not a key, the server stores no file at all until it is corrected. | off: files are stored as they are |
| `FILE_ENCRYPTION_KEYS_OLD` | Earlier keys, separated by commas, so files written with them can still be read after the key was changed. `node scripts/encrypt-files.mjs` moves those files to the current key. | none |
| `SEAL_P12`, `SEAL_P12_PASSWORD` | Seals every PDF completed from then on with an invisible PAdES signature of whoever runs the server (see "The digital seal of a completed PDF"): the path to a .p12 or .pfx file holding the seal key and its certificates, and its password. RSA of 2048 bits or more, or ECDSA P-256. | none: no seal, files as before |
| `SEAL_KEY_PEM`, `SEAL_CERT_PEM`, `SEAL_CHAIN_PEM` | The same key as PEM: the private key (not encrypted), the seal certificate, and the certificates that issued it. Each a path or the PEM text itself. Set these or `SEAL_P12`, not both. | none |
| `TSA_URL` | An RFC 3161 time-stamp service, so the seal carries its time (PAdES B-T) and not only the server's clock (B-B), and a completed PDF without a seal still gets a time stamp over the whole file. `http://ts.ssl.com,http://timestamp.digicert.com` are free. Several, separated by commas, are tried in order, 3 seconds each and 4 in all. A time more than 5 minutes from the server's clock is not used. `TSA_URLS` is read the same way. | none: B-B |
| `LTV_WAIT_MS` | With `TSA_URL`: how long, in milliseconds, all the answers about the seal's and the time-stamp service's certificates (OCSP, else revocation lists) may take together at completion, because the last signer's Finish waits for the stored file. When one does not answer in time the file stays at B-T and the page of the document says so. The document time stamp after them shares the same time. At most 120000. 0 turns long-term checking off (nothing is asked, the file stays at B-T and nothing is said). With `OUTSIDE_CALLS` listed or none, the hosts the certificates name must be added to `OUTBOUND_ALLOW`. | 20000 |
| `TSA_USER`, `TSA_PASSWORD` | HTTP Basic credentials for the time-stamp service, when it asks for them. They go to every address in `TSA_URL`, and only over https: with them set, a plain http address is not asked. | none |
| `SEAL_CSC_CLIENT_ID`, `SEAL_CSC_USERNAME`, `SEAL_CSC_PASSWORD` | Seals with a cloud signing service instead of a key file (SSL.com eSigner, see "The cloud seal"): the client id and the SSL.com account. All three, or the seal is refused and the startup log names what is missing. Not together with `SEAL_P12` or `SEAL_KEY_PEM`. | none |
| `SEAL_CSC_CLIENT_SECRET`, `SEAL_CSC_CREDENTIAL_ID`, `SEAL_CSC_TOTP_SECRET` | The client secret when the client has one; the credential to seal with (else the first eSealing one listed); the one-time code secret (base64, as SSL.com shows it) only for a certificate that asks for a code. | none |
| `SEAL_CSC_URL`, `SEAL_CSC_TOKEN_URL` | The CSC API and where its access token comes from. https only. Sandbox: `https://cs-try.ssl.com/csc/v0` and `https://oauth-sandbox.ssl.com/oauth2/token`. | `https://cs.ssl.com/csc/v0`, `https://login.ssl.com/oauth2/token` |
| `TSA_TRUST` | `bundled` for the roots of DigiCert and SSL.com built into the server (`deploy/tsa-roots.pem`), or a PEM file (or the PEM text) of the certificates the time-stamp service's own certificate must lead to. A time-stamp that does not is not used. Only with this set do the record, the certificate and the screens call a time stamp "trusted", and only then does `/verify` show a time stamp's time. | none: the time-stamp's signature, purpose and time are checked, not who issued its certificate, and nothing calls it trusted |
| `VERAPDF_CMD` | The veraPDF command line program (it needs Java), with any arguments, split at spaces. At most 2 checks run at once. With it set, account admins see "Archive format (PDF/A)" in Settings, Records and data, More options, and with that on, documents completed from then on are made as PDF/A-2b and checked by veraPDF (see "Archive format (PDF/A)"). It runs with only `PATH`, `JAVA_HOME` and a language set. | none: no PDF/A, the switch is not shown |
| `VERAPDF_TIMEOUT_MS` | How long one veraPDF check may take before it is stopped and the document is made as a normal PDF. The signed file and the "completed" emails are ready only after it; the signer is not kept waiting. Between 5000 and 600000. | 60000 |
| `SMTP_URL`, `MAIL_FROM` | Mail server, for example `smtps://user:pass@smtp.example.com`. Without it nothing is delivered, and the audit trail of an envelope says "Not emailed" instead of "Sent to recipient". An email the mail server will not take is kept and tried again by the timer (see `CRON_SECRET`): after 5 minutes, 30 minutes, 2 hours, 6 hours and a day, six tries in all. The envelope page and the audit trail say how it goes, and after the last try the sender is told. A mail server that stops answering is given up on after 10 seconds to connect, 10 for its greeting and 20 of silence (that try counts as failed); add `?connectionTimeout=&greetingTimeout=&socketTimeout=` in milliseconds to the address to change it. Emails about money are written down inside the account's billing step and handed to the mail server after it, a few at a time, so a slow mail server never holds up Cancel, a refund or a message from the payment provider; one that was never handed over (the server stopped) is sent by the timer. | none |
| `SMTP_REQUIRE_TLS` | `1` hands no email to the mail server in `SMTP_URL` without encryption: an `smtp://` address must offer STARTTLS, or the email is not handed over, is kept and is tried again (an `smtps://` address is encrypted from the first byte either way). Nothing in `SMTP_URL` switches the rule off. `/security` says whether it is on. It covers the one step from this server to your mail provider. How the provider carries the email on is decided there and on the recipient's side (MTA-STS, or REQUIRETLS at the provider). It is not end to end encryption. Off by default: the connection is then encrypted when the mail server offers it. |
| `MAIL_EVENTS_TOKEN` | A secret of at least 16 characters (`openssl rand -hex 24`; one with `+` in it also works pasted into the address as it is) that lets your mail provider tell this server what became of an email after it took it: delivered, bounced, marked as spam. Give the provider the address `https://<your domain>/api/mail/events?token=<the secret>` (or the secret as HTTP Basic password or `Authorization: Bearer`). See "Knowing when an email did not arrive". Without it the address answers 404 and nothing in the product mentions bounces. | none |
| `CRON_SECRET` | Lets a scheduler call `POST /api/cron`. Call it at least once an hour: it sends signer reminders and renewal reminders, expires signatures whose date has passed (with a line in the plan history) and emails top-ups that expire in 30 days or in 3 days while some are unused, tries emails again that the mail server would not take (so the gaps between tries are never shorter than the gap between calls), sends drafts whose Send later time has come and asks people whose wait has ended (a scheduler that calls less often makes both that much later), expires envelopes, retries refunds and cancellations the payment provider could not take the first time, closes accounts, and tells the operators and the customer when a help request has passed its response time. A renewal that is charged with no reminder on record raises an alert. | none |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GROVE`, `STRIPE_WEBHOOK_SECRET` | Turns on paying. Without them nothing is counted and there is nothing to buy. `STRIPE_PRICE_GROVE` is the monthly price. Point a Stripe webhook at `/api/stripe/webhook` and send it these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.upcoming`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`. | none |
| `STRIPE_COLLECT_TAX_ID` | Set to `1` and the payment page asks business buyers for their tax number (VAT, GST and the like) and billing address, and the provider prints both on the invoice. Put your own legal name, address and tax number on invoices in the provider's settings. Off by default: the provider refuses the request unless its settings allow it, so switch it on in test mode first and make one payment. Not tried against the real provider. | off |
| `STRIPE_WEBHOOK_WAIT_MS` | How long a message from the payment provider is worked on before it is answered. The provider counts a late answer as a failure, so a message that takes longer (the provider or the mail server is slow) is answered "received", kept in an inbox table and finished in the background; the timer applies anything left over after a restart or a failure. | `5000` |
| `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Payments while signing, into each account's own Stripe account (Stripe Connect). The client id (`ca_...`) and the platform's secret key (unset: `STRIPE_SECRET_KEY`) from the platform's Stripe dashboard, with `https://<your host>/api/collect/callback` as the redirect address; a Connect webhook endpoint (events on connected accounts) at `/api/collect/webhook` with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `account.application.deauthorized`, and its signing secret. All three, or nothing offers it. Never in `BILLING_MODE=deployment`. No fee is taken. | none |
| `STRIPE_API_VERSION` | Pins the version of the payment provider's API that calls are made with, for example the one shown in your Stripe dashboard when you tested. Set the webhook endpoint to the same version. Unset, the account's default version is used (both the older and the newer shapes of invoices, subscriptions and their tax lines are read), and a production server logs a loud warning once, because that default can change under a running server. | account default |
| `ACCEPT_DISPUTES_UP_TO_USD` | A card dispute always stops billing, takes the signatures the disputed payment bought off the balance (also ones held for envelopes that are out), switches new payments off until a person has looked (the operator page has the button to switch them back on), and tells the customer in writing. Disputes up to this amount are also accepted with the payment provider automatically instead of being fought; larger ones are left for a person to decide, and if the bank then lets the payment stand the signatures come back by themselves. `0` (or `ACCEPT_DISPUTES=0`) leaves every dispute to a person. | `25` |
| `SUPPORT_EMAIL` | The address people can write to. It is shown on `/help`, is told about every new help request and every late one (the answer is written in the operator queue, not by replying to that email; without this address those emails go to `OPERATOR_EMAILS`), and gets the alerts that need a person: a payment nobody could be matched to, a refund that keeps failing, a card dispute. Those alerts also go to `OPERATOR_EMAILS` and are kept in the operator queue. Set at least one of the two: with neither, nobody can open the queue and an alert is only a loud line in the server log. When set, the address is also printed in the footer of every public page; in the app, Help's "Talk to a person" reaches it. A production server that starts without it logs a loud warning, because the pages promise that a person answers. | none |
| `HOME_VIDEO_URL` | The video on the home page: Treegens' AI counting freshly planted mangroves in a planter's video. An mp4 or webm, as an `https://` address or as a file under `public/videos/` written `/videos/name.mp4`. `none` leaves the block out. Anything else (a page on a video site, another kind of file, an address with a password in it, a file name under `public/videos/` that is not there, an `http://` address when `APP_URL` is https) also gives no block, never an empty player. A file at another address is not fetched to check it: if it stops answering, the poster shows and the video does not play. It has controls, starts muted, never plays by itself and has a one-line caption that says what it shows, so set only a video that shows that (`src/lib/homevideo.ts`). | the video that ships, `public/videos/tree-count.mp4` (3 MB, with its poster, so nothing is fetched before someone presses play) |
| `HOME_VIDEO_POSTER` | The still picture shown before a video of your own plays: webp, jpg, png or avif, at the same two kinds of address. Without one the browser fetches the start of the video to show its first frame. | none (the shipped video has its own) |
| `ABUSE_EMAIL` | Where reports of suspicious documents go, and disputes ("I did not sign this"), which also go to `OPERATOR_EMAILS` and into the operator queue. | `SUPPORT_EMAIL` |
| `OPERATOR_EMAILS` | Comma-separated addresses of the people who run the service. Once their email is confirmed they can open `/app/operator`: help requests, reports, pausing or unpausing an account, and marking an account as trusted. They also make the top organisations above accounts, allow emergency access to documents for one, and move an agency between organisations (`/api/operator/orgs`, Settings, Organisation). They are the people a help request can be taken by or handed to, and they are emailed when one is late. They get every dispute with the internet address and browser it came from, and close it (closing its alert in the queue, or `POST /api/operator/disputes/:id`); until then its envelope cannot be deleted for good. | nobody |
| `SUPPORT_FIRST_REPLY_HOURS` | The published response time: a person answers a help request within this many hours of the message, counted in real hours (nights and weekends included). `/help`, the confirmation email and the request itself quote the actual time. Promised only while `SUPPORT_EMAIL` or `OPERATOR_EMAILS` is set. | `24` |
| `SUPPORT_URGENT_REPLY_HOURS` | The same for urgent requests: cannot log in, charged wrongly, a stuck document or a near deadline. Never longer than `SUPPORT_FIRST_REPLY_HOURS`. | `8` |
| `SUPPORT_CHAT_API_KEY`, `SUPPORT_CHAT_BASE_URL`, `SUPPORT_CHAT_MODEL` | Switches on an AI model for the help chat, through any host that speaks the OpenAI chat API: the key, the address of the API (https only; plain http only to this machine itself, for a model run locally, and with `DEPLOYMENT_PROFILE=government` or `OUTSIDE_CALLS` listed or none also to a private network address) and the model. First of the three ways to set a model up; see "The help chat". With `DEPLOYMENT_PROFILE=government` or `OUTSIDE_CALLS` listed or none, only this way counts, and only at a private network address or a host in `OUTBOUND_ALLOW` (`src/lib/chatboundary.ts`, `docs/self-hosted-model.md`). What people type into the chat then goes to that host, and `/security` lists it under "Where your data is". Without any key the chat answers from the built-in answers and nothing leaves the server. | none; `https://openrouter.ai/api/v1` and `moonshotai/kimi-k3` when only the key is set |
| `MOONSHOT_API_KEY` | The same through Moonshot AI's own API (`https://api.moonshot.ai/v1`, model `kimi-k3`, or `SUPPORT_CHAT_MODEL`). Used when `SUPPORT_CHAT_API_KEY` is not set. | none |
| `OPENROUTER_API_KEY` | The same through OpenRouter (model `moonshotai/kimi-k3`, or `SUPPORT_CHAT_MODEL`). Used when neither of the two above is set. | none |
| `SUPPORT_CHAT_DAILY_LIMIT` | How many questions the model answers for everyone on this server in a day (UTC). Past it, until midnight UTC, the built-in answers reply and people are told so, and the server log says it once. `0` sends nothing to the model. The limits per internet address, signing link and account are in `src/lib/chat.ts`. | `2000` |
| `WRITE_AI_DAILY_LIMIT` | How many drafts and changes the AI writes for one account in a day (UTC) in the writing view of editor step 1. They count against the help chat's limits too. `0` leaves writing by hand and the starters only. Needs the help chat's model. | `30` |
| `AI_ASSIST_DAILY_LIMIT` | How many AI suggestions for fields, drafted messages and signer summaries one account may ask for in a day (UTC), all together. They count against the help chat's limits too. `0` switches this help off. Needs the help chat's model; document text is read only on accounts whose admin switched on "Let the AI read document text". | `100` |
| `KEY_DATES_PER_TICK` | How many completed documents the timer reads for Key dates in one run, across the server, for accounts that switched Key dates on. Each counts as one AI request of its account's day, and the timer uses at most half of an account's `AI_ASSIST_DAILY_LIMIT`, so people keep the other half (with a limit of 1 it reads nothing by itself). `0` stops it reading by itself, and then the screens do not say documents are read by themselves; senders can still press "Find the dates and amounts". | `3` |
| `SUPPORT_CHAT_PROVIDER_NAME`, `SUPPORT_CHAT_PROVIDER_COUNTRY` | The company that runs the model and the country it handles what people type in, as `/security` and `/security/processing` print them. The name is known without this setting for OpenRouter and Moonshot AI; otherwise the address of the host is printed. Empty country: the pages say that it was not stated. | not stated |
| `FREE_PLAN_CODES` | Comma-separated codes that make the monthly plan free for whoever enters one. Set it to an empty value to have none. | `GROWalition` |
| `REFUND_DAYS` | How long after a payment its unused signatures are refunded on request, with no approval. A signature that has expired is not refunded (a month's expire at its end, so a monthly payment can be refunded only while its month runs). | `30` |
| `NEW_ACCOUNT_DAILY_RECIPIENTS` | How many people an account that has not paid can send to per day during its first week. "Has not paid" means: no payment for the plan or a top-up that is at least 14 days old and was neither refunded nor disputed (`PAID_TRUST_DAYS` in `src/lib/policy.ts`; a small amount the software sent back by itself because more was charged than we said is not a refund here, `STANDING_PAYMENT` in `src/server/credits.ts`), and not marked as trusted in the operator queue. So an account that paid yesterday still has the limit, and its refusals give the day it ends. Everyone a sender newly emails counts: a first send, a person added or an address changed on an envelope that is out, a bulk row. The visitors of a public form are counted apart, against the same number for each form, so a stranger on a form never uses up what its owner may send. Team invitations have a limit of their own, 20 people a day for each account (`TEAM_INVITES_PER_DAY`). | `50` |
| `UNPAID_DAILY_RECIPIENTS` | The same limit after the first week. A payment lifts both once it has stood for 14 days, and so does "Trust this account" in the operator queue, at once. The same two things lift the filter for fake payment notices. | `200` |
| `ABUSE_SUSPEND_AFTER` | How many different recipients must report an account within 30 days before its sending is paused for review. Open reports and reports an operator confirmed as abuse both count, also reports made with the security code of an email whose document was deleted since. Reports from visitors of a public form are shown to operators and never count, because such a visitor typed their own name and address. | `3` |
| `POWERFORM_IDLE_HOURS` | An unfinished start from a public form that nobody has touched for this long is closed, so it no longer counts against what the form can still take. Typing counts as touching. The visitor can start again. Never a start whose visitor pressed Finish while no signature was free: they were told that what they filled in is kept, so it stays open until the form's deadline, and they are emailed once (at the address they gave) when the form can take their signature. | `24` |
| `POWERFORM_SHARED_IDLE_MINUTES` | The same, for a form its owner marked as filled in on a shared device (a tablet at the front desk, one office network). Such a form also allows 30 unfinished starts at a time from one address instead of 3, and 120 starts an hour from one address for that form alone instead of 20 an hour for all ordinary forms together (`POWERFORM_SHARED_STARTS_PER_HOUR` and `POWERFORM_STARTS_PER_HOUR` in `src/lib/policy.ts`), and offers "start a new form for the next person" when someone has finished. | `60` |
| `CLICKWRAP_MONTHLY_LIMIT` | How many click-to-agree acceptances one account can record in a calendar month (UTC), over all its terms, counted apart for visitors who type their own details and for the people the website vouches for (a signed link or the API): each may reach it, so strangers typing on a page cannot use up what the website needs. An acceptance costs nothing, so this keeps a page anyone can open from filling the records. The owner and admins are emailed at 80 percent and when it is reached; after that a visitor is told that the terms cannot be accepted right now (nothing about the account), the API answers 429 with the day it starts again, and nothing is recorded until the 1st. `0` records none. | `1000` |
| `DORMANT_AUTO_STOP_DAYS` | A paid plan that has sent nothing for this long is not renewed. `0` only warns. | `90` |
| `SECURITY_LOG_DAYS` | How many days a line of an account's security record (Settings, Security) is kept, a whole number from 1 to 3650. The same for every account on the server, so an admin cannot shorten it to wipe what they did. The timer deletes older lines; until then database triggers refuse an UPDATE, a DELETE and an INSERT over an existing line, unless its account is deleted. That stops the app and careless hands, not someone who can change the database's own rules: see the security record under "What is in it" for what the keyed fingerprints show and do not show. Settings, Security, the API and the export quote the number. | `400` |
| `PWNED_CHECK` | The check of every new password (sign-up, the emailed link, Settings) against the Pwned Passwords list of passwords from data leaks. Only the first 5 characters of the password's SHA-1 leave the server; the comparison happens here. With no answer in 3 seconds, or an answer that is not the list, the password is allowed and nothing says it was checked. `0` (or `off`) switches it off; so does `OUTSIDE_CALLS=none`, unless the list's host is in `OUTBOUND_ALLOW`. | on |
| `HIBP_RANGE_URL` | Another copy of that list, for example a mirror inside a closed network: an `http(s)` address answering `GET <address><5 characters>` as the Pwned Passwords range API does. Anything else switches the check off. | `https://api.pwnedpasswords.com/range/` |
| `SECURITY_HEADS_DIR` | A folder outside the database. When set, the timer writes one file a day there (`security-heads-YYYY-MM-DD.jsonl`): one line per account with its id, the number, fingerprint and time of the newest line of its security record, and nothing else. Settings, Security then also holds the record against the newest 7 files and reads as changed when a noted line has another fingerprint or is gone before its days are over: that shows an older database put back, or a record rewritten by someone with the database and `APP_SECRET`. It shows nothing to someone who can rewrite the folder too, so copy it away or make it write-once, apart from the database and its backups. A file is never written over. | not set: nothing written or compared |
| `APP_SECRET_RETIRED` | Only after `APP_SECRET` was changed: the secret before (several separated by commas), so that lines of the security record that were fingerprinted with it still check when an admin opens Settings, Security. Used for nothing else: new lines, links and seals use `APP_SECRET`. Without it, admins are told that a line of their record does not match until the old lines have gone. | empty |
| `UNOPENED_ALERT_HOURS` | How long a request sits unopened before the sender is told. | `48` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Switches on "Continue with Google" on the sign-in and sign-up pages and under Settings. Both must be set. With either missing, nothing about Google is shown anywhere and its routes answer 404. Register the redirect address `APP_URL` + `/api/auth/google/callback` with Google (see below). | none |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The same for "Continue with Microsoft". Redirect address: `APP_URL` + `/api/auth/microsoft/callback`. | none |
| `MICROSOFT_TENANT` | Who may sign in with Microsoft: `common` (work, school and personal accounts), `organizations` (work and school), `consumers` (personal), or the id of one organization (the "Directory (tenant) ID", a value like `11111111-2222-3333-4444-555555555555`). A domain name is not accepted: Microsoft sign-in then stays off and the server log says why. | `common` |
| `SSO_SESSION_HOURS` | For accounts with single sign-on and "Everyone at these domains signs in through ..." on: how long a browser of someone at those domains stays signed in, 1 to 720 hours, before they go through the organisation's sign-in again. Single sign-on itself (OpenID Connect or SAML 2.0) and members from a directory (SCIM) are set per account under Settings, Security, and exist only with `FILE_ENCRYPTION_KEY` set. | `12` |
| `OPERATOR_NAME` | Who runs this server: legal name and country. Printed on `/security` ("Where your data is") and on the data processing summary (`/security/processing`), which says that a signed data processing agreement is between the customer and this party. Empty: the pages say "The operator of this server has not said who they are. Ask them." | not stated |
| `DATA_REGION`, `DATA_HOST` | Where the server and its files are (for example `Frankfurt, Germany`) and the hosting company. Plain text, printed as written. Empty: "The operator of this server has not said where it is hosted. Ask them." There is one region for everything, because storage is one disk. | not stated |
| `DATA_BACKUPS` | One sentence on whether and where backups are kept and for how long. Empty: the pages say that this was not stated. It is also quoted where a deletion says what stays (Settings, the document page, `/security/processing`). | not stated |
| `OUTSIDE_CALLS` | Which other machines the server itself may connect to: `all`, `listed` (only the hosts the settings imply, plus `OUTBOUND_ALLOW`; webhooks only to `WEBHOOK_ALLOW_HOSTS`) or `none` (only the mail relay and `OUTBOUND_ALLOW`; every service that needs another host is switched off at start and shown as off). Any other value is read as `none`. A second line of defence inside the software, not a firewall. See "Running it yourself". | `all` |
| `OUTBOUND_ALLOW` | More hosts the server may connect to in `listed` and `none`, separated by commas. `*.example.org` is any name under it. An entry that is not a host name is left out whole. With `DEPLOYMENT_PROFILE=government` or `OUTSIDE_CALLS` listed or none, it is also where the help chat's own model must be listed when `SUPPORT_CHAT_BASE_URL` is a name rather than a private network address. | none |
| `WEBHOOK_ALLOW_HOSTS` | In `listed` and `none`, the only hosts a webhook may go to. Empty there: no webhooks, and Settings says so instead of showing the form. A name listed exactly may be inside your own network; a name matched by `*.` may not. | none |
| `DEPLOYMENT_PROFILE` | `government` for a public body that runs its own copy. It changes two things: the signing record of every account carries no trees or paper estimate (and Settings shows no switch for it), and the help chat never goes to OpenRouter or Moonshot AI, only to a model you run yourself (`SUPPORT_CHAT_API_KEY` with `SUPPORT_CHAT_BASE_URL`, at a private network address or a host in `OUTBOUND_ALLOW`; `OUTSIDE_CALLS` listed or none does the same for the chat). Screens are the same as anywhere: "Trees on screens and emails" and "AI answers in the help chat" start on, and an admin can switch either off under Settings, Account. It claims no certification (see `/security/certifications`). Any other value runs as unset, and the server says so in its log as it starts. | unset |
| `BILLING_MODE` | How this server is paid for. `signatures`: the consumer product (signatures counted, held, used and expiring; Stripe when `STRIPE_SECRET_KEY` is set). `deployment`: for a public body paying one fixed fee a year under a contract. Nothing is counted, held or expires, sending has no signature limit, new accounts get no welcome signatures, no tree line is shown per signature, the `STRIPE_*` settings are taken away when the server starts (the log says so) so the payment provider is never called, every route of the plan (`/billing`, `/public/billing/*`, `/stripe/webhook`, `/operator/billing/*`) answers 404 in words, and Settings, Plan is one line about the agreement. No invoice is sent. There is no daily limit on how many people an account may email, nor on team invitations; the pause and the filter for fake payment notices stay, and only a person lifts them (the operator queue). The home page, `/pricing`, `/help`, `/impact`, the footer and the operator queue leave out prices, top-ups, expiry, trees per signature and the money tools. Any other value runs as `signatures`, and the log says so. | `signatures` |
| `LICENSE_HOLDER`, `AGREEMENT_REF`, `AGREEMENT_UNTIL` | In `deployment` mode, the line Settings shows: "This service is provided under `LICENSE_HOLDER`'s agreement `AGREEMENT_REF`, valid until `AGREEMENT_UNTIL`." (a date, YYYY-MM-DD). A part that is not set is left out. Nothing stops on the date: once it has passed, the line says so. | none |
| `SECURITY_CONTACT` | Where to report a security weakness: an email address or an https address, several separated by commas. Served at `/.well-known/security.txt` and shown on `/security/disclosure`. Empty: no security.txt, and the page sends people to the help address. | none |
| `SECURITY_REPLY_DAYS` | The days (1 to 90) within which you answer such a report. `/security/disclosure` promises exactly that, in your name, only when this and a contact are set. | none |
| `MAIL_PROVIDER_NAME`, `MAIL_PROVIDER_COUNTRY` | The company behind `SMTP_URL` and the country it handles email in. Listed among "who else handles data" only when `SMTP_URL` is set. | not stated |
| `PAYMENT_PROVIDER_COUNTRY` | The country of the Stripe company the payment account is with. Stripe is listed only when `STRIPE_SECRET_KEY` is set. | not stated |
| `SMS_PROVIDER_NAME`, `SMS_PROVIDER_COUNTRY` | The text message provider and where it handles messages. Listed only when text messages are switched on. The name is known without this setting when the provider is Twilio. | not stated |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | Switches text messages on, sent through Twilio with `fetch` (no SDK). The account id and the token are both needed, and one of a sending number in international form or a messaging service (which wins when both are set). With one of them missing text messages stay off and the server log says which. See "Checking who signs". | none |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | Switches text messages on through any other provider: every text is one `POST` to the address with the JSON body `{"to", "text"}` and `Authorization: Bearer <token>`. Answer 2xx when the text was taken. Answer 400 or 422 when the number can never be texted, which is final (so is any other 4xx except 401, 403, 404, 408, 409, 425 and 429). Anything else, and no answer within 15 seconds, is tried again by the timer like an email. Twilio wins when both are set up. | none |
| `SMS_DAILY_PER_ACCOUNT` | The most text message parts one account can cause in 24 hours: one-time codes, signing links and reminders, every new one counted, also a code that is asked for again. A text longer than one part, or with one character outside the GSM alphabet (then 70 characters a part), counts once for each part, as a provider bills it. A text goes only when all of its parts fit in what is left, and a send to several people adds up the parts of every text it would send, so the number is never passed. Curly quotes, long dashes and "..." as one sign are sent as plain ones, so they do not turn a text into UCS-2. A hard stop, because a text costs the operator money and customers are not charged for it. The refusal counts in parts and says when there is room again. `0` lets none through. | `200` |
| `SMS_DEV_OUTBOX=1` | Development only: text messages are switched on without a provider and are only written to `/dev/outbox`. Ignored on a production server unless `DEV_OUTBOX=1` is set too, because nobody receives anything. | off |
| `VOICE_ENABLED=1` | "Call me with the code" on the code screen of a check by text message: Twilio calls the number and reads the code out slowly, twice (`src/server/voice.ts`). Needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` (a number that can make calls); with `SMS_DEV_OUTBOX=1` on a development machine it only writes to the outbox. A call counts as one text against `SMS_DAILY_PER_ACCOUNT`. | off |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_INVITE` | Switches the signing link by WhatsApp on, through the Meta WhatsApp Business Platform (`src/server/whatsapp.ts`): an approved template (named here) with three blanks, sender, document and link. Off until all three are set: then nothing offers WhatsApp and the API refuses it. | off |
| `WHATSAPP_TEMPLATE_REMIND`, `WHATSAPP_TEMPLATE_DONE`, `WHATSAPP_TEMPLATE_DEADLINE`, `WHATSAPP_TEMPLATE_LANGUAGE` | The approved templates for a reminder, the link to the completed document and "closes soon" (falls back to the reminder), and their language code. A kind with no template is not sent, and the record says so. | none, `en` |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | Meta signs replies and delivery reports to `APP_URL/api/whatsapp/webhook` with the app secret; without it they are refused, so nobody could stop messages by replying STOP. The verify token answers Meta's one-time check of the address. | none |
| `TWILIO_WHATSAPP_FROM` | With the Twilio settings, switches WhatsApp on through a Twilio WhatsApp sender with this number. Replies and status reports come to the same address, signed with `TWILIO_AUTH_TOKEN`. | off |
| `WHATSAPP_DAILY_PER_ACCOUNT` | The most WhatsApp messages one account can cause in 24 hours. Each costs the operator money and customers are not charged for it, so this caps the cost until the owner sets a price. `0` lets none through. | `100` |
| `WHATSAPP_DEV_OUTBOX=1` | Development only: WhatsApp is switched on without a provider and messages are only written to the outbox. Ignored in production unless `DEV_OUTBOX=1`. | off |
| `ALLOW_PRIVATE_WEBHOOKS=1` | Accepts webhook addresses that are not public https. Local development only. | off |
| `DEV_OUTBOX=1` | Shows the outbox in a production build. Never set this on a public server: it exposes every signing link. | off |
| `CONVERTER` | `soffice`: Word, Excel, PowerPoint, OpenDocument, RTF, text, HTML and TIFF uploads are turned into PDF by LibreOffice on this machine (`soffice` on the `PATH`; Debian and Ubuntu: `apt install libreoffice-writer libreoffice-calc libreoffice-impress`). `gotenberg` (or leave it empty and set `CONVERTER_URL`): by a Gotenberg service. Anything else, or nothing: those files are refused, saying that a converter is needed, and nothing offers them. Read "Turning office files into PDF" first: the converter must have no network. (`stub` is for the tests and is ignored on a production server.) | off |
| `CONVERTER_URL` | The address of a Gotenberg service (MIT licence, `gotenberg/gotenberg:8`) inside your own network, for example `http://gotenberg:3000`. Files go to its `/forms/libreoffice/convert` in the clear, so keep it on a private network. | none |
| `CONVERT_TIMEOUT_MS` | How long one conversion may take before it is stopped (with LibreOffice here, its whole process group is killed). The sender is told that it took too long and nothing is saved. 1000 to 600000. | `60000` |
| `CONVERT_MAX_JOBS` | How many conversions run at the same moment; the rest wait their turn (up to ten times this many, then a polite 503). One account converts at most 2 files at once and 60 an hour. Plan for `CONVERT_MEMORY_MB` of memory for each. 1 to 32. | `2` |
| `OCR_CMD` | A command on this machine that reads the text of one picture of a page and prints it, for pages that are pictures (scans, photos, PNG and JPEG uploads). For Tesseract: `tesseract {file} stdout -l {lang}` (Debian and Ubuntu: `apt install tesseract-ocr` and a package per language, such as `tesseract-ocr-deu`). `{file}` is the page's picture (PNG or JPEG), `{lang}` the language code; it is started without a shell. A program path with spaces goes in double quotes. Read "Text for scanned pages" under "What is in it". | off |
| `OCRMYPDF_URL` | Instead of `OCR_CMD`: a service inside your own network that takes the PDF (POST, `application/pdf`, `?lang=eng`) and answers with the same PDF with a text layer, such as OCRmyPDF behind a small web wrapper. The whole document is sent to it. Ignored when `OCR_CMD` is set. | off |
| `OCR_TIMEOUT_MS` | How long one page may take to be read before the reader is stopped (a service gets this for each page it is asked for). A page that fails is tried again up to 3 times, then left without text. | `60000` |
| `CONVERT_MEMORY_MB` | The most memory one LibreOffice job may ask for (`ulimit -v`, its address space, which is a little more than what it really uses). A file of 1 KB can describe a sheet of a thousand million cells; we measured LibreOffice at 1.5 GB after 25 seconds on one, and still growing. With the limit such a job fails within seconds and the sender is told the file could not be opened. An ordinary document needs about 200 MB. 256 to 65536, or `0` for no limit. Not used with Gotenberg: limit its container instead. | `1024` |

`/help`, `/` and `/security` quote the refund window and the unused-plan rule. They read them from
`src/lib/policy.ts`, the same file the server enforces them from, so the pages and the code cannot disagree.

### Knowing when an email did not arrive

The mail server only says that it took an email. What happened next is told later by the mail provider, at
`POST /api/mail/events`, once `MAIL_EVENTS_TOKEN` is set. Every email goes out with a Message-ID of ours and an
`X-SG-Mail` header with its number, and the news is matched by those. News that names an id of ours which matches no
email (or one to another address) is logged and left alone, never guessed at by the address. When an envelope is
deleted, the number, Message-ID and account of each of its emails are kept for 30 days with a keyed fingerprint of
the address (never the address), so a spam complaint about it still counts against the account that sent it. News
without ids (Resend always, SES without "include original headers") is matched by the address among the emails of
the last 3 days, and only when they all come from one sender: one account, or our own emails to a login. When two
senders wrote to that address the news touches nobody and is logged, because nobody can tell whose email it was.
Code: `src/server/bounces.ts` (reading) and `src/server/routes-bounces.ts` (what is done).

What a recipient's mail server writes about a bounce is kept for the people who run the server (the dev outbox,
`emails.bounce_said`) and never reaches a customer: senders, the record and the pages say what it means in our own
words. A complaint is kept for the account (`mail_complaints`): nothing more is emailed to that address about the
account's documents, whatever the sender does (a correction away and back, "Try again", a new envelope), until the
person asks on a signing page and types a code we email to that address. "Try later" counts for each sender apart.
A batch is read to its end (up to 5000 events, a larger one is answered 413 whole), and after 8 seconds the answer
goes while the emails to senders are still being written, so a slow mail server never makes the provider resend.

| Provider | What to set up |
| --- | --- |
| Postmark | A webhook for Bounce, Spam Complaint and Delivery to the address above. `SMTP_URL` on `smtp.postmarkapp.com` also sends our number as metadata. |
| SendGrid | The Event Webhook (bounce, dropped, deferred, blocked, spam report, delivered) to the address above. `SMTP_URL` on `smtp.sendgrid.net` sends our number in `X-SMTPAPI`. |
| Mailgun | Webhooks for permanent and temporary failure, complained and delivered. `SMTP_URL` on `smtp.mailgun.org` sends our number as a variable. |
| Resend | A webhook for `email.bounced`, `email.complained`, `email.delivery_delayed` and `email.delivered`. Resend does not hand back our ids, so news is matched by the address. |
| Amazon SES | Bounce, complaint and delivery notifications (or event publishing) to an SNS topic with an HTTPS subscription to the address above. The subscription is confirmed by itself, only when its link is the `ConfirmSubscription` of that same topic at `sns.<region>.amazonaws.com`. An unsubscribe is written to the log each time. SNS signatures are not checked: the secret in the address is what protects it. Switch on "include original headers" so our number comes back. |
| Anything else | Post our own shape: `{"type": "bounce" \| "soft_bounce" \| "complaint" \| "delivered", "email": "...", "reason": "...", "message_id": "...", "mail_id": "..."}`, or a list of them. |

The five provider adapters were written from each provider's documentation and tested with one sample each. None
has been tried against the real service. A shape the server does not know (also inside an SNS notification) is
answered 202 and logged once. SendGrid's "dropped" for its unsubscribe list, a header it could not read or a quota
is about our setup, not the person: it marks nobody, says "not sent" on the envelope and is logged. Try
your provider's "send test webhook" button and look at the dev outbox or the log before relying on it.

### Checking who signs

For each recipient the sender chooses what has to happen before the document opens (the editor, step 1, the person's More, "Check who signs"
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
for one recipient; 15 a day to one mailbox or phone number from one sender's documents; and 100 an hour from one
caller address for one sender's documents that are then not typed in. All are counted in the database
(`signer_codes`), and the numbers are in `src/lib/policy.ts`. The limits are counted per sender on purpose: another
account, or a stranger typing an address into a public form (whose codes count for that form alone), can never
use up what someone else's document may send, and an office behind one internet address signing a bulk send all
get their codes. The caller limit needs `TRUSTED_PROXY_HOPS` to be right: an address the server cannot tell apart
is not counted at all, and the other limits hold anyway. Our stored copy of a code email or text loses the code
once the mail server or the provider has taken it, also when that happened on a later try. A device that passed
opens the document for that link for 24 hours, counted by the server from the moment the code was typed (the
cookie carries that moment, signed, so a copied cookie stops working at the same time and no two devices hold the
same one). Changing the check or the number, the link passing to another person, or another person taking the
place at the same address, makes every device pass again, and a pass is never written on another person's record.

**Before the code is typed** `GET /api/sign/:token` answers with less than it does behind an access code alone: no
subject, no message, no documents, no other recipients, no reason for a void, and the email address and the
number only masked (`j***@example.com`, `+44 *** *** 4321`). No answer of any route ever holds the code.

**When the code does not come** the screen has "I do not get the code" and, for a text, "This is not my number".
Both are written to the audit trail and emailed to the sender whatever their notification settings, because only
the sender can fix it. After "not my number" no further code and no text with the link goes to that number from
that sender's account, on any of its envelopes, also not a text that was waiting for another try, until the sender
confirms with the person that it is right after all (a box in the Correct dialog, `"number_confirmed": true` in
the API). Correcting the person to another number lets them in, and still leaves the disowned number alone.
Someone using the link can stop reminders only after typing the code (`POST /api/sign/:token/mute` answers 401
with `"code": "code_first"` before), so a stranger with the link cannot silence the signer; reporting the document
works without the code, and when a report stops texts the sender is told.

**The record.** The audit trail gets a line when a code is sent (the channel and the masked destination), when a
wrong code is typed, when the check is passed, and for every correction of a check. The certificate of completion
says for each signer how they were checked, for example "One-time code sent by text message to +44 \*\*\* \*\*\*
4321, passed 12 March 2026 14:02 UTC", and "Link sent by email only" when there was no check. For someone who
signed in person or whose link the sender shared, the line starts with that, then the code.

**Text messages** are off until the operator sets a provider up: Twilio, or any other through `SMS_WEBHOOK_URL`
(see the table above). While they are off the editor does not offer them, `GET /api/me` says `text_messages:
false`, and the API refuses `"sms_code"` and `"text_link": true` with a sentence that says the operator has not
switched them on. A text the provider would not take is tried again by the timer like an email (`POST /api/cron`),
and each later try is decided again by everything that applies at that moment, exactly as a first try is: the
number on file now, "not my number", a report, a decline, someone who has finished or switched reminders off, the
pause, the fake-notice filter and the daily limits. A refusal the provider gives at once (a number in the wrong
form, one whose owner opted out) ends trying, and the envelope page, the audit trail and an email to the sender
say what happened. "Sent" means the provider took the text, not that it arrived: a provider can accept a text to a
landline or a number nobody has and fail to deliver it later, and we are not told of that, which is what "I do not
get the code" is for. Premium-rate, satellite and international network numbers are refused when they are typed
(`NOT_MOBILE` in `src/lib/checks.ts`); premium ranges of other countries are left to the provider's own country
settings. In development, `SMS_DEV_OUTBOX=1` writes texts to `/dev/outbox`.

**"Also text the signing link"** (`text_link`, off unless chosen) sends a short text when the request goes out:
"GrowSigning, sent for Ada Sender: "Lease" is waiting for you to sign." and the link. Reminders by text follow at
most once a day, and one number gets at most 4 such texts a day from one account. Someone who declined or reported
the document is not texted again, and someone who switched reminders off gets no reminder by text. A text counts like an email to that person: none while the
sender is paused or the envelope reads like a fake payment notice, and an account under the daily limit on emails
can text as many phone numbers a day as people it may email. While sending is paused not even a code goes out by
text (a paused sender could otherwise keep texting the numbers it typed by opening its own links): the signer is
told neutrally that texts for this document are on hold, and the sender is told they can switch that person to a
code by email with Correct. A code by email still goes, to the mailbox that already has the link.

**What a text costs.** Texts are not charged to customers. `SMS_DAILY_PER_ACCOUNT` (200) is a hard stop per account
and 24 hours, in text message parts, never passed because a text goes only when all its parts fit, every part of every new text counted (`sms_usage.parts`: a text in Arabic or Amharic is UCS-2, 70
characters a part), and deleting an envelope hands nothing back.

**Corrections.** `POST /api/envelopes/:id/correct` and the editor take the check and the number. A change resets
any passed check for that person, clears "not my number", and is written to the audit trail with the numbers
masked. Changing the email address to another person's, or the name to another person's at the same address,
needs their number in the same call when a text is still asked for. When a signer passes a document on themselves, the number is dropped, a check by text becomes a code
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

### WhatsApp and codes by phone call

**WhatsApp.** With the Meta settings or a Twilio WhatsApp sender, a person's More in step 1 has "Also send the
link by WhatsApp" under "How they get it", with a mobile number and the tick "They agreed to get messages about
this by WhatsApp". The tick holds for the number it was given for and is written to the audit trail. The email
still goes; WhatsApp carries the invitation, a reminder (at most one a day), "closes soon", and once complete the
link to the finished document. The API takes `"whatsapp": true` and `"whatsapp_agreed": true` on a recipient.
Refused for templates (so bulk sends and public forms), groups, copies, in-person signers, someone whose link
the sender sends, and together with the text link. The pause, the fake-notice filter, a report, the daily limit
(`WHATSAPP_DAILY_PER_ACCOUNT`) and four messages per number a day hold every message, also one the timer tries
again. The envelope page says "Sent" when the provider took it and "Delivered to the phone" when it says so;
"read" is never shown, because it proves nothing. The certificate says "Link sent by email and by WhatsApp to
+44 *** *** 0123" once a provider has taken one. A reply STOP (signed webhook) stops WhatsApp to that number from the
account whose message it answers (or, when the reply quotes none, the account that wrote to it last), and from
no other account; START undoes it. When the person or the number changes (Change person, the editor's correction,
or a signer passing it on), WhatsApp is switched off for them and the certificate line goes with it; Change person
takes only `"whatsapp": false`, and refuses the link by text while WhatsApp stays on.

The texts to have approved as templates, with `{{1}}` the sender, `{{2}}` the document and `{{3}}` the link. Each
starts and ends with fixed words and uses each blank once, in order, which is how Meta's template rules want it;
paste them into Meta's template editor and check that it accepts them before you rely on them (this was not tried
against Meta):

- Invitation: `Hello. {{1}} asked you to sign {{2}} with GrowSigning. Open it here: {{3}} Reply STOP to get no more of these WhatsApp messages.`
- Reminder: `Reminder: {{1}} is waiting for you to sign {{2}}. Open it here: {{3}} Reply STOP to get no more of these WhatsApp messages.`
- Closes soon: `Closing soon: {{1}} asked you to sign {{2}}, and it closes soon. Open it here: {{3}} Reply STOP to get no more of these WhatsApp messages.`
- Completed: `Complete: {{1}} sent you {{2}}, and it is now complete. Your copy is here: {{3}} Reply STOP to get no more of these WhatsApp messages.`

**Call me with the code.** With `VOICE_ENABLED=1` and Twilio, the code screen of a check by text message has
"Call me with the code" under the code box, and before any code is sent "I have a landline: call me with the
code" under "Cannot get a code this way?": Twilio calls the same number and reads a new code out digit by digit, twice. It is the
same check, with the same digits, tries, limits and lock; the certificate says "One-time code sent by phone
call". It shows that someone answered that phone line, not who they are.

**What it costs.** Per call fees are the operator's; customers are not charged for them, and until the owner sets
a price (`src/lib/impact.ts`) the daily limit on texts caps them. Not tried against a live provider:
only against stand-ins (`tests/ds-channels.test.ts`). Send one real message in the provider's test mode first.

### Signing in with Google or Microsoft

Off until it is configured. A provider is on when both of its values are set, and then "Continue with Google" or
"Continue with Microsoft" appears on `/login` and `/signup` and under Settings, Security. `GET /api/auth/providers`
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
  mailbox (gmail.com, or an address in the very Google Workspace domain the `hd` claim names; an address in another
  domain of that organization gets our own confirmation email instead). For Microsoft it means the optional
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
  and connections that were not vouched for are all cut off. So is everything set up in it that would go on working
  or receiving for whoever started it (`src/server/reclaim.ts`): its webhooks with their log, invitations nobody
  accepted, the name, job title, company, signature, initials and email settings on the profile (the name becomes
  the one the provider knows), the workspace name, brand colour, logo and two-step rule, and its stamps; its public
  forms and click-to-agree pages are switched off, because confirming the address would otherwise open them. Only
  workspaces that login is alone in are touched. Drafts, templates, contacts and signing groups stay. The person is
  told on screen and by email exactly what was removed and what is still there to look at. The same happens when
  the address of a never-confirmed login is first proven by a password link (the name is then the part of the
  address before the @, until they change it). A login whose address is not confirmed cannot add a webhook.
- Someone already signed in who comes back from the provider with an account we do not know is not made a second
  login: Settings says to connect it there, or to sign out first for a separate login. A sign-in that ran out or was
  replaced in another tab sends a signed-in person back to Settings, not to the sign-in page. Started sign-ins that
  never came back are cleared by the timer after their ten minutes, and at once when the login they name is deleted.

What is checked on every sign-in: the `state` works once, for ten minutes, and only in the browser that started
(an HttpOnly cookie); PKCE (S256); and the ID token itself, here and not by a library: RS256 and nothing else,
the signature against the provider's published keys (kept for an hour, read once more when a token names a key we
have not seen), issuer (for Microsoft the organization named in the token itself, and `MICROSOFT_TENANT` when it
names one), audience, expiry and the nonce of this sign-in.

### Single sign-on for an organisation

An owner or admin sets it up under Settings, Security, "Single sign-on", for their own account; nothing is set on
the server for it except `FILE_ENCRYPTION_KEY`, without which the card is not shown and the routes refuse (the
client secret is only ever kept encrypted with that key). The code is `src/server/orgsso.ts` (the rules),
`src/server/routes-orgsso.ts` (the card's routes and the sign-in), `src/server/oidc.ts` (the OpenID Connect client,
shared with Google and Microsoft) and `src/components/settings/OrgSso.tsx`.

1. **Your email domains.** Add `example.org`; the card shows a TXT record named `_growsigning.example.org` with a
   random value. "Check now" looks it up (`node:dns`); found once, the domain is the account's and no other account
   can claim it while the record stands. The timer looks again once a day. A record that is gone pauses single
   sign-on for that domain (the card says so, the owner and admins are emailed, and people there sign in the usual
   way meanwhile); it comes back by itself when the record is found again. A DNS server that does not answer
   changes nothing. When the record of one account is gone and another account's is there, the second account gets
   the domain. A claim covers exactly that domain, not its sub-domains.
2. **Your sign-in service.** A name (on the button "Continue with Acme sign-in"), the issuer, the client id and the
   client secret; register `APP_URL` + `/api/sso/callback` at the service. The issuer must be https and lead to a
   public host, and `<issuer>/.well-known/openid-configuration` must name exactly that issuer, https addresses, PKCE
   with S256 and RS256 or ES256 when it lists them. It is kept for an hour. The hosts of the issuer, the token
   endpoint and the key list must lead to public addresses, checked each time the document is fetched again and on
   every sign-in, so a document that later names a host inside a private network is refused. Then "Try a sign-in":
   until an admin went through the service once with success, nothing on the sign-in page changes. A new issuer or
   client id needs a new try, and it, like removing the service, removes every login's connection to the old one:
   each person is connected again by their address the next time they sign in, so moving to another service does
   not lock anyone out.
3. **On the sign-in page**, email and password stay on one screen. As someone leaves the email box with an address
   at a claimed domain, the password box gives way to "Continue with Acme sign-in" (and "Use my password instead").
   The service's token is checked like Google's: state once and in the same browser, PKCE, nonce, the signature
   with RS256 or ES256 against the service's key list (fetched again for a key it does not hold), `iss` equal to the
   issuer, `aud`, `exp` and `iat`. Its address must be at a claimed domain of the account and not marked unconfirmed.
   A person is the service's own id for them (issuer and `sub`). An existing login with the address is connected
   and its owner emailed; otherwise a login is made, with a workspace of its own, or as a member of the account when
   "Add people from these domains as members when they first sign in" is on (off by default); the landing page then
   says a new login was made, and that a login under another address stays where it was. Our own two-step login is
   still asked for when the login has it.
4. **"Everyone at these domains signs in through Acme"** can be switched on after a successful try, with a claimed
   domain, and with the owner's two-step login on. Then for every address at those domains a password, sign-up,
   Google and Microsoft are refused with the reason, "Forgot password" emails how to sign in instead of a link, and
   browsers stay signed in for at most `SSO_SESSION_HOURS` (12), also the ones signed in before. Someone who leaves
   the organisation and whose login there is closed is therefore out within that time; nothing tells us the moment
   it happens. API keys made by such a person keep working until they are removed from the team. The owner's way
   back in, if the service breaks: "Account owner? Use your password" on the sign-in page, then the two-step code;
   each use is a line in the security record. Anyone else asking for it is refused before the password is looked
   at. While the rule is on, the owner cannot switch two-step login off, the account cannot be handed to someone
   without it, and taking a domain out of single sign-on or removing it asks for the two-step code. If the owner's
   two-step login goes anyway (a reset by email after a lost phone), the card says that there is no way back in
   until it is on again.

Every change, claim, lost record, try and use of the way back is a line in the security record. **What was
tested:** only the stand-in service in `tests/ds-sso-oidc.test.ts`. No real identity provider has been tried end to
end yet, so none is listed as supported; whoever runs the server should note here each one they have tried.

### SAML 2.0 and members from your directory

Both live in Settings, Security, for the owner and admins, and need nothing on the server beyond
`FILE_ENCRYPTION_KEY` (the same rule as the rest of single sign-on). The code is `src/server/saml.ts` and
`src/server/routes-saml.ts` (SAML), `src/server/scim.ts` and `src/server/routes-scim.ts` (SCIM),
`src/components/settings/OrgSaml.tsx` and `src/components/settings/OrgDirectory.tsx`. The claimed email domains, "Try a
sign-in", "Everyone at these domains signs in through ...", the owner's way back in and the shorter sessions are the
ones described above, the same for both standards.

1. **SAML 2.0.** In the Single sign-on card, choose "SAML 2.0" under "Your sign-in service". Give your identity
   provider our entity id (`APP_URL/api/sso/saml/sp/<random>`, which also serves our metadata) and our reply address
   (`APP_URL/api/sso/saml/acs`, HTTP-POST only). Paste its metadata or choose its file: one identity provider, a
   sign-in address for HTTP-Redirect at https, and at least one signing certificate that has not ended. Then "Try a
   sign-in". The XML signature is checked by `@node-saml/node-saml` (MIT) with `xml-crypto`, never by our own code.
   We require: the assertion itself signed by a certificate from the metadata, its Issuer the metadata's entity id,
   our entity id as Audience, a bearer confirmation with our reply address as Recipient, a NotOnOrAfter still ahead
   (30 seconds allowed for clocks), and InResponseTo the request this browser's sign-in sent, within 10 minutes and
   once. An assertion id is accepted only once. The answer is checked when the provider's page posts it, then the
   browser goes on to `/api/sso/saml/finish`, where the cookie set when the sign-in started must come back, so an
   answer carried to another browser signs nobody in. The address comes from an `email`-like attribute or an email
   NameID, and must be at a claimed domain. New certificates for the same entity id keep the service tried (a key
   rollover); another entity id needs a new try. Not supported: signed AuthnRequests, encrypted assertions, sign-ins
   started from the provider's portal, single logout.
2. **Members from your directory (SCIM 2.0).** Shown once single sign-on was tried with success. "Make a token"
   shows a token (`tss_...`) once; only its SHA-256 is kept, and a new one replaces it at once. The base address is
   `APP_URL/api/scim/v2`; Users can be created, read, listed with `filter=userName eq "..."` (or `externalId eq`),
   replaced, patched and deleted. Only addresses at the account's claimed domains are taken. Someone with a login
   becomes a Member at once and is emailed; someone without one becomes a Member the first time they sign in through
   the service. Nobody is made an admin and a role is never changed. Switching someone off (`active` false, also the
   string "False" Entra sends) or deleting them removes them from the team the way an admin removing them by hand
   does: what they sent passes to the member chosen in "Who takes over what a removed member sent", or to the owner;
   their API keys stop; their browsers in the account are signed out; they and the admins are emailed. The directory
   can remove admins too, so only the owner or someone with the built-in Admin role can make or stop its token or
   change the card; a role an admin made (even one based on Admin) gets 403 and does not see the card. The owner is
   never removed (409, also when the directory first sends the owner switched off, and then nothing is kept).
   "Members are managed by your directory" stops invitations by hand: the Team tab says so in place of Invite. If
   single sign-on is removed or stops working, the directory is paused (its calls get 403), the card says so, and
   invitations by hand work again until it is fixed. Every token, switch, person added and person removed is a line
   in the security record.
3. **When "Try a sign-in" fails with SAML**, the card says why in one sentence and what to change at the identity
   provider: the assertion is not signed, another issuer, another reply address (or an older try), another audience,
   no email address, clocks off, or the provider said no. Only the admin's try is told this; a person signing in from
   the sign-in page gets the usual short answer.

**Identity providers tested end to end:** only the stand-in identity provider and directory calls in
`tests/ds-sso-saml-scim.test.ts`. No real identity provider or directory (Okta, Microsoft Entra ID, Google, OneLogin,
Keycloak, ADFS) has been tried yet; whoever runs the server should note here each one they have tried.

### Two-step login

Nothing to configure. Anyone can switch it on under Settings, Security: the standard time-based codes (RFC 6238: 6
digits, 30 seconds, SHA-1) that every authenticator app makes, written out with `node:crypto` in
`src/server/twostep.ts`, which also holds the rules. The routes are in `src/server/routes-twostep.ts`, the numbers in
`src/lib/policy.ts` (`TWO_STEP_*`).

- Switching it on needs a confirmed address and asks for the password (or a sign-in within 15 minutes, for a login
  without one), shows the secret as a QR code, as text and as an `otpauth://` link, and counts only after a right
  code. Then ten recovery codes are shown once; only their fingerprints are kept, and each works once. Every other
  browser is signed out.
- Nothing takes it away but its owner with a code, an admin reset or the reset by email. A password reset by email,
  signing in with Google or Microsoft and confirming the address never do (`cutEarlierAccess` in `src/server/auth.ts`
  leaves it alone), and every one of them still asks for the code before there is a session.
- Every sign-in ends in `signInAs` (`src/server/routes-account.ts`): the password, Google or Microsoft, and the sign-in
  after a password reset by email. With two-step login on it gives no session, only a waiting sign-in tied to that
  browser by an HttpOnly cookie for 10 minutes; `POST /auth/two-step` with a right code finishes it. Google or
  Microsoft that is not connected to the login yet is connected only after the code (`linkProvider` in
  `src/server/routes-signin.ts`). Changing or resetting the password, or "Sign out everywhere else", ends waiting
  sign-ins.
- A wrong password for a login with two-step login gets the same second screen as the right one, and after the code
  both get the same answer ("the code is not right, or the password before it was not") and the same count, so a
  password cannot be found out by trying it there. Five wrong codes in a row after the right first step pause that
  login's second step for 15 minutes and email its owner (once a day at most); after a wrong password they pause only
  that internet address (`two_step_tries`), so a stranger cannot keep the owner out, and the right code after the
  right password still gets through such a pause. Codes under Settings count per browser. Each try is taken by one
  conditional `UPDATE` before the code is checked, so requests at the same moment get no extra tries. A code works
  once (the step of the last code used is kept).
- "Remember this device" skips the second step in that browser for that login for 30 days, through a cookie of its
  own; Settings lists those devices and withdraws them, which also signs those browsers out
  (`sessions.two_step_device`).
- Losing the phone: a recovery code; else an owner or admin of the team resets it (`POST
  /account/members/{id}/two-step/reset`, after their own code if they have two-step login, emailed and logged), but
  only for a member who owns no workspace and is an admin of no other. Everyone else, and anyone who prefers it, uses
  the reset by email: it needs the right password (typed after Google or Microsoft too), at most one waits, at most
  three emails a day, and it takes effect 7 days after the emailed link was opened. Every day an email from the timer
  (`POST /api/cron`) has a link that stops it without signing in (`/two-step-reset?stop=`), every page of the app shows
  it in every signed-in browser, and any sign-in with a code, a recovery code or a remembered device stops it, as does
  a password change while signed in. Stopped any other way, a new one waits 7 days unless the person signs in with a
  code. When it takes effect every browser is signed out. "Allow a reset by email" under Settings, Security (on by
  default, changed with a code) switches it off; then only an admin reset is left, or nothing.
- An owner can require it for a team: a member without it can then only set it up, switch workspace, leave, see and
  end their sessions or close their login in that account (403 with `"code": "two_step_setup"`), and the app shows only
  the setup.
- Changing the password, the email address or the second step itself asks for a current code. API keys are not
  affected, and no key can see or change two-step login, nor change the password (`PERSON_ONLY` in
  `src/server/router.ts`); `GET /me` leaves two-step login out for a key.
- The secret is kept in the database as it is, because the server has to read it to check a code.

### Turning office files into PDF

With `CONVERTER` or `CONVERTER_URL` set, an upload that is a Word, Excel, PowerPoint, OpenDocument, RTF, text, HTML
or TIFF file becomes a PDF before anything else (`src/server/convert.ts`). What a sender gets back, and what the
pages and the API say, is in "What is in it" above; this is what an operator needs to know.

- **The converter must have no network and should not see your files.** A document can name pictures and files
  outside itself: on other servers (fetching them tells their owner when and from where the document was opened, and
  can reach servers inside your own network) or on the converter's own disk (a web page whose background was a file
  path got that picture into the PDF, until this was closed). With `CONVERTER=soffice` every job is shut in as far
  as the machine allows, and the first job writes in the server log which of these it is:
  1. **A box** (`unshare -rnmpf`, then mounts and `pivot_root`, so the machine's own root is let go; needs unprivileged
     user namespaces, and nothing else installed): no network, its own process list, and a file system of its own that holds LibreOffice, the
     system's fonts and linker settings read-only, and the job's folder as `/work`. The app, `DATA_DIR`, `/home`,
     `/root`, `/tmp`, `/var` and the rest of `/etc` are not there. A LibreOffice installed outside `/usr` (in
     `/opt/libreoffice...`) is found by following `soffice` on the `PATH`. Fonts must be installed for the whole
     system (`/usr/share/fonts`), not in a home folder. `src/server/convert-box.ts`.
  2. **No network only** (`unshare -rn`), when the box cannot be built: the log says that LibreOffice can see the
     files of the machine. Then run the app as a user that can read nothing but the app.
  3. **Nothing**, when neither works: the log says so loudly, and LibreOffice runs with the server's network and
     files. Then block it yourself: run the whole app as a user whose outbound traffic is dropped except for what
     the app needs (mail, payments), or use Gotenberg in a container on a network with no way out (Docker:
     `docker network create --internal convert`, then run `gotenberg/gotenberg:8` on that network only, and give
     this app a second network to reach it; `docker-compose.example.yml` has this ready as its `office` profile).
     Gotenberg itself does not block a document's outside links: the network around it does.

  Whatever the machine allows, **a web page is never handed over as it was uploaded**
  (`src/server/convert-html.ts`): every address in it is taken out first (backgrounds, pictures, style sheets,
  `url(...)`, frames, objects, anything in an attribute that reads like an address or a path), except pictures the
  page carries inside itself (`data:` addresses) and links a reader can click (http, https, mailto). The sender is
  told "This file links to pictures or content stored elsewhere. They may be missing from the PDF." The original
  that is kept is the page as uploaded. With Gotenberg the same cleaned page is sent. For the other kinds (Word,
  OpenDocument, RTF and so on) LibreOffice's own setting refuses links out of a document; in our probes that held
  for linked pictures, linked sections, included text, embedded objects, WEBSERVICE and DDE, but it is LibreOffice's
  promise, not ours, which is why the box matters.
- **Each LibreOffice job** gets a fresh profile folder (`-env:UserInstallation`), only `PATH`, `HOME`, `TMPDIR` and
  the language from this server's environment (none of its secrets), a memory limit (`CONVERT_MEMORY_MB`), its own
  process group, which is killed whole after `CONVERT_TIMEOUT_MS`, and a temporary
  folder under the system's temporary directory that is removed when it ends (a folder left by a server that was
  stopped mid-job is removed by the first job after the restart, once it is an hour old). At most `CONVERT_MAX_JOBS` run at once. The file is in that folder in the
  clear while the job runs, also when `FILE_ENCRYPTION_KEY` is set; with Gotenberg it travels to the service in the
  clear. Keep LibreOffice up to date: opening a document is what its security fixes are about.
- **Macros.** The profile of every job sets LibreOffice not to run macros (`DisableMacrosExecution`, and the highest
  macro security level), and a file that has macros is pointed out to the sender. We could not test the switch
  itself: in a headless conversion our test macros did not run even with macros allowed, so there is no run to
  compare against. Do not rely on the setting alone. What a macro could do if one ever ran is what the box, the
  memory limit and the timeout leave it: its own folder, no network, a minute.
- **Before anything opens a file**, a ZIP-based one (OOXML, OpenDocument) is unpacked in memory with every byte
  counted, whatever sizes it claims, and refused past 100 MB or 20 times its own size. Without a converter nothing
  is unpacked at all.
- **What is checked and what is not.** The kind of file and the notes (tracked changes, comments, split sheets,
  outside content, macros) are read from the file itself, in the newer formats and RTF and HTML; in the old binary
  .doc, .xls and .ppt only the kind is known. A TIFF with more pages than the PDF made from it is refused, so no page
  goes missing. Fonts the file uses that are not installed with the converter are replaced, which moves text: that
  is why every converted document says to check every page. The tool and version in the audit line come from
  `soffice --version`, or for Gotenberg from the PDF it made and its `/version` answer. Gotenberg has only been
  tried against the shape of its documented API, not against a running service.

### Encrypting stored files

Off unless `FILE_ENCRYPTION_KEY` is set. With it set, every file the app writes to `DATA_DIR/blobs` is encrypted by
the app itself (`src/server/filecrypt.ts` for the format, `src/server/filestore.ts` for the rules below).

- **Switching it on.** Make a key with `openssl rand -base64 32` (or `node scripts/encrypt-files.mjs --new-key`): 32
  random bytes written as base64. Put it in `FILE_ENCRYPTION_KEY`, keep a copy somewhere apart from the server and its
  backups, and restart. New files are encrypted from then on, and files stored before stay readable as they are. To
  encrypt those too, stop the server and run `node scripts/encrypt-files.mjs` with the same settings (it reads the
  environment, `.env.local` and `.env`, like the server). `--check` only counts and checks every file, and changes
  nothing.
- **What is protected.** The files: uploaded documents, signed PDFs, the copies kept of what someone signed before a
  change, the files signers attach, and PDFs attached to emails that are still waiting to be sent. Each is encrypted
  with AES-256-GCM under a key made for that file alone (HKDF-SHA256 of the server's key with a random salt and the
  file's name), behind a small header that says the format version and which key wrote it. That key id is an HMAC of
  the key and says nothing about the key. Every file is checked when it is read, also the ones stored before: one
  changed byte, a file cut short, or a file copied under another name is refused (500, `"code": "file_damaged"`),
  never handed out, and the people who run the server get an alert in the operator queue and in the log, and by
  email when `SUPPORT_EMAIL` or `OPERATOR_EMAILS` is set. The export leaves such a file out and names it in its
  `README.txt` (a locked file is named apart, as locked and not lost). An email waiting for another try goes without
  an attachment that cannot be read, and says so at the top.
- **Part of the database is encrypted with the same key** (`src/server/colcrypt.ts`, `src/server/colsweep.ts`):
  signatures and initials as pictures (of signers, the ones a login keeps, and the ones kept when a document was
  changed after signing), what people typed or chose in fields (also the plain number kept next to a typed or
  worked-out number) and what the sender filled in for them, answers typed into a public form before it is signed,
  comments, the stored copies of emails with their plain text and archive copy, decline reasons, and the messages,
  replies and attached chats of help requests.
  Each column has a key of its own (HKDF-SHA256 of the server's key with the table and column), every value a fresh
  nonce, and each value is checked when it is read: one changed on the disk is refused (503, `"code": "data_locked"`),
  and one under a key the server was not given reads as empty while the rest of the record is served (as with
  stored files); neither is ever shown in another form, and the log and `/app/operator` name the key id that is
  missing. Kept readable on purpose, because search and joins need them: names, email addresses and phone
  numbers, subjects, ids and fingerprints of files, and the audit trail (chained line by line, and it repeats a
  decline reason). Values written before the key was set, or under an old key, are encrypted by the server when it
  starts and then a batch on every run of the timer, overwritten where they stood; `node scripts/encrypt-columns.mjs`
  does all of it at once and can run while the server runs (`--check` only counts). Help-queue search opens the
  messages in memory; the search of documents works on subjects, names and the kept text as before. Every write of
  those columns goes through `seal()`, and every read through `get()` and `all()` in `db.ts`, which open them. A save
  writes only the columns it changes, so a value that reads as empty while its key is missing is never written over.
  One write is not sealed at once: billing alerts to operators (`routes-billing.ts`), which the sweep seals later.
  `npm run setup` writes a new key into `.env` for a new install, and never over one that is set. Without a key the
  server says so when it starts and in one line on `/app/operator`.
- **The text read from uploaded PDFs** (kept for search and for the check before sending) is encrypted with the same
  key, in the database (`src/server/searchtext.ts`). A search opens it in memory, for the one account that searches.
  Text kept before the key was set is encrypted when the server starts with the key, and text under an old key moves
  to the current one at the same start.
- **What is not protected.** The rest of the database (`DATA_DIR/sign.db`) is not encrypted by the app. It holds the
  names, email addresses and phone numbers of everyone on a document, the subjects and messages of envelopes and the
  names of documents and folders, the address and subject of each stored email, the stored copies of text and
  WhatsApp messages, click-to-agree terms written as text, custom fields, contacts, payments and every audit trail.
  Someone with the disk or a backup reads all of that unless the disk itself is encrypted. Files stored before the
  key was set stay readable in backups made before then, and can stay in the free space of the disk after the script
  has encrypted them. And the key is in the server's settings, so this protects a
  copy of the disk or of a backup taken without those settings (a stolen disk, a backup that leaks), not a break-in
  to the running server or to its settings. Encrypt the disk as well. `/security` and the data processing summary say
  all this on a server where it is on, and say that the files are not encrypted where it is off.
- **What the names give away.** A stored file is still named by the SHA-256 of its readable contents, so the same
  file stored twice is one file and `/verify` still compares fingerprints. Someone with the disk therefore sees which
  stored files are the same as each other and roughly how large each is, and someone who already has a copy of a
  document can check whether that exact file is stored here by working out its fingerprint. The same fingerprints
  are in the database anyway. Nobody learns from a name what a file says.
- **Changing the key.** Put the new key in `FILE_ENCRYPTION_KEY` and the old one in `FILE_ENCRYPTION_KEYS_OLD` (a list
  separated by commas), restart, then run the script: it moves every file to the new key. Meanwhile files under a
  listed old key stay readable. Take an old key out only after `node scripts/encrypt-files.mjs --check` says that no
  file uses it.
- **A mistake with the key loses nothing.** When it starts, the server reads the first bytes of every stored file to
  see which keys they need. If it finds files written with a key it was not given (a new key set in place of the old
  one, or the key left out after a move), it says so loudly in its log, files an alert, reads everything it can, and
  stores no new file until that key is listed again: an upload or an attachment answers 503 (`"code":
  "storage_stopped"`) saying that nothing was saved, and a signed PDF is made later by the timer, once files can be
  stored again (the timer tries none while storing is stopped, and counts none of those against the envelope). So
  new files are never written with one key while older ones need another that nobody can find. A
  `FILE_ENCRYPTION_KEY` that is not a key stops storing files the same way, so files are never stored as they are
  while the operator believes they are encrypted. A file whose key is not listed answers 503 (`"code":
  "file_locked"`) and stays on the disk untouched.
- **A signed PDF that cannot be made never holds up the others** (`src/server/finalretry.ts`). Each failed try is
  counted and the next one waits longer (10, 20, 40, 80 minutes); the timer takes the envelopes that are due, those
  never tried first. After 5 tries the sender is emailed that the signed PDF is delayed and why, and the operators
  get one alert; it is then tried once a day, so a file put back from a backup still gets its PDF, and the sender is
  emailed when it is ready. A signer's attachment that fails its check is never left out of the sealed PDF: the
  build waits for it in the same way.
- **The script cannot lose a file.** Each file is encrypted into a new hidden file next to it, flushed to the disk,
  read back and checked, and only then takes the name of the plain copy, in one step. Stopped at any moment, it
  leaves at most a half-written hidden file, which the next run removes. Run again, it skips what is done. Files it
  cannot read (damaged, or under a key that is not listed) are named and left as they are, and it ends with exit
  code 1 until everything is done. Only one run goes at a time.
- **Switching it off.** Move the key to `FILE_ENCRYPTION_KEYS_OLD` and leave `FILE_ENCRYPTION_KEY` empty: new files are
  stored as they are and the encrypted ones stay readable, and so does the text kept for search. There is no script
  that decrypts files. `/security` then says that new files are stored as they are, and that those stored while it
  was on stay encrypted. Keep that key listed: the text kept for search stays under it, and `--check` does not look
  at the database.
- **Lose the key and the encrypted files are gone.** Nobody can read them, and that includes us. To store files again
  after that, move the files the server cannot read out of `DATA_DIR/blobs` (keep them, in case the key turns up) and
  restart; asking for one of them then answers that it cannot be found. The text kept from those documents is gone
  too: a search no longer finds them by the words inside, and the check before sending reads only their names.

### The digital seal of a completed PDF

With `SEAL_P12` (or `SEAL_KEY_PEM` and `SEAL_CERT_PEM`) set, every PDF completed from then on carries an invisible
PAdES signature of whoever runs the server: an electronic seal of the server over the whole file. Anyone can open
the file in a PDF reader that checks signatures and see whether it has changed since it was sealed, and which
certificate sealed it, without asking us. What was checked: poppler's `pdfsig` and `openssl cms -verify` accept the
seal in `tests/seal.test.ts`. It has not been opened in Acrobat, Foxit or the EU DSS validator yet; do that with
your own certificate before you rely on it. It is not a signature of the people who signed: it does
not show who stood behind each signature. We do not call it an advanced or a qualified seal.

How it is made (`src/server/finalpipe.ts`, `seal.ts`, `sealpdf.ts`, `sealcms.ts`, `sealkey.ts`, `p12.ts`, `tsa.ts`,
`der.ts`, `x509.ts`, all on `node:crypto` with no new dependency):

- `buildFinal` calls `finishPdf`, which decides the seal before the certificate of completion is drawn, so the
  certificate's "Digital seal" line describes the seal of its own file, then seals. The stored SHA-256, the size,
  the completion email's fingerprint and `/verify` are all of the sealed file.
- The seal is appended as an incremental update: the rendered file stays byte for byte inside the sealed one. It is
  an approval signature with `/SubFilter /ETSI.CAdES.detached`, `/M` for the time, a `/ByteRange` over everything
  but the 32 KB `/Contents`, and an invisible field on the last page. The CMS carries content-type, message-digest
  and signing-certificate-v2 as signed attributes, no signing-time, and the certificate chain: PAdES B-B. The
  signature is RSASSA-PSS with SHA-256 for an RSA key, ECDSA with SHA-256 for P-256. The ETSI clause of each part
  is named in the code; the ETSI texts could not be opened from the machine this was built on, so the clause
  numbers were checked from memory and the structure by `pdfsig` and `openssl` in `tests/seal.test.ts`.
- With `TSA_URL`, an RFC 3161 time-stamp over the signature value goes into the seal (PAdES B-T). It is used only
  when it checks out: granted, over our signature, with our nonce, signed by a certificate meant for time-stamping
  that was valid at that time, giving a time within 5 minutes of the server's clock (so a service that lies about
  the time, or a server whose clock is wrong, gets no time stamp), and with `TSA_TRUST` issued under one of those
  certificates. Without `TSA_TRUST` nobody checked whose service answered, so the record, the certificate and the
  screens say "a time stamp from a time-stamp service" and never "trusted". When no service gives one, the file is
  drawn again and sealed at B-B at once, and its certificate says the time is the server's clock. The signed PDF is
  never held back for a time-stamp: everyone's completion email carries the file and its fingerprint. A file sealed
  at B-B is never given a time stamp later, because that would change the file people hold. `TSA_USER` and
  `TSA_PASSWORD` are sent only over https.
- `/verify` on a dropped file (`checkSeal` in `seal.ts`) says a seal holds only when the `/ByteRange` is written in
  the same object as the `/Contents` it leaves out, that gap is nothing but the seal's own hex digits with zeros
  after them, the fingerprint and signature verify over every other byte, and, for a seal that claims the whole
  file, pdf-lib reading the file finds a signature field with that very range. So a file put together around a real
  seal (the seal moved, other pages in the gap) gets "Its digital seal does not hold". A time stamp sits outside
  what the seal covers and anyone can add one afterwards: `/verify` shows a time stamp's time only when its service
  leads to `TSA_TRUST`, and otherwise the seal's own time and that there is a time stamp it cannot check.
- The certificate on its own in an evidence pack (`certificate.pdf`) is an extract of the signed PDF: the seal's
  field is taken off before the pages are copied, so a reader shows no broken signature there, and the pack's
  README says the seal is in `signed.pdf`. The certificate's line speaks of "the signed PDF this certificate
  closes" for that reason.
- The key is read once and checked every time it is used: RSA of 2048 bits or more or ECDSA P-256, belonging to the
  certificate, a certificate within its dates whose key usage allows digitalSignature or nonRepudiation, and the
  certificate that issued it given. Otherwise sealing stops, PDFs are made exactly as without a seal, each envelope's
  audit trail says "Not sealed", and the operator queue (and `SUPPORT_EMAIL`, `OPERATOR_EMAILS`) is told once. The
  key sits behind a signer interface (`SealSigner` in `sealcms.ts`: `chain()` and `sign(digest)`), so a cloud signing
  service takes its place without the key on disk: SSL.com eSigner is built (see "The cloud seal" below); a cloud KMS
  or an HSM of your own is not.
- A .p12 file is read by our own code (`p12.ts`): PBES2 with AES or triple DES, and the old PKCS#12 schemes with
  triple DES and RC2 that older software wrote. Its password is checked with the file's MAC.
- Files completed before the seal was set up are never sealed afterwards: their fingerprint is in emails people
  hold. Copies of voided, declined or expired envelopes are not sealed and say so on their first page.

### The cloud seal (SSL.com eSigner) and what Acrobat shows

A certificate that Acrobat trusts out of the box comes from an authority on the Adobe Approved Trust List, and the
list's rules keep its private key in that authority's own hardware: it can never be a file on this server. So a
hosted server (Render, say) seals with such a certificate through a cloud signing service. GrowSigning speaks the
Cloud Signature Consortium API (version 0, as SSL.com eSigner serves it) in `src/server/sealcsc.ts`:

- Settings `SEAL_CSC_URL` (default `https://cs.ssl.com/csc/v0`), `SEAL_CSC_TOKEN_URL` (default
  `https://login.ssl.com/oauth2/token`), `SEAL_CSC_CLIENT_ID`, `SEAL_CSC_USERNAME` and `SEAL_CSC_PASSWORD` (these
  three required), `SEAL_CSC_CLIENT_SECRET`, `SEAL_CSC_CREDENTIAL_ID` (else the first eSealing credential listed) and
  `SEAL_CSC_TOTP_SECRET` (only for a certificate that asks for a one-time code; an eSealing one does not; with codes
  the seals ask one at a time, and a code refused as its 30 seconds turn over is tried once with the next). A half set
  is refused and said once at startup in a `[config]` line naming what is missing; a key file and a cloud seal
  together are refused too. Only when the settings are complete does the `[outside]` startup line and `/security`
  list the two hosts.
- The calls: an access token (password grant), kept until a minute before it expires and fetched again when the
  service stops taking it; `credentials/list` when no credential id is set (first with `"clientData": "DS_ESEAL"`,
  which is how SSL.com lists eSealing certificates); `credentials/info` for the certificate chain, fetched before the
  first seal and again every day (the old one keeps sealing meanwhile); and for each seal `credentials/authorize` then
  `signatures/signHash`. Only the SHA-256 of the seal's signed attributes is sent, base64, with `hashAlgo` SHA-256 and
  `signAlgo` sha256WithRSAEncryption (or ECDSA with SHA-256): never the document. The signature that comes back is
  checked with the certificate before it goes into the seal, and the whole chain the service gave goes into the CMS.
  The seal is then RSA with PKCS #1 v1.5 padding, which is what the service makes (a key file is sealed with
  RSASSA-PSS). The certificate's name and issuer on `GET /seal`, the certificate of completion and the record come
  from that chain.
- Every call gets 4 seconds and one seal 10 in all. When the service is down, slow, refuses (a wrong one-time code
  says so) or answers a signature that does not hold, the document completes without a seal exactly as when a key file
  cannot be used: "Not sealed" in its history, nothing about a seal on its certificate, and the reason to the operators.
- Checked: `tests/seal-csc.test.ts` against a fake CSC service with a throwaway authority (offline), and
  `scripts/seal-sandbox.ts` (and `tests/seal-csc-sandbox.test.ts`, skipped when the sandbox cannot be reached) against
  SSL.com's real sandbox with SSL.com's published demo account: a real envelope completed by the app, its seal checked
  by `openssl cms -verify`, `pdfsig` and pyHanko, its signature time stamp from `ts.ssl.com` by `openssl ts -verify`
  against the bundled roots, and page 1 rendered the same before and after. The output is in
  `research/sealed-sandbox-sample.pdf` and `research/sealed-sandbox-verify.txt`. The sandbox certificate is on no
  trust list, so Acrobat says "validity unknown" for that file, which is expected. Long-term data could not be added
  on the machine this was built on: the sandbox certificates name SSL.com's development OCSP and CRL hosts
  (`ocsp-dev.ssl.com`, `crl-dev.ssl.com`), which its network refused. A production certificate names
  `ocsps.ssl.com` and `crls.ssl.com`. Not yet opened in Acrobat with a production certificate.

Production, step by step (also in `.env.example`):

1. Buy an SSL.com OV Document Signing certificate (organisation validated; $299 a year on www.ssl.com in November 2026,
   less a year for a longer term), with eSigner cloud signing on a monthly plan. SSL.com's document signing tiers in
   November 2026: 20 signings for $20 a month ($1 for each one more), 100 for $85, 300 for $175, 1,000 for $250, or
   240 a year for $180. Each completed PDF uses one signing, and so does each person's own copy when a sender shows
   someone only some of the files. A file made again as a normal PDF because veraPDF did not pass it as PDF/A uses a
   second one. A failed time stamp never costs a second signing, two builds of one file in the same server wait for
   each other, and time stamps use none.
2. Complete SSL.com's organisation validation.
3. Enrol the issued order in eSigner, and convert it to eSealing (Orders, the order's details, "Remove 2FA") so no
   one-time code is needed for each seal.
4. Register an application at `https://login.ssl.com` (Manage Applications, Create Application: Confidential, scope
   `service`, redirect URI `urn:ietf:wg:oauth:2.0:oob`) and copy its Application ID and Application Secret.
5. In Render, the growsigning service, Environment: set `SEAL_CSC_CLIENT_ID`, `SEAL_CSC_CLIENT_SECRET`,
   `SEAL_CSC_USERNAME`, `SEAL_CSC_PASSWORD` (and `SEAL_CSC_CREDENTIAL_ID` or `SEAL_CSC_TOTP_SECRET` only if needed),
   `TSA_URL=http://ts.ssl.com,http://timestamp.digicert.com` and `TSA_TRUST=bundled`. Save and redeploy.
6. Check `GET /api/seal` as an admin (it names your organisation and SSL.com), then complete one test document and
   open the PDF in Adobe Acrobat Reader: the blue bar should read "Signed and all signatures are valid", with the
   time stamp and "Signature is LTV enabled" in the signature panel.

### Time stamps without a seal, and the bundled roots

- With `TSA_URL` and no seal (or a seal that could not be applied), every completed PDF still gets one PAdES document
  time stamp over the whole file (`addDocTimeStamp` in `ltv.ts`, called from `finishPdf`), so a PDF reader shows it
  as time-stamped by that service. Its history says "Time-stamped" with the service, or "Not time-stamped" and why.
  It is not called a seal anywhere, and `/verify` answers `"seal": null` for such a file.
- `TSA_TRUST=bundled` uses the roots of the two free public services built into the server (`src/server/tsaroots.ts`,
  the same certificates as `deploy/tsa-roots.pem`, which names where each came from and its SHA-256 fingerprint as
  DigiCert and SSL.com publish it): DigiCert Trusted Root G4 and DigiCert Assured ID Root CA for
  `http://timestamp.digicert.com`, SSL.com Root Certification Authority RSA for `http://ts.ssl.com`. No file is
  needed on the server. DigiCert's service sends a copy of Trusted Root G4 issued by Assured ID Root CA; the chain
  walk stops at the listed root. Both services were asked from the machine this was built on, and both time stamps
  verified with `openssl ts -verify` against `deploy/tsa-roots.pem`.

### Long-term checking and the record's time stamp

Both need `TSA_URL`; without it nothing here runs and nothing is asked. Two free public services work and are
bundled for `TSA_TRUST=bundled` (above). A time stamp is evidence of time from that service, nothing more: nothing
here calls it qualified.

- **The record's time stamp** (`src/server/auditstamp.ts`). When the last person finishes, before the certificate is
  drawn, the service is asked for an RFC 3161 time stamp over the SHA-256 of the chain head (the 64 hex characters the
  certificate prints as "Chain head", without a line break). It shares the 4 seconds for time stamps with the seal's
  own. With an answer that checks out, the certificate prints one line under the chain head, "The last value of this
  record was time-stamped by <the name on the service's certificate> at <time> UTC.", the token is kept in
  `audit_stamps`, and the evidence pack holds `audit-trail-head.txt`, `audit-trail-timestamp.tsr`, the certificates
  the token carries and the command `openssl ts -verify -in audit-trail-timestamp.tsr -token_in -data
  audit-trail-head.txt -CAfile <the service's root>`. The History fold on the page of the document ends with one
  line, "Time-stamped by <service> on <date>, when everyone had finished.", and when the stored record no longer
  leads to that value its badge reads "Changed after completion" with a warning as its first line (`record_stamp`
  in `GET /envelopes/{id}`, `src/components/sender/History.tsx`). The service's name and time on the page are read
  from the token, never from the row beside it. Without `TSA_TRUST` the line adds "Who runs that service was not
  checked"; with it, a token from any other service does not hold. Without an answer, no certificate line is
  printed and History says the fingerprint on the certificate still guards the record. What it changes is said in
  `CHAIN_TRUTH`: before completion the chain is only ours to vouch for; after it, a rewrite of the lines up to
  completion, even with every hash recomputed, ends at another value than the one the service signed. That holds
  when it is checked outside this server (the token, with OpenSSL, against the service's own root, over the head on
  the emailed certificate). The check on the page cannot stand alone against whoever can write the database: they
  can delete our copy of the token, or, without `TSA_TRUST`, put in one from a service they made themselves. Lines
  written after completion are not covered.
- **Long-term checking of the seal** (`src/server/ltv.ts`). After a seal with a time stamp (B-T), every certificate of
  the seal's chain and of the time-stamp token's chain is checked at the addresses it names: its OCSP service first
  (with a nonce; the answer must be signed by the issuer or a responder the issuer named, say "good" for this very
  certificate, and be current), else its revocation list (signed by the issuer, current, not listing it). An issuer
  the chain does not carry is fetched from the address the certificate gives. The certificates and answers go into a
  Document Security Store (`/DSS`) as an incremental update: PAdES B-LT. Then one document time stamp over the whole
  file (`/DocTimeStamp`, `ETSI.RFC3161`): B-LTA at completion. All the answers together get `LTV_WAIT_MS` (20
  seconds) because the stored file is the one that is emailed. When one does not answer, or an answer does not check
  out (revoked, signed by someone else, an old nonce, out of date), nothing is added: the file stays at B-T, the
  history line of the seal says why, and "Checks on the file" says in one plain line that the seal can be checked
  only while its certificate is valid (the reason, with service names, is never on that screen). Certificates that
  name no address at all (a certificate the operator made) give nothing to fetch: then nothing is added and nothing
  is said. In the time-stamp service's own chain, a certificate that names no address, or whose issuer is not there,
  is left as it is and does not keep the seal's certificates from being checked. Addresses are never asked when
  they are on this machine or a private network, written as a number, as a name such as `localhost.` or
  `*.internal`, or as a public-looking name the DNS says leads there (the lookup of `src/server/paydns.ts`; the DNS
  can still answer one thing to that lookup and another to fetch a moment later). With `OUTSIDE_CALLS` set to
  `listed` or `none`, these addresses come from certificates and are not on any list: add their hosts to
  `OUTBOUND_ALLOW`, or every sealed file stays at B-T and its history line names the host to add. A seal without a
  time stamp (B-B) gets no long-term data. The document time stamp's own certificate data is not added after it:
  that, and renewing the archive time stamp over the years, would change the file people hold.
- **`/verify`** (`ltvTail` in `ltv.ts`, called by `checkSeal`) treats what follows a seal as check data, and the file
  as whole, only when every object after it is the catalog again with nothing changed but `/DSS` and the form, the
  `/DSS` and the streams it lists, one new invisible field whose value is a document time stamp that holds and covers
  the whole file, the form's fields and the last page's annotations again with only that field added, and
  cross-reference sections that point back one to the next and free nothing. Each stream in the `/DSS` must read as
  the certificate, OCSP answer or revocation list its array says, with nothing else in its dictionary, and together
  they must check the seal's own certificate and each one above it for the time of the seal: an empty `/DSS`, one
  holding other bytes, or one about other certificates is not check data. The time stamp's field and signature
  dictionary may carry only the entries `withLongTerm` writes (no action, no appearance). Anything else (a turned
  page, another annotation, a time stamp over other bytes) is "more was saved into the file after the seal", as
  before. A document time stamp from any service that holds over the file is accepted as check data, because it
  changes nothing a reader shows; its time and the name on its certificate (`doc_timestamp_at`, `doc_timestamp_by`)
  are given only when it leads to a certificate in `TSA_TRUST`, otherwise `doc_timestamp_unchecked` is true and the
  page says its time is not shown.
- What was checked: `tests/ds-seal-ltv.test.ts` with a stub OCSP responder, a stub revocation list and a stub
  time-stamp service made in the test. poppler's `pdfsig` still says the seal is valid (it says "Not total document
  signed" for the seal and cannot check document time stamps: it shows the second signature as not verified), and
  `openssl ts -verify` accepts the document time stamp over the bytes it covers and the record's time stamp over the
  head, and refuses it for another head. Not yet opened in Acrobat or the EU DSS validator, and not run against a
  real OCSP responder or time-stamp service: "Can be checked for years" rests on the file carrying what PAdES says
  a reader needs, not on a reader having been seen to use it.
- On the screens there is nothing to switch on and nothing to choose. The page of a sealed document gets one
  history line, "Sealed by" and the name on the seal certificate, and a folded "Checks on the file" that says the
  same in two sentences (`src/components/sender/FileChecks.tsx`; `seal` in `GET /envelopes/{id}`). Admins see one
  read-only card under Settings, Records and data: "Digital seal (PAdES)", who seals, whether a time-stamp service is
  asked and the day the certificate ends, or that the seal is not being applied right now (`GET /seal`,
  `src/server/routes-seal.ts`, `src/components/settings/SealStatus.tsx`). Why a key is refused is told only to the
  people who run the server, because the reason can name files on it. A server without seal settings shows none of
  this. The time-stamp service's address is never repeated in a record, only its host name.
- Waiting: the last person's Finish makes the signed PDF, so it waits for the time-stamp service, 3 seconds for
  each service and 4 in all at the most, before the file is sealed without a time-stamp. With long-term checking
  (`LTV_WAIT_MS`), the answers about the certificates and the document time stamp after them share those
  `LTV_WAIT_MS` (20 seconds at the most by default) and never add to it, so the worst case is about 4 seconds plus
  `LTV_WAIT_MS`. A service that answers
  takes well under a second. A service that did not answer in time is not asked again for 10 minutes, so while it
  hangs, the signers who finish after that first wait get their file at once; files completed in those minutes are
  sealed without a time-stamp, say so, and are not changed afterwards. Signers who finish at the same moment, while
  the first request is still out, wait together and never longer than the first one. The 10 minutes are kept in the
  memory of each server process: after a restart, or on a second process, one more signer waits those seconds.
- On `/security` and `/security/certificate` the seal is explained only on a server with a seal key, in plain words
  (no standard names), including that a file is made without a seal when the certificate cannot be used at that
  moment. Those pages read the setting, not the state of the key: an expired certificate shows in the admins'
  status card and in each envelope's "Not sealed" line.

What to buy: Acrobat calls a seal valid only when its certificate comes from an authority on the Adobe Approved
Trust List or an EU trusted list. With any other certificate (a company CA, a self-signed one) Acrobat says
"validity unknown": that is about the certificate, and the panel still shows whether the file changed. Check a file
by hand with `pdfsig file.pdf` (poppler) or in Acrobat's signature panel.

### Archive format (PDF/A)

Some archives take permanent records only as PDF/A. With `VERAPDF_CMD` set, an admin can switch on "Archive format
(PDF/A)" under Settings, Records and data, More options. It is off by default, and without veraPDF on the server it is
not shown and nothing changes (while it is still on after the operator took veraPDF away, the card stays, says so and
can be switched off). With it on, every document the account completes from then on goes through
`src/server/pdfa.ts`, a step before the seal in `src/server/finalpipe.ts`:

1. The uploaded documents and the files signers attached are read first. A font that is not inside the file and
   that the pages draw with (many programs only name Helvetica or Arial; a font only listed is no problem), colours for a printing press (CMYK, which an sRGB output intent cannot
   describe), or sound, video, 3D or an attached file make PDF/A impossible without changing how the pages look. The
   document is then made as a normal PDF, and the certificate says "Archive format: not PDF/A (a font in Lease is
   not inside the file)".
2. Otherwise the signed PDF is made as PDF/A-2b: XMP metadata with `pdfaid:part` 2 and conformance B, the title and
   the dates the same as in the information dictionary, an output intent with the sRGB profile in `assets/icc`
   (made from the published sRGB numbers by `scripts/make-srgb-icc.mjs`; its licence is next to it), a document ID
   in the trailer, no JavaScript and no actions PDF/A forbids, annotations that cannot be seen taken away and every
   other one printable. Every font this server draws with (DejaVu, and Noto for other scripts) is embedded already.
   Then the seal, when the server seals: added as an incremental update. veraPDF 1.28.2 passed sealed files from
   this code as PDF/A-2b (step 3 checks every file again, so this is never taken on trust).
3. veraPDF checks the finished file, seal and long-term data included (`--flavour 2b --format mrr`, in a process
   group of its own, killed at `VERAPDF_TIMEOUT_MS`). Only when it passes does the certificate say "Archive format:
   PDF/A-2b, checked with veraPDF <version>". When it does not, takes too long or cannot run, the whole file is made
   again as a normal PDF, whose certificate says "not PDF/A" and why. The document always completes. At most 2
   checks run at once (each is a Java program of a few hundred MB); up to 20 wait, and at most 4 of one account
   run and wait. A file that finds the line full is made as a normal PDF that says "the check was busy".
4. The last signer is not kept waiting: with the switch on, the envelope is marked completed when they finish, and
   the signed file, its history lines and the "completed" emails (with the file attached) follow in the background
   once the check is done. Until then a download is the document as it is, without the seal or the archive format.

What came of it is on the page of the document under "Checks on the file", in its history, and in `GET
/envelopes/{id}` as `archive_format`. A file that is not PDF/A also gets one line on what to do next time ("Next
time, save the file as PDF/A in the program that made it"). When the account's last check could not be done on the
server (too slow, busy, or veraPDF would not start), the Settings card says so in one line. What veraPDF found wrong
is written in the server log, not shown to senders.

What was checked: `tests/ds-pdfa.test.ts` with a stand-in that answers in veraPDF's report format, and the real
veraPDF when `VERAPDF_TEST_CMD` names it. With veraPDF 1.28.2 (greenfield, run from its Maven jars) that test
passed: a file from this server with other scripts in its title and a font the upload only lists, a sealed one,
and a Helvetica file given PDF/A metadata failed (clause 6.2.11.4.1), as it should be. An upload drawn with a font
that lacks some of its letters is failed by veraPDF too (6.2.11.8) and made as a normal PDF. Run the test again
after upgrading veraPDF or changing the render.

## Things to decide before launch

- **Prices** are in `src/lib/impact.ts` (`PRICING`): $9 a month for 9 signatures, $1 for each extra signature,
  10 mangrove trees per dollar. `STRIPE_PRICE_GROVE` has to be a monthly price for the same $9. Top-ups need no
  price in Stripe; the amount is sent with each checkout.
- **Choices made for expiring signatures** (2026-11-20), each worth a second look: a month's signatures expire at
  the end of the period the provider names on the invoice, not when the next payment arrives (see the test-mode line
  below about the hour in between); when money goes back by another road (a refund at the provider, a dispute), the
  signatures that payment bought and someone used are taken from what is left, soonest-expiring first (so the trial
  and this month before top-ups), and the ones of it that expired are not taken from anything; a held signature sits
  in whichever lot expires soonest while it is held, so `paidSignatureFor` can change until the person signs; a month
  free with a code in which nobody opened the account is not written at all, because it would have expired unused;
  a plan payment can be refunded only while its month runs, because after that its signatures have expired. There
  are no customers yet (payments are off on the preview), so no notice about the change was sent to anyone.
- **Choices made around those prices**, each one line to change in `PRICING` or the settings above: a signature is
  one person signing one envelope; signatures expire (`expiryRuleText` in `src/lib/policy.ts`, decided by the owner
  on 2026-11-20): a month's 9 at the end of that billing period, top-ups `TOPUP_EXPIRY_MONTHS` (12) months after
  their payment, the 3 free ones of a new account `WELCOME_EXPIRY_DAYS` (30) days after it was made, and the one that
  expires soonest is used first; a new account gets 3 free ones; top-ups
  need the monthly plan; unused signatures that have not expired are refunded within 30 days of the payment that
  bought them, counted from that payment's own lot (`lotsOf` in `src/server/credits.ts`), and
  refunding a monthly payment ends the plan; a refund the software owes
  that the payment provider refuses three times is left to a person, and the customer is told; money a person sends
  back by hand at the provider while a refund of ours is waiting counts towards it, in as many parts as it takes:
  the software sends only the rest, the refund is settled once the parts add up to what is owed (or more), and the
  customer gets one email that says how much came back and on which days (until then the Plan page says what is
  back and what is still to come); an unused plan stops renewing after 90 days (once per renewal, and
  "keep it" is respected); a small card dispute is accepted rather than contested (`ACCEPT_DISPUTES_UP_TO_USD`);
  someone on a free code who was paying has their paid subscription ended the moment the code is applied; signing
  in person always uses a signature; signing your own document is free only under your own name and address;
  being asked to sign again after a change is free, for the same person (another person put in their place, also
  under another name at the same address, needs a signature of their own); a public form holds none of its owner's
  signatures and takes one at the moment a visitor finishes: if none is free then, the visitor is told politely,
  what they filled in is kept until the form's deadline (the idle timer leaves that start alone), they are emailed
  once at the address they gave when the form can take their signature, and the owner and the account's owners and
  admins are emailed; a form whose template has other signers too (a colleague who countersigns) needs a signature
  for each of them, and a visitor can start only while enough are free for the whole envelope; a form never takes
  a signature held for an envelope that is out and never takes the balance below zero (a stranger can still use
  signatures up by really signing, 20 starts an hour per address), and the emails at two left and at none go out
  for forms as for any send; only US dollars are accepted.
- **Free self-signing under a renamed profile** is a known limit, with no rule in the code. Signing your own
  document is free under your own name and address, and that is decided when the request goes out. So someone can
  rename their profile to a client's name, send to their own address, rename back, and the client signs for free.
  It saves $1 a time and costs the person their own evidence: the certificate shows the client's name on the
  sender's own address and login, which is a poor record to stand on if the signature is ever questioned. If it
  shows up in practice, the option is a monthly cap on free self-signatures (say 20 a month), counted on the
  ledger like any other line.
- **After someone has signed**, any change to what is printed on the pages asks everyone who finished to sign
  again (the sender has to choose that; nothing changes silently). That lock covers the whole envelope, including
  a new empty field for someone who has not signed yet. It is deliberately strict; loosen it in `printedView()`
  in `src/server/envelopes.ts` if you prefer a per-document rule.
- **Raising the price** has a rule, and the server holds you to it: 30 days of notice (`PRICE_NOTICE_DAYS` in
  `src/lib/policy.ts`). Every account has the price it is on written down: a new subscription takes the price its
  checkout showed (a returning customer is never held to the price of a plan that ended), and when the server
  starts, every account without one gets it from its last full-price plan payment (one that bought the whole month
  of signatures, not a discounted month) before that payment's own tax (a payment from before the tax was kept
  counts at most the price for new customers), or with none from the price for new customers at that moment, so
  deploy this code before you change `PRICING`. In this order: (1) on
  `/app/operator`, "Announce a price change" with the new price and a first day at least 30 days away (a calendar
  day in UTC, written that way in the email, on the Plan page and on the operator page). That emails every owner
  and admin of every account with a subscription, in any state (paid up, failing, on hold, paused), and records the
  notice for an account once the email has left for every one of them (taken by the mail server; the outbox counts
  only on a development server), counted from the moment the last of them left: one that leaves less than 30 days
  before the first day does not count, and the page says so ("not told in time"). The page lists the accounts it
  could not reach and those whose email is still on its way; run it again once email works (nobody is emailed
  twice, and an email that left since counts then).
  (2) Change `PRICING.monthlyUsd` for new customers whenever you like: an account that starts the plan after the
  notice pays what its checkout shows, and needs a notice of its own for any rise after that. (3) With the payment
  provider, move existing subscriptions to the new price so that it first applies on or after the announced day.
  Until an account has had its notice, a renewal above the price it was on is refunded the difference
  automatically and you are told; it still gets the full month of signatures. Tax the provider adds on top is
  allowed; tax inside the price (Stripe's "inclusive" tax) adds nothing, so a raise is refunded in full. A lower
  price needs no notice, and a notice for the same or a lower price than an account pays withdraws a rise announced
  before: everyone who was told of the rise is told it is withdrawn. After the first day, the Plan page shows the
  new price as the price.
- **The free code** (`GROWalition` by default) is in this source code. If the repository is public, so is the
  code, and nothing limits how many accounts use it. Change it with `FREE_PLAN_CODES`.
- **Click-to-agree acceptances** are free on every plan and use no signatures: an acceptance is not a signature.
  What stands in for a price is `CLICKWRAP_MONTHLY_LIMIT` (1000 a month per account for each of its two counts,
  typed-in visitors and the people its website vouches for, so up to 2000 in all; emails to the admins at 80 percent
  and at the limit). Decide whether to price them (a website with heavy traffic would pass 1000 in a day),
  whether the limit should rise with the plan, and what to tell a customer who asks for more; today the refusal
  sends them to the contact form and only the operator can raise the number, for every account at once. Also decide
  whether any site may frame the terms (today `frame-ancestors *` on `/agree/*?embed=1` only, see `next.config.mjs`)
  or only sites a team lists. And have a lawyer read the words on the page and the certificate (`src/lib/clickwrap.ts`): they
  say what the record shows and what it does not, and that whether a click binds anyone depends on the country and
  the agreement, and they promise nothing more.
- **Impact factors** in the same file are commonly cited estimates. Check them against a source you are happy
  to stand behind publicly.
- **The money promise and the trees per dollar** are business commitments. Every page says "what you pay, less
  card fees, goes to Treegens" (`MONEY_LINE` and `MONEY_SHORT` in `src/lib/impactwords.ts`), because card payments
  carry the processor's fees and nothing in the code makes them up. If you pay the fees yourself and send every
  dollar, change those two lines. The trees total counts each whole dollar paid, less refunds, before card fees,
  and /impact says so. The app records what was paid and displays it. Actually moving that money to tree planting
  is something you do, and should be able to show.
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
  Stripe account is shared with something else: everything GrowSigning starts there carries its own mark
  (`sg_account` in the metadata). An invoice, charge, refund or dispute is ours only when it is for our price, for a
  subscription of ours or carries our mark; being a customer of ours is not enough. Anything else is never matched
  to our customers, never mailed to them, never ends a plan and is never conceded, and one of our customer's that
  cannot be told apart goes to a person (an operator alert). An invoice for another price is set aside for good
  (never applied, never refunded, never looked at again by the timer); one that names nothing is looked at again
  only once its customer is one of ours, and one whose customer is ours is never deleted while it waits. A one-off
  invoice is a top-up's receipt only with our mark. Our own refunds go only to a charge found by its id (the
  invoice's own payment, or a charge that names the invoice): when none can be found, a person is asked. Also send
  the webhook these events: `charge.dispute.closed`, `refund.failed`.
  Things only test mode can settle, one test each, on the API version you pin (`STRIPE_API_VERSION`; write down
  the one you tested):
  - Stop by card: make a charge on a card whose last four digits start with 0, stop it by card with its date and
    amount (it should stop), then try a date outside the window (it should say the details do not match), and once
    a minute after a fresh charge (search can lag).
  - Both checkouts accept `adaptive_pricing[enabled]=false` (a refusal there would break every checkout and top-up).
  - Signatures expire (since 2026-11-20). With a test clock, renew a subscription twice: each `invoice.paid` must
    carry `lines.data[0].period.end` equal to the subscription's period end, because a month's signatures expire at
    exactly that moment (fairly sure, about 85 percent, for every API version the code reads; an invoice without it
    falls back to the renewal date we hold). Stripe finalizes and charges a renewal invoice about an hour after the
    period ends, so between the old month's end and the new payment there is an hour with no plan signatures: check
    that this is acceptable, or decide to let a month run until its renewal payment is applied. What the code does
    in that hour: it says the new month's signatures are on their way, a subscriber with nothing else left cannot
    send until they arrive, and a signature that was used out of a top-up in that hour moves to the new month when
    the payment arrives (within 24 hours of the month's end, `renewalGap` in `src/server/credits.ts`), so the top-up
    keeps its own later date.
  - Both checkout pages show the expiry rule in full (`custom_text[submit][message]`, at most 1200 characters; the
    plan's message is checked in tests/billing9.test.ts to stay under it, with the 30-day refund window).
  - With `STRIPE_COLLECT_TAX_ID=1`, a plan checkout for a customer who has paid before and a top-up for a new one.
  - One top-up: its `invoice.paid` carries `metadata.kind = sg_topup` and `sg_account`, and the Plan page shows its
    invoice once.
  - A renewal on a tax-inclusive price: `amount_paid` is the price itself and the tax lines say inclusive
    (`total_taxes[].tax_behavior` or `total_tax_amounts[].inclusive`), so nothing is refunded and the reminder
    states the price. Fairly sure (about 80 percent) that is how Stripe reports it.
  - Cancel in the hour before a renewal (a test clock with the renewal's draft invoice raised): the draft must not
    be charged. The code deletes a draft and, when Stripe refuses that (its documentation says only drafts that
    belong to no subscription can be deleted, so it most likely will), sets `auto_advance=false` on it; check the
    draft is never finalized or charged. If it is charged anyway, it must be refunded by itself.
  - Cancel in the customer portal while a renewal is failing: the plan must end the same day here, the open invoice
    must be voided, and a retry of the card must not be kept (if one goes through, it is refunded and the plan ends).
  - Win a dispute on a top-up and lose one on a plan payment: check that the Plan page and the emails follow both.
    We believe `charge.dispute.closed` carries `payment_intent` as well as `charge` (fairly sure); when it does not,
    the charge is looked up, so this tests that lookup.
  - Point the webhook at an endpoint that answers after 8 seconds and see whether the dashboard counts that as a
    failure: `STRIPE_WEBHOOK_WAIT_MS` (5 seconds by default) must stay below the limit Stripe really applies, which
    we remember as 10 to 20 seconds but have not checked.
  - Set "if all retries for a payment fail" to "mark the invoice as uncollectible", let a renewal fail to the end,
    and press "Pay the open payment": the provider's page must take the payment. We offer uncollectible invoices
    there as well as open ones; fairly sure (about 70 percent) Stripe lets them be paid.
  - Refund a renewal by hand in the dashboard: the Plan page must show it on that payment and the customer gets an
    email. A charge is never matched to one of our payments by its amount alone any more, so this needs
    `GET invoices/<id>?expand[]=payments` to name the charge's payment (likely right for 2025-03-31 and later); if it
    does not, a person is asked instead (an operator alert "could not be matched to a payment for sure").
  - A returning customer whose new invoice names no subscription: `GET subscriptions?customer=..&status=all` must
    list the new subscription (`status=all` is documented; the shape of the answer is what to check).
  - Pay a failing renewal a moment before pressing Cancel: the payment must stay (the code compares the invoice's
    `status_transitions.paid_at` with the moment the provider confirmed the stop).
  - Set the dashboard's "upcoming renewal events" to 7 days or more, or the operator's warning a week before a
    renewal priced above what an account is on comes late (the customer's own reminders run on our timer either
    way).
  - On the version you pin, refund by hand a charge of a renewal and dispute one (test cards for disputes): check
    whether `charge.refunded` and `charge.dispute.created` name the charge's invoice (`charge.invoice`, which we
    believe, about 70 percent, was removed in 2025-03-31). Either way they must match our payment: by the invoice,
    or by the invoice's own payment when the charge names none. A second product on a test account, refunded and
    disputed, must leave our customer untouched.
  - Refund a renewal by hand in two parts ($5, then $4) while a refund of ours is waiting for the same payment
    (make ours fail first, for example by refunding most of the charge by hand): check that `charge.refunded`
    carries the running `amount_refunded` each time, which is what the parts are counted from.
  - Cancel on a renewal that is failing (`past_due`), with the provider not confirming the end: check that Stripe
    keeps retrying the card while `cancel_at_period_end` is set (we believe it does). Our side refunds such a retry
    whatever happens, unless an admin chose "keep the plan and pay" on the Plan page.
  - Resume on the customer portal, then press Cancel in the app at once: our second Cancel asks Stripe first, so the
    order the messages arrive in does not matter; check that the portal's resume message carries an older `created`
    time than our own change, which is how a late one is told apart.
- **Stopping a plan without logging in** works for its owners and admins only, as in the app: a stop link names
  one of them, and stop by card with an email address finds only plans that address may stop. Stop by card
  without an email address (the last four digits plus the date and amount of a charge) cannot tell who is asking:
  anyone who knows those can stop the plan, and every plan charge is the same amount. Decide whether to keep it for
  customers, or keep it only for the operators' lookup and send people to the contact form instead.
- **Signing in with Google or Microsoft** has only been tested against a stand-in (`tests/signin.test.ts`), never
  against the live providers. Before switching it on for real, go through it once with real client ids: sign up,
  sign in again, cancel at the provider, connect and disconnect under Settings, and a Microsoft work account as well
  as a personal one. Three things to know: an unconfirmed login can still be started in someone else's name (with a
  password as before, or now with a Microsoft account that claims their address). When the real owner arrives every
  way in is cut off and everything that would keep working for the stranger is removed or switched off (webhooks,
  invitations, profile, branding, stamps, public forms, click-to-agree pages); drafts, templates, contacts and
  signing groups stay, and the notice names them so the owner looks at who they go to before using them. Our "Confirm your email" link confirms a login only in a browser that is signed in
  to it, or together with its password, so the owner of a mailbox cannot confirm a stranger's login by clicking (a
  login without a password, made with Google or Microsoft, is confirmed after signing in); and closing an account
  still asks for a password, so someone without one sets one first.
- **Storage** is SQLite on one disk, which is fine for one server. Back it up with `scripts/backup.mjs` on a
  schedule of your own (a plain copy of `DATA_DIR` taken while the server runs is not a backup), keep the copies
  somewhere else, and practise `scripts/restore.mjs` once. Moving to
  Postgres and object storage is the step to take before running more than one instance.
- **Encryption at rest.** Decide whether to set `FILE_ENCRYPTION_KEY` (see "Encrypting stored files"), and encrypt the
  disk either way, because the database is never encrypted by the app. With a key set, keep the key backed up apart
  from `DATA_DIR` and its backups: a backup restored without its key cannot be read.
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
docs          controls.md (a self-assessment, not audited) and runbooks.md, for whoever runs a server;
              procurement/ the procurement documents served at /procurement
deploy        the Helm chart; Dockerfile and docker-compose.example.yml are at the top
scripts       backup, restore, the bill of materials, encrypting stored files, fonts, the container smoke test
tests         API tests and the browser test
```
