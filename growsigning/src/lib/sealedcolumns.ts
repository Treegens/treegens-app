// What the software encrypts in the database when FILE_ENCRYPTION_KEY is set, and what it keeps readable, in words.
// /security and the data processing summary print these lists (through src/lib/storedfiles.ts). The columns behind
// them are SEALED_COLUMNS in src/server/colcrypt.ts; tests/ds-db-encrypt.test.ts checks every one of them is
// unreadable in the database file. Shared by pages and server: no server imports here.

/** Encrypted in the database, with a key of its own for each column, when FILE_ENCRYPTION_KEY is set. */
export const SEALED_WORDS = [
  'signatures and initials, also the ones saved for reuse and earlier ones kept after a change',
  'the phone number of each login',
  'what people typed or chose in fields, also as plain numbers, and what the sender filled in',
  'answers typed into a public form before it is signed',
  'comments',
  'copies of the emails that were sent',
  'decline reasons',
  'help messages, their replies and the chats attached to them',
];

/** Kept readable in the database whatever the setting. Search, sending mail and joining records need them. */
export const CLEAR_WORDS = [
  'names, email addresses and phone numbers of the people on a document (the phone number of a login is encrypted, see above)',
  'subjects and messages of envelopes, names of documents and folders, and who each email went to with its subject',
  'ids and fingerprints of files',
  'audit trails, with the IP addresses and browsers they record and what they repeat, such as a decline reason',
  'copies of text and WhatsApp messages, click-to-agree terms and who accepted them, custom fields, contacts, signing groups, plans and payments',
];
