# GrowSigning runbooks: what to do, step by step

For the people who run a server. Written on 21 November 2026 from the code as it was that day.

## What this is not

- Not a promise that these steps are enough for your situation. They say what the software needs; what the law or
  your own rules need on top is for you to find out.
- Not tested on your installation. The backup and restore steps are tested by `tests/selfhost.test.ts` on every
  run of the tests. The key rotation steps rest on `scripts/encrypt-files.mjs` and its tests in
  `tests/encrypt.test.ts`. The steps for a leaked key and for a breach are advice, and nobody has rehearsed them.
- An installation is not certified by following these steps, and no scheme is claimed to be met.

Words used below: the **data folder** is `DATA_DIR` (in the container, the volume at `/data`). The **two keys** are
`APP_SECRET` and `FILE_ENCRYPTION_KEY`. They are settings, never data, and never in a backup.

## Where the two keys must be kept

In a secret store of your own (a password manager for teams, your cloud's secret service, a sealed envelope in a
safe), apart from the server and apart from the backups. A backup with its keys next to it protects nothing; a
backup without its keys anywhere is lost.

If `APP_SECRET` was never set, the server made one and keeps it in the file `secret` in the data folder. Read it
from there now, put it in your secret store, and set `APP_SECRET` to it. `scripts/backup.mjs` leaves that file out
and says so in capital letters every time.

## Making a backup

The server keeps running.

```bash
node scripts/backup.mjs /path/to/backups        # with the server's settings in the environment or in .env
docker compose run --rm backup                   # the same, with docker-compose.example.yml
```

It writes a folder `backup-<date>T<time>Z` with `sign.db`, `blobs/` and `manifest.json` (the SHA-256 of every
file). The folder only gets that name when the backup is whole. A folder ending in `.partial` is one that was
stopped half way: delete it.

Then, your part: copy the folder somewhere else, encrypt that copy (the database inside is readable to anyone who
has it), and decide how long copies are kept. Say what you decided in `DATA_BACKUPS`, which `/security` prints.

## Restoring a backup

1. Check the backup where it is. Nothing is copied.
   ```bash
   node scripts/restore.mjs --verify /path/to/backups/backup-2026-11-21T02-00-00Z
   ```
   It must end with "is whole". If it does not, it says which file is missing or changed. Use another backup.
2. Stop the server that is to be replaced, if it still runs.
3. Restore into a new, empty folder. The script refuses a folder with anything in it, so it cannot overwrite a
   server's data. Give it the same two keys as the server that made the backup:
   ```bash
   APP_SECRET=... FILE_ENCRYPTION_KEY=... node scripts/restore.mjs /path/to/backups/backup-2026-11-21T02-00-00Z /path/to/new-data
   ```
4. Read what it says. It copies every file, compares each with the manifest, then recomputes every audit trail's
   hash chain and every account's security record chain with the server's own code, opens every stored file with
   the keys you gave and compares it with the SHA-256 it is named by, and compares `APP_SECRET` with a check value
   in the manifest.
   - "Everything checks": go on.
   - Exit code 3: the files are restored, and something must be put right first. The message says what: a key that
     was not given, a different `APP_SECRET`, or a chain that does not check (then the backup holds it as it was on
     the disk it was made from, and the problem is older than the backup).
   - Exit code 1: nothing was restored.
5. Point `DATA_DIR` at the new folder (or mount it as the volume) and start the server with the same two keys.
6. Open `/api/health`. It must answer 200. Then sign in, open a completed document and download it.

What a restore loses: everything that happened after the backup was made. Emails sent in that time point at
envelopes the restored server does not know. Tell the people it concerns.

## Rotating FILE_ENCRYPTION_KEY

The server can read files under several keys at once, so this needs no stop of more than a restart.

1. Make a new key: `node scripts/encrypt-files.mjs --new-key`. Put it in your secret store first.
2. Set `FILE_ENCRYPTION_KEY` to the new key and add the old one to `FILE_ENCRYPTION_KEYS_OLD` (a list separated by
   commas). Restart. New files are written with the new key; old ones stay readable.
3. Stop the server and run `node scripts/encrypt-files.mjs` with the same settings. It moves every stored file to
   the new key, one at a time, and cannot lose a file (each is written next to the old one, read back and checked
   before it takes its name). Start the server again. The text kept for search moves to the new key at that start.
4. Run `node scripts/encrypt-files.mjs --check`. Only when it says that no file uses the old key, take the old key
   out of `FILE_ENCRYPTION_KEYS_OLD`.
5. Keep the old key in your secret store for as long as you keep backups made under it. A backup's
   `manifest.json` names the id of each key its files need.

If the server starts with a key missing, it reads what it can, stores no new file, and says so in its log and on
`/api/health` (`file_store` fails). Put the key back; nothing is lost.

## Rotating APP_SECRET

Read this before you do it: there is no way to run with an old and a new `APP_SECRET` side by side. Everything the
old one sealed stops checking the moment it changes. So rotate it only when it has leaked, or when you accept the
list below.

What stops working, from reading the code (`src/server/util.ts` has the function, and every use of it was read):

- Records of click-to-agree terms can no longer be checked against their seal (`src/server/clickwrap.ts`). The
  records stay; the seal on each was made with the old secret. This is the heaviest loss. Before rotating, export
  the records you may need to show to someone.
- Links in emails already sent that carry a signature of the server: the link that stops a subscription, the link
  to a help request. A public form someone was in the middle of filling in starts again.
- One-time codes and access-code cookies in use at that moment. People ask for a new code or type the access code
  again.
- Marks kept as keyed fingerprints no longer match: which addresses got the welcome signatures (so they can be
  given a second time), which addresses bounced or asked for no more mail, which phone numbers asked for no more
  texts, and the "same device" mark of witnesses.

What keeps working: logins and sessions, API keys, signing links, webhooks (each has its own secret), stored files
(they use `FILE_ENCRYPTION_KEY`), audit trails and their chains, and `/verify`.

Steps: make a new value (`openssl rand -base64 48`), put it in your secret store, set `APP_SECRET`, restart, and
delete the file `secret` from the data folder if there is one. Keep the old value in the secret store, marked as
retired, with the date: it is the only way to check an old click-to-agree seal by hand.

## A leaked key

First find out which one, and since when.

**`FILE_ENCRYPTION_KEY` leaked.** The key alone opens nothing: someone also needs the stored files (the disk, the
volume or a backup). If they may have both, treat it as a breach (below). Either way, rotate it today with the
steps above. Old backups stay readable with the old key for ever: delete the ones you do not need, and guard the
rest.

**`APP_SECRET` leaked.** Someone who has it can forge what it signs: a link that stops someone's subscription, a
click-to-agree seal, an access-code cookie for a signing link they already have. It does not sign people in and
opens no document on its own. Rotate it today with the steps above, and accept the list of what stops.

**An API key, a webhook secret or the password in `SMTP_URL` leaked.** Delete the API key under Settings (it stops
working at once) and make a new one. Delete and make the webhook again. Change the mail password at your mail
provider and in `SMTP_URL`.

**A person's password leaked.** They change it under Settings, which signs every other session out. An admin can
see sign-ins and failed sign-ins in the security record under Settings, Security.

Write down what leaked, when you learned it, and what you did, with times.

## A breach

Someone got at the server, its disk, its settings or a backup, or you think so.

1. **Do not delete anything.** Keep the server log, the data folder and the suspect machine as they are. Take a
   backup now (`scripts/backup.mjs`) and keep it apart, marked as evidence.
2. **Stop the way in.** Take the server off the network or close the hole. If you cannot tell how they got in, stop
   the server.
3. **Find out what was readable.** Whoever has the data folder reads the whole database: names, addresses, phone
   numbers, what people typed, signatures as pictures, audit trails, stored copies of emails. They read the stored
   files only if those were not encrypted or they also have `FILE_ENCRYPTION_KEY`. The README section "Encrypting
   stored files" lists it exactly. Whoever has the settings has both keys.
4. **Find out what was changed.** `node scripts/restore.mjs --verify` on your backups from before and after, and a
   restore into a new folder, recompute every audit chain and security record chain. A chain that does not check
   was changed outside the application. A chain that checks shows that its lines fit each other; someone who can
   write to the database and knows how the chain is made can make one that checks, so compare with an older backup
   too.
5. **Rotate everything the attacker may have:** both keys (above), every API key, webhook secrets, the mail
   password, the payment provider's keys, sign-in client secrets. End all sessions by asking people to change
   their passwords, or delete the rows of the `sessions` table with the server stopped.
6. **Tell the people it concerns.** Who that is, how fast and in which words depends on the law where you and they
   are; many laws set a deadline counted in hours. The software sets none and sends no such notice. This is the
   moment for your lawyer and your data protection officer, not for a script.
7. **Start again from a known state:** a fresh machine, the image rebuilt from source (below), the data restored
   from the last backup you trust.
8. **Write it down:** what happened, when, what was reached, what you did. If the weakness is in this software,
   tell its authors through the contact on the project's own page.

## Rebuilding the same image

For source escrow, or to show that an image came from this source.

What fixes the result: `package-lock.json` (every package and its checksum; `npm ci` refuses to install anything
else), the digest of the base image, and `SOURCE_DATE_EPOCH` for the times written into the bill of materials.

```bash
docker buildx imagetools inspect node:24-bookworm-slim       # note the digest it prints
docker build \
  --build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<that digest> \
  --build-arg SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
  -t growsigning:<version> .
docker run --rm growsigning:<version> cat public/security/sbom.json > sbom.json
```

What is the same on every such build: the installed packages, the bill of materials (`tests/selfhost.test.ts`
checks that two runs with the same lockfile and time give the same file), and the fonts. What has not been shown:
that the compiled application under `.next` and the image layers come out byte for byte the same. Nobody has
compared two builds. So an escrow agent can rebuild a working image from the same inputs; this document does not
say the two images have the same digest.

Without Docker: Node 22.13 or newer, `npm ci`, `npm run build`, `npm start`.

## Running with no network

Set `OUTSIDE_CALLS=none`. The server then connects only to the mail relay in `SMTP_URL` and to hosts you list in
`OUTBOUND_ALLOW`; payments, sign-in with Google or Microsoft, text messages, time-stamps and an AI model on another
host are switched off when it starts, and each page shows them as absent. Without `SMTP_URL` no email is
delivered: a sender chooses "I will send the link myself" for a person and passes the link on by their own
means, or a system of yours asks the API for it (`POST /envelopes/{id}/recipient-view`).

The software's own guard is a second line of defence (`src/server/outside.ts` says what it cannot see). Deny
egress in the network as well: `deploy/helm/growsigning/templates/networkpolicy.yaml` does, by default.

`scripts/container-smoke.sh` builds the image, starts it with `--network none`, sends and signs one envelope
through the API and checks the signed PDF with the server's own verify call. Run it where Docker is. The README
says when it was last run and what it showed.
