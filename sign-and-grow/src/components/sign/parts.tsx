'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo, Mark, SentWith } from '@/components/Brand';
import { savedLine } from '@/components/sign/actions';
import { jumpRatherThanGlide } from '@/components/pdfMemory';
import { orgOf } from '@/lib/sendername';
import { headingFor } from '@/lib/consentfit';
import { signT } from '@/lib/signlang';
import { useSignLang, useDocumentLang, SignLangProvider, LanguageMenu, langAttrs } from '@/components/sign/lang';

/** The roles whose screens never say "Please sign": they approve, read or witness. */
const NOT_SIGNING = ['approver', 'viewer', 'witness'];

const ICONS: Record<string, string> = {
  download: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14',
  pen: 'M4 20l1.2-4.4L16.6 4.2a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4L8.4 18.8 4 20Zm10.6-13.8 3.2 3.2',
  clip: 'M19.5 11.5 12 19a4.6 4.6 0 0 1-6.5-6.5L13.4 4.6a3 3 0 0 1 4.3 4.3L10 16.6a1.5 1.5 0 0 1-2.2-2.1l6.9-6.9',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  clock: 'M12 7.5V12l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  mail: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm-.5 1.5L12 13l8.5-5.5',
  stop: 'M5.6 5.6l12.8 12.8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};
export const Icon = ({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
    <path d={ICONS[name]} />
  </svg>
);

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return on;
}

// A sender can choose any brand colour for the bar. Pick whichever text colour stays readable on it.
function inkOn(hex?: string | null): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.2 ? '#17241c' : '#ffffff';
}

/**
 * Where "Help" leads from a signing screen: the help page with the topic chosen and, when the screen knows it, which
 * document this is about. A message written from there then names the document, so the people who answer see it
 * and its sender can be told. Once the document is open to this person the link carries the security code of their
 * emails (help_code); before that, the envelope's id, which proves nothing by itself. It never carries the signing
 * link's own secret, because the address of a page ends up in logs and in the browser's history.
 */
export const helpHref = (data?: any, anchor = 'signing') =>
  `/help?topic=signing${data?.help_code ? `&code=${encodeURIComponent(data.help_code)}` : data?.envelope?.id ? `&envelope=${encodeURIComponent(data.envelope.id)}` : ''}#${anchor}`;

export function Shell({ data, children, bar, bottom, footer, titleIsHeading, live, helpInNewTab, plainBar, onHelp }: {
  data?: any;
  children: ReactNode;
  /** Controls on the right of the top bar. */
  bar?: ReactNode;
  /** The bar that stays at the bottom of a phone screen. */
  bottom?: ReactNode;
  /** Extra footer links, shown before Help. */
  footer?: ReactNode;
  titleIsHeading?: boolean;
  /** Read out politely by screen readers when it changes. */
  live?: string;
  helpInNewTab?: boolean;
  /** The bar shows our logo and not the document's name: for a screen whose own heading is that name (the consent). */
  plainBar?: boolean;
  /** Opens the help dialog. With it, Help is one button in the top bar and the footer has no second Help (charter 2.6, P12). */
  onHelp?: () => void;
}) {
  const brand = data?.brand;
  // Someone asked to approve, read or witness is not asked to sign: no "Please sign: " over their screen (headingFor).
  const title = data?.envelope?.subject ? headingFor(data.envelope.subject, NOT_SIGNING.includes(data?.recipient?.role)) : 'GrowSigning';
  const named = !!data?.envelope?.subject && !plainBar;
  const style = brand?.brand_color ? ({ ['--brand' as any]: brand.brand_color, ['--sg-bar-ink' as any]: inkOn(brand.brand_color) }) : undefined;
  // The language of everything under the Shell, on its root as lang and dir (src/components/sign/lang.tsx).
  const lang = useSignLang(data);
  useDocumentLang(lang);
  const T = (key: string) => signT(lang, key);
  return (
    <SignLangProvider value={lang}>
    <div className="sg-shell" {...langAttrs(lang)}>
      <a className="sg-skip" href="#sg-main">{T('sign.shell.skip')}</a>
      <header className="signbar sg-bar" style={style}>
        {brand?.brand_logo ? <img className="sg-logo" src={brand.brand_logo} alt={brand.name || T('sign.shell.logo')} /> : named && <Mark size={24} tone={brand?.brand_color ? 'mono' : 'dark'} />}
        {/* With no subject to show (a link that did not open), the bar shows the drawn logo, never the mark beside the typed name. */}
        {(() => {
          // With the language menu there, a phone shows the leaf alone rather than a logo cut off mid-word (sign.css).
          const shown = named ? <span dir="auto">{title}</span> : <><span className="sg-logo-full"><Logo height={20} tone={brand?.brand_color ? 'mono' : 'dark'} style={{ display: 'block' }} /></span><span className="sg-logo-small"><Mark size={24} tone={brand?.brand_color ? 'mono' : 'dark'} /></span></>;
          return titleIsHeading ? <h1 className="sg-title grow truncate">{shown}</h1> : <div className="sg-title grow truncate">{shown}</div>;
        })()}
        <LanguageMenu lang={lang} />
        {bar}
        {onHelp && <button type="button" className="btn sm sg-other sg-help" aria-haspopup="dialog" onClick={onHelp}>{T('sign.shell.help')}</button>}
      </header>
      <main id="sg-main" className="signwrap" tabIndex={-1}>{children}</main>
      <footer className="sg-foot">
        <div className="sg-foot-links">
          {footer}
          {!onHelp && <a href={helpHref(data)} {...(helpInNewTab ? { target: '_blank', rel: 'noreferrer' } : {})}>{T('sign.shell.help')}{helpInNewTab && <span className="sg-vh"> {T('sign.shell.new_tab')}</span>}</a>}
        </div>
        <div className="sg-foot-by"><SentWith height={16} /></div>
      </footer>
      {bottom && <div className="sg-bottom">{bottom}</div>}
      <div className="sg-vh" role="status" aria-live="polite">{live || ''}</div>
    </div>
    </SignLangProvider>
  );
}

const TONE_ICON: Record<string, string> = { ok: 'check', warn: 'clock', stop: 'stop', lock: 'lock', link: 'link', mail: 'mail', wait: 'clock' };

/** One clear message in the middle of the screen, for every state that is not the document itself. */
export function StateCard({ tone, title, children }: { tone: keyof typeof TONE_ICON; title: string; children?: ReactNode }) {
  return (
    <div className="card sg-state">
      <div className={`sg-state-icon ${tone}`}><Icon name={TONE_ICON[tone]} size={26} /></div>
      <h1 className="serif" id="sg-h1" tabIndex={-1}>{title}</h1>
      {children}
    </div>
  );
}

/** Who sent this, so the person can judge the request and knows whom to contact. */
export function Sender({ env, brand, lead = 'Sent by' }: { env: any; brand?: any; lead?: string }) {
  const s = env.sender || {};
  return (
    <dl className="sg-who">
      <div><dt>{lead}</dt><dd><b>{s.name}</b></dd></div>
      <div><dt>Email</dt><dd><a href={`mailto:${s.email}`}>{s.email}</a></dd></div>
      {/* The account's name only when it says more than the sender's own, never the "Rosa Gardener's workspace" every
          new account is called (orgOf, as on the consent screen and in the email). */}
      {orgOf(brand?.name, s.name) && <div><dt>Account</dt><dd>{orgOf(brand?.name, s.name)}</dd></div>}
    </dl>
  );
}

export function Impact({ impact }: { impact: any }) {
  if (!impact?.sheets) return null;
  const saved = savedLine(impact);
  return (
    <div className="card sg-impact">
      <Mark size={28} label="" />
      <div>
        <b>Signed without paper</b>
        <p>
          {/* A figure that rounds to nothing is left out, and one sheet is "1 sheet" (savedLine in sign/actions.ts). */}
          About <b>{saved.sheets}</b>{saved.rest} {saved.verb} not used, by our estimate.
        </p>
        {/* Opens in a new tab: the page it leads to is for everyone, with buttons to sign up, and someone who has
            just signed is not carried off to it. Nothing here asks a signer to buy or join anything. */}
        <a className="sg-more" href="/impact" target="_blank" rel="noreferrer">How we count<span className="sg-vh"> (opens in a new tab)</span></a>
      </div>
    </div>
  );
}

export const prefersLessMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls so the element sits a given fraction of the way down the screen. */
export function bringIntoView(el: Element, fraction = 0.45) {
  const go = (behavior: ScrollBehavior) => {
    const r = el.getBoundingClientRect();
    // Zoomed in, the pages are wider than the screen and slide sideways in their own strip: bring the field to its middle.
    const pan = el.closest('.sg-pan');
    if (pan && pan.scrollWidth > pan.clientWidth) pan.scrollTo({ left: pan.scrollLeft + r.left + r.width / 2 - pan.getBoundingClientRect().left - pan.clientWidth / 2, behavior });
    window.scrollTo({ top: Math.max(0, r.top + window.scrollY + r.height / 2 - window.innerHeight * fraction), behavior });
  };
  // Far away (page 51 seen from page 1), a glide passes pages that are still being laid out and stopped about 800 px
  // past the field. So a far field is jumped to, and only a near one glides (src/components/pdfMemory.ts).
  const far = jumpRatherThanGlide(el.getBoundingClientRect().top - window.innerHeight * fraction, window.innerHeight);
  go(far || prefersLessMotion() ? 'auto' : 'smooth');
  // Check where it landed once the scrolling has stopped (and once more a moment later, for a browser that does not
  // say when scrolling stops), and put it right if pages moved the field meanwhile.
  const check = () => {
    window.removeEventListener('scrollend', check);
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.top < 64 || r.bottom > window.innerHeight - 96) go('auto');
  };
  if ('onscrollend' in window) window.addEventListener('scrollend', check);
  window.setTimeout(check, 900);
}
