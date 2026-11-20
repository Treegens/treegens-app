'use client';
import Link from 'next/link';
import { PRICING } from '@/lib/impact';
import type { Allowance } from './allowance';
import { HELD_EXPIRY_TEXT, TOPUP_EXPIRY_MONTHS, WELCOME_EXPIRY_DAYS } from '@/lib/policy';

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
      {left === 0 && (
        <p className="sn-usage-note">
          <b>None left to send with.</b> Everything already out is covered and can still be signed, fixed and reminded. Nothing is charged unless you choose it.
        </p>
      )}
      {left > 0 && left <= 2 && <p className="sn-usage-note"><b>Running low.</b> Each new signer needs one. Nothing is charged unless you choose it.</p>}
      <ul className="sn-rules">
        <li><b>What uses one:</b> each person who actually signs.</li>
        <li><b>Set aside, not spent:</b> sending holds one for each signer. It comes back if you void, or if they decline or it expires. {HELD_EXPIRY_TEXT}</li>
        <li><b>Free:</b> signing your own documents, and people who only approve, view or get a copy.</li>
        <li>Fixing an envelope after sending is free, unless you add another signer.</li>
        <li><b>Signatures expire:</b> a month&apos;s {PRICING.monthlySignatures} at the end of that month, top-ups {TOPUP_EXPIRY_MONTHS} months after their payment, the free ones of a new account {WELCOME_EXPIRY_DAYS} days after it was made. The one that expires soonest is used first. <Link href={PLAN_PAGE}>Every date is on the Plan page</Link>.</li>
        <li><b>Getting more:</b> ${PRICING.monthlyUsd} a month adds {PRICING.monthlySignatures}, and extra ones are ${PRICING.topUpUsd} each. Every dollar plants {PRICING.treesPerUsd} mangrove trees.{a.freeWith ? ` Your monthly plan is free with the code ${a.freeWith}.` : ''}</li>
      </ul>
    </section>
  );
}
