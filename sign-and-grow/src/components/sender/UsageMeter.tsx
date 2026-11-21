'use client';
import Link from 'next/link';
import { PRICING } from '@/lib/impact';
import type { Allowance } from './allowance';
import { expiryMoment, expiredWords } from '@/lib/policy';

const PLAN_PAGE = '/app/settings?tab=billing';

// The signature balance, shown as a number with the counting rule in plain words, so nobody meets it for the first
// time as an error. Renders nothing when nothing is counted.
export function AllowanceCard({ allowance, canUpgrade }: { allowance: Allowance; canUpgrade: boolean }) {
  if (!allowance) return null;
  return <SignatureBalance a={allowance} canUpgrade={canUpgrade} />;
}

// A balance of signatures. One is used each time somebody signs; sending only sets them aside.
function SignatureBalance({ a, canUpgrade }: { a: NonNullable<Allowance>; canUpgrade: boolean }) {
  const left = Math.max(0, a.available);
  return (
    <section className={`card sn-usage${left === 0 ? ' full' : left <= 2 ? ' low' : ''}`} aria-labelledby="sn-usage-h">
      <div className="sn-usage-top">
        <div className="grow">
          <h2 id="sn-usage-h">Signatures</h2>
          <p className="sn-usage-line">
            <b className="num">{left}</b> {left === 1 ? 'signature' : 'signatures'} left to send with.
            {a.held > 0 ? <> <span className="muted">{a.held} more {a.held === 1 ? 'is' : 'are'} set aside for people who have not signed yet.</span></> : null}
          </p>
        </div>
        <Link href={PLAN_PAGE} className="btn sm">{canUpgrade ? 'Get more and plant mangroves' : 'See the plan'}</Link>
      </div>
      {/* When they reset, like a usage limit. The rules live in one place: the Plan page, behind this link. */}
      <p className="sn-usage-when muted">
        {left > 0 && a.period ? <>This month&apos;s signatures {a.period.fresh === 'none' ? 'expire' : 'reset'} on {expiryMoment(a.period.resets_at)}. </> : left > 0 && a.firstExpiry ? <>The first of them expire on {expiryMoment(a.firstExpiry)}. </> : null}
        <Link href={PLAN_PAGE}>How signatures work</Link>
      </p>
      {left === 0 && (
        <p className="sn-usage-note">
          <b>None left to send with.</b> {a.renewalPending ? <>Your new month&apos;s {PRICING.monthlySignatures} arrive when the renewal payment goes through, usually within the hour. </> : expiredWords(a.lastExpiry) ? <>{expiredWords(a.lastExpiry)} {a.plan === 'grove' ? 'Top up on the Plan page to send again. ' : 'Start the monthly plan to send again. '}</> : null}Everything already out is covered and can still be signed, fixed and reminded. Nothing is charged unless you choose it.
        </p>
      )}
      {left > 0 && left <= 2 && <p className="sn-usage-note"><b>Running low.</b> Each new signer needs one. Nothing is charged unless you choose it.</p>}
    </section>
  );
}
