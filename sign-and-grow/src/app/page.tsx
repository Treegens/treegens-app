import { refundRuleText, PRICE_NOTICE_DAYS, LANGUAGE_NOTE } from '@/lib/policy';
import { expiryShortText } from '@/lib/policy';
import Link from 'next/link';
import { Mark } from '@/components/Brand';
import { PublicNav, PublicFooter, ImpactBand, ClosedNotice } from '@/components/Public';
import { PLANS, PRICING, usd, CURRENCY_NOTE } from '@/lib/impact';
import { publicFacts, abuseFacts } from '@/app/help/facts';
import { BULK_COST_NOTE, DEFAULT_REMINDER_DAYS, IN_PERSON_ONLINE, NO_BAA_TITLE, NO_BAA_TEXT } from '@/lib/policy';
import { IN_PERSON_SHORT } from '@/lib/phone';
import { SIGNING_BROWSERS_SHORT, SIGNING_ONLINE } from '@/lib/mobile';

// The refund window is a setting. Read it when the page is asked for, not when the site is built.
export const dynamic = 'force-dynamic';

const FEATURES: [string, string][] = [
  ['Send for signature', 'Upload PDFs or images, add signers, approvers, viewers and people who get a copy. Sign in order or all at once.'],
  ['Drag and drop fields', 'Signatures, initials, dates, text, checkboxes, radio buttons, dropdowns, attachments and notes. Required or optional, prefilled or validated.'],
  ['Sign anywhere', `Recipients sign in the browser of their phone or computer, with no account and no app. ${SIGNING_BROWSERS_SHORT} Type, draw or upload a signature. Finish later, decline or pass it to someone else. ${SIGNING_ONLINE} ${LANGUAGE_NOTE}`],
  ['Templates and bulk send', `Set a document up once and reuse it. Send one template to hundreds of people from a spreadsheet. ${BULK_COST_NOTE} The page shows the count and the price before you send.`],
  ['PowerForms', 'A public link that lets anyone fill in and sign a form on their own. Put it on your website or in an email, or print the QR code the app makes for it on a sheet for a poster or a front desk. Good for waivers, sign-ups and permission slips. Not for patient forms: there is no HIPAA agreement to sign with us, as the rules under the prices say.'],
  ['In-person signing', `Host a signing on your own phone, tablet or laptop when the signer is standing next to you. ${IN_PERSON_SHORT} ${IN_PERSON_ONLINE}`],
  ['Reminders and deadlines', `A new account reminds whoever has not finished by email every ${DEFAULT_REMINDER_DAYS} days. You see that setting before every send and can change it or switch it off. A warning before a deadline, and more time in one click. An expired envelope can be reopened, and nobody signs twice.`],
  ['Proof you can check', 'Every completed envelope gets a certificate of completion, and every envelope a hash-chained audit trail. Anyone can check on our public page that a signed PDF is unchanged since signing finished.'],
  ['Teams and branding', 'Invite colleagues, share templates, set roles, and put your own logo and colour on emails and the signing screen.'],
  ['API and webhooks', 'Create envelopes, embed signing in your own product and get notified of every event. Included on every plan.'],
  ['Checking who signs', 'Protect a document with an access code you share with the signer yourself, or have us send them a one-time code by email at the moment they open it. Where the operator of the server has switched text messages on, the code can go to a mobile number you type instead, and the signing link can be texted as well. The certificate says for every signer which check was passed.'],
  ['Reports', 'See what is waiting, how long signing takes and how much paper your team has kept out of the printer.'],
];

// What people say goes wrong with e-signature tools, and what we do instead. Each card links to where the promise is kept.
type Pledge = { said: string; title: string; text: string; href: string; link: string };

const COMPARE: [string, string, string][] = [
  ['Where your money goes', '100% of what you pay goes to tree planting', 'Company profit'],
  ['A mistake after sending', 'Corrected in place, signatures kept', 'Often void and start again'],
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
  ['API, webhooks, bulk send, public forms', 'On both plans. Each person who signs uses one signature, as on any envelope', 'Often a separate, pricier plan'],
  ['Check a signed PDF', 'Public page, no account needed', 'Usually needs an account or the sender'],
  ['Audit trail', 'Hash chained, tampering is detectable', 'Event log'],
  ['Environmental impact', 'Shown on every envelope, with the maths published', 'Rarely shown'],
];

const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;

export default function Landing() {
  const { refundDays, dormantStopDays } = publicFacts();
  const P = PRICING;
  // "Bulk send is on every plan" needs its price said with it. A worked example from the same numbers the server
  // charges by: a list of 40 on the monthly plan is the month's signatures plus a top-up for the rest.
  const LIST = 40;
  const listTopUp = Math.max(0, LIST - P.monthlySignatures);
  const listUsd = P.monthlyUsd + listTopUp * P.topUpUsd;
  const { firstWeekDaily, unpaidDaily } = abuseFacts();

  const PROMISES: Pledge[] = [
    { said: 'A typo means voiding the document and starting over.', title: 'Fix a sent document without voiding it', text: 'Wrong email, misspelled name, a field in the wrong place? Correct the envelope while it is out. Signatures already collected stay, and it does not count as a new envelope.', href: '/help#fix-after-sending', link: 'How correcting works' },
    { said: 'The link has expired by the time the signer comes back.', title: 'Links that do not die', text: 'A signing link works for as long as the document is open, however often it is opened. If the deadline passes, the sender reopens it and the same link works again.', href: '/help#find-documents', link: 'If a link is lost' },
    { said: 'People who only want to sign are told to register.', title: 'Signers never need an account', text: 'No sign-up, no password, no trial offer and no marketing. Open the link, sign, get your copy.', href: '/security#signers', link: 'What signers can expect' },
    { said: 'Nobody can say whether a signing request is real.', title: 'Check any email is real', text: 'Every signing email carries a security code. Type it in on our site and we tell you who sent it, before you click anything.', href: '/check', link: 'Check an email' },
    { said: 'There is no cancel button to be found.', title: 'Month to month, cancel in one click', text: 'No yearly term and no notice period. One button on the Plan page, a stop link in every renewal reminder, and a way to stop without logging in. Signatures you paid for can be used until their own dates.', href: '/help#cancel', link: 'Three ways to cancel' },
    { said: 'A refund is refused a day after a renewal.', title: 'Refunds without asking', text: `${refundRuleText(refundDays)} A charge that arrives after you cancelled refunds itself.`, href: '/help#refunds', link: 'The refund rule' },
    { said: 'A bill for extra documents arrives out of nowhere.', title: 'No overage charges, ever', text: 'When your signatures run out, sending pauses. It never turns into a bill. A signature is only used when someone actually signs, so an envelope nobody signed costs nothing.', href: '#pricing', link: 'See pricing' },
    { said: 'The account is locked with the signed contracts inside.', title: 'Your documents stay yours', text: 'Export everything as one ZIP file, free, on any plan, also after you cancel. Cancelling or a failed payment never deletes or locks a document.', href: '/security#your-documents', link: 'What we promise about your data' },
    { said: 'Support is a chatbot going in circles.', title: 'A person is one click away', text: 'A helper answers at once, and under every answer is "Talk to a person": our contact form, with the chat attached if you want it. The form works without logging in, gives you a reference, and goes to a person. Every answer is emailed in full, with a private link where you follow your request, reply and say when it is solved. Nobody closes your request without writing to you.', href: '/help#contact', link: 'Write to us' },
  ];

  return (
    <div className="pub">
      <PublicNav />
      <main id="main">
        <ClosedNotice />
        <section className="wrap hero">
          <div>
            <div className="badge completed" style={{ marginBottom: 16 }}>100% of what you pay plants trees</div>
            <h1>You sign.<br /><em>Trees grow.</em></h1>
            <p className="lead">GrowSigning does what you expect from an e-signature tool: send, sign, track and store agreements. The difference is where the money goes. Every cent you pay funds Treegens tree planting, and every dollar plants {P.treesPerUsd} mangrove trees.</p>
            <div className="row wrap">
              <Link href="/signup" className="btn primary lg">Start free</Link>
              <Link href="/impact" className="btn lg">See the impact</Link>
            </div>
            <p className="muted small" style={{ marginTop: 14 }}>{sigs(P.welcomeSignatures)} free to start. No card needed. Signers never need an account.</p>
          </div>
          <div aria-hidden="true">
            <div className="doc-art">
              <div className="ln" style={{ width: '55%', height: 14, background: '#d9d3c4' }} />
              <div className="ln" /><div className="ln" style={{ width: '92%' }} /><div className="ln" style={{ width: '97%' }} /><div className="ln" style={{ width: '70%' }} />
              <div className="ln" style={{ marginTop: 22 }} /><div className="ln" style={{ width: '88%' }} /><div className="ln" style={{ width: '60%' }} />
              <div className="row between" style={{ marginTop: 30, alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontFamily: "'Sig Dancing', cursive", fontSize: 34, color: '#10243a', lineHeight: 1 }}>Wangari M.</div>
                  <div style={{ borderTop: '1.5px solid #17241c', width: 'min(190px, 40vw)', marginTop: 4 }} />
                  <div className="muted small">Signed via GrowSigning</div>
                </div>
                <div style={{ background: 'var(--green-soft)', borderRadius: 12, padding: '10px 14px', textAlign: 'center' }}>
                  <Mark size={22} label="" />
                  <div className="small" style={{ fontWeight: 700, color: 'var(--green-deep)' }}>6 sheets saved</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <ImpactBand />

        <section className="wrap section" aria-labelledby="promises-h">
          <p className="pub-kicker">Built from the one-star reviews</p>
          <h2 id="promises-h">Nine things that go wrong elsewhere, and what we do instead</h2>
          <p className="pub-sub">We read what people say when e-signature tools let them down. Then we built the opposite into the product. Each promise links to the place where it is kept.</p>
          <div className="grid g3">
            {PROMISES.map((p) => (
              <article key={p.title} className="pub-promise">
                <div className="said"><span>Elsewhere</span>{p.said}</div>
                <h3>{p.title}</h3>
                <p>{p.text}</p>
                <Link href={p.href}>{p.link}</Link>
              </article>
            ))}
          </div>
        </section>

        <section className="wrap section" aria-labelledby="features-h">
          <h2 id="features-h">Everything you need to get documents signed</h2>
          <p className="pub-sub">Every feature is on every plan. Nothing is locked behind a higher tier or a sales call.</p>
          <div className="grid g3">{FEATURES.map(([t, d]) => <div key={t} className="feat"><h3>{t}</h3><p>{d}</p></div>)}</div>
        </section>

        <section className="wrap section" aria-labelledby="compare-h">
          <h2 id="compare-h">How it compares</h2>
          <div className="card pad0" style={{ marginTop: 16 }}>
            <table className="t pub-cmp">
              <thead><tr><th scope="col"><span className="pub-vh">What</span></th><th scope="col">GrowSigning</th><th scope="col">Typical e-signature tools</th></tr></thead>
              <tbody>{COMPARE.map(([k, a, b]) => <tr key={k}><th scope="row">{k}</th><td data-label="GrowSigning">{a}</td><td data-label="Elsewhere">{b}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="wrap section" id="pricing" aria-labelledby="pricing-h">
          <h2 id="pricing-h">Simple pricing that plants trees</h2>
          <p className="pub-sub" style={{ marginBottom: 0 }}>You pay for signatures that actually happen. Every dollar plants {P.treesPerUsd} mangrove trees with Treegens, and both plans have the same features.</p>
          <div className="pub-plans">
            <div className="card pub-plan">
              <h3>{PLANS.seedling.name}</h3>
              <div className="price">{usd(PLANS.seedling.price)}</div>
              <p className="muted">Try it, and sign your own documents for free.</p>
              <ul>
                <li><b>{sigs(P.welcomeSignatures)} free</b> to try the product</li>
                <li>Signing your own documents is always free</li>
                <li>Every feature, including the API</li>
                <li>No card needed</li>
                <li>Signing is free for everyone you send to</li>
              </ul>
              <Link href="/signup" className="btn">Start free</Link>
            </div>
            <div className="card pub-plan best">
              <h3>{P.planName}</h3>
              <div className="price">{usd(P.monthlyUsd)}<small> / month</small></div>
              <p className="muted">For people who send regularly.</p>
              <ul>
                <li><b>{sigs(P.monthlySignatures)} added every month</b></li>
                <li>More when you need them, {usd(P.topUpUsd)} a signature</li>
                <li>A fresh {P.monthlySignatures} each month, with the reset date on screen</li>
                <li>One price for the whole team, not per person</li>
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
            <h3>The rules</h3>
            <ul>
              <li><b>What a signature is.</b> One person signing one envelope. An envelope can hold several documents, and that is still one signature for each signer.</li>
              <li><b>Only real signatures are used up.</b> Sending holds one signature for each signer, so nobody is stopped halfway. It is used when that person signs. If the envelope is voided, declined or left to expire, the ones held for people who had not signed yet come back, unless their own date has passed by then.</li>
              <li><b>What is always free.</b> Signing your own documents. Approvers, viewers and people who get a copy. Corrections, reminders and more time. And signing, for everyone you send to.</li>
              <li id="expiry"><b>When signatures expire.</b> {expiryShortText()} <Link href="/help#expiry">How signatures expire</Link>.</li>
              <li><b>Nothing is charged unless you choose it.</b> When signatures run out, sending pauses and we tell you. On {PLANS.seedling.name} you carry on by starting {P.planName}. On {P.planName} you can top up: a one-off payment at {usd(P.topUpUsd)} a signature, with the total shown before you pay. There are no overage charges.</li>
              <li><b>Month to month.</b> {P.planName} is {usd(P.monthlyUsd)} a month for the whole team. No yearly contract, no notice period, no per-person fees. Before each renewal we email you the exact amount and the date, with a link that stops it.</li>
              <li><b>Refunds are automatic.</b> {refundRuleText(refundDays)} A charge that arrives after you cancelled refunds itself. <Link href="/help#refunds">The full rule</Link>.</li>
              <li><b>No surprise price rises.</b> If the monthly price ever goes up, you are told by email at least {PRICE_NOTICE_DAYS} days before your first renewal at the new price, and a renewal that charges more without that notice refunds the difference by itself.</li>
              {dormantStopDays > 0 && <li><b>We do not charge for a plan nobody uses.</b> If nothing has been sent for {dormantStopDays} days when a renewal comes up, we stop the renewal and tell you.</li>}
              <li><b>Same features on both plans.</b> Templates, bulk send, public forms, branding, teams, the API and webhooks are on {PLANS.seedling.name} and on {P.planName}.</li>
              <li id="bulk-cost"><b>What a bulk send costs.</b> {BULK_COST_NOTE} A list of {LIST} people needs {sigs(LIST)}: starting from none on {P.planName}, that is the {P.monthlySignatures} of the month and {listTopUp} more at {usd(P.topUpUsd)} each, {usd(listUsd)} in all, paid before the batch goes out. The bulk send page shows your own numbers before you press Send. What nobody signs comes back to your balance when you void the batch or it runs out of time (unless its own date has passed by then), and the refund rule applies to it. An account that has not paid yet can newly email {firstWeekDaily} people a day in its first week and {unpaidDaily} a day after that.</li>
              <li><b>Stopping never costs you your documents.</b> Cancelling or a failed payment deletes nothing and locks nothing. Export is free.</li>
              <li><b>Where the money goes.</b> 100% of what you pay goes to Treegens tree planting. Every dollar plants {P.treesPerUsd} mangrove trees, whether its signatures are used or not.</li>
              <li id="not-for-patients"><b>{NO_BAA_TITLE}</b> {NO_BAA_TEXT} <Link href="/security#not">What would have to be true first</Link>.</li>
            </ul>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
