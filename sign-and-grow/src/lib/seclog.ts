// The security record of an account: what kinds of event it holds, how each is said on the screen, and the alerts.
// Shared by the server (src/server/seclog.ts) and Settings, Security (src/components/settings/SecurityLog.tsx).
import { ALERT_FAILED_SIGNINS_HOUR, ALERT_DELETES_HOUR } from './policy.ts';

/** Every kind of line the record can hold, with how a person reads it. Nothing else is ever written. */
export const SECURITY_KINDS = {
  'signin.succeeded': 'Signed in',
  'signin.failed': 'Sign-in failed',
  'session.ended': 'Signed out',
  'signout.everywhere': 'Signed out everywhere else',
  'password.changed': 'Password changed',
  'password.reset': 'Password chosen with an emailed link',
  'email.changed': 'Email address of a login changed',
  'two_step.on': 'Two-step login switched on',
  'two_step.off': 'Two-step login switched off',
  'two_step.reset': 'Two-step login reset',
  'signin_method.connected': 'Google or Microsoft connected to a login',
  'signin_method.removed': 'Google or Microsoft disconnected from a login',
  'member.invited': 'Someone invited to the team',
  'member.joined': 'Someone joined the team',
  'member.removed': 'Someone removed from the team',
  'member.role_changed': 'Role on the team changed',
  'member.left': 'Someone left the team',
  'owner.handed_over': 'Account handed to a new owner',
  'api_key.created': 'API key made',
  'api_key.revoked': 'API key revoked',
  'api_key.new_address': 'API key used from a new internet address',
  'webhook.created': 'Webhook added',
  'webhook.removed': 'Webhook removed',
  'export.made': 'Documents exported',
  'envelope.deleted': 'Envelope taken out of the lists (kept for its recipients)',
  'envelope.purged': 'Envelope or template deleted for good',
  'envelope.restored': 'Envelope put back in the lists',
  'template.rules_changed': 'Who can use or change a template changed',
  'settings.changed': 'Account settings changed',
  'account.closing': 'Closing of a login or account started',
  'account.close_undone': 'Closing undone by signing in again',
  'operator.paused': 'Sending paused by the GrowSigning team',
  'operator.resumed': 'Sending resumed by the GrowSigning team',
  'operator.trusted': 'Marked as trusted by the GrowSigning team',
  'operator.untrusted': 'Trusted mark removed by the GrowSigning team',
  // Keeping closed envelopes for a set time and legal holds (src/server/records.ts).
  'retention.changed': 'How long closed envelopes are kept changed',
  'legal_hold.placed': 'Legal hold placed',
  'legal_hold.lifted': 'Legal hold lifted',
  'purge.asked': 'Purge of an envelope asked for',
  'purge.cancelled': 'Purge of an envelope called off',
  'envelope.retention_purged': 'Documents of a closed envelope purged',
} as const;
export type SecurityKind = keyof typeof SECURITY_KINDS;
export const SECURITY_KIND_LIST = Object.keys(SECURITY_KINDS) as SecurityKind[];
export const isSecurityKind = (k: any): k is SecurityKind => typeof k === 'string' && k in SECURITY_KINDS;

/** The kinds in groups, for the filter on the screen. */
export const SECURITY_GROUPS: [string, SecurityKind[]][] = [
  ['Signing in', ['signin.succeeded', 'signin.failed', 'session.ended', 'signout.everywhere']],
  ['Logins', ['password.changed', 'password.reset', 'email.changed', 'two_step.on', 'two_step.off', 'two_step.reset', 'signin_method.connected', 'signin_method.removed', 'account.closing', 'account.close_undone']],
  ['Team', ['member.invited', 'member.joined', 'member.removed', 'member.role_changed', 'member.left', 'owner.handed_over']],
  ['API keys and webhooks', ['api_key.created', 'api_key.revoked', 'api_key.new_address', 'webhook.created', 'webhook.removed']],
  ['Documents', ['export.made', 'envelope.deleted', 'envelope.purged', 'envelope.restored', 'template.rules_changed']],
  ['Settings', ['settings.changed']],
  ['Keeping and holds', ['retention.changed', 'legal_hold.placed', 'legal_hold.lifted', 'purge.asked', 'purge.cancelled', 'envelope.retention_purged']],
  ['The GrowSigning team', ['operator.paused', 'operator.resumed', 'operator.trusted', 'operator.untrusted']],
];

/** Who did it: a person signed in, an API key, a person who runs this server, or the server on its own. */
export type ActorType = 'user' | 'api_key' | 'operator' | 'system';

/** The alerts. Each is on until an admin switches it off, and emails the admins at most once an hour. */
export const SECURITY_ALERTS = {
  failed_signins: `${ALERT_FAILED_SIGNINS_HOUR} failed sign-ins in an hour, for one person or from one internet address`,
  api_key_created: 'An API key is made',
  owner_handed_over: 'The account is handed to a new owner',
  everything_exported: 'Everything is exported',
  many_deleted: `${ALERT_DELETES_HOUR} envelopes or templates deleted in an hour`,
} as const;
export type SecurityAlert = keyof typeof SECURITY_ALERTS;
export const SECURITY_ALERT_LIST = Object.keys(SECURITY_ALERTS) as SecurityAlert[];

/** What the screen and the API say about the record, word for word. */
export const securityLogWords = (days: number) => `A record of these events, kept for ${days} days. Nobody watches it for you: the alerts are emails.`;

/** The most lines one call of GET /account/security-events gives. */
export const SECURITY_PAGE_MAX = 1000;
