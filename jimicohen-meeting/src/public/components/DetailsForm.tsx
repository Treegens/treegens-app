import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import { ArrowLeft, CalendarCheck, CircleAlert, UserPlus } from 'lucide-react';
import type { PublicEventType, PublicSite } from '../../../shared/types';
import { dayKey, formatDayKey, formatRange } from '../../lib/tz';
import { Button, Field, Input, Switch } from '../../ui';
import { checkPhone, loadPhoneLib } from '../lib/phone';
import { EMAIL_RE, fillTemplate, firstName, isWebUrl } from '../lib/text';
import { GuestsField } from './GuestsField';
import { PhoneField } from './PhoneField';
import { QuestionField, validateAnswer } from './QuestionField';
import type { AnswerValue } from './QuestionField';

export interface FormValues {
  name: string;
  email: string;
  /** as typed */
  phone: string;
  phoneCountry: string;
  guests: string[];
  guestsOpen: boolean;
  answers: Record<string, AnswerValue>;
  /** where to meet, when the chosen location asks the invitee */
  locationText: string;
  sms: boolean;
  call: boolean;
  /** honeypot: people never see or fill this */
  website: string;
}

export interface FormNotice {
  title: string;
  message?: string;
  action?: ReactNode;
}

export interface DetailsFormProps {
  site: PublicSite;
  eventType: PublicEventType;
  location: PublicEventType['locations'][number] | undefined;
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  /** called with the normalised phone number once everything is valid */
  onSubmit: (extra: { phoneE164: string | undefined }) => void;
  onBack: () => void;
  submitting: boolean;
  /** field errors from the server, keyed like the request: name, email, phone, guests, locationText, answers.<id> */
  serverErrors: Record<string, string>;
  notice: FormNotice | null;
  zone: string;
  hour12: boolean;
  start: number;
  duration: number;
  locale: string;
  ctaLabel: string;
  headingRef: RefObject<HTMLHeadingElement>;
}

type Errors = Record<string, string>;

/** Whether the form offers a reminder call: the site can place calls and this meeting has one. */
export function callOffered(site: PublicSite, eventType: PublicEventType): boolean {
  return site.features.calls && eventType.reminderChannels?.call !== false;
}

/** Who is booking: contact details, guests, the owner's questions, reminder choices. */
export function DetailsForm({ site, eventType, location, values, onChange, onSubmit, onBack, submitting, serverErrors, notice, zone, hour12, start, duration, locale, ctaLabel, headingRef }: DetailsFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const auto = useId();
  const titleId = `bwf${auto}`;
  const honeypotId = `bwh${auto}`;
  const [errors, setErrors] = useState<Errors>({});
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [checking, setChecking] = useState(false);

  // The number library is only needed here, so fetch it when the form opens.
  useEffect(() => {
    if (eventType.phone !== 'hidden' || location?.type === 'phone_host_calls') void loadPhoneLib().catch(() => undefined);
  }, [eventType.phone, location?.type]);

  // A fresh answer from the server replaces whatever was dismissed before.
  useEffect(() => {
    setDismissed(new Set());
  }, [serverErrors]);

  const hostFirst = firstName(eventType.hosts[0]?.name ?? site.profile.name);
  const phoneNeeded = eventType.phone === 'required' || location?.type === 'phone_host_calls';
  const showPhone = eventType.phone !== 'hidden' || phoneNeeded;
  const hasPhone = values.phone.trim().length > 0;
  const showSms = showPhone && site.features.sms;
  // Only a meeting with a reminder call offers one (and asks to agree to it).
  const showCall = showPhone && callOffered(site, eventType);
  const asksLocation = location?.type === 'ask_invitee';
  const agreesToCall = showCall && values.call;

  const consentText = useMemo(
    () =>
      fillTemplate(agreesToCall ? site.booking.consentText : (site.booking.consentTextSms ?? site.booking.consentText), {
        host_first_name: hostFirst,
        host_name: eventType.hosts[0]?.name ?? site.profile.name,
        assistant_name: site.assistantName,
        site_name: site.profile.name,
        event_name: eventType.title,
      }),
    [site, eventType, hostFirst, agreesToCall],
  );
  // The email hint says only what really goes to that address.
  const emailed = site.features.email !== false;
  const invited = eventType.calendarInvite !== false;
  const emailHint = emailed && invited ? 'Your confirmation and calendar invitation go here.' : emailed ? 'Your confirmation goes here.' : invited ? 'Your calendar invitation goes here.' : 'So your host can reach you about the meeting.';

  const errorOf = (key: string): string | undefined => errors[key] || (!dismissed.has(key) ? serverErrors[key] : undefined) || undefined;

  const clear = (key: string) => {
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
    if (serverErrors[key] && !dismissed.has(key)) setDismissed((prev) => new Set(prev).add(key));
  };

  const setError = (key: string, message: string) => setErrors((prev) => (prev[key] === message ? prev : { ...prev, [key]: message }));

  const checkName = (): string => {
    const v = values.name.trim();
    if (!v) return 'Please enter your name.';
    if (v.length < 2) return 'Please enter your full name.';
    return '';
  };

  const checkEmail = (): string => {
    const v = values.email.trim();
    if (!v) return 'Please enter your email address.';
    if (!EMAIL_RE.test(v)) return 'That email address does not look right.';
    return '';
  };

  const checkLocationText = (): string => (asksLocation && !values.locationText.trim() ? 'Please tell us where you would like to meet.' : '');

  const checkPhoneField = async (): Promise<{ message: string; e164?: string }> => {
    if (!showPhone) return { message: '' };
    if (!hasPhone) {
      if (!phoneNeeded) return { message: '' };
      return { message: location?.type === 'phone_host_calls' ? `${hostFirst} needs a number to call you on.` : 'Please enter your phone number.' };
    }
    const result = await checkPhone(values.phone, values.phoneCountry);
    if (!result.ok) return { message: 'That number does not look right. Check the country code and digits.' };
    return { message: '', e164: result.e164 };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || checking) return;
    setChecking(true);
    const next: Errors = {
      name: checkName(),
      email: checkEmail(),
      locationText: checkLocationText(),
      guests: errors.guests && values.guestsOpen ? errors.guests : '',
    };
    for (const q of eventType.questions) next[`answers.${q.id}`] = validateAnswer(q, values.answers[q.id]);
    const phone = await checkPhoneField();
    next.phone = phone.message;
    setChecking(false);
    setErrors(next);
    setDismissed(new Set(Object.keys(serverErrors)));

    if (Object.values(next).some(Boolean)) {
      window.requestAnimationFrame(() => {
        const first = formRef.current?.querySelector<HTMLElement>('.is-invalid input:not([type="hidden"]), .is-invalid textarea, .is-invalid select');
        first?.focus();
      });
      return;
    }
    onSubmit({ phoneE164: phone.e164 });
  };

  const busy = submitting || checking;

  return (
    <form ref={formRef} className="bw-form" onSubmit={handleSubmit} noValidate aria-labelledby={titleId}>
      <div className="bw-form__top">
        <button type="button" className="bw-back" onClick={onBack} disabled={submitting}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Back</span>
        </button>
        <h2 className="bw-form__title" id={titleId} ref={headingRef} tabIndex={-1}>
          Your details
        </h2>
      </div>

      <div className="bw-recap">
        <span className="bw-recap__icon" aria-hidden="true">
          <CalendarCheck size={18} />
        </span>
        <div className="bw-recap__text">
          <p className="bw-recap__date">{formatDayKey(dayKey(start, zone), locale, 'long')}</p>
          <p className="bw-recap__time">{formatRange(start, start + duration * 60000, zone, { hour12, locale })}</p>
        </div>
        <button type="button" className="bw-recap__change" onClick={onBack} disabled={submitting}>
          Change
        </button>
      </div>

      <div className="bw-form__fields">
        <Field label="Name" required error={errorOf('name')}>
          <Input
            name="name"
            autoComplete="name"
            value={values.name}
            maxLength={120}
            onChange={(e) => {
              onChange({ name: e.target.value });
              clear('name');
            }}
            onBlur={() => values.name && setError('name', checkName())}
          />
        </Field>

        <Field label="Email" required error={errorOf('email')} hint={emailHint}>
          <Input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={values.email}
            maxLength={254}
            onChange={(e) => {
              onChange({ email: e.target.value });
              clear('email');
            }}
            onBlur={() => values.email && setError('email', checkEmail())}
          />
        </Field>

        {showPhone ? (
          <div className="bw-form__phone">
            <Field
              label="Phone"
              required={phoneNeeded}
              optional={!phoneNeeded}
              error={errorOf('phone')}
              hint={phoneNeeded ? undefined : showCall ? 'Add a number if you would like a reminder by text or phone.' : showSms ? 'Add a number if you would like a reminder by text.' : undefined}
            >
              <PhoneField
                value={values.phone}
                country={values.phoneCountry}
                locale={locale}
                onChange={(phone, phoneCountry) => {
                  onChange({ phone, phoneCountry });
                  clear('phone');
                }}
                onBlur={() => {
                  if (!hasPhone) return;
                  void checkPhoneField().then((r) => setError('phone', r.message));
                }}
              />
            </Field>

            {hasPhone && (showSms || showCall) ? (
              <div className="bw-reminders">
                {showSms ? <Switch checked={values.sms} onChange={(sms) => onChange({ sms })} label="Text me the confirmation and reminders" size="sm" /> : null}
                {showCall ? (
                  <Switch
                    checked={values.call}
                    onChange={(call) => onChange({ call })}
                    label={`Reminder call from ${site.assistantName}, ${hostFirst}'s AI assistant`}
                    description="A short call before the meeting. You can confirm, reschedule or cancel by voice."
                    size="sm"
                  />
                ) : null}
                {(showSms && values.sms) || (showCall && values.call) ? <p className="bw-reminders__consent">{consentText}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {asksLocation ? (
          <Field label="Where would you like to meet?" required error={errorOf('locationText')} hint="An address or a phone number.">
            <Input
              name="location"
              value={values.locationText}
              maxLength={300}
              onChange={(e) => {
                onChange({ locationText: e.target.value });
                clear('locationText');
              }}
              onBlur={() => values.locationText && setError('locationText', checkLocationText())}
            />
          </Field>
        ) : null}

        {eventType.questions.map((q) => {
          const key = `answers.${q.id}`;
          return (
            <QuestionField
              key={q.id}
              question={q}
              value={values.answers[q.id]}
              error={errorOf(key)}
              onChange={(v) => {
                onChange({ answers: { ...values.answers, [q.id]: v } });
                clear(key);
              }}
              onBlur={() => {
                const v = values.answers[q.id];
                if (v !== undefined && v !== '') setError(key, validateAnswer(q, v));
              }}
            />
          );
        })}

        {eventType.allowGuests && eventType.maxGuests > 0 ? (
          values.guestsOpen || values.guests.length ? (
            <Field label="Guests" optional error={errorOf('guests')} hint={`Up to ${eventType.maxGuests}. Each guest gets the invitation too.`}>
              <GuestsField
                value={values.guests}
                max={eventType.maxGuests}
                ownEmail={values.email}
                onChange={(guests) => {
                  onChange({ guests });
                  clear('guests');
                }}
                onProblem={(message) => setError('guests', message)}
              />
            </Field>
          ) : (
            <button type="button" className="bw-addguests" onClick={() => onChange({ guestsOpen: true })}>
              <UserPlus size={16} aria-hidden="true" />
              <span>Add guests</span>
            </button>
          )
        ) : null}

        {/* Honeypot: hidden from people and assistive tech, tempting for bots. */}
        <div className="bw-hp" aria-hidden="true">
          <label htmlFor={honeypotId}>Website</label>
          <input id={honeypotId} type="text" name="website" tabIndex={-1} autoComplete="off" value={values.website} onChange={(e) => onChange({ website: e.target.value })} />
        </div>
      </div>

      {notice ? (
        <div className="bw-notice bw-notice--error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div className="bw-notice__body">
            <p className="bw-notice__title">{notice.title}</p>
            {notice.message ? <p className="bw-notice__text">{notice.message}</p> : null}
            {notice.action ? <div className="bw-notice__action">{notice.action}</div> : null}
          </div>
        </div>
      ) : null}

      <div className="bw-form__submit">
        <Button type="submit" variant="primary" size="lg" block loading={busy} loadingLabel="Booking your time">
          {ctaLabel}
        </Button>
        {isWebUrl(site.booking.privacyUrl) ? (
          <p className="bw-form__fine">
            Your details are only used to arrange this meeting.{' '}
            <a href={site.booking.privacyUrl} target="_blank" rel="noopener noreferrer">
              Privacy policy
            </a>
          </p>
        ) : (
          <p className="bw-form__fine">Your details are only used to arrange this meeting.</p>
        )}
      </div>
    </form>
  );
}
