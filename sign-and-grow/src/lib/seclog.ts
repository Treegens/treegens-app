// The security record of an account: what kinds of line it holds, how each is said on the screen, and the alerts.
// Shared by the server (src/server/seclog.ts) and Settings, Security (src/components/settings/SecurityLog.tsx).
// Every word a person reads comes from the catalogue (src/locales/en.json, keys "security.*") through t().
import { ALERT_FAILED_SIGNINS_HOUR, ALERT_DELETES_HOUR } from './policy.ts';
import { SOURCE_LOCALE, t } from './i18n.ts';
import { deviceName } from './phone.ts';
import { dayText } from './dates.ts';
import { orgEventWords, orgRuleWords } from './orgs.ts';

/** Every kind of line the record can hold. Nothing else is ever written. */
export const SECURITY_KIND_LIST = [
  'signin.succeeded', 'signin.failed', 'session.ended', 'signout.everywhere',
  'password.changed', 'password.reset', 'email.changed',
  'two_step.on', 'two_step.off', 'two_step.reset', 'two_step.codes_renewed', 'two_step.devices_forgotten',
  'signin_method.connected', 'signin_method.removed',
  'member.invited', 'member.invite_withdrawn', 'member.joined', 'member.removed', 'member.role_changed', 'member.left', 'owner.handed_over',
  'api_key.created', 'api_key.revoked', 'api_key.new_address', 'webhook.created', 'webhook.removed',
  'export.made', 'envelope.deleted', 'envelope.purged', 'envelope.restored', 'template.rules_changed',
  'settings.changed', 'account.closing', 'account.close_undone',
  'operator.paused', 'operator.resumed', 'operator.trusted', 'operator.untrusted',
  // Keeping finished documents for a set time, and holds (src/server/records.ts).
  'retention.changed', 'legal_hold.placed', 'legal_hold.lifted', 'purge.asked', 'purge.cancelled', 'envelope.retention_purged',
  // What an organisation above the account did to it, and emergency access to a document (src/server/orgs.ts).
  'org.changed', 'org.break_glass',
] as const;
export type SecurityKind = (typeof SECURITY_KIND_LIST)[number];
export const isSecurityKind = (k: any): k is SecurityKind => typeof k === 'string' && (SECURITY_KIND_LIST as readonly string[]).includes(k);

/** How a person reads each kind, in the language asked for. */
export const securityKindWords = (kind: string, locale: unknown = SOURCE_LOCALE): string => (isSecurityKind(kind) ? t(locale, `security.kind.${kind}`) : '') || kind;
/** The same in English, for the API, the CSV and the emails. */
export const SECURITY_KINDS = Object.fromEntries(SECURITY_KIND_LIST.map((k) => [k, securityKindWords(k)])) as Record<SecurityKind, string>;

/** The kinds in groups, for the filter on the screen. The first word is the key of the group's name. */
export const SECURITY_GROUPS: [string, SecurityKind[]][] = [
  ['signing_in', ['signin.succeeded', 'signin.failed', 'session.ended', 'signout.everywhere']],
  ['logins', ['password.changed', 'password.reset', 'email.changed', 'two_step.on', 'two_step.off', 'two_step.reset', 'two_step.codes_renewed', 'two_step.devices_forgotten', 'signin_method.connected', 'signin_method.removed', 'account.closing', 'account.close_undone']],
  ['team', ['member.invited', 'member.invite_withdrawn', 'member.joined', 'member.removed', 'member.role_changed', 'member.left', 'owner.handed_over']],
  ['keys', ['api_key.created', 'api_key.revoked', 'api_key.new_address', 'webhook.created', 'webhook.removed']],
  ['documents', ['export.made', 'envelope.deleted', 'envelope.purged', 'envelope.restored', 'template.rules_changed']],
  ['settings', ['settings.changed']],
  ['keeping', ['retention.changed', 'legal_hold.placed', 'legal_hold.lifted', 'purge.asked', 'purge.cancelled', 'envelope.retention_purged']],
  ['operator', ['operator.paused', 'operator.resumed', 'operator.trusted', 'operator.untrusted']],
  ['organisation', ['org.changed', 'org.break_glass']],
];
export const securityGroupWords = (group: string, locale: unknown = SOURCE_LOCALE): string => t(locale, `security.group.${group}`) || group;

/** Who did it: a person signed in, an API key, a person who runs this server, or the server on its own. */
export type ActorType = 'user' | 'api_key' | 'operator' | 'system';

/** The alerts. Each is on until an admin switches it off, and emails the admins at most once an hour. */
export const SECURITY_ALERT_LIST = ['failed_signins', 'api_key_created', 'owner_handed_over', 'everything_exported', 'many_deleted'] as const;
export type SecurityAlert = (typeof SECURITY_ALERT_LIST)[number];
export const securityAlertWords = (alert: string, locale: unknown = SOURCE_LOCALE): string => t(locale, `security.alert.${alert}`, { signins: ALERT_FAILED_SIGNINS_HOUR, deletes: ALERT_DELETES_HOUR }) || alert;
export const SECURITY_ALERTS = Object.fromEntries(SECURITY_ALERT_LIST.map((k) => [k, securityAlertWords(k)])) as Record<SecurityAlert, string>;

/** What the screen and the API say about the record, word for word. */
export const securityLogWords = (days: number, locale: unknown = SOURCE_LOCALE) => t(locale, 'security.words', { days });

/**
 * A webhook that only carries the security record ("events" is "security.event" and nothing else): it was added in
 * Settings, Security, and API and webhooks lists it as that, not as one that hears about documents.
 */
export const securityOnlyHook = (events: unknown): boolean => {
  const list = String(events ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  return list.length > 0 && list.every((e) => e === 'security.event');
};

/** The most lines one call of GET /account/security-events gives. */
export const SECURITY_PAGE_MAX = 1000;
/** The longest text the search box of the record takes. */
export const SECURITY_SEARCH_MAX = 80;

// ---- A line in sentences --------------------------------------------------------------------------------------

/** "Linux computer, Chrome", from what the browser called itself; empty when it cannot be read. */
export function securityDevice(ua: string | null | undefined, locale: unknown = SOURCE_LOCALE): string {
  if (!ua) return '';
  const d = deviceName(ua);
  if (d.device === 'Unknown device' && d.browser === 'unknown browser') return '';
  if (d.device === 'Unknown device') return t(locale, 'security.device.browser', { browser: d.browser });
  if (d.browser === 'unknown browser') return t(locale, 'security.device.device', { device: d.device });
  return t(locale, 'security.device.both', { device: d.device, browser: d.browser });
}

// Something that only names a row of the database (usr_..., inv_...) is never shown on the screen.
const isId = (v: unknown) => typeof v === 'string' && /^[a-z]{2,5}_[A-Za-z0-9_-]{8,}$/.test(v);
const plain = (v: unknown): string => (v === null || v === undefined || v === '' ? '' : typeof v === 'boolean' ? '' : typeof v === 'object' ? '' : String(v).replace(/_/g, ' '));
const capital = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const sentence = (x: string) => {
  const s = capital(x.trim());
  return s && !/[.!?]$/.test(s) ? `${s}.` : s;
};

/**
 * The details of one line as sentences a person can read ("Role changed from admin to member."). The record keeps
 * details as short names and values (src/server/seclog.ts); this is the one place that turns them into words. A
 * detail nobody wrote a sentence for is said as "Name: value.", and an id is left out.
 */
export function securityDetail(kind: string, details: Record<string, any> | null | undefined, locale: unknown = SOURCE_LOCALE): string[] {
  const d = details && typeof details === 'object' ? details : {};
  const w = (key: string, vars: Record<string, any> = {}) => t(locale, `security.detail.${key}`, vars);
  const yesNo = (v: unknown) => (v === true ? w('on') : v === false ? w('off') : plain(v) || w('nothing'));
  const out: string[] = [];
  const done = new Set<string>();
  const say = (text: string, ...keys: string[]) => {
    if (text) out.push(text);
    for (const k of keys) done.add(k);
  };
  const role = (r: unknown) => w(r === 'owner' ? 'role_owner' : r === 'admin' ? 'role_admin' : 'role_member');

  if (kind === 'signin.succeeded' || kind === 'signin.failed') {
    const m = String(d.method || 'password');
    if (kind === 'signin.failed') say(w(d.reason === 'wrong_password_or_code' ? 'wrong_password_or_code' : 'wrong_password'), 'reason');
    else if (d.new_login) say(w('new_login'), 'new_login');
    if (m !== 'password' && m !== 'sign_up') say(w('with_provider', { provider: capital(m) }));
    if (d.second_step) say(w(d.second_step === 'remembered_device' ? 'second_step_remembered' : 'second_step_code'));
    done.add('method').add('second_step').add('new_login').add('reason');
  } else if (kind === 'session.ended') {
    say(d.how === 'ended_from_settings' ? w('ended_from_settings') : d.how === 'idle' ? w('ended_idle', { count: Number(d.minutes) || 0 }) : d.how === 'signed_in_elsewhere' ? w('ended_elsewhere', { count: Number(d.browsers) || 1 }) : '', 'how', 'minutes', 'browsers');
  } else if (kind === 'signout.everywhere') {
    say(w('signed_out_n', { count: Number(d.signed_out) || 0 }), 'signed_out');
    say(Number(d.devices_forgotten) ? w('devices_n', { count: Number(d.devices_forgotten) }) : '', 'devices_forgotten');
  } else if (kind === 'password.reset') {
    say(d.address_confirmed_now ? w('address_confirmed') : '', 'address_confirmed_now');
    say(Number(d.disconnected) ? w('disconnected_n', { count: Number(d.disconnected) }) : '', 'disconnected');
  } else if (kind === 'two_step.on') {
    say(d.moved_to_another_app ? w('moved_app') : '', 'moved_to_another_app');
  } else if (kind === 'two_step.reset') {
    say(w(d.how === 'by_an_admin' ? 'reset_by_admin' : 'reset_by_email'), 'how', 'account');
  } else if (kind === 'two_step.devices_forgotten') {
    say(w('devices_n', { count: Number(d.devices) || 0 }), 'devices');
    say(Number(d.signed_out) ? w('signed_out_n', { count: Number(d.signed_out) }) : '', 'signed_out');
  } else if (kind === 'signin_method.connected' || kind === 'signin_method.removed') {
    say(d.provider ? sentence(capital(String(d.provider))) : '', 'provider', 'how');
  } else if (kind === 'member.invited' || kind === 'member.invite_withdrawn') {
    say(w('invited_as', { role: role(d.role) }), 'role');
  } else if (kind === 'member.joined') {
    say(w('joined_as', { role: role(d.role) }), 'role', 'invite');
  } else if (kind === 'member.role_changed') {
    say(w('role_changed', { from: role(d.from), to: role(d.to) }), 'from', 'to');
  } else if (kind === 'member.removed' || kind === 'member.left') {
    say(w('was_role', { role: role(d.role) }), 'role', 'handed_to');
    say(Number(d.keys_stopped) ? w('keys_stopped_n', { count: Number(d.keys_stopped) }) : '', 'keys_stopped');
    say(Number(d.handed_over) ? w('handed_over_n', { count: Number(d.handed_over) }) : '', 'handed_over');
  } else if (kind === 'owner.handed_over') {
    done.add('from').add('to');
  } else if (kind === 'api_key.created' || kind === 'api_key.revoked') {
    say(d.name ? w('key_named', { name: String(d.name) }) : '', 'name', 'made_by');
    say(w(d.scope === 'admin' ? 'scope_admin' : 'scope_send'), 'scope');
    say(d.was_stopped ? w('key_was_stopped') : '', 'was_stopped');
  } else if (kind === 'api_key.new_address') {
    say(d.first_use ? w('key_first_use') : '', 'first_use');
  } else if (kind === 'webhook.created' || kind === 'webhook.removed') {
    const ev = String(d.events || '*');
    say(w(ev === '*' ? 'hook_all' : ev.split(',').includes('security.event') ? 'hook_security' : 'hook_some'), 'events', 'host');
  } else if (kind === 'export.made') {
    say(w(d.everything ? 'export_everything_n' : 'export_n', { count: Number(d.envelopes) || 0 }), 'everything', 'envelopes');
    say(d.whose === 'own' ? w('export_own') : '', 'whose');
  } else if (kind === 'envelope.deleted' || kind === 'envelope.purged' || kind === 'envelope.restored') {
    say(d.status ? w('status_was', { status: plain(d.status === 'voided' ? 'cancelled' : d.status) }) : '', 'status', 'kind', 'kept_for_recipients');
  } else if (kind === 'account.closing') {
    say(d.deleted_now ? w('closed_now') : w('closes_on', { day: dayText(String(d.deletes_at || '').slice(0, 10)) || String(d.deletes_at || '').slice(0, 10) }), 'deleted_now', 'deletes_at', 'accounts_closing');
    const keys = Number(d.keys_stopped) || Number(d.keys_switched_off) || 0;
    say(keys ? w('keys_stopped_n', { count: keys }) : '', 'keys_stopped', 'keys_switched_off');
  } else if (kind === 'operator.paused') {
    say(d.reason ? w('reason', { reason: String(d.reason) }) : '', 'reason');
  } else if (kind === 'retention.changed') {
    const days = (n: unknown) => (Number(n) ? w('days_n', { count: Number(n) }) : w('kept_until_deleted'));
    // Each of the two lines of the schedule is said only when it changed (an older line carries no second pair).
    const moved = (a: unknown, b: unknown) => (Number(a) || 0) !== (Number(b) || 0);
    const both = 'stopped_days' in d || 'was_stopped_days' in d;
    say(!both || moved(d.was_days, d.days) ? w('retention', { from: days(d.was_days), to: days(d.days) }) : '', 'days', 'was_days', 'level', 'was_level', 'templates');
    say(both && moved(d.was_stopped_days, d.stopped_days) ? w('retention_stopped', { from: days(d.was_stopped_days), to: days(d.stopped_days) }) : '', 'stopped_days', 'was_stopped_days');
  } else if (kind === 'legal_hold.placed' || kind === 'legal_hold.lifted') {
    say(Number(d.covers) ? w('covers_n', { count: Number(d.covers) }) : '', 'covers', 'folder', 'envelope_id');
    say(d.by_operator ? w('by_operator') : '', 'by_operator');
  } else if (kind === 'purge.asked' || kind === 'purge.cancelled' || kind === 'envelope.retention_purged') {
    done.add('level');
  } else if (kind === 'org.changed' || kind === 'org.break_glass') {
    say(orgEventWords(kind, d), 'what', 'organisation', 'by_name', 'agency', 'agency_name', 'invited', 'to', 'from', 'role', 'reason', 'name', 'by_organisation', 'document', 'person', 'policy');
  } else if (kind === 'settings.changed' && d.by_organisation) {
    // Rules an organisation above the account set or took away: "Government of Example set: ..." (src/lib/orgs.ts).
    const said = orgRuleWords(d);
    if (said) say(said, 'settings', 'by_organisation', 'organisation', 'by_name', 'given_back');
  }

  // A setting by its name, with what it was and is; a personal or bulky one by its name only.
  if (d.settings && typeof d.settings === 'object' && !done.has('settings')) {
    for (const [name, c] of Object.entries(d.settings as Record<string, any>)) {
      if (name.startsWith('alert_')) {
        out.push(w(c?.to ? 'alert_on' : 'alert_off', { alert: securityAlertWords(name.slice(6), locale) }));
        continue;
      }
      const label = t(locale, `security.setting.${name}`) || capital(name.replace(/_/g, ' '));
      out.push(c?.changed || typeof c?.from === 'object' && c?.from !== null ? w('setting_changed', { setting: label }) : w('setting_from_to', { setting: label, from: yesNo(c?.from), to: yesNo(c?.to) }));
    }
    done.add('settings');
  }
  if (Number(d.browsers_signed_out)) say(w('browsers_signed_out', { count: Number(d.browsers_signed_out) }), 'browsers_signed_out');
  if (typeof d.change === 'string') say(sentence(d.change), 'change');
  if (typeof d.custom_field === 'string') done.add('custom_field');

  // Whatever is left: "Name: value.", never an id, never a list or an object.
  for (const [k, v] of Object.entries(d)) {
    if (done.has(k) || isId(v) || /(^|_)id$/.test(k)) continue;
    const value = typeof v === 'boolean' ? (v ? w('yes') : w('no')) : plain(v);
    if (value) out.push(`${capital(k.replace(/_/g, ' '))}: ${value}.`);
  }
  return out;
}
