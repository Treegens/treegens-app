/**
 * Coming back from Google's consent screen: the callback sends the browser to the page the
 * connection was started from, with `?google=connected` (plus `&zone=<IANA zone>` when the
 * host's time zone changed with it) or `?google=error&reason=<sentence>`. Every dashboard page
 * can be that page. These helpers say what happened and take the parameters back off the address.
 */
import { GOOGLE_RETURN_PARAMS } from '../lib/api';
import { isValidZone, zoneLabel } from '../lib/tz';
import type { ToastApi } from '../ui';

export function googleReturnReason(reason: string | null): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Google did not finish connecting. Please try again.';
  if (r === 'access_denied') return 'The Google screen was closed before access was allowed. Press Connect to try again.';
  return r.slice(0, 240);
}

/** Toasts what the return from Google means. False when the address carries no result. */
export function announceGoogleReturn(toast: ToastApi, search: string, reason: (r: string | null) => string = googleReturnReason): boolean {
  const params = new URLSearchParams(search);
  const result = params.get('google');
  if (!result) return false;
  if (result === 'connected') {
    toast.success('Google is connected', 'Your busy times are now checked and bookings land on your calendar.');
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
