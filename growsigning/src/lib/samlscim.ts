// SAML 2.0 sign-in and members from a directory (SCIM 2.0): the addresses and limits the server (src/server/saml.ts,
// src/server/scim.ts) and the Settings screens (src/components/settings/OrgSso.tsx, OrgDirectory.tsx) share. Plain
// constants with no environment in them, safe in a 'use client' file. The words are in src/locales/en.json
// ("saml.*", "directory.*").

/** Where every SAML identity provider posts its answer (HTTP-POST binding only). Register APP_URL + this path. */
export const SAML_ACS_PATH = '/api/sso/saml/acs';
/** Our entity id and metadata for one account: APP_URL + this + the account's random sp id. */
export const SAML_SP_PATH = '/api/sso/saml/sp/';
/** The longest identity provider metadata we read, in characters. Real ones are a few kilobytes. */
export const SAML_METADATA_MAX = 200_000;
/** How long a sign-in that was sent to the identity provider may take to come back, in minutes. */
export const SAML_REQUEST_MINUTES = 10;
/** How far the identity provider's clock may be off from ours when its times are checked, in seconds. */
export const SAML_CLOCK_SECONDS = 30;

/** The base address a directory is given: APP_URL + this. Users live at <base>/Users. */
export const SCIM_BASE_PATH = '/api/scim/v2';
/** The start of every directory token, so a token that leaks in a log is recognised. */
export const SCIM_TOKEN_PREFIX = 'tss_';
/** The most people one page of GET /Users answers. */
export const SCIM_PAGE_MAX = 200;
/** The most calls one directory may make in a minute. */
export const SCIM_CALLS_PER_MINUTE = 300;

/** The two standards a sign-in service can speak, as the card offers them. */
export const SSO_KINDS = ['oidc', 'saml'] as const;
export type SsoKind = (typeof SSO_KINDS)[number];

/**
 * Why a SAML answer was refused, as the admin's "Try a sign-in" is told it (the words are "saml.why.<code>" in
 * src/locales/en.json, each saying what to change at the identity provider). A person signing in is never told these.
 */
export const SAML_WHY = ['unsigned', 'issuer', 'recipient', 'audience', 'no_email', 'clock', 'refused', 'other'] as const;
export type SamlWhy = (typeof SAML_WHY)[number];
export const isSamlWhy = (v: unknown): v is SamlWhy => (SAML_WHY as readonly string[]).includes(String(v));
/** The code for a refusal the SAML library gave in its own words. */
export function samlWhyOf(message: string): SamlWhy {
  const m = String(message || '');
  if (/Bad status code/i.test(m)) return 'refused';
  if (/signature|signed data|Missing SAML assertion|Not a valid XML/i.test(m)) return 'unsigned';
  if (/audience/i.test(m)) return 'audience';
  if (/issuer/i.test(m)) return 'issuer';
  if (/expired|not yet valid|clocks skewed/i.test(m)) return 'clock';
  if (/InResponseTo|subject confirmation/i.test(m)) return 'recipient';
  if (/NameID/i.test(m)) return 'no_email';
  return 'other';
}
