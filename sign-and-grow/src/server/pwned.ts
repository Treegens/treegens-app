// A new password is looked up in the list of passwords that have appeared in leaks (Pwned Passwords), wherever one
// is chosen: at sign-up, with the emailed link, and under Settings.
//
// What leaves this server: the first 5 of the 40 characters of the password's SHA-1 fingerprint, nothing else. The
// list answers with every fingerprint ending it knows for those 5 (several hundred), and the comparison with the
// other 35 characters happens here. The password, its whole fingerprint, the address and the name of the person
// never leave. "Add-Padding" asks the list to pad its answer, so its size says nothing either.
//
// It never stands in the way when it cannot run: with no answer in PWNED_TIMEOUT_MS, an answer that is not the
// list, or a network that refuses the call, the password is allowed, and nothing anywhere says it was checked.
//
// Settings: PWNED_CHECK=0 switches it off. HIBP_RANGE_URL names another copy of the list (a mirror inside a closed
// network); it must be an http(s) address. With OUTSIDE_CALLS=none the check is switched off when the server starts,
// unless the host of the list is in OUTBOUND_ALLOW (src/lib/outside.ts).
import crypto from 'node:crypto';
import { PWNED_TIMEOUT_MS, pwnedUrl as rangeUrl } from '../lib/signinrules.ts';

type Env = Record<string, string | undefined>;

/** Where the list is asked, or null when the check is off (pwnedUrl in src/lib/signinrules.ts reads the settings). */
export const pwnedUrl = (env: Env = process.env): string | null => rangeUrl(env);

export const pwnedOn = (env: Env = process.env): boolean => !!pwnedUrl(env);

export type PwnedAnswer = 'leaked' | 'not_found' | 'not_checked';

/**
 * Whether the password is in the list. 'not_checked' when the check is off or the list did not answer as a list in
 * time: the caller allows the password then and claims nothing.
 */
export async function pwnedLookup(password: string, env: Env = process.env): Promise<PwnedAnswer> {
  const url = pwnedUrl(env);
  if (!url || !password) return 'not_checked';
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5), rest = sha1.slice(5);
  try {
    const res = await fetch(`${url}${prefix}`, { headers: { 'add-padding': 'true', accept: 'text/plain' }, redirect: 'error', signal: AbortSignal.timeout(PWNED_TIMEOUT_MS) });
    if (!res.ok) return 'not_checked';
    const text = (await res.text()).slice(0, 400_000);
    let lines = 0, found = false;
    for (const line of text.split('\n')) {
      // "35 characters of the fingerprint:how often it was seen". A padded line has 0 and is nobody's password.
      const m = /^([0-9A-Fa-f]{35}):(\d+)\s*$/.exec(line.trim());
      if (!m) continue;
      lines++;
      if (Number(m[2]) > 0 && m[1].toUpperCase() === rest) found = true;
    }
    // An answer without a single line of the list is not the list (an error page, an empty body): not a check.
    return found ? 'leaked' : lines ? 'not_found' : 'not_checked';
  } catch {
    return 'not_checked';
  }
}
