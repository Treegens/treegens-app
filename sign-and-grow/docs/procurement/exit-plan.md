# Exit plan: taking your data and leaving

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not a promise of help from anyone. It says what the software lets you take out, in which formats, and what
  it does not let you take out today.
- It is not a migration tool. Nothing here imports your data into another product.
- It does not cover what the operator of a server keeps in its backups. Ask them.

There are two ways out. A customer on someone else's server uses the account export. A body that runs its own server
also has the whole database and every file.

## Way 1: the account export (any customer)

Settings, Records and data, **Export everything**. Free on every plan, and it keeps working after a paid plan ends
or is cancelled (`GET /api/export`, `src/server/routes-trust.ts`). An admin gets the whole account; a member gets
the envelopes they sent.

What the ZIP file holds:

| Folder or file | What | Format |
| --- | --- | --- |
| `signed/` | Every completed document, with its certificate of completion inside it | PDF |
| `audit/` | The full audit trail of every envelope: each step, who, when, from which internet address | JSON |
| `comments/` | The questions and comments on an envelope, in full | Plain text |
| `originals/` | The files as uploaded, where a document was made from a Word file or similar. They were not what was signed | As uploaded |
| `stamps/` | The account's stamps, with their names and settings | PNG and CSV |
| `security/` | The account's security record, for admins | CSV |
| `deletion-record.csv` | Every change to the deletion schedule, every keep, hold and deletion, for admins | CSV |
| `envelopes.csv` | One row per envelope: subject, status, dates, recipients, the SHA-256 of the signed PDF, custom fields | CSV (UTF-8) |
| `README.txt` | What is in the file, and what was left out and why | Plain text |

Click-to-agree acceptances have their own export, as CSV (`GET /api/clickwrap-acceptances/export`,
`src/server/routes-clickwrap.ts`).

Every signed PDF can still be checked after you leave: its SHA-256 is in `envelopes.csv` and in its audit trail, and
any copy of the software can compare them at `/verify`. A PDF with a digital seal (when the server had
`SEAL_KEY_PEM`) can be checked by any PDF reader that reads seals, without this software.

### Steps

1. An admin signs in and opens Settings, Records and data.
2. Choose Export everything. The ZIP file is made as it downloads.
3. Open `README.txt` first. It names anything left out: a signed PDF that failed its check, one locked with a key
   the server was not given, one whose files the deletion schedule removed, or the rest when the file would be larger
   than one ZIP can hold (60,000 files or about 3.8 GB, `src/server/zip.ts`). In that last case, export again with
   fewer envelopes selected.
4. Check a few signed PDFs at `/verify`.
5. When you have what you need, close the account: Settings, Records and data, Close my account. It is deleted
   after 30 days, or at once if you choose.

### Timing

The export is made while it downloads, so it takes as long as the download. Nothing has to be requested or
waited for.

## Way 2: the whole server (an operator)

`node scripts/backup.mjs <folder>` copies the database and every stored file while the server runs, with a manifest
of SHA-256 sums (`scripts/backup.mjs`). The database is one SQLite file, which any SQLite tool opens. The stored files
are named by the SHA-256 of their contents and, when `FILE_ENCRYPTION_KEY` was set, are encrypted in the format
described in `src/server/filecrypt.ts` (AES-256-GCM behind a small header). There is no tool that writes them back
out unencrypted: to read them, restore the backup into a copy of this software (`scripts/restore.mjs`) and use the
account export, or write a reader from that format description. Keep `FILE_ENCRYPTION_KEY` and `APP_SECRET`: without the first, encrypted files cannot be
read; without the second, old click-to-agree seals and the security record chains cannot be checked.

## What is lost, or not in the account export today

- Drafts and envelopes that were never completed: their audit trails and rows are in the export, but not their
  documents.
- Templates, public forms and click-to-agree agreements themselves (the acceptances are exported, the terms are not).
- Contacts and signing groups.
- The team list, roles, API keys, webhooks and account settings.
- The stored copies of emails and text messages.
- The account's consent texts and their versions.

A full export of all of this, in documented formats, is planned work (G19 in `research/government.json`) and not
built. Until then, a body that needs all of it should run its own server and use way 2.
