'use client';
import Link from 'next/link';
import { PLANS } from '@/lib/impact';
import type { Allowance } from './allowance';
import { longDateUtc } from './lib';

const PLAN_PAGE = '/app/settings?tab=billing';

// The limit on sending, shown as a number with the counting rule in plain words, so nobody meets it for the first
// time as an error. Renders nothing when the account has no limit.
export function AllowanceCard({ allowance, canUpgrade }: { allowance: Allowance; canUpgrade: boolean }) {
  if (!allowance) return null;
  return allowance.kind === 'envelopes' ? <EnvelopeMeter a={allowance} canUpgrade={canUpgrade} /> : <SignatureBalance a={allowance} canUpgrade={canUpgrade} />;
}

// A monthly number of envelopes, with its reset date.
function EnvelopeMeter({ a, canUpgrade }: { a: Extract<Allowance, { kind: 'envelopes' }>; canUpgrade: boolean }) {
  const { used, limit } = a;
  const left = Math.max(0, limit - used);
  const reset = longDateUtc(a.resets_at);
  const plan = PLANS[a.plan as keyof typeof PLANS]?.name || 'Free';
  return (
    <section className={`card sn-usage${left === 0 ? ' full' : left === 1 ? ' low' : ''}`} aria-labelledby="sn-usage-h">
      <div className="sn-usage-top">
        <div className="grow">
          <h2 id="sn-usage-h">{plan} plan this month</h2>
          <p className="sn-usage-line"><b className="num">{Math.min(used, limit)} of {limit}</b> envelopes used this month{reset ? `, resets on ${reset}` : ''}.</p>
        </div>
        <Link href={PLAN_PAGE} className="btn sm">{canUpgrade ? 'See plans and plant trees' : 'See the plan'}</Link>
      </div>
      <div className="sn-meter" role="progressbar" aria-label="Envelopes used this month" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-valuetext={`${Math.min(used, limit)} of ${limit} used`}>
        <i style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
      </div>
      {left === 0 && (
        <p className="sn-usage-note">
          <b>That was the last one for this month.</b> New envelopes can be sent again{reset ? ` on ${reset}` : ' next month'}, or sooner on a bigger plan. Everything already out can still be signed, fixed and reminded.
        </p>
      )}
      {left === 1 && <p className="sn-usage-note"><b>One left this month.</b> After that, sending waits until{reset ? ` ${reset}` : ' next month'}. Nothing extra is ever charged.</p>}
      <ul className="sn-rules">
        <li><b>What counts:</b> only envelopes that are out for signature or completed.</li>
        <li><b>What does not:</b> voided, declined and expired envelopes.</li>
        <li>Fixing an envelope after sending is free.</li>
        <li>Signing your own documents is always free.</li>
        <li>Nothing extra is ever charged. At the limit, sending simply waits for the reset.</li>
      </ul>
    </section>
  );
}

// A balance of signatures. One is used each time somebody signs; sending only sets them aside.
function SignatureBalance({ a, canUpgrade }: { a: Extract<Allowance, { kind: 'signatures' }>; canUpgrade: boolean }) {
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
        <Link href={PLAN_PAGE} className="btn sm">{canUpgrade ? 'Get more and plant trees' : 'See the plan'}</Link>
      </div>
      {left === 0 && (
        <p className="sn-usage-note">
          <b>None left to send with.</b> Everything already out is covered and can still be signed, fixed and reminded. Nothing is charged unless you choose it.
        </p>
      )}
      {left > 0 && left <= 2 && <p className="sn-usage-note"><b>Running low.</b> Each new signer needs one. Nothing is charged unless you choose it.</p>}
      <ul className="sn-rules">
        <li><b>What uses one:</b> each person who actually signs.</li>
        <li><b>Set aside, not spent:</b> sending holds one for each signer. It comes back if you void, or if they decline or it expires.</li>
        <li><b>Free:</b> signing your own documents, and people who only approve, view or get a copy.</li>
        <li>Fixing an envelope after sending is free, unless you add another signer.</li>
        <li>Signatures do not run out at the end of the month.</li>
      </ul>
    </section>
  );
}
