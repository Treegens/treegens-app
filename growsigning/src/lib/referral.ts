// Invite a friend (refer-a-friend). Plain rules and words, no database and no React, so the server, the screens and
// the tests read the same ones. The server side is src/server/referrals.ts.
//
// Every account has one invite link: <site>/r/<code>, which opens the sign-up page (/signup?ref=<code>). When the
// friend's account is real (their email is confirmed, they gave a phone number, and someone has signed a document
// they sent), the inviter and the friend each get REFERRAL_SIGNATURES free signatures. They are a lot of their own in
// the ledger (source "referral", src/server/credits.ts), they expire REFERRAL_EXPIRY_DAYS days after they arrive, as
// the trial's do after sign-up, and each one plants trees when it is signed, like every other signature.

/**
 * Whether the offer exists on this server: signatures are counted (a payment provider is connected), it is not a
 * server under a yearly agreement, and REFERRALS is not 0. The public pages and the server ask the same question.
 */
export const referralOfferOn = (env: Record<string, string | undefined>): boolean =>
  !!env.STRIPE_SECRET_KEY && (env.BILLING_MODE || '').trim().toLowerCase() !== 'deployment' && env.REFERRALS !== '0';

/** The numbers of the offer. The server reads them from REFERRAL_* (referralSettings in src/server/referrals.ts). */
export type ReferralRules = { signatures: number; expiry_days: number; monthly_max: number; total_max: number };
export const REFERRAL_DEFAULTS: ReferralRules = { signatures: 3, expiry_days: 30, monthly_max: 10, total_max: 30 };

/** A whole number from the environment, or the default when it is missing or makes no sense. */
const whole = (v: string | undefined, fallback: number, min = 1, max = 1000): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
export const referralRulesFrom = (env: Record<string, string | undefined>): ReferralRules => ({
  signatures: whole(env.REFERRAL_SIGNATURES, REFERRAL_DEFAULTS.signatures, 1, 100),
  expiry_days: whole(env.REFERRAL_EXPIRY_DAYS, REFERRAL_DEFAULTS.expiry_days, 1, 3650),
  monthly_max: whole(env.REFERRAL_MONTHLY_MAX, REFERRAL_DEFAULTS.monthly_max, 0, 100000),
  total_max: whole(env.REFERRAL_TOTAL_MAX, REFERRAL_DEFAULTS.total_max, 0, 100000),
});

// The code in the link: small letters and digits without look-alikes, the alphabet of our other short codes.
export const REFERRAL_CODE_LENGTH = 8;
export const isReferralCode = (s: unknown): s is string => typeof s === 'string' && /^[a-hjkmnp-z2-9]{6,12}$/.test(s);
export const referralPath = (code: string) => `/r/${code}`;

/**
 * An email address as one person: small letters, nothing after a plus sign, and for Gmail no dots and one domain.
 * "Ann.Lee+work@GoogleMail.com" and "annlee@gmail.com" are the same mailbox, so they are the same friend.
 */
export function normalEmail(email: unknown): string {
  const s = String(email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  let local = s.slice(0, at).split('+')[0];
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
/** A phone number as digits only, without the zeros or the plus in front, so two spellings of one number match. */
export const normalPhone = (phone: unknown): string => String(phone ?? '').replace(/\D/g, '').replace(/^0+/, '');

// Why an invite brought no reward. Kept on the record for the operators; never shown to the friend.
export const REFERRAL_REFUSALS = {
  same_email: 'The friend has the same email address as someone in the inviting account.',
  same_account: 'The friend already belongs to the inviting account.',
  same_phone: 'The friend gave the same phone number as someone in the inviting account.',
  phone_used: 'That phone number already earned a reward as another friend.',
  same_device: 'The friend signed up on a device the inviting account was used on.',
  same_ip: 'The friend signed up from the same internet address as the inviting account within a day.',
  same_card: 'The friend paid with the same card as the inviting account.',
  disposable: 'The friend signed up with a throwaway email address.',
  welcomed_before: 'That email address had a GrowSigning login before, so it is not a new friend.',
  total_limit: 'The inviting account had reached its limit of rewarded friends.',
  inviter_closed: 'The inviting account was paused for abuse or is being closed.',
  friend_closed: 'The friend\'s account was paused for abuse.',
} as const;
export type ReferralRefusal = keyof typeof REFERRAL_REFUSALS;

/** The whole offer in plain sentences, for the pricing page, the help page, the chat helper and the API description. */
export const referralRuleText = (r: ReferralRules = REFERRAL_DEFAULTS): string =>
  `Every account has an invite link, on the Plan page. When a friend signs up through it, confirms their email, gives a phone number and has a first document signed by someone they sent it to, you and your friend each get ${r.signatures} free signatures. They last ${r.expiry_days} days from the day they arrive and plant trees like any other signature. You pass the link on yourself: we never write to your friends. One reward per friend, up to ${r.monthly_max} rewarded friends a month and ${r.total_max} in all. An invite does not count for a second account of your own: the same email address, the same phone number, the same device, or the same internet connection within a day. A reward is taken back if the friend's account is paused for abuse.`;
