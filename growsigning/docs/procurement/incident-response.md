# Incident response: what the software gives you, and what you must staff

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not an incident response service. The software sends no breach notice to anyone, sets no deadline and has
  nobody on call. Its authors do not watch any server.
- It is not a plan that has been rehearsed. Nobody has run these steps on a real incident.
- It does not say what the law requires of you, or how fast. Many laws count the time to notify in hours. Ask your
  lawyer and your data protection officer which apply.

The steps to follow during a breach, and for a leaked key, are in `docs/runbooks.md` ("A leaked key", "A breach").
This document lists what the software records and alerts on, what you must have in place to meet a notification
deadline, and notices to start from.

## What the software records today

| Record | What is in it | Where | Who can read it |
| --- | --- | --- | --- |
| Security record of each account | Sign-ins, failed sign-ins, changes to logins, two-step login, the team, API keys, webhooks, exports, deletions. Cannot be changed through the application; chained with a keyed hash | `src/server/seclog.ts` | The account's admins, under Settings, Security; an admin API key (`GET /api/account/security-events`); a webhook for `security.event` |
| Audit trail of each envelope | Every step of sending and signing, with time, internet address and browser. Hash chained | `src/server/envelopes.ts` | The sender and the account's admins; in the export |
| Deletion record | Every change to the deletion schedule, every keep, hold and deletion, every refused attempt | `src/server/records.ts` | The account's admins |
| Refused outside connections | A connection the server tried to open to a host not on its list, once an hour per host | `src/server/outside.ts` | The server log |
| Server log | Start-up warnings for wrong settings, errors, alerts | standard output | Whoever runs the server |

The server log is written to standard output only. Collecting it, keeping it where it cannot be changed and
reading it is the operator's job.

## What the software alerts on today

| Alert | Who is told | How | Where in the code |
| --- | --- | --- | --- |
| Many failed sign-ins on an account in an hour | The account's admins | Email, at most once an hour | `src/lib/seclog.ts`, `src/server/seclog.ts` |
| A new API key | The account's admins | Email | same |
| The account handed to a new owner | The account's admins | Email | same |
| Everything exported | The account's admins | Email | same |
| Many documents deleted in an hour | The account's admins | Email | same |
| A stored file fails its check (changed, cut short or copied under another name) | The operator | Operator queue, log, and email to `SUPPORT_EMAIL` or `OPERATOR_EMAILS` when set | `src/server/filestore.ts` |
| A signed PDF could not be made | The operator | Operator queue, log, email as above | `src/server/finalretry.ts` |
| A document is disputed by someone it names | The operator | Operator queue, log, email as above | `src/server/evidence.ts` |
| The server is unhealthy (database, disk, file store, timer) | Whatever watches `/api/health` | HTTP 503 with the reason | `src/server/selfhost.ts` |

Without `SUPPORT_EMAIL` or `OPERATOR_EMAILS` the operator alerts reach only the operator queue and the log, and the
log says that nobody was told by email.

## What you must staff to meet a deadline counted in hours

Nothing in the software can meet a notification deadline for you. To meet one you need, at least:

1. **A named contact who is reachable** at the hours the deadline counts, with a deputy. Put them in
   `SECURITY_CONTACT` so reports from outside reach them (`/.well-known/security.txt`, `/security/disclosure`), and in
   `OPERATOR_EMAILS` so the software's alerts do.
2. **Someone watching** `/api/health`, the server log and the operator mailbox, with a way to wake the contact.
3. **The authority to stop the server** or take it off the network without asking anyone else first.
4. **A lawyer or data protection officer** who can decide, within the deadline, whether and whom to notify.
5. **The list of customers and their contacts,** kept outside the server, so you can reach them when it is down.
6. **Backups you have restored before** (`scripts/restore.mjs`), so you know what a clean state is.

Until a named person is on call, do not write a number of hours into a contract (see
`docs/procurement/data-processing-terms-template.md`, clause 10).

## Notices to start from

Fill in the brackets. Say what you know, what you do not know yet, and what the reader should do. Do not guess, and
do not say that nothing was reached unless you have checked.

### To a customer

> Subject: Security incident on [server address]
>
> On [date and time, with time zone] we found [what happened, in one sentence]. It began on or after [date].
>
> What was reached: [the data, for example "names and email addresses of people your account sent documents to"].
> What we know was not reached: [only what you have checked].
> What we do not know yet: [the open questions].
>
> What we have done: [for example "closed the way in, changed every key, restored from a backup of [date]"].
> What you should do: [for example "ask your team to change their passwords", or "nothing at this time"].
>
> We will write again by [date and time] with what we have learned. Write to [named contact, address, phone].

### To a person whose data was reached

> Subject: Your information in documents sent through [organization]
>
> [Organization] uses [server address] to send documents for signature. On [date] we found that [what happened].
> Your [name, email address, signature, and so on] may have been seen by someone who should not have it.
>
> What this means for you: [for example "be careful with emails that ask you to sign something you do not expect"].
> What we have done: [in one or two sentences].
> Questions: [named contact].

### To a supervisory authority

Use the authority's own form where it has one. Have ready: who you are and your contact; what happened and when;
the categories and rough number of people and records; the likely consequences; what you have done and will do;
and, if you are late, why.

## After the incident

Write down what happened, when, what was reached and what you did, with times (`docs/runbooks.md`, step 8). If the
weakness is in the software, tell its authors through the contact on the project's own page.
