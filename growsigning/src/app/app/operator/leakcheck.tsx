'use client';
// One line on /app/operator when this server does not look new passwords up in the list of leaked ones
// (GET /api/operator/leak-check, src/server/routes-secpolicy.ts). With the check on, nothing is drawn.
import { api, useLoad } from '@/components/ui';

export function LeakCheckLine() {
  const [d] = useLoad<{ on: boolean; why: 'outside_calls' | 'setting' | null } | null>(() => api('/operator/leak-check').catch(() => null));
  if (!d || d.on) return null;
  return (
    <p className="notice small" role="status" data-feature="ds-sec-policy">
      {d.why === 'outside_calls'
        ? 'Leaked-password check off: no outside calls. OUTSIDE_CALLS=none switched it off; add the host of the list to OUTBOUND_ALLOW to keep it.'
        : 'Leaked-password check off: PWNED_CHECK switches it off, or HIBP_RANGE_URL is not an http(s) address.'}
      {' '}New passwords are still held to the length rules.
    </p>
  );
}
