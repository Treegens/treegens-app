import { PublicNav, PublicFooter } from '@/components/Public';
import { StopView } from './StopView';

export const metadata = { title: 'Stop renewing', description: 'Stop a Sign&Grow subscription from renewing. One button, no login needed.', robots: { index: false } };

// Opened from the links in billing emails. The token in the address says which account, so nobody has to log in.
export default function StopBilling() {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page narrow">
        <StopView />
      </main>
      <PublicFooter />
    </div>
  );
}
