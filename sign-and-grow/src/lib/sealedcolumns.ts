// What the software encrypts in the database when FILE_ENCRYPTION_KEY is set, and what it keeps readable, in words.
// /security and the data processing summary print these lists (through src/lib/storedfiles.ts). The columns behind
// them are SEALED_COLUMNS in src/server/colcrypt.ts; tests/ds-db-encrypt.test.ts checks every one of them is
// unreadable in the database file. Shared by pages and server: no server imports here.

/** Encrypted in the database, with a key of its own for each column, when FILE_ENCRYPTION_KEY is set. */
export const SEALED_WORDS = [
  'signatures and initials as pictures, also the ones a login keeps for reuse and the ones kept when a document was changed after signing',
  'what people typed or chose in fields, and what the sender filled in for them',
  'comments',
  'the stored copies of the emails that were sent, with their plain text',
  'the reasons people gave when they declined',
  'the messages and replies of help requests',
];

/** Kept readable in the database whatever the setting, and why. */
export const CLEAR_WORDS = [
  'the names, email addresses and phone numbers of everyone on a document and of everyone with a login, because finding a document, sending mail and joining records need them',
  'the subjects and messages of envelopes, the names of their documents and folders, and the address and subject of each stored email, because search needs them',
  'ids and fingerprints of files, and which file an attachment or a stamp field holds, because records are joined on them',
  'every audit trail, with the IP addresses and browsers it records and what it repeats, such as a decline reason, because each line is chained to the one before and checked',
  'the copies kept of text and WhatsApp messages, terms written on click-to-agree pages and who accepted them, custom fields, contacts, signing groups, and the plans and payments of accounts',
];
