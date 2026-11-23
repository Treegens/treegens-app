// What the API description says about Key dates (src/server/routes-airepo.ts), kept apart so the busy openapi.ts
// only needs two references to it.
import { TERM_KINDS, DATE_KINDS, REMIND_KINDS, AMOUNTS_MAX, REMIND_DAYS_MAX, TERM_NAMES, QUOTE_MIN } from '../lib/keydates.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const obj = (properties: any, required?: string[]) => ({ type: 'object', ...(required ? { required } : {}), properties });
const s = { type: 'string' }, b = { type: 'boolean' }, i = { type: 'integer' };
const GATE = 'Only while Key dates is on for the account (PUT /account/key-dates), which needs a model on the server, the account\'s AI switch and "Let the AI read document text"; 403 with "code": "key_dates_off" otherwise, and nothing is sent anywhere. A member reaches the envelopes they sent, an admin every envelope of the account.';
const term = obj({
  id: s, kind: { type: 'string', enum: [...TERM_KINDS] }, name: s, value: { type: 'string', description: `For ${DATE_KINDS.join(', ')}: a day as 2027-03-03.` }, day: { type: 'string', nullable: true },
  quote: { type: 'string', description: 'The words of the document it came from, checked to be on that page. Empty for one the sender added.' }, page: { type: 'integer', nullable: true, description: 'Counted from 1 across the documents of the envelope.' },
  document: { type: 'string', nullable: true }, status: { type: 'string', enum: ['proposed', 'confirmed'] }, found_by_ai: b, corrected: b, confirmed_at: { type: 'string', nullable: true },
});
const view = { description: 'The key dates of the envelope.', ...json(obj({ on: b, terms: { type: 'array', items: term }, reminder: { type: 'object', nullable: true, properties: { days: i } }, scan: { type: 'object', nullable: true, properties: { state: { type: 'string', enum: ['found', 'none', 'failed'] }, at: s } }, note: s })) };
const id = { name: 'id', in: 'path', required: true, schema: s };
const termId = { name: 'term', in: 'path', required: true, schema: s };

/** The filter of GET /envelopes. */
export const keyDatesListParams = () => [{ name: 'ends_within', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 3650 }, description: 'Key dates: only completed envelopes whose confirmed end date is from today (UTC) to this many days on. Proposals the sender did not confirm never count. 400 for anything but a whole number.' }];

export const keyDatesPaths = () => ({
  '/account/key-dates': {
    get: { summary: 'Whether Key dates is on', description: '"possible": the AI may read document text on this account. "on": Key dates is on. "since": when it was switched on; the timer reads documents completed after that by itself (KEY_DATES_PER_TICK a run). "older": an admin asked for older documents to be read too. "auto": the timer reads documents by itself on this server (false when KEY_DATES_PER_TICK is 0 or AI_ASSIST_DAILY_LIMIT is below 2); it uses at most half of the account\'s AI requests of the day, so people keep the other half.', responses: { 200: { description: 'The switch.', ...json(obj({ possible: b, on: b, since: { type: 'string', nullable: true }, older: b, auto: b })) }, default: err } },
    put: { summary: 'Switch Key dates on or off', description: 'Owners and admins, signed in to the app; an API key gets 403. Off by default. 409 with "code": "read_off" for true while "Let the AI read document text" is off. Written to the security record as "settings.changed" ("ai_key_dates"). While it is off, no reminder is emailed. Turning "Let the AI read document text" off (PUT /account/ai-read) turns Key dates off too, and turning that on again does not bring Key dates back: an admin switches it on again.', requestBody: { required: true, ...json(obj({ on: b }, ['on'])) }, responses: { 200: { description: 'The switch as it is now.', ...json({ type: 'object' }) }, default: err } },
  },
  '/account/key-dates/older': {
    post: { summary: 'Look through older documents', description: `Admins, signed in to the app; an API key gets 403. The timer then also reads completed documents from before the switch went on, a few at a time. Answers the switch with "waiting": how many completed documents wait to be read. ${GATE}`, responses: { 200: { description: 'Saved.', ...json({ type: 'object' }) }, default: err } },
  },
  '/key-dates': {
    get: { summary: 'Completed documents with key dates', description: `Each completed document that has key dates or was read for them, the one with the nearest confirmed ${REMIND_KINDS.join(', ')} date first, with its terms, "to_check" (proposals nobody confirmed), "next" and this person's "reminder". "waiting": completed documents not read yet. ${GATE}`, parameters: [{ name: 'within', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 3650 }, description: `Only those with a confirmed ${REMIND_KINDS.join(', ')} date from today to this many days on.` }], responses: { 200: { description: 'The list. Each document has "coming": its confirmed end, notice and renewal dates from today on. "calendar": the calendar file would hold at least one date.', ...json(obj({ documents: { type: 'array', items: { type: 'object' } }, waiting: i, setting: { type: 'object' }, calendar: b })) }, default: err } },
  },
  '/key-dates/calendar.ics': {
    get: { summary: 'The confirmed dates as a calendar file', description: `An iCalendar file (text/calendar) with one all-day event for each confirmed date of the documents this person may open. Proposals are never in it. ${GATE}`, responses: { 200: { description: 'The calendar file.', content: { 'text/calendar': { schema: { type: 'string' } } } }, default: err } },
  },
  '/envelopes/{id}/key-dates': {
    get: { summary: 'The key dates of one envelope', description: GATE, parameters: [id], responses: { 200: view, default: err } },
    post: { summary: 'Add a date or amount by hand', description: `{ "kind": one of ${TERM_KINDS.join(', ')}, "value" }. A date as 2027-03-03. Confirmed at once, and a detail of the envelope. One of each kind, up to ${AMOUNTS_MAX} amounts: 409 for more. Only on a completed envelope. ${GATE}`, parameters: [id], requestBody: { required: true, ...json(obj({ kind: s, value: s }, ['kind', 'value'])) }, responses: { 200: view, default: err } },
  },
  '/envelopes/{id}/key-dates/find': {
    post: { summary: 'Find the dates and amounts', description: `The AI reads the text of the completed envelope's documents (never a picture) and proposes ${TERM_KINDS.map((k) => TERM_NAMES[k].toLowerCase()).join(', ')}, each with the words it came from. A proposal whose words are not on a page of the document, whose words do not contain the value itself (the date written out, the numbers of the amount, the names of the parties), whose words are shorter than ${QUOTE_MIN} characters, a date that is not a real day, an unknown kind, or a value with a phone number, an email address or a request for payment details is dropped. What was confirmed stays; earlier proposals are replaced. Counts as one AI request of the day (AI_ASSIST_DAILY_LIMIT): 429 when the day is full, 503 with "code": "model_down" when the model does not answer (then not counted). 409 with "code": "not_completed" before completion. "found": how many were proposed; "message" when none. ${GATE}`, parameters: [id], responses: { 200: view, default: err } },
  },
  '/envelopes/{id}/key-dates/{term}': {
    put: { summary: 'Confirm or correct one', description: `Without "value": confirm it as it is. With "value": correct it (a date as 2027-03-03), and it is confirmed. From then on it is a detail of the envelope (custom_fields, never on the certificate), counts in the filter and the calendar file, and reminders are sent for it. A detail of the same name the envelope already has is never written over: "End date 2" is used. ${GATE}`, parameters: [id, termId], requestBody: { required: false, ...json(obj({ value: s })) }, responses: { 200: view, default: err } },
    delete: { summary: 'Remove one', description: `A wrong proposal, or a confirmed one with its detail on the envelope. ${GATE}`, parameters: [id, termId], responses: { 200: view, default: err } },
  },
  '/envelopes/{id}/key-dates-reminder': {
    put: { summary: 'Remind me, or stop', description: `{ "days": 1 to ${REMIND_DAYS_MAX} }: the caller is emailed that many days before each confirmed ${REMIND_KINDS.join(', ')} date, once for each date, by the day where they are. 409 with "code": "nothing_confirmed" while no such date is confirmed, and "code": "all_passed" when every such date is before today. { "days": null } stops it. Nothing is sent while Key dates is off, or to someone who can no longer open the document. ${GATE}`, parameters: [id], requestBody: { required: true, ...json(obj({ days: { type: 'integer', nullable: true } })) }, responses: { 200: view, default: err } },
  },
});
