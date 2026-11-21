// Every outside service this server can connect to, worked out from the settings it runs on, in one list. /security
// prints it ("What this server connects to"), the server logs it once when it starts, and src/server/outside.ts holds
// connections to it when OUTSIDE_CALLS asks for that. Nothing else in the code may call out: a new outside service
// gets a line here first, or tests/selfhost.test.ts fails (it reads every fetch( and connect in src/server).
//
// OUTSIDE_CALLS (one setting, three values):
//   all     (the default, also when unset)  the software connects to every service switched on below, and to the
//           webhook addresses account admins enter. Nothing inside the software stops other connections.
//   listed  only to the hosts the settings below imply, the hosts in OUTBOUND_ALLOW, and webhooks only to the hosts in
//           WEBHOOK_ALLOW_HOSTS. Anything else is refused inside the software and logged once an hour.
//   none    for a closed network: only the mail relay (SMTP_URL) and the hosts in OUTBOUND_ALLOW (and webhooks to
//           WEBHOOK_ALLOW_HOSTS). Every service that needs another host is switched off when the server starts, so the
//           feature is absent and its page says that it is off, exactly as when it was never set up.
//   Any other value counts as none, the strictest, and the log says so: a typo must not open the server up.
// This machine itself (localhost, 127.0.0.0/8, ::1) is never an outside host.
//
// What this is not: a firewall. It sees connections made through fetch and Node's own net and tls modules. A program
// the server starts (LibreOffice, for example) is outside it. The network around the server is where egress is
// really stopped: deploy/helm/growsigning has a NetworkPolicy that denies it by default. /security says both, apart.
//
// It reads the environment: server code and server components only.
import { signInProviders } from './signin.ts';
import { smsProvider } from './checks.ts';
import { chatProvider, chatModelOn } from './chatprovider.ts';

type Env = Record<string, string | undefined>;

export type OutsideMode = 'all' | 'listed' | 'none';
export type ServiceId = 'mail' | 'payments' | 'google' | 'microsoft' | 'sms' | 'tsa' | 'chat' | 'converter' | 'sns' | 'webhooks';

export type OutsideService = {
  id: ServiceId;
  /** What it is, in a few words. */
  name: string;
  /** What the server uses it for. */
  purpose: string;
  /** The settings that switch it on. */
  settings: string[];
  /** Whether the settings switch it on. */
  on: boolean;
  /** The hosts the settings point it at. Empty when it is off, or when the host is not known before a call (sns, webhooks). */
  hosts: string[];
  /** When the host is only known at the moment of a call: in words. */
  hostWords?: string;
};

/** A setting this list reads, with the sentence it gets in the README and .env.example. */
export const OUTSIDE_SETTINGS = ['OUTSIDE_CALLS', 'OUTBOUND_ALLOW', 'WEBHOOK_ALLOW_HOSTS'] as const;

/** Services the software does not have, so nothing calls them. Said on /security so a reader does not have to guess. */
export const NOT_BUILT = [
  'WhatsApp (a sender can share a signing link there themselves; the server sends nothing to WhatsApp)',
  'a check of passwords against lists of leaked passwords',
  'certificate revocation checks (OCSP or CRL)',
  'analytics, advertising, error reporting or any service that "phones home" to the makers of the software',
];

const clean = (v: string | undefined) => (v || '').trim();

/** The host part of an address, in lower case without a trailing dot or brackets. '' when it is not an address. */
export function hostOfUrl(raw: string): string {
  try {
    return normalHost(new URL(raw.trim()).hostname);
  } catch {
    return '';
  }
}
export const normalHost = (h: string) => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** This machine itself, which is never an outside host. */
export function isLoopback(host: string): boolean {
  const h = normalHost(host);
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^::ffff:127\./.test(h);
}

/** A list setting: host names separated by commas or spaces. "*.example.org" means any name under example.org. */
export function hostList(raw: string | undefined): string[] {
  return [...new Set(clean(raw).split(/[\s,]+/).map((s) => {
    const t = s.trim().toLowerCase();
    // An address pasted whole ("https://hooks.example.org/x") counts as its host.
    if (/^[a-z]+:\/\//.test(t)) return hostOfUrl(t);
    return t.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  }).filter((s) => /^(\*\.)?[a-z0-9.:_-]+$/.test(s)))];
}

/** Whether a host is on a list made by hostList. "*.example.org" matches a.example.org and a.b.example.org, not example.org. */
export function onList(list: string[], host: string): boolean {
  const h = normalHost(host);
  if (!h) return false;
  return list.some((e) => (e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : e === h));
}

/** The time-stamp services, read the same way as tsaUrls() in src/server/tsa.ts (tests/selfhost.test.ts compares them). */
export const tsaHosts = (env: Env) => [...new Set(`${env.TSA_URL || ''},${env.TSA_URLS || ''}`.split(',').map((s) => s.trim()).filter((s) => /^https?:\/\/[^\s]+$/i.test(s)).map(hostOfUrl).filter(Boolean))];

/** The Gotenberg service, read the same way as converterMode() in src/server/convert.ts. LibreOffice on this machine needs no network. */
function converterHost(env: Env): string | null {
  const c = clean(env.CONVERTER).toLowerCase();
  const raw = clean(env.CONVERTER_URL).replace(/\/+$/, '');
  if (c === 'gotenberg' || (!c && raw)) return /^https?:\/\/[^\s/]+/i.test(raw) ? hostOfUrl(raw) || null : null;
  return null;
}

// What Amazon SNS asks a new address to fetch to confirm it (routes-bounces.ts, confirmSubscription). The host is
// only known when the message arrives: sns.<region>.amazonaws.com.
export const SNS_HOST = /^sns\.[a-z]{2,4}(-[a-z]+)+-\d{1,2}\.amazonaws\.com(\.cn)?$/;

/** Every outside service, on or off, from the settings. */
export function outsideServices(env: Env = process.env): OutsideService[] {
  const out: OutsideService[] = [];
  const smtp = clean(env.SMTP_URL);
  out.push({ id: 'mail', name: 'Mail relay', purpose: 'Delivers every email this server sends.', settings: ['SMTP_URL'], on: !!smtp, hosts: smtp ? [hostOfUrl(smtp)].filter(Boolean) : [] });
  const pay = !!clean(env.STRIPE_SECRET_KEY);
  out.push({ id: 'payments', name: 'Payment provider (Stripe)', purpose: 'Takes payments for plans and top-ups, and refunds them.', settings: ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_GROVE', 'STRIPE_WEBHOOK_SECRET'], on: pay, hosts: pay ? ['api.stripe.com'] : [] });
  const sign = signInProviders(env);
  out.push({ id: 'google', name: 'Google sign-in', purpose: 'Checks a "Continue with Google" sign-in: swaps its code for a token and fetches the keys that token is signed with.', settings: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], on: sign.includes('google'), hosts: sign.includes('google') ? ['oauth2.googleapis.com', 'www.googleapis.com'] : [] });
  out.push({ id: 'microsoft', name: 'Microsoft sign-in', purpose: 'Checks a "Continue with Microsoft" sign-in the same way.', settings: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'], on: sign.includes('microsoft'), hosts: sign.includes('microsoft') ? ['login.microsoftonline.com'] : [] });
  const sms = smsProvider(env);
  out.push({ id: 'sms', name: 'Text message provider', purpose: 'Sends one-time codes and signing links by text message, when a sender asks for that.', settings: sms === 'hook' ? ['SMS_WEBHOOK_URL', 'SMS_WEBHOOK_TOKEN'] : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMS_WEBHOOK_URL'],
    on: sms === 'twilio' || sms === 'hook', hosts: sms === 'twilio' ? ['api.twilio.com'] : sms === 'hook' ? [hostOfUrl(clean(env.SMS_WEBHOOK_URL))].filter(Boolean) : [] });
  const tsa = tsaHosts(env);
  out.push({ id: 'tsa', name: 'Time-stamp service', purpose: 'Adds a trusted time to the digital seal of a signed PDF. Without it the seal carries the server\'s own time only.', settings: ['TSA_URL', 'TSA_URLS'], on: tsa.length > 0, hosts: tsa });
  const chat = chatProvider(env);
  const chatOn = !!chat && chatModelOn(env);
  out.push({ id: 'chat', name: 'AI model for the help chat', purpose: 'Writes the help chat\'s answers from what a person types into the chat. Never a document.', settings: [chat?.keyVar || 'SUPPORT_CHAT_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY'].filter((v, i, a) => a.indexOf(v) === i),
    on: chatOn, hosts: chatOn && chat ? [hostOfUrl(chat.baseUrl)].filter(Boolean) : [] });
  const conv = converterHost(env);
  out.push({ id: 'converter', name: 'Document converter (Gotenberg)', purpose: 'Turns Word, Excel, PowerPoint and similar files into PDF. LibreOffice on this machine (CONVERTER=soffice) needs no network and is not listed.', settings: ['CONVERTER_URL'], on: !!conv, hosts: conv ? [conv] : [] });
  const sns = !!clean(env.MAIL_EVENTS_TOKEN);
  out.push({ id: 'sns', name: 'Amazon SNS confirmation', purpose: 'When news about emails comes from Amazon SNS, SNS asks once that a link of its own is opened to confirm the address. Only that link is fetched.', settings: ['MAIL_EVENTS_TOKEN'], on: sns, hosts: [], hostWords: 'sns.<region>.amazonaws.com, named by the message' });
  const hooks = hostList(env.WEBHOOK_ALLOW_HOSTS);
  const mode = outsideMode(env).mode;
  out.push({ id: 'webhooks', name: 'Webhooks', purpose: 'Tells a system of an account\'s own about its envelopes. The address is chosen by the account\'s admins.', settings: ['WEBHOOK_ALLOW_HOSTS'],
    on: mode === 'all' || hooks.length > 0, hosts: mode === 'all' ? [] : hooks, hostWords: mode === 'all' ? 'any public https address an account admin enters' : undefined });
  return out;
}

/** OUTSIDE_CALLS as the server reads it. `unknown` is a value that is none of the three, read as none. */
export function outsideMode(env: Env = process.env): { mode: OutsideMode; raw: string; unknown: boolean } {
  const raw = clean(env.OUTSIDE_CALLS).toLowerCase();
  if (!raw || raw === 'all') return { mode: 'all', raw, unknown: false };
  if (raw === 'listed' || raw === 'none') return { mode: raw, raw, unknown: false };
  return { mode: 'none', raw, unknown: true };
}

export type OutsidePolicy = {
  mode: OutsideMode;
  services: OutsideService[];
  /** Exact hosts and "*." patterns the server may connect to (meaningless in mode all, where nothing is held). */
  allow: string[];
  /** OUTBOUND_ALLOW as read. */
  extra: string[];
  /** WEBHOOK_ALLOW_HOSTS as read. */
  webhookHosts: string[];
  /** Whether SNS confirmation links may be fetched. */
  sns: boolean;
};

/** Which hosts a service needs that a policy in mode none does not allow. Mail is always allowed. */
const blockedInNone = (s: OutsideService, extra: string[]) => s.id !== 'mail' && s.id !== 'webhooks' && s.on && (s.id === 'sns' ? !extra.length : s.hosts.some((h) => !isLoopback(h) && !onList(extra, h)));

export function outsidePolicy(env: Env = process.env): OutsidePolicy {
  const { mode } = outsideMode(env);
  const services = outsideServices(env);
  const extra = hostList(env.OUTBOUND_ALLOW);
  const webhookHosts = hostList(env.WEBHOOK_ALLOW_HOSTS);
  const allow = new Set<string>([...extra, ...webhookHosts]);
  for (const s of services) if (s.on && s.id !== 'webhooks' && (mode !== 'none' || s.id === 'mail' || !blockedInNone(s, extra))) for (const h of s.hosts) allow.add(h);
  const snsOn = services.find((s) => s.id === 'sns')!.on;
  return { mode, services, allow: [...allow], extra, webhookHosts, sns: snsOn && mode === 'listed' };
}

/** Whether the server may connect to this host under the policy. */
export function hostAllowed(p: OutsidePolicy, host: string): boolean {
  if (p.mode === 'all') return true;
  const h = normalHost(host);
  if (!h || isLoopback(h)) return true;
  if (onList(p.allow, h)) return true;
  return p.sns && SNS_HOST.test(h);
}

/** Why a host is refused, in one sentence for the server log and the error a caller sees. Names the setting to change. */
export function refusalWords(p: OutsidePolicy, host: string): string {
  return p.mode === 'none'
    ? `This server does not connect to ${host}: OUTSIDE_CALLS=none lets it reach only the mail relay and the hosts in OUTBOUND_ALLOW. Add ${host} to OUTBOUND_ALLOW if it should.`
    : `This server does not connect to ${host}: OUTSIDE_CALLS=listed lets it reach only the services its settings switch on and the hosts in OUTBOUND_ALLOW. Add ${host} to OUTBOUND_ALLOW if it should.`;
}

// ---- Mode none: switching off what needs an outside host ----------------------------------------------------------

export type SwitchedOff = { id: ServiceId; name: string; settings: string[] };
const g = globalThis as any;

/**
 * In mode none, takes the settings of every service that needs a host the policy does not allow out of `env`, so the
 * feature is absent everywhere and every page says it is off, exactly as when it was never set up. Called once when
 * the server starts (src/instrumentation.ts), before anything reads them. Answers what it switched off, which
 * /security and the log name. Mode all and listed change nothing.
 */
export function applyOutsideCalls(env: Env = process.env): SwitchedOff[] {
  const { mode } = outsideMode(env);
  const off: SwitchedOff[] = [];
  if (mode === 'none') {
    const extra = hostList(env.OUTBOUND_ALLOW);
    for (const s of outsideServices(env)) {
      if (!blockedInNone(s, extra) || s.id === 'sns') continue;
      const all = s.id === 'chat' ? ['SUPPORT_CHAT_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY'] : s.id === 'sms' ? ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMS_WEBHOOK_URL', 'SMS_WEBHOOK_TOKEN'] : s.id === 'converter' ? ['CONVERTER_URL'] : s.settings;
      const had = all.filter((k) => clean(env[k]));
      for (const k of had) delete env[k];
      // CONVERTER=gotenberg with its address gone names nothing: leave LibreOffice (soffice) alone.
      if (s.id === 'converter' && clean(env.CONVERTER).toLowerCase() === 'gotenberg') delete env.CONVERTER;
      off.push({ id: s.id, name: s.name, settings: had });
    }
  }
  if (env === process.env) g.__sgOutsideOff = off;
  return off;
}

/** What applyOutsideCalls switched off when this server started. Empty when it did not run or switched nothing off. */
export const switchedOff = (): SwitchedOff[] => g.__sgOutsideOff || [];

/** The lines the server logs once when it starts: what it is configured to connect to, and the guard. */
export function outsideStartLines(env: Env = process.env): string[] {
  const { mode, raw, unknown } = outsideMode(env);
  const p = outsidePolicy(env);
  const on = p.services.filter((s) => s.on);
  const lines = [`[outside] This server is configured to connect to: ${on.length ? on.map((s) => `${s.hosts.length ? s.hosts.join(', ') : s.hostWords || '?'} (${s.name.toLowerCase()})`).join('; ') : 'nothing outside this machine'}.`];
  if (unknown) lines.push(`[outside] OUTSIDE_CALLS is "${raw}", which is not all, listed or none. It is read as none, the strictest.`);
  if (mode === 'all') lines.push('[outside] OUTSIDE_CALLS is not set (all): nothing inside the software holds other connections. Stop them in the network around the server.');
  else lines.push(`[outside] OUTSIDE_CALLS=${mode}: every other host is refused inside the software${p.webhookHosts.length ? `, and webhooks go only to ${p.webhookHosts.join(', ')}` : ', and no webhook can be sent'}. This is a second line of defence: stop egress in the network as well.`);
  for (const s of switchedOff()) lines.push(`[outside] OUTSIDE_CALLS=none switched off ${s.name.toLowerCase()}${s.settings.length ? ` (${s.settings.join(', ')} ignored)` : ''}. Add its host to OUTBOUND_ALLOW to keep it.`);
  const mail = p.services.find((s) => s.id === 'mail')!;
  if (mail.on && !mail.hosts.length) lines.push('[outside] SMTP_URL could not be read as an address, so the mail relay cannot be named here.');
  return lines;
}

// ---- Webhooks under the guard ----------------------------------------------------------------------------------------

/** null: any public https host (mode all). Otherwise the hosts a webhook may go to; empty means none. */
export function webhookHostsRule(env: Env = process.env): string[] | null {
  return outsideMode(env).mode === 'all' ? null : hostList(env.WEBHOOK_ALLOW_HOSTS);
}

/** Why a webhook to this host may not be saved or sent, in words for the account's admin, or null when it may. */
export function webhookRefusal(host: string, env: Env = process.env): string | null {
  const rule = webhookHostsRule(env);
  if (!rule) return null;
  if (!rule.length) return 'Webhooks are switched off on this server: it does not send anything to other systems. That is a rule of the people who run it, so ask them if you need one.';
  if (onList(rule, host)) return null;
  return `Webhooks on this server can only go to ${rule.join(', ')}. That is a rule of the people who run it, so ask them if you need another address.`;
}

/** An exact name the operator listed for webhooks may lead into their own network (a closed network has no other). */
export function webhookMayBePrivate(host: string, env: Env = process.env): boolean {
  const rule = webhookHostsRule(env);
  return !!rule && rule.includes(normalHost(host));
}
