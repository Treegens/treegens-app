// Signing in with Google or Microsoft: the names, the words for everything that can go wrong on the way, and the
// rule for where a person may be sent after signing in. The pages and the server both read them from here, so a
// screen can never say something the server does not do.
//
// Everything down to signInProviders() is plain constants and functions with no side effects, safe in a 'use client'
// file. signInProviders() and microsoftTenant() read the environment: server code and server components only.

export type ProviderId = 'google' | 'microsoft';
export const PROVIDER_IDS: ProviderId[] = ['google', 'microsoft'];
export const PROVIDER_NAMES: Record<ProviderId, string> = { google: 'Google', microsoft: 'Microsoft' };
export const isProviderId = (s: any): s is ProviderId => s === 'google' || s === 'microsoft';

/** A sign-in that was started at a provider must come back within this many minutes. */
export const SIGNIN_MINUTES = 10;

/** Where the provider sends the browser back to. Register exactly APP_URL + this path with the provider. */
export const callbackPath = (provider: ProviderId): string => `/api/auth/${provider}/callback`;

/**
 * Where a person may go after signing in: a path on this site and nothing else. A browser reads "//host" and
 * "/\host" as another site and drops tabs and line breaks before it looks, so those are refused before the address
 * is parsed, and what comes back is the parsed path, never the text that was sent.
 */
export function safeNext(next: any, fallback = '/app'): string {
  if (typeof next !== 'string' || next.length > 500 || !next.startsWith('/') || next.startsWith('//')) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const u = new URL(next, 'http://site.invalid');
    if (u.origin !== 'http://site.invalid' || u.pathname.startsWith('//')) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** Every way a sign-in at a provider can end without signing anyone in. The pages get the code, never free text. */
export const SIGNIN_ERRORS = ['cancelled', 'expired', 'failed', 'exists', 'no_email', 'invite', 'code', 'taken', 'session', 'busy'] as const;
export type SignInError = (typeof SIGNIN_ERRORS)[number];

/** What happened and what to do next, in words. `provider` is only ever one of the names above. */
export function signInErrorText(code: any, provider?: any): string {
  const p = isProviderId(provider) ? PROVIDER_NAMES[provider] : 'the sign-in service';
  switch (code as SignInError) {
    case 'cancelled':
      return `You stopped at ${p} before it was finished, so you are not signed in. Nothing was changed. You can try again, or use your email and password.`;
    case 'expired':
      return `That sign-in was used already, or it took longer than ${SIGNIN_MINUTES} minutes, so we stopped it to be safe. Nothing was changed. Please start again from this page. If this keeps happening, your browser may be refusing cookies from this site: allow them, or use your email and password.`;
    case 'exists':
      return `You already have a Sign&Grow login with this address. Sign in with your password once, then connect ${p} under Settings. We did not sign you in with ${p} because it does not confirm to us that this address is yours. No password, or you do not remember it? Use "Forgot password" below and we email you a link to choose one.`;
    case 'no_email':
      return `${p} did not tell us an email address for you, so no login was created. Create one with your email and a password instead. You can connect ${p} afterwards under Settings.`;
    case 'invite':
      return `This invitation cannot be used with the address you chose at ${p}. It was sent to another address, it was used already, it was cancelled, or the team is being closed. No login was created. Choose the ${p} account that has the invited address, or create a login with that address and a password, or ask the person who invited you to send a new invitation.`;
    case 'code':
      return 'We do not recognise that code, so no login was created. Check the spelling, or leave the code box empty and add the code later on the Plan page.';
    case 'taken':
      return `That ${p} account is already connected to another Sign&Grow login, so it was not connected to this one. Sign in to the other login and disconnect it there first, or choose a different ${p} account.`;
    case 'session':
      return `You were no longer signed in to the same Sign&Grow login when ${p} answered, so nothing was connected. Sign in and try again under Settings, Profile.`;
    case 'busy':
      return 'Too many attempts. Please wait a bit and try again.';
    default:
      return `${p} did not confirm who you are, so you are not signed in. Nothing was changed. Try again in a minute. If it keeps happening, use your email and password, or get help below.`;
  }
}

/**
 * What a sign-in did besides signing the person in, as the server reports it. The first screen of the app says it in
 * words (signInNotice), so nothing that happened on the way in is swallowed.
 */
export type SignInNote = {
  restored?: boolean; // the login was being closed and is back
  fresh?: boolean; // the person belonged to no account any more and was given a workspace
  joined?: string | null; // the team an invitation was accepted for
  invite_error?: string | null; // why an invitation was not accepted
  created?: string; // a new login was made by signing in with this provider
  confirm?: boolean; // and we emailed our own link to confirm the address
  linked?: string; // this provider was connected to a login that existed already
  reclaimed?: 'password' | 'login'; // that login had never been confirmed, and what was cut off (see cutEarlierAccess)
  code_unused?: boolean; // a code was carried along but the person already had a login
};

/**
 * The cookie the server leaves what a sign-in did in, for the landing page to read once. Over https its name carries
 * the "__Host-" prefix, which a browser only accepts from this very host, and the page reads no other.
 */
export const SIGNIN_NOTE_COOKIE = 'sg_signin_note';

export function signInNotice(r: SignInNote): string {
  const said: string[] = [];
  if (r.created) said.push(`Welcome. Your Sign&Grow login was made with ${r.created}, so use "Continue with ${r.created}" to sign in from now on. It has no password. You can set one under Settings, Profile.${r.confirm ? ' We emailed you a link to confirm your address. Open it in this browser while you are signed in, and you can send documents.' : ''}`);
  if (r.reclaimed) said.push(`${r.linked} confirmed that this address is yours. A Sign&Grow login had been started with it earlier, but the address was never confirmed, so we could not know who started it. To be safe${r.reclaimed === 'password' ? ' the password that was set before no longer works and' : ''} every other browser was signed out. From now on you sign in with ${r.linked}${r.reclaimed === 'password' ? ', and you can choose a new password under Settings, Profile' : ''}. If you did not start that login yourself, look at the team, the API keys and the webhooks under Settings.`);
  else if (r.linked) said.push(`${r.linked} is now connected to your login, because it confirmed your address to us. You can sign in with ${r.linked} or with your password. We emailed you a note about it.`);
  if (r.invite_error) said.push(`You are signed in, but you did not join the team. ${r.invite_error}`);
  else if (r.joined) said.push(`You have joined ${r.joined}.${r.created ? '' : ' If you have a workspace of your own, it is still there: switch between them at the bottom of the menu.'}`);
  else if (r.fresh) said.push('You are no longer on a team, so we made you a workspace of your own. Documents sent to you are in your inbox, and a team can invite you again at any time.');
  if (r.code_unused) said.push('The code was not used, because you already had a login. You can add it under Settings, Plan.');
  return said.join(' ');
}

// ---- Settings (server only from here) --------------------------------------------------------

/** Microsoft's own tenant for personal accounts (outlook.com, hotmail.com and so on). */
export const MICROSOFT_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Who may sign in with Microsoft: "common" (work, school and personal accounts), "organizations" (work and school),
 * "consumers" (personal), or the id of one organization. Anything else returns null and Microsoft sign-in stays off:
 * a domain name is not accepted, because the organization in a sign-in is checked against this value letter by letter.
 */
export function microsoftTenant(env: Record<string, string | undefined> = process.env): string | null {
  const t = (env.MICROSOFT_TENANT || 'common').trim().toLowerCase();
  return t === 'common' || t === 'organizations' || t === 'consumers' || GUID.test(t) ? t : null;
}

/** The providers the operator of this server has switched on: both values of a provider must be set. */
export function signInProviders(env: Record<string, string | undefined> = process.env): ProviderId[] {
  const on: ProviderId[] = [];
  if ((env.GOOGLE_CLIENT_ID || '').trim() && (env.GOOGLE_CLIENT_SECRET || '').trim()) on.push('google');
  if ((env.MICROSOFT_CLIENT_ID || '').trim() && (env.MICROSOFT_CLIENT_SECRET || '').trim() && microsoftTenant(env)) on.push('microsoft');
  return on;
}

/** Said once when a server starts with Microsoft sign-in half set up, or null. */
export function signInWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (!(env.MICROSOFT_CLIENT_ID || '').trim() || !(env.MICROSOFT_CLIENT_SECRET || '').trim() || microsoftTenant(env)) return null;
  return `\n[config] MICROSOFT_TENANT IS NOT USABLE, so signing in with Microsoft is switched off. Set it to common, organizations, consumers, or the id of your organization (a value like 11111111-2222-3333-4444-555555555555, shown as "Directory (tenant) ID" in the Microsoft Entra admin centre). A domain name is not accepted.\n`;
}
