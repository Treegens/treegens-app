// What an account has switched on or off for itself, read in one place. Nothing else reads these columns.
//
//   impact_display  the tree and paper lines on screens and in emails: next to Finish, the finished screen, the email
//                   that asks someone to sign and the completion email, and the sender's envelope page and review
//                   step. Off: none of them is shown. The count of what was planted goes on all the same
//                   (src/server/impact.ts), and the Plan page and the Trees planted page are not changed by it.
//   impact_record   the box "Signed without paper" on the signing record ('Trees on the signing record', kept in
//                   accounts.cert_impact_off by src/server/routes-impact.ts). Under DEPLOYMENT_PROFILE=government it
//                   is off for every account and cannot be switched on (owner's answer, 2026-11-20: trees off the
//                   certificate for government tenants only).
//   ai_helper       AI answers in the help chat, for the account's people and for the people who sign its documents.
//                   Off: their questions never go to the model; the built-in answers and Talk to a person stay.
//   white_label     kept for a later feature. Always false until that is built; nothing can set it.
//
// An account that has not chosen (NULL) has both on, under every profile: the owner asked that signers are told what
// their signature plants, and for an AI helper that helps with everything (research/government.json, critic G01, and
// the designer's notes gov-G01 and gov-G20). What DEPLOYMENT_PROFILE=government changes is elsewhere: the record never
// carries trees (above), and no hosted AI service is ever used, so a model answers only once the operator points the
// chat at one of their own (chatModelOn in src/lib/chatprovider.ts).
import { get, run } from './db.ts';
import { isGovernment } from '../lib/deployment.ts';
import { chatModelOn } from '../lib/chatprovider.ts';
import { refuseLoosening } from './orgs.ts';

export type OnOff = 'on' | 'off';
export type TenantPolicy = { impact_display: OnOff; impact_record: OnOff; ai_helper: OnOff; white_label: boolean };
/** What a page may know. The same as TenantPolicy today: nothing in it is a secret. */
export type ClientPolicy = { impact_display: OnOff; ai_helper: OnOff; white_label: boolean };

const chosen = (v: unknown): OnOff | null => (v === 'on' || v === 'off' ? v : null);

/** What an account that never chose has: on, under every profile (see the top of this file). */
export const POLICY_DEFAULT: OnOff = 'on';

/** The one reader. An account that does not exist reads as the defaults. */
export function tenantPolicy(accountId: string | null | undefined): TenantPolicy {
  const a = accountId ? get('SELECT impact_display, ai_helper, cert_impact_off FROM accounts WHERE id=?', accountId) : null;
  return {
    impact_display: chosen(a?.impact_display) ?? POLICY_DEFAULT,
    impact_record: isGovernment() || a?.cert_impact_off ? 'off' : 'on',
    ai_helper: chosen(a?.ai_helper) ?? POLICY_DEFAULT,
    white_label: false,
  };
}

/**
 * The shape GET /api/me and GET /api/sign/:token give a page. "ai_helper" is what happens, not only what the account
 * chose: 'on' only where a model answers the chat on this server too (aiAnswersFor), so a page that trusts it never
 * shows AI wording the server does not keep. What the account chose is in GET /account/policy.
 */
export function clientPolicy(accountId: string | null | undefined): ClientPolicy {
  const p = tenantPolicy(accountId);
  return { impact_display: p.impact_display, ai_helper: aiAnswersFor(accountId) ? 'on' : 'off', white_label: p.white_label };
}

/** May tree lines be shown on screens and in emails about this account's documents? */
export const showsTrees = (accountId: string | null | undefined): boolean => tenantPolicy(accountId).impact_display === 'on';

/** May the signing record of this account's documents end with the box on trees and paper? (pdf.ts asks this.) */
export const recordShowsTrees = (accountId: string | null | undefined): boolean => tenantPolicy(accountId).impact_record === 'on';

/**
 * Does a model answer the help chat for this account's people and signers? Only when one answers on this server at
 * all (chatModelOn, which under the government profile is never a hosted service) and the account has it on. With no
 * account (a visitor on a public page) the server's own rule decides.
 */
export const aiAnswersFor = (accountId: string | null | undefined): boolean => chatModelOn() && (!accountId || tenantPolicy(accountId).ai_helper === 'on');

/** The account behind a signing link, or null for a link that does not exist. */
export function accountOfLink(token: string | null | undefined): string | null {
  if (!token) return null;
  return get('SELECT e.account_id x FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.token=?', String(token))?.x || null;
}

/** Writes what an admin chose. Returns what it was and what it is, for the account's history. */
export function setTenantPolicy(accountId: string, change: { impact_display?: OnOff; ai_helper?: OnOff }): { before: TenantPolicy; after: TenantPolicy } {
  // An organisation above the account may have switched one off for every account below it (src/server/orgs.ts).
  refuseLoosening(accountId, { impact_display: change.impact_display, ai_helper: change.ai_helper });
  const before = tenantPolicy(accountId);
  if (change.impact_display) run('UPDATE accounts SET impact_display=? WHERE id=?', change.impact_display, accountId);
  if (change.ai_helper) run('UPDATE accounts SET ai_helper=? WHERE id=?', change.ai_helper, accountId);
  return { before, after: tenantPolicy(accountId) };
}
