/**
 * Integrations as the dashboard sees them: what is connected (never the credentials
 * themselves), saving credentials, and the "send a test" actions.
 *
 * Credentials come from two places: what the owner saved here (sealed in storage) and, on top
 * of that, values set in the deployment's environment. Saving always starts from what is
 * stored, never from the merged view, so an environment value is never copied into storage.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  Booking,
  Host,
  IntegrationTestResponse,
  IntegrationsStatus,
  Secrets,
  SendResult,
  SiteSettings,
} from '../../../shared/types';
import { randomId } from '../crypto';
import type { Ctx } from '../ctx';
import { renderEmailHtml, renderEmailText, resolveEmailProvider, sendEmail } from '../email';
import { GoogleApiError, GoogleAuthError, googleFreeBusy, googleRedirectUri } from '../google';
import { getHost, getSecrets, getSite, getStoredSecrets, listHosts, saveSecrets, saveSite } from '../repo';
import { sendSms } from '../sms';
import { firstName } from '../templates';
import { getTwilioAccount, normalizePhone, twilioFeatures } from '../twilio';
import { FieldErrors, isEmail, isPlainObject, requireObject } from '../validate';
import { MODEL_TIMEOUT_MS, startReminderCall } from '../voice';
import { type Bag, given } from './fields';
import { MODEL_ID_PATTERN } from './site';
import { maskMiddle, ownerOf } from './view';

const DAY_MS = 86_400_000;
const GOOGLE_CLIENT_SUFFIX = '.apps.googleusercontent.com';
const DEFAULT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_API = 'https://api.anthropic.com';
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Which values are set in the deployment's environment and therefore win over anything saved here. */
export interface EnvironmentFlags {
  google: { clientId: boolean; clientSecret: boolean };
  twilio: { accountSid: boolean; authToken: boolean; fromNumber: boolean };
  anthropic: { apiKey: boolean };
  resend: { apiKey: boolean };
}

export type IntegrationsView = IntegrationsStatus & { environment: EnvironmentFlags };

function isSet(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function environmentFlags(ctx: Ctx): EnvironmentFlags {
  const o = ctx.env.overrides ?? {};
  return {
    google: { clientId: isSet(o.googleClientId), clientSecret: isSet(o.googleClientSecret) },
    twilio: { accountSid: isSet(o.twilioAccountSid), authToken: isSet(o.twilioAuthToken), fromNumber: isSet(o.twilioFromNumber) },
    anthropic: { apiKey: isSet(o.anthropicApiKey) },
    resend: { apiKey: isSet(o.resendApiKey) },
  };
}

/** "1234….apps.googleusercontent.com": recognisable, not usable. */
function maskClientId(clientId: string): string {
  if (clientId.endsWith(GOOGLE_CLIENT_SUFFIX) && clientId.length > GOOGLE_CLIENT_SUFFIX.length + 4) return `${clientId.slice(0, 4)}…${GOOGLE_CLIENT_SUFFIX}`;
  return maskMiddle(clientId);
}

/** GET /admin/integrations. Booleans, addresses the owner chose and masked identifiers only. */
export async function integrationsStatus(ctx: Ctx, known?: { site?: SiteSettings; hosts?: Host[] }): Promise<IntegrationsView> {
  const site = known?.site ?? (await getSite(ctx));
  const hosts = known?.hosts ?? (await listHosts(ctx));
  const [secrets, twilio, resolved] = await Promise.all([getSecrets(ctx), getTwilioAccount(ctx), resolveEmailProvider(ctx)]);
  const owner = ownerOf(hosts, site);

  const google: IntegrationsStatus['google'] = {
    configured: isSet(secrets.google?.clientId) && isSet(secrets.google?.clientSecret),
    redirectUri: googleRedirectUri(ctx),
    ownerConnected: !!owner?.google,
  };
  if (isSet(secrets.google?.clientId)) google.clientIdMasked = maskClientId(secrets.google!.clientId);
  if (owner?.google) google.ownerEmail = owner.google.email;

  // Texts go out with a number or a Messaging Service. A call needs a number of its own (see twilioFeatures).
  const twilioStatus: IntegrationsStatus['twilio'] = {
    configured: !!twilio && (isSet(twilio.fromNumber) || isSet(twilio.messagingServiceSid)),
    calls: !!twilio && isSet(twilio.fromNumber),
  };
  if (twilio) {
    twilioStatus.accountSidMasked = maskMiddle(twilio.accountSid);
    if (isSet(twilio.fromNumber)) twilioStatus.fromNumber = twilio.fromNumber;
    if (isSet(twilio.messagingServiceSid)) twilioStatus.messagingServiceSid = twilio.messagingServiceSid;
  }

  // Gmail sends through the owner's Google connection. While that connection cannot be used
  // (the keys are gone, or Google wants a new sign-in) nothing goes out, and the dashboard has
  // to say so instead of "Sending from Gmail". This is a view for the screens only: the sender
  // itself keeps trying, so queued messages are retried and not dropped as "not configured".
  const gmailGranted = owner?.google?.gmailSend === true;
  const gmailProblem: IntegrationsStatus['email']['gmailProblem'] = !gmailGranted ? undefined : !google.configured ? 'keys_missing' : owner?.google?.status !== 'ok' ? 'needs_reconnect' : undefined;
  const gmailDown = resolved === 'gmail' && gmailProblem !== undefined;
  const email: IntegrationsStatus['email'] = {
    setting: site.email?.provider ?? 'auto',
    resolved: gmailDown ? 'none' : resolved,
    resendConfigured: isSet(secrets.resend?.apiKey),
    gmailAvailable: gmailGranted && gmailProblem === undefined,
    fromEmail: site.email?.fromEmail ?? '',
  };
  if (gmailDown) email.gmailProblem = gmailProblem;

  return {
    baseUrl: ctx.env.publicBaseUrl,
    google,
    twilio: twilioStatus,
    anthropic: { configured: isSet(secrets.anthropic?.apiKey), model: site.assistant?.model || DEFAULT_MODEL },
    email,
    environment: environmentFlags(ctx),
  };
}

// ───────────────────────── saving credentials ─────────────────────────

interface SecretRule {
  group: 'google' | 'twilio' | 'anthropic' | 'resend';
  key: string;
  test: (value: string) => boolean;
  message: string;
}

const NO_SPACES = /^[\x21-\x7E]+$/;

const SECRET_RULES: SecretRule[] = [
  {
    group: 'google',
    key: 'clientId',
    test: (v) => v.length <= 200 && NO_SPACES.test(v) && v.endsWith(GOOGLE_CLIENT_SUFFIX) && v.length > GOOGLE_CLIENT_SUFFIX.length,
    message: 'This does not look like a Google client ID. It should end with .apps.googleusercontent.com',
  },
  { group: 'google', key: 'clientSecret', test: (v) => v.length >= 8 && v.length <= 200 && NO_SPACES.test(v), message: 'This does not look like a Google client secret. Copy it again from Google Cloud.' },
  { group: 'twilio', key: 'accountSid', test: (v) => /^AC[0-9a-zA-Z]{32}$/.test(v), message: 'An Account SID starts with AC and has 34 characters.' },
  { group: 'twilio', key: 'authToken', test: (v) => v.length >= 16 && v.length <= 128 && NO_SPACES.test(v), message: 'This does not look like a Twilio auth token. Copy it again from the Twilio Console.' },
  { group: 'twilio', key: 'fromNumber', test: (v) => /^\+[1-9]\d{6,14}$/.test(v), message: 'Use the international format for your Twilio number, for example +14155550123.' },
  { group: 'twilio', key: 'messagingServiceSid', test: (v) => /^MG[0-9a-zA-Z]{32}$/.test(v), message: 'A Messaging Service SID starts with MG and has 34 characters.' },
  { group: 'anthropic', key: 'apiKey', test: (v) => v.startsWith('sk-ant-') && v.length >= 20 && v.length <= 300 && NO_SPACES.test(v), message: 'An Anthropic API key starts with sk-ant-. Copy it again from the Claude Console.' },
  { group: 'resend', key: 'apiKey', test: (v) => v.length >= 8 && v.length <= 200 && NO_SPACES.test(v), message: 'This does not look like a Resend API key. Copy it again from Resend.' },
];

/**
 * PUT /admin/integrations. Only the keys that were sent change: a value replaces what is
 * stored, an empty string clears it, a missing key (or undefined) leaves it alone.
 * `anthropic.model` is accepted too and saved with the assistant settings.
 */
export async function updateIntegrations(ctx: Ctx, body: unknown): Promise<IntegrationsView> {
  const update = requireObject(body);
  const errors = new FieldErrors();
  const changes: { rule: SecretRule; value: string }[] = [];

  for (const rule of SECRET_RULES) {
    if (!given(update, rule.group)) continue;
    const group = update[rule.group];
    if (!isPlainObject(group)) {
      errors.add(rule.group, 'These settings are not readable.');
      continue;
    }
    if (!given(group, rule.key)) continue;
    const raw = group[rule.key];
    if (typeof raw !== 'string') {
      errors.add(`${rule.group}.${rule.key}`, rule.message);
      continue;
    }
    // Phone numbers are often pasted with spaces or dashes. Everything else is taken as typed.
    const value = rule.key === 'fromNumber' ? raw.replace(/[\s().-]/g, '') : raw.trim();
    if (value !== '' && !rule.test(value)) errors.add(`${rule.group}.${rule.key}`, rule.message);
    else changes.push({ rule, value });
  }

  let model: string | undefined;
  const anthropic: Bag | null = isPlainObject(update.anthropic) ? update.anthropic : null;
  if (anthropic && given(anthropic, 'model')) {
    const raw = typeof anthropic.model === 'string' ? anthropic.model.trim() : '';
    if (MODEL_ID_PATTERN.test(raw)) model = raw;
    else errors.add('anthropic.model', 'That does not look like a model ID.');
  }
  errors.throwIfAny();

  if (changes.length > 0) {
    // What the owner saved, without environment values on top: those must never end up in storage.
    const stored = await getStoredSecrets(ctx);
    const next: Secrets = {
      google: { clientId: stored.google?.clientId ?? '', clientSecret: stored.google?.clientSecret ?? '' },
      twilio: {
        accountSid: stored.twilio?.accountSid ?? '',
        authToken: stored.twilio?.authToken ?? '',
        fromNumber: stored.twilio?.fromNumber ?? '',
        messagingServiceSid: stored.twilio?.messagingServiceSid ?? '',
      },
      anthropic: { apiKey: stored.anthropic?.apiKey ?? '' },
      resend: { apiKey: stored.resend?.apiKey ?? '' },
    };
    for (const { rule, value } of changes) (next[rule.group] as Record<string, string>)[rule.key] = value;
    // saveSecrets drops groups that ended up completely empty.
    await saveSecrets(ctx, next);
  }
  if (model !== undefined) {
    const site = await getSite(ctx);
    if (site.assistant.model !== model) await saveSite(ctx, { ...site, assistant: { ...site.assistant, model } });
  }
  return integrationsStatus(ctx);
}

// ───────────────────────── tests ─────────────────────────

const TEST_CHANNELS = ['email', 'sms', 'call', 'google', 'anthropic'] as const;
export type TestChannel = (typeof TEST_CHANNELS)[number];

export function parseTestChannel(value: unknown): TestChannel | null {
  return (TEST_CHANNELS as readonly unknown[]).includes(value) ? (value as TestChannel) : null;
}

const SKIP_REASONS: Record<string, string> = {
  email_not_configured: 'No email provider is set up yet. Add a Resend key and a from address, or allow sending from Gmail.',
  invalid_recipient: 'That email address does not look right.',
  sms_not_configured: 'Twilio is not set up yet. Save your Twilio details first.',
  calls_not_configured: 'Reminder calls need a Twilio phone number. Add one first.',
  invalid_phone: 'That phone number does not look right. Use the international format, for example +14155550123.',
  unsupported_number: 'That kind of number cannot be used for tests. Try a normal mobile number.',
  recipient_opted_out: 'That number has opted out of texts. Text START to your Twilio number from it, then try again.',
  opted_out: 'That number has asked not to be called.',
  region_not_enabled: 'Your Twilio account is not allowed to reach that country yet. Enable it under Geo permissions in Twilio.',
  number_not_verified: 'This is a Twilio trial account, which can only reach numbers you have verified in Twilio.',
  number_blocked: 'Twilio refuses to call that number.',
  unreachable_number: 'Twilio could not reach that number.',
  not_a_mobile_number: 'That number cannot receive texts. Try a mobile number.',
  no_public_url: 'Calls need a public https address for this site. Set PUBLIC_BASE_URL in the deployment.',
};

function problem(result: SendResult, fallback: string): string {
  if (result.skipped && SKIP_REASONS[result.skipped]) return SKIP_REASONS[result.skipped];
  const detail = (result.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail ? `${fallback} ${detail}` : fallback;
}

function providerName(provider: string): string {
  if (provider === 'resend') return 'Resend';
  if (provider === 'gmail') return 'Gmail';
  if (provider === 'mock') return 'the local test outbox';
  return provider;
}

async function testEmail(ctx: Ctx, site: SiteSettings, owner: Host | null, to: unknown): Promise<IntegrationTestResponse> {
  const typed = typeof to === 'string' ? to.trim() : '';
  if (typed !== '' && !isEmail(typed)) return { ok: false, detail: 'That email address does not look right.' };
  // Without an address the test goes to the owner: the reply-to address, their own, or their Google account.
  const recipient = typed || [site.email?.replyTo, owner?.email, owner?.google?.email].find((address) => isEmail(address));
  if (!recipient) return { ok: false, detail: 'Enter an email address to send the test to.' };

  const siteName = site.profile?.name || 'your booking page';
  const content = {
    heading: 'Email is working',
    paragraphs: [
      `This is a test from the booking page of ${siteName}.`,
      'Confirmations, reminders and updates about meetings will arrive from this address.',
    ],
    footer: 'You asked for this test from the Integrations page of your dashboard.',
  };
  const result = await sendEmail(ctx, {
    to: recipient,
    subject: `Test email from ${siteName}`,
    text: renderEmailText(content),
    html: renderEmailHtml({ site, preheader: 'Your booking page can send email.', ...content }),
  });
  if (result.ok) return { ok: true, detail: `Test email sent to ${recipient} through ${providerName(result.provider)}. It can take a minute to arrive.` };
  return { ok: false, detail: problem(result, 'The test email was not sent.') };
}

async function testSms(ctx: Ctx, site: SiteSettings, to: unknown): Promise<IntegrationTestResponse> {
  if (!(await twilioFeatures(ctx)).sms) return { ok: false, detail: SKIP_REASONS.sms_not_configured };
  const number = typeof to === 'string' ? normalizePhone(to) : null;
  if (!number) return { ok: false, detail: 'Enter a mobile number in the international format, for example +14155550123.' };
  const result = await sendSms(ctx, { to: number, body: `Test from the booking page of ${site.profile?.name || 'your site'}: texts are working.` });
  if (result.ok) return { ok: true, detail: `Test text sent to ${number}.` };
  return { ok: false, detail: problem(result, 'The test text was not sent.') };
}

/** A booking that exists only for the length of a test call. It is never stored. */
function sampleBooking(ctx: Ctx, site: SiteSettings, owner: Host | null, to: string): Booking {
  const now = ctx.now();
  const start = new Date(now.getTime() + DAY_MS);
  const iso = now.toISOString();
  return {
    id: randomId('test'),
    eventTypeId: 'test',
    eventSlug: 'test',
    eventTitle: 'Test meeting',
    kind: 'solo',
    hostIds: owner ? [owner.id] : [],
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: owner?.name || site.profile?.name || 'there', email: owner?.email || 'test@example.com', phone: to, timezone: owner?.timezone || 'UTC' },
    guests: [],
    answers: [],
    location: { type: 'google_meet', label: 'Google Meet' },
    consent: { sms: false, call: true, at: iso, text: 'Test call requested from the dashboard.' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduledFromStart: null,
    rescheduleCount: 0,
    source: 'admin',
    timeline: [],
    createdAt: iso,
    updatedAt: iso,
  };
}

async function testCall(ctx: Ctx, site: SiteSettings, owner: Host | null, to: unknown): Promise<IntegrationTestResponse> {
  if (!(await twilioFeatures(ctx)).calls) return { ok: false, detail: SKIP_REASONS.calls_not_configured };
  const number = typeof to === 'string' ? normalizePhone(to) : null;
  if (!number) return { ok: false, detail: 'Enter a phone number in the international format, for example +14155550123.' };
  const result = await startReminderCall(ctx, { booking: sampleBooking(ctx, site, owner, number), purpose: 'test', to: number });
  if (result.ok) return { ok: true, detail: `Calling ${number} now. ${site.assistant?.name || 'Your assistant'} will say it is a test call, and nothing will be changed.` };
  return { ok: false, detail: problem(result, 'The test call could not be placed.') };
}

async function testGoogle(ctx: Ctx, host: Host | null, isOwner: boolean): Promise<IntegrationTestResponse> {
  if (!host) return { ok: false, detail: 'That person is no longer on the team.' };
  const calendar = isOwner ? 'Your Google Calendar' : `${firstName(host.name) || 'Their'}'s Google Calendar`;
  if (!host.google) return { ok: false, detail: `${calendar} is not connected yet.` };
  if (host.google.status === 'needs_reconnect') return { ok: false, detail: `${calendar} needs to be reconnected. Google asked for a new sign-in.` };
  const now = ctx.now().getTime();
  try {
    const busy = await googleFreeBusy(ctx, host, { start: now, end: now + 7 * DAY_MS });
    const blocks = busy.length === 1 ? '1 busy block' : `${busy.length} busy blocks`;
    return { ok: true, detail: `Connected as ${host.google.email}. Found ${blocks} in the next 7 days.` };
  } catch (err) {
    // Both error classes only carry sentences written in google.ts: no tokens, no response bodies.
    if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return { ok: false, detail: err.message };
    throw err;
  }
}

function anthropicProblem(err: unknown, model: string): string {
  // Most specific first.
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'Claude took too long to answer. Please try again.';
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic did not accept this key. Check that it was copied in full, then save it again.';
  if (err instanceof Anthropic.PermissionDeniedError) return `This key is not allowed to use ${model}.`;
  if (err instanceof Anthropic.NotFoundError) return `Anthropic does not know the model "${model}", or this key cannot use it. Choose another model.`;
  if (err instanceof Anthropic.BadRequestError) return `Anthropic turned the test down for ${model}. Check the model, and that the account has credit.`;
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is limiting this key right now. Wait a minute and try again.';
  if (err instanceof Anthropic.InternalServerError) return 'Anthropic is having trouble right now. Please try again in a moment.';
  if (err instanceof Anthropic.APIConnectionError) return 'Anthropic could not be reached. Please try again.';
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return 'The Anthropic account has a billing problem. Add credit in the Claude Console, then try again.';
    return `Anthropic answered with an error${err.status ? ` (${err.status})` : ''}. Please try again.`;
  }
  return 'The test could not be completed. Please try again.';
}

/**
 * One tiny message with the configured key and model, sent the way the voice assistant sends
 * its own (official SDK, our fetch, no retries, low effort, refusal fallback when the account
 * has it). A reply of any kind proves that the key and the model work together.
 */
async function testAnthropic(ctx: Ctx, site: SiteSettings): Promise<IntegrationTestResponse> {
  const apiKey = (await getSecrets(ctx)).anthropic?.apiKey?.trim();
  if (!apiKey) return { ok: false, detail: 'No Anthropic key has been added yet.' };
  const configured = site.assistant?.model?.trim() ?? '';
  const model = MODEL_ID_PATTERN.test(configured) ? configured : DEFAULT_MODEL;

  const client = new Anthropic({
    apiKey,
    // Stated outright so nothing in the process environment can point requests elsewhere.
    baseURL: ANTHROPIC_API,
    fetch: ctx.fetch,
    maxRetries: 0,
    timeout: MODEL_TIMEOUT_MS,
    logLevel: 'off',
  });
  const request = {
    model,
    max_tokens: 512,
    output_config: { effort: 'low' as const },
    messages: [{ role: 'user' as const, content: 'This is a connection test from a scheduling app. Reply with the single word: ready' }],
  };

  const started = ctx.now().getTime();
  let stopReason: string | null;
  try {
    try {
      const response = await client.beta.messages.create({ ...request, betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' });
      stopReason = response.stop_reason;
    } catch (err) {
      // A 400 comes back at once. The usual cause is that the refusal fallback option is not
      // available to this account or model, so the same message is sent once more without it.
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      const response = await client.messages.create(request);
      stopReason = response.stop_reason;
    }
  } catch (err) {
    ctx.log('warn', 'integrations: the Anthropic test failed', { reason: err instanceof Error ? err.name : 'unknown', status: err instanceof Anthropic.APIError ? err.status : undefined });
    return { ok: false, detail: anthropicProblem(err, model) };
  }

  const seconds = (ctx.now().getTime() - started) / 1000;
  const timing = seconds > 0 ? ` in ${seconds.toFixed(1)} seconds` : '';
  if (stopReason === 'refusal') return { ok: true, detail: `The key works and ${model} answered${timing}, although it declined the test message itself.` };
  return { ok: true, detail: `The key works. ${model} answered${timing}.` };
}

/**
 * POST /admin/integrations/test. Always answers with { ok, detail }: a test that goes wrong is
 * a result to show, not an error to throw.
 */
export async function runIntegrationTest(ctx: Ctx, body: unknown): Promise<IntegrationTestResponse> {
  const request: Bag = isPlainObject(body) ? body : {};
  const channel = parseTestChannel(request.channel);
  if (!channel) return { ok: false, detail: 'Choose what to test: email, sms, call, google or anthropic.' };
  try {
    const [site, hosts] = await Promise.all([getSite(ctx), listHosts(ctx)]);
    const owner = ownerOf(hosts, site);
    switch (channel) {
      case 'email':
        return await testEmail(ctx, site, owner, request.to);
      case 'sms':
        return await testSms(ctx, site, request.to);
      case 'call':
        return await testCall(ctx, site, owner, request.to);
      case 'google': {
        const hostId = typeof request.hostId === 'string' && request.hostId !== '' ? request.hostId : owner?.id;
        const host = hostId ? await getHost(ctx, hostId) : null;
        return await testGoogle(ctx, host, !!host && host.id === owner?.id);
      }
      case 'anthropic':
        return await testAnthropic(ctx, site);
    }
  } catch (err) {
    ctx.log('error', 'integrations: a test crashed', { channel, error: err instanceof Error ? err.name : 'unknown' });
    return { ok: false, detail: 'The test could not be completed. Please try again in a moment.' };
  }
}
