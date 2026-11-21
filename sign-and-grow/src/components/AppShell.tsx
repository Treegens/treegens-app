'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, toast, oops } from './ui';
import { Logo } from './Brand';
import { fmtNum, totalWorthShowing } from '@/lib/impact';
import { HandedOver, type Locked } from './HandedOver';
import { EmailProblemBanner } from './EmailProblem';
import { TwoStepRequired, TwoStepResetBanner } from './TwoStep';
import { HelpChatButton } from './HelpChat';
import { ConfirmBanner } from './ConfirmEmail';
import { SideNav, TabBar } from './AppNav';
import { navOn, pageTitle } from '@/lib/nav';
// The account's sign-in rules (src/server/secpolicy.ts): a longer password first, and the warning before an idle sign-out.
import { PasswordRequired } from './PasswordRequired';
import { IdleWarning } from './IdleWarning';
import { signedOutPath, QUIET_HEADER } from '@/lib/signinrules';

type Me = { user: any; account: any; role: string; accounts: any[]; billing: any; /** What the account switched on or off for itself (src/server/tenantpolicy.ts). */ policy?: { impact_display: 'on' | 'off'; ai_helper: 'on' | 'off'; white_label: boolean };outbox: boolean; /** The operator of this server has switched text messages on. */ text_messages?: boolean; /** WhatsApp and calls with a code are set up (src/lib/channels.ts). */ whatsapp?: boolean; phone_calls?: boolean; whatsapp_daily?: number; /** This server turns Word files and the like into PDF on upload (src/server/convert.ts). */ converts?: boolean; admins: number; members: number; operator: boolean; /** An admin of an organisation above accounts (src/server/orgs.ts). */ org_admin?: boolean; support_email: string | null; reload: (quiet?: boolean) => void };
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

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

  // quiet: a look of the page's own (waiting for the email to be confirmed) that is not use of the app, so the sign-in
  // rule "Sign out after" still counts the browser as idle (QUIET_HEADER, src/server/secpolicy.ts).
  const reload = useCallback((quiet?: boolean) => {
    api('/me', quiet === true ? { headers: { [QUIET_HEADER]: '1' } } : {}).then((m) => {
      if (m.handed_over) return setLocked(m.handed_over);
      setLocked(null);
      // A browser that a sign-in rule signed out is told why on the sign-in page (signed_out comes once).
      if (!m.user) router.replace(signedOutPath(m.signed_out, window.location.pathname));
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
    // One that was signed out meanwhile (a sign-in rule, or signing out in another tab) goes to the sign-in page.
    const look = () => document.visibilityState === 'visible' && api('/me').then((m) => (m.handed_over ? setLocked(m.handed_over) : m.user ? setLocked(null) : me && window.location.assign(signedOutPath(m.signed_out, window.location.pathname)))).catch(() => {});
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
  // Each page of the app has its own name in the browser tab (src/lib/nav.ts).
  useEffect(() => {
    if (!me) return;
    const want = pageTitle(path);
    const set = () => {
      if (document.title !== want) document.title = want;
    };
    set();
    // The site's own title comes back when a page is swapped in (a redirect into the editor, say): put ours back.
    const seen = new MutationObserver(set);
    seen.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => seen.disconnect();
  }, [path, me]);
  // The phone's menu closes with Escape, and the keyboard goes back to the button that opened it.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      document.getElementById('tab-menu')?.focus();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
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
  // The same for a member whose password is shorter than the account asks (the server refuses the rest).
  if (me.rules?.password_needed) return <MeCtx.Provider value={{ ...me, reload }}><PasswordRequired me={me} /></MeCtx.Provider>;
  // Only in an account with "Sign out after N minutes of no use": the line that warns two minutes before.
  const idle = me.rules?.idle_minutes ? <IdleWarning minutes={me.rules.idle_minutes} account={me.account.name} /> : null;
  const full = /^\/app\/(envelopes|templates)\/[^/]+\/edit/.test(path);
  if (full) return <MeCtx.Provider value={{ ...me, reload }}>{idle}{me.two_step?.reset_at && <div className="full-ts-reset"><TwoStepResetBanner me={{ ...me, reload }} /></div>}{children}</MeCtx.Provider>;

  return (
    <MeCtx.Provider value={{ ...me, reload }}>
      {idle}
      {/* The first stop for a keyboard: past the menu, straight to the page. Its words are drawn by start.css when
          it has the focus, so a screen without a keyboard in use has nothing more on it. */}
      <a href="#app-main" className="app-skip" aria-label="Skip to content" />
      <div className="mobilebar">
        <Link href="/app" className="row mobilebar-logo"><Logo height={20} tone="dark" /></Link>
        {/* With more than one workspace, a phone shows which one this is without opening the menu. */}
        {me.accounts?.length > 1 && <span className="truncate" style={{ flex: 1, minWidth: 0, margin: '0 10px', textAlign: 'right', fontSize: 12.5, opacity: 0.85 }} title="The workspace you are in">{me.account.name}</span>}
      </div>
      <div className="shell">
        <aside id="app-menu" className={`side${open ? ' open' : ''}`} aria-label="Menu">
          <Link href="/app" className="brand"><Logo height={24} tone="dark" /></Link>
          {/* Nine entries: the one start button, five pages, More, Settings and Help (src/lib/nav.ts). */}
          <SideNav path={path} role={me.role} userId={me.user.id} onGo={() => setOpen(false)} />
          {/* Help, once: it opens the helper, and the help page is the link inside it (components/HelpChat.tsx). */}
          <HelpChatButton className="nav hc-open hc-nav">Help</HelpChatButton>
          {me.operator && <Link href="/app/operator" className={`nav${navOn('/app/operator', path) ? ' on' : ''}`}>Operator</Link>}
          {me.outbox && <a className="nav" href="/dev/outbox" target="_blank">Dev outbox ↗</a>}
          {/* The account's total of paper saved, only once it is large enough to mean something (src/lib/impact.ts).
              Until then, and while it loads, nothing stands here. The saving of one document is said where it is sent. */}
          {impact && totalWorthShowing(impact.account.sheets)
            ? <div className="impact"><b className="num">{fmtNum(impact.account.sheets)}</b>sheets of paper saved by {me.account.name}, by our estimate</div>
            : <div className="side-gap" />}
          <div className="me">
            <div className="truncate" style={{ color: '#fff', fontWeight: 600 }}>{me.user.name}</div>
            <div className="truncate">{me.account.name}</div>
            {/* The address of the people who run this server, when they gave one. */}
            {me.support_email && <a href={`mailto:${me.support_email}`} className="side-support truncate" title={`Write to ${me.support_email}`}>{me.support_email}</a>}
            {/* The usage line (research/ux-charter.md 2.1). Absent while payments are not connected: nothing is counted then. */}
            {typeof me.billing?.signatures?.available === 'number' && (
              <Link href="/app/settings?tab=billing" className="usage-line" onClick={() => setOpen(false)}>{Math.max(0, me.billing.signatures.available)} signature{Math.max(0, me.billing.signatures.available) === 1 ? '' : 's'} left</Link>
            )}
            {me.accounts.length > 1 && (
              <select style={{ marginTop: 6, padding: '4px 6px', fontSize: 12.5 }} value={me.account.id} aria-label="Switch account"
                onChange={(e) => api('/auth/switch', { body: { account_id: e.target.value } }).then(() => window.location.assign('/app')).catch(oops)}>
                {me.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <button className="btn sm ghost side-out" style={{ color: '#cfe2d3', padding: '4px 0', marginTop: 4 }} onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.assign('/'))}>Sign out</button>
          </div>
        </aside>
        <main className="main" id="app-main" tabIndex={-1}>
          {me.account.paused && (
            <div className="banner paused" role="alert">
              <span><b>Sending is paused on this account.</b> Reason: {String(me.account.paused).replace(/[.\s]+$/, '')}. A person reviews every pause. Until then nothing you start is emailed to anyone: no new envelopes, no new or changed recipients, no reminders, no reopening, no team invitations and no email about a change, and people further down a signing order are asked only once the pause is lifted. You can still open, download and export everything, give an open document more time or void it, and people who already have a document can still sign it.</span>
              <Link href="/help" className="btn sm">Contact us</Link>
            </div>
          )}
          {/* An organisation above this workspace switched its sending off (src/server/orgs.ts): said on every page,
              so nobody prepares a whole document to learn it at Send. Absent for every other workspace. */}
          {me.org?.sending_off && !me.account.paused && (
            <div className="banner paused" role="status" data-feature="gov-G13">
              <span>{me.org.sending_off}</span>
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
          {/* Not confirmed yet: the 6-digit code from the email is typed right here, and the banner goes by itself
              once the address is confirmed in this tab or anywhere else (ConfirmEmail.tsx). */}
          <ConfirmBanner me={{ ...me, reload }} />

          {children}
        </main>
      </div>
      <TabBar path={path} menuOpen={open} onMenu={() => setOpen(!open)} />
    </MeCtx.Provider>
  );
}
