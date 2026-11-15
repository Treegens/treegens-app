import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CalendarClock, Check, ChevronRight, CircleCheck, ExternalLink, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AdminBooking, AdminOverview } from '../../../shared/types';
import { APP_BASE, errorMessage, getOverview } from '../../lib/api';
import { formatDateLong, zoneLabel, zonedParts } from '../../lib/tz';
import { Button, ButtonLink, CopyButton, EmptyState, Skeleton } from '../../ui';
import { YourLinksCard } from '../components/BrandBits';
import { Notice, Page, PageHeader } from '../components/Page';
import { BookingRow, groupByDay } from '../components/BookingRow';
import { firstName, trimUrl } from '../format';
import { useAdmin } from '../state';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; overview: AdminOverview };

export default function Home() {
  const { data, ownerHost } = useAdmin();
  const zone = ownerHost.timezone;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ status: 'loading' });
    getOverview({ signal: ctrl.signal })
      .then((overview) => setLoad({ status: 'ready', overview }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({ status: 'error', message: errorMessage(e, 'We could not load your overview.') });
      });
    return () => ctrl.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const now = useMemo(() => Date.now(), [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const hour = zonedParts(now, zone).hour;
  const greeting = hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const publicUrl = trimUrl(load.status === 'ready' ? load.overview.publicUrl || data.publicUrl : data.publicUrl);

  return (
    <Page width="wide">
      <PageHeader
        title={`${greeting}, ${firstName(ownerHost.name || data.site.profile.name)}`}
        description={`${formatDateLong(now, zone)}. Times here are in ${zoneLabel(zone)}.`}
        actions={
          <>
            <ButtonLink variant="secondary" href={publicUrl} external iconRight={<ArrowUpRight size={16} />}>
              View booking page
            </ButtonLink>
            <ButtonLink variant="primary" to="/admin/event-types?new=1" iconLeft={<Plus size={16} />}>
              New event type
            </ButtonLink>
          </>
        }
      />

      {load.status === 'ready' && load.overview.warnings.length ? (
        <div className="adm-stack adm-home__warnings">
          {load.overview.warnings.map((w) => (
            <Notice
              key={w.key}
              tone="warning"
              action={
                w.href ? (
                  <ButtonLink variant="link" to={w.href} iconRight={<ChevronRight size={15} />}>
                    Fix this
                  </ButtonLink>
                ) : undefined
              }
            >
              {w.message}
            </Notice>
          ))}
        </div>
      ) : null}

      {load.status === 'error' ? (
        <div className="adm-panel">
          <EmptyState
            tone="danger"
            title="Your overview did not load"
            description={load.message}
            action={
              <Button variant="primary" onClick={retry}>
                Try again
              </Button>
            }
          />
        </div>
      ) : (
        <Stats overview={load.status === 'ready' ? load.overview : null} />
      )}

      <div className="adm-home">
        <section className="adm-panel adm-home__upcoming" aria-labelledby="home-upcoming">
          <div className="adm-panel__head">
            <div>
              <h2 className="adm-panel__title" id="home-upcoming">
                Coming up
              </h2>
              <p className="adm-panel__desc">Your next confirmed meetings.</p>
            </div>
            <ButtonLink variant="ghost" size="sm" to="/admin/bookings" iconRight={<ChevronRight size={15} />}>
              All bookings
            </ButtonLink>
          </div>
          {load.status === 'loading' ? (
            <UpcomingSkeleton />
          ) : load.status === 'ready' ? (
            <Upcoming bookings={load.overview.upcoming} zone={zone} now={now} publicUrl={publicUrl} />
          ) : (
            <p className="adm-panel__desc">Meetings will show here once the overview loads.</p>
          )}
        </section>

        <div className="adm-home__aside">
          {load.status === 'ready' ? <Checklist items={load.overview.checklist} /> : load.status === 'loading' ? <Skeleton height={220} radius={14} style={{ display: 'block' }} /> : null}

          {/* jimicohen.com/meet, jimicohen.com/pod and the main link, with what each opens. */}
          <YourLinksCard />
        </div>
      </div>
    </Page>
  );
}

function Stats({ overview }: { overview: AdminOverview | null }) {
  const items: { label: string; value: number | null; hint: string }[] = [
    { label: 'Upcoming', value: overview?.stats.upcomingCount ?? null, hint: 'confirmed meetings ahead' },
    { label: 'Booked', value: overview?.stats.last30Count ?? null, hint: 'in the last 30 days' },
    { label: 'Cancelled', value: overview?.stats.cancelledLast30 ?? null, hint: 'in the last 30 days' },
    { label: 'Confirmed by your assistant', value: overview?.stats.confirmedByAssistant ?? null, hint: 'on reminder calls' },
  ];
  return (
    <dl className="adm-stats" aria-busy={overview ? undefined : true}>
      {items.map((s) => (
        <div className="adm-stats__item" key={s.label}>
          <dt className="adm-stats__label">{s.label}</dt>
          <dd className="adm-stats__value">{s.value === null ? <Skeleton width={40} height={30} /> : s.value}</dd>
          <dd className="adm-stats__hint">{s.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

function Upcoming({ bookings, zone, now, publicUrl }: { bookings: AdminBooking[]; zone: string; now: number; publicUrl: string }) {
  if (!bookings.length) {
    return (
      <EmptyState
        compact
        icon={<CalendarClock />}
        title="Nothing booked yet"
        description="When someone picks a time it shows up here, and in your Google Calendar."
        action={<CopyButton value={publicUrl} label="Copy your booking link" variant="secondary" />}
      />
    );
  }
  return (
    <div className="adm-agenda">
      {groupByDay(bookings, zone, now).map((g) => (
        <div className="adm-agenda__day" key={g.key}>
          <h3 className="adm-agenda__date">{g.heading}</h3>
          <ul role="list" className="adm-agenda__list">
            {g.items.map((b) => (
              <li key={b.id}>
                <BookingRow booking={b} zone={zone} to={`/admin/bookings?b=${encodeURIComponent(b.id)}`} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function UpcomingSkeleton() {
  return (
    <div className="adm-agenda" aria-busy="true">
      <span className="u-vh" role="status">
        Loading your meetings
      </span>
      {[0, 1, 2, 3].map((i) => (
        <div className="adm-agenda__row adm-agenda__row--bone" key={i}>
          <Skeleton width={64} height={34} />
          <Skeleton lines={2} width="min(320px, 70%)" />
        </div>
      ))}
    </div>
  );
}

function Checklist({ items }: { items: AdminOverview['checklist'] }) {
  const done = items.filter((i) => i.done).length;
  if (!items.length) return null;
  if (done === items.length) {
    return (
      <section className="adm-panel adm-checklist adm-checklist--done" aria-label="Setup">
        <CircleCheck size={20} aria-hidden="true" />
        <div>
          <h2 className="adm-panel__title">You are all set up</h2>
          <p className="adm-panel__desc">Calendar, reminders and your page are ready to go.</p>
        </div>
      </section>
    );
  }
  const pct = Math.round((done / items.length) * 100);
  return (
    <section className="adm-panel adm-checklist" aria-labelledby="home-setup">
      <div className="adm-panel__head">
        <div>
          <h2 className="adm-panel__title" id="home-setup">
            Finish setting up
          </h2>
          <p className="adm-panel__desc">
            {done} of {items.length} done
          </p>
        </div>
      </div>
      <div className="adm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-label="Setup progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ul role="list" className="adm-checklist__list">
        {items.map((item) => (
          <li key={item.key}>
            {item.done ? (
              <span className="adm-checklist__item is-done">
                <span className="adm-checklist__mark" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
                <span className="adm-checklist__label">{item.label}</span>
                <span className="u-vh">Done</span>
              </span>
            ) : (
              <CheckLink href={item.href} label={item.label} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckLink({ href, label }: { href: string; label: string }) {
  const inner = (
    <>
      <span className="adm-checklist__mark" aria-hidden="true" />
      <span className="adm-checklist__label">{label}</span>
      <ChevronRight size={16} aria-hidden="true" className="adm-checklist__chev" />
    </>
  );
  // The API sends app routes ("/admin/integrations"). Anything else opens as a normal link.
  if (/^https?:\/\//.test(href)) {
    return (
      <a className="adm-checklist__item" href={href} target="_blank" rel="noopener noreferrer">
        {inner}
        <ExternalLink size={14} aria-hidden="true" />
      </a>
    );
  }
  return (
    <Link className="adm-checklist__item" to={APP_BASE && href.startsWith(`${APP_BASE}/`) ? href.slice(APP_BASE.length) : href}>
      {inner}
    </Link>
  );
}
