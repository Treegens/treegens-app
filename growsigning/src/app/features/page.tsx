// Everything the product does, and the nine promises it was built around. Moved here from the home page, which now
// says one thing and links here once.
import { refundRuleText, LANGUAGE_NOTE } from '@/lib/policy';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { publicFacts } from '@/app/help/facts';
import { BULK_COST_NOTE, DEFAULT_REMINDER_DAYS, IN_PERSON_ONLINE } from '@/lib/policy';
import { SIGNING_ONLINE } from '@/lib/mobile';

export const metadata = { title: "What it does", description: "Everything GrowSigning does, on every plan: send for signature, sign anywhere, templates, Send to many, forms, proof you can check, teams and the API." };
// The refund window is a setting. Read it when the page is asked for, not when the site is built.
export const dynamic = "force-dynamic";

const FEATURES: [string, string, [string, string]?][] = [
  ['Send for signature', 'Upload PDFs or pictures and add the people who sign, approve, view or get a copy, in order or all at once.'],
  ['Drag and drop fields', 'Signatures, initials, dates, text, tick boxes, choices and attachments, each one required or not.'],
  ['Sign anywhere', `People sign in the browser of their phone or computer, with no account and no app. ${SIGNING_ONLINE} ${LANGUAGE_NOTE}`],
  ['Templates and Send to many', `Set a document up once and reuse it. Send one template to hundreds of people from a spreadsheet. ${BULK_COST_NOTE}`],
  ['Forms', 'A public link anyone can fill in and sign on their own. Put it on your website, or print the QR code the app makes for it. Not for patient forms.', ['/pricing#not-for-patients', 'Why not for patient forms']],
  ['In-person signing', `Hand your own phone, tablet or laptop to a signer standing next to you. ${IN_PERSON_ONLINE}`],
  ['Reminders and deadlines', `A new account reminds whoever has not finished by email every ${DEFAULT_REMINDER_DAYS} days. You can change that before each send.`],
  ['Proof you can check', 'Every completed document gets a signing record, and anyone can check on our site that a signed PDF is unchanged since it was finished.', ['/verify', 'Check a signed document']],
  ['Teams and branding', 'Invite colleagues, share templates, and put your own logo and colour on emails and the signing page.'],
  ['Signing inside your own site', 'Developers can send documents and show signing inside their own product, on every plan.', ['/developers', 'See the API']],
  ['Checking who signs', 'An access code you tell them, or a code we email them. The signing record says which check each person passed.'],
  ['Reports', 'What is waiting, how long signing takes, and what was completed.'],
];

// What people say goes wrong with e-signature tools, and what we do instead. Each card links to where the promise is kept.
type Pledge = { said: string; title: string; text: string; href: string; link: string };

export default function Features() {
  const { refundDays } = publicFacts();

  const PROMISES: Pledge[] = [
    { said: 'A typo means cancelling the document and starting over.', title: 'Fix a sent document without cancelling it', text: 'Wrong email, misspelled name, a field in the wrong place? Correct the document while it is out. Signatures already collected stay, and it does not count as a new document.', href: '/help#fix-after-sending', link: 'How correcting works' },
    { said: 'The link has expired by the time the signer comes back.', title: 'Links that do not die', text: 'A signing link works for as long as the document is open, however often it is opened. If the deadline passes, the sender reopens it and the same link works again.', href: '/help#find-documents', link: 'If a link is lost' },
    { said: 'People who only want to sign are told to register.', title: 'Signers never need an account', text: 'No sign-up, no password, no trial offer and no marketing. Open the link, sign, get your copy.', href: '/security#signers', link: 'What signers can expect' },
    { said: 'Nobody can say whether a signing request is real.', title: 'Check any email is real', text: 'Every signing email carries a security code. Type it in on our site and we tell you who sent it, before you click anything.', href: '/check', link: 'Check an email' },
    { said: 'There is no cancel button to be found.', title: 'Month to month, cancel in one click', text: 'No yearly term and no notice period. One button on the Plan page, a stop link in every renewal reminder, and a way to stop without logging in. Signatures you paid for can be used until their own dates.', href: '/help#cancel', link: 'Three ways to cancel' },
    { said: 'A refund is refused a day after a renewal.', title: 'Refunds without asking', text: `${refundRuleText(refundDays)} A charge that arrives after you cancelled refunds itself.`, href: '/help#refunds', link: 'The refund rule' },
    { said: 'A bill for extra documents arrives out of nowhere.', title: 'No overage charges, ever', text: 'When your signatures run out, sending pauses. It never turns into a bill. A signature is only used when someone actually signs, so a document nobody signed costs nothing.', href: '/pricing', link: 'See pricing' },
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
          <div className="grid g3">{FEATURES.map(([t, d, more]) => <div key={t} className="feat"><h3>{t}</h3><p>{d}{more ? <> <Link href={more[0]}>{more[1]}</Link>.</> : null}</p></div>)}</div>
        </section>


        <section className="wrap section" aria-labelledby="promises-h">
          {/* Closed until asked for, so the page is the list of what it does and one button. */}
          <details className="pub-fold" data-fold="">
          <summary id="promises-h">Nine things that go wrong elsewhere, and what we do instead</summary>
          <p className="pub-sub">Built from the one-star reviews of other e-signature tools. Each promise links to the place where it is kept.</p>
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
          </details>
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
