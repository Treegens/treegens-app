import fs from 'node:fs';
import path from 'node:path';
import { procurementDoc } from '../../../lib/procurement.ts';

// /procurement/<slug>: one procurement document, as the Markdown text it is kept in under docs/ on this server. Only
// the documents named in src/lib/procurement.ts are served, by their slug, so nothing else in docs/ (or anywhere else)
// can be asked for. (Relative imports, so tests/gov-g03.test.ts can call GET itself.)
export const dynamic = 'force-dynamic';

// A mistyped or old address: a small page with a link back to the list, so nobody is left on bare text.
const NOT_FOUND = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No such document</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;color:#1a1a1a;background:#fff}main{max-width:40rem;margin:0 auto}a{display:inline-flex;align-items:center;min-height:44px;color:#14532d;font-weight:600}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#86efac}}</style></head><body><main><h1>No such document</h1><p>There is no procurement document at this address. The link may be old or mistyped.</p><p><a href="/procurement">Open the list of procurement documents</a></p></main></body></html>\n';
const notFound = () => new Response(NOT_FOUND, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function GET(_req: Request, ctx: { params: Promise<{ doc: string }> }) {
  const { doc } = await ctx.params;
  let slug = String(doc || '');
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // A broken escape is simply no document.
  }
  const d = procurementDoc(slug);
  if (!d) return notFound();
  let body: Buffer;
  try {
    body = fs.readFileSync(path.join(/* turbopackIgnore: true */ process.cwd(), d.file));
  } catch {
    return text(`This server was installed without its docs folder, so "${d.title}" cannot be sent from here. It is in the source of the software, at ${d.file}.\n`, 404);
  }
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="growsigning-${d.slug}"`,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
