// What the software does to the files it stores, and what it does not. /security and the data processing summary
// print these sentences, and the server reads the same key rules (src/server/filecrypt.ts, src/server/filestore.ts),
// so a page cannot say files are encrypted on a server that does not encrypt them.
//
// The files are the uploaded documents, the signed PDFs, the copies kept of what someone signed before a change, the
// files signers attach and the PDFs attached to emails waiting to be sent: everything in DATA_DIR/blobs. With a key the
// text read from uploaded PDFs for search is encrypted with it too (src/server/searchtext.ts). The database
// (DATA_DIR/sign.db) is encrypted in part with a key (SEALED_WORDS in sealedcolumns.ts, src/server/colcrypt.ts):
// without one DATABASE_HOLDS is what anyone with a copy of the disk reads there, with one CLEAR_WORDS is, and both
// pages print exactly that list.
//
// It reads the environment: server code and server components only.
import { SEALED_WORDS, CLEAR_WORDS } from './sealedcolumns.ts';

/** How to make a key, in a form that can be copied into a terminal. */
export const NEW_FILE_KEY_COMMAND = 'openssl rand -base64 32';

/** A key from the settings: exactly 32 bytes written as base64 (44 characters with the "=" at the end). Anything
 *  else is not a key. Buffer.from(..., 'base64') skips characters it does not know, so the text is checked first:
 *  a key with a typo in it must be refused, not quietly turned into a different key. */
export function decodeFileKey(text: string | undefined): Buffer | null {
  const t = String(text || '').trim();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) return null;
  const k = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return k.length === 32 ? k : null;
}

/** True when this server encrypts the files it writes: FILE_ENCRYPTION_KEY is set and is a key. A key that is set but
 *  is not one stops the server from storing files at all (filestore.ts), so it never counts as on. */
export const fileEncryptionOn = (env: Record<string, string | undefined> = process.env): boolean => !!decodeFileKey(env.FILE_ENCRYPTION_KEY);

const FILES = 'uploaded documents, signed PDFs and the files signers attach';
/** What stays readable in the database whatever the setting, because the software does not encrypt it. */
export const DATABASE_HOLDS = [
  'the names, email addresses and phone numbers of everyone on a document and of everyone with a login',
  'the subjects and messages of envelopes and the names of their documents and folders',
  'what people typed into fields, and their signatures and initials as pictures',
  'comments, and the copies kept of the emails and text messages that were sent',
  'terms written on click-to-agree pages, and who accepted them',
  'contacts, signing groups, help requests, and the plans and payments of accounts',
  'every audit trail, with the IP addresses and browsers it records',
];
const KEPT_TEXT = 'the text read from every uploaded PDF, kept for search and for the check before sending';
// With a key, part of the database is encrypted too (src/server/colcrypt.ts). The two lists are in sealedcolumns.ts.
const PART_SEALED = `With the same key the software also encrypts, in the database: ${SEALED_WORDS.join('; ')}, and the text read from uploaded PDFs for search. Values written before the key was set are encrypted when the server starts and by its timer.`;
/** The database, said the same way on /security and in the data processing summary. `on`: files are encrypted. */
export const databaseText = (on = fileEncryptionOn()): string =>
  on
    ? `${PART_SEALED} The rest of the database stays readable to whoever has a copy of the disk or of a backup: ${CLEAR_WORDS.join('; ')}. So encrypt the disk itself as well. Whether it is encrypted depends on where the service is hosted.`
    : `The software does not encrypt the database. Whoever has a copy of the disk or of a backup can read what it holds: ${[...DATABASE_HOLDS, KEPT_TEXT].join('; ')}. So encrypt the disk itself as well. Whether it is encrypted depends on where the service is hosted.`;

/** The point on /security that says what is protected when the files are encrypted. Empty when they are not. */
export function encryptedFilesPoint(on = fileEncryptionOn()): { title: string; text: string } | null {
  if (!on) return null;
  return {
    title: 'Stored files are encrypted by the software.',
    text: `On this server the ${FILES} are encrypted before they are written to disk, with AES-256-GCM and a key of its own for each file, and so is the text read from uploaded PDFs that is kept for search. Every file is checked when it is read: one that was changed or damaged on the disk is refused and reported, never shown. That keeps those files unreadable on a copy of the disk or of a backup taken without the server's settings. It does not make such a copy safe by itself, because only part of the database on the same disk is encrypted (see "What this is not" below). It does not protect against someone who gets into the running server either, because the key is in those settings. Files stored before encryption was switched on are encrypted when the people who run this server run the script made for that, and until then they are kept as they were. Their earlier readable copies stay in backups made before that, and can stay in the free space of the disk, until those backups are replaced and the disk is encrypted.`,
  };
}

/** The point under "What this is not" on /security: the database always, the files when they are not encrypted. */
// Off is said of the files stored from now on: a server where encryption was switched off (the key moved to
// FILE_ENCRYPTION_KEYS_OLD) still holds files that were encrypted while it was on, and they stay encrypted.
export function notEncryptedPoint(on = fileEncryptionOn(), env: Record<string, string | undefined> = process.env): { title: string; text: string } {
  const wasOn = !!(env.FILE_ENCRYPTION_KEYS_OLD || '').trim();
  return on
    ? { title: 'The database is only partly encrypted by the software.', text: databaseText(true) }
    : { title: 'Stored files and the database are not encrypted by the software on this server.', text: `The software can encrypt the ${FILES}, and it is not switched on here, so new files are kept on the disk as they were uploaded and signed.${wasOn ? ' Files stored while it was switched on stay encrypted.' : ''} ${databaseText(false)}` };
}

/** The line in the data processing summary, under "How it is protected", when the files are encrypted. The page
 *  says what is true when they are not, and prints databaseText() in both cases. */
export const PROCESSING_ENCRYPTED = `Stored files (the ${FILES}) and the text read from uploaded PDFs for search are encrypted by the software with AES-256-GCM, and so are signatures, typed answers, comments, stored emails, decline reasons and help messages in the database. The rest of the database is not, so how the disk is protected still matters and depends on the host. The key is in the server's settings, so this protects copies of the disk and backups taken without them, not a running server someone has broken into.`;
/** "What the software does not do" in the data processing summary. */
export const processingNotDone = (on = fileEncryptionOn()): string =>
  on ? 'it does not encrypt the whole database: names, email addresses, subjects and the audit trail stay readable.' : 'on this server it does not encrypt the files it stores now, and it never encrypts the database, so how the disk is protected depends on the host.';
