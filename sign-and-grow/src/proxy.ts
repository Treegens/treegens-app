// Who may show a signing page or the sender screen inside a frame (src/server/embed.ts decides; this only sets the
// header). A signing link handed out for one of the account's websites may be framed by that website alone; every
// other signing page only by our own pages; the sender screen only by the website it was made for. Never "*".
// A browser that reads frame-ancestors ignores the X-Frame-Options of next.config.mjs.
import { NextResponse, type NextRequest } from 'next/server';
import { frameAncestors } from './server/embed';

export function proxy(request: NextRequest) {
  const res = NextResponse.next();
  let policy: string | null = null;
  try {
    policy = frameAncestors(request.nextUrl.pathname, request.nextUrl.searchParams);
  } catch {
    // If the answer cannot be worked out, the page may not be framed by anyone else.
    policy = "frame-ancestors 'self'";
  }
  if (policy) res.headers.set('Content-Security-Policy', policy);
  return res;
}

export const config = { matcher: ['/sign/:path*', '/embed/:path*'] };
