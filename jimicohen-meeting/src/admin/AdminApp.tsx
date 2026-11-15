/**
 * The dashboard: auth gate (first-run setup, sign in), then the shell with its navigation and
 * routes. Lazy-loaded by src/App.tsx at "/admin/*".
 *
 * Pages read the bootstrap with useAdmin() from ./state. The pages owned by ADMINX (Team,
 * Design, Integrations, Settings) are imported lazily by path and rendered inside <main>.
 */
import { Component, Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import {
  CalendarCheck2,
  CalendarRange,
  ChevronsUpDown,
  CloudOff,
  Clock,
  ExternalLink,
  House,
  LogOut,
  Menu as MenuIcon,
  MonitorSmartphone,
  Moon,
  Palette,
  Plug,
  Settings as SettingsIcon,
  Sun,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { AuthState } from '../../shared/types';
import { ApiFailure, errorMessage, getAuthState, logout, reportDeviceZone, setUnauthorizedHandler } from '../lib/api';
import { storageGet, storageSet } from '../lib/storage';
import { AdminScope } from '../lib/theme';
import { detectZone, zoneLabel } from '../lib/tz';
import { Avatar, Button, ButtonLink, Drawer, EmptyState, LoadingBlock, Menu, Skeleton, cx, useLatest, useToast } from '../ui';
import type { MenuItem } from '../ui';
import { UnsavedGuardProvider, useUnsavedGuard } from './components/UnsavedGuard';
import { announceGoogleReturn, withoutGoogleReturn } from './googleReturn';
import Home from './pages/Home';
import Login from './pages/Login';
import Setup from './pages/Setup';
import { AdminProvider, useAdmin } from './state';
import '../styles/admin.css';

const EventTypes = lazy(() => import('./pages/EventTypes'));
const EventTypeEditor = lazy(() => import('./pages/EventTypeEditor'));
const Availability = lazy(() => import('./pages/Availability'));
const Bookings = lazy(() => import('./pages/Bookings'));
const Team = lazy(() => import('./pages/Team'));
const Design = lazy(() => import('./pages/Design'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Settings = lazy(() => import('./pages/Settings'));

interface NavItem {
  to: string;
  label: string;
  /** shorter label for the phone tab bar */
  short?: string;
  icon: LucideIcon;
  end?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/admin', label: 'Home', icon: House, end: true },
  { to: '/admin/event-types', label: 'Event types', short: 'Events', icon: CalendarRange },
  { to: '/admin/availability', label: 'Availability', short: 'Hours', icon: Clock },
  { to: '/admin/bookings', label: 'Bookings', icon: CalendarCheck2 },
];

const SETUP_NAV: NavItem[] = [
  { to: '/admin/team', label: 'Team', icon: Users },
  { to: '/admin/design', label: 'Design', icon: Palette },
  { to: '/admin/integrations', label: 'Integrations', icon: Plug },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

const ALL_NAV = [...PRIMARY_NAV, ...SETUP_NAV];

function currentNav(pathname: string): NavItem | undefined {
  const path = pathname.replace(/\/+$/, '') || '/admin';
  return ALL_NAV.filter((n) => (n.end ? path === n.to : path === n.to || path.startsWith(`${n.to}/`))).sort((a, b) => b.to.length - a.to.length)[0];
}

/** The app's mark: a calendar with a tick. Drawn inline so it follows the surrounding colours. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="adm-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#0b1d14" />
      <rect x="13" y="16" width="38" height="35" rx="8" fill="none" stroke="#f2ede2" strokeWidth="4.5" />
      <path d="M23 11v9M41 11v9" stroke="#f2ede2" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M23.5 34.5l6 6 11.5-12" fill="none" stroke="#5ede8e" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ───────────── auth gate ─────────────

type Gate = { status: 'loading' } | { status: 'error'; error: ApiFailure } | { status: 'ready'; auth: AuthState };

type Scheme = 'auto' | 'light' | 'dark';
const SCHEME_KEY = 'mtg:admin-scheme';
const SchemeContext = createContext<{ scheme: Scheme; setScheme: (next: Scheme) => void }>({ scheme: 'auto', setScheme: () => undefined });

function readScheme(): Scheme {
  const saved = storageGet(SCHEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'auto';
}

export default function AdminApp() {
  // Light, dark, or whatever the device prefers. A per-device choice, so it lives in localStorage.
  const [scheme, setSchemeState] = useState<Scheme>(readScheme);
  const value = useMemo(
    () => ({
      scheme,
      setScheme: (next: Scheme) => {
        setSchemeState(next);
        storageSet(SCHEME_KEY, next);
      },
    }),
    [scheme],
  );
  return (
    <SchemeContext.Provider value={value}>
      <AdminScope colorScheme={scheme}>
        <AuthGate />
      </AdminScope>
    </SchemeContext.Provider>
  );
}

function AuthGate() {
  const [gate, setGate] = useState<Gate>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const toast = useToast();
  const toastRef = useLatest(toast);
  const wasSignedIn = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setGate({ status: 'loading' });
    getAuthState()
      .then((auth) => {
        if (!cancelled) setGate({ status: 'ready', auth });
      })
      .catch((e: unknown) => {
        if (!cancelled) setGate({ status: 'error', error: e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', errorMessage(e)) });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const signedIn = gate.status === 'ready' && gate.auth.authenticated;
  useEffect(() => {
    wasSignedIn.current = signedIn;
  }, [signedIn]);

  // A 401 from any admin call means the session ended: go back to the sign-in screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (wasSignedIn.current) toastRef.current.info('Your session has ended', 'Please sign in again to carry on.');
      wasSignedIn.current = false;
      setGate({ status: 'ready', auth: { setupRequired: false, authenticated: false } });
    });
    return () => setUnauthorizedHandler(null);
  }, [toastRef]);

  const onSignedIn = useCallback(() => setGate({ status: 'ready', auth: { setupRequired: false, authenticated: true } }), []);
  const onSignedOut = useCallback(() => setGate({ status: 'ready', auth: { setupRequired: false, authenticated: false } }), []);

  if (gate.status === 'loading') return <LoadingBlock label="Opening your dashboard" minHeight="100dvh" />;
  if (gate.status === 'error') {
    return (
      <div className="adm-center">
        <EmptyState
          tone="danger"
          as="h2"
          icon={<CloudOff />}
          title="The dashboard could not load"
          description={gate.error.message}
          action={
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  if (gate.auth.setupRequired) return <Setup onDone={onSignedIn} onRecheck={() => setAttempt((n) => n + 1)} />;
  if (!gate.auth.authenticated) return <Login onDone={onSignedIn} />;
  return <Shell onSignedOut={onSignedOut} />;
}

// ───────────── shell ─────────────

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <AdminProvider
      loading={<ShellSkeleton />}
      renderError={(error, retry) => (
        <div className="adm-center">
          <EmptyState
            tone="danger"
            as="h2"
            icon={<CloudOff />}
            title="The dashboard could not load"
            description={error.message}
            action={
              <Button variant="primary" onClick={retry}>
                Try again
              </Button>
            }
          />
        </div>
      )}
    >
      <UnsavedGuardProvider>
        <DeviceZoneSync />
        <GoogleReturnSync />
        <ShellFrame onSignedOut={onSignedOut} />
      </UnsavedGuardProvider>
    </AdminProvider>
  );
}

function ShellFrame({ onSignedOut }: { onSignedOut: () => void }) {
  const { data, ownerHost } = useAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const guard = useUnsavedGuard(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { scheme, setScheme } = useContext(SchemeContext);
  const active = currentNav(location.pathname);
  const siteName = data.site.profile.name || ownerHost.name;

  // New page: start at the top and name the tab.
  useEffect(() => {
    window.scrollTo(0, 0);
    setMoreOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${active?.label ?? 'Dashboard'} · ${siteName}`;
    return () => {
      document.title = previous;
    };
  }, [active, siteName]);

  const signOut = useCallback(() => {
    guard.confirmLeave(() => {
      logout()
        .catch(() => undefined)
        .finally(() => {
          toast.info('You are signed out');
          onSignedOut();
        });
    });
  }, [guard, onSignedOut, toast]);

  const accountItems = useMemo<MenuItem[]>(
    () => [
      { label: 'View booking page', icon: <ExternalLink size={16} />, href: data.publicUrl, external: true },
      { label: 'Settings', icon: <SettingsIcon size={16} />, onSelect: () => navigate('/admin/settings') },
      { type: 'separator' },
      { type: 'label', label: 'Appearance' },
      { label: 'Match this device', icon: <MonitorSmartphone size={16} />, checked: scheme === 'auto', onSelect: () => setScheme('auto') },
      { label: 'Light', icon: <Sun size={16} />, checked: scheme === 'light', onSelect: () => setScheme('light') },
      { label: 'Dark', icon: <Moon size={16} />, checked: scheme === 'dark', onSelect: () => setScheme('dark') },
      { type: 'separator' },
      { label: 'Sign out', icon: <LogOut size={16} />, onSelect: signOut },
    ],
    [data.publicUrl, navigate, signOut, scheme, setScheme],
  );

  const moreActive = SETUP_NAV.some((n) => n === active);

  return (
    <div className="adm-shell">
      <a className="adm-skip" href="#adm-main">
        Skip to content
      </a>

      <aside className="adm-side" aria-label="Dashboard">
        <NavLink to="/admin" end className="adm-side__brand">
          <BrandMark size={32} />
          <span className="adm-side__brandtext">
            <span className="adm-side__name u-truncate">{siteName}</span>
            <span className="adm-side__sub">Scheduling</span>
          </span>
        </NavLink>

        <nav className="adm-side__nav" aria-label="Main">
          <ul role="list">
            {PRIMARY_NAV.map((item) => (
              <SideLink key={item.to} item={item} />
            ))}
          </ul>
          <p className="adm-side__label" id="adm-nav-setup">
            Set up
          </p>
          <ul role="list" aria-labelledby="adm-nav-setup">
            {SETUP_NAV.map((item) => (
              <SideLink key={item.to} item={item} />
            ))}
          </ul>
        </nav>

        <div className="adm-side__foot">
          <a className="adm-side__link adm-side__link--quiet" href={data.publicUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={17} aria-hidden="true" />
            <span>View booking page</span>
          </a>
          <Menu
            label="Account"
            side="top"
            align="start"
            matchWidth
            items={accountItems}
            trigger={
              <button type="button" className="adm-side__account">
                <Avatar name={ownerHost.name} src={ownerHost.avatarUrl} size="sm" decorative />
                <span className="adm-side__accounttext">
                  <span className="adm-side__accountname u-truncate">{ownerHost.name}</span>
                  <span className="adm-side__accountmail u-truncate">{ownerHost.email || 'Owner'}</span>
                </span>
                <ChevronsUpDown size={15} aria-hidden="true" />
              </button>
            }
          />
        </div>
      </aside>

      <header className="adm-top">
        <NavLink to="/admin" end className="adm-top__brand" aria-label="Home">
          <BrandMark size={30} />
        </NavLink>
        <p className="adm-top__title u-truncate">{siteName}</p>
        <Menu
          label="Account"
          items={accountItems}
          trigger={
            <button type="button" className="adm-top__account" aria-label="Account">
              <Avatar name={ownerHost.name} src={ownerHost.avatarUrl} size="sm" decorative />
            </button>
          }
        />
      </header>

      <main className="adm-main" id="adm-main" tabIndex={-1}>
        <RouteBoundary resetKey={location.pathname}>
          <Suspense fallback={<LoadingBlock label="Loading" minHeight="50vh" />}>
            <Routes>
              <Route index element={<Home />} />
              <Route path="event-types" element={<EventTypes />} />
              <Route path="event-types/:id" element={<EventTypeEditor />} />
              <Route path="availability" element={<Availability />} />
              <Route path="bookings" element={<Bookings />} />
              <Route path="team" element={<Team />} />
              <Route path="design" element={<Design />} />
              <Route path="integrations" element={<Integrations />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<AdminNotFound />} />
            </Routes>
          </Suspense>
        </RouteBoundary>
      </main>

      <nav className="adm-tabbar" aria-label="Main">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cx('adm-tabbar__item', isActive && 'is-active')}>
            <item.icon size={21} aria-hidden="true" />
            <span>{item.short ?? item.label}</span>
          </NavLink>
        ))}
        <button type="button" className={cx('adm-tabbar__item', moreActive && 'is-active')} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}>
          <MenuIcon size={21} aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>

      <Drawer open={moreOpen} onClose={() => setMoreOpen(false)} side="bottom" title="More" className="adm-more">
        <ul role="list" className="adm-more__list">
          {SETUP_NAV.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} className={({ isActive }) => cx('adm-more__item', isActive && 'is-active')} onClick={() => setMoreOpen(false)}>
                <item.icon size={19} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
          <li>
            <a className="adm-more__item" href={data.publicUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={19} aria-hidden="true" />
              <span>View booking page</span>
            </a>
          </li>
          <li>
            <button
              type="button"
              className="adm-more__item"
              onClick={() => {
                setMoreOpen(false);
                signOut();
              }}
            >
              <LogOut size={19} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </li>
        </ul>
      </Drawer>
    </div>
  );
}

function SideLink({ item }: { item: NavItem }) {
  return (
    <li>
      <NavLink to={item.to} end={item.end} className={({ isActive }) => cx('adm-side__link', isActive && 'is-active')}>
        <item.icon size={17} aria-hidden="true" />
        <span>{item.label}</span>
      </NavLink>
    </li>
  );
}

/**
 * Keeps the owner's time zone in step with the device they are using right now. The server
 * only applies it while the zone mode is "follow this device".
 */
function DeviceZoneSync() {
  const { data, ownerHost, setData } = useAdmin();
  const toast = useToast();
  const latest = useLatest({ data, setData, toast });
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const before = ownerHost.timezone;
    reportDeviceZone(ownerHost.id, detectZone())
      .then(({ host, timezoneChanged }) => {
        const now = latest.current;
        if (!host || typeof host.timezone !== 'string') return;
        now.setData({ ...now.data, hosts: now.data.hosts.map((h) => (h.id === host.id ? host : h)) });
        // The server compares with what was stored at that moment, which is surer than what this page loaded a moment ago.
        if (timezoneChanged ?? host.timezone !== before) {
          now.toast.info(`Your time zone is now ${zoneLabel(host.timezone)}`, 'Your availability follows the device you are using. You can change that under Availability.');
        }
      })
      .catch(() => {
        // Not worth interrupting anyone: the next load tries again.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/**
 * Back from Google on any dashboard page (a connection can return to Team, Home or anywhere it was
 * started): say what happened, then take the result off the address so it is not left there or
 * said again on a reload. Integrations does this itself, as it also opens its Google card.
 */
function GoogleReturnSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (location.pathname.replace(/\/+$/, '') === '/admin/integrations') return;
    if (!new URLSearchParams(location.search).has('google')) return;
    if (announced.current !== location.search) {
      announced.current = location.search;
      announceGoogleReturn(toast, location.search);
    }
    navigate({ pathname: location.pathname, search: withoutGoogleReturn(location.search), hash: location.hash }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  return null;
}

function ShellSkeleton() {
  return (
    <div className="adm-shell" aria-busy="true">
      <aside className="adm-side" aria-hidden="true">
        <div className="adm-side__brand">
          <BrandMark size={32} />
        </div>
        <div className="adm-side__skeleton">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="adm-side__bone" />
          ))}
        </div>
      </aside>
      <header className="adm-top" aria-hidden="true">
        <BrandMark size={30} />
      </header>
      <main className="adm-main">
        <div className="adm-page adm-page--default">
          <span className="u-vh" role="status">
            Loading your dashboard
          </span>
          <Skeleton width={260} height={34} />
          <Skeleton width="min(420px, 80%)" height={16} style={{ marginTop: 14 }} />
          <div className="adm-skeleton-grid">
            <Skeleton height={96} radius={14} />
            <Skeleton height={96} radius={14} />
            <Skeleton height={96} radius={14} />
          </div>
          <Skeleton height={280} radius={14} style={{ marginTop: 20, display: 'block' }} />
        </div>
      </main>
    </div>
  );
}

function AdminNotFound() {
  return (
    <div className="adm-page adm-page--default">
      <EmptyState
        as="h2"
        title="That page is not part of the dashboard"
        description="The link may be old. Head back home and pick up from there."
        action={
          <ButtonLink variant="primary" to="/admin">
            Go to Home
          </ButtonLink>
        }
      />
    </div>
  );
}

interface BoundaryProps {
  resetKey: string;
  children: ReactNode;
}

/** One broken page should not take the navigation down with it. */
class RouteBoundary extends Component<BoundaryProps, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="adm-page adm-page--default">
        <EmptyState
          tone="danger"
          as="h2"
          title="This page ran into a problem"
          description="Nothing was lost. Try again, or go to another page from the menu."
          action={
            <Button variant="primary" onClick={() => this.setState({ failed: false })}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}
