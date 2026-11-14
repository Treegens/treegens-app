import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { APP_BASE } from './lib/api';
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
 */
export default function App() {
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
