# GrowSigning security whitepaper

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not an audit, a certificate or a test report. Nobody outside the project has checked it. No penetration
  test has been done.
- It is not a description of your installation. It describes the software. Where the data is, who can reach the
  server and how it is run are decided by whoever runs it (the operator).
- It is not a promise that the software keeps any law or standard. It says what the code does and what it does not
  do. Every statement names the file it rests on, so that your own people can read the code and check it.

The control areas, one by one, are in `docs/controls.md`. The steps for backups, keys and a breach are in
`docs/runbooks.md`.

## Architecture

One process does everything: the web pages, the API and a timer (`src/server/cron.ts`). It runs on Node with the
Next.js framework. The API is one catch-all route (`src/app/api/[...path]/route.ts`) into a small router
(`src/server/router.ts`) that checks, for every route, who is calling and at which level (signed in, admin, API key
scope), and hands the caller's account to the handler.

Data lives in one folder, `DATA_DIR`:

- the database, one SQLite file (`src/server/db.ts`), with one writer;
- the stored files: uploaded documents, signed PDFs, attachments, under `blobs/`, each named by the SHA-256 of its
  contents (`src/server/filestore.ts`).

There is no second server, no queue service, no cache service and no separate database server. Because SQLite has
one writer, there is exactly one copy of the process. An update means a short stop. There is no failover.

TLS is not done by the application. It speaks plain http behind a reverse proxy, which the operator runs.

The container image (`Dockerfile`) runs as a user without privileges. The Helm chart
(`deploy/helm/growsigning/templates/deployment.yaml`) gives it a read-only root file system and one writable
volume, and a network policy that denies outgoing traffic by default
(`deploy/helm/growsigning/templates/networkpolicy.yaml`).

## Data flows

```
 Sender's browser ──https──┐                                ┌──> Mail relay (SMTP_URL): every email
 Signer's browser ──https──┤                                ├──> Payment provider, if connected
 API client (key) ──https──┤                                ├──> Google or Microsoft sign-in, if set up
                           v                                ├──> Text message provider, if set up
                  Reverse proxy (TLS, operator's)            ├──> Time-stamp service, if set up (a hash only)
                           │ http                           ├──> AI model for the help chat, if set up
                           v                                ├──> Document converter, if set up
             ┌──────── one Node process ────────┐           ├──> Leaked-password list (a hash prefix only)
             │ pages, API, router, timer        │ ──────────┤
             └───────┬──────────────────┬───────┘           └──> Webhooks an account admin sets up
                     v                  v
             SQLite database      stored files (blobs/)
                     └──── DATA_DIR, one volume ────┘
```

Every outside service is off until its setting is set. The one list of them, with the hosts the settings imply, is
`src/lib/outside.ts`; `/security` prints it from the settings the server runs on. `OUTSIDE_CALLS=listed` or `none`
makes the server refuse any other connection it opens itself, before anything is sent (`src/server/outside.ts`).
This is a second line of defence, not a firewall: a program the server starts (LibreOffice) is outside it.

## Data inventory

What is stored, and where. The full list of what the database holds is in the README section "Encrypting stored
files", under "What is not protected", and on `/security/processing` (`src/lib/dataplace.ts`,
`src/lib/storedfiles.ts`).

| What | Where | Encrypted by the application |
| --- | --- | --- |
| Uploaded documents, signed PDFs, signer attachments, PDFs waiting to be emailed | `DATA_DIR/blobs` (`src/server/filestore.ts`) | Yes, when `FILE_ENCRYPTION_KEY` is set (`src/server/filecrypt.ts`) |
| Text read from uploaded PDFs, for search | database (`src/server/searchtext.ts`) | Yes, when `FILE_ENCRYPTION_KEY` is set |
| Names, email addresses, phone numbers, subjects, messages, what people typed into fields, signatures as pictures, comments | database (`src/server/db.ts`) | No |
| Audit trail of every envelope: each step, its time, the internet address and the browser | database (`src/server/envelopes.ts`) | No. Hash chained |
| Security record of every account: sign-ins, failed sign-ins, changes to logins, team and keys | database (`src/server/seclog.ts`) | No. Chained with a keyed hash |
| Copies of every email and text message sent | database (`src/server/mail.ts`, `src/server/sms.ts`) | No |
| Password hashes, session fingerprints, API key fingerprints | database (`src/server/auth.ts`) | Stored as hashes, never as written |
| Two-step login secrets | database (`src/server/twostep.ts`) | No |
| Payments: what was paid and the provider's reference, never a card number | database (`src/server/routes-billing.ts`) | No |
| Help chat: not the conversation (nothing asked or answered is stored), only a count of questions under a keyed fingerprint, for up to two days | database (`src/server/chat.ts`) | Fingerprints only |
| Help requests written to a person | database (`src/server/routes-support.ts`) | No |

Encrypt the disk. Whoever has the disk or a backup reads everything in the database.

## Crypto inventory

All cryptography on the server is Node's own `node:crypto` (OpenSSL underneath). No hardware security module is
used, and no validated cryptographic module is claimed. One use runs in the visitor's browser instead: `/verify`
works out the SHA-256 of a file with the browser's own WebCrypto, so the file does not leave the device
(`src/app/verify/ById.tsx`); a browser without it sends the file to the server, which hashes it the same way. A test (`tests/gov-g03.test.ts`) reads every call below in `src/server`
and `scripts` and fails when one is used in a file this table does not name, so a new use has to be written here
first.

| Call in the code | What it is used for | Files |
| --- | --- | --- |
| `crypto.scryptSync` | Password hashes: scrypt with a random 16-byte salt and a 64-byte result. | `src/server/auth.ts` |
| `crypto.createCipheriv` | AES-256-GCM: stored files, and the text read from PDFs, under a key per file; values in the encrypted database columns under a key per column. | `src/server/filecrypt.ts`, `src/server/searchtext.ts`, `src/server/colcrypt.ts` |
| `crypto.createDecipheriv` | Reading those back; the GCM tag refuses one changed byte. Also opening a seal key in a PKCS#12 file (AES-CBC or 3DES, as the file says). | `src/server/filecrypt.ts`, `src/server/searchtext.ts`, `src/server/p12.ts`, `src/server/colcrypt.ts` |
| `crypto.hkdfSync` | HKDF-SHA256: the key per file or per text from `FILE_ENCRYPTION_KEY`, a random salt and the file's name; the key per database column from the same key and the table and column. | `src/server/filecrypt.ts`, `src/server/searchtext.ts`, `src/server/colcrypt.ts` |
| `crypto.pbkdf2Sync` | Opening a PKCS#12 seal key file with its password. | `src/server/p12.ts` |
| `crypto.createHmac` | HMAC-SHA256 with `APP_SECRET`: signing links, one-time codes kept as keyed hashes, the security record chain, click-to-agree seals, the key id of `FILE_ENCRYPTION_KEY`, a check in a backup that `APP_SECRET` is the same. HMAC-SHA1 for two-step login codes (TOTP, as authenticator apps expect). The PKCS#12 integrity check. Checking the signature on replies and delivery reports from WhatsApp (HMAC-SHA256 with `WHATSAPP_APP_SECRET`, HMAC-SHA1 with `TWILIO_AUTH_TOKEN`, as those providers sign). Checking the signature on payment messages from Stripe Connect (HMAC-SHA256 with `STRIPE_CONNECT_WEBHOOK_SECRET`). HMAC-SHA1 for the one-time code of a cloud seal certificate that asks for one (TOTP, `SEAL_CSC_TOTP_SECRET`). | `src/server/util.ts`, `src/server/clickwrap.ts`, `src/server/filecrypt.ts`, `src/server/twostep.ts`, `src/server/p12.ts`, `src/server/whatsapp.ts`, `src/server/collect.ts`, `scripts/backup.mjs`, `src/server/sealcsc.ts` |
| `crypto.createHash` | SHA-256: file names by contents, the audit trail chain, session and API key fingerprints, the digest a seal signs, certificate fingerprints, the PKCE challenge of a sign-in, backup manifests, checking a time stamp over the audit trail's chain head. SHA-1 only for the first five characters sent to the leaked-password list and for the certificate ids that OCSP asks for (long-term validation of a seal). | `src/server/util.ts`, `src/server/filecrypt.ts`, `src/server/credits.ts`, `src/server/auditstamp.ts`, `src/server/ltv.ts`, `src/server/oidc.ts`, `src/server/p12.ts`, `src/server/pwned.ts`, `src/server/seal.ts`, `src/server/sealcms.ts`, `src/server/sealkey.ts`, `src/server/sealpdf.ts`, `src/server/tsa.ts`, `src/server/x509.ts`, `scripts/backup.mjs`, `scripts/restore.mjs`, `scripts/sbom.mjs`, `src/server/sealcsc.ts` |
| `crypto.sign` | The digital seal of a completed PDF, when `SEAL_KEY_PEM` is set: RSA-PSS with SHA-256 (2048 bits or more) or ECDSA on P-256. | `src/server/sealkey.ts` |
| `crypto.verify` | Checking a seal or a time stamp on a PDF; checking revocation answers (OCSP) for long-term validation of a seal; checking the RS256 signature on a Google or Microsoft ID token; checking the signature a cloud signing service (SSL.com eSigner) sends back before it goes into a seal. | `src/server/sealcms.ts`, `src/server/ltv.ts`, `src/server/oidc.ts`, `src/server/sealcsc.ts` |
| `crypto.randomBytes` | Session tokens, ids, salts and GCM nonces, the server's own secret when `APP_SECRET` is not set, two-step login secrets, time-stamp and OCSP nonces, the document ID of a PDF/A file, the one-time value of a Stripe connect. | `src/server/util.ts`, `src/server/auth.ts`, `src/server/db.ts`, `src/server/filecrypt.ts`, `src/server/searchtext.ts`, `src/server/routes-twostep.ts`, `src/server/tsa.ts`, `src/server/ltv.ts`, `src/server/pdfa.ts`, `src/server/collect.ts`, `scripts/encrypt-files.mjs`, `src/server/colcrypt.ts`, `scripts/encrypt-columns.mjs`, `scripts/setup.mjs` |
| `crypto.randomInt` | Six-digit codes (address confirmation, signer codes, the code that lets a person ask for emails again, the code sent by text message to check the phone number of a login), two-step recovery codes, a random look for a stamp, the code that connects a person's own screen at a service counter. | `src/server/confirmcode.ts`, `src/server/signercode.ts`, `src/server/routes-bounces.ts`, `src/server/twostep.ts`, `src/server/stamps.ts`, `src/server/counter.ts`, `src/server/routes-signuprules.ts` |
| `crypto.timingSafeEqual` | Comparing a password hash and a signed value without leaking time. | `src/server/auth.ts`, `src/server/util.ts` |

TLS is left to the reverse proxy. Mail goes to the relay with the TLS settings of `SMTP_URL` (`src/server/mail.ts`).

## Sessions and sign-in

- A session is a random token in a cookie marked HttpOnly and SameSite=Lax, and Secure when the request came over
  https. The database keeps only its SHA-256 (`src/server/auth.ts`).
- A session that is used moves its end forward, but ends 90 days after sign-in at the latest; one that is not used
  ends 30 days after its last use (`SESSION_DAYS` and `SESSION_MAX_DAYS` in `src/lib/policy.ts`). A person can see
  and end their other sessions. Changing the password signs every other session out.
- Two-step login with an authenticator app, and recovery codes, is optional for each person; an owner can require
  it for the account (`src/server/twostep.ts`).
- Sign-in with Google or Microsoft is optional and off until set up (`src/server/oidc.ts`). An organisation can
  have its people sign in through its own OpenID Connect or SAML 2.0 service once it proves its email domain
  (`src/server/orgsso.ts`; SAML signatures are checked by the `@node-saml/node-saml` library, `src/server/saml.ts`),
  and its directory can add and remove members by SCIM 2.0 with a token kept only as its SHA-256
  (`src/server/scim.ts`). There is no SAML single logout.
- A new password is looked up in a list of leaked passwords, sending only the first five characters of its SHA-1
  (`src/server/pwned.ts`). `PWNED_CHECK=0` switches that off.
- API keys are kept as fingerprints and carry at most their maker's role (`src/server/auth.ts`).

## Rate limits

Sign-in, codes, access codes, public forms and other public routes are limited per caller address and per target
(`rateLimit` in `src/server/util.ts`, used across `src/server`). The counters live in the memory of the one process,
so a restart sets them back to zero. The caller's address is read behind `TRUSTED_PROXY_HOPS` proxies; set it
wrong and the limits count the proxy.

## Logging and alerts

- The audit trail of every envelope is hash chained, so a changed or missing line shows when the chain is checked
  (`src/server/envelopes.ts`).
- The security record of every account cannot be changed through the application: triggers in the database refuse
  an update and an early delete, and each line is chained with a keyed hash (`src/server/seclog.ts`,
  `src/server/db.ts`). Admins read it under Settings, Security, and can pull it through the API or a webhook
  (`src/server/routes-seclog.ts`). Five alerts email the admins: many failed sign-ins, a new API key, the account
  handed to a new owner, everything exported, many documents deleted (`src/lib/seclog.ts`).
- A stored file that fails its check is refused and the operator is alerted in the operator queue and by email when
  `SUPPORT_EMAIL` or `OPERATOR_EMAILS` is set (`src/server/filestore.ts`).
- The server log goes to standard output only. The software keeps no log of its own beyond the records above, and
  does not ship the log anywhere.
- `GET /api/health` answers 503 and says why when the database does not open, the disk is full, storing files is
  stopped or the timer has not run (`src/server/selfhost.ts`).

## Backups

`scripts/backup.mjs` makes a consistent copy while the server runs, with a manifest of SHA-256 sums.
`scripts/restore.mjs` refuses a backup that is not whole and checks every chain and every stored file after
copying. Neither holds a key. Running them on a schedule, keeping copies elsewhere and encrypting them is the
operator's job. See `docs/runbooks.md`.

## Encryption at rest, and its limits

With `FILE_ENCRYPTION_KEY` set, stored files and the text read from PDFs are encrypted by the application
(`src/server/filecrypt.ts`, `src/server/searchtext.ts`). Without it, nothing is. Either way:

- the database is not encrypted by the application;
- the key is in the server's settings, so this protects a stolen disk or a leaked backup taken without those
  settings, not a break-in to the running server;
- a stored file is still named by the SHA-256 of its readable contents, so someone with the disk sees which files
  are the same and roughly how large each is.

## Separation between customers

Every row belongs to an account. The router hands each handler the caller's account (`src/server/router.ts`), and
each handler filters its own queries by it: the router does not do that filtering itself, so every new route has to.
All
accounts share one database and one process. A body that must not share a database with anyone runs its own copy.

## What is not done

- No audit, no certificate of any kind, no penetration test, no outside code review.
- No encryption of the database by the application, no hardware security module, no keys held by the customer.
- No malware scan of uploads.
- No SAML single logout, no SAML sign-ins started from the identity provider's portal, no directory groups (SCIM Users only). No real identity provider or directory has been tried end to end yet, only stand-ins in the tests.
- No high availability, no second site.
- No log shipping, no intrusion detection, no alerting to an on-call person.
- No promise from the authors of how fast a weakness is fixed.
