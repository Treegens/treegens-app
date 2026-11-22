// The home page and the price page of a server run under a government agreement (BILLING_MODE=deployment). The
// consumer pages talk about paying per signature, top-ups and trees per signature, none of which happens there, so
// both say what does: nobody pays here. A server component: the pages ask isDeploymentBilling() and render this.
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { GOV_PUBLIC_LINE } from '@/lib/billingmode';

export function DeploymentHome({ title }: { title: string }) {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page">
        <h1 className="pub-h1">{title}</h1>
        <p className="pub-lead">{GOV_PUBLIC_LINE}</p>
        <p className="row wrap" style={{ gap: 12 }}>
          <Link href="/login" className="btn primary lg">Sign in</Link>
          <Link href="/verify" className="btn lg">Check a signed document</Link>
        </p>
        <p>What a public body pays for a service like this one: <Link href="/pricing/government">Government prices</Link>.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
