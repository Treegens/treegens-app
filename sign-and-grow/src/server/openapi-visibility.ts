// What the API description says about "Each person sees only their files" (visibility.ts, src/lib/owndocs.ts), kept
// apart so the busy openapi.ts only needs a few references to it.
import { OTHER_DOC_LINE } from '../lib/owndocs.ts';

const RULE = 'With it on, each person is shown the files with their own fields, the files ticked for them in "also_sees", and (for a witness) what the person they witness is shown; a file with another person\'s field that one of their own formulas counts is shown to them too. Someone with no field and nothing ticked (a copy, a viewer), someone who can change the document ("editor") and someone who chooses who comes next ("agent") see every file. With fewer than two files it changes nothing.';

/** EnvelopeInput "own_docs". */
export const OWN_DOCS_PROP = {
  type: 'boolean', default: false,
  description: `"Each person sees only their files". ${RULE} On a signing link, a file a person is not shown is in no answer (the view, GET /sign/{token}/ocr, the summary, the files to read), its fields and the comments pinned to it are not there, and GET /sign/{token}/doc/{doc} answers 404 for it exactly as for a file that does not exist. Their "subject" (on the link, in every email, in file names) never names such a file: when the envelope's subject is empty or names one, theirs is "Please sign: <the first file they are shown>". A correction that changes only files they are not shown is not emailed to them, and their "changed" leaves it out. A file to read that no one has in "also_sees" goes to everyone; once someone has it there, only they get it. When everyone has finished, each person whose view is limited gets a completed copy of their own: their files and the certificate, which lists each other file as "${OTHER_DOC_LINE}" with its SHA-256 and no name; its audit trail names such a file "a document you were not shown". Each copy goes through the same finishing steps as the sender's (archive format, digital seal), is stored, and is found by /verify. That copy is what their link downloads and what their completed email attaches, with its own fingerprint. The sender's side (the sender, admins, GET /envelopes/{id}/download, the evidence pack, which also holds each own copy) always has every file. A new envelope or template starts with the account's "own_docs_default". Copied into everything made from a template or a copy (sign again, bulk sends, public forms). Once someone has finished, a save that would change which files they are shown is refused with 409, "code": "own_docs_locked", unless the same save asks them to sign again ("resign": true). Left out, it stays as it is; anything but true or false is refused with 400.`,
};

/** Recipient "also_sees". */
export const ALSO_SEES_PROP = {
  type: 'array', nullable: true, items: { type: 'string' },
  description: 'With "own_docs" on: ids of documents of this envelope this person is shown beside those with their own fields, as the same request names them. Ids of documents that are not on the envelope are dropped. null or [] for none. Left out, it stays as it is. Something that is not a list is refused with 400.',
};

/** PATCH /account "own_docs_default". */
export const OWN_DOCS_DEFAULT_PROP = { type: 'boolean', description: 'Whether new envelopes and templates start with "own_docs" on. Off until an admin turns it on. Documents already made keep what they have. Anything but true or false is refused with 400. Also in GET /me, under "account".' };

/** POST /public/verify "own_copy". */
export const OWN_COPY_PROP = { type: 'boolean', description: 'Present and true when the file is the completed copy made for one person who was shown only some of the files ("own_docs"): their files and the certificate. "envelope.subject" is then the subject as that person was shown it. Everything else in the answer is as for the sender\'s copy.' };

/** GET /public/verify/{id} "own_copies". */
export const OWN_COPIES_PROP = { type: 'array', items: { type: 'string' }, description: 'Present when people on it were shown only some of the files: the SHA-256 of each completed copy made for one of them, beside "sha256" of the sender\'s copy.' };
