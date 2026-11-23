// The second set of names for the seal settings, and PDF_SIGNING_MODE. The seal reads its own names (SEAL_P12,
// SEAL_CSC_*, see src/server/sealkey.ts and sealcsc.ts). An operator may write the shorter names below instead: each
// is copied to its own name before anything reads a setting (applySealEnv), so the rest of the code knows one set.
//
//   LOCAL_P12_PATH      -> SEAL_P12               CSC_API_BASE_URL   -> SEAL_CSC_URL
//   LOCAL_P12_PASSWORD  -> SEAL_P12_PASSWORD      CSC_TOKEN_URL      -> SEAL_CSC_TOKEN_URL
//   CSC_CLIENT_ID       -> SEAL_CSC_CLIENT_ID     CSC_CLIENT_SECRET  -> SEAL_CSC_CLIENT_SECRET
//   CSC_USERNAME        -> SEAL_CSC_USERNAME      CSC_PASSWORD       -> SEAL_CSC_PASSWORD
//   CSC_CREDENTIAL_ID   -> SEAL_CSC_CREDENTIAL_ID CSC_TOTP_SECRET    -> SEAL_CSC_TOTP_SECRET
//
// When both names of one setting are set and differ, the SEAL_ name wins and the server says so once when it starts.
//
// PDF_SIGNING_MODE says which seal to use when the settings of both are there:
//   local_p12  the key file (a .p12 or .pfx, or the PEM files). Cloud seal settings are left unused.
//   csc        the cloud signing service. Key file settings are left unused.
//   unset      as before: whichever settings are present decide (and both at once are refused).
// A mode whose settings are missing is refused in plain words (sealModeProblem): completed PDFs are then made without
// a seal, exactly as when a certificate cannot be used, and the people who run the server are told.
type Env = Record<string, string | undefined>;

export const SEAL_ALIASES: readonly (readonly [alias: string, own: string])[] = [
  ['LOCAL_P12_PATH', 'SEAL_P12'], ['LOCAL_P12_PASSWORD', 'SEAL_P12_PASSWORD'],
  ['CSC_API_BASE_URL', 'SEAL_CSC_URL'], ['CSC_TOKEN_URL', 'SEAL_CSC_TOKEN_URL'], ['CSC_CLIENT_ID', 'SEAL_CSC_CLIENT_ID'], ['CSC_CLIENT_SECRET', 'SEAL_CSC_CLIENT_SECRET'],
  ['CSC_USERNAME', 'SEAL_CSC_USERNAME'], ['CSC_PASSWORD', 'SEAL_CSC_PASSWORD'], ['CSC_CREDENTIAL_ID', 'SEAL_CSC_CREDENTIAL_ID'], ['CSC_TOTP_SECRET', 'SEAL_CSC_TOTP_SECRET'],
];
export const SIGNING_MODES = ['local_p12', 'csc'] as const;
export type SigningMode = (typeof SIGNING_MODES)[number];
/** The password the dev certificate is made with (scripts/dev-seal-cert.mjs). Known to everyone, so never a secret. */
export const DEV_P12_PASSWORD = 'changeit';
export const DEV_P12_PATH = './certs/dev-seal.p12';
export const DEV_SEAL_NAME = 'GrowSigning development seal';

const LOCAL = ['SEAL_P12', 'SEAL_P12_PASSWORD', 'SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM'];
// The cloud settings that name an account. The two addresses alone never switch a cloud seal on (src/lib/seal.ts).
const CLOUD = ['SEAL_CSC_CLIENT_ID', 'SEAL_CSC_CLIENT_SECRET', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD', 'SEAL_CSC_CREDENTIAL_ID', 'SEAL_CSC_TOTP_SECRET'];
const CLOUD_REQUIRED = ['SEAL_CSC_CLIENT_ID', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD'];
const has = (env: Env, k: string) => !!(env[k] || '').trim();
const aliasOf = (own: string) => SEAL_ALIASES.find(([, o]) => o === own)?.[0];

/** PDF_SIGNING_MODE as read: a known mode, null when unset, or `unknown` with what was written. */
export function signingMode(env: Env = process.env): { mode: SigningMode | null; unknown?: string } {
  const raw = (env.PDF_SIGNING_MODE || '').trim().toLowerCase().replace(/-/g, '_');
  if (!raw) return { mode: null };
  if (raw === 'p12' || raw === 'local' || raw === 'pfx') return { mode: 'local_p12' };
  return (SIGNING_MODES as readonly string[]).includes(raw) ? { mode: raw as SigningMode } : { mode: null, unknown: (env.PDF_SIGNING_MODE || '').trim().slice(0, 40) };
}

/**
 * What applySealEnv would do to `env`, without doing it. `set`: own names to fill from the other name. `drop`: own
 * names the mode leaves unused. `from`: for each own name filled, the name the operator wrote. `lines`: what to say
 * once at the start. Never repeats a value: a path, a password and a client secret all stay out of the log.
 */
export function resolveSealEnv(env: Env = process.env): { set: Record<string, string>; drop: string[]; from: Record<string, string>; lines: string[] } {
  const { mode, unknown } = signingMode(env);
  const set: Record<string, string> = {};
  const from: Record<string, string> = {};
  const lines: string[] = [];
  const differ: string[] = [];
  const unused = mode === 'csc' ? LOCAL : mode === 'local_p12' ? CLOUD : [];
  for (const [alias, own] of SEAL_ALIASES) {
    const a = env[alias];
    if (!has(env, alias) || unused.includes(own)) continue;
    if (!has(env, own)) (set[own] = a as string), (from[own] = alias);
    else if ((env[own] as string).trim() !== (a as string).trim()) differ.push(`${own} (not ${alias})`);
  }
  if (differ.length) lines.push(`[config] Two names of the same seal setting are set to different values. The SEAL_ name is used: ${differ.join(', ')}. Take one of each pair away.`);
  if (unknown) lines.push(`[config] PDF_SIGNING_MODE is "${unknown}", which is not a mode. It is ignored. Write local_p12 (a key file) or csc (a cloud signing service), or leave it out.`);
  // What the mode leaves unused: said by the name the operator wrote.
  const drop = unused.filter((k) => has(env, k));
  const named = [...new Set([...drop, ...SEAL_ALIASES.filter(([a, o]) => unused.includes(o) && has(env, a) && !has(env, o)).map(([a]) => a)])];
  if (named.length) lines.push(`[config] PDF_SIGNING_MODE=${mode}, so the ${mode === 'csc' ? 'key file' : 'cloud seal'} settings are not used: ${named.join(', ')}.`);
  return { set, drop, from, lines };
}

const g = globalThis as any;

/**
 * Copies the second names to the seal's own names and takes away what PDF_SIGNING_MODE leaves unused. Safe to call
 * any number of times: the second call changes nothing. Called when the server starts (src/instrumentation.ts), and
 * again wherever the seal reads its settings, so a script or a test that never starts the server gets the same.
 */
export function applySealEnv(env: Env = process.env): string[] {
  const r = resolveSealEnv(env);
  for (const [k, v] of Object.entries(r.set)) env[k] = v;
  for (const k of r.drop) delete env[k];
  if (env === process.env) {
    g.__sealEnvFrom = { ...(g.__sealEnvFrom || {}), ...r.from };
    g.__sealEnvLines = [...new Set([...(g.__sealEnvLines || []), ...r.lines])];
  }
  return r.lines;
}

/**
 * Why the seal mode asked for cannot be used, or null. Read after applySealEnv. The seal is then refused with these
 * words (src/server/sealkey.ts), and the document completes without a seal.
 */
export function sealModeProblem(env: Env = process.env): string | null {
  const { mode } = signingMode(env);
  if (mode === 'local_p12' && !has(env, 'SEAL_P12') && !has(env, 'LOCAL_P12_PATH') && !has(env, 'SEAL_KEY_PEM') && !has(env, 'SEAL_CERT_PEM'))
    return `PDF_SIGNING_MODE=local_p12, but no key file is set. Set LOCAL_P12_PATH (or SEAL_P12) to a .p12 or .pfx file and LOCAL_P12_PASSWORD to its password. For a test certificate run: npm run seal:dev-cert`;
  if (mode === 'csc' && !CLOUD.some((k) => has(env, k) || has(env, aliasOf(k) || '')))
    return `PDF_SIGNING_MODE=csc, but the cloud signing service is not set up: ${CLOUD_REQUIRED.map((k) => aliasOf(k)).join(', ')} are not set (SSL.com also wants CSC_CLIENT_SECRET, and CSC_CREDENTIAL_ID picks the certificate).`;
  return null;
}

/** A message about seal settings, with each own name written the way the operator wrote it ("SEAL_P12" as "LOCAL_P12_PATH"). */
export function asWritten(message: string): string {
  const from: Record<string, string> = g.__sealEnvFrom || {};
  let m = Object.keys(from).reduce((t, own) => t.replace(new RegExp(`\\b${own}\\b`, 'g'), from[own]), message);
  // An operator who wrote the cloud settings as CSC_ reads the ones still missing under those names too.
  if (Object.keys(from).some((k) => k.startsWith('SEAL_CSC_'))) m = m.replace(/\bSEAL_CSC_URL\b/g, 'CSC_API_BASE_URL').replace(/\bSEAL_CSC_/g, 'CSC_');
  return m;
}

/** The lines the server logs once when it starts: names that disagree, an unknown mode, settings a mode leaves unused, a mode with nothing behind it. */
export function sealEnvStartLines(env: Env = process.env): string[] {
  const lines = env === process.env ? [...new Set([...(g.__sealEnvLines || []), ...applySealEnv(env)])] : resolveSealEnv(env).lines;
  const p = sealModeProblem(env);
  return p ? [...lines, `[config] ${p} Until then completed PDFs are made without the digital seal.`] : lines;
}

/** For tests: forget what was said and which names were copied. */
export function forgetSealEnv() {
  g.__sealEnvFrom = undefined;
  g.__sealEnvLines = undefined;
}
