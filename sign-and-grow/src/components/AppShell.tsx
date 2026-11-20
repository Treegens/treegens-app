'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, Leaf, toast, oops } from './ui';
import { fmtNum, fmtTrees } from '@/lib/impact';
import { HandedOver, type Locked } from './HandedOver';
import { EmailProblemBanner } from './EmailProblem';
import { TwoStepRequired, TwoStepResetBanner } from './TwoStep';
import { HelpChatButton } from './HelpChat';

type Me = { user: any; account: any; role: string; accounts: any[]; billing: any; outbox: boolean; /** The operator of this server has switched text messages on. */ text_messages?: boolean; /** This server turns Word files and the like into PDF on upload (src/server/convert.ts). */ converts?: boolean; admins: number; members: number; operator: boolean; support_email: string | null; reload: () => void };
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
  const [notice, setNotice] = useState('');
  const path = usePathname();
  const router = useRouter();

  // Set while this browser is locked because the device was handed to someone to sign in person. Then no page of
  // the account is drawn, only the screen that asks for the owner's password (HandedOver).
  const [locked, setLocked] = useState<Locked | null>(null);

  const reload = useCallback(() => {
    api('/me').then((m) => {
      if (m.handed_over) return setLocked(m.handed_over);
      setLocked(null);
      if (!m.user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      else setMe(m);
    }).catch(oops);
  }, [router]);
  useEffect(reload, [reload]);
  useEffect(() => {
    // "Host signing now" says so before it leaves this page, and the account is put away at once: the Back button
    // then brings back the lock, not the envelope. The server locks the session when the signing page opens.
    const handed = (e: Event) => setLocked((l) => l || { name: me?.user?.name || 'the owner of this account', has_password: me?.user?.has_password !== false, signer: (e as CustomEvent).detail?.signer || null, envelope_id: (e as CustomEvent).detail?.envelope_id || null });
    // A page of the account that was open in another tab, or comes back from the browser's history, asks whether
    // it may still show what it shows as soon as it is looked at again.
    const look = () => document.visibilityState === 'visible' && api('/me').then((m) => (m.handed_over ? setLocked(m.handed_over) : m.user && setLocked(null))).catch(() => {});
    window.addEventListener('sg-handed-over', handed);
    window.addEventListener('pageshow', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('sg-handed-over', handed);
      window.removeEventListener('pageshow', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [me]);
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
      // Anything else the sign-in did: joined a team from an invitation, could not join it, or was given a workspace.
      // It is a few sentences, so it stays on screen until it is dismissed.
      const said = sessionStorage.getItem('sg_notice');
      if (said) {
        sessionStorage.removeItem('sg_notice');
        setNotice(said);
      }
    } catch {
      /* storage can be unavailable */
    }
  }, []);

  if (locked) return <HandedOver info={locked} onUnlocked={reload} />;
  if (!me) return <div className="muted center" style={{ padding: 80 }}>Loading…</div>;
  // This account asks everyone for two-step login and this person has none: nothing of it is drawn until they have
  // set it up (the server refuses the rest with "two_step_setup", src/server/twostep.ts).
  if (me.two_step?.setup_required) return <MeCtx.Provider value={{ ...me, reload }}><TwoStepRequired me={me} /></MeCtx.Provider>;
  const full = /^\/app\/(envelopes|templates)\/[^/]+\/edit/.test(path);
  if (full) return <MeCtx.Provider value={{ ...me, reload }}>{me.two_step?.reset_at && <div className="full-ts-reset"><TwoStepResetBanner me={{ ...me, reload }} /></div>}{children}</MeCtx.Provider>;

  const on = (href: string) => (href === '/app' ? path === '/app' : path.startsWith(href));
  return (
    <MeCtx.Provider value={{ ...me, reload }}>
      <div className="mobilebar">
        <Link href="/app" className="row" style={{ color: '#fff', textDecoration: 'none', fontWeight: 700 }}><Leaf color="#9ed88f" /> GrowSigning</Link>
        {/* With more than one workspace, a phone shows which one this is without opening the menu. */}
        {me.accounts?.length > 1 && <span className="truncate" style={{ flex: 1, minWidth: 0, margin: '0 10px', textAlign: 'right', fontSize: 12.5, opacity: 0.85 }} title="The workspace you are in">{me.account.name}</span>}
        <HelpChatButton className="btn sm hc-open" label="Help: ask the helper or write to a person">Help</HelpChatButton>
        <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>Menu</button>
      </div>
      <div className="shell">
        <aside className={`side${open ? ' open' : ''}`}>
          <Link href="/app" className="brand"><Leaf color="#9ed88f" size={22} /> GrowSigning</Link>
          <Link href="/app/envelopes/new" className="btn" style={{ margin: '0 4px 10px', background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>New envelope</Link>
          {NAV.map(([href, label]) => <Link key={href} href={href} className={`nav${on(href) ? ' on' : ''}`}>{label}</Link>)}
          {/* Click-to-agree terms speak for the team's website, so only its owner and admins manage them. */}
          {(me.role === 'owner' || me.role === 'admin') && <Link href="/app/agreements" className={`nav${on('/app/agreements') ? ' on' : ''}`}>Click-to-agree</Link>}
          <HelpChatButton className="nav hc-open hc-nav">Ask for help</HelpChatButton>
          <Link href="/help" className="nav">Help</Link>
          {me.support_email && <a href={`mailto:${me.support_email}`} className="nav" style={{ fontSize: 12.5, paddingTop: 2 }} title={`Write to ${me.support_email}`}><span className="truncate">{me.support_email}</span></a>}
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
              <span><b>Sending is paused on this account.</b> Reason: {String(me.account.paused).replace(/[.\s]+$/, '')}. A person reviews every pause. Until then nothing you start is emailed to anyone: no new envelopes, no new or changed recipients, no reminders, no reopening, no team invitations and no email about a change, and people further down a signing order are asked only once the pause is lifted. You can still open, download and export everything, give an open document more time or void it, and people who already have a document can still sign it.</span>
              <Link href="/help" className="btn sm">Contact us</Link>
            </div>
          )}
          {/* Our last email to this login came back for good: said on every page until it is dealt with. */}
          <EmailProblemBanner me={{ ...me, reload }} />
          {/* A reset by email of two-step login is under way: said on every page until it stops or takes effect. */}
          <TwoStepResetBanner me={{ ...me, reload }} />
          {notice && (
            <div className={`notice${/did not join/.test(notice) ? ' warn' : ''} row between wrap`} style={{ marginBottom: 16 }} role="status">
              <span>{notice}</span>
              <button className="btn sm" onClick={() => setNotice('')}>OK</button>
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
