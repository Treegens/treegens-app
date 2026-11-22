// The total cost of running GrowSigning yourself, from your own numbers (src/lib/govpricing.ts, tco()).
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { Calculator } from './Calculator';

export const metadata = { title: 'Cost calculator', description: 'Add up what running GrowSigning costs a public body in a year: servers, staff, support, text messages and email, at your own prices. The licence costs nothing.' };

export default function Tco() {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap section stack tco">
        <div>
          <h1 className="pub-h1">What running it costs you</h1>
          <p className="pub-sub" style={{ marginBottom: 0 }}>The licence is free. What remains is your own servers, staff and messages. Enter your numbers and see the total for a year and for each signature.</p>
        </div>
        <Calculator />
        <p className="muted small no-print">The fees for support are on <Link href="/pricing/government">Government prices</Link>.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
