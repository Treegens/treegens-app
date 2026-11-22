// AI help when sending and signing (src/server/aiassist.ts has the server side, src/server/routes-aiassist.ts the
// routes): fields suggested from the text of pages where 'Place fields for me' found nothing, a plain summary for
// signers, and a drafted subject and message. The rules, numbers and words that pages and the server share live here.
//
// Three switches decide, all three needed for anything that reads a document:
//   1. a model on this server: the help chat's own (src/lib/chatprovider.ts chatModelOn), one client, one key;
//   2. the account's AI switch, "AI answers in the help chat" (accounts.ai_helper, src/server/tenantpolicy.ts);
//   3. for document text only: "Let the AI read document text" (accounts.ai_read_text), off until an admin turns it on.
// Draft a message needs 1 and 2: it then uses only the document names and the people. With 3 it may read the text too.
// Suggested fields and the summary need all three. Without them nothing here sends anything anywhere.

/** The field kinds a suggestion may be. Anything else the model answers is dropped. */
export const SUGGEST_TYPES = ['signature', 'initials', 'date_signed', 'full_name', 'text', 'checkbox'] as const;
export type SuggestType = (typeof SUGGEST_TYPES)[number];
export const SUGGEST_WORDS: Record<SuggestType, string> = { signature: 'Signature', initials: 'Initials', date_signed: 'Date signed', full_name: 'Name', text: 'Text', checkbox: 'Checkbox' };

/** At most this many pages are sent in one ask, and this many characters of their text in all. */
export const SUGGEST_PAGES_MAX = 10;
export const SUGGEST_CHARS_MAX = 12_000;
/** At most this many text runs per page, and suggestions kept per ask. */
export const SUGGEST_ITEMS_MAX = 400;
export const SUGGEST_KEEP_MAX = 40;
/** The page is sent to the model in these units, top left at 0,0. Its answer uses the same units. */
export const GRID = 1000;

/** How many asks (suggestions, drafts and summaries together) one account may make in a day (UTC), by default. */
export const AI_ASSIST_DAILY_DEFAULT = 100;
/** The most characters of one document that are sent for a summary or a draft. */
export const SUMMARY_TEXT_MAX = 30_000;
export const SUMMARY_MAX = 2_500;
export const DRAFT_SUBJECT_MAX = 120;
export const DRAFT_MESSAGE_MAX = 900;

import { chatModelOn } from './chatprovider.ts';

// ---- Words ---------------------------------------------------------------------------------------------------------
export const READ_SWITCH = 'Let the AI read document text';
/** One line on what the switch is for. The Settings card puts whereLine under it; 'Saved' says it saved. */
export const READ_HINT = 'Lets the AI read your documents to suggest fields, write a summary for signers and draft messages.';
export const SUMMARY_LINK = 'Summary (written by AI, check it)';
export const SUMMARY_WARNING = 'Made by an AI. It may be wrong. It is not the agreement and not legal advice. Read the document.';
export const SUMMARY_CHOICE = 'Plain summary for signers';
export const SUMMARY_CHOICE_HINT = 'Signers see a link above the document to a short summary written by AI. It never changes what is signed.';
/** POST /sign/:token/summary once the person finished: the record line must never come after a signature. */
export const SUMMARY_AFTER = 'This document is finished, so its summary is no longer shown. The document itself is what was signed.';
/** Said to someone who finished while others still have the document. */
export const SUMMARY_AFTER_YOU = 'You have finished this document, so its summary is no longer shown to you. The document itself is what counts.';
export const DRAFT_BUTTON = 'Draft a message';
export const MODEL_DOWN = 'The AI is not answering just now. Nothing was changed. Try again in a few minutes, or carry on without it.';
export const DAILY_FULL = (n: number) => `Your account has used its ${n} AI requests for today. Nothing was changed. You can ask again tomorrow, or carry on without it.`;
export const SUMMARY_DOWN = 'The summary could not be written just now. Read the document itself; it is all you need to sign.';
export const DRAFT_REFUSED = 'The AI wrote words that look like a fake bill or notice from a company, so we did not use them. Write the message yourself.';
export const NOT_ALLOWED = 'AI help is not switched on for this account. An admin can turn it on in Settings, Account.';
export const READ_OFF = 'The AI may not read document text on this account. An admin can turn on "Let the AI read document text" in Settings, Account.';

/** The line the Settings card shows under the switch: who gets the text, on which host and in which country. */
export function whereLine(o: { name: string; model: string; host: string; country: string | null }): string {
  return `The text goes to ${o.name} (${o.host}), which runs the model ${o.model}${o.country ? `, in ${o.country}` : ''}.${o.country ? '' : ' Whoever runs this server has not said in which country.'}`;
}

/** AI_ASSIST_DAILY_LIMIT: asks per account per day (UTC), all three kinds together. 0 switches this help off. */
export const assistLimit = (env: Record<string, string | undefined> = process.env): number => {
  const raw = (env.AI_ASSIST_DAILY_LIMIT ?? '').trim();
  const n = Number(raw === '' ? NaN : raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : AI_ASSIST_DAILY_DEFAULT;
};
/** One sentence for the list of outside services: when the help chat's model reads document text. */
export const READ_OUTSIDE = 'It reads document text only for accounts whose admin switched on "Let the AI read document text": the text of pages for suggested fields, of a document whose sender offers signers a summary, and of completed documents on accounts that also switched on Key dates.';

/** Can any account on this server let the AI read document text? A model, and a daily number above 0. */
export const readPossible = (env: Record<string, string | undefined> = process.env): boolean => chatModelOn(env) && assistLimit(env) > 0;

/** What /security and /security/processing say about document text and the AI. True of src/server/aiassist.ts. */
export const READ_SENT = 'Only for accounts whose admin switched on "Let the AI read document text": the text of the pages where Place fields for me found nothing, with where each word sits on the page (never a picture of the page), for a document whose sender switched on the plain summary, the text of that document, and, where an admin also switched on Key dates, the text of completed documents, to find their dates and amounts. Draft a message, also with the switch off, sends the document names, the sender\'s name and account name, and the names and roles of the people on it; the document text only when the switch is on.';
export const READ_KEPT = 'A summary is kept with the file it was written from, so it is written once, and is deleted with that file. Suggestions and drafted messages are not kept by us; the sender decides what to use. Key dates the AI found are kept with their document (encrypted with the file key when one is set) until the sender takes them off, and are deleted with it.';
/** Who the AI service hears about, where AI help when sending and signing is possible (src/lib/dataplace.ts). */
export const READ_WHO = 'Anyone who types into the help chat: visitors, signers and account holders. Also senders who use AI help when sending, and the people named in their documents and messages.';
/** The end of the sentence on /security and /security/processing that says what the one AI service gets. */
export const READ_ALSO = ', the document names and the names of the sender and the people on it when a sender presses Draft a message, and document text only where an account\'s admin switched on "Let the AI read document text"';
