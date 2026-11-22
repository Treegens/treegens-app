import { PublicNav, PublicFooter } from '@/components/Public';
import { LinkedRequest } from '../../../RequestView';

// The address holds the secret of one help request. Search engines are told to stay away, and the browser is told
// never to pass the address on to another site.
export const metadata = { title: 'Your request', description: 'One help request: where it stands, everything written so far, and a way to reply. No login needed.', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

// Opened from the link in our emails about a help request. It works without signing in, because the people who need
// help most are the ones who cannot.
export default function RequestPage() {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page narrow">
        <LinkedRequest />
      </main>
      <PublicFooter />
    </div>
  );
}
