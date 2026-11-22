import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';

// Any address this app does not have: a mistyped one, an old bookmark, a link that lost its end in an email program.
// The same header and footer as every public page, so the person sees whose site it is and has a way on.
export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page narrow">
        <header className="pub-top">
          <h1 className="pub-h1">We could not find that page</h1>
          <p className="pub-lead">Nothing is at this address. Opening it changed nothing: your documents are where they were.</p>
        </header>
        <section className="pub-aside" aria-labelledby="nf-next">
          <h2 id="nf-next">What you can do</h2>
          <p><b>Came from a link in an email?</b> Email programs sometimes cut a long link in two. Go back to the email and press the button in it, or copy the whole link into the address bar.</p>
          <p><b>Looking for a document you signed or were sent?</b> <Link href="/help#find-documents">Find my documents</Link> emails you a link to each one. You do not need an account.</p>
          <p><b>Typed the address yourself?</b> Check it for a slip, or start from one of these.</p>
          <p style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <Link href="/" className="btn primary" style={{ minHeight: 44 }}>Go to the home page</Link>
            <Link href="/login" className="btn" style={{ minHeight: 44 }}>Sign in</Link>
            <Link href="/help" className="btn" style={{ minHeight: 44 }}>Get help</Link>
          </p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
