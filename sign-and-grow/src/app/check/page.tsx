import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { CheckForm } from './CheckForm';

export const metadata = { title: 'Check an email', description: 'Enter the security code from a signing email and we tell you whether it is genuine, who sent it and where the document is.' };

export default function Check() {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page narrow">
        <header className="pub-top">
          <h1 className="pub-h1">Check an email</h1>
          <p className="pub-lead">Got an email asking you to sign something? Before you click anything in it, enter its security code here. We tell you whether the email is real and who sent it.</p>
        </header>

        <CheckForm />

        <section className="pub-aside" aria-labelledby="why-h">
          <h2 id="why-h">Why this is safe</h2>
          <p>You typed this address yourself, so you are on the real Sign&Grow and not on a copy that a link took you to. The code only tells you who sent the email and where the document is: we never ask for a password, a card number or a payment, here or by email.</p>
        </section>
        <section className="pub-aside" aria-labelledby="where-h">
          <h2 id="where-h">Where to find the code</h2>
          <p>It is in a box near the bottom of the email, under the words &quot;Not sure this email is real?&quot;. It looks like ABCD-EFGH-JKLM. Signing requests, reminders and completion emails all carry one.</p>
          <p>An email that asks you to sign and has no code did not come from us. The only emails with document links and no code are the ones you ask for yourself with <Link href="/help#find-documents">Find my documents</Link>.</p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
