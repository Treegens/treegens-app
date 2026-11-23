'use client';
import Link from 'next/link';
import { PRICING } from '@/lib/impact';
import type { Allowance } from './allowance';
import { expiryMoment, expiredWords } from '@/lib/policy';
import { InviteChoices, useInvite } from './InviteFriend';
import { useST } from '@/components/senderLang';

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
  // Invite a friend (InviteFriend.tsx): null where the offer is off, so nothing of it draws there.
  const inv = useInvite();
  const T = useST();
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
        {/* With none left, the two ways to get more stand side by side below instead (LowChoices). */}
        {left > 0 && <Link href={PLAN_PAGE} className="btn sm">{canUpgrade ? 'Get more signatures' : 'See the plan'}</Link>}
      </div>
      {/* When they reset, like a usage limit. The rules live in one place: the Plan page, behind this link. */}
      <p className="sn-usage-when muted">
        {left > 0 && a.period ? <>This month&apos;s signatures {a.period.fresh === 'none' ? 'expire' : 'reset'} on {expiryMoment(a.period.resets_at)}. </> : left > 0 && a.firstExpiry ? <>The first of them expire on {expiryMoment(a.firstExpiry)}. </> : null}
        <Link href={PLAN_PAGE}>How signatures work</Link>
        {/* With some left, the invite offer is one quiet link to its card on the Plan page, never a pitch. */}
        {left > 0 && inv?.open && <> · <Link href={`${PLAN_PAGE}#invite`}>{T('invite.title', { count: inv.rules.signatures })}</Link></>}
      </p>
      {left === 0 && (
        <p className="sn-usage-note">
          <b>None left to send with.</b> {a.renewalPending ? <>Your new month&apos;s {PRICING.monthlySignatures} arrive when the renewal payment goes through, usually within the hour. </> : expiredWords(a.lastExpiry) ? <>{expiredWords(a.lastExpiry)} {a.plan === 'grove' ? 'Top up on the Plan page to send again. ' : 'Start the monthly plan to send again. '}</> : null}Documents already sent can still be signed. Nothing is charged unless you choose it.
        </p>
      )}
      {left > 0 && left <= 2 && <p className="sn-usage-note"><b>Running low.</b> Each new signer needs one. Nothing is charged unless you choose it.</p>}
      {left === 0 && <LowChoices plan={a.plan} canUpgrade={canUpgrade} inv={inv} />}
    </section>
  );
}

// Out of signatures: the two ways to get more, side by side (InviteFriend.tsx). "Get more signatures" is the Plan
// page as before; "Invite a friend" is the person's own link to pass on. Where the invite offer is off, only the
// first one draws. With one or two left the card keeps its one button and one link: the owner asked for the offer
// when people run out, and a new account is at two left after its very first send.
function LowChoices({ plan, canUpgrade, inv }: { plan: string; canUpgrade: boolean; inv: ReturnType<typeof useInvite> }) {
  const note = plan === 'grove' ? `Top up at $${PRICING.topUpUsd} a signature: one payment you choose.` : `The monthly plan is $${PRICING.monthlyUsd} for ${PRICING.monthlySignatures} signatures.`;
  return (
    <InviteChoices inv={inv} note={`${note}${canUpgrade ? '' : ' An owner or admin of your team can do this.'}`}
      more={<Link href={PLAN_PAGE} className="btn sm primary">{canUpgrade && plan === 'grove' ? 'Top up' : 'See the plan'}</Link>} />
  );
}
