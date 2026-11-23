// Prices, the rules that go with them, and how they compare. Moved here from the home page, which now says one thing.
import { refundRuleText, PRICE_NOTICE_DAYS } from '@/lib/policy';
import { expiryShortText } from '@/lib/policy';
import { referralOfferOn, referralRulesFrom } from '@/lib/referral';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { OpenOnHash } from '@/components/OpenOnHash';
import { DeploymentHome } from '@/components/DeploymentHome';
import { isDeploymentBilling } from '@/lib/billingmode';
import { PLANS, PRICING, usd, CURRENCY_NOTE, treesFor } from '@/lib/impact';
import { publicFacts, abuseFacts } from '@/app/help/facts';
import { BULK_COST_NOTE, NO_BAA_TITLE, NO_BAA_TEXT } from '@/lib/policy';

export const metadata = { title: 'Pricing', description: 'What GrowSigning costs, the rules that go with the prices, and how it compares. You pay for signatures that actually happen, and every signature plants 5 trees with Treegens.' };
// The refund window is a setting. Read it when the page is asked for, not when the site is built.
export const dynamic = 'force-dynamic';

const COMPARE: [string, string, string][] = [
  ['Where your money goes', 'What you pay, less card fees, goes to tree planting', 'Company profit'],
  ['A mistake after sending', 'Corrected in place, signatures kept', 'Often cancel and start again'],
  ['Signing links', 'Work while the document is open, with no click limit', 'Often expire after a few days or a few opens'],
  ['Signers', 'Never need an account, never pay', 'Often nudged to register'],
  ['Billing', 'Month to month', 'Often a yearly commitment'],
  ['Cancelling', 'One click, also without logging in', 'Often hard to find, or through support'],
  ['What you pay for', 'Signatures that were actually made', 'Often every document sent, signed or not'],
  ['What you do not use', 'A month\'s signatures expire at its end, with the date and time always on screen. The soonest to expire is used first, and you are emailed before top-ups expire', 'Often lost at renewal without a word'],
  ['Running out', 'Sending pauses. Never a charge you did not choose', 'Often billed per extra document'],
  ['Refunds', 'Automatic for what you have not used', 'Usually decided case by case'],
  ['If you stop paying', 'Nothing is deleted or locked', 'Access can be cut off'],
  ['Taking your documents with you', 'One free export, any time', 'Often one at a time, or a paid add-on'],
  ['API, webhooks, Send to many, forms', 'On both plans. Each person who signs uses one signature, as on any document', 'Often a separate, pricier plan'],
  ['Check a signed PDF', 'Public page, no account needed', 'Usually needs an account or the sender'],
  ['History of each document', 'Each step is sealed to the one before, so a later change shows', 'Event log'],
  ['Paper and trees', 'The paper each document saves, as an estimate, with the working published', 'Rarely shown'],
];

const sigs = (n: number) => `${n} signature${n === 1 ? "" : "s"}`;

export default function Pricing() {
  // A server under a government agreement has no consumer plan: say what is paid there, and link the price list.
  if (isDeploymentBilling()) return <DeploymentHome title="Pricing" />;
  const { refundDays, dormantStopDays } = publicFacts();
  const P = PRICING;
  // "Bulk send is on every plan" needs its price said with it. A worked example from the same numbers the server
  // charges by: a list of 40 on the monthly plan is the month's signatures plus a top-up for the rest.
  const LIST = 40;
  const listTopUp = Math.max(0, LIST - P.monthlySignatures);
  const listUsd = P.monthlyUsd + listTopUp * P.topUpUsd;
  const { firstWeekDaily, unpaidDaily } = abuseFacts();

  return (
    <div className="pub">
      <PublicNav />
      <main id="main">
        <section className="wrap section" id="pricing" aria-labelledby="pricing-h">
          <h1 id="pricing-h" className="pub-h1">Simple pricing that plants trees</h1>
          <p className="pub-sub" style={{ marginBottom: 0 }}>You pay for signatures that actually happen. Every signature plants {P.treesPerSignature} trees with Treegens, the free ones too, and both plans have the same features.</p>
          <div className="pub-plans">
            <div className="card pub-plan">
              <h3>{PLANS.seedling.name}</h3>
              <div className="price">{usd(PLANS.seedling.price)}</div>
              <p className="muted">Try it, and sign your own documents for free.</p>
              <ul>
                <li><b>{sigs(P.welcomeSignatures)} free</b> to try the product, {treesFor(P.welcomeSignatures)} trees planted</li>
                <li>No card needed</li>
                {referralOfferOn(process.env) && <li><b>Invite a friend:</b> you both get {sigs(referralRulesFrom(process.env).signatures)} extra free once someone signs the first document your friend sends. <Link href="/help#invite">The rules</Link></li>}
                <li>Signing is free for everyone you send to</li>
              </ul>
              <Link href="/signup" className="btn">Start free</Link>
            </div>
            <div className="card pub-plan best">
              <h3>{P.planName}</h3>
              <div className="price">{usd(P.monthlyUsd)}<small> / month</small></div>
              <p className="muted">For people who send regularly.</p>
              <ul>
                <li><b>{sigs(P.monthlySignatures)} added every month</b>, {treesFor(P.monthlySignatures)} trees</li>
                <li>More when you need them, {usd(P.topUpUsd)} a signature</li>
                <li>Month to month. Cancel in one click</li>
              </ul>
              <Link href="/signup" className="btn primary">Start free, upgrade any time</Link>
            </div>
          </div>

          <p className="muted small pub-code-note">Were you given a code? Some communities get {P.planName} free. Enter it when you <Link href="/signup">sign up</Link>, or later on the Plan page.</p>
          {/* A bare "$9" reads as local dollars in half the world, and a simple signature is not enough for every
              document in every country. Both are said here, before anyone signs up. */}
          <p className="muted small pub-code-note" id="currency">{CURRENCY_NOTE}</p>
          <p className="muted small pub-code-note">GrowSigning makes simple electronic signatures. Whether that is enough depends on your country and on the kind of document: <Link href="/help#enough">check before you rely on it</Link>.</p>

          <div className="card pub-rules">
            <h2 id="rules">The rules</h2>
            {/* Three lines say the most of it. The rest is one press away, and a link to one of them opens the fold (OpenOnHash). */}
            <ul>
              <li><b>What a signature is.</b> One person signing one document. A document can hold several files, and that is still one signature for each person who signs.</li>
              <li><b>Nothing is charged unless you choose it.</b> When signatures run out, sending pauses and we tell you. On {PLANS.seedling.name} you carry on by starting {P.planName}. On {P.planName} you can top up: a one-off payment at {usd(P.topUpUsd)} a signature, with the total shown before you pay. There are no overage charges.</li>
              <li><b>Refunds are automatic.</b> {refundRuleText(refundDays)} A charge that arrives after you cancelled refunds itself. <Link href="/help#refunds">The full rule</Link>.</li>
            </ul>
            <details className="pub-fold" id="all-rules" data-fold="">
            <summary>All the rules</summary>
            <ul>
              <li><b>Only real signatures are used up.</b> Sending holds one signature for each person who has to sign, so nobody is stopped halfway. It is used when that person signs. If the document is cancelled, declined or left to expire, the ones held for people who had not signed yet come back, unless their own date has passed by then.</li>
              <li><b>What is always free.</b> Signing your own documents. Approvers, viewers and people who get a copy. Corrections, reminders and more time. And signing, for everyone you send to.</li>
              <li id="expiry"><b>When signatures expire.</b> {expiryShortText()} <Link href="/help#expiry">How signatures expire</Link>.</li>
              <li><b>Month to month.</b> {P.planName} is {usd(P.monthlyUsd)} a month for the whole team. No yearly contract, no notice period, no per-person fees. Before each renewal we email you the exact amount and the date, with a link that stops it.</li>
              <li><b>No surprise price rises.</b> If the monthly price ever goes up, you are told by email at least {PRICE_NOTICE_DAYS} days before your first renewal at the new price, and a renewal that charges more without that notice refunds the difference by itself.</li>
              {dormantStopDays > 0 && <li><b>We do not charge for a plan nobody uses.</b> If nothing has been sent for {dormantStopDays} days when a renewal comes up, we stop the renewal and tell you.</li>}
              <li><b>Same features on both plans.</b> Templates, Send to many, forms, branding, teams, the API and webhooks are on {PLANS.seedling.name} and on {P.planName}.</li>
              <li id="bulk-cost"><b>What Send to many costs.</b> {BULK_COST_NOTE} A list of {LIST} people needs {sigs(LIST)}: starting from none on {P.planName}, that is the {P.monthlySignatures} of the month and {listTopUp} more at {usd(P.topUpUsd)} each, {usd(listUsd)} in all, paid before the batch goes out. The Send to many page shows your own numbers before you press Send. What nobody signs comes back to your balance when you cancel the batch or it runs out of time (unless its own date has passed by then), and the refund rule applies to it. An account that has not paid yet can newly email {firstWeekDaily} people a day in its first week and {unpaidDaily} a day after that.</li>
              <li><b>Stopping never costs you your documents.</b> Cancelling or a failed payment deletes nothing and locks nothing. Export is free.</li>
              <li><b>Where the money goes.</b> What you pay, less card fees, goes to Treegens tree planting. Every signature plants {P.treesPerSignature} mangrove trees, the free ones included.</li>
              <li id="not-for-patients"><b>{NO_BAA_TITLE}</b> {NO_BAA_TEXT} <Link href="/security#not">What would have to be true first</Link>.</li>
            </ul>
            </details>
            <OpenOnHash />
          </div>
        </section>

        {/* Closed until asked for: the plans and the three rules are what most people came for. */}
        <section className="wrap section" aria-labelledby="compare-h">
          <details className="pub-fold" id="compare" data-fold="">
          <summary id="compare-h">How it compares with other e-signature tools</summary>
          <div className="card pad0" style={{ marginTop: 16 }}>
            <table className="t pub-cmp">
              <thead><tr><th scope="col"><span className="pub-vh">What</span></th><th scope="col">GrowSigning</th><th scope="col">Typical e-signature tools</th></tr></thead>
              <tbody>{COMPARE.map(([k, a, b]) => <tr key={k}><th scope="row">{k}</th><td data-label="GrowSigning">{a}</td><td data-label="Elsewhere">{b}</td></tr>)}</tbody>
            </table>
          </div>
          </details>
        </section>

      </main>
      <PublicFooter />
    </div>
  );
}
