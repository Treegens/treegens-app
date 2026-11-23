// What the API description says about Invite a friend (src/server/routes-referrals.ts and referrals.ts). Kept apart
// so the busy openapi.ts only needs one reference to it.
import { referralRuleText, referralRulesFrom } from '../lib/referral.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const obj = (properties: any) => ({ type: 'object', properties });
const s = { type: 'string' }, b = { type: 'boolean' }, n = { type: 'integer' };
const time = { type: 'string', format: 'date-time' };

const rules = obj({
  signatures: { ...n, description: 'Free signatures the inviter and the friend each get (REFERRAL_SIGNATURES).' },
  expiry_days: { ...n, description: 'Days they last from the day they arrive (REFERRAL_EXPIRY_DAYS).' },
  monthly_max: { ...n, description: 'The most rewarded friends in a calendar month, UTC (REFERRAL_MONTHLY_MAX).' },
  total_max: { ...n, description: 'The most rewarded friends ever (REFERRAL_TOTAL_MAX).' },
});

export const referralsPaths = () => ({
  '/referrals': {
    get: {
      summary: 'The invite link of this account and what it has earned',
      description: `${referralRuleText(referralRulesFrom(process.env))} The reward signatures are a lot with source "referral" in GET /billing. No friend is named here: the answer holds counts only. "on" is false where signatures are not counted (no payment provider, or BILLING_MODE=deployment) and with REFERRALS=0; the other fields are then left out. Asking also gives any reward that is due.`,
      responses: { 200: { description: 'The link, the counts and the numbers of the rules.', ...json(obj({
        on: b, code: s, url: { type: 'string', format: 'uri', description: 'The link to pass on: <site>/r/<code>. It opens the sign-up page.' }, rules,
        joined: { ...n, description: 'Friends who signed up through the link and were not refused.' },
        rewarded: { ...n, description: 'Friends this account was rewarded for.' },
        waiting: { ...n, description: 'Friends whose account is not real yet.' },
        signatures: { ...n, description: 'Free signatures earned so far.' },
        month_left: n, total_left: n,
        open: { ...b, description: 'false once a limit is reached, or while the account is paused or being closed: friends who join then earn nothing.' },
        emails: { ...b, description: 'Whether the owner is emailed when a reward lands.' },
      })) }, default: err },
    },
  },
  '/public/referrals/{code}': {
    get: {
      summary: 'Whether an invite code still counts',
      description: 'Asked by the sign-up page. No login. The answer never says whose link it is. When the code counts, the browser is given a cookie that keeps it for 30 days, so the invite also counts after signing up with Google or Microsoft. A sign-up may also send the code as "ref" in the body of POST /auth/signup.',
      security: [], parameters: [{ name: 'code', in: 'path', required: true, schema: s }],
      responses: { 200: { description: 'ok is false for a code we do not know, a link at its limit, and where the offer is off.', ...json(obj({ ok: b, signatures: n, expiry_days: n })) }, default: err },
    },
  },
  '/public/referral-emails': {
    get: {
      summary: 'The page behind "Stop these emails" in a reward email',
      description: 'No login: the token in the link names the account. Opening the page changes nothing; its one button does (POST).',
      security: [], parameters: [{ name: 'token', in: 'query', required: true, schema: s }],
      responses: { 200: { description: 'A small page.', content: { 'text/html': { schema: s } } }, default: err },
    },
    post: {
      summary: 'Stop, or send again, the emails about invited friends',
      description: 'emails=off stops them, emails=on sends them again. Rewards arrive either way.',
      security: [], parameters: [{ name: 'token', in: 'query', required: true, schema: s }, { name: 'emails', in: 'query', schema: { type: 'string', enum: ['on', 'off'] } }],
      responses: { 200: { description: 'The same page, saying where it stands now.', content: { 'text/html': { schema: s } } }, default: err },
    },
  },
  '/operator/referrals': {
    get: {
      summary: 'Who invited whom (operators)',
      description: 'For the people in OPERATOR_EMAILS, signed in; 404 for anyone else. Every invite, newest first: the inviting account, the friend, where it stands (pending, rewarded, refused, taken_back), why, and how many signatures each side got.',
      parameters: [{ name: 'limit', in: 'query', schema: n }, { name: 'account_id', in: 'query', schema: s, description: 'Only invites this account made or came through.' }],
      responses: { 200: { description: 'The record.', ...json(obj({ on: b, referrals: { type: 'array', items: obj({
        id: s, at: time, status: { type: 'string', enum: ['pending', 'rewarded', 'refused', 'taken_back'] }, decided_at: { ...time, nullable: true }, reason: s,
        inviter: obj({ account_id: s, account: s, email: s, signatures: n }), friend: obj({ account_id: s, account: s, email: s, name: s, signatures: n }),
        taken_back_at: { ...time, nullable: true }, taken_back: n,
      }) } })) }, default: err },
    },
  },
});
