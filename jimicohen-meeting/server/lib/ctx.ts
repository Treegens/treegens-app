/**
 * Request context injected into every server function. Nothing in server/lib may read
 * process.env, call the global fetch, or call Date.now() directly: go through Ctx so
 * the whole backend runs unchanged on Netlify, in the local dev server and in tests.
 */

export interface KVSetOptions {
  /** write only if the key does not exist yet */
  onlyIfNew?: boolean;
  /** write only if the stored etag still matches (optimistic concurrency) */
  onlyIfMatch?: string;
}

export interface KV {
  getJSON<T>(key: string): Promise<T | null>;
  getJSONWithEtag<T>(key: string): Promise<{ value: T; etag: string } | null>;
  /** modified=false means a condition (onlyIfNew / onlyIfMatch) failed and nothing was written */
  setJSON(key: string, value: unknown, opts?: KVSetOptions): Promise<{ modified: boolean; etag?: string }>;
  delete(key: string): Promise<void>;
  /** all keys starting with prefix, in ascending lexicographic order */
  list(prefix: string): Promise<string[]>;
  getBlob(key: string): Promise<{ data: Uint8Array; metadata: Record<string, string> } | null>;
  setBlob(key: string, data: Uint8Array, metadata: Record<string, string>): Promise<void>;
}

export interface Env {
  /** base64 32-byte master secret; every key (sessions, sealing, tokens) is derived from it */
  secretKey: string;
  /** sha256 hex of the one-time setup code; null once unused/unset */
  setupCodeHash: string | null;
  /** public origin + base path, no trailing slash, e.g. https://jimicohen.com/meeting */
  publicBaseUrl: string;
  /**
   * Direct origin + base path of the app's own site (e.g. https://jimicohen-meeting.netlify.app/meeting).
   * Third-party embeds must load from here: the proxying domain forbids framing. Falls back to publicBaseUrl.
   */
  embedBaseUrl?: string;
  /** true in local dev / tests: provider calls go to in-process mocks */
  mockProviders: boolean;
  /** optional env-level credentials; they win over values saved in the dashboard */
  overrides: {
    googleClientId?: string;
    googleClientSecret?: string;
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioFromNumber?: string;
    anthropicApiKey?: string;
    resendApiKey?: string;
  };
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface Ctx {
  kv: KV;
  env: Env;
  fetch: typeof fetch;
  now: () => Date;
  /** keep the invocation alive until the promise settles (after the response is sent) */
  waitUntil: (p: Promise<unknown>) => void;
  log: (level: LogLevel, msg: string, data?: unknown) => void;
  ip: string | null;
  requestId: string;
}

/** URL path prefix the app is mounted at. Must match vite `base` and the function `path`. */
export const BASE_PATH = '/meeting';
export const API_PREFIX = '/meeting/api';
