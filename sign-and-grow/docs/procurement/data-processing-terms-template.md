# Data processing terms: a template for a lawyer

**Template for a lawyer. Not legal advice. Not a contract until signed.**

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not a contract. Nothing here binds anyone until a lawyer has turned it into terms and both sides have signed
  them.
- It is not legal advice, and it does not say which law applies to you or what that law requires. Whether you need
  such terms at all, and what they must say, is for your lawyer.
- It is not an offer by the authors of the software. The terms are between the customer and whoever runs the server
  (the operator). The authors are not a party.

How to use it: each clause has a note under it. **Made true by the software** names the code that does what the
clause says, so the operator can sign it knowing the software keeps it. **A promise only** means nothing in the
software does it: the operator must do it, or leave the clause out. Words in square brackets are for the parties to
fill in. Delete the notes before signing.

The live list of who else handles data on a given server is at `/security/subprocessors`, made from the settings
that server runs on (`src/lib/dataplace.ts`). The fuller description is at `/security/processing`.

## 1. Parties and roles

The customer, [name], decides which documents are processed and for whom (the controller). The operator, [name,
country], processes them on the customer's behalf with the GrowSigning software (the processor).

> A promise only. The software cannot tell who is a controller. `OPERATOR_NAME` prints the operator's name on
> `/security` and `/security/processing` (`src/lib/dataplace.ts`).

## 2. Purposes: the complete list

The operator processes personal data only to:

1. store the customer's documents and templates and show them to the customer's own users;
2. send documents to the people the customer names, by email and, where the customer asks, by text message;
3. record each step of signing in an audit trail and put a certificate of completion on the signed PDF;
4. let the people a document was sent to open, fill in, sign, decline and download it;
5. sign people in, keep them signed in, and keep a security record of sign-ins and changes;
6. take payments, where the customer pays through the software;
7. answer help requests, and the help chat where it is switched on (see clause 4);
8. keep and delete data as clause 7 says;
9. make backups and restore them.

> Made true by the software: these are the features the software has. There is no feature that processes data for
> any other purpose. Check the list against the README, "What is in it".

## 3. No other use

The operator does not use the customer's personal data or documents for analytics, advertising, profiling, product
improvement, or the training of any AI model, and does not sell or share them.

> Made true by the software, for the software itself: it has no analytics, advertising or error-reporting service
> and nothing that sends data to its makers (`NOT_BUILT` in `src/lib/outside.ts`). It sends no document to an AI
> service (`src/lib/chatprovider.ts`). A promise only for anything the operator does outside the software. See
> clause 4 for the help chat.

## 4. Sub-processors

The operator uses only the sub-processors on the list at `/security/subprocessors` of the server named in
[schedule 1], with the country each handles data in. The operator tells the customer [ ] days before adding or
replacing one, and the customer may object within [ ] days.

> Made true by the software: the list is made from the settings the server runs on. A provider appears because its
> switch is on, and what the operator has not stated (who the company is, which country) is printed as not stated
> (`src/lib/dataplace.ts`). The software does not notify anyone of a change: the notice is a promise only.
>
> The help chat. When an AI model answers the help chat, what people type into it goes to that model's provider,
> whose own terms decide what it keeps and whether it trains on it. The software does not control those terms and
> does not set any provider option that limits retention. It does take out what looks like card numbers, links,
> codes, passwords and email addresses first, and never sends a document (`CHAT_SENT` in
> `src/lib/chatprovider.ts`). For a customer who receives these terms, the operator should do one of these: switch
> AI answers off under Settings, Account; run a model inside its own boundary (`SUPPORT_CHAT_API_KEY` with
> `SUPPORT_CHAT_BASE_URL`; with `DEPLOYMENT_PROFILE=government` the hosted routes are never used); or list the
> provider here and check that its terms fit clause 3. Without one of these, clause 3 is not true for the chat.

## 5. Security

The operator keeps the measures in [schedule 2].

> Write schedule 2 from `docs/procurement/security-whitepaper.md` and `docs/controls.md`, and only from the rows the
> operator actually runs. What the software does is listed there with its file. What the operator must do (TLS,
> disk encryption, backups, access to the server) is a promise only.

## 6. Confidentiality of staff

The operator lets only staff who need it reach the server and its settings, under a duty of confidentiality.

> A promise only. The software has no hidden administrator and no remote access for its authors, but whoever has
> the server or its settings reads everything (`docs/controls.md`, 8.2 to 8.4).

## 7. Keeping and deleting

The operator keeps the customer's data while the customer's account exists, deletes it as the customer's deletion
schedule says, and deletes all of it within [ ] days after the account is closed, except what clause 7.2 lists.

7.2 What stays: the record of a signed document with its fingerprint where the customer chose that; copies the
people a document was sent to already have; and backups until the operator's backup cycle ends, which is [ ] days.

> Made true by the software: the deletion schedule, legal holds and deleting one document (`src/server/records.ts`),
> closing an account with a grace period of `CLOSE_GRACE_DAYS` days and then deleting it (`src/server/routes-trust.ts`,
> `src/lib/policy.ts`). What stays after each is
> listed on `/security/processing`. Deleting does not reach backups: the backup cycle is a promise only, and
> `DATA_BACKUPS` prints the operator's own words for it.

## 8. Giving data back

On request, and at the end, the operator lets the customer take their data in the form of the software's export.

> Made true by the software: Settings, Records and data, Export everything, a ZIP of every signed PDF, every audit
> trail and a list of all envelopes, free on every plan and after cancelling (`src/server/routes-trust.ts`). What it
> does not hold is in `docs/procurement/exit-plan.md`.

## 9. Help with the rights of the people in the documents

The operator helps the customer answer requests from people to see, correct or delete their data, within [ ] days.

> Partly made true by the software: an export per account, deleting documents and accounts. There is no search
> across accounts for one person and no tool that answers such a request by itself. The help is a promise only.

## 10. Breaches

The operator tells the customer of a personal data breach without undue delay, and at the latest within [ ] hours
of becoming aware of it, through [named, staffed contact], and tells them what is known, what was reached and what
is being done.

> A promise only. The software sends no such notice and sets no deadline. Fill in the hours only once a named person
> is on call to meet them; until then leave the number out rather than write one nobody can keep. What the software
> logs and alerts on is in `docs/procurement/incident-response.md`, with notices to start from.

## 11. Audits

The operator gives the customer the information needed to show that these terms are kept, and lets the customer or
an auditor it names inspect, on [ ] days' notice, at most [once a year].

> A promise only. The software gives the audit trail of every envelope and the security record of every account
> (`src/server/envelopes.ts`, `src/server/seclog.ts`), which the customer can read and export. No outside audit of the
> software exists.

## 12. Transfers

The operator processes the data only in [country or region], and transfers it elsewhere only [with the customer's
written consent / under the safeguards in schedule 3].

> Made true by the software in part: one server, one region, set by where the operator runs it; `DATA_REGION` prints
> it (`src/lib/dataplace.ts`). Each switched-on sub-processor may handle data in its own country, as
> `/security/subprocessors` shows. A template for a transfer assessment is
> `docs/procurement/transfer-impact-assessment-template.md`.

## Schedules

1. The server: its address, and the list at its `/security/subprocessors` on the day of signing, printed.
2. The security measures (clause 5).
3. Transfer safeguards, where needed (clause 12).
