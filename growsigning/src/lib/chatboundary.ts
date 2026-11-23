// The help chat's model on a server that must keep what people type inside its own boundary (research/government.json,
// G20, and the owner's answer of 2026-11-20: "self-hosted model only for government"). Two settings ask for that:
//   DEPLOYMENT_PROFILE=government  (src/lib/deployment.ts)
//   OUTSIDE_CALLS=listed or none   (src/lib/outside.ts; any value that is not "all" counts, as there)
// Under either, the hosted defaults (OpenRouter and Moonshot AI, through their own keys or through SUPPORT_CHAT_BASE_URL)
// are never used. Only SUPPORT_CHAT_API_KEY with SUPPORT_CHAT_BASE_URL counts, and that address must be
//   - an internet address of a private network or of this machine (10.x, 172.16-31.x, 192.168.x, 100.64-127.x,
//     127.x, fc00::/7, ::1, localhost), which may then also be plain http, because a model inside the boundary often
//     has no certificate; or
//   - a name the operator listed in OUTBOUND_ALLOW, over https.
// Otherwise the help chat answers from the built-in help only, and the server says why when it starts.
// The server cannot check where a name leads or who runs the machine behind an address: whoever sets it answers for it.
// Link-local addresses (169.254.x, fe80::) are never accepted, nor the two metadata addresses some clouds put inside
// the private ranges (AWS's fd00:ec2::/32 and Alibaba Cloud's 100.100.100.200). Another cloud may use another one:
// the server cannot know them all, so whoever sets the address answers for it.
//
// It reads the environment: server code and server components only. No import of outside.ts (it imports the chat's
// provider, so that would be a loop): the list is read here the same way hostList reads it.

type Env = Record<string, string | undefined>;
const clean = (v: string | undefined) => (v || '').trim();

/** Whether this server must keep the help chat inside its own boundary. */
export function boundaryRequired(env: Env = process.env): boolean {
  if (clean(env.DEPLOYMENT_PROFILE).toLowerCase() === 'government') return true;
  const calls = clean(env.OUTSIDE_CALLS).toLowerCase();
  return !!calls && calls !== 'all';
}

/** Which of the two settings asks for it, for the words the operator reads. */
export const boundaryReason = (env: Env = process.env): string =>
  clean(env.DEPLOYMENT_PROFILE).toLowerCase() === 'government' ? 'DEPLOYMENT_PROFILE=government' : `OUTSIDE_CALLS=${clean(env.OUTSIDE_CALLS).toLowerCase().slice(0, 20)}`;

const bare = (h: string) => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** An internet address of a private network or of this machine, or the name localhost. Never a link-local address. */
export function isPrivateAddress(host: string): boolean {
  const h = bare(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    if (a === 100 && b === 100 && c === 100 && d === 200) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(':') || !/^[0-9a-f:.]+$/.test(h)) return false;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (m) return isPrivateAddress(m[1]);
  // fd00:ec2::/32 is AWS's metadata service over IPv6: never a model.
  if (/^fd00:0{0,2}ec2:/.test(h)) return false;
  // fc00::/7: the first group starts with fc or fd.
  return /^f[cd][0-9a-f]{0,2}:/.test(h);
}

/**
 * Whether a host name belongs to one of the two hosted defaults, however it is spelled: with or without a trailing
 * dot or a port, and any name under openrouter.ai, moonshot.ai or moonshot.cn. Null for any other host.
 */
export function hostedKind(host: string): 'openrouter' | 'moonshot' | null {
  const h = bare(host).replace(/:\d+$/, '').replace(/\.+$/, '');
  const under = (d: string) => h === d || h.endsWith(`.${d}`);
  if (under('openrouter.ai')) return 'openrouter';
  if (under('moonshot.ai') || under('moonshot.cn')) return 'moonshot';
  return null;
}

/** OUTBOUND_ALLOW read as src/lib/outside.ts hostList reads it: a part with anything that is not a host name is left out. */
function allowList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of clean(raw).split(',')) {
    const names = part.trim().split(/\s+/).filter(Boolean).map((s) => {
      const t = s.trim().toLowerCase();
      if (/^[a-z]+:\/\//.test(t)) {
        try {
          return bare(new URL(t).hostname);
        } catch {
          return '';
        }
      }
      return t.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    });
    if (names.length && names.every((s) => /^(\*\.)?[a-z0-9]([a-z0-9.:_-]*[a-z0-9])?$/.test(s))) out.push(...names);
  }
  return out;
}
const listed = (list: string[], host: string) => {
  const h = bare(host);
  return !!h && list.some((e) => (e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : e === h));
};

/** The host part of an address without its port, or ''. */
export function hostnameOf(url: string): string {
  try {
    return bare(new URL(url).hostname);
  } catch {
    return '';
  }
}

/** Whether plain http may be used for this address: only inside the boundary rule, and only to a private address. */
export const plainHttpAllowed = (url: string, env: Env = process.env): boolean =>
  boundaryRequired(env) && /^http:\/\//i.test(url) && isPrivateAddress(hostnameOf(url));

export type BoundaryCheck = { ok: true } | { ok: false; why: string };

/**
 * Whether the provider the chat would use counts as one inside the boundary. `p` is what chatProvider() answered.
 * The words in `why` name the setting to change; the server logs them once when it starts.
 */
export function boundaryModel(p: { keyVar: string; baseUrl: string; style: string } | null, env: Env = process.env): BoundaryCheck {
  if (!p) return { ok: false, why: 'no model is set up for it' };
  if (p.keyVar !== 'SUPPORT_CHAT_API_KEY' || !clean(env.SUPPORT_CHAT_BASE_URL))
    return { ok: false, why: `it does not use the hosted AI service set in ${p.keyVar}. Only SUPPORT_CHAT_API_KEY together with SUPPORT_CHAT_BASE_URL, the address of a model you run yourself, counts` };
  if (p.style !== 'plain' || hostedKind(hostnameOf(p.baseUrl))) return { ok: false, why: 'SUPPORT_CHAT_BASE_URL points at OpenRouter or Moonshot AI, which are hosted services' };
  const host = hostnameOf(p.baseUrl);
  if (isPrivateAddress(host)) return { ok: true };
  if (listed(allowList(env.OUTBOUND_ALLOW), host)) return { ok: true };
  return { ok: false, why: `SUPPORT_CHAT_BASE_URL points at ${host.slice(0, 80)}, which is neither a private network address nor listed in OUTBOUND_ALLOW. Add it to OUTBOUND_ALLOW if it is a model you run yourself` };
}

/** The line the server logs when it starts and the chat cannot use the model in its settings, or null. */
export function boundaryChatWarning(p: { keyVar: string; baseUrl: string; style: string } | null, env: Env = process.env): string | null {
  if (!boundaryRequired(env)) return null;
  // A key with an address the chat cannot use at all (plain http to a name, or not an address): say that too.
  if (!p && clean(env.SUPPORT_CHAT_API_KEY) && clean(env.SUPPORT_CHAT_BASE_URL))
    return `${boundaryReason(env)}: the help chat answers from the built-in help only, because SUPPORT_CHAT_BASE_URL cannot be used: it must start with https://, or with http:// only for a private network address such as 10.0.0.5. What people type into the help chat never goes to a hosted service on this server.`;
  if (!p) return null;
  const c = boundaryModel(p, env);
  if (c.ok) return null;
  return `${boundaryReason(env)}: the help chat answers from the built-in help only, because ${c.why}. What people type into the help chat never goes to a hosted service on this server.`;
}

/** What a page may print about the model: "<model> on <host>", read from the settings. Never the key. */
export const modelLine = (p: { model: string; host: string }): string => `Answers come from ${p.model.slice(0, 80)} on ${p.host.slice(0, 80)}.`;

/**
 * Whether the help chat's model runs inside this server's own network: SUPPORT_CHAT_BASE_URL at a private network
 * address that is not a hosted default. Only then may a page say that nothing is sent to train a model.
 */
export const insideNetwork = (p: { keyVar: string; baseUrl: string } | null): boolean =>
  !!p && p.keyVar === 'SUPPORT_CHAT_API_KEY' && !hostedKind(hostnameOf(p.baseUrl)) && isPrivateAddress(hostnameOf(p.baseUrl));

/**
 * Said after CHAT_KEPT_PAGE (which says nothing asked or answered is stored or logged) only when the model runs inside
 * this server's network (insideNetwork). For a model outside it, chatTermsLine says whose terms decide instead.
 */
export const CHAT_NOT_TRAINED = "Nothing is sent to train a model. What the model's own program logs is set by the people who run it.";
/** The table under "Where your data is", for a model inside this server's network. */
export const CHAT_SERVER_KEEPS_NOTHING = 'This server stores nothing typed into the help chat, and sends nothing to train a model.';
/** The same table, for a model outside it: true of src/server/chat.ts on every server. */
export const CHAT_SERVER_STORES_NOTHING = 'This server stores nothing typed into the help chat.';
/** For a model outside this server's network: whose terms decide what it keeps. */
export const chatTermsLine = (name: string, plain: boolean): string =>
  `What ${name} keeps of what is typed, and whether it trains on it, is set by its own terms${plain ? ' or by the people who run it' : ''}.`;
