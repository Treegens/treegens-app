import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { shortNameOfPath, type ShortName } from '../shared/shortLinks';
import { APP_BASE } from './lib/api';
import { OutsideAppBase } from './lib/links';
import BookingManage from './public/BookingManage';
import BookingPage from './public/BookingPage';
import Landing from './public/Landing';
import { AppErrorBoundary, NotFound, RouteFallback } from './ui/AppStates';

// The dashboard and the co-host page are separate chunks: invitees never download them.
const AdminApp = lazy(() => import('./admin/AdminApp'));
const HostPage = lazy(() => import('./host/HostPage'));
// UI kit gallery, development only. The import disappears from production builds.
const Kit = import.meta.env.DEV ? lazy(() => import('./dev/Kit')) : null;

/**
 * Routes (all relative to the /meeting base):
 *   /                          Landing: profile and event types
 *   /:slug                     BookingPage: one event type
 *   /booking/:id               BookingManage: details        (?t=<manage token>)
 *   /booking/:id/reschedule    BookingManage view="reschedule"
 *   /booking/:id/cancel        BookingManage view="cancel"
 *   /admin/*                   AdminApp (owns its own nested routes)
 *   /host/:id                  HostPage: co-host self-service (?t=<invite token>)
 *
 * On a short link's page (jimicohen.com/meet, /pod: shared/shortLinks.ts) the router is mounted on that
 * path instead, and only the booking page of the event it opens is there (ShortLinkApp).
 */
const SHORT = typeof window !== 'undefined' ? shortNameOfPath(window.location.pathname) : null;

export default function App() {
  if (SHORT) return <ShortLinkApp name={SHORT} />;
  return (
    <AppErrorBoundary>
      <BrowserRouter basename={APP_BASE} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/admin/*" element={<AdminApp />} />
            <Route path="/host/:id" element={<HostPage />} />
            <Route path="/booking/:id" element={<BookingManage view="details" />} />
            <Route path="/booking/:id/reschedule" element={<BookingManage view="reschedule" />} />
            <Route path="/booking/:id/cancel" element={<BookingManage view="cancel" />} />
            {Kit ? <Route path="/__kit" element={<Kit />} /> : null}
            <Route path="/:slug" element={<BookingPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

/**
 * jimicohen.com/meet and /pod: one booking calendar, with the address staying on the short path through
 * every step. The dashboard and co-host chunks are never loaded here. Links to other app pages are plain
 * links to /meeting/... (src/lib/links.tsx).
 */
function ShortLinkApp({ name }: { name: ShortName }) {
  return (
    <AppErrorBoundary>
      <OutsideAppBase.Provider value={true}>
        <BrowserRouter basename={`/${name}`} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/" element={<BookingPage shortName={name} />} />
            <Route path="*" element={<LeaveShortPath />} />
          </Routes>
        </BrowserRouter>
      </OutsideAppBase.Provider>
    </AppErrorBoundary>
  );
}

/**
 * A path below the short one. A booking page (a router link that slipped through) is left for the app's own
 * page with location.replace, so Back returns to the short page and no /pod/booking/... address stays behind
 * in the history (it carries the manage token). Anything else becomes the short page itself, query kept.
 */
function LeaveShortPath() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const leaving = /^\/booking\//.test(pathname);
  useEffect(() => {
    if (leaving) window.location.replace(`${APP_BASE}${pathname}${search}`);
    else navigate({ pathname: '/', search }, { replace: true });
  }, [leaving, pathname, search, navigate]);
  return <RouteFallback />;
}
