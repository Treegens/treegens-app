// What the proof around a signed document does and does not show, in the words the pages, the evidence pack and the
// README use, so none of them claims more than the code does. Plain constants, so a 'use client' file may import them.
// The code these sentences describe: audit() and verifyChain() in src/server/envelopes.ts (the chain), POST
// /public/verify in src/server/routes-account.ts (the file check), src/server/evidence.ts (what is kept after a
// deletion, the lookup by envelope ID, disputes and the evidence pack). Change the words when the code changes.

/** What a match on /verify shows. "Authentic" would read as "these people really signed", which no file check shows. */
export const MATCH_MEANS = 'This is, byte for byte, the file we stored when the last person finished. So it has not been changed since. It does not show who was behind each signature: every name is the one the sender typed, attached to whoever used that person\'s link, and the sender can use a link too.';

/** Why a file can fail to match, for the person holding it. Each is a real way to get "no match". */
export const NO_MATCH_CAUSES: string[] = [
  'It was changed after signing, even by one byte.',
  'It was saved again by a PDF viewer or a browser ("Save as", "Print to PDF", filling in or turning a page). That writes a new file, even when the pages look the same.',
  'It is a printout or a scan of the document.',
  'Its sender deleted it, with their account, more than a year ago. After such a deletion we keep only the fingerprint of the signed file, for one year.',
  'It was never completed here: it comes from another service, or from a document that was cancelled, declined or ran out of time before everyone had finished.',
];

/** The hash chain, exactly as far as it goes (see verifyChain in src/server/envelopes.ts). */
export const CHAIN_TRUTH = 'Each line of the audit trail carries a SHA-256 fingerprint made from the line itself and the fingerprint of the line before it. Changing or removing a past line without recomputing every line after it breaks the chain, and the app then shows that the record was altered. The chain has no secret key and is kept in the same database as the lines. So whoever can write to that database, the people who run the server or someone who broke into it, could change a line and recompute the rest, and the app would still show the record as intact. What would show such a rewrite is the chain head printed on the certificate of the completed PDF that each person was emailed: the stored trail must still lead to that same value. Before completion the chain is only ours to vouch for. When a time-stamp service is set up, the chain head at completion is also time-stamped by that service, and after it, rewriting shows against the time stamp: a rewritten and recomputed chain no longer has the value the service signed, and nobody here can make that service sign another value with an earlier time. That holds when it is checked outside this server: the time stamp in the evidence pack, checked with OpenSSL against the service\'s own root certificate, over the chain head printed on the certificate each person was emailed. The check on the document page cannot stand alone against whoever can write the database: they could delete our copy of the time stamp, or put in its place one from a time-stamp service they made themselves. Only when the people who run the server have set up a list of trusted services (TSA_TRUST) does the page accept a time stamp from those alone. The time stamp is evidence of time from that service, nothing more. That head covers the lines up to completion only. Lines written after it (the completed copy being emailed and opened, later visits, disputes and their closing) are protected by nothing outside our database. The browser description stored with a line is not part of its fingerprint.';

/** What the certificate's names, times and places are. */
export const WHO_WHEN_WHERE = 'A name is the one the sender typed, attached to whoever used that person\'s link, which can be the sender. Times are in UTC. An internet address is a connection, not a place: many people can share one, and it can be the sender\'s own.';

/**
 * The day /security/certificate was last written from drawCertificate() in src/server/pdf.ts. Whoever changes what the
 * certificate prints changes that page and this date in the same change.
 */
export const CERTIFICATE_PAGE_VERSION = '2026-11-21';

/** After a deletion: what /verify still knows about a completed file, and for how long. */
export const FINGERPRINT_KEPT_DAYS = 365;

// "I did not sign this, or this was not me" (fileDispute in src/server/evidence.ts). Said on every screen before the
// person sends it, so they know exactly what the sender will be given, and what only the operators get.
/** What a dispute does, in one line. */
export const DISPUTE_DOES = 'It marks the document as disputed, for its sender and for anyone who checks it on our Verify page. Nothing is changed, held or deleted, and we do not decide who is right.';
/** What the sender is given, and what is not given to them. `sender` is their name, or "The sender". */
export const disputeSenderSees = (sender: string) => `${sender} will see that you dispute it, the date and time, which email or link was used (by the name and address it was sent to), and what you write below, word for word. ${sender} will not see your internet address or which browser or device you use: those go only to the people who run GrowSigning, together with your words.`;
/** After a deletion: what is kept of a dispute that is still open, and until when. */
export const DISPUTE_KEPT = 'When a disputed document is deleted with its sender\'s account, we keep its envelope ID, the fingerprint of its signed file, the day of the dispute and its state, with no names and no addresses, until a person at GrowSigning has closed the dispute. The alert our team works from keeps the names and what was written until it is closed, then it is deleted like any help request.';
