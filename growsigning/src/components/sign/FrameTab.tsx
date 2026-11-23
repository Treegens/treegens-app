'use client';
// A signing page inside a frame on another website cannot remember an access code: the browser keeps no cookie for
// it there. The server does not hand out such links for someone with a code (src/server/embed.ts framedLink), but a
// code can be added to a person after their link was made. Then the right code is accepted and forgotten at once,
// and this says so in place of asking for the code again and again.
import { api } from '@/components/ui';
import { frameOrigin } from './frame';

/** After a right access code: true when the page is in a frame and the code was forgotten straight away. */
export async function codeForgottenInFrame(base: string): Promise<boolean> {
  if (!frameOrigin()) return false;
  const d = await api(base).catch(() => null);
  return !!d?.locked && (d.needs ?? 'access_code') === 'access_code';
}

/** The way out: the same signing link in its own tab, where the code is kept. */
export function OwnTabLink() {
  if (typeof window === 'undefined') return null;
  return (
    <a className="btn lg" href={window.location.pathname} target="_blank" rel="noopener" style={{ marginTop: 10 }}>
      Open in its own tab
    </a>
  );
}
