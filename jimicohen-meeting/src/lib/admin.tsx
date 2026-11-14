/**
 * Shared dashboard state. AdminApp (the shell) provides it, every admin page reads it.
 * It lives in src/lib so that pages written by different people agree on one contract:
 *
 *   const { data, refresh, patch } = useAdmin();
 *   data.site, data.hosts, data.eventTypes, data.integrations, data.publicUrl
 *
 * After a successful save either call `patch()` with the server's answer (instant) or
 * `await refresh()` (re-reads everything).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AdminBootstrap, AdminHost, EventType, SiteSettings } from '../../shared/types';
import { ApiFailure, getBootstrap } from './api';

export interface AdminContextValue {
  /** everything from GET /admin/bootstrap */
  data: AdminBootstrap;
  /** the owner's host record (data.hosts entry matching data.site.ownerHostId) */
  owner: AdminHost;
  /** re-reads the bootstrap from the server and returns it */
  refresh: () => Promise<AdminBootstrap>;
  /** local update after a save, so the UI does not wait for a refresh */
  patch: (fn: (prev: AdminBootstrap) => AdminBootstrap) => void;
  /** convenience patches for the most common saves */
  setSite: (site: SiteSettings) => void;
  upsertEventType: (eventType: EventType) => void;
  removeEventType: (id: string) => void;
  upsertHost: (host: AdminHost) => void;
  removeHost: (id: string) => void;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

/** Dashboard data + actions. Only valid below the provider that AdminApp renders after sign-in. */
export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin() must be used inside the admin shell (AdminContext.Provider)');
  return ctx;
}

export type AdminLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: ApiFailure; retry: () => void }
  | { status: 'ready'; value: AdminContextValue };

/**
 * Loads the bootstrap and builds the context value. Use it in the shell once the user is
 * signed in: render a skeleton for "loading", an error state for "error", and
 * <AdminContext.Provider value={state.value}> for "ready".
 */
export function useAdminBootstrap(enabled = true): AdminLoadState {
  const [data, setData] = useState<AdminBootstrap | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await getBootstrap();
    if (alive.current) {
      setData(next);
      setError(null);
    }
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(null);
    getBootstrap()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', 'Something went wrong while loading the dashboard.'));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  const patch = useCallback((fn: (prev: AdminBootstrap) => AdminBootstrap) => {
    setData((prev) => (prev ? fn(prev) : prev));
  }, []);

  const value = useMemo<AdminContextValue | null>(() => {
    if (!data) return null;
    const owner = data.hosts.find((h) => h.id === data.site.ownerHostId) ?? data.hosts.find((h) => h.role === 'owner') ?? data.hosts[0];
    return {
      data,
      owner,
      refresh,
      patch,
      setSite: (site) => patch((p) => ({ ...p, site })),
      upsertEventType: (et) =>
        patch((p) => {
          const exists = p.eventTypes.some((x) => x.id === et.id);
          const eventTypes = exists ? p.eventTypes.map((x) => (x.id === et.id ? et : x)) : [...p.eventTypes, et];
          return { ...p, eventTypes: eventTypes.slice().sort((a, b) => a.position - b.position) };
        }),
      removeEventType: (id) => patch((p) => ({ ...p, eventTypes: p.eventTypes.filter((x) => x.id !== id) })),
      upsertHost: (host) =>
        patch((p) => ({ ...p, hosts: p.hosts.some((h) => h.id === host.id) ? p.hosts.map((h) => (h.id === host.id ? host : h)) : [...p.hosts, host] })),
      removeHost: (id) => patch((p) => ({ ...p, hosts: p.hosts.filter((h) => h.id !== id) })),
    };
  }, [data, refresh, patch]);

  if (value) return { status: 'ready', value };
  if (error) return { status: 'error', error, retry: () => setAttempt((n) => n + 1) };
  return { status: 'loading' };
}

/** Ready-made provider for shells that do not need custom loading UI. */
export function AdminDataProvider({ loading, renderError, children }: { loading: ReactNode; renderError: (error: ApiFailure, retry: () => void) => ReactNode; children: ReactNode }) {
  const state = useAdminBootstrap();
  if (state.status === 'loading') return <>{loading}</>;
  if (state.status === 'error') return <>{renderError(state.error, state.retry)}</>;
  return <AdminContext.Provider value={state.value}>{children}</AdminContext.Provider>;
}
