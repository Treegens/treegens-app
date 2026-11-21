// Archive addresses, as part of /api/openapi.json (routes-archive.ts). Kept apart so the main description stays
// readable; openapi.ts spreads it into its paths.
import { ARCHIVE_MAX_ADDRESSES, ARCHIVE_BOUNCES_TO_PAUSE, ARCHIVE_CONFIRM_DAYS, ARCHIVE_ASKS_PER_DAY, ARCHIVE_ASKS_PER_ADDRESS_DAY, ARCHIVE_REFUSED_DAYS, ARCHIVE_WHAT, ARCHIVE_LIMITS, ARCHIVE_LINK_REMOVED } from '../lib/archivemail.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const s = { type: 'string' };
const time = { type: 'string', format: 'date-time' };

const address = {
  type: 'object',
  properties: {
    id: s, email: s,
    state: { type: 'string', enum: ['waiting', 'confirmed', 'paused', 'expired'], description: `"waiting": asked, not confirmed yet, nothing is sent there. "confirmed": it gets the copies. "paused": ${ARCHIVE_BOUNCES_TO_PAUSE} copies came back with none arriving in between, or a copy was marked as spam; no copies go there until it is confirmed again. "expired": the link ran out after ${ARCHIVE_CONFIRM_DAYS} days.` },
    added_at: time, added_by: { ...s, nullable: true }, link_sent_at: { ...time, nullable: true }, link_works_until: { ...time, nullable: true }, confirmed_at: { ...time, nullable: true },
    copies: { type: 'integer', description: 'Copies handed to the mail server so far.' }, last_copy_at: { ...time, nullable: true },
    bounces: { type: 'integer' }, paused_at: { ...time, nullable: true }, paused_why: { type: 'string', enum: ['bounced', 'spam'], nullable: true },
    missed: { type: 'integer', description: 'Emails that were not copied there while it was paused. They are not sent later.' },
    problem: { ...s, nullable: true }, problem_at: { ...time, nullable: true },
  },
};

export function archivePaths() {
  return {
    '/account/archive-addresses': {
      get: {
        summary: 'The addresses that get a copy of every email about the account\'s documents',
        description: `${ARCHIVE_WHAT} ${ARCHIVE_LIMITS} A link is replaced by "${ARCHIVE_LINK_REMOVED}". Admins get the whole list. A member, and an API key without the admin scope, get only "taking": how many addresses take copies.`,
        responses: ok({ type: 'object', properties: { may_change: { type: 'boolean', description: 'false for members and for every API key.' }, taking: { type: 'integer' }, max: { type: 'integer', example: ARCHIVE_MAX_ADDRESSES }, addresses: { type: 'array', items: address }, refused: { type: 'array', items: { type: 'object', properties: { email: s, at: time, can_ask_again_at: time } }, description: `Addresses whose reader answered "This was not me". The account cannot ask them again for ${ARCHIVE_REFUSED_DAYS} days.` }, bounce_news: { type: 'boolean', description: 'Whether this server hears from its mail provider when an email comes back. Without that, an address that stopped working is not paused.' } } }),
      },
      post: {
        summary: 'Add an archive address, or send its link again (admins, signed in)',
        description: `Up to ${ARCHIVE_MAX_ADDRESSES} addresses. We email the address a link, which works for ${ARCHIVE_CONFIRM_DAYS} days. Nothing else is sent there until someone with that inbox presses Confirm on the page it opens. The same call for an address that is waiting, expired or paused sends a new link, at most ${ARCHIVE_ASKS_PER_ADDRESS_DAY} times a day for one address and ${ARCHIVE_ASKS_PER_DAY} for the account. An API key is refused with 403: an address added by a leaked key would receive the account's emails.`,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { ...s, format: 'email' } } } } } },
        responses: ok({ type: 'object', properties: { ok: { type: 'boolean' }, address, delivery: { type: 'string', enum: ['sent', 'outbox', 'failed', 'queued'] }, message: s } }),
      },
    },
    '/account/archive-addresses/{id}': {
      delete: {
        summary: 'Remove an archive address (admins, signed in)',
        description: 'It gets no more copies, also none that were waiting to go. The owner and the admins are emailed when a confirmed address is removed. An API key is refused with 403.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: s }],
        responses: ok({ type: 'object', properties: { ok: { type: 'boolean' }, message: s } }),
      },
    },
  };
}
