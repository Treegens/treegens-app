// Single sign-on for an organisation (Settings, Security, "Single sign-on"): the rules and words the server
// (src/server/orgsso.ts) and the screens (src/components/settings/OrgSso.tsx, src/components/AuthForm.tsx) share.
// Plain constants and functions with no environment in them, safe in a 'use client' file. Every word a person reads
// comes from the catalogue (src/locales/en.json, keys "sso.*") through t().
import { SOURCE_LOCALE, t, type Vars } from './i18n.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);

/** The DNS name that proves a domain: a TXT record at _growsigning.<domain>. */
export const TXT_PREFIX = '_growsigning';
export const txtName = (domain: string) => `${TXT_PREFIX}.${domain}`;
/** What the TXT record holds: this text, then the random value made for the claim. */
export const TXT_VALUE_PREFIX = 'growsigning-domain=';
/** A claimed domain is asked about again once a day; a record found gone pauses single sign-on for that domain. */
export const DOMAIN_CHECK_HOURS = 24;
/** The most domains one account can claim. */
export const DOMAINS_MAX = 20;
/** The longest a name for the sign-in service may be ("Acme", "City of Example"). */
export const SSO_NAME_MAX = 60;
/** Where the sign-in service sends people back to. Register exactly APP_URL + this path there. */
export const SSO_CALLBACK_PATH = '/api/sso/callback';
/** The default of SSO_SESSION_HOURS: how long a browser of someone whose domain signs in through the service stays in. */
export const SSO_SESSION_HOURS_DEFAULT = 12;

/**
 * A domain as typed ("Example.org", "@example.org", "https://www.example.org/"), as the plain lower-case name, in its
 * ASCII form for names with other letters, or null. At least two labels, letters, digits and hyphens only, no IP
 * address: a claim is about email addresses, and those end in a name.
 */
export function cleanDomain(raw: unknown): string | null {
  let s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s || s.length > 253) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^@/, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  let ascii = s;
  try {
    ascii = new URL(`http://${s}/`).hostname;
  } catch {
    return null;
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return ascii;
}

/** The domain of an email address, lower case, or ''. */
export const domainOf = (email: unknown): string => {
  const s = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const i = s.lastIndexOf('@');
  return i > 0 ? cleanDomain(s.slice(i + 1)) || '' : '';
};

/** Every way a single sign-on can end without signing anyone in. The pages get the code, never free text. */
export const SSO_ERRORS = ['failed', 'cancelled', 'expired', 'domain', 'off', 'busy', 'no_email', 'taken', 'session'] as const;
export type SsoError = (typeof SSO_ERRORS)[number];
/** What happened and what to do next. `name` is the account's name for its sign-in service, from our server. */
export function ssoErrorText(code: unknown, name?: unknown): string {
  const k = (SSO_ERRORS as readonly string[]).includes(String(code)) ? String(code) : 'failed';
  const n = typeof name === 'string' && name.trim() ? name.trim().slice(0, SSO_NAME_MAX) : say('sso.your_service');
  const s = say(`sso.error.${k}`, { name: n });
  // "your organisation's sign-in" can open the sentence: then it starts with a capital.
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The button on the sign-in page and the name of the service in sentences. */
export const continueWords = (name: string) => say('sso.continue', { name });

// ---- Settings (server code and server components only from here: they read the environment) ----------------------

/** SSO_SESSION_HOURS: how long a browser of someone at an enforced domain stays signed in (1 to 720 hours). */
export function ssoHours(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SSO_SESSION_HOURS);
  return Number.isInteger(n) && n >= 1 && n <= 720 ? n : SSO_SESSION_HOURS_DEFAULT;
}
/**
 * Whether accounts on this server can set up single sign-on: only with FILE_ENCRYPTION_KEY set to a key (32 bytes as
 * base64, the same test as decodeFileKey in storedfiles.ts), because each client secret is kept encrypted with it.
 */
export const ssoOffered = (env: Record<string, string | undefined> = process.env): boolean => /^[A-Za-z0-9+/_-]{43}=?$/.test(String(env.FILE_ENCRYPTION_KEY || '').trim());
