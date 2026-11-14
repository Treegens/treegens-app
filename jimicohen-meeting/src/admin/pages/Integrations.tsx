/**
 * Integrations: Google Calendar, email sending, Twilio (texts and reminder calls) and the
 * Anthropic key for the voice assistant. Written for someone who is not a developer: every
 * card has a status, numbered steps in plain words, copy buttons for anything that must be
 * pasted elsewhere, and a test whose answer shows up right next to the button.
 *
 * Keys are write-only. Inputs are never pre-filled, the server only tells us "saved" (and a
 * masked hint), and only what is typed here is ever sent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bot, CalendarCheck, Check, ChevronRight, CircleCheck, Mail, MessageSquareText, PhoneCall, RefreshCw, Send, Unplug } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { AdminHost, GoogleCalendarListItem, IntegrationsStatus, IntegrationsUpdate, SiteSettings } from '../../../shared/types';
import { APP_BASE, ApiFailure, disconnectGoogle, errorMessage, getHostCalendars, googleConnectUrl, saveIntegrations, saveSite, updateHost } from '../../lib/api';
import { Button, Checkbox, ConfirmDialog, Field, Input, RadioGroup, Select, Skeleton, useToast } from '../../ui';
import { Notice, Page, PageHeader } from '../components/Page';
import { IntegrationCard, IxBlock, useIntegrationTest } from '../components/x/IntegrationCard';
import type { IntegrationStatus } from '../components/x/IntegrationCard';
import { CopyField, Ext, SecretField, Step, Steps, TestResult } from '../components/x/bits';
import { firstName } from '../format';
import { useAdmin } from '../state';
import '../../styles/adminx.css';

type CardId = 'google' | 'email' | 'twilio' | 'assistant';
const CARD_IDS: CardId[] = ['google', 'email', 'twilio', 'assistant'];

const MODELS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (quicker replies, lower cost)' },
];

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanPhone(input: string): string {
  return input.replace(/[\s().-]/g, '');
}

function googleReason(reason: string | null): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Google did not finish connecting. Please try again.';
  if (r === 'access_denied') return 'The Google screen was closed before access was allowed. Press Connect to try again.';
  if (r === 'no_refresh_token') return 'Google did not return a long-lived token. Remove this app at myaccount.google.com/permissions, then connect again.';
  return r.slice(0, 240);
}

/** Shared helpers for the four cards. */
function useApply() {
  const { data, setData } = useAdmin();
  const latest = useRef(data);
  latest.current = data;
  return useMemo(
    () => ({
      integrations: (integrations: IntegrationsStatus) => setData({ ...latest.current, integrations }),
      site: (site: SiteSettings) => setData({ ...latest.current, site }),
      host: (host: AdminHost) => setData({ ...latest.current, hosts: latest.current.hosts.map((h) => (h.id === host.id ? host : h)) }),
    }),
    [setData],
  );
}

interface CardProps {
  open: boolean;
  onToggle: () => void;
}

// ═════════════════════════════ Google Calendar ═════════════════════════════

function GoogleCard({ open, onToggle }: CardProps) {
  const { data, refresh, ownerHost } = useAdmin();
  const apply = useApply();
  const toast = useToast();
  const g = data.integrations.google;
  const hostGoogle = ownerHost.google;
  const needsReconnect = hostGoogle?.status === 'needs_reconnect';
  const connected = g.ownerConnected && !!hostGoogle && !needsReconnect;

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [calendars, setCalendars] = useState<GoogleCalendarListItem[] | null>(null);
  const [calError, setCalError] = useState<string | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmRemoveKeys, setConfirmRemoveKeys] = useState(false);
  const [test, runTest] = useIntegrationTest();

  const status: IntegrationStatus = connected
    ? { tone: 'success', label: 'Connected' }
    : needsReconnect
      ? { tone: 'warning', label: 'Needs reconnecting' }
      : g.configured
        ? { tone: 'warning', label: 'Keys saved, not connected' }
        : { tone: 'neutral', label: 'Not set up' };

  const hostId = ownerHost.id;
  useEffect(() => {
    if (!open || !connected) return;
    const controller = new AbortController();
    setCalError(null);
    getHostCalendars(hostId, { signal: controller.signal }).then(
      (list) => setCalendars(list),
      (e: unknown) => {
        if (!controller.signal.aborted) setCalError(errorMessage(e, 'Your calendars could not be loaded.'));
      },
    );
    return () => controller.abort();
  }, [open, connected, hostId]);

  const idLooksOff = clientId.trim() !== '' && !/\.apps\.googleusercontent\.com$/.test(clientId.trim());
  const canSaveKeys = g.configured ? clientId.trim() !== '' || clientSecret.trim() !== '' : clientId.trim() !== '' && clientSecret.trim() !== '';

  const saveKeys = async () => {
    if (!canSaveKeys || saving) return;
    setSaving(true);
    setError(null);
    try {
      const update: IntegrationsUpdate = { google: {} };
      if (clientId.trim()) update.google!.clientId = clientId.trim();
      if (clientSecret.trim()) update.google!.clientSecret = clientSecret.trim();
      apply.integrations(await saveIntegrations(update));
      setClientId('');
      setClientSecret('');
      toast.success('Google keys saved', 'One step left: connect your calendar.');
    } catch (e) {
      setError(errorMessage(e, 'The keys could not be saved. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const removeKeys = async () => {
    try {
      apply.integrations(await saveIntegrations({ google: { clientId: '', clientSecret: '' } }));
      toast.success('Google keys removed');
    } catch (e) {
      toast.error('The keys were not removed', errorMessage(e));
      throw e;
    }
  };

  const connect = (gmail = false) => {
    window.location.assign(googleConnectUrl({ hostId: ownerHost.id, returnTo: `${APP_BASE}/admin/integrations`, gmail: gmail || !!hostGoogle?.gmailSend }));
  };

  const disconnect = async () => {
    try {
      await disconnectGoogle(ownerHost.id);
      await refresh();
      setCalendars(null);
      toast.success('Google Calendar disconnected', 'Bookings will no longer be added to your calendar.');
    } catch (e) {
      toast.error('Could not disconnect', errorMessage(e));
      throw e;
    }
  };

  const saveCalendars = async (update: { busyCalendarIds?: string[]; writeCalendarId?: string }) => {
    if (calBusy) return;
    setCalBusy(true);
    try {
      apply.host(await updateHost(ownerHost.id, update));
    } catch (e) {
      toast.error('Your calendar choice was not saved', errorMessage(e));
    } finally {
      setCalBusy(false);
    }
  };

  const busyIds = hostGoogle?.busyCalendarIds ?? [];
  const writable = (calendars ?? []).filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer');
  const stepsVisible = !connected || showSteps;

  const keyFields = (
    <div className="ix-form">
      <Field label="Client ID" hint={idLooksOff ? undefined : 'Ends with .apps.googleusercontent.com'} error={idLooksOff ? 'This does not look like a client ID. It should end with .apps.googleusercontent.com' : undefined}>
        <SecretField plain saved={g.configured} masked={g.clientIdMasked} value={clientId} onChange={setClientId} placeholder="1234567890-abc123.apps.googleusercontent.com" />
      </Field>
      <Field label="Client secret">
        <SecretField saved={g.configured} value={clientSecret} onChange={setClientSecret} placeholder="GOCSPX-..." onClear={g.configured ? () => setConfirmRemoveKeys(true) : undefined} />
      </Field>
      {error ? (
        <Notice tone="danger" title="The keys were not saved">
          {error}
        </Notice>
      ) : null}
      <div className="ix-actions">
        <Button variant={g.configured ? 'secondary' : 'primary'} disabled={!canSaveKeys || idLooksOff} loading={saving} loadingLabel="Saving" onClick={() => void saveKeys()}>
          Save keys
        </Button>
      </div>
    </div>
  );

  return (
    <IntegrationCard
      id="google"
      icon={<CalendarCheck size={20} />}
      title="Google Calendar"
      description="Checks when you are busy and puts every booking on your calendar, with a Meet link."
      status={status}
      open={open}
      onToggle={onToggle}
    >
      {connected && hostGoogle ? (
        <>
          <div className="ix-connected">
            <span className="ix-connected__icon" aria-hidden="true">
              <CircleCheck size={18} />
            </span>
            <div className="ix-connected__text">
              <p className="ix-connected__title">Connected as {hostGoogle.email}</p>
              <p className="ix-connected__desc">Bookings are added to this account. Your busy times there are never offered.</p>
            </div>
            <div className="ix-connected__actions">
              <Button size="sm" variant="secondary" iconLeft={<RefreshCw size={14} />} loading={test.status === 'running'} loadingLabel="Checking" onClick={() => void runTest({ channel: 'google' })}>
                Check connection
              </Button>
              <Button size="sm" variant="ghost" iconLeft={<Unplug size={14} />} onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            </div>
          </div>
          <TestResult state={test} />

          <IxBlock title="Calendars to check for conflicts">
            {calError ? (
              <Notice tone="danger">{calError}</Notice>
            ) : !calendars ? (
              <div className="ix-callist" aria-busy="true">
                <Skeleton height={20} width="56%" />
                <Skeleton height={20} width="40%" />
                <Skeleton height={20} width="48%" />
              </div>
            ) : (
              <>
                <ul role="list" className="ix-callist">
                  {calendars.map((c) => (
                    <li key={c.id}>
                      <Checkbox
                        checked={busyIds.includes(c.id) || (c.primary && busyIds.includes('primary'))}
                        disabled={calBusy}
                        onChange={(on) => {
                          const id = c.primary && busyIds.includes('primary') ? 'primary' : c.id;
                          const next = on ? [...busyIds, c.id] : busyIds.filter((x) => x !== id && x !== c.id);
                          void saveCalendars({ busyCalendarIds: next });
                        }}
                        label={
                          <span className="ix-cal">
                            <span className="ix-cal__dot" style={{ background: c.backgroundColor || 'var(--a-faint)' }} aria-hidden="true" />
                            <span className="ix-cal__name">{c.summary}</span>
                            {c.primary ? <span className="ix-cal__tag">Main</span> : null}
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
                {busyIds.length === 0 ? (
                  <Notice tone="warning">No calendar is checked, so people could book over your other plans. Tick at least one.</Notice>
                ) : null}
                <Field label="Add new meetings to" className="ix-narrow">
                  <Select
                    value={writable.some((c) => c.id === hostGoogle.writeCalendarId) ? hostGoogle.writeCalendarId : (writable.find((c) => c.primary)?.id ?? hostGoogle.writeCalendarId)}
                    disabled={calBusy}
                    onChange={(e) => void saveCalendars({ writeCalendarId: e.target.value })}
                    options={(writable.length ? writable : [{ id: hostGoogle.writeCalendarId, summary: hostGoogle.email, primary: true, accessRole: 'owner' }]).map((c) => ({ value: c.id, label: c.primary ? `${c.summary} (main)` : c.summary }))}
                  />
                </Field>
              </>
            )}
          </IxBlock>

          <button type="button" className="ix-toggle" aria-expanded={showSteps} onClick={() => setShowSteps((v) => !v)}>
            <ChevronRight size={15} aria-hidden="true" />
            {showSteps ? 'Hide the setup steps and keys' : 'Show the setup steps and keys'}
          </button>
        </>
      ) : null}

      {needsReconnect ? (
        <Notice tone="warning" title="Google asked us to sign in again" action={<Button size="sm" variant="primary" onClick={() => connect()}>Reconnect</Button>}>
          New bookings are not reaching your calendar right now. Reconnecting takes a few seconds. If this keeps happening, check step 3 below: the app must be published.
        </Notice>
      ) : null}

      {stepsVisible ? (
        <>
          {!g.configured ? (
            <p className="ix-lead">
              Google asks every site that reads a calendar to register itself once. It is free and takes about five minutes. You do this in Google Cloud, with the Google account that owns your calendar.
            </p>
          ) : null}
          <Steps>
            <Step title="Create a project in Google Cloud" done={g.configured}>
              <p>
                Open <Ext href="https://console.cloud.google.com/projectcreate">Google Cloud, New project</Ext> and create one. Any name works, for example "Meetings".
              </p>
            </Step>
            <Step title="Switch on the Calendar API" done={g.configured}>
              <p>
                Open <Ext href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</Ext> and press <strong>Enable</strong>. If you want reminder emails to come from your Gmail address, also enable the{' '}
                <Ext href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</Ext>.
              </p>
            </Step>
            <Step title="Fill in the consent screen, then publish it" done={g.configured}>
              <p>
                Open <Ext href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Ext>, press <strong>Get started</strong>, choose <strong>External</strong> and finish the short form. Then open <strong>Audience</strong> and press{' '}
                <strong>Publish app</strong>, so the status reads "In production".
              </p>
              <Notice tone="warning" title="Do not skip publishing">
                While the app is in "Testing", Google ends the connection after 7 days and bookings stop reaching your calendar.
              </Notice>
              <p>When you connect, Google may say the app is not verified. That is normal for an app only you use: choose Advanced, then continue.</p>
            </Step>
            <Step title="Create the sign-in client" done={g.configured}>
              <p>
                Open <Ext href="https://console.cloud.google.com/auth/clients">Clients</Ext>, press <strong>Create client</strong> and choose <strong>Web application</strong>. Under "Authorised redirect URIs" add this exact address:
              </p>
              <CopyField value={g.redirectUri} label="Redirect address for Google" copyLabel="Copy" />
            </Step>
            <Step title="Paste the two keys Google shows you" done={g.configured}>
              {keyFields}
            </Step>
            <Step title="Connect your calendar" done={connected}>
              {connected ? (
                <p>Done. You are connected as {hostGoogle?.email}.</p>
              ) : (
                <>
                  <p>{g.configured ? 'You will be taken to Google to allow access, then brought straight back here.' : 'Save the two keys first, then this button wakes up.'}</p>
                  <div className="ix-actions">
                    <Button variant="primary" disabled={!g.configured} iconLeft={<CalendarCheck size={16} />} onClick={() => connect()}>
                      {needsReconnect ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
                    </Button>
                  </div>
                </>
              )}
            </Step>
          </Steps>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={disconnect}
        tone="danger"
        title="Disconnect Google Calendar?"
        description="Your busy times will no longer be checked and new bookings will not be added to your calendar. Meetings already booked stay where they are."
        confirmLabel="Disconnect"
      />
      <ConfirmDialog
        open={confirmRemoveKeys}
        onClose={() => setConfirmRemoveKeys(false)}
        onConfirm={removeKeys}
        tone="danger"
        title="Remove the Google keys?"
        description="Nobody on your team will be able to connect or reconnect a Google Calendar until you add keys again."
        confirmLabel="Remove keys"
      />
    </IntegrationCard>
  );
}

// ═════════════════════════════ Email ═════════════════════════════

type Provider = SiteSettings['email']['provider'];

function EmailCard({ open, onToggle }: CardProps) {
  const { data, refresh, ownerHost } = useAdmin();
  const apply = useApply();
  const toast = useToast();
  const email = data.integrations.email;
  const google = data.integrations.google;
  const site = data.site;

  const [provider, setProvider] = useState<Provider>(site.email.provider);
  const [fromEmail, setFromEmail] = useState(site.email.fromEmail);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [to, setTo] = useState(ownerHost.email || site.email.replyTo || '');
  const [test, runTest] = useIntegrationTest();

  useEffect(() => {
    setProvider(site.email.provider);
    setFromEmail(site.email.fromEmail);
  }, [site.email.provider, site.email.fromEmail]);

  const status: IntegrationStatus =
    email.resolved === 'resend'
      ? { tone: 'success', label: 'Sending with Resend' }
      : email.resolved === 'gmail'
        ? { tone: 'success', label: 'Sending from Gmail' }
        : site.email.provider === 'none'
          ? { tone: 'neutral', label: 'Turned off' }
          : { tone: 'warning', label: 'Not sending yet' };

  const fromInvalid = fromEmail.trim() !== '' && !EMAIL.test(fromEmail.trim());
  const dirty = provider !== site.email.provider || fromEmail.trim() !== site.email.fromEmail || key.trim() !== '';
  const showResend = provider === 'resend' || provider === 'auto';
  const showGmail = provider === 'gmail' || provider === 'auto';

  const save = async () => {
    if (!dirty || saving || fromInvalid) return;
    setSaving(true);
    setError(null);
    try {
      if (key.trim()) await saveIntegrations({ resend: { apiKey: key.trim() } });
      if (provider !== site.email.provider || fromEmail.trim() !== site.email.fromEmail) await saveSite({ email: { provider, fromEmail: fromEmail.trim() } });
      setKey('');
      await refresh();
      toast.success('Email settings saved');
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : null;
      setError(failure?.fields ? Object.values(failure.fields)[0] : errorMessage(e, 'Your email settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      apply.integrations(await saveIntegrations({ resend: { apiKey: '' } }));
      await refresh();
      toast.success('Resend key removed');
    } catch (e) {
      toast.error('The key was not removed', errorMessage(e));
      throw e;
    }
  };

  const allowGmail = () => {
    window.location.assign(googleConnectUrl({ hostId: ownerHost.id, returnTo: `${APP_BASE}/admin/integrations`, gmail: true }));
  };

  return (
    <IntegrationCard id="email" icon={<Mail size={20} />} title="Email" description="Confirmations, reminders and follow-ups by email." status={status} open={open} onToggle={onToggle}>
      <RadioGroup<Provider>
        label="How should emails be sent?"
        value={provider}
        onChange={setProvider}
        options={[
          { value: 'auto', label: 'Choose for me', description: 'Uses Resend when a key is saved, otherwise your Gmail.' },
          { value: 'resend', label: 'Resend', description: 'A sending service. Best deliverability, from an address at your own domain.' },
          { value: 'gmail', label: 'My Gmail', description: 'Sends from the Google account you connected. Nothing else to set up.' },
          { value: 'none', label: 'Do not send emails', description: 'People still get the calendar invitation from Google.' },
        ]}
      />

      {showGmail ? (
        <IxBlock title="Gmail">
          {email.gmailAvailable ? (
            <p className="ix-ok">
              <Check size={15} aria-hidden="true" />
              <span>Allowed. Emails go out as {google.ownerEmail ?? 'your Google account'}.</span>
            </p>
          ) : google.ownerConnected ? (
            <>
              <p className="ix-text">Your calendar is connected, but sending email needs one more permission from Google. Make sure the Gmail API is enabled (step 2 under Google Calendar).</p>
              <div className="ix-actions">
                <Button variant="secondary" iconLeft={<Mail size={15} />} onClick={allowGmail}>
                  Allow sending from Gmail
                </Button>
              </div>
            </>
          ) : (
            <p className="ix-text">
              Connect Google Calendar first, in the card above. Then come back here to allow sending from the same account.
            </p>
          )}
        </IxBlock>
      ) : null}

      {showResend ? (
        <IxBlock title="Resend">
          <Steps>
            <Step title="Create a Resend account" done={email.resendConfigured}>
              <p>
                Sign up at <Ext href="https://resend.com/signup">resend.com</Ext>. The free plan is enough for a personal booking page.
              </p>
            </Step>
            <Step title="Add your domain" done={email.resendConfigured}>
              <p>
                Under <Ext href="https://resend.com/domains">Domains</Ext>, add the domain you want to send from and copy the records it shows into your domain's DNS settings. Wait until it says Verified.
              </p>
            </Step>
            <Step title="Create an API key and paste it here" done={email.resendConfigured}>
              <p>
                Under <Ext href="https://resend.com/api-keys">API Keys</Ext> press Create. "Sending access" is all it needs.
              </p>
              <Field label="Resend API key">
                <SecretField saved={email.resendConfigured} value={key} onChange={setKey} placeholder="re_..." onClear={email.resendConfigured ? () => setConfirmRemove(true) : undefined} />
              </Field>
            </Step>
            <Step title="Choose the address emails come from" done={email.resendConfigured && !!site.email.fromEmail}>
              <Field label="From address" hint="An address at the domain you verified, for example meetings@yourdomain.com." error={fromInvalid ? 'Please enter a full email address.' : undefined}>
                <Input type="email" inputMode="email" autoComplete="off" value={fromEmail} placeholder="meetings@yourdomain.com" onChange={(e) => setFromEmail(e.target.value)} />
              </Field>
            </Step>
          </Steps>
        </IxBlock>
      ) : null}

      {error ? (
        <Notice tone="danger" title="Not saved">
          {error}
        </Notice>
      ) : null}
      <div className="ix-actions">
        <Button variant="primary" disabled={!dirty || fromInvalid} loading={saving} loadingLabel="Saving" onClick={() => void save()}>
          Save email settings
        </Button>
        <span className="ix-actions__note">
          The sender name and reply-to address are under <Link to="/admin/settings">Settings</Link>.
        </span>
      </div>

      <IxBlock title="Send a test">
        <div className="ix-test">
          <Field label="Send it to" className="ix-test__field">
            <Input type="email" inputMode="email" autoComplete="email" value={to} placeholder="you@example.com" onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button variant="secondary" iconLeft={<Send size={15} />} disabled={!EMAIL.test(to.trim())} loading={test.status === 'running'} loadingLabel="Sending" onClick={() => void runTest({ channel: 'email', to: to.trim() })}>
            Send test email
          </Button>
        </div>
        <TestResult state={test} />
      </IxBlock>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={removeKey}
        tone="danger"
        title="Remove the Resend key?"
        description="Emails will go out from your Gmail when that is allowed, otherwise they stop."
        confirmLabel="Remove key"
      />
    </IntegrationCard>
  );
}

// ═════════════════════════════ Twilio ═════════════════════════════

function TwilioCard({ open, onToggle }: CardProps) {
  const { data } = useAdmin();
  const apply = useApply();
  const toast = useToast();
  const t = data.integrations.twilio;
  const assistant = data.site.assistant.name;

  const [sid, setSid] = useState('');
  const [token, setToken] = useState('');
  const [from, setFrom] = useState(t.fromNumber ?? '');
  const [service, setService] = useState(t.messagingServiceSid ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [to, setTo] = useState('');
  const [test, runTest] = useIntegrationTest();

  useEffect(() => {
    setFrom(t.fromNumber ?? '');
    setService(t.messagingServiceSid ?? '');
  }, [t.fromNumber, t.messagingServiceSid]);

  const hasKeys = !!t.accountSidMasked;
  const status: IntegrationStatus = t.configured ? { tone: 'success', label: 'Connected' } : hasKeys ? { tone: 'warning', label: 'Needs a phone number' } : { tone: 'neutral', label: 'Not set up' };

  const fromClean = cleanPhone(from);
  const fromInvalid = fromClean !== '' && !E164.test(fromClean);
  const sidOff = sid.trim() !== '' && !/^AC[0-9a-fA-F]{32}$/.test(sid.trim());
  const dirty = sid.trim() !== '' || token.trim() !== '' || fromClean !== (t.fromNumber ?? '') || service.trim() !== (t.messagingServiceSid ?? '');
  const firstTime = !hasKeys;
  const complete = firstTime ? sid.trim() !== '' && token.trim() !== '' && (fromClean !== '' || service.trim() !== '') : true;

  const save = async () => {
    if (!dirty || !complete || saving || fromInvalid || sidOff) return;
    setSaving(true);
    setError(null);
    try {
      const twilio: NonNullable<IntegrationsUpdate['twilio']> = {};
      if (sid.trim()) twilio.accountSid = sid.trim();
      if (token.trim()) twilio.authToken = token.trim();
      if (fromClean !== (t.fromNumber ?? '')) twilio.fromNumber = fromClean;
      if (service.trim() !== (t.messagingServiceSid ?? '')) twilio.messagingServiceSid = service.trim();
      apply.integrations(await saveIntegrations({ twilio }));
      setSid('');
      setToken('');
      toast.success('Twilio saved', 'Send yourself a test text to make sure it works.');
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : null;
      setError(failure?.fields ? Object.values(failure.fields)[0] : errorMessage(e, 'Twilio could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      apply.integrations(await saveIntegrations({ twilio: { accountSid: '', authToken: '', fromNumber: '', messagingServiceSid: '' } }));
      toast.success('Twilio removed', 'Reminders now go by email only.');
    } catch (e) {
      toast.error('Twilio was not removed', errorMessage(e));
      throw e;
    }
  };

  const toClean = cleanPhone(to);
  const toValid = E164.test(toClean);
  const smsWebhook = `${data.integrations.baseUrl.replace(/\/+$/, '')}/api/twilio/sms`;

  return (
    <IntegrationCard
      id="twilio"
      icon={<MessageSquareText size={20} />}
      title="Texts and reminder calls"
      description={`Twilio sends reminder texts and places the calls ${assistant} makes.`}
      status={status}
      open={open}
      onToggle={onToggle}
    >
      {!t.configured ? <p className="ix-lead">Until this is connected, reminders go out by email only. Twilio charges a small amount per text and per minute of calling.</p> : null}
      <Steps>
        <Step title="Create a Twilio account" done={hasKeys}>
          <p>
            Sign up at <Ext href="https://www.twilio.com/try-twilio">twilio.com</Ext> and add a payment method. A trial account can only text and call numbers you have verified yourself.
          </p>
        </Step>
        <Step title="Get a phone number" done={t.configured}>
          <p>
            Under <Ext href="https://console.twilio.com/us1/develop/phone-numbers/manage/search">Phone Numbers, Buy a number</Ext>, pick one that can do both <strong>SMS</strong> and <strong>Voice</strong>.
          </p>
          <p>Texting people in the United States also needs a one-time registration (Twilio calls it A2P 10DLC). Twilio walks you through it under Messaging.</p>
        </Step>
        <Step title="Paste your Twilio details" done={t.configured}>
          <p>
            The Account SID and Auth Token are on the first page of the <Ext href="https://console.twilio.com/">Twilio Console</Ext>, under Account Info.
          </p>
          <div className="ix-form">
            <div className="adm-grid2">
              <Field label="Account SID" error={sidOff ? 'An Account SID starts with AC and has 34 characters.' : undefined}>
                <SecretField plain saved={hasKeys} masked={t.accountSidMasked} value={sid} onChange={setSid} placeholder="AC..." />
              </Field>
              <Field label="Auth token">
                <SecretField saved={hasKeys} value={token} onChange={setToken} placeholder="32 characters" onClear={hasKeys ? () => setConfirmRemove(true) : undefined} />
              </Field>
            </div>
            <div className="adm-grid2">
              <Field label="Your Twilio number" hint="With the country code, like +14155550123." error={fromInvalid ? 'Use the international format, for example +14155550123.' : undefined}>
                <Input type="tel" inputMode="tel" autoComplete="off" value={from} placeholder="+14155550123" onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="Messaging Service SID" optional hint="Only if you send texts through a Twilio Messaging Service.">
                <Input autoComplete="off" spellCheck={false} value={service} placeholder="MG..." onChange={(e) => setService(e.target.value)} />
              </Field>
            </div>
            {error ? (
              <Notice tone="danger" title="Not saved">
                {error}
              </Notice>
            ) : null}
            <div className="ix-actions">
              <Button variant={t.configured ? 'secondary' : 'primary'} disabled={!dirty || !complete || fromInvalid || sidOff} loading={saving} loadingLabel="Saving" onClick={() => void save()}>
                Save Twilio details
              </Button>
            </div>
          </div>
        </Step>
        <Step title="Let people reply to your texts">
          <p>
            In Twilio, open your number and find "A message comes in". Choose <strong>Webhook</strong>, method <strong>POST</strong>, and paste this address. Then a reply of "C" confirms the meeting and anything else gets the reschedule link.
          </p>
          <CopyField value={smsWebhook} label="Address for incoming texts" />
        </Step>
      </Steps>

      <IxBlock title="Send a test">
        <div className="ix-test">
          <Field label="Your mobile number" className="ix-test__field" error={toClean !== '' && !toValid ? 'Use the international format, for example +14155550123.' : undefined}>
            <Input type="tel" inputMode="tel" autoComplete="tel" value={to} placeholder="+14155550123" onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button variant="secondary" iconLeft={<MessageSquareText size={15} />} disabled={!t.configured || !toValid || test.status === 'running'} onClick={() => void runTest({ channel: 'sms', to: toClean })}>
            Send test text
          </Button>
          <Button variant="secondary" iconLeft={<PhoneCall size={15} />} disabled={!t.configured || !toValid || test.status === 'running'} onClick={() => void runTest({ channel: 'call', to: toClean })}>
            Call me
          </Button>
        </div>
        {!t.configured ? <p className="ix-text">Save your Twilio details first.</p> : null}
        <TestResult state={test} />
      </IxBlock>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        tone="danger"
        title="Remove Twilio?"
        description="Reminder texts and calls stop. Email reminders keep going."
        confirmLabel="Remove Twilio"
      />
    </IntegrationCard>
  );
}

// ═════════════════════════════ Voice assistant (Anthropic) ═════════════════════════════

function AssistantCard({ open, onToggle }: CardProps) {
  const { data, refresh } = useAdmin();
  const apply = useApply();
  const toast = useToast();
  const a = data.integrations.anthropic;
  const twilio = data.integrations.twilio;
  const site = data.site;
  const name = site.assistant.name;
  const owner = firstName(site.profile.name);

  const current = site.assistant.model || a.model;
  const known = MODELS.some((m) => m.id === current);
  const [model, setModel] = useState(known ? current : 'custom');
  const [custom, setCustom] = useState(known ? '' : current);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [test, runTest] = useIntegrationTest();

  const chosen = model === 'custom' ? custom.trim() : model;
  const modelInvalid = model === 'custom' && !/^[a-z0-9][a-z0-9.@:-]{2,80}$/i.test(custom.trim());
  const dirty = key.trim() !== '' || (chosen !== current && !modelInvalid);
  const status: IntegrationStatus = a.configured ? { tone: 'success', label: 'Connected' } : { tone: 'neutral', label: 'Using the simple script' };

  const save = async () => {
    if (!dirty || saving || modelInvalid) return;
    setSaving(true);
    setError(null);
    try {
      if (key.trim()) apply.integrations(await saveIntegrations({ anthropic: { apiKey: key.trim() } }));
      if (chosen !== current) await saveSite({ assistant: { model: chosen } });
      setKey('');
      await refresh();
      toast.success('Assistant settings saved');
    } catch (e) {
      setError(errorMessage(e, 'The assistant settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      apply.integrations(await saveIntegrations({ anthropic: { apiKey: '' } }));
      toast.success('Anthropic key removed', `${name} goes back to the simple script.`);
    } catch (e) {
      toast.error('The key was not removed', errorMessage(e));
      throw e;
    }
  };

  return (
    <IntegrationCard
      id="assistant"
      icon={<Bot size={20} />}
      title="Voice assistant"
      description={`Lets ${name} hold a real conversation on reminder calls, powered by Claude.`}
      status={status}
      open={open}
      onToggle={onToggle}
    >
      <div className="ix-compare">
        <div className="ix-compare__col">
          <p className="ix-compare__label">Without a key</p>
          <p className="ix-compare__text">{name} follows a simple script: "Press 1 to confirm, 2 for a link to reschedule, 3 to cancel."</p>
        </div>
        <div className="ix-compare__col is-on">
          <p className="ix-compare__label">With a key</p>
          <p className="ix-compare__text">
            {name} understands what people say. "I'm running ten minutes late" or "can we do Thursday instead?" get a sensible answer, and {owner} hears about it.
          </p>
        </div>
      </div>

      {!twilio.configured ? (
        <Notice tone="info">Reminder calls also need Twilio, in the card above. You can add this key now and it will be used as soon as calls are on.</Notice>
      ) : null}

      <Steps>
        <Step title="Open the Claude Console" done={a.configured}>
          <p>
            Go to <Ext href="https://platform.claude.com/">platform.claude.com</Ext> and sign in or create an account. Add a little credit under Billing so calls can run.
          </p>
        </Step>
        <Step title="Create an API key and paste it here" done={a.configured}>
          <p>Open API keys, press Create key, give it a name like "Meetings" and copy it. You only see it once.</p>
          <Field label="Anthropic API key">
            <SecretField saved={a.configured} value={key} onChange={setKey} placeholder="sk-ant-..." onClear={a.configured ? () => setConfirmRemove(true) : undefined} />
          </Field>
        </Step>
        <Step title="Choose the model">
          <div className="ix-form">
            <Field label="Model" hideLabel hint="The recommended model handles phone conversations best. You can change this any time.">
              <Select value={model} onChange={(e) => setModel(e.target.value)} options={[...MODELS.map((m) => ({ value: m.id, label: m.label })), { value: 'custom', label: 'Another model' }]} />
            </Field>
            {model === 'custom' ? (
              <Field label="Model ID" error={custom.trim() !== '' && modelInvalid ? 'That does not look like a model ID.' : undefined} hint="Exactly as written in the Claude documentation.">
                <Input autoComplete="off" spellCheck={false} autoCapitalize="off" value={custom} placeholder="claude-..." onChange={(e) => setCustom(e.target.value)} />
              </Field>
            ) : null}
          </div>
        </Step>
      </Steps>

      {error ? (
        <Notice tone="danger" title="Not saved">
          {error}
        </Notice>
      ) : null}
      <div className="ix-actions">
        <Button variant="primary" disabled={!dirty || modelInvalid} loading={saving} loadingLabel="Saving" onClick={() => void save()}>
          Save assistant settings
        </Button>
        <span className="ix-actions__note">
          {name}'s name, voice and calling hours are under <Link to="/admin/settings">Settings</Link>.
        </span>
      </div>

      <IxBlock title="Send a test">
        <div className="ix-test">
          <p className="ix-text ix-test__field">Sends one short message to Claude with your key and shows how long the answer took.</p>
          <Button variant="secondary" iconLeft={<Send size={15} />} disabled={!a.configured} loading={test.status === 'running'} loadingLabel="Testing" onClick={() => void runTest({ channel: 'anthropic' })}>
            Send test
          </Button>
        </div>
        <TestResult state={test} />
      </IxBlock>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={removeKey}
        tone="danger"
        title="Remove the Anthropic key?"
        description={`${name} will go back to the simple script on reminder calls.`}
        confirmLabel="Remove key"
      />
    </IntegrationCard>
  );
}

// ═════════════════════════════ page ═════════════════════════════

function Progress({ items }: { items: { id: CardId; label: string; done: boolean; icon: ReactNode }[] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <nav className="ix-progress" aria-label="Connections">
      <p className="ix-progress__count">
        <strong>{done}</strong> of {items.length} connected
      </p>
      <ul role="list" className="ix-progress__list">
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className={i.done ? 'ix-chip is-done' : 'ix-chip'}>
              <span className="ix-chip__icon" aria-hidden="true">
                {i.done ? <Check size={13} strokeWidth={3} /> : i.icon}
              </span>
              {i.label}
              <span className="u-vh">{i.done ? ', connected' : ', not connected yet'}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function IntegrationsPage() {
  const { data, refresh, ownerHost } = useAdmin();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const integ = data.integrations;

  const googleDone = integ.google.ownerConnected && ownerHost.google?.status !== 'needs_reconnect';
  const emailDone = integ.email.resolved !== 'none';
  const done: Record<CardId, boolean> = { google: googleDone, email: emailDone, twilio: integ.twilio.configured, assistant: integ.anthropic.configured };

  const [open, setOpen] = useState<Set<CardId>>(() => {
    const hash = window.location.hash.replace('#', '') as CardId;
    if (CARD_IDS.includes(hash)) return new Set([hash]);
    const first = CARD_IDS.find((id) => !done[id]);
    return new Set(first ? [first] : []);
  });

  const toggle = (id: CardId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Back from Google: say what happened, then tidy the address bar.
  const handledReturn = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get('google');
    if (!result || handledReturn.current) return;
    handledReturn.current = true;
    if (result === 'connected') toast.success('Google is connected', 'Your busy times are now checked and bookings land on your calendar.');
    else toast.error('Google did not connect', googleReason(params.get('reason')));
    setOpen((prev) => new Set(prev).add('google'));
    navigate('/admin/integrations', { replace: true });
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Links like /admin/integrations#twilio open that card and bring it into view.
  useEffect(() => {
    const hash = location.hash.replace('#', '') as CardId;
    if (!CARD_IDS.includes(hash)) return;
    setOpen((prev) => (prev.has(hash) ? prev : new Set(prev).add(hash)));
    window.requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [location.hash]);

  const reconnect = ownerHost.google?.status === 'needs_reconnect';

  return (
    <Page width="narrow">
      <PageHeader title="Integrations" description="Four connections make everything work. Each takes a few minutes, and you only do it once." />

      <Progress
        items={[
          { id: 'google', label: 'Calendar', done: done.google, icon: <CalendarCheck size={13} /> },
          { id: 'email', label: 'Email', done: done.email, icon: <Mail size={13} /> },
          { id: 'twilio', label: 'Texts and calls', done: done.twilio, icon: <MessageSquareText size={13} /> },
          { id: 'assistant', label: 'Voice assistant', done: done.assistant, icon: <Bot size={13} /> },
        ]}
      />

      {reconnect ? (
        <Notice tone="warning" title="Your Google Calendar needs to be reconnected">
          New bookings are not reaching your calendar. Open the Google Calendar card and press Reconnect.
        </Notice>
      ) : null}

      <div className="ix-list">
        <GoogleCard open={open.has('google')} onToggle={() => toggle('google')} />
        <EmailCard open={open.has('email')} onToggle={() => toggle('email')} />
        <TwilioCard open={open.has('twilio')} onToggle={() => toggle('twilio')} />
        <AssistantCard open={open.has('assistant')} onToggle={() => toggle('assistant')} />
      </div>

      <p className="ix-foot">Keys are stored encrypted and are never shown again after you save them. To change one, press Replace.</p>
    </Page>
  );
}
