/**
 * The booking widget: event summary, month calendar, time list, details form, confirmation.
 *
 * It does NOT create its own <ThemeScope>: the caller wraps it (the booking page with the
 * event's resolved theme, the design editor with the draft theme). Everything visual reads the
 * theme through useTheme(), the `--m-*` variables and the scope's data attributes, and every
 * responsive rule keys off the widget's own width (CSS container queries), so it lays out
 * correctly inside a narrow preview box as well as on a phone.
 *
 * mode="live"    talks to the API.
 * mode="preview" generates believable fake times and a fake confirmation. It never calls the API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarX2, CircleAlert, CloudOff, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import type { CreateBookingRequest, CreateBookingResponse, PublicEventType, PublicSite } from '../../shared/types';
import { createBooking, isApiFailure, rescheduleBooking } from '../lib/api';
import { useTheme } from '../lib/theme';
import { addMonths, dayKey, detectLocale, formatDayKey, formatMonthYear, formatTime, monthRange, parseDayKey, todayKey } from '../lib/tz';
import { Button, EmptyState, cx } from '../ui';
import '../styles/public.css';
import { Confirmation } from './components/Confirmation';
import { DetailsForm, callOffered } from './components/DetailsForm';
import type { FormNotice, FormValues } from './components/DetailsForm';
import { EventSummary } from './components/EventSummary';
import { MonthCalendar } from './components/MonthCalendar';
import { PublicFooter } from './components/PublicFooter';
import { SlotList } from './components/SlotList';
import { TimezoneBar } from './components/TimezoneBar';
import { guessCountry } from './lib/phone';
import { useVisitorPrefs } from './lib/prefs';
import { SlotStore, useMonthSlots } from './lib/slots';
import { hostNames, plural } from './lib/text';

export interface BookingWidgetPrefill {
  name?: string;
  email?: string;
  phone?: string;
  /** minutes: one of eventType.durations */
  duration?: number;
  /** YYYY-MM: month to open */
  month?: string;
  /** YYYY-MM-DD: day to preselect */
  date?: string;
  /** utm_* query parameters to pass along with the booking */
  utm?: Record<string, string>;
}

export type BookingWidgetStep = 'pick' | 'details' | 'done';

export interface BookingWidgetProps {
  site: PublicSite;
  eventType: PublicEventType;
  /** live = talks to the API. preview = generated fake slots, never calls the API (design editor). */
  mode: 'live' | 'preview';
  /**
   * set when moving an existing booking instead of creating one. durationMin keeps the booked length.
   * asHost: the page was opened from a host's link, so this browser's zone is not the invitee's.
   */
  reschedule?: { bookingId: string; token: string; currentStart: string; durationMin?: number; asHost?: boolean };
  /** called after a booking was created (or moved, with the same manage token) */
  onBooked?: (result: CreateBookingResponse) => void;
  prefill?: BookingWidgetPrefill;
  /** route of the list of meeting types: shows a "All meeting types" link in the summary */
  backHref?: string;
  /** recorded on the booking. "embed" also keeps embed=1 on the manage links. */
  source?: 'page' | 'embed';
  /** leave out the footer note and scheduling credit under the card */
  hideFooter?: boolean;
  /** preview mode only: which step to show, so the design editor can style every screen */
  previewStep?: BookingWidgetStep;
  /** rescheduling: called when the visitor decides to keep the current time */
  onCancelReschedule?: () => void;
}

interface View {
  year: number;
  month: number;
}

const DAY_MS = 86400000;
const MIN_FORM_MS = 1600;
const monthOf = (key: string) => key.slice(0, 7);
const viewOfKey = (key: string): View => {
  const p = parseDayKey(key);
  return { year: p.year, month: p.month };
};
/** "2026-11": months compare as text. */
const keyOfView = (v: View): string => `${String(v.year).padStart(4, '0')}-${String(v.month).padStart(2, '0')}`;
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** 128 random bits, URL safe. Made once per booking form and sent with every try of it. */
function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function BookingWidget({ site, eventType, mode, reschedule, onBooked, prefill, backHref, source = 'page', hideFooter = false, previewStep, onCancelReschedule }: BookingWidgetProps) {
  const { theme, assets, hour12: themeHour12, weekStart, motion } = useTheme();
  const preview = mode === 'preview';
  const isReschedule = !!reschedule;
  const locale = useMemo(() => detectLocale(), []);
  const { zone, setZone, hour12, setHour12 } = useVisitorPrefs({ defaultHour12: themeHour12, persist: !preview });

  const rootRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<HTMLDivElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const doneHeadingRef = useRef<HTMLHeadingElement>(null);

  // ───────────── what is being booked ─────────────

  const [duration, setDuration] = useState<number>(() => {
    const wanted = reschedule?.durationMin ?? prefill?.duration;
    if (wanted && (isReschedule || eventType.durations.includes(wanted))) return wanted;
    return eventType.durations.includes(eventType.defaultDuration) ? eventType.defaultDuration : (eventType.durations[0] ?? 30);
  });
  const [locationIndex, setLocationIndex] = useState(0);
  const location = eventType.locations[locationIndex] ?? eventType.locations[0];

  // The design editor can swap the event under a mounted widget: keep the choices valid.
  useEffect(() => {
    if (isReschedule) return;
    if (!eventType.durations.includes(duration)) setDuration(eventType.durations.includes(eventType.defaultDuration) ? eventType.defaultDuration : (eventType.durations[0] ?? 30));
    if (locationIndex >= eventType.locations.length) setLocationIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType.durations.join(','), eventType.locations.length]);

  const rescheduleId = reschedule?.bookingId;
  const rescheduleToken = reschedule?.token;
  const store = useMemo(
    () =>
      new SlotStore({
        slug: eventType.slug,
        preview,
        previewZone: site.ownerTimezone,
        reschedule: rescheduleId && rescheduleToken ? { bookingId: rescheduleId, token: rescheduleToken } : undefined,
      }),
    [eventType.slug, preview, site.ownerTimezone, rescheduleId, rescheduleToken],
  );

  // ───────────── calendar state ─────────────

  const [now] = useState(() => Date.now());
  const currentStart = useMemo(() => {
    const ms = reschedule ? Date.parse(reschedule.currentStart) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }, [reschedule]);
  const today = todayKey(zone, now);
  const horizon = now + Math.max(1, eventType.maxDaysAhead) * DAY_MS;
  const maxDay = dayKey(horizon, zone);

  const [plan] = useState(() => {
    if (currentStart && currentStart > now) {
      const day = dayKey(currentStart, zone);
      return { view: viewOfKey(day), day: day as string | null };
    }
    if (validDayKey(prefill?.date) && prefill.date >= today && prefill.date <= maxDay) return { view: viewOfKey(prefill.date), day: prefill.date as string | null };
    if (prefill?.month && /^\d{4}-\d{2}$/.test(prefill.month) && prefill.month >= monthOf(today) && prefill.month <= monthOf(maxDay)) {
      return { view: viewOfKey(`${prefill.month}-01`), day: null as string | null };
    }
    return { view: viewOfKey(today), day: null as string | null };
  });

  const [view, setView] = useState<View>(plan.view);
  const [selectedDay, setSelectedDay] = useState<string | null>(plan.day);
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [locating, setLocating] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const viewKey = `${String(view.year).padStart(4, '0')}-${String(view.month).padStart(2, '0')}`;

  const month = useMonthSlots(store, duration, zone, view.year, view.month);
  const monthLabel = formatMonthYear(view.year, view.month, locale);

  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Find the first month, from the one on screen, that has an open time.
  useEffect(() => {
    let alive = true;
    const start = viewRef.current;
    setLocating(true);
    setExhausted(false);
    void (async () => {
      /** Months from `from` on, up to the horizon (and before `until` when given). null once this search is stale. */
      const search = async (from: View, until: View | null): Promise<{ view: View; found: boolean; failed: boolean } | null> => {
        let cursor = from;
        for (let i = 0; i < 14; i++) {
          if (until && keyOfView(cursor) >= keyOfView(until)) break;
          const range = monthRange(cursor.year, cursor.month, zoneRef.current);
          if (range.from > horizon) break;
          const status = await store.ensure(duration, range.from, range.to);
          if (!alive) return null;
          if (status.state === 'error') return { view: cursor, found: false, failed: true };
          if (store.slots(duration, range.from, range.to).length) return { view: cursor, found: true, failed: false };
          cursor = addMonths(cursor.year, cursor.month, 1);
        }
        return { view: cursor, found: false, failed: false };
      };
      let result = await search(start, null);
      if (!result) return;
      // Nothing from the month on screen onwards. When that month is later than this one (the visitor paged
      // ahead, or a booking being moved opened on its own month), the weeks before it may still have times.
      const thisMonth = viewOfKey(todayKey(zoneRef.current, now));
      if (!result.found && !result.failed && keyOfView(start) > keyOfView(thisMonth)) {
        const earlier = await search(thisMonth, start);
        if (!earlier) return;
        if (earlier.found || earlier.failed) result = earlier;
      }
      if (!alive) return;
      if (result.found || result.failed) setView(result.view);
      else setExhausted(true);
      setLocating(false);
    })();
    return () => {
      alive = false;
    };
    // The search restarts for another event or length, not when the zone or the month changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, duration]);

  const ready = !locating && month.status.state === 'ready';

  // Keep a day selected: the first open one of the month unless the current choice still has times.
  useEffect(() => {
    if (!ready) return;
    if (selectedDay && month.byDay.has(selectedDay)) return;
    const next = month.days[0] ?? null;
    if (next !== selectedDay) setSelectedDay(next);
  }, [ready, month.byDay, month.days, selectedDay]);

  // A chosen time that is no longer offered (another length, refreshed data) is dropped.
  useEffect(() => {
    if (!ready || selectedStart === null) return;
    const day = dayKey(selectedStart, zone);
    if (monthOf(day) !== viewKey) return;
    if (!month.byDay.get(day)?.includes(selectedStart)) setSelectedStart(null);
  }, [ready, selectedStart, zone, viewKey, month.byDay]);

  const availability = useMemo(() => {
    const map = new Map<string, number>();
    month.byDay.forEach((list, key) => map.set(key, list.length));
    return map;
  }, [month.byDay]);

  const daySlots = selectedDay ? (month.byDay.get(selectedDay) ?? []) : [];

  // ───────────── steps ─────────────

  const [step, setStep] = useState<BookingWidgetStep>('pick');
  const [values, setValues] = useState<FormValues>(() => ({
    name: prefill?.name?.slice(0, 120) ?? '',
    email: prefill?.email?.slice(0, 254) ?? '',
    phone: prefill?.phone?.slice(0, 32) ?? '',
    phoneCountry: guessCountry(zone, locale),
    guests: [],
    guestsOpen: false,
    answers: {},
    locationText: '',
    sms: site.booking.reminderOptInDefault,
    call: site.booking.reminderOptInDefault,
    website: '',
  }));
  const patchValues = useCallback((patch: Partial<FormValues>) => setValues((prev) => ({ ...prev, ...patch })), []);
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formNotice, setFormNotice] = useState<FormNotice | null>(null);
  const [pickNotice, setPickNotice] = useState<{ tone: 'warning' | 'error'; title: string; message?: string } | null>(null);
  const [result, setResult] = useState<CreateBookingResponse | null>(null);
  const formOpenedAt = useRef<number | null>(null);
  // The same key on every try of this form: a try whose answer got lost then comes back as that booking, not a second one.
  const requestKey = useRef<string | null>(null);

  const previewResult = useCallback(
    (start: number): CreateBookingResponse => ({
      manageToken: 'preview',
      booking: {
        id: 'preview',
        status: 'confirmed',
        eventTitle: eventType.title,
        eventSlug: eventType.slug,
        start: new Date(start).toISOString(),
        end: new Date(start + duration * 60000).toISOString(),
        durationMin: duration,
        hosts: eventType.kind === 'round_robin' ? eventType.hosts.slice(0, 1) : eventType.hosts,
        invitee: { name: values.name.trim() || 'Amina Wanjiru', email: values.email.trim() || 'amina@example.org', timezone: zone },
        guests: values.guests,
        location: {
          type: location?.type ?? 'google_meet',
          label: location?.label ?? 'Google Meet',
          // A Meet booking has no address: the confirmation says where the link will be instead.
          value: location?.type === 'ask_invitee' ? values.locationText : !location || location.type === 'google_meet' ? undefined : location.detail,
        },
        canReschedule: true,
        canCancel: true,
        calendarLinks: { google: '#', outlook: '#', office365: '#', ics: '#' },
        cancellation: null,
        rescheduledFromStart: null,
        attendanceConfirmed: false,
      },
    }),
    [eventType, duration, values.name, values.email, values.guests, values.locationText, zone, location],
  );

  // Design editor: jump to the step being styled, picking a time for it when none is chosen.
  useEffect(() => {
    if (!preview || !previewStep || !ready) return;
    if (previewStep === 'pick') {
      setStep('pick');
      return;
    }
    const start = selectedStart ?? daySlots[0] ?? store.slots(duration, month.range.from, month.range.to)[0] ?? now + 2 * DAY_MS;
    if (selectedStart === null) setSelectedStart(start);
    if (previewStep === 'done') setResult((prev) => prev ?? previewResult(start));
    setStep(previewStep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, previewStep, ready]);

  // Move focus with the step so keyboard and screen reader users land in the new content.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (preview && previewStep) return;
    const root = rootRef.current;
    if (!root) return;
    const frame = window.requestAnimationFrame(() => {
      if (root.getBoundingClientRect().top < 0) root.scrollIntoView({ block: 'start', behavior: motion ? 'smooth' : 'auto' });
      if (step === 'details') formHeadingRef.current?.focus({ preventScroll: true });
      else if (step === 'done') doneHeadingRef.current?.focus({ preventScroll: true });
      else (root.querySelector<HTMLElement>('.bw-slot.is-selected') ?? root.querySelector<HTMLElement>('.bw-day[tabindex="0"]'))?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ───────────── handlers ─────────────

  const changeMonth = (year: number, m: number) => {
    setView({ year, month: m });
    setSelectedDay(null);
    setExhausted(false);
  };

  const pickDay = (key: string) => {
    setSelectedDay(key);
    setPickNotice(null);
    if (selectedStart !== null && dayKey(selectedStart, zone) !== key) setSelectedStart(null);
    // On a narrow card the times sit under the calendar: bring them into view.
    window.requestAnimationFrame(() => {
      const el = slotsRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.62) window.scrollBy({ top: rect.top - window.innerHeight * 0.28, behavior: motion ? 'smooth' : 'auto' });
    });
  };

  const pickSlot = (start: number) => {
    setSelectedStart(start);
    setPickNotice(null);
    if (isReschedule) {
      // The bar with "Confirm new time" keeps to the bottom of the screen. A time tapped down there would end
      // up underneath it: nudge it into the clear (the room it needs is the slot's scroll margin in the CSS).
      // Two frames: the first paints the bar and the new line in the summary, which both move things.
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          rootRef.current?.querySelector<HTMLElement>(`.bw-slot[data-start="${start}"]`)?.scrollIntoView({ block: 'nearest', behavior: motion ? 'smooth' : 'auto' });
        }),
      );
      return;
    }
    if (formOpenedAt.current === null) formOpenedAt.current = Date.now();
    setFormNotice(null);
    setStep('details');
  };

  const changeZone = (next: string) => {
    const anchor = selectedStart ?? (selectedDay ? month.byDay.get(selectedDay)?.[0] : undefined);
    setZone(next);
    if (anchor) {
      const key = dayKey(anchor, next);
      setSelectedDay(key);
      setView(viewOfKey(key));
    } else {
      setSelectedDay(null);
      setView(viewOfKey(todayKey(next, now)));
    }
  };

  const changeDuration = (minutes: number) => {
    setDuration(minutes);
    setSelectedStart(null);
    setPickNotice(null);
  };

  /** The time was taken while the visitor filled in the form: back to the times, details kept. */
  const slotGone = (start: number, message: string | undefined, kept: boolean) => {
    store.remove(duration, start);
    store.invalidate();
    setSelectedStart(null);
    setStep('pick');
    setPickNotice({
      tone: 'warning',
      title: 'That time was just taken',
      message: kept ? 'Please pick another one. Everything you typed is still here.' : message || 'Please pick another one.',
    });
  };

  const submitBooking = async ({ phoneE164 }: { phoneE164: string | undefined }) => {
    if (selectedStart === null || submitting) return;
    const start = selectedStart;
    setSubmitting(true);
    setFormNotice(null);
    setServerErrors({});

    if (preview) {
      await sleep(500);
      setResult(previewResult(start));
      setSubmitting(false);
      setStep('done');
      return;
    }

    // Bots submit instantly and the server refuses anything under 1.5 s. A very quick person waits a moment instead.
    const opened = formOpenedAt.current ?? Date.now();
    const waited = Date.now() - opened;
    if (waited < MIN_FORM_MS) await sleep(MIN_FORM_MS - waited);

    const answers: NonNullable<CreateBookingRequest['answers']> = {};
    for (const q of eventType.questions) {
      const v = values.answers[q.id];
      if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0)) continue;
      answers[q.id] = typeof v === 'string' ? v.trim() : v;
    }
    const request: CreateBookingRequest = {
      slug: eventType.slug,
      start: new Date(start).toISOString(),
      durationMin: duration,
      name: values.name.trim(),
      email: values.email.trim(),
      phone: phoneE164,
      timezone: zone,
      locale,
      guests: values.guests,
      answers,
      locationIndex,
      locationText: location?.type === 'ask_invitee' ? values.locationText.trim() : undefined,
      consent: phoneE164 ? { sms: site.features.sms && values.sms, call: callOffered(site, eventType) && values.call } : undefined,
      source,
      utm: prefill?.utm && Object.keys(prefill.utm).length ? prefill.utm : undefined,
      website: values.website,
      elapsedMs: Date.now() - opened,
      requestKey: (requestKey.current ??= newRequestKey()),
    };

    try {
      const res = await createBooking(request);
      setResult(res);
      setStep('done');
      onBooked?.(res);
    } catch (e) {
      if (isApiFailure(e) && (e.code === 'booking_limit' || e.code === 'phone_limit' || e.code === 'in_progress')) {
        setFormNotice({ title: e.code === 'in_progress' ? 'Your booking is on its way' : 'We could not complete the booking', message: e.message });
      } else if (isApiFailure(e) && (e.code === 'slot_taken' || e.status === 409)) {
        slotGone(start, e.message, true);
      } else if (isApiFailure(e) && e.status === 422 && e.fields && Object.keys(e.fields).length) {
        const known = ['name', 'email', 'phone', 'guests', 'locationText'];
        const usable = Object.keys(e.fields).some((k) => known.includes(k) || k.startsWith('answers.'));
        setServerErrors(e.fields);
        setFormNotice(usable ? { title: 'Please check the highlighted fields' } : { title: 'We could not complete the booking', message: Object.values(e.fields)[0] || e.message });
      } else if (isApiFailure(e) && e.code === 'calendar_unavailable') {
        setFormNotice({ title: 'The calendar is not answering right now', message: 'Nothing was booked. Please try again in a minute, your details are still here.' });
      } else if (isApiFailure(e) && e.status === 429) {
        setFormNotice({ title: 'Too many attempts', message: 'Please wait a minute and try again.' });
      } else if (isApiFailure(e) && (e.isNetwork || (e.status >= 500 && e.code !== 'busy'))) {
        // The request may have reached us and been booked before the answer got lost. Trying again is safe:
        // the same form sends the same key, so a booking that went through comes back instead of a second one.
        setFormNotice({
          title: e.isNetwork ? 'The connection dropped' : 'We could not confirm the booking',
          message: 'It may have gone through. Please try again: you will not be booked twice, and you will see your booking if it is already made.',
        });
      } else {
        setFormNotice({ title: 'We could not complete the booking', message: isApiFailure(e) && e.message ? e.message : 'Please try again in a moment.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const confirmReschedule = async () => {
    if (selectedStart === null || !reschedule || submitting) return;
    const start = selectedStart;
    setSubmitting(true);
    setPickNotice(null);
    try {
      if (preview) {
        await sleep(500);
        setResult(previewResult(start));
        setStep('done');
        return;
      }
      // A host moving the meeting is in their own zone, which must not become the invitee's.
      const booking = await rescheduleBooking(
        reschedule.bookingId,
        reschedule.token,
        new Date(start).toISOString(),
        reschedule.asHost ? undefined : zone,
        reschedule.asHost ? 'host' : undefined,
      );
      const res: CreateBookingResponse = { booking, manageToken: reschedule.token };
      setResult(res);
      setStep('done');
      onBooked?.(res);
    } catch (e) {
      if (isApiFailure(e) && e.code === 'move_limit') setPickNotice({ tone: 'warning', title: 'This meeting cannot be moved again right now', message: e.message });
      // The time may well be free: the calendar could not be asked. Keep it chosen so trying again is one tap.
      else if (isApiFailure(e) && e.code === 'calendar_unavailable')
        setPickNotice({ tone: 'warning', title: 'The calendar is not answering right now', message: 'Your meeting has not been moved. Please try again in a minute.' });
      else if (isApiFailure(e) && (e.code === 'slot_taken' || e.status === 409)) slotGone(start, e.message, false);
      else setPickNotice({ tone: 'error', title: 'We could not move your meeting', message: isApiFailure(e) && e.message ? e.message : 'Nothing has changed. Please try again in a moment.' });
    } finally {
      setSubmitting(false);
    }
  };

  // ───────────── announcements ─────────────

  const liveMessage = (() => {
    if (step !== 'pick') return '';
    if (locating || month.status.state === 'loading') return 'Loading available times.';
    if (month.status.state === 'error') return '';
    if (exhausted) return 'No open times right now.';
    const base = `${monthLabel}: ${month.days.length ? `${plural(month.days.length, 'day has', 'days have')} open times` : 'no open times'}.`;
    if (selectedDay && daySlots.length) return `${base} ${formatDayKey(selectedDay, locale, 'long')}: ${plural(daySlots.length, 'time', 'times')}.`;
    return base;
  })();

  // ───────────── cover ─────────────

  const [coverFailed, setCoverFailed] = useState(false);
  const coverUrl = eventType.coverUrl ?? assets.coverUrl;
  useEffect(() => setCoverFailed(false), [coverUrl]);
  const coverHeight = coverUrl && !coverFailed ? (theme.coverHeight > 0 ? theme.coverHeight : eventType.coverUrl ? 180 : 0) : 0;

  // ───────────── render ─────────────

  const slotError = !locating && month.status.state === 'error' ? month.status : null;
  const calendarLoading = locating || month.status.state === 'loading';

  const rescheduleBar =
    isReschedule && selectedStart !== null ? (
      <div className="bw-confirmbar">
        <p className="bw-confirmbar__text">
          <span className="bw-confirmbar__label">New time</span>
          <span className="bw-confirmbar__value">
            {formatDayKey(dayKey(selectedStart, zone), locale, 'medium')}, {formatTime(selectedStart, zone, { hour12, locale })}
          </span>
        </p>
        <Button variant="primary" loading={submitting} loadingLabel="Moving your meeting" onClick={confirmReschedule} disabled={selectedStart === currentStart}>
          {selectedStart === currentStart ? 'This is your current time' : 'Confirm new time'}
        </Button>
      </div>
    ) : null;

  const pick = (
    <div className="bw-pick">
      <div className="bw-pick__head">
        <h2 className="bw-pick__title">{isReschedule ? 'Pick a new time' : theme.texts.pickTimeLabel || 'Pick a time'}</h2>
        {isReschedule && onCancelReschedule ? (
          <button type="button" className="bw-back bw-back--quiet" onClick={onCancelReschedule}>
            Keep my current time
          </button>
        ) : null}
      </div>

      {pickNotice ? (
        <div className={cx('bw-notice', `bw-notice--${pickNotice.tone}`, 'bw-pick__notice')} role="alert">
          {pickNotice.tone === 'warning' ? <TriangleAlert size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
          <div className="bw-notice__body">
            <p className="bw-notice__title">{pickNotice.title}</p>
            {pickNotice.message ? <p className="bw-notice__text">{pickNotice.message}</p> : null}
          </div>
        </div>
      ) : null}

      {slotError ? (
        <div className="bw-pick__state" role="alert">
          <EmptyState
            as="h3"
            tone="danger"
            icon={slotError.problem === 'network' ? <WifiOff /> : slotError.problem === 'inactive' ? <CalendarX2 /> : <CloudOff />}
            title={
              slotError.problem === 'network'
                ? 'You seem to be offline'
                : slotError.problem === 'inactive'
                  ? 'Not taking bookings right now'
                  : slotError.problem === 'calendar_error'
                    ? 'We cannot check the calendar right now'
                    : 'The times did not load'
            }
            description={slotError.problem === 'network' ? 'Check your connection and try again.' : slotError.message}
            action={
              slotError.problem === 'inactive' ? undefined : (
                <Button variant="secondary" iconLeft={<RefreshCw size={16} />} onClick={month.retry}>
                  Try again
                </Button>
              )
            }
          />
        </div>
      ) : exhausted ? (
        <div className="bw-pick__state">
          <EmptyState
            as="h3"
            icon={<CalendarX2 />}
            title="No open times right now"
            description={
              // A joint meeting may have no time at all when everyone is working, so it promises nothing.
              eventType.kind === 'collective' && eventType.hosts.length > 1
                ? `There is no time in the next ${plural(eventType.maxDaysAhead, 'day', 'days')} when ${hostNames(eventType.hosts, 'collective')} are ${eventType.hosts.length === 2 ? 'both' : 'all'} free. If someone sent you this link, let them know.`
                : `Nothing is free in the next ${plural(eventType.maxDaysAhead, 'day', 'days')}. Please check back soon, new times open up every day.`
            }
          />
        </div>
      ) : (
        <>
          <div className="bw-pick__cal">
            <MonthCalendar
              year={view.year}
              month={view.month}
              weekStart={weekStart}
              today={today}
              minDay={today}
              maxDay={maxDay}
              availability={availability}
              loading={calendarLoading}
              selectedDay={selectedDay}
              onSelectDay={pickDay}
              onMonthChange={changeMonth}
              locale={locale}
              markedDay={currentStart && currentStart > now ? dayKey(currentStart, zone) : null}
            />
            <TimezoneBar zone={zone} onZoneChange={changeZone} hour12={hour12} onHour12Change={setHour12} />
          </div>
          <div className="bw-pick__slots" ref={slotsRef}>
            <SlotList
              day={selectedDay}
              slots={daySlots}
              zone={zone}
              hour12={hour12}
              selected={selectedStart}
              onSelect={pickSlot}
              loading={calendarLoading}
              currentStart={currentStart}
              locale={locale}
              footer={rescheduleBar}
              emptyTitle={!selectedDay && !month.days.length ? `No open times in ${monthLabel}` : undefined}
              emptyHint={!selectedDay && !month.days.length ? 'Try another month with the arrows above the calendar.' : undefined}
            />
          </div>
        </>
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={cx('bw', `bw--${step}`, isReschedule && 'bw--reschedule', preview && 'bw--preview')} data-step={step}>
      <p className="u-vh" role="status" aria-live="polite">
        {liveMessage}
      </p>

      <div className="bw__card">
        {coverHeight > 0 && coverUrl ? (
          <div className="bw__cover" style={{ height: `min(${coverHeight}px, 46cqw)` }}>
            <img src={coverUrl} alt="" onError={() => setCoverFailed(true)} />
          </div>
        ) : null}

        {step === 'done' && result ? (
          <Confirmation
            site={site}
            booking={result.booking}
            manageToken={result.manageToken}
            zone={zone}
            hour12={hour12}
            locale={locale}
            variant={isReschedule ? 'rescheduled' : 'booked'}
            preview={preview}
            embed={source === 'embed'}
            headingRef={doneHeadingRef}
          />
        ) : (
          <div className="bw__body">
            <div className="bw__summary">
              <EventSummary
                site={site}
                eventType={eventType}
                duration={duration}
                onDurationChange={changeDuration}
                locationIndex={locationIndex}
                onLocationChange={setLocationIndex}
                zone={zone}
                hour12={hour12}
                selectedStart={step === 'details' || isReschedule ? selectedStart : null}
                rescheduleFrom={currentStart}
                locked={isReschedule || step === 'details'}
                backHref={backHref}
                locale={locale}
              />
            </div>
            <div className="bw__main" key={step}>
              {step === 'details' && selectedStart !== null ? (
                <DetailsForm
                  site={site}
                  eventType={eventType}
                  location={location}
                  values={values}
                  onChange={patchValues}
                  onSubmit={submitBooking}
                  onBack={() => setStep('pick')}
                  submitting={submitting}
                  serverErrors={serverErrors}
                  notice={formNotice}
                  zone={zone}
                  hour12={hour12}
                  start={selectedStart}
                  duration={duration}
                  locale={locale}
                  ctaLabel={theme.texts.ctaLabel || 'Confirm booking'}
                  headingRef={formHeadingRef}
                />
              ) : (
                pick
              )}
            </div>
          </div>
        )}
      </div>

      {hideFooter ? null : <PublicFooter site={site} inert={preview} />}
    </div>
  );
}

export default BookingWidget;
