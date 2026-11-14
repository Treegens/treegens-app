/**
 * Settings: who you are on the booking page, how the AI assistant sounds and when it may
 * call, the defaults of the booking form, the email identity, and the dashboard password.
 * One draft with a save bar for everything except the password, which has its own button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Plus, Quote, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DEFAULT_CONSENT_TEXT } from '../../../shared/defaults';
import type { AssistantSettings, SiteSettings } from '../../../shared/types';
import { ApiFailure, changePassword, errorMessage, saveSite } from '../../lib/api';
import { Button, Field, IconButton, Input, Select, Switch, Textarea, useToast } from '../../ui';
import { FieldGroup, Notice, Page, PageHeader, SaveBar, Section } from '../components/Page';
import { useUnsavedGuard } from '../components/UnsavedGuard';
import { ImageField } from '../components/x/bits';
import { firstName, sameJson } from '../format';
import { useAdmin } from '../state';
import '../../styles/adminx.css';

type AssistantDraft = Omit<AssistantSettings, 'model'>;

interface Draft {
  profile: SiteSettings['profile'];
  assistant: AssistantDraft;
  booking: { reminderOptInDefault: boolean; consentText: string; privacyUrl: string };
  email: { fromName: string; replyTo: string };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LINKS = 6;

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'es-MX', label: 'Spanish (Mexico)' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'nl-NL', label: 'Dutch' },
];

function toDraft(site: SiteSettings): Draft {
  const { model: _model, ...assistant } = site.assistant;
  void _model;
  return {
    profile: { ...site.profile, avatarAssetId: site.profile.avatarAssetId ?? null, links: site.profile.links.map((l) => ({ ...l })) },
    assistant,
    booking: { reminderOptInDefault: site.booking.reminderOptInDefault, consentText: site.booking.consentText, privacyUrl: site.booking.privacyUrl ?? '' },
    email: { fromName: site.email.fromName, replyTo: site.email.replyTo },
  };
}

function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** "jimicohen.com" → "https://jimicohen.com": people rarely type the scheme. */
function withScheme(url: string): string {
  const u = url.trim();
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return `https://${u.replace(/^\/+/, '')}`;
}

function hourLabel(hour: number): string {
  if (hour === 24) return 'Midnight';
  const d = new Date(Date.UTC(2026, 0, 1, hour, 0));
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
}

/** First problem that blocks saving, in words. */
function problemOf(d: Draft): string | null {
  if (!d.profile.name.trim()) return 'Your name cannot be empty.';
  for (const l of d.profile.links) {
    const label = l.label.trim();
    const url = l.url.trim();
    if (!label && !url) continue;
    if (!label) return 'Give every link a label.';
    if (!isWebUrl(url)) return `The link "${label}" needs a full address that starts with https://`;
  }
  if (!d.assistant.name.trim()) return 'Your assistant needs a name.';
  if (!d.assistant.voice.trim()) return 'Choose a voice for your assistant.';
  if (d.assistant.callWindowStartHour >= d.assistant.callWindowEndHour) return 'Calls must start before they end.';
  if (!d.booking.consentText.trim()) return 'The consent wording cannot be empty.';
  if (d.booking.privacyUrl.trim() && !/^https:\/\//i.test(d.booking.privacyUrl.trim())) return 'The privacy link must start with https://';
  if (d.email.replyTo.trim() && !EMAIL.test(d.email.replyTo.trim())) return 'The reply-to address is not a full email address.';
  return null;
}

function PasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const f: Record<string, string> = {};
    if (!current) f.current = 'Enter your current password.';
    if (next.length < 10) f.next = 'Use at least 10 characters.';
    else if (next === current) f.next = 'Choose a password you are not using now.';
    if (again !== next) f.again = 'The two new passwords do not match.';
    setFields(f);
    setError(null);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      toast.success('Password changed', 'Other devices will be asked to sign in again.');
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      if (failure?.fields && Object.keys(failure.fields).length) setFields(failure.fields);
      else if (failure?.status === 401 || failure?.status === 403) setFields({ current: 'That is not your current password.' });
      else setError(errorMessage(err, 'Your password could not be changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="st-password" onSubmit={submit} noValidate>
      <Field label="Current password" error={fields.current} className="adm-w-lg">
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <div className="adm-grid2">
        <Field label="New password" error={fields.next} hint={fields.next ? undefined : 'At least 10 characters. A few random words work well.'}>
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="New password, once more" error={fields.again}>
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
      </div>
      {error ? (
        <Notice tone="danger" title="Not changed">
          {error}
        </Notice>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" iconLeft={<KeyRound size={15} />} loading={busy} loadingLabel="Changing" disabled={!current && !next && !again}>
          Change password
        </Button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { data, setData, refresh, ownerHost } = useAdmin();
  const toast = useToast();
  const latest = useRef(data);
  latest.current = data;

  const base = useMemo(() => toDraft(data.site), [data.site]);
  const [draft, setDraft] = useState<Draft>(base);
  const [saving, setSaving] = useState(false);
  const [serverProblem, setServerProblem] = useState<string | null>(null);
  /** preview of an avatar uploaded in this session, by asset id */
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const baseRef = useRef(base);

  // When the site changes underneath (another page saved, a refresh), follow it unless there are edits.
  useEffect(() => {
    setDraft((prev) => (sameJson(prev, baseRef.current) ? base : prev));
    baseRef.current = base;
  }, [base]);

  const dirty = !sameJson(draft, base);
  useUnsavedGuard(dirty);
  const problem = dirty ? (problemOf(draft) ?? serverProblem) : null;

  const set = <K extends keyof Draft>(key: K, patch: Partial<Draft[K]>) => {
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
    setServerProblem(null);
  };

  const voices = data.voiceOptions ?? [];
  const voiceKnown = voices.some((v) => v.id === draft.assistant.voice);
  const [customVoice, setCustomVoice] = useState(() => voices.length > 0 && !voices.some((v) => v.id === base.assistant.voice));
  const showCustomVoice = voices.length === 0 || customVoice || !voiceKnown;
  const languageKnown = LANGUAGES.some((l) => l.value === draft.assistant.language);

  const avatarId = draft.profile.avatarAssetId ?? null;
  const avatarUrl = avatarId ? (avatarUrls[avatarId] ?? (avatarId === (data.site.profile.avatarAssetId ?? null) ? ownerHost.avatarUrl : null)) : null;

  const links = draft.profile.links;
  const setLink = (i: number, patch: Partial<{ label: string; url: string }>) => set('profile', { links: links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  const save = async () => {
    if (saving || problem) return;
    setSaving(true);
    setServerProblem(null);
    try {
      const cleanLinks = draft.profile.links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.label && l.url);
      const avatarChanged = (draft.profile.avatarAssetId ?? null) !== (data.site.profile.avatarAssetId ?? null);
      const site = await saveSite({
        profile: { ...draft.profile, name: draft.profile.name.trim(), headline: draft.profile.headline.trim(), welcome: draft.profile.welcome.trim(), links: cleanLinks },
        assistant: { ...draft.assistant, name: draft.assistant.name.trim(), voice: draft.assistant.voice.trim(), persona: draft.assistant.persona.trim() },
        booking: { ...draft.booking, consentText: draft.booking.consentText.trim(), privacyUrl: draft.booking.privacyUrl.trim() },
        email: { fromName: draft.email.fromName.trim(), replyTo: draft.email.replyTo.trim() },
      });
      setData({ ...latest.current, site });
      baseRef.current = draft; // lets the effect above adopt what the server stored
      if (avatarChanged) await refresh().catch(() => undefined);
      toast.success('Settings saved');
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : null;
      const message = failure?.fields ? Object.values(failure.fields)[0] : errorMessage(e, 'Your settings could not be saved.');
      setServerProblem(message);
      toast.error('Your settings were not saved', message);
    } finally {
      setSaving(false);
    }
  };

  const owner = firstName(draft.profile.name || 'you');
  const assistantName = draft.assistant.name.trim() || 'Your assistant';

  return (
    <Page>
      <PageHeader title="Settings" description="Your profile, your assistant and the details of the booking form." />

      <Section title="Profile" description="How you appear at the top of your booking page and in emails.">
        <ImageField
          label="Photo"
          shape="round"
          purpose="avatar"
          url={avatarUrl}
          hint="A square photo of your face works best. Up to 3 MB."
          uploadLabel={avatarUrl ? 'Change photo' : 'Upload a photo'}
          onUploaded={(asset) => {
            setAvatarUrls((prev) => ({ ...prev, [asset.id]: asset.dataUrl || asset.url }));
            set('profile', { avatarAssetId: asset.id });
          }}
          onRemove={() => set('profile', { avatarAssetId: null })}
        />
        <Field label="Name" required>
          <Input value={draft.profile.name} maxLength={80} autoComplete="name" onChange={(e) => set('profile', { name: e.target.value })} />
        </Field>
        <Field label="Headline" hint="The big line on your page.">
          <Input value={draft.profile.headline} maxLength={120} placeholder={`Book time with ${owner}`} onChange={(e) => set('profile', { headline: e.target.value })} />
        </Field>
        <Field label="Welcome message" hint="One or two sentences under the headline.">
          <Textarea value={draft.profile.welcome} rows={3} maxLength={600} autoGrow onChange={(e) => set('profile', { welcome: e.target.value })} />
        </Field>
        <FieldGroup
          label="Links"
          optional
          hint={links.length >= MAX_LINKS ? `You can show up to ${MAX_LINKS} links.` : 'Shown as small buttons under your welcome message: your site, LinkedIn, a portfolio.'}
        >
          {links.length ? (
            <ul role="list" className="st-links">
              {links.map((l, i) => (
                <li key={i} className="st-link">
                  <Input aria-label={`Link ${i + 1}, label`} value={l.label} maxLength={40} placeholder="Website" wrapperClassName="st-link__label" onChange={(e) => setLink(i, { label: e.target.value })} />
                  <Input
                    aria-label={`Link ${i + 1}, address`}
                    type="url"
                    inputMode="url"
                    value={l.url}
                    maxLength={300}
                    placeholder="https://"
                    invalid={l.url.trim() !== '' && !isWebUrl(l.url.trim())}
                    wrapperClassName="st-link__url"
                    onChange={(e) => setLink(i, { url: e.target.value })}
                    onBlur={() => l.url.trim() && withScheme(l.url) !== l.url && setLink(i, { url: withScheme(l.url) })}
                  />
                  <IconButton label={`Remove link ${i + 1}`} icon={<Trash2 size={16} />} onClick={() => set('profile', { links: links.filter((_, j) => j !== i) })} />
                </li>
              ))}
            </ul>
          ) : null}
          {links.length < MAX_LINKS ? (
            <div>
              <Button size="sm" variant="secondary" iconLeft={<Plus size={15} />} onClick={() => set('profile', { links: [...links, { label: '', url: '' }] })}>
                Add a link
              </Button>
            </div>
          ) : null}
        </FieldGroup>
      </Section>

      <Section
        title="AI assistant"
        description={`${assistantName} phones people who left a number and agreed to a reminder call, to confirm they are coming or send them a link to reschedule.`}
        aside={
          <p className="st-aside">
            The key and model that power the conversation are under{' '}
            <Link className="adm-textlink" to="/admin/integrations#assistant">
              Integrations
            </Link>
            .
          </p>
        }
      >
        <div className="adm-grid2">
          <Field label="Name" hint="Said at the start of every call.">
            <Input value={draft.assistant.name} maxLength={40} onChange={(e) => set('assistant', { name: e.target.value })} />
          </Field>
          <Field label="Language">
            <Select
              value={draft.assistant.language}
              onChange={(e) => set('assistant', { language: e.target.value })}
              options={languageKnown ? LANGUAGES : [...LANGUAGES, { value: draft.assistant.language, label: draft.assistant.language }]}
            />
          </Field>
        </div>
        <Field label="Voice" hint={showCustomVoice && voices.length ? 'Type the exact name of a Twilio voice, for example Polly.Joanna-Neural.' : undefined}>
          <div className="st-voice">
            {voices.length ? (
              <Select
                aria-label="Voice"
                value={customVoice || !voiceKnown ? '__custom' : draft.assistant.voice}
                onChange={(e) => {
                  if (e.target.value === '__custom') setCustomVoice(true);
                  else {
                    setCustomVoice(false);
                    set('assistant', { voice: e.target.value });
                  }
                }}
                options={[...voices.map((v) => ({ value: v.id, label: v.label })), { value: '__custom', label: 'Another voice' }]}
              />
            ) : null}
            {showCustomVoice ? (
              <Input aria-label="Voice name" value={draft.assistant.voice} spellCheck={false} autoCapitalize="off" maxLength={80} placeholder="Polly.Joanna-Neural" onChange={(e) => set('assistant', { voice: e.target.value })} />
            ) : null}
          </div>
        </Field>
        <Field label="Personality" hint="A sentence or two about tone. The assistant always says it is an AI and stays on the subject of the meeting.">
          <Textarea value={draft.assistant.persona} rows={3} maxLength={500} autoGrow onChange={(e) => set('assistant', { persona: e.target.value })} />
        </Field>
        <FieldGroup label="Calling hours" hint="In the time zone of the person being called, so nobody is phoned at night. A reminder that falls outside these hours is skipped.">
          <div className="st-hours">
            <Select
              aria-label="Earliest call"
              wrapperClassName="st-hours__select"
              value={String(draft.assistant.callWindowStartHour)}
              onChange={(e) => set('assistant', { callWindowStartHour: Number(e.target.value) })}
              options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))}
            />
            <span className="st-hours__to">to</span>
            <Select
              aria-label="Latest call"
              wrapperClassName="st-hours__select"
              value={String(draft.assistant.callWindowEndHour)}
              invalid={draft.assistant.callWindowStartHour >= draft.assistant.callWindowEndHour}
              onChange={(e) => set('assistant', { callWindowEndHour: Number(e.target.value) })}
              options={Array.from({ length: 24 }, (_, i) => ({ value: String(i + 1), label: hourLabel(i + 1) }))}
            />
          </div>
        </FieldGroup>
        <figure className="st-script">
          <Quote size={16} aria-hidden="true" className="st-script__icon" />
          <blockquote>
            Hi Sam, this is {assistantName}, an AI assistant calling for {owner}. A quick reminder about your meeting tomorrow at 10:00 AM your time. Are you still able to make it?
          </blockquote>
          <figcaption>How every reminder call begins.</figcaption>
        </figure>
      </Section>

      <Section title="Booking form" description="What people see when they add a phone number, and what they agree to.">
        <Switch
          labelSide="start"
          checked={draft.booking.reminderOptInDefault}
          onChange={(reminderOptInDefault) => set('booking', { reminderOptInDefault })}
          label="Start with reminders switched on"
          description="When someone types a phone number, the text and call reminders are already ticked. They can untick them."
        />
        <Field
          label="Consent wording"
          hint={
            <>
              Shown under the phone field. <code className="st-code">{'{{host_first_name}}'}</code> becomes your first name.
            </>
          }
          action={
            draft.booking.consentText.trim() !== DEFAULT_CONSENT_TEXT ? (
              <button type="button" className="adm-textbtn" onClick={() => set('booking', { consentText: DEFAULT_CONSENT_TEXT })}>
                Use the standard wording
              </button>
            ) : undefined
          }
        >
          <Textarea value={draft.booking.consentText} rows={3} maxLength={600} autoGrow onChange={(e) => set('booking', { consentText: e.target.value })} />
        </Field>
        <Field label="Privacy policy link" optional hint="Shown in the footer of your booking pages.">
          <Input
            type="url"
            inputMode="url"
            value={draft.booking.privacyUrl}
            maxLength={300}
            placeholder="https://"
            onChange={(e) => set('booking', { privacyUrl: e.target.value })}
            onBlur={() => draft.booking.privacyUrl.trim() && withScheme(draft.booking.privacyUrl) !== draft.booking.privacyUrl && set('booking', { privacyUrl: withScheme(draft.booking.privacyUrl) })}
          />
        </Field>
      </Section>

      <Section
        title="Email identity"
        description="Whose name is on confirmations and reminders, and where replies go."
        aside={
          <p className="st-aside">
            How emails are sent is under{' '}
            <Link className="adm-textlink" to="/admin/integrations#email">
              Integrations
            </Link>
            .
          </p>
        }
      >
        <div className="adm-grid2">
          <Field label="Sender name">
            <Input value={draft.email.fromName} maxLength={80} placeholder={draft.profile.name} onChange={(e) => set('email', { fromName: e.target.value })} />
          </Field>
          <Field label="Replies go to" optional hint={ownerHost.email ? `Leave empty to use ${ownerHost.email}.` : undefined}>
            <Input type="email" inputMode="email" value={draft.email.replyTo} maxLength={254} placeholder={ownerHost.email || 'you@example.com'} onChange={(e) => set('email', { replyTo: e.target.value })} />
          </Field>
        </div>
      </Section>

      <Section title="Password" description="The password for this dashboard. Changing it signs out every other device.">
        <PasswordForm />
      </Section>

      <SaveBar dirty={dirty} saving={saving} problem={problem} saveLabel="Save settings" onSave={() => void save()} onDiscard={() => setDraft(base)} />
    </Page>
  );
}
