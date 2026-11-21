// Organisations above accounts: the rules an organisation passes down to the agencies below it, which way each rule
// is tighter, and the words for them. Shared by the server (src/server/orgs.ts) and Settings, Organisation
// (src/components/settings/Organisation.tsx). No environment is read here, so a 'use client' file may import it.
//
// A rule set by an organisation is a floor: every account below it has at least that, and can ask for more but never
// for less. A rule an organisation does not set is left to the organisation above it, and then to each account.
import { PASSWORD_MIN, PASSWORD_RULE_MAX, IDLE_MIN_MINUTES, IDLE_MAX_MINUTES } from './signinrules.ts';

export type OrgPolicy = {
  /** Everyone on each account signs in with two-step login. */
  two_step_required?: true;
  /** Passwords of at least this many characters. */
  min_password_length?: number;
  /** Signed out after at most this many minutes of no use. */
  idle_minutes?: number;
  /** Signed in in one browser at a time. */
  one_session?: true;
  /** No tree lines on screens and in emails. */
  impact_display?: 'off';
  /** No AI answers in the help chat. */
  ai_helper?: 'off';
};
export type OrgPolicyKey = keyof OrgPolicy;
export const ORG_POLICY_KEYS: OrgPolicyKey[] = ['two_step_required', 'min_password_length', 'idle_minutes', 'one_session', 'impact_display', 'ai_helper'];

/** How deep organisations nest: a government, a ministry, a department, an agency's own unit. */
export const ORG_MAX_DEPTH = 5;
/** The longest name of an organisation or an agency. */
export const ORG_NAME_MAX = 120;

/** What each rule is called on the screen, and what it says when it is set. */
export const ORG_POLICY_WORDS: Record<OrgPolicyKey, { name: string; on: (v: any) => string }> = {
  two_step_required: { name: 'Two-step login for everyone', on: () => 'Everyone signs in with two-step login' },
  min_password_length: { name: 'Shortest password', on: (v) => `Passwords of at least ${v} characters` },
  idle_minutes: { name: 'Sign out when not used', on: (v) => `Signed out after ${v} minutes without use` },
  one_session: { name: 'One browser at a time', on: () => 'Signed in in one browser at a time' },
  impact_display: { name: 'Trees on screens, emails and the signing record', on: () => 'No tree lines on screens, in emails or on the signing record' },
  ai_helper: { name: 'AI answers in the help chat', on: () => 'No AI answers in the help chat' },
};

/** "No AI answers" inside a sentence: only the first letter goes small, so "AI" stays "AI". */
export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "Set by Ministry of Health": what a screen says next to a value an organisation decided. */
export const setByWords = (orgName: string) => `Set by ${orgName}`;

/** The tighter of two values of one rule (undefined means the rule is not set). */
export function tighter<K extends OrgPolicyKey>(key: K, a: OrgPolicy[K] | undefined, b: OrgPolicy[K] | undefined): OrgPolicy[K] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (key === 'min_password_length') return (Math.max(a as number, b as number) as OrgPolicy[K]);
  if (key === 'idle_minutes') return (Math.min(a as number, b as number) as OrgPolicy[K]);
  return a;
}

/** True when `value` asks for less than `floor` (a value that is not set asks for nothing). */
export function looser<K extends OrgPolicyKey>(key: K, value: OrgPolicy[K] | undefined, floor: OrgPolicy[K] | undefined): boolean {
  if (floor === undefined) return false;
  if (value === undefined) return true;
  if (key === 'min_password_length') return (value as number) < (floor as number);
  if (key === 'idle_minutes') return (value as number) > (floor as number);
  return false;
}

/**
 * Reads a policy someone sent: only the known rules, each with a value it can have. A rule sent as null (or false,
 * or 'on') is taken out. Answers the policy, or the sentence that says what was wrong.
 */
export function parseOrgPolicy(input: unknown): { policy: OrgPolicy; unset: OrgPolicyKey[] } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Send the rules as a JSON object, for example {"two_step_required": true}. Nothing was changed.' };
  const policy: OrgPolicy = {};
  const unset: OrgPolicyKey[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(ORG_POLICY_KEYS as string[]).includes(k)) return { error: `"${k}" is not a rule an organisation can pass down. Send only ${ORG_POLICY_KEYS.join(', ')}. Nothing was changed.` };
    const key = k as OrgPolicyKey;
    if (v === null || v === false || v === 'on') {
      unset.push(key);
      continue;
    }
    if (key === 'two_step_required' || key === 'one_session') {
      if (v !== true) return { error: `Send "${key}" as true to set it, or null to leave it to each agency. Nothing was changed.` };
      policy[key] = true;
    } else if (key === 'impact_display' || key === 'ai_helper') {
      if (v !== 'off') return { error: `Send "${key}" as "off" to switch it off below, or null to leave it to each agency. Nothing was changed.` };
      policy[key] = 'off';
    } else {
      const [lo, hi] = key === 'min_password_length' ? [PASSWORD_MIN + 1, PASSWORD_RULE_MAX] : [IDLE_MIN_MINUTES, IDLE_MAX_MINUTES];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) return { error: `Send "${key}" as a whole number from ${lo} to ${hi}, or null to leave it to each agency. Nothing was changed.` };
      policy[key] = v;
    }
  }
  return { policy, unset };
}

/** A policy as kept: only known keys with values they can have (anything else in the stored JSON is ignored). */
export function cleanPolicy(raw: unknown): OrgPolicy {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const r = parseOrgPolicy(v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).filter(([k]) => (ORG_POLICY_KEYS as string[]).includes(k))) : {});
  return 'policy' in r ? r.policy : {};
}

/** One sentence for a line an organisation wrote in an account's security record or its own record. */
export function orgEventWords(kind: string, d: Record<string, any>): string {
  const org = String(d.organisation || 'The organisation above this account');
  const by = d.by_name ? `${d.by_name} of ${org}` : org;
  // The agency by its name, so a line reads the same on the organisation's page and in the agency's own record.
  const agency = d.agency_name ? String(d.agency_name) : 'this account';
  if (kind === 'org.break_glass') return `${by} opened ${d.document ? `the document "${d.document}"` : `a document of ${agency}`} with emergency access. Reason given: ${d.reason || 'none'}.`;
  switch (d.what) {
    case 'agency_created': return `${by} made the agency${d.name ? ` "${d.name}"` : ''} in ${org}.`;
    case 'agency_moved_in': return `${agency === 'this account' ? 'This account' : agency} was moved into ${org}${d.from ? ` from ${d.from}` : ''} by the people who run this server.`;
    case 'agency_moved_out': return `${agency === 'this account' ? 'This account' : agency} was moved out of ${org}${d.to ? ` into ${d.to}` : ''} by the people who run this server.`;
    case 'owner_named': return d.invited ? `${by} invited ${d.person || 'someone'} by email to be ${d.role === 'admin' ? 'an admin' : 'an owner'} of ${agency}.` : `${by} made ${d.person || 'someone'} ${d.role === 'admin' ? 'an admin' : 'an owner'} of ${agency}.`;
    case 'role_changed': return `${by} changed the role of ${d.person || 'a member'} in ${agency} to ${d.role || 'member'}.`;
    case 'two_step_reset': return `${by} switched off two-step login of ${d.person || 'a member'} of ${agency} so they can set it up again.`;
    case 'sending_off': return `${by} switched sending off for ${agency}.`;
    case 'sending_on': return `${by} switched sending on again for ${agency}.`;
    case 'policy_changed': return `${by} changed the rules it passes down.`;
    case 'org_created': return `${by} made the organisation${d.name ? ` "${d.name}"` : ''}.`;
    case 'admin_added': return `${by} made ${d.person || 'someone'} an admin of ${org}.`;
    case 'admin_removed': return `${by} took ${d.person || 'someone'} off the admins of ${org}.`;
    case 'break_glass_allowed': return `The people who run this server ${d.to ? 'allowed' : 'stopped'} emergency access to documents for the admins of ${org}.`;
    default: return `${by} changed something in ${agency}.`;
  }
}

/** "Government of Example set: passwords of at least 12 characters, no AI answers in the help chat." for a line in
 * an account's security record that an organisation's rules wrote. `settings` as kept there (min_length for the
 * shortest password). */
export function orgRuleWords(d: Record<string, any>): string {
  const keyOf = (name: string): OrgPolicyKey | null => (name === 'min_length' ? 'min_password_length' : (ORG_POLICY_KEYS as string[]).includes(name) ? (name as OrgPolicyKey) : null);
  const by = new Map<string, string[]>();
  for (const [name, c] of Object.entries((d.settings || {}) as Record<string, any>)) {
    const k = keyOf(name);
    if (!k) continue;
    const who = String(c?.set_by || d.organisation || 'An organisation above this account');
    by.set(who, [...(by.get(who) || []), lowerFirst(ORG_POLICY_WORDS[k].on(d.given_back ? c?.from : c?.to))]);
  }
  if (!by.size) return '';
  if (d.given_back) return `${String(d.organisation || 'The organisation above this account')} took away its rule (${[...by.values()].flat().join('; ')}), so this account has back what it had before.`;
  return [...by].map(([who, rules]) => `${who} set: ${rules.join(', ')}.`).join(' ');
}

/**
 * One line for a card of an account's Settings that holds rules an organisation decided, or '' when none did:
 * "Set by Ministry of Health: Shortest password, Sign out when not used. This account can ask for more, never for less."
 */
export function setByLine(setBy: Partial<Record<string, string>> | null | undefined, keys: OrgPolicyKey[]): string {
  const by = new Map<string, string[]>();
  for (const k of keys) {
    const who = setBy?.[k];
    if (who) by.set(who, [...(by.get(who) || []), lowerFirst(ORG_POLICY_WORDS[k].name)]);
  }
  if (!by.size) return '';
  return `${[...by].map(([who, names]) => `${who}: ${names.join(', ')}`).join('. ')}. This account can ask for more, never for less.`;
}
