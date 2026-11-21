# GrowSigning

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
| `tests/billing.test.ts` | Paying, against a simulated payment provider (`tests/stripe-fake.ts`): free signatures for a new account, the monthly plan, top-ups, renewal reminders, cancelling in the app, from an email link and by card, a charge after cancelling, refunds of unused signatures, a card dispute, an unused plan, free codes. |
| `tests/billing2.test.ts` | Paying when things go wrong: the provider's messages in any order, the provider failing half way, two refund requests at once, replayed checkouts and messages, cancelling while a payment is failing, slow payment methods, reminders on our own timer, a charge higher than the reminder said, the corners of the free code, and the ways round paying for a signature. |
| `tests/billing3.test.ts` | What a second round of attacks found: provider messages handled in the same instant, a refund whose answer is lost on the way back, refunding again when signatures come back, card disputes, top-up invoices and invoices that are not ours, cancelling in the awkward moments, the unused-plan rule, who pays for which signature, and a free code that is switched off. |
| `tests/billing4.test.ts` | What a third round of attacks found: a refund racing against a burst of sends, one customer's slow call not holding up another's, things on a shared provider account that are not ours, disputes the bank decides either way, a refund made by hand settling ours, cancelling when the provider cannot be asked, payments whose message was lost, and the corners of who pays for which signature. |
| `tests/billing5.test.ts` | The last open ends of the payment code: the provider's messages are answered within a few seconds and kept in an inbox until applied (a slow provider, a failure, a restart in between, three days of failing), a plan on hold can pay its open payment from the Plan page and is read back when that was paid elsewhere, an invoice that names no subscription is matched by asking the provider what the customer is subscribed to, and the price rule: a renewal above the price an account is on is refunded the difference unless a notice went out 30 days before, with the operator's announcement and the reminder that states the true amount. |
| `tests/billing6.test.ts` | What a third review of the payment core found: a plan set to end on the provider's page is worked out from what the provider says and survives a failed call, a payment that was waiting when a plan was stopped is never kept, a charge is never matched to one of ours by its amount alone (a refund or dispute of another product on a shared provider account changes nothing and a person is asked), a dispute's decision waits for the dispute itself, messages neither wait for ever nor hide newer ones from the timer, a refund the provider refuses three times goes to a person and the customer is told, a refund made by hand is emailed, free signatures count as used first, a $0 first invoice and an undelivered reminder are said as they are, the provider's early tax figure is quoted, and a silent mail server is given up on in seconds. |
| `tests/billing7.test.ts` | The terms around the price, and what a third review found: a returning customer pays what their new checkout showed, every account has its price written down (also the ones from before), a price notice goes to every plan in any state and counts only once it left for every owner and admin, a lower notice withdraws a rise and says so, the day of a change is the same day everywhere, tax inside a price is not counted twice, the stop page and the emails quote the account's own price, a paused plan and a code that ended read as what they are, a member cannot stop the team's plan by card, other products' invoices on a shared provider account never crowd out or delete ours, a form visitor told to come back keeps what they filled in and is emailed, a form with a second signer and the emails at two and at none, a refund still on its way when an account is closed at once, and one signature per person at a shared address. |
| `tests/billing9.test.ts` | Signatures expire (decided 2026-11-20), with a fake clock: a month's 9 at the end of their billing period (also after cancelling, and a free code's at the end of the calendar month), top-ups 12 months after their payment, the trial's 30 days after the account was made; the soonest to expire is used first; a held one does not expire while held and is gone if let go after its date; the timer writes an "expired" history line; the ledger sums add up; an expired signature is not refunded, and a refund or dispute takes its own payment's first; the Plan page and the API show the reset date and each top-up's date; reminders say how many will expire; top-ups are emailed 30 and 3 days before, only when some are unused; trees count the money, not the signatures; `paidSignatureFor`; and no page promises that signatures never expire. |
| `tests/billing8.test.ts` | What a fourth review found: another product's invoice, refund or dispute on a shared provider account never mails, ends, takes or concedes anything of ours (also for a stranger), one that cannot be told apart goes to a person, and our own refund never goes to a charge found by its amount; a refund reported before its payment waits for it; a refund we owe that a person sends by hand in parts settles once they add up, with one email that says each part (also with a person after three refusals, and when we send the rest ourselves), and a closing account is told of one with a person; a mail server that stalls never holds Cancel (the emails follow from the outbox, and the timer sends one left behind); a price notice counts from when its email left; Cancel pressed and not confirmed survives the pay page being opened, a fresh read that is not set to end ends nothing, a second Cancel after a resume elsewhere asks the provider, and a second press after the plan ended says the same cancellation again; the stored price of an old row is a full-price month before its own tax; the Plan page reads an unwritten price like the money does; a small refund of our own leaves the limits lifted; two form visitors at once never take the balance below zero; "you can finish now" keeps the rules of every email and does not wait for ever behind a visitor who stays away; and a signer renamed away and back pays once. |
| `tests/groups.test.ts` | Signing groups: who may keep and use them, a group on a draft, one email and one link per member, the first who agrees takes it on and two at once, handing back and giving back, asking to take over, declining for the group, reminders, the not-opened alert, the access code, Find my documents and the security code, a member's email that comes back, one signature per group, the group as it was sent, corrections to its members, templates, bulk sends, public forms, and the screens; and the repairs after a skeptic's check: a member's spam mark or report stops every email to that member, hand-back notes stay with the sender, a member who cannot act freezes only their own link, the sender signing for their own group is free, and what the sender is told always matches what was emailed. |
| `tests/finish.test.ts` | What was still open at the end: a member leaves a team by themselves, public forms on a shared device and on a closing account, the email check recognising codes of deleted documents from a fingerprint, and stored copies of emails going with a deleted person and after 90 days. |
| `tests/integrity.test.ts` | What people sign is what they saw: every signer is shown everything the sender wrote, nothing printed changes after a signature unless the signer is asked to sign again, a signing page left open cannot finish on a document that was changed, the audit trail says what a correction changed, a replaced signer starts with empty fields, a save from an older copy of the editor is refused, a replaced email is still recognised as genuine, a changed signing order is enforced. A second round covers what a second look found: names and addresses that a field prints are wording too, what a finished signer left empty stays empty, the page loads a replaced file again before Finish works, a hand-over inside one inbox passes on nothing, changes made outside the editor count as a newer version, nothing in a request is dropped or cut short without a word, and whoever signed keeps the document as they signed it. |
| `tests/trust.test.ts` | Everything built in answer to complaints: correcting a sent envelope, lost links, deadlines, checking an email is genuine, reports and pauses, export, team hand-over, the help form, closing an account. |
| `tests/autoplace.test.ts` | Placing fields automatically from the text of a document. |
| `tests/bounces.test.ts` | Knowing when an email did not arrive: the ids every email carries, the address for the mail provider and its secret, one sample of each provider read like our own shape, hard and soft bounces, complaints and deliveries, matching by id (also after the envelope was deleted) and by address (only when one sender wrote to it), reminders that stop and start again, a complaint that no correction or new envelope undoes and only a code from the person's mailbox does, emails waiting for another try, news in any order, mail server text kept from customers, the warning before sending to an address that bounced, a login whose own address bounces, odd, huge and slow batches, and the Amazon SNS confirmation. |
| `tests/qr.test.ts` | QR codes made by the app itself: every version from 1 to 40 read back by a reader written apart from the encoder (format and version bits, the mask taken off, the blocks put back together, Reed-Solomon checked, the text out), fixed matrices that outside decoders read from pixels, the fixed parts of the picture, the four penalty rules and the choice among all eight masks, the SVG with its light margin and nothing of the text in it, what is refused (too long, not a web link, a user name in front of the address), the words on the dialog and the sheet, the public address a form's code is drawn from, and a personal code that stops opening the document when its link is replaced. |
| `tests/platform.test.ts` | Platform and security: links in emails never come from a request header, the caller's address behind a proxy, what an API key may do and what it says when it cannot be used, keys when a member is removed, closes their own login or an account is closing, and webhooks (logged before the first try, sent to the address that was checked, sent again, paged). |
| `tests/abuse.test.ts` | Keeping scammers and strangers out: the filter for fake payment notices where an email is started and where it is written (first send, correction, reminder, bulk, public form, void, the next person in a signing order, a decline notice, a team invitation), with the spellings it is known to catch (spaced, glued, look-alike letters and digits, phone numbers however they are punctuated) and the honest senders it must let through; a payment that lifts the checks only after 14 days; the daily limit on people newly emailed, with its own count for each public form and for team invitations; what a paused account can and cannot do, and what is held back and released; reports that count, reports through a public form that do not, and reports about documents that were deleted; who may read a support message and who may confirm an address (and that a new password confirms it too); access codes that freeze; public forms that never hand out someone else's document, and whose page never prints a fake payment notice; and reporting an email with its security code. |
| `tests/api.test.ts` | Calls that are repeated or cross each other: an `Idempotency-Key` that belongs to one person and goes with its envelope, a bulk send that is repeated while it runs or finished after the server stopped half way, one audit line a day for an embedded signing link, two Finish, Decline, Void or reassign requests at the same moment, a whole batch reminded or voided while someone in it signs, and signed PDFs made from fillable forms, whether the form was sent or attached by a signer. |
| `tests/lifecycle.test.ts` | Accounts, teams and deleting: someone removed from a team can still sign in (a workspace of their own, the welcome signatures once) and be invited again, nobody removes themselves, a hand-over names a member who stays, takes bulk sends along and is written to each audit trail, a deleted account leaves no names, addresses, email copies or signer files behind and keeps the money records without names, a closing account takes on nothing new and its owner is emailed a week before the end, members use every template but change only their own and see only their own folders and batches, a completed envelope its sender deletes stays with its recipients and can be found and put back by the admins, help references nobody can misread (alerts too, and the queue finds one by the reference read out), a signer's help request that names the document from the help link and reaches the sender, sign-in opening the workspace used last, a bulk send that stops when its sender is removed, the welcome signatures once per address also after deleting, public forms and contacts that are their maker's, and webhook logs that go with their webhook. |
| `tests/chat.test.ts` | The help chat, against a stand-in for the model (a fetch stub, never the network): the provider from the settings, the answer streamed with little thinking and no temperature, one more try without the tuning after a refusal, the built-in answers when there is no key, the model is down, slow or says nothing (and said as such), every limit (an internet address a minute and a day, an IPv6 /64 as one, a signing link, an account, everyone together), what is taken out before a question leaves and what stays, only the screen going along, answers the page made up, the hand-over to a person with the chat attached and checked, nothing else stored or logged, the system prompt built from `policy.ts` with the help topics and "What is not in it" read from the page and this file as they are now, the correcting line for "valid" and refund promises in the phrasings models use, the answer cut at its longest and a huge question refused, an answer checked only under the question it answered, a closed dialog stopping its answer, and the provider on `/security`. |
| `tests/support.test.ts` | Help requests as tickets: the whole life of a request from both sides, the published response times and the timer's escalation when one is late, reopening and the follow-up after 30 days, the link that works without a login (right secret, wrong secret, another request's secret), what a customer can never see (internal notes, another customer's request, an answer written to somebody else's mailbox), the operator queue and who may work it (nobody else, and no API key), the payment alerts in the same queue, the real median, the limits on the link and the form, and deleting an account with its threads. Also what a review proved broken and is fixed: a stranger who types your address can neither fill your inbox nor shut you out, "send me the links again" takes the same time whatever it finds, no API key or post from another site files a request as you, an alert never shows the operator's own account, deleting a login leaves a request it wrote under another address to that mailbox, a refused or given-up answer is told to the operator, old rows are filled in, odd input gets plain answers, and requests that belong to no login do not stay for ever. |
| `tests/signerux.test.ts` | The person who signs, and the email that reaches them: a saved signature is confirmed before it goes on a page and never offered across two people at one address, "Finish later" carries the signature to another device, "Fix my name" cannot turn one signer into another, dead and replaced links tell the sender, "Email me the current link" and "Find my documents" say what they did, scans and pictures are flagged page by page and stay flagged, the sender's field count matches the signer's, emails the mail server refuses are tried again and the audit trail says so (never a request to someone who has finished, never a withdrawn invitation), someone who signed keeps a copy when the envelope is closed, also when its access code froze afterwards, and a new person at a shared address starts with an empty request. |
| `tests/signin.test.ts` | Signing in and signing up with Google or Microsoft, against a stand-in for both (an RSA key made in the test, their key lists and token endpoints answered by a fetch stub, ID tokens signed and forged there): a new person, a returning one, a state that is missing, made up, from another browser, used twice or too old, every check on the ID token (signature, "none", HS256 keyed with the public key, issuer, Microsoft's organization rule, audience, expiry, nonce), keys cached and fetched again for an unknown key id, an address in a token never opening an existing login unless the provider vouches for it, a login someone else started in a person's name being cut off from them, invitations, free codes, a closing login coming back, a removed member's workspace, connecting and disconnecting under Settings, the last way in, a first password by emailed link, API keys kept out, no redirect off this site, nothing answering when a provider is not configured, and the repairs after review: everything a stranger set up in a login made in someone's name removed or switched off when the owner takes it back (with a provider or a password link) and listed for them, a signed-in person never made a second login, a Connect that ran out going back to Settings, the email naming only a password the login has, started sign-ins cleared, Google's Workspace domain matched to the address, and no provider sign-in skipping two-step login. |
| `tests/signercode.test.ts` | Checking who signs, with the text message provider stood in for (a fetch stub for Twilio and for the generic hook, and the outbox): what each setting switches on and what is refused without one, what a link gives away before the code is typed, the code (ten minutes, five tries, only the newest, never in an answer or in the database), every limit on codes and on texts, "not my number", Twilio and the hook called with the right body and credentials, a provider that fails or refuses, the signing link by text and who is never texted, the daily stop, corrections and passing a document on, templates, bulk rows and public forms, the audit lines and the certificate text. Also the skeptic's findings: a text tried again by the timer is decided again, a pass never goes to another person at the same address and lasts 24 hours on the server, limits are counted per sender, no text while paused, "not my number" for the whole account, premium-rate numbers refused. |
| `tests/gaps-nonus-words.test.ts` | What the product says to people outside the United States, and whether it is true: the consent text (what kind of signature this is, never that it equals a handwritten one) and its version in the audit trail, a QR code promised only because the app now draws one, the sentence about English, what "fix my name" really does, every public price written as US$ with the line about currency, the check before sending (which words set it off, which do not, that it warns and never blocks, the `warnings` in the answer to sending and the line in the audit trail), every country note dated and resting on a source the research names, "Where your data is" filled from settings with what was not stated said out loud, the data processing summary, and the line in signing emails for someone who cannot open the page. |
| `tests/gaps-mobile-send.test.ts` | Sending from a phone: the camera's orientation note read in both byte orders, a photo upright in the stored and in the signed PDF for all eight values of the note (drawn with pdf.js and checked corner by corner), several pictures joined in the order chosen, a session that slides while it is used and the list of where someone is signed in, the switch after sending, the lock on a device handed to someone who signs in person (the password, five tries, who is and who is not locked), the 44 pixel tap areas in the editor, the list of fields without a label, and the warning for a document that is slow to open on a phone. |
| `tests/gaps-mobile-sign.test.ts` | Signing on a phone: the legacy build of the PDF viewer opening a document with `Promise.withResolvers` taken away, a browser that cannot show the document told so in words with three ways on, the browsers on `/help`, the email link opening the page with no account and no cookie, a tap or a speck refused as a signature and a blank or solid picture refused as an upload, Finish without a connection (nothing signed, answers kept in the tab, sent again by itself, a lost answer not signing twice), long documents giving their memory back and Next jumping to a far field, the page sizes and pinch zoom, two fields of one person on top of each other refused in the editor and by the server, and the adopt dialog keeping its buttons on screen. |
| `tests/twostep-repair.test.ts` | Repairs to two-step login after a skeptic's probes: switching it on needs a confirmed address, and a password reset or Google never takes it away or gives a session without the code; Google connects nothing before the code; the reset by email needs the password (also after Google), waits 7 days, emails a stop link every day that works signed out, is on every signed-in browser's `GET /me`, stops on a sign-in with a code or a remembered device and on a password change, makes a new one wait 7 days after any other stop, is one at a time and three emails a day at most, signs every browser out when it takes effect, and can be switched off with a code; a stranger without the password cannot pause the owner and gets the same words and count, the owner on the same network still gets in, wrong codes sent at once get five tries, a pause from signing in never blocks Settings; an admin resets only a member who owns no workspace and is an admin of no other; waiting sign-ins end on a password change, a reset or signing out others; no key changes the password or reads two-step login; withdrawing a device signs it out; a required team still opens sessions and closing the login. |
| `tests/mobile-repair.test.ts` | Repairs to the phone work after a skeptic's probes: forty unlock tries sent at once get five password checks and the fifth wrong one signs the browser out, a session ending 90 days after sign-in however often it is used, or after 30 days without use (also one that slid past that before), "Sign out everywhere else" ending remembered two-step devices, Finish that only says nothing was signed when that is known and treats a second Finish as done, a public form's own 503 shown in its own words and not retried, two fingers on the signature pad making no signature, overlapping fields drawn smaller on top with templates and public forms checked, and all eight camera orientations upright in three real file layouts and both byte orders, on the page and in the signed PDF. |
| `tests/gaps-nonus-text.test.ts` | Text, dates, numbers and names outside the US and outside the Latin alphabet: a signed PDF with Chinese, Japanese, Korean, Thai, Hindi, Arabic, Khmer and Cyrillic names read back out of it, a script with no font (flagged to sender and signer, marked on the page, listed in the certificate) and a font file that is missing, right-to-left text with digits and Latin words in it (order, alignment, the typed text kept in the PDF, every box a signer types words into taking its direction from what is typed), one date format for typed dates and the date of signing, the account's default format, the date of signing by the signer's own calendar with local time and zone on the certificate, deadlines with time and zone in emails (the warning three days before too) and in the Give more time dialog, reminders that wait for a signer's morning, numbers as they are written outside the US, and a signer fixing the spacing of their name or offering it in another script. |
| `tests/encrypt.test.ts` | Encryption of stored files by the app itself: writing and reading with and without a key, old plain files beside new encrypted ones, a wrong key, a changed byte, a cut-short file, a file copied under another name, an upload that only looks encrypted, the server that stores nothing new when it finds files it has no key for (and says so at start), a key that is not a key, changing the key with the old one listed, the script on a folder with every kind of file (run twice, stopped half way, a leftover half-written copy, a file the server deleted meanwhile), and a whole send, sign, download, export and delete with the key set, with the files on the disk unreadable without it and the pages saying what is and is not encrypted. |
| `tests/qr-encrypt-repair.test.ts` | Repairs after a skeptic's probes of QR codes and encryption: the text read from uploaded PDFs encrypted with the file key (none of it in the database file on the disk, older text sealed and overwritten at start, moved to a new key), search, the check before sending and the click-to-agree filter still reading it, the pages listing what stays readable in the database, five envelopes whose signed PDF cannot be made never blocking the others (sender and operators told once, made when the file is back), a code or link shown again being the one that works now, a witness's code saying what it lets its holder do, emails retried without an unreadable attachment, a locked file in the export called locked, a click-to-agree record that says its terms could not be read, a signer's damaged attachment never left out of the sealed PDF, the signer told the server's words instead of a download that would fail, and a QR code for every member of a group. |
| `tests/gaps-industry.test.ts` | What agents, clinics, contractors, HR teams and small firms ran into: who can really open a document (a forwarded link, the account's admins, exactly what the people who run the server see), no health information agreement said in three places from one text, reminders on by default and said before every send (the editor, a bulk batch, a public form), what a bulk send holds and costs before the Send button in the numbers the send is held to, two people finishing the same envelope at the same moment (two addresses, one shared address, a late autosave crossing Finish), "filled in everything but has not pressed Finish", searching and moving templates, a "Strike out" field through to the signed PDF and the sign-again rule, and a link to the sender's own payment page after Finish (who may set one, the addresses refused by name and by where the DNS says they lead, shorteners, never before Finish, never to the sender's own team, never in an email, an attached certificate, an export or an evidence pack, gone when trust goes or when the person who set it leaves, who saw which address after a change, a deleted envelope); also a % or _ in the template search. |
| `tests/gaps-disputes-evidence.test.ts` | What happens around the certificate when a signature is disputed: what `/verify` and `/security` may claim (and what the hash chain really stops, checked against the code), the fingerprint kept for a year after an account is deleted, the public lookup by envelope ID (what it says and never says, its limit), the fingerprint in every completion email, the record of the completed copy (handed to the mail server, first opened, later visits once a day), the closed copy marked large across every page, "I did not sign this" from the check page and the signing link, the help topic that never reaches the sender, the evidence pack (the chain recomputed from it, no live links in its emails) and the page that explains each line of the certificate. Then the repairs after a skeptic's review: disputing with the code of any email we sent, also after the sender put another address under the name or someone passed it on; a dispute that stops the sender deleting for good and outlives the account as an id, a fingerprint, a day and a state until a person closes it; the sender getting the words and never the internet address or browser; marks that cover every corner and survive a black-and-white copy, also on copies made while out; and the first open after an upgrade not called the first. |
| `tests/comments.test.ts` | Questions and comments: private to the sender unless everyone is chosen, nobody reading a private thread they are not in (by its id, after a hand-over, on the device of someone who signs in person), the old "ask" being a private comment, one email to the sender at most every 10 minutes with the comments in it, an answer emailed to the person answered and nobody else, the rules of every email in the sender's name (a fake payment notice refused, held while paused), who is never emailed and why, the count before Finish and who may settle, nothing of the words on the signed PDF or in the audit trail, the export and evidence pack, read-only after completion, gone with the envelope, the limits, and the API with its webhook. |
| `tests/comments-repair.test.ts` | Repairs to comments after a skeptic's probes: two people signing in person one after the other on one device (Back to the earlier page, after they finished, a tablet that is not signed in, a forged cookie), the fake payment notice filter across a day of comments and the names beside them (one writer to several people, several writers to one reader, an admin's name, a form visitor's name, a recipient writing for everyone, and an honest office it lets through), an answer turned down at sending dropped with a note and the next one sent, settling limited with one audit line an hour, the webhook log after deleting and sending again, refused requests not using up the burst, the same comment twice, who is really emailed, and an admin reading a removed envelope. |
| `tests/templates.test.ts` | Who can use and change each template, and the lock on its wording: every route that lists, reads, uses, sends in bulk, copies, publishes as a public form, changes or deletes a template, for the owner of the account, an admin, the template's owner, a chosen member and another member, each by browser and by API key; the lock through the editor's whole save and through the plain API (what can be filled in, everything else refused with who to ask, nothing saved), once out too, unlocking and deleting the template; copies of templates and of locked envelopes; bulk sends and public forms; leaving and being removed; a database from before this. |
| `tests/witness.test.ts` | A witness for one signer: tied to one person who signs and every way that cannot work, asked straight after that signer whatever the order and holding nobody up, no signature held or used, the block and what prints when, the signer naming the witness before Finish (themselves, a party, a pause, the cap, the daily count), the statement as the witness's own words and a stale one refused, no decline and no hand-over for a witness, "I was not there" and naming the person who was, the certificate (the witness under the signer, the statement, its time, the note), the marks for the same address, the same browser and the same internet address and browser, reminders, the not-opened alert, Find my documents, the completed copy, declining, passing on, corrections, signing again, templates, bulk sends, public forms and the API description. The repairs: a finished witness set aside and asked again with the signature they saw, moving one needs the sign-again choice, no device fingerprint to any sender and none that links envelopes, no self-witness or party through Correct, an API key or a hand-over, the sender's choice kept after "I was not there" and in a copy, who was told said as it is, the witness's note to the sender only, the witness name read by the fake-notice filter, the deadline warning, the "same name" mark, and no fields of a party for a witness. |
| `tests/logic.test.ts` | Conditional fields and formulas: the formula reader (order of operations, brackets, sum and round, what it refuses in words, nothing run as code), numbers as people write them and the result written the same way, empty inputs, dividing by 0, numbers too big or too small, rules that chain and loops (refused when saved, naming the fields), what the review step warns about, a browser that lies about a hidden required field or a calculated value, a signature field that an answer hides, the signed PDF, someone else's answer counting once they have finished and a signed result never changing, sign-again after a rule or a formula changes (predicted the same way in the editor), templates, copies, public forms, bulk send rows that fill a field, and the lock on a template's wording. After the skeptic's review: a result with three decimals read back as the same number (PDF pictures and words, the sender's counts, the next person's formula), no Finish as signed without a picture, nothing learned about an unfinished answer from Finish errors, a total that changed under an open page, two radio buttons chosen at once, number rule values written two ways, a very long line of fields, long numbers in a formula, and digits of every script. |
| `tests/stamps.test.ts` | Company stamps: the processing steps as pure functions on pixels made in the test (paper removed under light that falls off by half and on grey, yellow, kraft and canary paper, a desk round the sheet, a hard shadow, ruled lines and a noisy faint stamp, one ink in every pixel with a little variation, a thin line kept thin, a design's tint printed solid, faint small print kept in a photo, black print left out and the stroke it crossed filled in, the ink chosen after cutting off the edges, a logo's colours kept apart, an oval made round, the texture sized in millimetres with full-ink cores, a heavier side, voids and darker rims, the ink found and other colours left out, a logo said to have several colours, the same impression for the same seed and another for another, trimmed with a small margin, a tilt from -4 to 4 turned by the page and not drawn in, a texture that keeps the ink readable, a see-through design, a seal that fills the picture, a dark table at the edge of a photo), which files can be a stamp, the account's stamps (up to ten, admins only, names checked for an unpaid account, anything but a see-through PNG refused in words, text and camera notes taken out of the file), a signer's stamp (Finish later keeps it, the answers never set it, required before Finish, the audit line with its fingerprint), the signed PDF (multiplied in at 97 percent and turned by its tilt, the words under it still in the file, the certificate lines and the honest sentence), changing and deleting a stamp, saved stamps from the signer's own account and who may not use them, the limits and who may see a picture, money, signing again after a change, templates, bulk sends, public forms, signing groups, the evidence pack, the export, deleting, and the API description. |
| `tests/clickwrap.test.ts` | Click-to-agree terms: drafts and versions, our page, the frame (only `?embed=1`) and the API, the signed link a website makes, the record that never changes and its seal, what the certificate says the browser reported, the receipt and one copy by email only for the browser that accepted and an address the website gave, the scam filter on every word the page shows, the two monthly counts and the limits per address (offices, IPv6 blocks), paused accounts, reports, members and keys, and deleting with the files. |
| `tests/seal.test.ts` | The digital seal of a completed PDF, checked by poppler's `pdfsig`, `openssl cms -verify` and `openssl ts -verify` where they are installed (each test that needs one is skipped otherwise) and by pdf.js: no settings leave the file byte for byte as it was and write nothing down; a sealed file is covered to its last byte and the stored SHA-256 is of it; one changed byte breaks the seal and a byte added after it is told apart; keys from a .p12 (as OpenSSL 3 writes it, and the old triple DES and RC2 kind) and from PEM, RSA-PSS and ECDSA P-256; an expired, not yet valid, wrong-purpose, mismatched, too small or unchained key refused with the file made as before and the operators told once; a time-stamp service made in the test (B-T, its token verified by OpenSSL), and every way a time-stamp can fail falling back to B-B at once, with the certificate saying so; several services in order and a 10-second timeout; `/verify` on the sealed file, an added-to file, a changed file, a file sealed by someone else and one sealed with an earlier key; envelopes completed before the seal never sealed afterwards; a voided copy unsealed and saying so; an uploaded PDF that already carries signatures. |
| `tests/seclog.test.ts` | The security record: each kind of event written once, to the right accounts, with the right person and address (the team, sign-ins and their failures to every account of the person, logins, two-step login, keys and their new addresses, settings, webhooks, deletions, template rules, the export, the owner handed over, the GrowSigning team), a wrong password and a wrong code written the same way for a login with two-step login, nothing secret in any line (the test's passwords, keys, tokens, codes and addresses looked for), members and send keys refused, an admin key paging in order, filters and the CSV, names only when shared, lines that cannot be changed or deleted, a forged line found by the chain, the purge after `SECURITY_LOG_DAYS` and with the account, the alerts once an hour and switched off by a person only, and the opt-in webhook. |
| `tests/retention.test.ts` | Keeping closed envelopes for a set time: the rule off by default, only admins change it, 30 to 9,999 days, a level, a template's own period and a dry run that counts; the due date for each way of closing (completed, voided, declined, expired) and none while out; one email 14 days before to the sender and the admins, not twice, and nothing purged sooner; a rule switched off or a level raised after the email; Keep it with its reason in the audit trail; legal holds on an envelope and a folder (members refused, a reason needed, the sender's delete, Purge now, the timer and the purge itself refused and recorded, a folder hold that follows an envelope out of it), lifting with a reason, closing the account and the timer refused with the list of holds (recorded once a day), the two-person lift by the people who run the server; what each level removes and nothing more (pages, signed PDF and attachments off the disk, a template's file kept, values and signature pictures, names, addresses, internet addresses, browsers, the subject's names, our email copies); `/verify` by file and by ID, the signing link, the email's security code, downloads, the evidence pack and copies after a purge; a redacted trail said as redacted, while any other change still shows; Purge now and calling it off within the 14 days; an open dispute; the retention record never changed and without names after the account goes; the export; and today's delete and restore as they were. |
| `tests/convert.test.ts` | Office files turned into PDF: every kind recognised from bytes built in the test (Word, Excel, PowerPoint, OpenDocument, the old binary formats, RTF, HTML, text, TIFF) and never from the name, the unknown kinds and what each is told, passwords, ZIPs that unpack to more than 100 MB or 20 times their size (also when they lie about it, and one entry listed eighteen times), the test converter through a whole send, sign and evidence pack (the audit line with both fingerprints, the original kept encrypted, in `originals/`, kept while another account has it and deleted with the account), a correction that puts a converted file on, the notes (tracked changes, comments, sheets, outside content but not web links, macros), a name that reads like a payment notice left out of the record, no converter set up, a signer's attachment, several files at once, a TIFF that would lose pages, a stand-in for LibreOffice that hangs (killed with what it started, its folder gone), shows its environment (no secrets) and its network (none), the queue and the limit per account, and the real LibreOffice when it is installed. |
| `tests/i18n.test.ts` | Languages: the catalogue parser and its placeholders, plural rules for English, French, Arabic and Russian, the fallback from pt-BR to pt to English, a missing or broken text shown in English and never as its key, right to left, the statuses of each language, the choice of language (the sender's, the browser's, English), legal texts in English with one sentence until a person has checked them, the language recorded in the audit line and read back by the evidence pack, `recipients[].locale` and `default_locale` refused in words when a language is not available, templates, copies, bulk rows and public forms, the bulk list's language column, `<html lang>` and `dir`, dates and numbers by language with the signed PDF unchanged, and `npm run i18n:check` failing on a catalogue that does not match. |
| `tests/brand.test.ts` | The GrowSigning brand: brand.css loaded last, no leftover data URI icon, the four icon files and the link preview picture the same as the brand kit with its alt text, `metadataBase` from `APP_URL` (a broken one falls back instead of taking pages down), one web app manifest whose icons are the sizes it says, the drawn logo in every place that showed the leaf beside the typed name and never the mark beside the typed name, the email logo picture (a sender's own logo or name still first, escaped), the stamp at the foot of every page of a signed copy turned 0, 90, 180 and 270 degrees and of the certificate with its deep green band and logo (drawn with poppler, pixels counted), no old name or wrong web address anywhere, and a browser signed out after 30 idle days or 90 days from signing in. |

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
| The plan renews with no warning, and the email does not say the amount. | Month to month only. A week before and again the day before every renewal an email states the exact amount and date, with a link that stops it. The reminders run on the app's own timer and are written to the plan history. If more is charged than the reminder said, the difference is refunded by the software. Every payment gets a receipt. |
| "I cancelled and was charged anyway." | Cancelling tells the payment provider at once, says "cancelled" only when the provider has confirmed it, and returns a reference that stays on the Plan page. A charge on a plan that already ended, a second charge for the plan, or a charge on a free plan is refunded by the software itself; if the provider is down the refund is retried on the timer for as long as it takes and a person is told when it keeps failing. Cancelling while a payment is failing, or in the hour before a new month's payment is taken, ends the plan the same day and withdraws that payment. Cancelling on the provider's own page gets the same reference and email. If one of the provider's messages is lost, the timer reads the real state back. A card dispute stops all billing, takes the unused signatures of that payment back with the money, and small ones are not contested. |
| There is no cancel button. | One button on the Plan page. A stop link in every email about a payment while a plan renews, which works without logging in (`/billing/stop`) and dies when that admin leaves the team. On `/help`: find every paid plan by email, or stop billing with the card alone (last four digits plus the account email, or plus the date and amount of a charge). |
| Refunds are refused or left to someone's discretion. | One rule, applied by the software and written once (`refundRuleText` in `src/lib/policy.ts`): within `REFUND_DAYS` of a payment, every signature from it that has not been used is refunded at the price paid, for any payment in the window, not only the latest. No form and no approval. Two requests at the same moment pay out once. |
| "I paid and nothing happened." | The plan and its signatures are there the moment checkout finishes, whichever of the provider's messages arrives first, and the page only says thank you for a payment that really arrived. A payment that cannot be matched to an account is flagged to a person at once. |
| Bills for going over the limit. Documents that count even when nobody signed. | People pay for signatures, and one is used only when somebody actually signs. Sending holds one per signer. Voiding, declining and expiring give it back, unless that signature's own date passed while it was held: then it is gone instead of coming back (a held one never expires while it is held). Running out pauses sending and never creates a charge. |
| Prepaid allowance disappears at renewal. | It does here too, and we say so: since 2026-11-20 a month's 9 signatures belong to that month and the unused ones expire at the renewal (or at the end of the paid month after cancelling), top-ups 12 months after their payment, and the 3 free ones 30 days after the account was made (`expiryRuleText` in `src/lib/policy.ts`). To be fair about it: the date and time is shown everywhere signatures are counted (the Plan page says "6 of 9 left, they reset on 3 December 2026 at 14:00 UTC" and lists each top-up with its own date, and every receipt and renewal reminder says how many will expire and when); the one that expires soonest is always used first, so nobody loses one that could have been used; a signature held for an envelope that is out does not expire while it is held; top-ups get an email 30 days and 3 days before they expire, if any are unused; and the trees are planted from the money either way, used or not. |
| The price went up and nobody said so. | One rule, written once (`priceRuleText` in `src/lib/policy.ts`) and enforced by the server: an account stays on the monthly price it has been paying until every owner and admin has been emailed the new price at least 30 days before the day it starts, with a link that stops the plan. A renewal that charges more without that notice has the difference refunded automatically, the customer still gets the full month, and the operator is told (a week ahead if the provider already shows the higher amount). The operator announces a price on `/app/operator`. |
| "I updated my card and the plan is still on hold." | A plan the provider has stopped retrying says so, and offers "Pay the open payment", which opens the provider's page for exactly that invoice. If it was paid in the meantime the plan is read back instead of offering the payment again. |
| Paying for a plan nobody uses. | A nudge after 60 quiet days. After `DORMANT_AUTO_STOP_DAYS` without a send, the renewal is stopped before the next charge and the owner is told. |
| Support is a chatbot loop, and closed to anyone who cannot log in. | An AI helper answers at once, on the public pages, in the app and from Other actions on the signing page, signed in or not, and a person is always one click away: "Talk to a person" is under every answer and opens the contact form with the chat attached (the writer sees it and can take it off). The helper offers a person by itself for money taken or owed, "I did not sign this", a security problem, a lockout, anything legal (whether to sign included), an upset person and a second answer that did not help (the server reads the words in English and the common ones in five other languages; beyond those it relies on the model, which is told the same). It answers from the same rules the pages print, says it is an AI and can be wrong, gives no legal advice, takes no action and points to the tools that do (see "The help chat"). Without a model set up, or past a limit, the built-in answers reply instead and say so. `/help` works without an account: self-service tools, then a contact form that returns a reference and goes to a queue people work from (`/app/operator`, and `SUPPORT_EMAIL` if set). The reference is eight characters nobody can misread. The Help link on the signing screen and in every signing email carries that email's security code (never the signing link itself), so the form shows the signer which document their message is about before they send it, the people who answer see it, and its sender, who can usually fix it at once, is told that the signer needs help. Someone who arrives another way can type the code. The words of the message only go to the sender when the writer is signed in under the confirmed address they wrote from; otherwise the sender only learns that the person needs help. Help is one click away from the sign-in forms, the public form page and the editor. |
| No answer, no reference, nobody owns the problem, and the ticket is closed without a word. | Every help request is a ticket (see "How support works" below): a reference, a state the customer can see, one operator who has it and whose first name the customer is shown, and a thread. A response time is published (`SUPPORT_FIRST_REPLY_HOURS`, `SUPPORT_URGENT_REPLY_HOURS`), and the confirmation says the actual time a person will have answered by. When that time passes the request says "We are late with this. Sorry.", everyone who answers is emailed, and so is the customer. Every answer is emailed in full, with a private link that opens the request without a login, because the people who need help most are locked out. Nobody closes a request without a written answer, and a reply opens it again. A stranger who types your address into the form can send you at most three emails a day that way and can never use up what you can send us yourself. When the mail server refuses an answer, the person who wrote it is told at once, and again if it is given up, so nobody believes an answer arrived that did not. |
| A typo after sending means void and start again. | An envelope that is out can be corrected in place: names, addresses, fields, people. Signatures already collected stay. Once someone has finished, the pages they signed only change if the sender chooses to ask them to sign again. That covers the files, the fields, the sender's wording and any name or address a field prints on the pages, by every route: the editor, the API, the quick correction, a signer passing the document on or fixing their name. They are told what changed, the first signature stays on record together with the document as they signed it, and it costs no extra signature. What a finished signer left empty or unticked is their answer and is never filled in again. A signer whose page is open during a correction cannot finish on the old version: the page loads the changed document again, and Finish stays off until its pages are on the screen. A change made outside the editor (a quick correction, a hand-over, sending) is a newer version too, so an editor that was opened before it cannot undo it. The audit trail says what every correction changed. |
| Two people share one email address, and one person's signature ended up on the other's line. | A signature, initials, typed answers and the agreement to sign electronically belong to the person who made them. When the sender puts another person's name on a request at the same address (with Correct or in the editor), the request starts empty for that person on the same link, and they agree for themselves. A spelling fix of the same person keeps everything. "Fix my name" takes only a spelling of the name the sender wrote: never one that is, looks like (letters of another alphabet that look Latin, one letter off) or borrows from another person's on the document, and never a name that would turn the sender's own free signature into somebody else's. A browser tab keeps a signature only under the name it was made for. |
| A Word file has to be exported to PDF first, or comes out different after the upload converted it, and nobody noticed before it was signed. | On a server with a converter, Word, Excel, PowerPoint and similar files are taken and turned into a PDF at upload, and the sender sees that PDF before placing a field, with "Check every page: the PDF is what people sign, and conversion can move text." next to it, plus a word about tracked changes, comments, split sheets, outside pictures and macros where the file has them. The audit trail names the original by its SHA-256 and the tool, and the evidence pack keeps the original. Nothing says the layout is the same. |
| Signing links expire or stop after a few opens. | A link works for as long as the envelope is open, with no limit on opens. A replaced link offers to send the current one. `/help` emails anyone their documents again. An expired envelope is reopened, not rebuilt, and signers can ask for more time. |
| Signers are pushed to create an account. | Signers never need an account or a password, and are never sent marketing. |
| A signer has no way to ask about a clause before signing, and the answer is lost somewhere in email. | "Questions and comments" next to the document: a question goes to the sender's side (the sender and the admins of their account) privately unless the signer chooses everyone, the sender answers on the envelope page, and the answer is on the signing page and in one email when we can email that person (not someone signing in person, without an address, or whose address bounced or marked us as spam, and the page says so). Nobody else on the envelope ever reads a private thread, also not the next person handed the same device to sign in person. The sender sees who waits for an answer, and someone who presses Finish with a question unanswered is told so and can still finish. Comments are not part of what is signed, and the audit trail records who wrote and when, never the words. |
| The text message code never arrives, my number is refused, and only the sender can change the check. | A sender can ask for a one-time code by email, or by text message to a mobile number they type where the operator has switched texts on. A number is checked for its country code when the sender types it, with one rule for every screen and the API, so a number that cannot be texted is caught before anything is sent. The code screen shows where the code went (masked) and when a new one can be asked for, and offers "I do not get the code" and "This is not my number": both reach the sender at once, whatever their email settings, and tell the signer honestly that only the sender can fix it. After "not my number" no more codes or links go to that number from that sender, on any envelope. A text the provider would not take is tried again like an email, decided again at that moment (a corrected number, a decline, the pause), and the sender is told when it never goes through. Limits on codes are counted per sender, so nobody can lock a person out of another sender's documents, and a whole office behind one internet connection gets its codes. Texts are not charged to customers. See "Checking who signs". |
| "I cannot tell a real request from a scam." | Every signing email names the sender and carries a security code that anyone can type into `/check`. Senders must confirm their email, and the confirmation link only works together with the login's session or password, so nobody confirms a login that a stranger made in their name. Until an account has a payment that is 14 days old and was not refunded or disputed (`PAID_TRUST_DAYS` in `src/lib/policy.ts`), or a person has cleared it, it has a daily limit on how many people it newly emails, however it reaches them, and cannot send what reads like a fake payment notice or send or invite under the name of a well-known brand. A public form named like such a notice is refused, because its page would print it on our address to anyone with the link. Paying does not switch that off at once. Recipients can report a request from the email itself or from the signing page, also after the sender has deleted the document, and enough reports pause the sender until a person has looked. The filter (`src/server/fakenotice.ts`) catches the common trick in the spellings the tests list, not every scam: a notice worded another way, or a brand that is not on its list, passes. Reports and the pause are the backstop. A click-to-agree page is read the same way, every word it shows (the box, the button, the notes of what changed, the name a website signs into its link), and a copy of an acceptance is emailed only to an address the website vouched for, once, so a stranger cannot make us write to anyone. |
| "They say they never got the email." | The envelope shows whether each email left, and the audit trail only says "Sent to recipient" when the mail server took it. An email it would not take is tried again by the timer for about a day and a half, and the sender is told when that fails for good. The sender is told when a request sits unopened, and can copy the signing link, remind one person or correct the address. |
| An email bounced and nobody said so: reminders kept going to a dead address, and the sender found out weeks later. | On a server connected to its mail provider (`MAIL_EVENTS_TOKEN`), an email that comes back for good tells the sender at once, says "Could not be delivered" with the reason in plain words on the envelope and in the list, and stops reminders to that address until the sender corrects it or chooses "Try again". For 30 days a new envelope to the same address warns first and goes out when the sender says so. Someone who marks our email as spam is not emailed by that account again, also after a correction away and back or on a new envelope, unless they ask on a signing page with a code we email them (the sender holds the link, so the link alone is not enough), and it counts as a report like the "Report this email" link, also after the sender deleted the envelope. That holds for each member of a signing group by themselves: no reminder, notice or copy goes to that member, the sender is told it was a member of the group and that the others are not affected, and the member who took a document on and bounced is never told to use a Correct that groups do not have. News that names no email of ours, or only an address that two senders wrote to, touches nobody. What a recipient's mail server wrote is never shown or emailed to a customer, only our own words for it. When our own emails to a customer come back, every page of the app says so, with a way to move the login to another address. "Delivered" only ever means that their mail server took it. |
| The account was locked with our contracts in it. | Cancelling, a failed payment or a pause never deletes or locks a document. Pausing stops what a sender starts from being emailed (new sends, new or changed recipients, reminders, reopening, team invitations, notices about a change, and people further down a signing order wait until it is lifted). People who already have a document can still sign it and are sent their copy, a document that is out can be given more time, and it can be voided (the people on it are told, without the reason). |
| There is no way to get everything out. | One free export of every signed PDF, audit trail and a CSV index, on every plan, also after cancelling (`GET /api/export`). |
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
| I have to keep contracts for exactly as long as the law says and no longer, and the e-signature tool either keeps everything for ever or deletes the evidence with nobody told. | An account rule under Settings, Your data, off by default: keep closed envelopes for 30 to 9,999 days from the day they closed (a template can have its own period), then remove the documents, or also what people filled in, or also the personal details in the record. The sender and the admins get one email 14 days before, and "Keep it" (with a reason in the audit trail) keeps one for another period. An admin can put an envelope or a folder on legal hold: the software then refuses every way of deleting or purging it, and records each attempt. The setting, the email, the envelope page and `/security/processing` say what stays: the record with its fingerprint, copies people already have, and backups until the operator's cycle ends. Never "deleted everywhere". |
| The signing screen says an electronic signature equals a handwritten one, and where I live it does not. | The text every signer agrees to says what this is: a simple electronic signature, usable in many countries for agreements that need no special form, with rules that differ by country and by kind of document, and it tells the signer to ask the sender or a lawyer when unsure. It no longer says that such a signature equals a handwritten one, on the consent screen or under "Adopt and sign". The signer also accepts the electronic method as the way the parties sign. The wording has a version, the audit trail records which version each person agreed to, and `/help` prints the words. The wording shown before versions were recorded is kept word for word (`UNVERSIONED_CONSENT`), so the evidence pack prints for such a person what they saw, marked as inferred, never today's words. Research: `research/gaps-partial.json`, "map:nonus". |
| Nothing warned me that this kind of document cannot be signed electronically in my country. | A check before sending reads the subject, the document names and the text of the documents for words that usually mean a will, a trust deed, a power of attorney, a sale of land or a long lease, a fixed-term employment contract or a notice of termination, or a deed that needs a witness or a notary (one list, `src/lib/paperwork.ts`, in English, German, Spanish, Portuguese and French). Document names are read the way file names are written ("Power_of_Attorney.pdf", "PowerOfAttorney.pdf"), and German typed without umlauts ("Kuendigung") is found too. The review step of the editor names the word and where it stands, the API answers sending with the same list as `warnings`, and the audit trail records it. It warns and never blocks. `/help` has one section with the documents not to sign here and short notes by country, each with the month it was looked at and its source, and says that none of it is legal advice. A sender whose clock is set to India or Indonesia is told that signing does not pay stamp duty. |
| A deed needs a witness who was in the room, and the e-signature tool had nowhere to put one: a witness added as a second signer used a paid signature and recorded nothing about being there. | A recipient can be a witness for one person who signs. They are asked straight after that person has signed, whatever the signing order says, never use a signature, and fill in a block the sender places next to that signature (signature, name, address, occupation, date). The sender names the witness, or the signer does on their review screen, next to one paragraph on who may witness. The witness's first screen is their own statement, "I was physically present and saw Ann Lee sign this document on 20 November 2026", to tick before they can sign, or "I was not there", which tells the sender, and the signer when we can email them (never with what the witness wrote), and lets the signer name the person who was. The certificate lists the witness under the signer with the statement and its time, and marks a witness at the signer's email address, under the signer's name at another address, or in the browser the signer signed in, which the sender is told about. For the device the sender only ever sees "same device: yes or no", with what that can show: the browser cookie behind it is fingerprinted per envelope and never leaves the server. A statement belongs to one signature: when that signature is set aside (sign again, or the place goes to another person) or the witness is moved, the statement is set aside too, written to the audit trail, and the witness is asked again. A witness cannot be the signer, a party, or someone with a party's fields, whether by sending, Correct, an API key or a signer passing the document on. Every screen and the help page say that GrowSigning records what the witness states, cannot check that they were in the room, and that whether a document witnessed this way is accepted depends on the law that applies: for a deed, check first. Rules and words in `src/lib/witness.ts`, the server side in `src/server/witness.ts`. Research: `research/gaps.json`, "map:nonus". |
| The price said $9 and I could not tell in which dollars. | Every price on a public page is written as US$, with one line: prices and payments are in US dollars, and a bank may add a fee for converting. |
| I cannot find out where my documents are stored or who else handles them. | `/security` has a block "Where your data is", filled from settings (`OPERATOR_NAME`, `DATA_REGION`, `DATA_HOST`, `DATA_BACKUPS` and the provider settings): where the server is, who else handles data, in which country and what for. A provider is listed only when its switch is on, and whatever the operator has not stated is printed as "has not said ... Ask them." instead of being left out. `/security/processing` is a plain data processing summary to save as a PDF, and says that a signed agreement is between the customer and whoever runs the server. |
| My signer cannot open the page where they are, and nobody says what to do. | Every email that asks someone to sign ends with one line: reply and ask the sender for the document as a PDF. `/help` tells the sender what to do then, and that a signature collected that way is outside the certificate. No claim is made about any country, because none was tested. |
| My signers live in WhatsApp, not email, and a recipient cannot exist without an address. | Tick "I will send the link myself": a name and no address. We never write to that person, the envelope page hands the sender the link and the ways to share it, the sender gets the turn, the reminders and the copy in their place, and the certificate says "Link shared by the sender" instead of claiming an email went out. They count towards the limits like anyone. Their own page never promises them an email: asking for more time says the sender will reach them the way they sent the link, and the sender's email says there is no address to reply to. |
| My signers do not read English and nobody told me. | The landing page, `/help`, `/security` and this file say it in one sentence (`LANGUAGE_NOTE`): the signing screen and the emails are in English for now, and the document can be in any language. `/help` prints the consent text so a sender can translate it. The foundation for other languages is built (catalogues, a language per recipient, legal texts in English until a person has checked a translation, the language each person agreed in on the audit line), and no screen is translated yet. |
| A name in Chinese, Thai or Hindi comes out as empty boxes on the signed document. | The signed PDF and its certificate print Latin (with accents), Greek, Cyrillic, Arabic, Hebrew, Armenian, Georgian, Chinese, Japanese, Korean, Thai, Devanagari (Hindi, Marathi, Nepali) and Khmer, with the letters joined and stacked as the script needs, and only the font files a document uses are embedded in it. For any other script (Tamil or Bengali, say) nothing is printed as an empty box: the sender is told on the envelope page and before sending, the signer in the check before finishing, each such character is printed as the mark �, and the certificate lists them by Unicode number. A font file that is missing after a broken install counts the same way instead of failing the PDF. A typed signature shows four handwriting styles only when the handwriting fonts can write the name, and one plain style otherwise. |
| Hebrew or Arabic typed into a field is reversed, and house number 42 becomes 24. | Right-to-left text is put in reading order on the signed PDF and the certificate, with digits and Latin words inside it left to right, and it starts at the right edge of its box. The fields on the signing page take their direction from what is typed. The words as typed are also written into the PDF next to the glyphs, for programs that copy or search. |
| The dates on my document are in American order, and one page shows two formats. | One format for every date on an envelope: the date each person signs on, and any date they pick in a date field, on the signing page, in what other signers are shown and on the PDF. An account sets the format its new envelopes start with (Settings, Account), and the formats with the month as a word are listed first. Nothing is ever converted to month-first unless the sender chose that. |
| The signing date is a day off from my own calendar, and no time zone is given. | The date of signing is the calendar day where the signer is, by the time zone their device reports with consent and with Finish (falling back to the sender's zone, then UTC). The zone is written to the audit trail, and the certificate prints the signer's local time with its zone next to UTC for each of their steps. A signed PDF is built once and never changes afterwards. A zone belongs to its person: after a hand-over, a correction to someone else or a hand-back to a group, the new person starts without one. The audit trail names it the first time and once more at Finish if it changed, so nobody holding a link can fill the certificate with zone lines. A zone named after an offset (Etc/GMT-14) is printed as its offset (UTC+14:00). |
| The email said the 20th, the page said the 21st, and it closed at 9:40 in the morning. | A deadline is a moment, and it is always given with its time and its zone: in emails in UTC ("closes on 20 March 2027 at 16:40 UTC") and in the reader's own zone as well once we know it (a signer's from their device, a sender's from the app), on the signing page and the sender's pages (also when giving more time) in the reader's local time with the zone named. |
| Reminders arrive at one in the morning. | Once a signer's time zone is known, automatic reminders keep to their daytime, 8:00 to 20:00 there. One that falls in their night waits for the morning, and the audit trail says so. Without a known zone it goes out at about the hour the envelope was sent, as before. A reminder the sender sends by hand always goes at once. One that waits is dropped if the sender turns reminders off before morning. |
| An amount written 1.234,56 is refused. | A number field takes numbers the way people write them: 1.234,56, 1 234,56, 1'234.56, Indian grouping (1,23,456), a currency sign before or after. The signing page and the server check with one rule (`src/lib/numbers.ts`), and what was typed is printed exactly as typed. |
| The security page said only the right people can open a document, and nothing about who else can. | `/security` has a block "Who can see your documents", from one list (`WHO_CAN_SEE` in `src/lib/policy.ts`): whoever holds a signing link (which is why access codes and one-time codes exist), the sender, the owner and admins of the account, the people who run the server (exactly what their queue shows, no document; and that the disk is another matter, under a rule the software cannot enforce), the companies that carry it, and nobody else. |
| Public forms sold for consent forms, and no word that there is no health information agreement. | One statement (`NO_BAA_TEXT` in `src/lib/policy.ts`) on `/security`, under the pricing rules and on `/help`: there is no HIPAA business associate agreement at any price, so a US healthcare provider must not put patient information through it, and what would have to exist first. There is deliberately no click-through agreement. |
| Bulk send "on every plan", and the price only showed up after the Send button. | The bulk page shows what a batch holds, what you have, what is missing and what that costs before the Send button, from the count the send is held to (`POST /api/bulk/check`), and the landing page says the cost next to the feature. |
| Everything was filled in, nobody pressed Finish, and the deal waited for days. | The step before Finish opens by itself the first time nothing required is left. The sender's envelope page says "filled in everything but has not pressed Finish", and the reminder to that person says one button is left. New accounts remind every 3 days by default, shown before every send. |
| Fifty waiver templates and no way to find the right one. | The templates page has a search over every word of the name, roles, folder and the document itself, a folder filter, and Move, like the envelope list. |
| Anyone on the team could open our HR letters, and a salesperson sent the contract with the liability clause changed. | Each template says who can use it (everyone, admins only, chosen members) and who can change it, and its wording can be locked: whoever may not change it fills in names, addresses and the empty fields, and the editor shows the rest as locked from the start instead of refusing at the end. A template someone may not use is not in their list, and a refusal names who to ask. A copy is no way round it: a copy of a locked or restricted template stays with its owner, and an envelope from before the lock cannot be copied into an unlocked one. The note and the identity check the template gives a signer stay too. The owner and admins of the account, and the template's own owner, are never locked out. |
| To strike a word from a form I had to edit the PDF somewhere else. | A "Strike out" field draws a line through printed wording, the same on the signing screen and in the signed PDF, and counts as wording: once someone has signed, it only changes if they are asked to sign again. |
| A deposit is due at signing, and collecting it needs the top plan or a second tool. | An account that has earned trust can add a link to its own payment page. Each person who signs sees it after Finish, with the name of whoever set it and the full address, and the page says GrowSigning takes no part in the payment and does not check where that page sends them next. The address is never in an email, an attached certificate or an export; shorteners and private-network addresses are refused; the link goes when the person who set it leaves the team. The record says who was shown which address and who pressed it. |
| My name was cut at the first space, and I could not fix how it is written. | One name as written, everywhere: no screen or share text greets anyone by a guessed first name, and a new workspace is named after the whole name. A signer can fix a letter, the spacing, a hyphen or a dot of their own name ("山田 太郎" to "山田太郎"). A name offered in another script (Cyrillic to Latin, kanji to Latin) goes to the sender to confirm, and the signer is told that it may well be the same name, not that it is a different one. |
| My phone photo of a paper page came out sideways in the signed PDF, and the fields were off. | A phone camera writes a note into a JPEG that says which way up it is. The server reads it (`src/server/exif.ts`, no library), puts the picture on a page that suits it the way the note says, and sets the note to "upright", so the page is the same way up in the editor, on the signing page and in the signed PDF, and a field is where it was placed. The test draws the signed PDF with pdf.js and checks the corners for all eight values of the note. |
| I photographed five pages and got five documents, each of them huge. | When several pictures are chosen at once the editor asks whether they are one document, shows them in the order chosen with a way to change it, and joins them into one PDF, a page for each (up to 50). A picture larger than a page needs is made smaller in the browser before it is uploaded (2,000 pixels on the long side). |
| My phone keeps asking me to sign in. | Signing in on another device signs nothing out, and Settings, Profile lists every browser that is signed in, with the device, the browser, the last use and the day it is signed out by itself, and has "Sign out everywhere else" (which also ends the other devices' skipping of two-step login). Two rules sign a browser out, whichever comes first: 30 days without use (`SESSION_DAYS`), or 90 days after it signed in, however often it is used (`SESSION_MAX_DAYS`). A phone used every week stays signed in for 12 weeks and then asks once; a copied sign-in that kept being used once a month used to stay alive for ever, and now dies 90 days after the sign-in at the latest. |
| A client of mine was locked out, and was told only their admin could help. | Two-step login (an authenticator app, `src/server/twostep.ts`) comes with ten recovery codes, shown once. Without phone and codes, an owner or admin of the team switches it off under Settings, Team: the person is emailed at once, and their record says who did it. Someone who owns a workspace (whom nobody else may reset) or anyone else resets it by email, after the right password: it takes effect after 7 days, with an email every day that can stop it without signing in and a notice on every page, and a sign-in with a code or a remembered device stops it. A password reset or Google never takes it away, and a stranger who does not know the password cannot pause it. The screen where it is switched on, the sign-in screen and `/help` say all of this before anyone is stuck. |
| I handed my tablet to a client to sign, and my whole account was a tap away. | Opening the signing page of someone who signs in person locks the host's account in that browser until the host types their password, and the signer's last screen asks them to hand the device back. Five wrong passwords sign that browser out, counted on the server before each password is checked, in one statement, so forty guesses sent at once from the browser's console get five checks, not forty; one address can try 30 times in 15 minutes. What the lock does not cover (the rest of the device, a password the browser offers to fill in, a Google or Microsoft session) is said next to "Host signing now" and on `/security`. |
| I ended up with two accounts and nobody could merge them. | Pressing "Continue with Google" or "Continue with Microsoft" while already signed in never makes a second login on the way. The person is sent to Settings, which says to connect that account to the login they are in, or to sign out first for a separate one, and the sign-in page says who is signed in instead of offering the buttons. A Connect that took too long, or was replaced in another tab, goes back to Settings too. |
| On my phone I never hear that someone signed. | The page after sending has one switch, "Email me each time someone signs". It sets the same preference as Settings, Notifications. |
| Fields in the editor are too small to grab with a finger. | On a touch screen every field answers a tap over at least 44 by 44 pixels (a tick box is drawn about 9 pixels wide at phone width), so does the resize corner, and every button of the editor on a phone is at least 44 pixels tall. |
| A blind signer hears "Text, required" and cannot know what to type. | The last step before sending lists every field a signer fills in that has no label, says why that matters to someone who uses a screen reader, and opens each one with the cursor in its Label box. It warns and never blocks. |
| The upload said 25 MB was fine, and my signers' phones sat on a blank page. | A signer's phone downloads the whole file, and we measured how long that takes on a slow mobile connection: about 5.7 seconds a megabyte (`PHONE_SECONDS_PER_MB` in `src/lib/policy.ts`, Chromium at phone size with Chrome's "Slow 4G", not a real phone). The upload box says so next to the limits, and a document of 5 MB or more gets a warning under it and again before sending, with the wait for its size and what to do. On a phone the box says "Tap to choose files or take a photo", not "drop" or "click". |
| The signing page stayed blank on my older iPhone. | The PDF viewer is the legacy build of pdf.js, which runs wherever the app itself runs (iOS 16.4, Chrome 111); the modern build needed iOS 17.4. A browser that still cannot show the document gets a notice in words with three ways on: copy the link into another browser, download the PDF, ask the sender. `/help` lists the browsers and says what was tested. |
| A tap on the screen went onto the contract as my signature. | A drawing whose lines add up to less than a quarter of the width of the box, that fits in 40 by 12 pixels, or that covers nearly half the box is refused in words, with Type offered instead; so is an uploaded picture with no ink or almost nothing but ink (`src/lib/ink.ts`). It judges the size of a mark only, never whether it looks like anyone's signature, and only in the browser. |
| "Failed to fetch. Go back, put it right." I had no signal, and nothing to put right. | Finish without a connection says that nothing was signed only when that is known (the device was offline before it was sent, or the server says so); when the answer was lost on the way it asks the server, shows the done screen if it went through, and otherwise says plainly that we cannot tell yet and that nothing typed is lost. A Finish sent again after one that went through is simply done, with no error. A public form that has no signature free says so in its own words (we email the visitor when it can take their signature) instead of "could not reach GrowSigning", and is not sent again every 15 seconds. It says that the answers are safe on the page, keeps the last step open and sends it again by itself when the device is back online (and every 15 seconds while it says it is online). Answers not saved yet are kept in the browser tab too, so a reload does not lose them. Nothing is shown as signed before the server has said so. The landing page, `/help` and the in-person notice say that signing needs a connection to open the document and to finish. |
| A 100 page contract crashed my phone, and Next stopped past the field. | Pages more than three screens away give their picture back and are drawn again when they come near. Measured on 100 pages at 390 by 844 (Chromium, not a real phone): 277 MB of page pictures after scrolling to the end before, 19 MB after. Next jumps to a far field instead of gliding, and checks where it landed when the scrolling stops: from page 1 to a field on page 51 it now lands on screen at the first tap. |
| The print is tiny on a phone, and there is no zoom. | 100, 150 and 200 percent above the pages, drawn again at that size at the phone's own density (up to 3, within 6 million points a page), sliding sideways in a strip of their own so the bars stay put. Pinch zoom is never switched off. |
| Two signature boxes on top of each other, and the signer could never finish. | The signing page draws the smaller of two overlapping fields on top, so a tick box inside the end of a text field, as paper forms have it, can be tapped and so can the text field. Sending, correcting, saving a template and making a public form refuse a field of one person that more than 60 percent of is hidden under that person's fields drawn over it, naming the person and the page, in the review step of the editor and on the server (`src/lib/stacked.ts`). A public form made before this rule keeps taking visitors (Text view reaches every field) and its owner is emailed what to move, instead of every visitor being told the form cannot take signatures. On an envelope that was out before, Next that keeps coming back to the same field points to Text view. |
| I put two fingers on the signature box to zoom, and that zigzag became my signature. | The pad draws with one finger at a time. A second finger that lands while one is drawing takes that line away and says "That was two fingers at once, so it was not kept", and nothing draws until every finger is off. A palm resting next to a pen is ignored (`onePen` in `src/lib/ink.ts`). |
| A 50 megapixel photo sent through the API froze the signer's phone. | The app's editor makes photos smaller before they leave the phone; the server does not. So a JPEG may have up to 13 million pixels (a 12 megapixel phone photo), because every signer's phone unpacks the whole picture to show its page, and a larger one is refused with its size and what to do. The API description says so. |
| On my phone held sideways, or with large text, the Adopt button was off the screen. | The end of the adopt dialog (a problem, the sentence agreed to, Cancel and Adopt and sign) is pinned to its bottom edge. Checked at 390 by 844, 844 by 390, 320 by 568 and 195 by 422 (a phone at 200 percent). Below 300 px the title of the document gets a line of its own and the bar at the bottom stacks. |
| The verify page called a file "authentic" when the sender had signed it for three of the four people. | `/verify` says "Unchanged since signing finished" and that this does not show who was behind each signature. "No match" lists its causes: changed, saved again by a viewer, printed or scanned, deleted long ago, never completed here. |
| The sender closed their account, and my untouched signed copy turned into "no match". | The SHA-256 of each completed signed PDF, its envelope ID and its day stay for a year after the account is deleted, and nothing else. `/verify` then says the file was completed here on that day and deleted since, and that it is disputed while a dispute about it is open. |
| All I have is a printed copy, and nothing to check it against. | The envelope ID at the foot of every page can be looked up on `/verify`: status, day, pages, signers, the fingerprint of the signed file to compare a file with, and whether it is disputed. Never a name or an address. The fingerprint is also in every completion email. |
| Nobody could tell whether the signed copy ever reached the other side, or was opened. | Audit lines for the completed copy handed to the mail server for each person, the first time each opens or downloads it (with internet address and browser), and later visits, once a day at most. |
| The sender's own copy of a voided agreement showed every signature and no sign that it was voided. | That copy, and the signer's, opens with a page that says why it was not completed and carries "VOIDED, NOT A SIGNED DOCUMENT" large across every page, again in small dark rows over the whole page (corners included, and kept by a black-and-white copier), at the top and the bottom, and over every signature. A copy downloaded while the envelope was still out says "NOT COMPLETED YET" the same way, because voiding it later cannot change that file. |
| Someone signed in my name, and there was no way to say so. | "I did not sign this, or this was not me" on the signing page and on `/check`, also after completion, and with the security code of any email we sent that person: also after the sender put another address under their name and signed, or someone passed it on through their link. The envelope is marked as disputed wherever it is shown, the sender is told when and what was written, word for word, the operators are told the same with the internet address and browser (the sender never gets those, and the screen says so before sending), and nothing is deleted: while it is open the sender cannot delete the envelope for good, and deleting the account keeps the envelope ID, the file's fingerprint, the day and the state, with no names, until a person at GrowSigning closes it. The help topic of that name is never passed to the sender, and its answer says exactly what we give out and to whom. |
| Our lawyer told us to keep our own evidence, and all we could download was the PDF. | "Download evidence pack": the signed PDF, the certificate alone, the audit trail as text and as data with everything needed to recompute its chain, every email we stored about it with what became of it, and the consent wording each person agreed to. |
| Our security team could not see who signed in or who changed what, and could not feed it to our own systems. | Settings, Security: who signed in or failed to, and who changed logins, the team, keys, webhooks, exports, deletions and settings, with the address and browser, ids only and never a secret. Lines cannot be changed and are kept `SECURITY_LOG_DAYS`. CSV, an API an admin key pages through, an opt-in webhook, and five alerts by email that a person can switch off. It says plainly that nobody watches it: the alerts are emails. |
| Nobody would explain what the lines of the certificate mean. | `/security/certificate` goes through every line: where it comes from, what it shows, what it does not. Dated, to attach to a letter. |
| A field hidden by a rule still blocked Finish as "required", and a total the browser added up could not be trusted. | "Only show when..." and "Calculate from..." on any field, each said back as a sentence ("Shown when 'Has a co-signer' is ticked"). The server works out what is shown and every total again from what is stored, on every save and at Finish: a hidden field is not required, keeps no answer and prints nothing, and a calculated value the browser sends is not taken. A loop is refused with the fields named, empty fields count as 0, dividing by 0 says so on screen, the result keeps the way its numbers are written (1.234,50) and is kept as a plain number too, so a total of 1,233 is never read back as 1233, and a changed rule needs the sign-again choice once someone has finished (`src/lib/logic.ts`, `src/server/logic.ts`). |
| A signer saw one total and another was signed under their name, because a co-signer finished in between. | Finish carries a key for the other people's answers the screen counted. If someone finished since, nothing is signed: the page says who finished, shows the new total and any field that comes with it, and the person finishes after looking (`formulaInputs` in `src/server/logic.ts`). |

## What is in it

**Sending**
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
  says "Converted from Contract.docx. Check every page: the PDF is what people sign, and conversion can move text.",
  and also when the file has tracked changes or comments (Word, OpenDocument text, RTF), is a spreadsheet ("A sheet
  may be split across pages."), points at pictures or files outside itself (Word, Excel, PowerPoint, OpenDocument,
  RTF and HTML; a web link someone can click does not count) or has macros, which are never run. The original is
  kept with the PDF as a stored file (encrypted when `FILE_ENCRYPTION_KEY` is set), the audit trail says "Converted
  from Contract.docx (SHA-256 ...) to PDF by LibreOffice 24.2.7.2" when the envelope is sent or a correction puts the
  document on it, the evidence pack carries it under `originals/`, and it is deleted with the account. A ZIP-based
  file that unpacks to more than 100 MB or 20 times its own size is refused before anything opens it, and so is a
  file protected with a password. A file a signer attaches is never converted. Without a converter these files are
  refused with a sentence that names the kinds that need one. Rules in `src/server/convert.ts`, words in
  `src/lib/convert.ts`, tests in `tests/convert.test.ts`.
- Recipients who sign, approve, only view, get a copy, or sign in person on your device. Signing in person needs an
  internet connection from opening the document to pressing Finish: there is no offline mode.
- Signing order (sequential, parallel or mixed) or everyone at once.
- A witness for one person who signs (the role `witness` with `witness_for`): asked straight after that person has
  signed, whatever the order, and holding nobody up; never charged; a block the editor places next to the signature
  (signature, name, address, occupation, date). The sender names the witness or leaves it to the signer
  (`named_by_signer`), who names them on the review screen before Finish. The witness first ticks their own statement
  that they were physically present and saw the signature, or says "I was not there", and the signer can then name
  the person who was. The certificate lists the witness under the signer with the statement, and marks a witness at
  the signer's address, under the signer's name, or in the signer's browser ("same device: yes or no"). A statement
  is set aside with the signature it saw. GrowSigning records what the witness states and cannot check it.
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
  Templates, copies, public forms, bulk send (a column named
  like a field fills it) and the API (`fields[].show_when`, `fields[].formula`) all carry them.
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
- A "Strike out" field: a line through printed wording (a cross over a box taller than a line), on the signing
  screen and in the signed PDF, written to the audit trail, and counted as wording by the sign-again rule.
- The sender sees who filled in everything but has not pressed Finish, and the reminder to that person says so.

**Signing**
- No account and no app needed. Works in the browser of a phone or computer from 2023 or later (iOS 16.4, Chrome,
  Edge and Firefox 111: the floor of Next.js; the PDF viewer is the legacy build of pdf.js, which runs there too). A
  browser that cannot show the document says so, with a download, a link to copy into another browser and a way to
  ask the sender. `/help` lists the browsers (`src/lib/mobile.ts`).
- Consent to electronic records before any field opens. The text says what kind of signature this is (a simple
  electronic one), that rules differ by country and by kind of document, and that some documents need more. It
  never says the signature equals a handwritten one. The wording has a version (`CONSENT_VERSION` in
  `src/lib/policy.ts`), the audit trail records which version each person agreed to, and `/help` prints the words.
- Guided "Next" through required fields, progress bar. Pages at 100, 150 or 200 percent. A tap on the pad is not
  taken as a signature. Finish without signal says nothing was signed and goes again by itself when the
  connection is back.
- Adopt a signature by typing (four handwriting styles for names in Latin letters, one plain style for other
  scripts), drawing or uploading. Saved signatures for account holders.
- Finish later, decline with a reason, assign to someone else, ask the sender a question (as a comment, below), fix
  a slip in the spelling of your own name (a bigger change is passed to the sender), ask for more time, stop
  reminders, report a request. View or print at any time.
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
  areas at the edge of a photo, the ruled lines of lined paper and sensor noise go; a design prints solid, as rubber
  does, while a photo keeps the unevenness of the real impression, with the cut set part by part so faint small print
  stays; the marks become one ink (blue, red, purple, black or green), the likely one found in the picture and chosen
  first, and in a photo marks in another colour (printed black text beside a blue stamp) are left out unless asked
  for, with the stroke filled in where text crossed it; a design in several colours keeps every mark, with a thin gap
  where two colours meet; a round seal photographed at a slant can be made round again. Then the texture of a
  hand-pressed rubber stamp, sized in millimetres at the size it prints so it still shows at 150 pixels on a screen:
  one side pressed harder, patches short of ink, paper grain, small voids, rough edges with a little ink spread,
  darker rims where ink squeezes to the edge of a stroke, and dull pad-ink colours that vary a little. The small
  natural tilt (between -4 and 4 degrees) is not drawn in: the page turns the picture when it prints it, so the stamp
  keeps the exact size of its field. All of it comes from a seed that is stored with the stamp, so the same settings
  give the same impression. A before and after on a page of text shows it while each step can be changed. It is
  stored as a transparent PNG (drawing it on a canvas leaves out the camera's notes), and on the signing page and in
  the signed PDF it is multiplied into the page at 97 percent, so the words under it show through and there is
  never a box around it. Admins keep up to 10 stamps under
  Settings, Stamps (a name, the picture, the ink, the seed and the real size, 40 mm across to start with); a
  stamp name typed by an account the checks apply to is checked like any other name. In the editor a Stamp field
  is either the sender's own stamp, part of the document from the start (a change after someone has signed needs
  the sign-again choice), or a signer's, who puts their own on when they sign from a picture, a photo or a saved
  stamp of their own account (only when signed in at the address the document went to, never on a device handed over
  in person). Changing or deleting a stamp never changes a document it is on. A stamp field is required or optional,
  Finish later keeps it, it is put on again when someone is asked to sign again, and it works in templates, bulk
  sends, public forms, signing groups and the text view. The audit trail says who put which stamp on which field and
  when, with the SHA-256 of the picture, the certificate lists it under that person, and the evidence pack and the
  export carry the pictures. A picture from a signing link is shown to nobody outside that envelope, one field holds
  one, and a link can put on 20 an hour. A stamp uses no signature. What it is, said wherever one is offered: a
  picture of a stamp that a person put on the document; GrowSigning does not check that they may use it, it is not a
  certified electronic seal, and it pays no stamp duty.

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
  signature (B-B, or B-T with a time-stamp service) that Acrobat and other readers check by themselves, a "Digital
  seal" line on the certificate saying what it is and is not, and `/verify` checking the seal of a dropped file next
  to the byte-for-byte answer, including a file someone saved more into after the seal. See "The digital seal of a
  completed PDF". An uploaded PDF that already carries signatures is said to lose them: the signed copy is made from
  the pages as they look.
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
- "Download evidence pack" on the envelope page (`GET /api/envelopes/:id/evidence`): the signed PDF, the certificate
  alone, the audit trail as text and as JSON with every chain value and how to recompute them, every stored email
  about it with its hand-off result (signing links and security codes taken out), the consent wording each person
  agreed to, the disputes with what each person wrote, and a README that says whether a person or an API key made it.
- `/security/certificate`: "How to read a GrowSigning certificate", every line it prints, where it comes from, what it
  shows and does not, dated (`CERTIFICATE_PAGE_VERSION` in `src/lib/evidence.ts`). A test fails when the certificate
  prints a line the page does not explain.
- Keeping closed envelopes for a set time (`src/server/records.ts`, the words in `src/lib/retention.ts`). Settings, Your
  data, for admins, off by default: keep closed envelopes (completed, voided, declined, expired) for 30 to 9,999 days
  counted from the day each closed, with an optional schedule name and code, and templates with a period of their
  own; then remove one of three levels: the documents (pages unless a template or another envelope uses the file,
  the signed PDF, copies from before a correction, signer attachments, stamp pictures, email attachments); also what
  people filled in (values, signature and initials pictures, comment words, decline and void reasons); also the
  personal details in the record (names, addresses, phone numbers, internet addresses and browsers replaced by
  "Removed on" and the day, the message, names in the subject, our email copies, the text and webhook logs). A save
  that would reach envelopes at once says how many first. The timer emails the sender and every admin once, 14 days
  before, one email each with the list; nothing goes sooner than 14 days after that email, a level raised after it
  applies from the next one, and switching the rule off calls off what was announced. On the envelope page: "Keep
  it" (sender or admin, a reason in the audit trail, one more period), "Purge now" (sender or admin, a level, 14 days,
  called off until then, then for good), and for admins "Put on legal hold" with a reason and a matter reference.
  An admin can hold a folder too: it covers what is in it, what is put in it later and what leaves it afterwards.
  While a hold is on, deleting for good, Purge now, the timer, closing the account (refused with the list of holds)
  and `purgeUser` are refused and each attempt is in the record; a member sees that it is held, not why. An admin
  lifts a hold with a reason; the people who run the server can lift one when a court order or their legal duty
  requires it, as two people (one asks, another confirms within 7 days, `POST /api/operator/holds/:id/lift`), and
  the admins are emailed. An open dispute also keeps an envelope from a purge. After a purge the envelope keeps its
  record: the audit trail with its chain values, the changed lines marked, so the page says "Some details were
  removed on <day>. The record can no longer be recomputed for those lines." instead of "Record was altered" (any
  other change still shows); the fingerprint of its signed PDF, so `/verify` by file and by ID says completed here
  and deleted since; recipients' links say the sender deleted it; downloads, the evidence pack and copies say why
  they are not there; the export lists it. Every rule change, keep, hold, lift, purge and refused attempt is in the
  account's retention record (never changed; CSV under Settings, Your data, with the fingerprint of each purged
  PDF), and in the security record. API: `GET`/`PUT /api/account/retention`, `POST`/`DELETE
  /api/envelopes/:id/hold`, `POST`/`DELETE /api/envelopes/:id/purge`, `POST /api/envelopes/:id/keep`, `GET
  /api/envelopes/:id/retention`, `POST /api/account/retention/holds`, `DELETE /api/account/retention/holds/:id`,
  `GET /api/account/retention/log`.

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
- "Ask for help" in the public header (in the menu on a phone), "Help" in the app's bar and menu and in the editor,
  and "Help" in Other actions on the signing page, where it never floats over Finish or the fields. A dialog
  (`src/components/HelpChat.tsx`): focus stays inside, Escape closes it, answers are read out a sentence at a time
  as they arrive, 44 px targets, reduced motion respected. Nothing on the page underneath is touched.
- Who answers: an AI model through any host that speaks the OpenAI chat API, from the settings, first match wins
  (`SUPPORT_CHAT_API_KEY` with `SUPPORT_CHAT_BASE_URL` and `SUPPORT_CHAT_MODEL`, then `MOONSHOT_API_KEY`, then
  `OPENROUTER_API_KEY`), by default Kimi K3, the open-weights model treegens.app uses. No temperature is sent
  (Kimi K3 refuses any but 1), little thinking is asked for, and asked once more without that after a refusal;
  1200 tokens, because thinking counts. Without a key, past a limit, or when the model is down, slow (55 seconds)
  or says nothing, the built-in answers reply (`src/server/chatkb.ts`), and the answer says which.
- What it knows: a system prompt built on the server from `src/lib/policy.ts` and `src/lib/impact.ts` (prices,
  the refund and price rules, cancelling, deadlines, limits, closing and what is kept, who can see documents, the
  consent wording, no BAA, the language note), every topic of `/help` and "What is not in it" below, both read
  from the help page's source and from this file while the server runs (`src/server/chatsources.ts`, so an edit
  reaches the next question; on a server that ships neither file the helper is told it does not have them and
  offers a person), and the built-in answers. It says it is an AI
  and can be wrong, that the rules on the pages count, gives no legal advice, never judges whether a signature is valid or enough for a
  document, never promises a refund, answers in the person's language and says the screens are English. An
  answer that still reads as saying a signature is valid, binding or enforceable or will hold up, or as promising a
  refund, gets a correcting line at its end (`src/server/chatguard.ts`), unless the words just before the claim
  take it back ("not", "whether"). It knows English and the common phrasings in French, German, Spanish,
  Portuguese and Italian, so it is a backstop, not a guarantee. Em dashes are taken out. An answer is cut at 8000
  characters, and a host that sends more is stopped there.
- What it sends: only the typed chat (the latest 12 messages, each cut to 1500 characters) and which kind of screen
  it is (`CHAT_SCREENS` in `src/lib/chat.ts`). Before a question leaves the browser, and again on the server,
  what looks like a card number (also with full stops between the groups), a private link, a code from our emails
  (also in small letters), a password (also a plain word after "my password is", or after a login written as
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
  is used (`SESSION_MAX_DAYS`, both in `src/lib/policy.ts`), whichever comes first, and signing in on another device signs nothing out. Settings, Profile lists where you are signed in and signs out one browser
  or all the others. Hosting a signing in person locks your account in that browser until you type your password.
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
- Settings, Security (owner and admins only): the account's security record. "A record of these events, kept for
  N days (`SECURITY_LOG_DAYS`, 400). Nobody watches it for you: the alerts are emails." One line each, with who
  (a person, an API key, the GrowSigning team or the server itself), when, the internet address and browser of a
  person or key, and what it was about by id: sign-ins that worked or failed (written to every account the person
  belongs to), signing out (one browser or everywhere else), password changed or reset, email address changed,
  two-step login on, off or reset, Google or Microsoft connected or removed, members invited, joined, removed,
  role changed or left, the owner handed over, API keys made or revoked, a key used from a new internet address
  (at most 50 such lines per key a day), webhooks added or removed, exports, envelopes taken out of the lists,
  deleted for good or put back, template rules, account settings (by name with the old and new value; the logo by
  name only), closing started or undone, and the GrowSigning team pausing, resuming or trusting the account. Never a
  password, token, code, key, email address or anything from a document. For a login with two-step login a wrong
  password and a wrong code are written as one reason, as the sign-in screen says them, so an admin of a team that
  person is on cannot use the record to find out whether a password was right. A line is never changed: a database
  trigger refuses it, and refuses deleting one before its days are over unless its account is deleted; each line
  carries the hash of the one before (per account), and the screen says when a line does not match. Newest first,
  filtered by kind, person and days, downloadable as CSV. A security system pulls it in order with an admin key
  (`GET /api/account/security-events?after=&limit=`, up to 1,000 a call), or gets each line as the webhook event
  `security.event`, which only a webhook that lists it receives. Outside the app people are named by id unless an
  admin switches on names and email addresses. Five alerts email the owner and admins, each at most once an hour
  and each switched off by a person signed in (never a key; the other admins are emailed when one is): 10 failed
  sign-ins in an hour for one person or from one address, an API key made, the owner handed over, everything
  exported, 20 envelopes or templates deleted in an hour. The admin's export carries the record as
  `security/security-events.csv`; deleting the account deletes it.

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

**Developers**
- JSON API for everything the app does, API keys, embedded signing links. Reference at `/developers`, and a
  machine-readable description at `/api/openapi.json`.
- API keys have a scope. A key does everyday work (envelopes, templates, files, contacts, bulk sends, reports)
  unless an admin creates it with the "admin" scope. No key can create or revoke keys, remove a member, hand over
  or close the account, or touch the plan and payments. Admins see every key in the account, never the secret.
- Webhooks with HMAC signatures, retries, a delivery log with paging, and redelivery of the latest 200 events of
  each webhook. Private network targets are refused, and a delivery connects to the address that was checked.
- Comments for a key of either scope: `GET` and `POST /api/envelopes/:id/comments` (every thread, and the sender's
  side of them) and `POST /api/envelopes/:id/comments/:thread/settle`; the `comment.created` webhook carries what
  was written (until the envelope is deleted: then the log keeps the delivery without the words and the name).

**Environment**
- Paper, water and CO2e saved shown on every envelope, on the certificate, in emails, in the dashboard, in
  reports, and as live public totals on `/impact`.
- Every number comes from `src/lib/impact.ts`, and the method is published on `/impact`.
- Payment ledger (from the payment provider's invoices) shown publicly as money sent to tree planting.

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
  PDF's text.

**Languages (the foundation; only English is switched on)**
- Catalogues of our own words as flat JSON, one file per language in `src/locales/<tag>.json`, with `en.json` as the
  source (keys like `settings.language.button`). `t(locale, key, vars)` in `src/lib/i18n.ts` fills in `{name}` and
  `{count, plural, one {# day} other {# days}}` with a small parser of our own and `Intl.PluralRules`; nothing in a
  catalogue is ever run as code. A text is looked for in the person's language, then without its region (pt-BR, pt),
  then in English; a missing or broken text shows the English one and never the key. `dir()` is right to left for
  Arabic, Hebrew, Persian and Urdu. No library, so it works in pages and on the server alike.
- `SUPPORTED_LOCALES` lists each language with two statuses: its screens and its legal texts (the consent, what kind
  of signature this is, the adopt line, witness statements, `STAMP_IS`, `CHECK_PROVES`), each `reviewed` by a person,
  a machine `draft`, or `missing`. English is the only one switched on. French, Amharic (in Ethiopic script) and
  Afaan Oromo are listed with nothing translated; a language is switched on in the code when a person has checked it.
- Which language a person sees: the one the sender set for them, else what their browser asks for among the languages
  switched on, else English (`src/server/locales.ts`). The signing page is told the language, its direction and who
  chose it (`language` in `GET /api/sign/:token`); `<html lang>` and `dir` come from the request.
- Legal texts are kept by version and by language beside their words in `src/lib/policy.ts`, never in a catalogue,
  so no translation tool can change them. A language whose legal texts no person has checked shows them in English
  with one sentence in the reader's language: "This part is in English because its translation has not yet been
  checked by a person." A machine translation of a legal text is never shown as the text. The audit line of each
  person's consent names the wording and the language of the words they were shown ("Wording 2026-11, in English
  (en), ..."), and the evidence pack prints those words in that language.
- The sender's side: `recipients[].locale` in the API (a language that is not switched on is refused with a 400 that
  names the ones that are), a Language choice per person in the editor under More, and the account's
  `default_locale` under Settings, Account, which new recipients start with. Templates and copies keep it, a bulk
  list may have a "language" column (a code or a name; one we do not have is left out with a note on that row), and a
  public form takes the visitor's browser language. While English is the only language there is nothing to choose,
  so the editor shows no choice and Settings says so in one sentence. The sender's own subject, message, notes and
  documents are never translated.
- Dates and numbers on a screen go through `Intl` with the reader's language (`dateOnScreen`, `momentOnScreen` in
  `src/lib/dates.ts`, `numberOnScreen` in `src/lib/numbers.ts`), in one place, so another calendar (the Ethiopian one
  is `ethiopic`) can be asked for there. English reads exactly as before, and the signed PDF prints what it printed.
- For translators: `npm run i18n:check` checks every catalogue against `en.json`. Every English key has to be in
  each catalogue, translated or marked missing with `""` (shown in English); no key may be left over; the
  placeholders must be the ones in English; no HTML, entities or links; and it warns when a button's text is more
  than 40 percent longer than in English. It exits with 1 on an error, so it can run in CI. The files are in the
  format Weblate calls "JSON file" (flat, monolingual): add the project with `src/locales/en.json` as the
  monolingual base file and `src/locales/*.json` as the file mask, use the "ICU MessageFormat" check, and run
  `npm run i18n:check` on what Weblate commits. Legal texts are not in these files: a person who can answer for
  them checks each language in `src/lib/policy.ts`.

## What is not in it

Being straight about this: the market-leading e-signature products are large suites, and this covers the core
e-signature product, not all of it. Not built:

- **Certificate-based signatures of the people who sign.** A completed PDF can carry a digital seal of the server
  (see "The digital seal of a completed PDF"), but the people who sign do not sign with certificates of their own.
  Without a seal set up, integrity comes from the stored SHA-256 fingerprint, the hash-chained audit trail and
  `/verify` alone. These are standard electronic signatures with an audit trail, not "advanced" or "qualified"
  signatures under eIDAS. Have a lawyer confirm they fit your use and jurisdiction before relying on them for
  high-stakes documents. Not built around the seal: long-term validation (B-LT and B-LTA: revocation data and a
  document time-stamp so the seal can be checked after its certificate expires), PDF/A, an organisation's own seal,
  keys in an HSM or a cloud KMS, an outbound allowlist for the time-stamp request (its address is an operator
  setting, never a user's), and keeping signatures that an uploaded PDF already carries.
- **A security monitoring service.** The security record (Settings, Security) is a record and five email alerts.
  Nobody watches it, there is no detection of unusual behaviour beyond those five counts, and nothing is pushed to
  syslog or a log platform by us: a security system pulls it with an admin key or takes the `security.event`
  webhook. Not built from the government brief (G12): delivery over syslog with TLS and over HTTPS batches with a
  retry queue, the envelope audit trail as a second stream, an OCSF mapping, a daily export of the chain head,
  alerts on a new country (that needs a location database we do not ship) and on sends far above an account's own
  pattern, retention set per account (an admin who could shorten it could wipe the record of what they did), events
  of the server itself that belong to no account, and lines for a rate limit that was hit. Google or Microsoft
  sign-ins that fail at the provider are not written, because they name no login of ours.
- **Records management beyond the retention rule.** There is one schedule per account and one per template, not per
  document type, folder or tag; the end of a period purges (no "review" queue and no "transfer to archive"); there
  is no archive export in BagIt layout, no records officer role, and the certificate of destruction is the CSV of
  the retention record, not a PDF. Holds are placed on one envelope or one folder, not by search, person or dates.
  A hold is a rule of this software: it does not reach the database, the disk or the backups of the people who run
  the server, so held documents are not kept out of backup rotation unless they arrange it.
- **Electronic seals.** A company stamp here is a picture of a stamp that a person puts on the page (see
  "Signing"). Nothing checks that they may use it, and it is not an electronic seal backed by a certificate (an
  "advanced" or "qualified" seal under eIDAS). It pays no stamp duty and is not an e-stamp certificate or an
  e-meterai. The digital seal of a completed PDF is the server's, not a company's.
- Languages other than English. The signing screen and our emails are in English for now. Your document can be in
  any language. (The sentence the pages print is `LANGUAGE_NOTE` in `src/lib/policy.ts`.) The foundation is built
  (see "Languages" above), but no screen and no email has been moved into the catalogue or translated yet, the
  editor's "changed" check does not count a change of language alone, a signer cannot switch language on the page,
  the certificate is English only, and there is no `LANGUAGES_ENABLED` setting: a language is switched on in
  `SUPPORTED_LOCALES`. Nothing calls a translation service.
- ID verification (government ID, knowledge-based checks) and checks by phone call. A one-time code by email or by
  text message is in (see "Checking who signs"); it shows that someone can read a mailbox or holds a phone, not who
  they are. Text messages only exist on a server whose operator has set a provider up.
- Remote online notarisation. Payments are not collected: a trusted account can
  show a link to its own payment page after Finish (see "Reuse and scale"), and the money never passes through here.
- A HIPAA business associate agreement, at any price. US healthcare providers must not put patient information
  through it (`NO_BAA_TEXT` in `src/lib/policy.ts`).
- Google Docs and cloud drives: download a Google Doc as Word or PDF first. Word and other office files are turned
  into PDF only on a server with a converter, and the PDF can differ from what the program shows (fonts that are
  not installed, page breaks, a sheet split across pages): the PDF is the record, so check it. Tracked changes and
  outside links are not looked for in the old binary .doc, .xls and .ppt formats. Documents cannot be edited here,
  and HEIC photos are not taken (phones hand over a JPEG when a photo is chosen).
- Contract lifecycle management, AI contract analysis, document generation.
- Single sign-on for a whole organization (SAML, or making a team sign in one way), native mobile apps. Signing in
  with Google or Microsoft is in, and so is two-step login with an authenticator app (see "Two-step login"). Codes by
  text message, passkeys and security keys for signing in are not.
- Signing without a connection. Opening the document and Finish need one; a connection that drops in between is
  fine, and Finish goes again by itself when it is back.
- Ready-made integrations (Salesforce, Google Drive and so on). The API and webhooks are the way in for now.
- A security certification, and encryption of the database by the app itself. The app encrypts the stored files
  when `FILE_ENCRYPTION_KEY` is set (see "Encrypting stored files"), and with them the text read from uploaded PDFs
  for search, never the rest of the database, so encrypt the disk as well. `/security` says so plainly and lists
  what the database holds.
- Staffed support. The software gives everyone a way to reach a person, gives those people a queue, publishes a
  response time and says so when it is missed. Someone still has to read the queue and answer in time.
- Replying to a support email. Answers are written and read on the request's own page (the link in every email),
  not by replying to the email, and the emails say so.
- A dark-mode email header. Every email has a light header, so `public/brand/email-logo-dark.png` is not used. A mail
  program that darkens a light email by itself (Gmail on a phone does) shows our logo dim on its dark ground.
- Keeping the stamp clear of a document's own words. It sits 8 to 22 points above the bottom left corner of every
  page of a signed copy, in muted ink and without a background, so anything printed in that corner stays readable
  under it but can touch it.
- A helper that acts. The help chat answers and points to the tools that do things (see "The help chat"); it cannot
  see or change a document, an account or a payment, never says whether a signature is enough or valid, and can be
  wrong: the rules on the pages are what count. It answers in the person's language, while the screens stay English.

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
| `APP_URL` | Public address of the app, for example `https://sign.example.com`. **Required on a real deployment:** every link in every email is built from it. The address of a request is never used for a real host, because a request header can be forged. Without `APP_URL` the app logs a warning and links only work on your own machine. It is also the address of link previews (`og:image`) and of the GrowSigning logo in emails that have no sender's logo (`/brand/email-logo.png`; until the app is public, mail programs show the words instead). | `http://localhost:3000`, or the localhost address you opened the app on |
| `TRUSTED_PROXY_HOPS` | How many proxies of your own sit in front of the app (load balancer, CDN, the platform's router). The caller's address, used for rate limits and the audit trail, is read that many places from the right of `X-Forwarded-For`; anything further left is whatever the caller typed. `0` means nothing is in front: the header is ignored and every visitor shares one set of rate limits. The limit on one-time codes per caller address (see "Checking who signs") is not counted at all then, and with `1` on a server that has no proxy in front a caller can name any address; the limits per recipient and per mailbox or number hold either way. | `1` |
| `DATA_DIR` | Where the database and files live. Must be a persistent disk. | `./data` |
| `APP_SECRET` | Secret for access-code cookies and stop links. | generated and kept in `DATA_DIR` |
| `FILE_ENCRYPTION_KEY` | Encrypts every file the app stores from now on (uploaded documents, signed PDFs, attachments) with AES-256-GCM. 32 random bytes as base64: make one with `openssl rand -base64 32`, and keep a copy apart from the server and its backups. The text read from uploaded PDFs for search is encrypted with it too; the rest of the database is not. See "Encrypting stored files" for what it protects and what it does not, how to encrypt the files stored before, and what happens when the key does not fit the files. Set to something that is not a key, the server stores no file at all until it is corrected. | off: files are stored as they are |
| `FILE_ENCRYPTION_KEYS_OLD` | Earlier keys, separated by commas, so files written with them can still be read after the key was changed. `node scripts/encrypt-files.mjs` moves those files to the current key. | none |
| `SEAL_P12`, `SEAL_P12_PASSWORD` | Seals every PDF completed from then on with an invisible PAdES signature of whoever runs the server (see "The digital seal of a completed PDF"): the path to a .p12 or .pfx file holding the seal key and its certificates, and its password. RSA of 2048 bits or more, or ECDSA P-256. | none: no seal, files as before |
| `SEAL_KEY_PEM`, `SEAL_CERT_PEM`, `SEAL_CHAIN_PEM` | The same key as PEM: the private key (not encrypted), the seal certificate, and the certificates that issued it. Each a path or the PEM text itself. Set these or `SEAL_P12`, not both. | none |
| `TSA_URL` | An RFC 3161 time-stamp service, so the seal carries its time (PAdES B-T) and not only the server's clock (B-B). Several, separated by commas, are tried in order, 10 seconds each. `TSA_URLS` is read the same way. | none: B-B |
| `TSA_USER`, `TSA_PASSWORD` | HTTP Basic credentials for the time-stamp service, when it asks for them. | none |
| `TSA_TRUST` | A PEM file of the certificates the time-stamp service's own certificate must lead to. A time-stamp that does not is not used. | none: the time-stamp's signature, purpose and time are checked, not who issued its certificate |
| `SMTP_URL`, `MAIL_FROM` | Mail server, for example `smtps://user:pass@smtp.example.com`. Without it nothing is delivered, and the audit trail of an envelope says "Not emailed" instead of "Sent to recipient". An email the mail server will not take is kept and tried again by the timer (see `CRON_SECRET`): after 5 minutes, 30 minutes, 2 hours, 6 hours and a day, six tries in all. The envelope page and the audit trail say how it goes, and after the last try the sender is told. A mail server that stops answering is given up on after 10 seconds to connect, 10 for its greeting and 20 of silence (that try counts as failed); add `?connectionTimeout=&greetingTimeout=&socketTimeout=` in milliseconds to the address to change it. Emails about money are written down inside the account's billing step and handed to the mail server after it, a few at a time, so a slow mail server never holds up Cancel, a refund or a message from the payment provider; one that was never handed over (the server stopped) is sent by the timer. | none |
| `MAIL_EVENTS_TOKEN` | A secret of at least 16 characters (`openssl rand -hex 24`; one with `+` in it also works pasted into the address as it is) that lets your mail provider tell this server what became of an email after it took it: delivered, bounced, marked as spam. Give the provider the address `https://<your domain>/api/mail/events?token=<the secret>` (or the secret as HTTP Basic password or `Authorization: Bearer`). See "Knowing when an email did not arrive". Without it the address answers 404 and nothing in the product mentions bounces. | none |
| `CRON_SECRET` | Lets a scheduler call `POST /api/cron`. Call it at least once an hour: it sends signer reminders and renewal reminders, expires signatures whose date has passed (with a line in the plan history) and emails top-ups that expire in 30 days or in 3 days while some are unused, tries emails again that the mail server would not take (so the gaps between tries are never shorter than the gap between calls), expires envelopes, retries refunds and cancellations the payment provider could not take the first time, closes accounts, and tells the operators and the customer when a help request has passed its response time. A renewal that is charged with no reminder on record raises an alert. | none |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GROVE`, `STRIPE_WEBHOOK_SECRET` | Turns on paying. Without them nothing is counted and there is nothing to buy. `STRIPE_PRICE_GROVE` is the monthly price. Point a Stripe webhook at `/api/stripe/webhook` and send it these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.upcoming`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`. | none |
| `STRIPE_COLLECT_TAX_ID` | Set to `1` and the payment page asks business buyers for their tax number (VAT, GST and the like) and billing address, and the provider prints both on the invoice. Put your own legal name, address and tax number on invoices in the provider's settings. Off by default: the provider refuses the request unless its settings allow it, so switch it on in test mode first and make one payment. Not tried against the real provider. | off |
| `STRIPE_WEBHOOK_WAIT_MS` | How long a message from the payment provider is worked on before it is answered. The provider counts a late answer as a failure, so a message that takes longer (the provider or the mail server is slow) is answered "received", kept in an inbox table and finished in the background; the timer applies anything left over after a restart or a failure. | `5000` |
| `STRIPE_API_VERSION` | Pins the version of the payment provider's API that calls are made with, for example the one shown in your Stripe dashboard when you tested. Set the webhook endpoint to the same version. Unset, the account's default version is used (both the older and the newer shapes of invoices, subscriptions and their tax lines are read), and a production server logs a loud warning once, because that default can change under a running server. | account default |
| `ACCEPT_DISPUTES_UP_TO_USD` | A card dispute always stops billing, takes the signatures the disputed payment bought off the balance (also ones held for envelopes that are out), switches new payments off until a person has looked (the operator page has the button to switch them back on), and tells the customer in writing. Disputes up to this amount are also accepted with the payment provider automatically instead of being fought; larger ones are left for a person to decide, and if the bank then lets the payment stand the signatures come back by themselves. `0` (or `ACCEPT_DISPUTES=0`) leaves every dispute to a person. | `25` |
| `SUPPORT_EMAIL` | The address people can write to. It is shown on `/help`, is told about every new help request and every late one (the answer is written in the operator queue, not by replying to that email; without this address those emails go to `OPERATOR_EMAILS`), and gets the alerts that need a person: a payment nobody could be matched to, a refund that keeps failing, a card dispute. Those alerts also go to `OPERATOR_EMAILS` and are kept in the operator queue. Set at least one of the two: with neither, nobody can open the queue and an alert is only a loud line in the server log. When set, the address is also printed in the footer of every public page and in the app's menu. A production server that starts without it logs a loud warning, because the pages promise that a person answers. | none |
| `ABUSE_EMAIL` | Where reports of suspicious documents go, and disputes ("I did not sign this"), which also go to `OPERATOR_EMAILS` and into the operator queue. | `SUPPORT_EMAIL` |
| `OPERATOR_EMAILS` | Comma-separated addresses of the people who run the service. Once their email is confirmed they can open `/app/operator`: help requests, reports, pausing or unpausing an account, and marking an account as trusted. They are the people a help request can be taken by or handed to, and they are emailed when one is late. They get every dispute with the internet address and browser it came from, and close it (closing its alert in the queue, or `POST /api/operator/disputes/:id`); until then its envelope cannot be deleted for good. | nobody |
| `SUPPORT_FIRST_REPLY_HOURS` | The published response time: a person answers a help request within this many hours of the message, counted in real hours (nights and weekends included). `/help`, the confirmation email and the request itself quote the actual time. Promised only while `SUPPORT_EMAIL` or `OPERATOR_EMAILS` is set. | `24` |
| `SUPPORT_URGENT_REPLY_HOURS` | The same for urgent requests: cannot log in, charged wrongly, a stuck document or a near deadline. Never longer than `SUPPORT_FIRST_REPLY_HOURS`. | `8` |
| `SUPPORT_CHAT_API_KEY`, `SUPPORT_CHAT_BASE_URL`, `SUPPORT_CHAT_MODEL` | Switches on an AI model for the help chat, through any host that speaks the OpenAI chat API: the key, the address of the API (https only; plain http only to this machine itself, for a model run locally) and the model. First of the three ways to set a model up; see "The help chat". What people type into the chat then goes to that host, and `/security` lists it under "Where your data is". Without any key the chat answers from the built-in answers and nothing leaves the server. | none; `https://openrouter.ai/api/v1` and `moonshotai/kimi-k3-20260715` when only the key is set |
| `MOONSHOT_API_KEY` | The same through Moonshot AI's own API (`https://api.moonshot.ai/v1`, model `kimi-k3`, or `SUPPORT_CHAT_MODEL`). Used when `SUPPORT_CHAT_API_KEY` is not set. | none |
| `OPENROUTER_API_KEY` | The same through OpenRouter (model `moonshotai/kimi-k3-20260715`, or `SUPPORT_CHAT_MODEL`). Used when neither of the two above is set. | none |
| `SUPPORT_CHAT_DAILY_LIMIT` | How many questions the model answers for everyone on this server in a day (UTC). Past it, until midnight UTC, the built-in answers reply and people are told so, and the server log says it once. `0` sends nothing to the model. The limits per internet address, signing link and account are in `src/lib/chat.ts`. | `2000` |
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
| `SECURITY_LOG_DAYS` | How many days a line of an account's security record (Settings, Security) is kept, a whole number from 1 to 3650. The same for every account on the server, so an admin cannot shorten it to wipe what they did. The timer deletes older lines; until then a database trigger refuses to change or delete a line, unless its account is deleted. Settings, Security, the API and the export quote the number. | `400` |
| `UNOPENED_ALERT_HOURS` | How long a request sits unopened before the sender is told. | `48` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Switches on "Continue with Google" on the sign-in and sign-up pages and under Settings. Both must be set. With either missing, nothing about Google is shown anywhere and its routes answer 404. Register the redirect address `APP_URL` + `/api/auth/google/callback` with Google (see below). | none |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The same for "Continue with Microsoft". Redirect address: `APP_URL` + `/api/auth/microsoft/callback`. | none |
| `MICROSOFT_TENANT` | Who may sign in with Microsoft: `common` (work, school and personal accounts), `organizations` (work and school), `consumers` (personal), or the id of one organization (the "Directory (tenant) ID", a value like `11111111-2222-3333-4444-555555555555`). A domain name is not accepted: Microsoft sign-in then stays off and the server log says why. | `common` |
| `OPERATOR_NAME` | Who runs this server: legal name and country. Printed on `/security` ("Where your data is") and on the data processing summary (`/security/processing`), which says that a signed data processing agreement is between the customer and this party. Empty: the pages say "The operator of this server has not said who they are. Ask them." | not stated |
| `DATA_REGION`, `DATA_HOST` | Where the server and its files are (for example `Frankfurt, Germany`) and the hosting company. Plain text, printed as written. Empty: "The operator of this server has not said where it is hosted. Ask them." There is one region for everything, because storage is one disk. | not stated |
| `DATA_BACKUPS` | One sentence on whether and where backups are kept and for how long. Empty: the pages say that this was not stated. It is also quoted where a purge says what stays (Settings, the email 14 days before, the envelope page, `/security/processing`). | not stated |
| `MAIL_PROVIDER_NAME`, `MAIL_PROVIDER_COUNTRY` | The company behind `SMTP_URL` and the country it handles email in. Listed among "who else handles data" only when `SMTP_URL` is set. | not stated |
| `PAYMENT_PROVIDER_COUNTRY` | The country of the Stripe company the payment account is with. Stripe is listed only when `STRIPE_SECRET_KEY` is set. | not stated |
| `SMS_PROVIDER_NAME`, `SMS_PROVIDER_COUNTRY` | The text message provider and where it handles messages. Listed only when text messages are switched on. The name is known without this setting when the provider is Twilio. | not stated |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | Switches text messages on, sent through Twilio with `fetch` (no SDK). The account id and the token are both needed, and one of a sending number in international form or a messaging service (which wins when both are set). With one of them missing text messages stay off and the server log says which. See "Checking who signs". | none |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | Switches text messages on through any other provider: every text is one `POST` to the address with the JSON body `{"to", "text"}` and `Authorization: Bearer <token>`. Answer 2xx when the text was taken. Answer 400 or 422 when the number can never be texted, which is final (so is any other 4xx except 401, 403, 404, 408, 409, 425 and 429). Anything else, and no answer within 15 seconds, is tried again by the timer like an email. Twilio wins when both are set up. | none |
| `SMS_DAILY_PER_ACCOUNT` | The most text messages one account can cause in 24 hours: one-time codes, signing links and reminders, every new one counted, also a code that is asked for again. A hard stop, because a text costs the operator money and customers are not charged for it. The refusal says when there is room again. `0` lets none through. | `200` |
| `SMS_DEV_OUTBOX=1` | Development only: text messages are switched on without a provider and are only written to `/dev/outbox`. Ignored on a production server unless `DEV_OUTBOX=1` is set too, because nobody receives anything. | off |
| `ALLOW_PRIVATE_WEBHOOKS=1` | Accepts webhook addresses that are not public https. Local development only. | off |
| `DEV_OUTBOX=1` | Shows the outbox in a production build. Never set this on a public server: it exposes every signing link. | off |
| `CONVERTER` | `soffice`: Word, Excel, PowerPoint, OpenDocument, RTF, text, HTML and TIFF uploads are turned into PDF by LibreOffice on this machine (`soffice` on the `PATH`; Debian and Ubuntu: `apt install libreoffice-writer libreoffice-calc libreoffice-impress`). `gotenberg` (or leave it empty and set `CONVERTER_URL`): by a Gotenberg service. Anything else, or nothing: those files are refused, saying that a converter is needed, and nothing offers them. Read "Turning office files into PDF" first: the converter must have no network. (`stub` is for the tests and is ignored on a production server.) | off |
| `CONVERTER_URL` | The address of a Gotenberg service (MIT licence, `gotenberg/gotenberg:8`) inside your own network, for example `http://gotenberg:3000`. Files go to its `/forms/libreoffice/convert` in the clear, so keep it on a private network. | none |
| `CONVERT_TIMEOUT_MS` | How long one conversion may take before it is stopped (with LibreOffice here, its whole process group is killed). The sender is told that it took too long and nothing is saved. 1000 to 600000. | `60000` |
| `CONVERT_MAX_JOBS` | How many conversions run at the same moment; the rest wait their turn (up to ten times this many, then a polite 503). One account converts at most 2 files at once and 60 an hour. LibreOffice takes a few hundred MB of memory per job. 1 to 32. | `2` |

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
and 24 hours, every new text counted (`sms_usage`), and deleting an envelope hands nothing back.

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

### Two-step login

Nothing to configure. Anyone can switch it on under Settings, Profile: the standard time-based codes (RFC 6238: 6
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
  code. When it takes effect every browser is signed out. "Allow a reset by email" under Settings, Profile (on by
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

- **The converter must have no network.** A document can point at pictures and files on other servers, and an
  office program may fetch them while it opens the file: that tells their owner when and from where the document was
  opened, and can reach servers inside your own network. With `CONVERTER=soffice`, every job runs under
  `unshare -rn` (a network namespace of its own with nothing in it) where that works, which needs nothing but
  unprivileged user namespaces in the kernel; the first job checks, and when it does not work the server log says
  so loudly and LibreOffice runs with the server's network. Then block it yourself, in one of these ways:
  run the whole app as a user whose outbound traffic is dropped except for what the app needs (mail, payments), or
  put a wrapper called `soffice` first on the `PATH` that starts the real one without a network
  (`exec unshare -rn /usr/bin/soffice "$@"`, or the same with `firejail --net=none`), or use Gotenberg in a
  container on a network with no way out (Docker: `docker network create --internal convert`, then run
  `gotenberg/gotenberg:8` on that network only, and give this app a second network to reach it). Gotenberg itself
  does not block a document's outside links.
- **Each LibreOffice job** gets a fresh profile folder (`-env:UserInstallation`) with macros switched off and links
  from untrusted documents blocked, only `PATH`, `HOME`, `TMPDIR` and the language from this server's environment
  (none of its secrets), its own process group, which is killed whole after `CONVERT_TIMEOUT_MS`, and a temporary
  folder under the system's temporary directory that is removed when it ends (a folder left by a server that was
  stopped mid-job is removed by the first job after the restart, once it is an hour old). At most `CONVERT_MAX_JOBS` run at once. The file is in that folder in the
  clear while the job runs, also when `FILE_ENCRYPTION_KEY` is set; with Gotenberg it travels to the service in the
  clear. Keep LibreOffice up to date: opening a document is what its security fixes are about.
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
- **The text read from uploaded PDFs** (kept for search and for the check before sending) is encrypted with the same
  key, in the database (`src/server/searchtext.ts`). A search opens it in memory, for the one account that searches.
  Text kept before the key was set is encrypted when the server starts with the key, and text under an old key moves
  to the current one at the same start.
- **What is not protected.** The database (`DATA_DIR/sign.db`) is not encrypted by the app. It holds the names, email
  addresses and phone numbers of everyone on a document, the subjects and messages of envelopes and the names of
  documents and folders, what people typed into fields, signatures as pictures, comments, the stored copies of
  emails and texts, click-to-agree terms written as text, contacts, help requests, payments and every audit trail.
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
the file in Acrobat or another reader that checks signatures and see that not a byte has changed since it was
sealed, and which certificate sealed it, without asking us. It is not a signature of the people who signed: it does
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
  that was valid at that time, and with `TSA_TRUST` issued under one of those certificates. When no service gives one,
  the file is drawn again and sealed at B-B at once, and its certificate says the time is the server's clock. The
  signed PDF is never held back for a time-stamp: everyone's completion email carries the file and its fingerprint.
- The key is read once and checked every time it is used: RSA of 2048 bits or more or ECDSA P-256, belonging to the
  certificate, a certificate within its dates whose key usage allows digitalSignature or nonRepudiation, and the
  certificate that issued it given. Otherwise sealing stops, PDFs are made exactly as without a seal, each envelope's
  audit trail says "Not sealed", and the operator queue (and `SUPPORT_EMAIL`, `OPERATOR_EMAILS`) is told once. The
  key sits behind a signer interface (`SealSigner` in `sealcms.ts`: `chain()` and `sign(digest)`), so a cloud KMS or an
  HSM can take its place without the key on disk; neither is built.
- A .p12 file is read by our own code (`p12.ts`): PBES2 with AES or triple DES, and the old PKCS#12 schemes with
  triple DES and RC2 that older software wrote. Its password is checked with the file's MAC.
- Files completed before the seal was set up are never sealed afterwards: their fingerprint is in emails people
  hold. Copies of voided, declined or expired envelopes are not sealed and say so on their first page.

What to buy: Acrobat calls a seal valid only when its certificate comes from an authority on the Adobe Approved
Trust List or an EU trusted list. With any other certificate (a company CA, a self-signed one) Acrobat says
"validity unknown": that is about the certificate, and the panel still shows whether the file changed. Check a file
by hand with `pdfsig file.pdf` (poppler) or in Acrobat's signature panel.

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
    that this is acceptable, or decide to let a month run until its renewal payment is applied.
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
- **Storage** is SQLite on one disk, which is fine for one server. Back the `DATA_DIR` folder up. Moving to
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
tests         API tests and the browser test
```
