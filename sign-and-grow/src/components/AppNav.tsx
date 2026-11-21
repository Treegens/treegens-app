'use client';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { NAV_START, NAV_MAIN, NAV_END, IN_TAB_BAR, moreFor, insideMore, moreKey, navOn, type NavItem } from '@/lib/nav';

// The app's navigation (research/ux-charter.md, section 2.1): the sidebar's entries with the closed More group, and
// the phone's bottom bar. The list itself is in src/lib/nav.ts.

const Entry = ({ item, path, onGo }: { item: NavItem; path: string; onGo?: () => void }) => (
  <Link href={item.href} className={`nav${navOn(item.href, path) ? ' on' : ''}${IN_TAB_BAR.includes(item.href) ? ' in-bar' : ''}`} aria-current={navOn(item.href, path) ? 'page' : undefined} onClick={onGo}>{item.label}</Link>
);

/** The start button and the pages above Help. `onGo` closes the phone's menu when an entry is pressed. */
export function SideNav({ path, role, userId, onGo }: { path: string; role: string; userId: string; onGo?: () => void }) {
  // More is closed. It opens by itself on a page inside it, and stays open for a person who opened it, so someone
  // who uses "Send to many" every day does not pay a click each time.
  const [kept, setKept] = useState(false);
  useEffect(() => {
    try {
      setKept(localStorage.getItem(moreKey(userId)) === '1');
    } catch {
      /* storage can be unavailable: More is then closed on every visit */
    }
  }, [userId]);
  const inside = insideMore(path, role);
  const open = kept || inside;
  const listId = useId();
  function toggle() {
    const next = !open;
    setKept(next);
    try {
      if (next) localStorage.setItem(moreKey(userId), '1');
      else localStorage.removeItem(moreKey(userId));
    } catch {}
  }
  return (
    <>
      <Link href={NAV_START.href} className="btn side-start in-bar" onClick={onGo}>{NAV_START.label}</Link>
      {NAV_MAIN.map((n) => <Entry key={n.href} item={n} path={path} onGo={onGo} />)}
      <div data-more="nav">
        {/* On a page inside More the group cannot be closed: the page you are on stays in view, and the arrow that
            would close it is not drawn (start.css). */}
        <button type="button" className="nav nav-more-toggle" aria-expanded={open} aria-controls={listId} onClick={inside ? undefined : toggle} aria-disabled={inside || undefined}>More</button>
        <div id={listId} className="nav-more-list" hidden={!open}>
          {moreFor(role).map((n) => <Entry key={n.href} item={n} path={path} onGo={onGo} />)}
        </div>
      </div>
      {NAV_END.map((n) => <Entry key={n.href} item={n} path={path} onGo={onGo} />)}
    </>
  );
}

const ICON = {
  home: <path d="M4 11.5 12 5l8 6.5V20h-5.5v-5h-5v5H4z" />,
  docs: <path d="M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M9.5 12h6M9.5 15.5h6" />,
  send: <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />,
  sign: <path d="M4 17.5c3-6 5-9 6.5-9 2 0-1.5 7 .5 7 1.5 0 2.5-3 4-3 1 0 1 2 2 2h3M4 20.5h16" />,
  menu: <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};
const Icon = ({ name }: { name: keyof typeof ICON }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICON[name]}</svg>
);

/**
 * Phones: a bar at the bottom with Home, Documents, Send, To sign and Menu, so the start button is always under the
 * thumb. On wider screens it is not shown (src/app/styles/start.css). "Menu" opens the sidebar with everything else.
 * The bar stays on top of the open menu and its last button then reads "Close", in the place that opened it.
 */
export function TabBar({ path, menuOpen, onMenu }: { path: string; menuOpen: boolean; onMenu: () => void }) {
  const tab = (href: string, label: string, icon: keyof typeof ICON) => (
    <Link href={href} className={navOn(href, path) ? 'on' : undefined} aria-current={navOn(href, path) ? 'page' : undefined}><Icon name={icon} /><span>{label}</span></Link>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab('/app', 'Home', 'home')}
      {tab('/app/envelopes', 'Documents', 'docs')}
      <Link href={NAV_START.href} className="tab-send" aria-label={NAV_START.label}><span className="dot"><Icon name="send" /></span><span>Send</span></Link>
      {tab('/app/inbox', 'To sign', 'sign')}
      <button type="button" id="tab-menu" data-more="nav" aria-expanded={menuOpen} aria-controls="app-menu" onClick={onMenu}><Icon name={menuOpen ? 'close' : 'menu'} /><span>{menuOpen ? 'Close' : 'Menu'}</span></button>
    </nav>
  );
}
