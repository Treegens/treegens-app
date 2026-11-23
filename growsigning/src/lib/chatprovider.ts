// Who writes the help chat's answers on this server, from the settings, first match wins (src/server/chat.ts):
//   SUPPORT_CHAT_API_KEY  any host that speaks the OpenAI chat API, at SUPPORT_CHAT_BASE_URL (default OpenRouter),
//                         with SUPPORT_CHAT_MODEL (default Kimi K3 there)
//   MOONSHOT_API_KEY      Moonshot AI's own API, model kimi-k3
//   OPENROUTER_API_KEY    OpenRouter, model moonshotai/kimi-k3
// With none of them the chat still answers, from the built-in answers, and nothing leaves the server.
//
// /security ("Where your data is") and /security/processing list the provider from this same function, so the pages
// name exactly whom the server sends the typed chat to. It reads the environment: server code and server components
// only. It never returns the key itself, only the name of the setting that holds it.
import { CHAT_DAILY_DEFAULT, CHAT_KEPT_PAGE } from './chat.ts';
import { boundaryRequired, boundaryModel, plainHttpAllowed, modelLine, hostedKind, hostnameOf, insideNetwork, CHAT_NOT_TRAINED, chatTermsLine } from './chatboundary.ts';

type Env = Record<string, string | undefined>;
const val = (v: string | undefined): string | null => (v || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
export const MOONSHOT_URL = 'https://api.moonshot.ai/v1';
export const OPENROUTER_MODEL = 'moonshotai/kimi-k3';
export const MOONSHOT_MODEL = 'kimi-k3';

export type ChatProvider = {
  /** Which setting holds the key. The server reads the key from it; nothing else ever sees it. */
  keyVar: 'SUPPORT_CHAT_API_KEY' | 'MOONSHOT_API_KEY' | 'OPENROUTER_API_KEY';
  baseUrl: string;
  model: string;
  /** OpenRouter and Moonshot spell the knob for "think less" differently. */
  style: 'openrouter' | 'moonshot' | 'plain';
  /** The company, as the operator named it or as the address shows it. */
  name: string;
  /** Where it handles the chat, as the operator stated it, or null. */
  country: string | null;
  host: string;
  /** The model runs inside this server's own network (a private network address, src/lib/chatboundary.ts). */
  inside: boolean;
};

/** What a sentence calls the model of the help chat when nobody named it: never a capital in the middle of a sentence. */
export const INSIDE_NAME = "the model that runs inside this server's own network";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function chatProvider(env: Env = process.env): ChatProvider | null {
  const named = val(env.SUPPORT_CHAT_PROVIDER_NAME), country = val(env.SUPPORT_CHAT_PROVIDER_COUNTRY);
  const model = val(env.SUPPORT_CHAT_MODEL);
  if (val(env.SUPPORT_CHAT_API_KEY)) {
    const base = (val(env.SUPPORT_CHAT_BASE_URL) || OPENROUTER_URL).replace(/\/+$/, '');
    // Only a web address over https is used, so the key never travels in the clear. A plain http address is allowed
    // only on this machine itself, for a model run locally.
    const host = hostOf(base);
    // Where the chat must stay inside the server's own boundary, plain http is also allowed to a private network
    // address, for a model in that network without a certificate (src/lib/chatboundary.ts).
    if (!host || !(/^https:\/\//i.test(base) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(base) || plainHttpAllowed(base, env))) return null;
    // Which hosted default it is, from the bare host name: a trailing dot, a port or a name under it changes nothing.
    const kind = hostedKind(hostnameOf(base));
    const inside = insideNetwork({ keyVar: 'SUPPORT_CHAT_API_KEY', baseUrl: base });
    return { keyVar: 'SUPPORT_CHAT_API_KEY', baseUrl: base, model: model || OPENROUTER_MODEL, style: kind || 'plain',
      name: named || (kind === 'openrouter' ? 'OpenRouter' : kind === 'moonshot' ? 'Moonshot AI' : inside ? INSIDE_NAME : `the service at ${host}`), country, host, inside };
  }
  if (val(env.MOONSHOT_API_KEY))
    return { keyVar: 'MOONSHOT_API_KEY', baseUrl: MOONSHOT_URL, model: model || MOONSHOT_MODEL, style: 'moonshot', name: named || 'Moonshot AI', country, host: hostOf(MOONSHOT_URL), inside: false };
  if (val(env.OPENROUTER_API_KEY))
    return { keyVar: 'OPENROUTER_API_KEY', baseUrl: OPENROUTER_URL, model: model || OPENROUTER_MODEL, style: 'openrouter', name: named || 'OpenRouter', country, host: hostOf(OPENROUTER_URL), inside: false };
  return null;
}

/** How many questions the model answers for everyone on this server in a day (UTC). 0 sends none to it. */
export const chatDailyLimit = (env: Env = process.env): number => {
  const raw = (env.SUPPORT_CHAT_DAILY_LIMIT ?? '').trim();
  const n = Number(raw === '' ? NaN : raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CHAT_DAILY_DEFAULT;
};

/** What the security pages say reaches the provider. True of src/server/chat.ts: change both together. */
export const CHAT_SENT = 'Only what people type into the help chat, after what looks like a card number, a private link, a code, a password or an email address is taken out (the usual ways of writing them; it cannot catch every one, so the chat asks people not to type them), with the latest messages of that conversation and which kind of screen it was typed on (for example "the signing page"). Never a document, a name, an address, a signing link or a security code from the page itself, and nothing that says who is asking.';
export const CHAT_WHO = 'Anyone who types into the help chat: visitors, signers and account holders. Nobody else.';

/** Whether a model answers the help chat on this server: a provider, its key, and a daily limit above 0. */
export const chatModelOn = (env: Env = process.env): boolean => {
  const p = chatProvider(env);
  return !!p && !!(env[p.keyVar] || '').trim() && chatDailyLimit(env) > 0 && (!boundaryRequired(env) || ownModel(p, env));
};

/**
 * Under DEPLOYMENT_PROFILE=government (src/lib/deployment.ts) or OUTSIDE_CALLS=listed or none the chat never goes to
 * a hosted service. A model answers only when the operator set SUPPORT_CHAT_API_KEY together with
 * SUPPORT_CHAT_BASE_URL, that address is not OpenRouter's or Moonshot AI's, and it is a private network address or a
 * name listed in OUTBOUND_ALLOW (src/lib/chatboundary.ts). The server cannot check where the address leads: whoever
 * sets it answers for it.
 */
export const ownModel = (p: ChatProvider, env: Env = process.env): boolean => boundaryModel(p, env).ok;

/** The point on /security under "Privacy and AI", from the same settings. */
export function chatPrivacyPoint(env: Env = process.env): { title: string; text: string } {
  const p = chatProvider(env);
  if (chatModelOn(env) && p && p.inside)
    return { title: "What you type into the help chat stays inside this server's network.", text: `It goes to the model ${p.model.slice(0, 80)} that the people who run this server run themselves, at ${p.host.slice(0, 80)}. ${CHAT_SENT} ${CHAT_KEPT_PAGE} ${CHAT_NOT_TRAINED}` };
  return chatModelOn(env) && p
    ? { title: 'What you type into the help chat goes to an AI service.', text: `It goes to ${p.name}, which is listed under "Where your data is" below. ${modelLine(p)} ${CHAT_SENT} ${CHAT_KEPT_PAGE} ${chatTermsLine(p.name, p.style === 'plain')}` }
    : { title: 'The help chat answers from the built-in help.', text: `${boundaryRequired(env) ? 'This server keeps the help chat inside its own network, and no AI model of its own is set up for it' : 'No AI model is set up for it on this server'}, so nothing typed into it leaves the server. ${CHAT_KEPT_PAGE}` };
}
