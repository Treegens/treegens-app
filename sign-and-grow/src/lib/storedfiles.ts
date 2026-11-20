// What the software does to the files it stores, and what it does not. /security and the data processing summary
// print these sentences, and the server reads the same key rules (src/server/filecrypt.ts, src/server/filestore.ts),
// so a page cannot say files are encrypted on a server that does not encrypt them.
//
// The files are the uploaded documents, the signed PDFs, the copies kept of what someone signed before a change, the
// files signers attach and the PDFs attached to emails waiting to be sent: everything in DATA_DIR/blobs. The database
// (DATA_DIR/sign.db) is never encrypted by the software. It holds names, email addresses, what people typed into
// fields, signatures as pictures and every audit trail.
//
// It reads the environment: server code and server components only.

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
const DATABASE = 'The database is a different matter: the names and email addresses of everyone on a document, what they typed into its fields, their signatures as pictures and every audit trail are kept there, and the software does not encrypt it. Whoever has a copy of the disk can read all of that unless the disk itself is encrypted, which depends on where the service is hosted.';

/** The point on /security that says what is protected when the files are encrypted. Empty when they are not. */
export function encryptedFilesPoint(on = fileEncryptionOn()): { title: string; text: string } | null {
  if (!on) return null;
  return {
    title: 'Stored files are encrypted by the software.',
    text: `On this server the ${FILES} are encrypted before they are written to disk, with AES-256-GCM and a key of its own for each file, and every file is checked when it is read: one that was changed or damaged on the disk is refused and reported, never shown. That protects a copy of the disk or of a backup taken without the server's settings. It does not protect against someone who gets into the running server, because the key is in those settings. Files stored before encryption was switched on are encrypted when the people who run this server run the script made for that, and until then they are kept as they were.`,
  };
}

/** The point under "What this is not" on /security: the database always, the files when they are not encrypted. */
export function notEncryptedPoint(on = fileEncryptionOn()): { title: string; text: string } {
  return on
    ? { title: 'The database is not encrypted by the software.', text: DATABASE }
    : { title: 'Stored files and the database are not encrypted by the software on this server.', text: `The software can encrypt the ${FILES}, and the people who run this server have not switched that on, so those files are on the disk as they were uploaded and signed. ${DATABASE}` };
}

/** The line in the data processing summary, under "How it is protected", when the files are encrypted. The page
 *  says what is true when they are not. */
export const PROCESSING_ENCRYPTED = `Stored files (the ${FILES}) are encrypted by the software with AES-256-GCM. The database is not: it holds names, addresses, what people typed, signatures and the audit trails, so how the disk is protected still matters and depends on the host. The key is in the server's settings, so this protects copies of the disk and backups, not a running server someone has broken into.`;
