'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, useLoad, Leaf } from './ui';
import { fmtNum, fmtTrees, IMPACT } from '@/lib/impact';

// Shared frame of the public pages: the top navigation, the footer and the live impact numbers.

const LINKS: [string, string][] = [
  ['/impact', 'Impact'],
  ['/help', 'Help'],
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
          <Link href="/" className="logo"><Leaf color="#1f6f43" size={24} /> Sign&Grow</Link>
          <nav className="pub-links" aria-label="Main">
            {LINKS.map(([href, label]) => <Link key={href} href={href} className="btn ghost sm" {...current(href)}>{label}</Link>)}
          </nav>
          <div className="pub-actions">
            <Link href="/login" className="btn sm pub-signin">Sign in</Link>
            <Link href="/signup" className="btn primary sm">Start free</Link>
            <button ref={menuButton} type="button" className="btn sm pub-menu-btn" aria-expanded={open} aria-controls="pub-menu" onClick={() => setOpen((o) => !o)}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              {open ? 'Close' : 'Menu'}
            </button>
          </div>
        </div>
        <nav id="pub-menu" className="pub-menu" aria-label="Menu" hidden={!open}>
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
          <Link href="/" className="logo"><Leaf color="#1f6f43" size={20} /> Sign&Grow</Link>
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
          <Link href="/help">Help</Link>
          <Link href="/help#find-documents">Find my documents</Link>
          <Link href="/help#cancel">Stop a subscription</Link>
          <Link href="/help#contact">Contact a person</Link>
        </nav>
        <nav aria-label="Trust">
          <h2>Trust</h2>
          <Link href="/check">Check an email</Link>
          <Link href="/verify">Verify a document</Link>
          <Link href="/security">Security</Link>
        </nav>
      </div>
    </footer>
  );
}

// The live totals on the landing page. Numbers come from this service, the factors from src/lib/impact.ts.
export function ImpactBand() {
  const [imp] = useLoad(() => api('/public/impact'));
  const v = (f: (i: any) => string) => (imp ? f(imp) : '…');
  return (
    <section className="band" aria-labelledby="impact-h">
      <div className="wrap">
        <h2 id="impact-h">Paper has a cost. So we count it.</h2>
        <p className="pub-band-lead">
          One tree makes roughly {fmtNum(IMPACT.sheetsPerTree)} sheets of office paper, and each sheet takes about {IMPACT.litresWaterPerSheet} litres of water to produce. Everyone using Sign&Grow has so far kept this much out of the printer:
        </p>
        <div className="grid g4 keep2" aria-live="polite" aria-busy={!imp}>
          <div className="stat"><div className="k">Sheets of paper saved</div><div className="v num">{v((i) => fmtNum(i.sheets))}</div></div>
          <div className="stat"><div className="k">Trees left standing</div><div className="v num">{v((i) => fmtTrees(i.trees))}</div></div>
          <div className="stat"><div className="k">Litres of water not used</div><div className="v num">{v((i) => fmtNum(i.litresWater))}</div></div>
          <div className="stat"><div className="k">Sent to tree planting</div><div className="v num">{v((i) => `$${fmtNum(i.donatedUsd)}`)}</div><div className="s">{imp?.treesFunded != null ? `${fmtNum(imp.treesFunded)} mangrove trees funded` : 'everything customers pay'}</div></div>
        </div>
        <p className="small pub-band-foot">Live numbers from this service. <Link href="/impact">See exactly how we count</Link>.</p>
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
