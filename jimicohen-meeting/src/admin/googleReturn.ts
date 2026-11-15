/**
 * Coming back from Google's consent screen: the callback sends the browser to the page the
 * connection was started from, with `?google=connected` (plus `&zone=<IANA zone>` when the
 * host's time zone changed with it) or `?google=error&reason=<sentence>`. Every dashboard page
 * can be that page. These helpers say what happened and take the parameters back off the address.
 */
import type { AdminHost } from '../../shared/types';
import { GOOGLE_RETURN_PARAMS } from '../lib/api';
import { allAccounts } from '../lib/googleAccounts';
import { isValidZone, zoneLabel } from '../lib/tz';
import type { ToastApi } from '../ui';

export function googleReturnReason(reason: string | null): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Google did not finish connecting. Please try again.';
  if (r === 'access_denied') return 'The Google screen was closed before access was allowed. Press Connect to try again.';
  return r.slice(0, 240);
}

/** Looks up an account named in the return (by id: the address bar never carries an address). */
export type AccountLookup = (id: string | null) => { email: string; status?: 'ok' | 'needs_reconnect'; main?: boolean } | null;

/** An account of any of these hosts by id, as the return toasts need it. */
export function findScreenAccount(hosts: AdminHost[], id: string | null): { email: string; status: 'ok' | 'needs_reconnect'; main: boolean } | null {
  if (!id) return null;
  for (const h of hosts) {
    const a = allAccounts(h).find((x) => x.id === id);
    if (a) return { email: a.email, status: a.status, main: a.main };
  }
  return null;
}

/** What the return says happened, in a title and a sentence. Null for the plain "connected" of an older server. */
export function connectedMessage(params: URLSearchParams, find?: AccountLookup): { title: string; body: string; tone: 'success' | 'info' | 'warning' } | null {
  const outcome = params.get('gresult');
  const got = find?.(params.get('gaccount')) ?? null;
  const email = got?.email ?? 'The account';
  if (params.get('gnote') === 'other_account') {
    const wanted = find?.(params.get('gwanted')) ?? null;
    const first = `You signed in as ${email === 'The account' ? 'another account' : email}. ${email === 'The account' ? 'That account' : email} is connected now.`;
    if (wanted && wanted.status === 'needs_reconnect') {
      return { tone: 'warning', title: 'Another account was connected', body: `${first} ${wanted.email} still needs to be reconnected: press Reconnect next to it and choose that account at Google.` };
    }
    if (wanted && wanted.main) return { tone: 'info', title: 'Another account was connected', body: `${first} New meetings still go to ${wanted.email}.` };
    return { tone: 'info', title: 'Another account was connected', body: first };
  }
  switch (outcome) {
    case 'added':
      return { tone: 'success', title: `${email} is connected`, body: 'Its busy times now block times on your booking page.' };
    case 'refreshed':
      return { tone: 'success', title: `${email} was already connected`, body: 'Its connection was refreshed. Nothing was added twice.' };
    case 'promoted':
      return { tone: 'success', title: `New meetings now go to ${email}`, body: 'It was already connected; now it is your main account.' };
    case 'replaced':
      return { tone: 'success', title: `New meetings now go to ${email}`, body: 'It replaced the account you had before.' };
    default:
      return null;
  }
}

/**
 * Toasts what the return from Google means. False when the address carries no result. `find` names the
 * account: call this after the page has loaded the hosts again, so a new account is there to be found.
 */
export function announceGoogleReturn(toast: ToastApi, search: string, reason: (r: string | null) => string = googleReturnReason, find?: AccountLookup): boolean {
  const params = new URLSearchParams(search);
  const result = params.get('google');
  if (!result) return false;
  if (result === 'connected') {
    const said = connectedMessage(params, find);
    if (said) toast[said.tone](said.title, said.body);
    else toast.success('Google is connected', 'Your busy times are now checked and bookings land on your calendar.');
    // Following the calendar's zone moves every hour offered: never let that happen in silence.
    const zone = params.get('zone');
    if (isValidZone(zone)) toast.info(`Your time zone is now ${zoneLabel(zone)}`, 'It was taken from your Google Calendar, and your hours are read in it. You can change that under Availability.');
  } else {
    toast.error('Google did not connect', reason(params.get('reason')));
  }
  return true;
}

/** The query string without the parameters a return from Google left ("" or "?a=1"). */
export function withoutGoogleReturn(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of GOOGLE_RETURN_PARAMS) params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
