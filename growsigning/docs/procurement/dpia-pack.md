# Data protection impact assessment: a pack to start from

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not a finished impact assessment. Only the body that decides to use the software can make one: it knows its
  documents, its people and its law. This pack gives the facts about the software that such an assessment needs.
- It is not legal advice, and it does not say whether an assessment is required for you.
- It is not a statement about any one server. Where the data is and who else handles it depend on the settings of
  that server: read its `/security/subprocessors` and `/security/processing`.

## What the processing is

People in an organization upload documents, send them to others to fill in and sign, and keep the signed copies.
The people the documents are sent to open a link, agree to sign electronically, sign, and get a copy. Every step is
recorded in an audit trail.

## Categories of data

From the data inventory in `docs/procurement/security-whitepaper.md`:

| Whose | What | Where it comes from |
| --- | --- | --- |
| Account holders | Name, email address, password hash, job title and company if given, saved signature and initials, team memberships, sign-in history, time zone | The person, and their browser |
| People documents are sent to | Name, email address, mobile number if the sender adds one, access code if the sender sets one, what they filled in, signature and initials as pictures, time zone, internet address and browser at each step | The sender, the person, their browser |
| Anyone named inside a document | Whatever the document holds. The software does not read it except to make the text searchable for the account | The sender's upload |
| People who pay | Email address, what they bought, the payment provider's reference. Never a card number | The person, the payment provider |
| People who ask for help | What they wrote, and the answers | The person |

Special categories (health, beliefs, and so on) and data about criminal matters appear only if the customer's
documents contain them. The software cannot tell, and treats every document the same.

## Risks, and what the code does about them

| Risk to the people in the documents | What the software does | What is left to the operator or the customer |
| --- | --- | --- |
| Someone opens a document that was not sent to them | Only the people a document was sent to, its sender and the admins of the sender's account can open it: the router hands each handler the caller's account (`src/server/router.ts`) and each handler filters by it (for documents, `mine()` in `src/server/routes-envelopes.ts`). Optional access codes and one-time codes for signers (`src/server/signercode.ts`). Rate limits (`src/server/util.ts`) | A signing link is the key: anyone who has the email has the document. Decide when to require a code |
| An account is taken over | Password hashes (`src/server/auth.ts`), optional two-step login (`src/server/twostep.ts`), leaked-password check (`src/server/pwned.ts`), a security record and alerts (`src/server/seclog.ts`) | Require two-step login where it matters |
| A disk or backup is stolen | Stored files encrypted when `FILE_ENCRYPTION_KEY` is set (`src/server/filecrypt.ts`). Backups never hold the keys (`scripts/backup.mjs`) | The database is not encrypted by the software: encrypt the disk and the backups |
| A signed document is changed afterwards | Its fingerprint is recorded, the audit trail is hash chained (`src/server/envelopes.ts`), and `/verify` checks a file | Keep backups, so a dispute can be answered |
| Data kept longer than needed | A deletion schedule per account, legal holds, deleting one document, closing an account (`src/server/records.ts`, `src/server/deleting.ts`) | Choose the periods. Deletion does not reach backups |
| Data sent somewhere unexpected | Every outside service is off until set up and listed (`src/lib/outside.ts`). `OUTSIDE_CALLS` holds the server to the list (`src/server/outside.ts`) | Deny egress in the network as well |
| What people type into the help chat goes to an AI provider | Off unless a model is set up. Cards, links, codes, passwords and email addresses are taken out first, and no document is ever sent (`src/lib/chatprovider.ts`) | Switch AI answers off, or run a model inside your own boundary |
| The person signing does not understand what they agree to | A consent screen before signing, in plain words, with its version in the audit trail | The words of the documents themselves |
| A signer's identity is not what it seems | The software knows a signer only by access to the inbox, plus a code if the sender asks. It checks no identity document | Decide whether that is enough for each kind of document |

## The operator's choices left open

Each of these changes the assessment. Write down the choice and why.

1. Where the server runs, and who hosts it (`DATA_REGION`, `DATA_HOST`).
2. Which outside services are on: mail relay, text messages, payments, sign-in with Google or Microsoft, a
   time-stamp service, a document converter, an AI model for the help chat.
3. Whether stored files are encrypted (`FILE_ENCRYPTION_KEY`), and whether the disk is.
4. How backups are made, where they are kept and for how long (`DATA_BACKUPS`).
5. The deletion schedule of each account, and how long the security record is kept (`SECURITY_LOG_DAYS`).
6. Whether two-step login is required, and whether signers must give a code.
7. Who on the operator's staff can reach the server, and who answers a breach (see
   `docs/procurement/incident-response.md`).
8. Whether people outside the country receive documents, and what that means for transfers (see
   `docs/procurement/transfer-impact-assessment-template.md`).
