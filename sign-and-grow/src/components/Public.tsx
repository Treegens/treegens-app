'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, useLoad } from './ui';
import { Logo } from './Brand';
import { fmtNum, usd, TOTALS_FROM, totalWorthShowing } from '@/lib/impact';
import { HelpChatButton } from './HelpChat';

// Shared frame of the public pages: the top navigation, the footer and the live impact numbers.

// Help is one entry, the button that opens the helper (HelpChat.tsx). The help page is the link inside it, and in the footer.
const LINKS: [string, string][] = [
  ['/impact', 'Impact'],
  ['/check', 'Check an email'],
  ['/security', 'Security'],
  ['/verify', 'Verify a document'],
  ['/developers', 'API'],
];

export function PublicNav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = (href: string) => (path === href ? ({ 'aria-current': 'page' } as const) : {});

  return (
    <>
      <a href="#main" className="pub-skip">Skip to the main content</a>
      <header className="pub-head">
        <div className="nav-top">
          <Link href="/" className="logo"><Logo height={26} /></Link>
          <nav className="pub-links" aria-label="Main">
            {LINKS.map(([href, label]) => <Link key={href} href={href} className="btn ghost sm" {...current(href)}>{label}</Link>)}
          </nav>
          <div className="pub-actions">
            {/* The help chat: answers at once, with a person one click away (HelpChat.tsx). */}
            <HelpChatButton className="btn sm hc-open">Help</HelpChatButton>
            <Link href="/login" className="btn sm pub-signin">Sign in</Link>
            <Link href="/signup" className="btn primary sm">Start free</Link>
            <button ref={menuButton} type="button" className="btn sm pub-menu-btn" aria-expanded={open} aria-controls="pub-menu" onClick={() => setOpen((o) => !o)}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              {open ? 'Close' : 'Menu'}
            </button>
          </div>
        </div>
        <nav id="pub-menu" className="pub-menu" aria-label="Menu" hidden={!open}>
          {/* On a phone the header has no room for the help chat's button, so it is the first thing in the menu. */}
          <HelpChatButton className="hc-menu">Help</HelpChatButton>
          {LINKS.map(([href, label]) => <Link key={href} href={href} {...current(href)} onClick={() => setOpen(false)}>{label}</Link>)}
          <Link href="/#pricing" onClick={() => setOpen(false)}>Pricing</Link>
          <Link href="/login" onClick={() => setOpen(false)}>Sign in</Link>
        </nav>
      </header>
    </>
  );
}

export function PublicFooter() {
  // The address people can write to, printed on every public page when one is set (SUPPORT_EMAIL).
  const [support] = useLoad(() => api('/public/support'));
  return (
    <footer className="foot pub-foot">
      <div className="wrap pub-foot-grid">
        <div className="pub-foot-brand">
          <Link href="/" className="logo"><Logo height={22} /></Link>
          <p>100% of what you pay goes to Treegens tree planting.</p>
          <p>Stuck? <Link href="/help#contact">Write to us</Link>{support?.email ? <> or email <a href={`mailto:${support.email}`}>{support.email}</a></> : null}. A person replies, and you do not need to log in.</p>
        </div>
        <nav aria-label="Product">
          <h2>Product</h2>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/impact">Impact</Link>
          <Link href="/developers">API reference</Link>
          <Link href="/signup">Start free</Link>
        </nav>
        <nav aria-label="Help">
          <h2>Help</h2>
          <Link href="/help">The help page</Link>
          <Link href="/help#find-documents">Find my documents</Link>
          <Link href="/help#cancel">Stop a subscription</Link>
          <Link href="/help#contact">Contact a person</Link>
        </nav>
        <nav aria-label="Trust">
          <h2>Trust</h2>
          <Link href="/check">Check an email</Link>
          <Link href="/verify">Verify a document</Link>
          <Link href="/security">Security</Link>
          <Link href="/security/disclosure">Report a weakness</Link>
        </nav>
      </div>
    </footer>
  );
}

// The totals on the landing page. A total is shown only once it is large enough to mean something (TOTALS_FROM in
// src/lib/impact.ts): until then, and while it loads, the band is simply absent. No share of a tree, and every
// figure about paper is called an estimate. Numbers come from this service, the factors from src/lib/impact.ts.
export function ImpactBand() {
  const [i] = useLoad(() => api('/public/impact'));
  const paper = totalWorthShowing(i?.sheets);
  const planted = Number(i?.treesFunded) >= TOTALS_FROM.treesPlanted;
  if (!i || (!paper && !planted)) return null;
  return (
    <section className="band" aria-labelledby="impact-h">
      <div className="wrap">
        <h2 id="impact-h">What signing here has done so far</h2>
        <p className="pub-band-lead">
          Everything customers pay goes to Treegens to plant mangroves, and a document signed on screen is not printed.
        </p>
        <div className="grid g4 keep2">
          {planted && <div className="stat"><div className="k">Mangroves funded</div><div className="v num">{fmtNum(i.treesFunded)}</div><div className="s">from {usd(fmtNum(i.donatedUsd))} paid by customers</div></div>}
          {paper && <div className="stat"><div className="k">Sheets of paper not used, estimated</div><div className="v num">{fmtNum(i.sheets)}</div></div>}
          {paper && <div className="stat"><div className="k">Litres of water not used, estimated</div><div className="v num">{fmtNum(i.litresWater)}</div></div>}
        </div>
        <p className="small pub-band-foot">Numbers from this service. <Link href="/impact">See exactly how we count</Link>.</p>
      </div>
    </section>
  );
}

// Shown on the landing page to someone who has just closed their account for good (Settings sends them to /?closed=now).
export function ClosedNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(new URLSearchParams(window.location.search).get('closed') === 'now'), []);
  if (!show) return null;
  return (
    <div className="wrap" role="status">
      <div className="notice pub-closed">
        <b>Your account is closed and deleted.</b> Any subscription has been stopped and you will not be charged again. Thank you for the trees. If anything looks wrong, <Link href="/help#contact">write to us</Link>.
      </div>
    </div>
  );
}
