'use client';
import { useEffect, useState, type ReactNode } from 'react';

// The reader's time zone, sent along when the app loads, so dates in emails match the dates on screen.
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(path === '/me' && !opts.method ? { 'x-tz': timeZone() } : {}) },
    body: opts.form || (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

// Toasts: call toast('Saved') from anywhere.
type T = { id: number; msg: string; err?: boolean };
let push: (t: T) => void = () => {};
export function toast(msg: string, err = false) {
  push({ id: Date.now() + Math.random(), msg, err });
}
export const oops = (e: any) => toast(e?.message || 'Something went wrong.', true);
export function Toasts() {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    push = (t) => {
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.err ? 6000 : 3200);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>{t.msg}</div>)}
    </div>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const Leaf = ({ size = 20, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }}>
    <path fill={color} d="M2 22C2 9 10 2 22 2c0 12-7 20-20 20Z" />
    <path d="M4 20 15 9" stroke="rgba(255,255,255,.55)" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const STATUS: Record<string, string> = { draft: 'Draft', sent: 'Waiting for others', completed: 'Completed', declined: 'Declined', voided: 'Voided', expired: 'Expired', pending: 'Not yet sent', viewed: 'Viewed' };
export const Status = ({ s, label }: { s: string; label?: string }) => <span className={`badge ${s}`}>{label || STATUS[s] || s}</span>;

export const ROLE_LABEL: Record<string, string> = { signer: 'Needs to sign', approver: 'Needs to approve', cc: 'Receives a copy', viewer: 'Needs to view', inperson: 'Signs in person' };
export const COLORS = ['#1f6f43', '#2f5f9e', '#b3392f', '#8a4fb0', '#b97712', '#0f7f86', '#a8457a', '#5b6b1e'];

export function fmtDate(s?: string | null, time = false) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + (time ? `, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '');
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
