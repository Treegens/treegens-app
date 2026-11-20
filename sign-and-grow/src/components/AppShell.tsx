'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, Leaf, toast, oops } from './ui';
import { fmtNum, fmtTrees } from '@/lib/impact';

type Me = { user: any; account: any; role: string; accounts: any[]; billing: any; outbox: boolean; admins: number; operator: boolean; support_email: string | null; reload: () => void };
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

const NAV: [string, string, string?][] = [
  ['/app', 'Home'],
  ['/app/envelopes', 'Envelopes'],
  ['/app/inbox', 'Inbox'],
  ['/app/templates', 'Templates'],
  ['/app/bulk', 'Bulk send'],
  ['/app/powerforms', 'PowerForms'],
  ['/app/contacts', 'Contacts'],
  ['/app/reports', 'Reports'],
  ['/app/impact', 'Our impact'],
  ['/app/settings', 'Settings'],
];

export function AppShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<any>(null);
  const [impact, setImpact] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const router = useRouter();

  const reload = useCallback(() => {
    api('/me').then((m) => {
      if (!m.user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      else setMe(m);
    }).catch(oops);
  }, [router]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (me) api('/impact').then(setImpact).catch(() => {});
  }, [me, path]);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    // Set by the login form when signing in cancelled a pending account closure.
    try {
      if (sessionStorage.getItem('sg_restored')) {
        sessionStorage.removeItem('sg_restored');
        toast('Welcome back. Your account is no longer scheduled to be deleted.');
      }
    } catch {
      /* storage can be unavailable */
    }
  }, []);

  if (!me) return <div className="muted center" style={{ padding: 80 }}>Loading…</div>;
  const full = /^\/app\/(envelopes|templates)\/[^/]+\/edit/.test(path);
  if (full) return <MeCtx.Provider value={{ ...me, reload }}>{children}</MeCtx.Provider>;

  const on = (href: string) => (href === '/app' ? path === '/app' : path.startsWith(href));
  return (
    <MeCtx.Provider value={{ ...me, reload }}>
      <div className="mobilebar">
        <Link href="/app" className="row" style={{ color: '#fff', textDecoration: 'none', fontWeight: 700 }}><Leaf color="#9ed88f" /> Sign&Grow</Link>
        <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>Menu</button>
      </div>
      <div className="shell">
        <aside className={`side${open ? ' open' : ''}`}>
          <Link href="/app" className="brand"><Leaf color="#9ed88f" size={22} /> Sign&Grow</Link>
          <Link href="/app/envelopes/new" className="btn" style={{ margin: '0 4px 10px', background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>New envelope</Link>
          {NAV.map(([href, label]) => <Link key={href} href={href} className={`nav${on(href) ? ' on' : ''}`}>{label}</Link>)}
          <Link href="/help" className="nav">Help</Link>
          {me.operator && <Link href="/app/operator" className={`nav${on('/app/operator') ? ' on' : ''}`}>Review queue</Link>}
          {me.outbox && <a className="nav" href="/dev/outbox" target="_blank">Dev outbox ↗</a>}
          <button className="btn sm ghost" style={{ color: '#fff', display: open ? 'block' : 'none', marginTop: 8 }} onClick={() => setOpen(false)}>Close menu</button>
          <div className="impact">
            <b className="num">{impact ? fmtNum(impact.account.sheets) : '…'}</b>
            sheets of paper saved by {me.account.name}
            {impact && impact.account.sheets > 0 && <div style={{ marginTop: 4, color: '#a8c9b0' }}>{fmtTrees(impact.account.trees)} of a tree · {fmtNum(impact.account.litresWater)} L water</div>}
          </div>
          <div className="me">
            <div className="truncate" style={{ color: '#fff', fontWeight: 600 }}>{me.user.name}</div>
            <div className="truncate">{me.account.name}</div>
            {me.accounts.length > 1 && (
              <select style={{ marginTop: 6, padding: '4px 6px', fontSize: 12.5 }} value={me.account.id} aria-label="Switch account"
                onChange={(e) => api('/auth/switch', { body: { account_id: e.target.value } }).then(() => window.location.assign('/app')).catch(oops)}>
                {me.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <button className="btn sm ghost" style={{ color: '#cfe2d3', padding: '4px 0', marginTop: 4 }} onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.assign('/'))}>Sign out</button>
          </div>
        </aside>
        <main className="main">
          {me.account.paused && (
            <div className="banner paused" role="alert">
              <span><b>Sending is paused on this account.</b> Reason: {String(me.account.paused).replace(/[.\s]+$/, '')}. A person reviews every pause. Until then nothing new goes out: no new envelopes, no new or changed recipients, no reminders and no reopening. You can still open, download and export everything, and people who already have a document can still sign it.</span>
              <Link href="/help" className="btn sm">Contact us</Link>
            </div>
          )}
          {!me.user.email_verified && (
            <div className="notice warn row between wrap" style={{ marginBottom: 16 }}>
              <span>Confirm your email ({me.user.email}) before you send. It also puts documents others send you in your inbox. This keeps scammers from sending in someone else&apos;s name.</span>
              <button className="btn sm" onClick={() => api('/auth/resend-verification', { method: 'POST' }).then(() => toast('Confirmation email sent')).catch(oops)}>Resend email</button>
            </div>
          )}
          {children}
        </main>
      </div>
    </MeCtx.Provider>
  );
}
