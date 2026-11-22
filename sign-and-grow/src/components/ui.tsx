'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toastLift } from '@/lib/toastplace';
import { fmtDateTag } from '@/lib/dates';
import { signedOutPath } from '@/lib/signinrules';
import { Mark } from './Brand';

// The reader's time zone, sent along when the app loads, so dates in emails match the dates on screen.
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// The sender screen inside a customer's app has no cookie, only the token its link gave it (screenToken.ts).
import { screenHeaders } from './screenToken';

export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...screenHeaders(), ...(path === '/me' && !opts.method ? { 'x-tz': timeZone() } : {}), ...(opts.headers || {}) },
    body: opts.form || (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  // A sign-in rule of the account signed this browser out (src/server/secpolicy.ts): a page of the app goes to the
  // sign-in page, which says why, instead of showing the refusal next to whatever was pressed.
  if (res.status === 401 && data.code === 'signed_out' && (data.why === 'idle' || data.why === 'elsewhere') && window.location.pathname.startsWith('/app')) window.location.assign(signedOutPath(data.why, `${window.location.pathname}${window.location.search}`));
  // Some refusals carry a code a screen can act on (a stale copy, a change that needs a signer to sign again), next
  // to the sentence for the person. Both travel with the error.
  // A signing link whose document was paused while the page was open (src/server/timing.ts): the page reloads into
  // its paused card instead of showing the refusal as an error.
  if (res.status === 409 && data.code === 'paused' && path.startsWith('/sign/')) window.dispatchEvent(new Event('sg:paused'));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status, code: data.code as string | undefined, data });
  return data;
}

// Toasts: call toast('Saved') from anywhere.
type T = { id: number; msg: string; err?: boolean };
let push: (t: T) => void = () => {};
export function toast(msg: string, err = false) {
  push({ id: Date.now() + Math.random(), msg, err });
}
export const oops = (e: any) => toast(e?.message || 'Something went wrong.', true);
// A web address in a message is shown as a link, so "use the contact form at .../help" can be followed from the toast.
const withLinks = (msg: string) => msg.split(/(https?:\/\/[^\s]*[^\s.,;:!?)])/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part));
export function Toasts() {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    push = (t) => {
      setList((l) => [...l, t]);
      // A refusal can be a paragraph (why sending is paused, and what still works). It stays long enough to be read.
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.err ? Math.min(30000, Math.max(6000, t.msg.length * 60)) : 3200);
    };
  }, []);
  // A toast never sits over something a person can press: it is lifted to the nearest free band (src/lib/toastplace.ts),
  // again when the page scrolls under it.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !list.length) return;
    let frame = 0;
    const place = () => {
      el.style.marginBottom = '';
      // Plain boxes: the fields of a DOMRect are not its own, so they would be lost when copied.
      const plain = (r: DOMRect) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width });
      const t = plain(el.getBoundingClientRect());
      const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [role="button"]')]
        .filter((c) => !el.contains(c) && c.offsetParent !== null).map((c) => plain(c.getBoundingClientRect())).filter((r) => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight);
      const lift = toastLift(t, controls, window.innerHeight);
      if (lift) el.style.marginBottom = `${lift}px`;
    };
    const later = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(place)));
    place();
    // Once more after the page has drawn what the action changed.
    const again = setTimeout(place, 500);
    window.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    return () => (clearTimeout(again), cancelAnimationFrame(frame), window.removeEventListener('scroll', later), window.removeEventListener('resize', later), void (el.style.marginBottom = ''));
  }, [list]);
  return (
    <div className="toasts" role="status" aria-live="polite" ref={box}>
      {list.map((t) => <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>{withLinks(t.msg)}</div>)}
    </div>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      // Tab stays inside the dialog, so a keyboard never reaches the page behind it.
      if (e.key !== 'Tab' || !box.current) return;
      // With a dialog over a dialog, the top one holds the keyboard.
      const open = document.querySelectorAll('.modal');
      if (open[open.length - 1] !== box.current) return;
      const all = [...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      const inside = box.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && (document.activeElement === last || !inside)) (e.preventDefault(), first.focus());
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Focus moves into the dialog when it opens (to a field marked autoFocus, else the first control) and back to
  // what opened it when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]),select,textarea,button:not([disabled]),a[href]') || el).focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Old name for a picture of a leaf. It now draws the brand's mark in one colour, hidden from screen readers. Use
 * `Mark` or `Logo` from ./Brand instead; tests/brand.test.ts fails when a Leaf stands next to the product's name. */
export const Leaf = ({ size = 20, color = 'currentColor' }: { size?: number; color?: string }) => (
  <Mark size={size} tone="mono" label="" style={{ color }} />
);

const STATUS: Record<string, string> = { draft: 'Draft', sent: 'Waiting for others', completed: 'Completed', declined: 'Declined', voided: 'Cancelled', expired: 'Expired', pending: 'Not yet sent', viewed: 'Viewed', skipped: 'Not asked' };
export const Status = ({ s, label }: { s: string; label?: string }) => <span className={`badge ${s}`}>{label || STATUS[s] || s}</span>;

export const ROLE_LABEL: Record<string, string> = { signer: 'Needs to sign', approver: 'Needs to approve', cc: 'Gets a copy', viewer: 'Must open it', inperson: 'Signs in person', witness: 'Is a witness', editor: 'Can change the document', agent: 'Chooses who comes next' };
export const COLORS = ['#1f6f43', '#2f5f9e', '#b3392f', '#8a4fb0', '#b97712', '#0f7f86', '#a8457a', '#5b6b1e'];

export function fmtDate(s?: string | null, time = false) {
  if (!s) return '';
  const d = new Date(s);
  // In English the day comes first and the month is a word, "21 Nov 2026, 14:05", whatever the browser's region:
  // nobody can misread it. Another language keeps its own way of writing a date.
  const tag = fmtDateTag(typeof navigator === 'undefined' ? '' : navigator.language);
  return d.toLocaleDateString(tag, { day: 'numeric', month: 'short', year: 'numeric' }) + (time ? `, ${d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' })}` : '');
}

export const newId = (prefix: string) => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_')}`;
};

export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []): [T | null, () => void, any] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<any>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [data, () => setN((x) => x + 1), error];
}
