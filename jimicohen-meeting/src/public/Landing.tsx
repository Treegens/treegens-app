/**
 * /: the owner's public page. Who they are and the meetings they offer.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, CalendarDays, CalendarOff, Clock } from 'lucide-react';
import type { PublicEventType, PublicSite } from '../../shared/types';
import { isHex } from '../../shared/theme';
import { getPublicSite, isApiFailure } from '../lib/api';
import { useTheme } from '../lib/theme';
import { formatDuration } from '../lib/tz';
import { Avatar, AvatarGroup, EmptyState, Skeleton, cx } from '../ui';
import { LocationIcon } from './components/LocationIcon';
import { PageMessage, PublicPage, useDocumentTitle } from './components/PublicPage';
import { PublicFooter } from './components/PublicFooter';
import { isEmbedSearch, withEmbed } from './lib/embed';
import { firstName, isWebUrl, joinNames, paragraphs } from './lib/text';

type State = { status: 'loading' } | { status: 'ready'; site: PublicSite } | { status: 'error'; offline: boolean };

function durationsLabel(durations: number[]): string {
  if (durations.length <= 1) return formatDuration(durations[0] ?? 30);
  const allMinutes = durations.every((d) => d < 60);
  if (allMinutes) return `${joinNames(durations.map(String), 'or')} min`;
  return joinNames(durations.map(formatDuration), 'or');
}

function EventCard({ event, embed }: { event: PublicEventType; embed: boolean }) {
  const several = event.hosts.length > 1;
  const names = joinNames(event.hosts.map((h) => firstName(h.name)), event.kind === 'round_robin' ? 'or' : 'and');
  const first = event.locations[0];
  const style = isHex(event.color) ? ({ '--ev': event.color } as CSSProperties) : undefined;
  return (
    <li>
      <Link to={withEmbed(`/${event.slug}`, embed)} className="pl-card" style={style}>
        <span className="pl-card__tile" aria-hidden="true">
          {event.emoji ? <span className="pl-card__emoji">{event.emoji}</span> : <CalendarDays size={22} />}
        </span>
        <span className="pl-card__body">
          <span className="pl-card__title">{event.title}</span>
          {event.description ? <span className="pl-card__desc">{event.description}</span> : null}
          <span className="pl-card__meta">
            <span className="pl-card__fact">
              <Clock size={15} aria-hidden="true" />
              {durationsLabel(event.durations)}
            </span>
            {first ? (
              <span className="pl-card__fact">
                <LocationIcon type={first.type} size={15} />
                {event.locations.length > 1 ? `${first.label} +${event.locations.length - 1}` : first.label}
              </span>
            ) : null}
            {several ? (
              <span className="pl-card__fact">
                <AvatarGroup people={event.hosts} size={22} max={3} className="pl-card__hosts" />
                {event.kind === 'round_robin' ? `${names}, whoever is free` : `With ${names}`}
              </span>
            ) : null}
          </span>
        </span>
        <span className="pl-card__go" aria-hidden="true">
          <ArrowRight size={18} />
        </span>
      </Link>
    </li>
  );
}

function LandingContent({ site, embed }: { site: PublicSite; embed: boolean }) {
  const { theme, assets } = useTheme();
  const [coverFailed, setCoverFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const { profile } = site;
  const welcome = paragraphs(profile.welcome);
  const links = profile.links.filter((l) => l.label && isWebUrl(l.url));
  const cover = assets.coverUrl && theme.coverHeight > 0 && !coverFailed ? assets.coverUrl : null;

  return (
    <div className={cx('pl', embed && 'pl--embed', cover && 'pl--cover')}>
      {cover ? (
        <div className="pl__cover" style={{ height: `min(${theme.coverHeight}px, 42cqw)` }}>
          <img src={cover} alt="" onError={() => setCoverFailed(true)} />
        </div>
      ) : null}

      <div className="pl__grid">
        <header className="pl__profile">
          {assets.logoUrl && !logoFailed ? <img className="pl__logo" src={assets.logoUrl} alt={`${profile.name} logo`} onError={() => setLogoFailed(true)} /> : null}
          <div className="pl__who">
            {theme.showAvatar ? <Avatar name={profile.name} src={profile.avatarUrl} size={72} decorative className="pl__avatar" /> : null}
            <p className="pl__name">{profile.name}</p>
          </div>
          <h1 className="pl__headline">{profile.headline || `Book time with ${firstName(profile.name)}`}</h1>
          {welcome.length ? (
            <div className="pl__welcome">
              {welcome.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          ) : null}
          {links.length ? (
            <ul role="list" className="pl__links">
              {links.map((l) => (
                <li key={l.url + l.label}>
                  <a className="pl__link" href={l.url} target="_blank" rel="noopener noreferrer">
                    <span>{l.label}</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </header>

        <section className="pl__events" aria-labelledby="pl-events-title">
          <h2 className="pl__eyebrow" id="pl-events-title">
            {site.eventTypes.length === 1 ? 'One way to meet' : 'Choose a meeting'}
          </h2>
          {site.eventTypes.length ? (
            <ul role="list" className="pl__list">
              {site.eventTypes.map((event) => (
                <EventCard key={event.id} event={event} embed={embed} />
              ))}
            </ul>
          ) : (
            <div className="pp-card">
              <EmptyState
                as="h3"
                icon={<CalendarOff />}
                title="Nothing to book just yet"
                description={`${firstName(profile.name)} has not opened any meeting types. Please check back soon.`}
              />
            </div>
          )}
        </section>
      </div>

      {embed ? null : <PublicFooter site={site} />}
    </div>
  );
}

function LandingSkeleton() {
  return (
    <div className="pl pl--skeleton" aria-busy="true">
      <p className="u-vh" role="status">
        Loading
      </p>
      <div className="pl__grid" aria-hidden="true">
        <div className="pl__profile">
          <Skeleton circle width={72} height={72} />
          <Skeleton width="70%" height={40} />
          <Skeleton lines={2} height={15} />
        </div>
        <div className="pl__events">
          <Skeleton width={140} height={14} />
          <div className="pl__list">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} height={112} radius="var(--m-radius-lg)" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const { search } = useLocation();
  const embed = isEmbedSearch(search);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    getPublicSite({ signal: controller.signal }).then(
      (site) => setState({ status: 'ready', site }),
      (e: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', offline: isApiFailure(e) && e.isNetwork });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const site = state.status === 'ready' ? state.site : null;
  useDocumentTitle(site ? site.profile.headline || `Book time with ${site.profile.name}` : null);

  if (!site) {
    return (
      <PublicPage embed={embed}>
        {state.status === 'error' ? (
          <PageMessage
            kind={state.offline ? 'offline' : 'error'}
            title={state.offline ? 'You seem to be offline' : 'This page did not load'}
            description={state.offline ? 'Check your connection and try again.' : 'Something went wrong on our side. Please try again in a moment.'}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <LandingSkeleton />
        )}
      </PublicPage>
    );
  }

  return (
    <PublicPage theme={site.theme} assets={site.themeAssets} embed={embed}>
      <LandingContent site={site} embed={embed} />
    </PublicPage>
  );
}
