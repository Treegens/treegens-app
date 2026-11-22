// Where Android sends a PDF or photos shared into GrowSigning from another app (the manifest's share_target,
// src/lib/phoneapp.ts). The work is done by POST /api/share-target (src/server/routes-phoneapp.ts): this page
// passes the request on and turns a refusal into a page a person can read, since the phone opens it as a page.
import { POST as api } from '../api/[...path]/route';
import { PRODUCT } from '@/lib/site';
import { shareOrigin, SHARE_FROM_ELSEWHERE } from '@/lib/phoneapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, said: string, href: string, button: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · ${PRODUCT}</title>
<style>:root{--paper:#f7f5ef;--ink:#1d2a22;--deep:#134a2c;--muted:#55625a}@media (prefers-color-scheme:dark){:root{--paper:#111813;--ink:#e9efe9;--deep:#7cc79a;--muted:#a9b5ad}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;box-sizing:border-box;background:var(--paper);color:var(--ink);font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:26rem}h1{font-size:22px;margin:0 0 8px}p{color:var(--muted)}a{display:inline-flex;align-items:center;min-height:44px;padding:0 22px;border-radius:10px;background:var(--deep);color:var(--paper);font-weight:600;text-decoration:none}a:focus-visible{outline:3px solid var(--ink);outline-offset:3px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(said)}</p><a href="${esc(href)}">${esc(button)}</a></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  // "Origin: null" is dropped only for a share from the phone itself (shareOrigin in src/lib/phoneapp.ts).
  const from = shareOrigin(headers.get('origin'), headers.get('sec-fetch-site'));
  if (from === 'refuse') return page('The file was not added', SHARE_FROM_ELSEWHERE, '/app', `Open ${PRODUCT}`, 403);
  if (from === 'drop') headers.delete('origin');
  const res = await api(new Request(new URL('/api/share-target', url), { method: 'POST', headers, body: req.body, duplex: 'half' } as RequestInit));
  if (res.status === 303) return res;
  if (res.status === 401) return page('Sign in first', `Your file was not kept. Sign in to ${PRODUCT} on this phone, then share the file again.`, '/login?next=/app', 'Sign in', 401);
  const said = await res.json().then((d: any) => String(d?.error || ''), () => '');
  return page('The file was not added', said || 'Something went wrong on our side. Share the file again in a moment, or upload it in GrowSigning.', '/app', `Open ${PRODUCT}`, res.status);
}

// Opened by hand, the address has nothing to show: back to the app.
export function GET(): Response {
  return new Response(null, { status: 303, headers: { location: '/app' } });
}
