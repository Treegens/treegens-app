import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarCheck2, CalendarX2, Download, History, Search, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { AdminBooking } from '../../../shared/types';
import { bookingsCsvUrl, errorMessage, listBookings } from '../../lib/api';
import { zoneLabel } from '../../lib/tz';
import { Button, ButtonLink, EmptyState, Input, Skeleton, Spinner, Tabs } from '../../ui';
import type { TabItem } from '../../ui';
import { BookingDrawer } from '../components/BookingDrawer';
import { BookingRow, groupByDay } from '../components/BookingRow';
import { Page, PageHeader } from '../components/Page';
import { useAdmin } from '../state';

type Scope = 'upcoming' | 'past' | 'cancelled';
const SCOPES: Scope[] = ['upcoming', 'past', 'cancelled'];
const SCOPE_LABEL: Record<Scope, string> = { upcoming: 'Upcoming', past: 'Past', cancelled: 'Cancelled' };
const PAGE_SIZE = 40;

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; bookings: AdminBooking[]; total: number; loadingMore: boolean };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return v;
}

export default function Bookings() {
  const { ownerHost } = useAdmin();
  const zone = ownerHost.timezone;
  const [params, setParams] = useSearchParams();
  const scopeParam = params.get('scope') as Scope | null;
  const scope: Scope = scopeParam && SCOPES.includes(scopeParam) ? scopeParam : 'upcoming';
  const openId = params.get('b');

  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const q = useDebounced(query.trim(), 260);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [counts, setCounts] = useState<Partial<Record<Scope, number>>>({});
  const [reload, setReload] = useState(0);
  const requestId = useRef(0);

  const patchParams = useCallback(
    (fn: (p: URLSearchParams) => void, replace = true) => {
      const next = new URLSearchParams(params);
      fn(next);
      setParams(next, { replace });
    },
    [params, setParams],
  );

  // The list for the current tab and search.
  useEffect(() => {
    const ctrl = new AbortController();
    const id = ++requestId.current;
    setList({ status: 'loading' });
    listBookings({ scope, q: q || undefined, limit: PAGE_SIZE, offset: 0 }, { signal: ctrl.signal })
      .then((res) => {
        if (id !== requestId.current) return;
        setList({ status: 'ready', bookings: res.bookings, total: res.total, loadingMore: false });
        if (!q) setCounts((c) => ({ ...c, [scope]: res.total }));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || id !== requestId.current) return;
        setList({ status: 'error', message: errorMessage(e, 'We could not load your bookings.') });
      });
    return () => ctrl.abort();
  }, [scope, q, reload]);

  // Counts for the other tabs, so the tab bar is honest about what is behind each one.
  useEffect(() => {
    let cancelled = false;
    for (const s of SCOPES) {
      if (s === scope) continue;
      listBookings({ scope: s, limit: 1, offset: 0 })
        .then((res) => {
          if (!cancelled) setCounts((c) => ({ ...c, [s]: res.total }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  // Keep the search in the URL so a reload or a shared link shows the same list.
  useEffect(() => {
    if ((params.get('q') ?? '') === q) return;
    patchParams((p) => (q ? p.set('q', q) : p.delete('q')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const loadMore = async () => {
    if (list.status !== 'ready' || list.loadingMore) return;
    const id = requestId.current;
    setList({ ...list, loadingMore: true });
    try {
      const res = await listBookings({ scope, q: q || undefined, limit: PAGE_SIZE, offset: list.bookings.length });
      if (id !== requestId.current) return;
      setList((prev) => (prev.status === 'ready' ? { status: 'ready', bookings: [...prev.bookings, ...res.bookings], total: res.total, loadingMore: false } : prev));
    } catch {
      if (id !== requestId.current) return;
      setList((prev) => (prev.status === 'ready' ? { ...prev, loadingMore: false } : prev));
    }
  };

  const tabs = useMemo<TabItem<Scope>[]>(() => SCOPES.map((s) => ({ id: s, label: SCOPE_LABEL[s], badge: counts[s] })), [counts]);
  const groups = useMemo(() => (list.status === 'ready' ? groupByDay(list.bookings, zone) : []), [list, zone]);
  const preview = list.status === 'ready' ? list.bookings.find((b) => b.id === openId) ?? null : null;

  const rowLink = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('b', id);
    return { search: `?${p.toString()}` };
  };

  return (
    <Page>
      <PageHeader
        title="Bookings"
        description={`Every meeting people have booked with you. Times are in ${zoneLabel(zone)}.`}
        actions={
          <ButtonLink variant="secondary" href={bookingsCsvUrl({ scope, q: q || undefined })} download iconLeft={<Download size={16} />}>
            Export CSV
          </ButtonLink>
        }
      />

      <div className="adm-toolbar">
        <Tabs
          label="Bookings"
          tabs={tabs}
          value={scope}
          onChange={(next) =>
            patchParams((p) => {
              if (next === 'upcoming') p.delete('scope');
              else p.set('scope', next);
              p.delete('b');
            })
          }
        />
        <div className="adm-toolbar__search">
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Search by name, email or event"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leading={<Search size={16} aria-hidden="true" />}
            trailing={
              query ? (
                <button type="button" className="adm-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                  <X size={15} aria-hidden="true" />
                </button>
              ) : list.status === 'loading' && q ? (
                <Spinner size={15} label="" />
              ) : undefined
            }
          />
        </div>
      </div>

      <section className="adm-panel adm-bookings" aria-label={`${SCOPE_LABEL[scope]} bookings`}>
        {list.status === 'loading' ? (
          <div className="adm-agenda" aria-busy="true">
            <span className="u-vh" role="status">
              Loading bookings
            </span>
            {[0, 1, 2, 3, 4].map((i) => (
              <div className="adm-agenda__row adm-agenda__row--bone" key={i}>
                <Skeleton width={64} height={34} />
                <Skeleton lines={2} width="min(360px, 70%)" />
              </div>
            ))}
          </div>
        ) : list.status === 'error' ? (
          <EmptyState
            tone="danger"
            title="Your bookings did not load"
            description={list.message}
            action={
              <Button variant="primary" onClick={() => setReload((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        ) : list.bookings.length === 0 ? (
          q ? (
            <EmptyState
              icon={<Search />}
              title={`Nothing matches "${q}"`}
              description={`No ${SCOPE_LABEL[scope].toLowerCase()} bookings with that name, email or event. Try another tab or a shorter search.`}
              action={
                <Button variant="secondary" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              }
            />
          ) : scope === 'upcoming' ? (
            <EmptyState icon={<CalendarCheck2 />} title="No meetings coming up" description="New bookings appear here the moment someone picks a time." />
          ) : scope === 'past' ? (
            <EmptyState icon={<History />} title="No past meetings yet" description="Once a meeting has happened it moves here, where you can mark no-shows." />
          ) : (
            <EmptyState icon={<CalendarX2 />} title="Nothing cancelled" description="Cancelled meetings are kept here with who cancelled and why." />
          )
        ) : (
          <>
            <div className="adm-agenda">
              {groups.map((g) => (
                <div className="adm-agenda__day" key={g.key}>
                  <h2 className="adm-agenda__date">{g.heading}</h2>
                  <ul role="list" className="adm-agenda__list">
                    {g.items.map((b) => (
                      <li key={b.id}>
                        <BookingRow booking={b} zone={zone} to={rowLink(b.id)} showEmail />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {list.bookings.length < list.total ? (
              <div className="adm-bookings__more">
                <Button variant="secondary" loading={list.loadingMore} onClick={() => void loadMore()}>
                  Show more
                </Button>
                <span className="adm-quiet">
                  {list.bookings.length} of {list.total}
                </span>
              </div>
            ) : null}
          </>
        )}
      </section>

      <BookingDrawer
        bookingId={openId}
        preview={preview}
        zone={zone}
        onClose={() => patchParams((p) => p.delete('b'))}
        onChanged={() => setReload((n) => n + 1)}
      />
    </Page>
  );
}
