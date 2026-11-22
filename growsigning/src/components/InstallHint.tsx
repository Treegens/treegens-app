'use client';
import { useEffect, useRef, useState } from 'react';
import { INSTALL_VISITS, INSTALL_HELP_ID } from '@/lib/phoneapp';
import { toast } from './ui';
import { useST } from './senderLang';

// One line on Home, on a phone only: "Add GrowSigning to your home screen" (research/ux-notes.json, ds-phone-app).
// It shows on the first 3 visits from a phone, or until it is dismissed, and never in the app that is already on the
// home screen. Android's own "add" question is asked only when the person presses the line; with none to ask (an
// iPhone, or a browser that does not offer one), the line opens the Help answer with the steps. No popup of its own.
const KEY = 'sg_home_screen_hint';

type Seen = { visits: number; gone: boolean };
function read(): Seen {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { visits: Number(v.visits) || 0, gone: !!v.gone };
  } catch {
    return { visits: 0, gone: false };
  }
}
function write(s: Seen) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage can be unavailable: then it shows again next time, which is harmless */
  }
}

/** Whether this is a phone in a browser, not the app on the home screen and not a computer. */
export function onPhoneInBrowser(): boolean {
  try {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
    return !standalone && window.matchMedia('(max-width: 760px) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function InstallHint() {
  const T = useST();
  const [show, setShow] = useState(false);
  const ask = useRef<any>(null);
  useEffect(() => {
    if (!onPhoneInBrowser()) return;
    const seen = read();
    if (seen.gone) return;
    // A visit is a session of the browser tab, so moving between pages does not use up the three.
    let counted = false;
    try {
      counted = sessionStorage.getItem(KEY) === '1';
      if (!counted) sessionStorage.setItem(KEY, '1');
    } catch {
      /* without session storage every opening of Home counts */
    }
    const visits = counted ? seen.visits : seen.visits + 1;
    if (!counted) write({ ...seen, visits });
    if (visits > INSTALL_VISITS) return;
    setShow(true);
    const keep = (e: Event) => {
      e.preventDefault();
      ask.current = e;
    };
    window.addEventListener('beforeinstallprompt', keep);
    return () => window.removeEventListener('beforeinstallprompt', keep);
  }, []);
  if (!show) return null;
  const hide = () => (write({ ...read(), gone: true }), setShow(false));
  // The line goes from under the keyboard's focus: focus moves to the page heading, and the live region says so,
  // so a keyboard or screen-reader user is not sent back to the top of the page.
  const dismiss = () => {
    hide();
    try {
      const h = document.querySelector<HTMLElement>('main h1') || document.querySelector<HTMLElement>('h1');
      if (h) {
        if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
        h.focus();
      }
    } catch {
      /* no heading to go to: the toast still says what happened */
    }
    toast(T('home.add_dismissed'));
  };
  const add = async (e: React.MouseEvent) => {
    if (!ask.current) return; // the link opens the steps on /help
    e.preventDefault();
    try {
      await ask.current.prompt();
      const choice = await ask.current.userChoice;
      ask.current = null;
      if (choice?.outcome === 'accepted') hide();
    } catch {
      window.location.assign(`/help#${INSTALL_HELP_ID}`);
    }
  };
  return (
    <p className="sn-drafts ph-hint" data-feature="ds-phone-app">
      <a href={`/help#${INSTALL_HELP_ID}`} onClick={add}>{T('home.add_to_home_screen')}</a>
      <button type="button" className="ph-hint-x" onClick={dismiss} aria-label={T('home.add_dismiss_label')}>×</button>
    </p>
  );
}
