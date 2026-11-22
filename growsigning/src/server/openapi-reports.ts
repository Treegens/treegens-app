// Reports, the monthly report email and saved lists for Send to many, as part of /api/openapi.json
// (routes-reports.ts, routes-bulklists.ts). Kept apart so the main description stays readable; openapi.ts spreads it in.
import { REPORT_STATUSES, REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, REPORT_CSV_HEAD, LIST_DAYS_DEFAULT, LIST_DAYS_MIN, LIST_DAYS_MAX, LIST_MAX_ROWS, LIST_MAX_BYTES, LIST_NAME_MAX, LISTS_PER_ACCOUNT } from '../lib/reports.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const s = { type: 'string' };
const n = { type: 'integer' };
const time = { type: 'string', format: 'date-time' };
const idParam = { name: 'id', in: 'path', required: true, schema: s };
const q = (name: string, description: string, schema: any = s) => ({ name, in: 'query', schema, description });

const filters = [
  q('from', `First day, YYYY-MM-DD in UTC. Default: ${REPORT_DEFAULT_DAYS - 1} days before "to".`, { type: 'string', format: 'date' }),
  q('to', 'Last day, YYYY-MM-DD in UTC, included. Default: today.', { type: 'string', format: 'date' }),
  q('status', 'Only envelopes in this state now.', { type: 'string', enum: [...REPORT_STATUSES] }),
  q('sender', 'Admins: one sender\'s user id. A member asking for anyone but themselves gets 403.'),
  q('template', 'A template id, or "none" for envelopes sent without a template.'),
  q('folder', 'Only envelopes in this folder.'),
  q('field', 'The name of a custom field, as on GET /envelopes.'),
  q('value', 'With "field": its value. A value typed in part finds what starts with it; a list of choices is matched whole. Empty: any value.'),
];
const row = { type: 'object', properties: { key: { ...s, description: 'The template id ("none" for no template), the sender\'s user id, or "all".' }, name: s, sent: n, completed: n, declined: n, voided: n, expired: n, waiting: { ...n, description: 'Still out ("sent").' }, median_hours: { type: 'number', nullable: true, description: 'Median hours from sending to finishing, over the finished ones. null when none finished.' } } };
const list = { type: 'object', properties: { id: s, name: s, rows: n, created_by: { ...s, description: 'The name of who saved it, or "A former team member" after their login was deleted.' }, created_at: time, used_at: { ...time, nullable: true }, deletes_at: { ...time, description: 'When the timer deletes it unless it is used before.' }, may_delete: { type: 'boolean' } } };

export function reportPaths() {
  return {
    '/reports': { get: { summary: 'Which documents get finished, how long it takes, and which stall', description: `Envelopes sent in the period (by the day they were sent, in UTC; at most ${REPORT_MAX_DAYS} days), not drafts or templates. A completed envelope its sender deleted from their lists is counted nowhere, as in GET /reports/summary and the lists. A member gets their own sending only and no "senders"; an admin gets every sender. "choices" lists what the filters can be set to. 400 for a day that cannot be read, a first day after the last, or an unknown status.`, parameters: filters,
      responses: ok({ type: 'object', properties: { from: s, to: s, totals: row, templates: { type: 'array', items: row, description: 'Most sent first. "Sent without a template" and "A template that was deleted" are rows of their own.' }, senders: { type: 'array', items: row }, months: { type: 'array', items: { type: 'object', properties: { month: s, sent: n, completed: n } } }, byStatus: { type: 'object', additionalProperties: n }, impact: { type: 'object' }, may_see_senders: { type: 'boolean' }, choices: { type: 'object', properties: { templates: { type: 'array', items: { type: 'object', properties: { id: s, name: s } } }, folders: { type: 'array', items: s }, senders: { type: 'array', items: { type: 'object', properties: { id: s, name: s } } }, statuses: { type: 'array', items: s } } } } }) } },
    '/reports/csv': { get: { summary: 'The same report as a CSV file', description: `The numbers GET /reports gives for the same filters, one row for all, one per template and (admins) one per sender, with the columns ${REPORT_CSV_HEAD.join(', ')}. A cell that starts with =, +, - or @ gets a ' in front, so a spreadsheet does not run it.`, parameters: filters, responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: s } } }, default: err } } },
    '/reports/monthly': {
      get: { summary: 'Whether you get the monthly report by email', responses: ok({ type: 'object', properties: { may: { type: 'boolean', description: 'Owners and admins of an account with at least two people that has sent something, or when it is on. PUT works for any owner or admin.' }, on: { type: 'boolean' } } }) },
      put: { summary: 'Ask for the monthly report by email, or stop it', description: 'Off by default. For owners and admins (403 for members). On the first day of each month (UTC), or the second or third when the timer did not run before, last month\'s numbers for the whole account: totals and the five templates sent most, with templates that stall. It names templates, never team members or the people documents went to. A month the timer did not run on days 1 to 3 is skipped. A month with nothing sent sends no email. From the month after you switch it on.', requestBody: body({ type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } }), responses: ok({ type: 'object', properties: { on: { type: 'boolean' } } }) },
    },
    '/bulk-lists': {
      get: { summary: 'The team\'s saved lists for Send to many', description: `Everyone in the account sees every list. A list nobody opened for "days" days (default ${LIST_DAYS_DEFAULT}) is deleted by the timer. Lists are in the export (lists/) and go with the account.`, responses: ok({ type: 'object', properties: { lists: { type: 'array', items: list }, days: n, min_days: n, max_days: n, may_change_days: { type: 'boolean' }, personal_data: { ...s, description: 'The sentence the screens show about personal data in a list.' } } }) },
      post: { summary: 'Save a list under a name', description: `"csv": the list as it was pasted or uploaded (up to ${LIST_MAX_BYTES / 1_000_000} MB and ${LIST_MAX_ROWS} people). It is kept as it is, and checked against a template when it is used (as any list on the Send to many page, and POST /bulk/check). How many people it holds ("rows") is counted by the server: every line with something in it, less the first when that line has no email address in it (a header row). A "rows" sent with it is not used. A list needs at least one person (a header row alone is refused with 400). Names up to ${LIST_NAME_MAX} characters, without direction marks or other invisible characters (they are dropped), one list per name (409), up to ${LISTS_PER_ACCOUNT} lists an account.`, requestBody: body({ type: 'object', required: ['name', 'csv'], properties: { name: s, csv: s } }), responses: ok({ type: 'object', properties: { list } }) },
    },
    '/bulk-lists/{id}': {
      get: { summary: 'One list with what it holds', description: 'Opening it counts as using it, so it is kept for another period.', parameters: [idParam], responses: ok({ type: 'object', properties: { list: { ...list, properties: { ...list.properties, csv: s } } } }) },
      delete: { summary: 'Delete a list', description: 'The person who saved it, or an admin (403 for anyone else). Documents already sent to it are not affected.', parameters: [idParam], responses: ok({ type: 'object' }) },
    },
    '/bulk-lists/settings': { put: { summary: 'After how many days an unused list is deleted (admins)', description: 'A number that would make the next check delete lists nobody used for that many days is refused with 409, code "lists_would_be_deleted" and "deleting" (how many), unless "confirm" is true. Nothing changes on a refusal.', requestBody: body({ type: 'object', required: ['days'], properties: { days: { ...n, minimum: LIST_DAYS_MIN, maximum: LIST_DAYS_MAX }, confirm: { type: 'boolean', description: 'true: save even though it deletes lists at the next check.' } } }), responses: ok({ type: 'object', properties: { days: n, deleting: { ...n, description: 'How many lists the next check deletes because of this number.' } } }) } },
  };
}
