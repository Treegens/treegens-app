// A share link: growsigning.com/<name> (src/server/sharelinks.ts). Any address at the top level of the site that is
// not one of its own pages comes here; Next serves the site's own pages first, and a share name can never be one of
// them (RESERVED in src/lib/sharename.ts). A document's link asks "Who are you?"; a public form's link is the form.
import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { sharePage, type SharePage as SharePageData } from '@/server/sharelinks';
import { rateLimit } from '@/server/util';
import { clientIp } from '@/server/router';
import { SHARE_LOOKUPS_PER_MINUTE } from '@/lib/policy';
import { isShareName } from '@/lib/sharename';
import { OG_ALT } from '@/lib/site';
import { WhoAreYou } from '@/components/share/WhoAreYou';
import { ShareForm } from '@/components/share/ShareForm';

// Read from the database for each visitor, never built ahead and never kept by a cache in between.
export const dynamic = 'force-dynamic';

const OG_IMAGE = { url: '/opengraph-image.png', width: 1200, height: 630, alt: OG_ALT };
type Props = { params: Promise<{ name: string }> };

// One decision for each visit, shared by the page and by its title and link preview (React keeps the answer for
// the length of one request): the lookup is counted for each internet address, the same limit as the API's, and
// once the limit is reached neither the page nor its title says whether a name exists or what a document is called.
// null: too many lookups.
const look = cache(async (name: string): Promise<SharePageData | null> => {
  if (!isShareName(name)) return { state: 'none' };
  const h = await headers();
  const ip = clientIp(new Request('http://share.invalid/', { headers: { 'x-forwarded-for': h.get('x-forwarded-for') || '' } }));
  try {
    if (ip && ip !== 'unknown') rateLimit(`share-look:${ip}`, SHARE_LOOKUPS_PER_MINUTE, 60_000);
    else rateLimit('share-look:everyone', SHARE_LOOKUPS_PER_MINUTE * 10, 60_000);
  } catch {
    return null;
  }
  return sharePage(name);
});

// In a link preview: the document's name and "Sent with GrowSigning", nothing else, with the site's own picture.
// Never in a search engine. Only a link that is open for signing, or a form that is open, gives its name: one that
// is off, renamed, closed or asked for too often gives none.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await params;
  const page = await look(name);
  const title = page && (page.state === 'open' || page.state === 'form') && page.title ? page.title : 'Share link';
  const description = 'Sent with GrowSigning.';
  return {
    title, description, robots: { index: false, follow: false, nocache: true }, referrer: 'no-referrer',
    // The site's own picture (src/app/opengraph-image.png), named here because a page that sets its own Open Graph
    // words does not take the picture over from the layout.
    openGraph: { title, description, siteName: 'GrowSigning', type: 'website', images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE] },
  };
}

export default async function SharePage({ params }: Props) {
  const { name } = await params;
  if (!isShareName(name)) notFound();
  const page = await look(name);
  if (page?.state === 'none') notFound();
  if (page?.state === 'form') return <ShareForm slug={page.slug} />;
  return <WhoAreYou name={name} page={page} />;
}
