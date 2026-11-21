// Everything the product does, and the nine promises it was built around. Moved here from the home page, which now
// says one thing and links here once.
import { refundRuleText, LANGUAGE_NOTE } from '@/lib/policy';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { publicFacts } from '@/app/help/facts';
import { BULK_COST_NOTE, DEFAULT_REMINDER_DAYS, IN_PERSON_ONLINE } from '@/lib/policy';
import { IN_PERSON_SHORT } from '@/lib/phone';
import { SIGNING_BROWSERS_SHORT, SIGNING_ONLINE } from '@/lib/mobile';

export const metadata = { title: "What it does", description: "Everything GrowSigning does, on every plan: send for signature, sign anywhere, templates, bulk send, public forms, proof you can check, teams and the API." };
// The refund window is a setting. Read it when the page is asked for, not when the site is built.
export const dynamic = "force-dynamic";

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
  ['Reports', 'See what is waiting, how long signing takes and how many documents were completed.'],
];

// What people say goes wrong with e-signature tools, and what we do instead. Each card links to where the promise is kept.
type Pledge = { said: string; title: string; text: string; href: string; link: string };

export default function Features() {
  const { refundDays } = publicFacts();

  const PROMISES: Pledge[] = [
    { said: 'A typo means voiding the document and starting over.', title: 'Fix a sent document without voiding it', text: 'Wrong email, misspelled name, a field in the wrong place? Correct the envelope while it is out. Signatures already collected stay, and it does not count as a new envelope.', href: '/help#fix-after-sending', link: 'How correcting works' },
    { said: 'The link has expired by the time the signer comes back.', title: 'Links that do not die', text: 'A signing link works for as long as the document is open, however often it is opened. If the deadline passes, the sender reopens it and the same link works again.', href: '/help#find-documents', link: 'If a link is lost' },
    { said: 'People who only want to sign are told to register.', title: 'Signers never need an account', text: 'No sign-up, no password, no trial offer and no marketing. Open the link, sign, get your copy.', href: '/security#signers', link: 'What signers can expect' },
    { said: 'Nobody can say whether a signing request is real.', title: 'Check any email is real', text: 'Every signing email carries a security code. Type it in on our site and we tell you who sent it, before you click anything.', href: '/check', link: 'Check an email' },
    { said: 'There is no cancel button to be found.', title: 'Month to month, cancel in one click', text: 'No yearly term and no notice period. One button on the Plan page, a stop link in every renewal reminder, and a way to stop without logging in. Signatures you paid for can be used until their own dates.', href: '/help#cancel', link: 'Three ways to cancel' },
    { said: 'A refund is refused a day after a renewal.', title: 'Refunds without asking', text: `${refundRuleText(refundDays)} A charge that arrives after you cancelled refunds itself.`, href: '/help#refunds', link: 'The refund rule' },
    { said: 'A bill for extra documents arrives out of nowhere.', title: 'No overage charges, ever', text: 'When your signatures run out, sending pauses. It never turns into a bill. A signature is only used when someone actually signs, so an envelope nobody signed costs nothing.', href: '/pricing', link: 'See pricing' },
    { said: 'The account is locked with the signed contracts inside.', title: 'Your documents stay yours', text: 'Export everything as one ZIP file, free, on any plan, also after you cancel. Cancelling or a failed payment never deletes or locks a document.', href: '/security#your-documents', link: 'What we promise about your data' },
    { said: 'Support is a chatbot going in circles.', title: 'A person is one click away', text: 'A helper answers at once, and under every answer is "Talk to a person": our contact form, with the chat attached if you want it. The form works without logging in, gives you a reference, and goes to a person. Every answer is emailed in full, with a private link where you follow your request, reply and say when it is solved. Nobody closes your request without writing to you.', href: '/help#contact', link: 'Write to us' },
  ];

  return (
    <div className="pub">
      <PublicNav />
      <main id="main">
        <section className="wrap section" aria-labelledby="features-h">
          <h1 id="features-h" className="pub-h1">What GrowSigning does</h1>
          <p className="pub-sub">Every feature is on every plan. Nothing is locked behind a higher tier or a sales call.</p>
          <div className="grid g3">{FEATURES.map(([t, d]) => <div key={t} className="feat"><h3>{t}</h3><p>{d}</p></div>)}</div>
        </section>


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

        <section className="wrap section">
          <p><Link href="/signup" className="btn primary lg">Start free</Link></p>
          <p className="muted small">Prices and the rules that go with them are on the <Link href="/pricing">pricing page</Link>.</p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
