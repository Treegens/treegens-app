/**
 * Dashboard bootstrap context. The shell (AdminApp) loads GET /admin/bootstrap once after
 * sign-in and provides it here. Every admin page reads it with `useAdmin()`:
 *
 *   const { data, refresh, ownerHost, setData } = useAdmin();
 *
 * After a save, either `setData({ ...data, site })` with the server's answer (instant) or
 * `await refresh()` to re-read everything.
 *
 * The same value is also published on `AdminContext` from src/lib/admin, so pages written
 * against that older helper keep working inside the shell.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AdminBootstrap, AdminHost } from '../../shared/types';
import { AdminContext } from '../lib/admin';
import type { AdminContextValue } from '../lib/admin';
import { ApiFailure, getBootstrap } from '../lib/api';

export interface AdminState {
  /** everything from GET /admin/bootstrap */
  data: AdminBootstrap;
  /** re-reads the bootstrap from the server */
  refresh(): Promise<void>;
  /** the owner's host record */
  ownerHost: AdminHost;
  /** replace the bootstrap locally after a save, so the UI does not wait for a refresh */
  setData(next: AdminBootstrap): void;
}

export const AdminStateContext = createContext<AdminState | null>(null);

/** Dashboard data. Only valid below the provider that AdminApp renders after sign-in. */
export function useAdmin(): AdminState {
  const ctx = useContext(AdminStateContext);
  if (!ctx) throw new Error('useAdmin() must be used inside the admin shell');
  return ctx;
}

export function findOwner(data: AdminBootstrap): AdminHost {
  return data.hosts.find((h) => h.id === data.site.ownerHostId) ?? data.hosts.find((h) => h.role === 'owner') ?? data.hosts[0];
}

function toFailure(e: unknown): ApiFailure {
  return e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', 'Something went wrong while loading the dashboard.');
}

export interface AdminProviderProps {
  /** shown while the first bootstrap request is in flight */
  loading: ReactNode;
  /** shown when the first bootstrap request fails */
  renderError: (error: ApiFailure, retry: () => void) => ReactNode;
  /** called with a 401 so the shell can go back to the sign-in screen */
  onUnauthorized?: () => void;
  children: ReactNode;
}

/** Loads the bootstrap and provides it to the pages. */
export function AdminProvider({ loading, renderError, onUnauthorized, children }: AdminProviderProps) {
  const [data, setDataState] = useState<AdminBootstrap | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getBootstrap()
      .then((next) => {
        if (!cancelled) setDataState(next);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const failure = toFailure(e);
        if (failure.status === 401) onUnauthorizedRef.current?.();
        setError(failure);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const load = useCallback(async (): Promise<AdminBootstrap> => {
    try {
      const next = await getBootstrap();
      if (alive.current) {
        setDataState(next);
        setError(null);
      }
      return next;
    } catch (e) {
      const failure = toFailure(e);
      if (failure.status === 401) onUnauthorizedRef.current?.();
      throw failure;
    }
  }, []);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const setData = useCallback((next: AdminBootstrap) => {
    setDataState(next);
  }, []);

  const state = useMemo<AdminState | null>(() => {
    if (!data) return null;
    return { data, refresh, ownerHost: findOwner(data), setData };
  }, [data, refresh, setData]);

  // Compatibility value for pages that read the older src/lib/admin context.
  const legacy = useMemo<AdminContextValue | null>(() => {
    if (!data) return null;
    const patch = (fn: (prev: AdminBootstrap) => AdminBootstrap) => setDataState((prev) => (prev ? fn(prev) : prev));
    return {
      data,
      owner: findOwner(data),
      refresh: load,
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
  }, [data, load]);

  if (!state || !legacy) {
    if (error) return <>{renderError(error, () => setAttempt((n) => n + 1))}</>;
    return <>{loading}</>;
  }
  return (
    <AdminStateContext.Provider value={state}>
      <AdminContext.Provider value={legacy}>{children}</AdminContext.Provider>
    </AdminStateContext.Provider>
  );
}
