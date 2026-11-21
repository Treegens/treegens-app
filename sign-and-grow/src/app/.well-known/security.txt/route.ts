import { securityTxt } from '../../../lib/selfhost.ts';
import { siteBase } from '../../../lib/site.ts';

// /.well-known/security.txt (RFC 9116), made from SECURITY_CONTACT each time it is asked for (src/lib/selfhost.ts).
// Without a contact there is no file: 404, and /security/disclosure says who to ask instead. (Relative imports, so
// tests/selfhost.test.ts can call GET itself.)
export const dynamic = 'force-dynamic';

export function GET() {
  const text = securityTxt(siteBase().origin);
  if (!text) return new Response('No security contact is set up on this server. See /security/disclosure.\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
