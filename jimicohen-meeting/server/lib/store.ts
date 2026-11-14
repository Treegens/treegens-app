/**
 * The three KV backends behind `Ctx.kv`:
 *   memoryKV : tests
 *   fileKV   : local dev server, one file per key
 *   blobsKV  : production, Netlify Blobs with strong consistency
 * All three share the same semantics: one key namespace, conditional writes (onlyIfNew /
 * onlyIfMatch) that report `modified: false` instead of throwing, sorted `list`.
 */
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getStore } from '@netlify/blobs';
import type { KV, KVSetOptions } from './ctx';

// ───────────────────────── shared rules ─────────────────────────

/** Same limits as Netlify Blobs, enforced everywhere so a bad key fails in tests, not in production. */
function assertKey(key: string): void {
  if (typeof key !== 'string' || key === '') throw new Error('KV key must not be empty');
  if (key.startsWith('/')) throw new Error(`KV key must not start with "/": ${key}`);
  if (Buffer.byteLength(key, 'utf8') > 600) throw new Error('KV key is longer than 600 bytes');
}

type Condition = { kind: 'none' } | { kind: 'new' } | { kind: 'match'; etag: string };

function conditionOf(opts?: KVSetOptions): Condition {
  const wantsNew = opts?.onlyIfNew === true;
  const wantsMatch = opts?.onlyIfMatch !== undefined && opts?.onlyIfMatch !== null;
  if (wantsNew && wantsMatch) throw new Error('KV: onlyIfNew and onlyIfMatch cannot be combined');
  if (wantsMatch) {
    // An empty etag must never degrade into an unconditional write.
    if (typeof opts!.onlyIfMatch !== 'string' || opts!.onlyIfMatch === '') throw new Error('KV: onlyIfMatch needs a non-empty etag');
    return { kind: 'match', etag: opts!.onlyIfMatch };
  }
  return wantsNew ? { kind: 'new' } : { kind: 'none' };
}

function serialize(key: string, value: unknown): string {
  const body = JSON.stringify(value);
  if (body === undefined) throw new Error(`KV: value for "${key}" cannot be stored as JSON`);
  return body;
}

function parse<T>(key: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`KV: stored value for "${key}" is not valid JSON`);
  }
}

function contentEtag(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

function cleanMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

// ───────────────────────── memory ─────────────────────────

type MemoryEntry = { kind: 'json'; body: string; etag: string } | { kind: 'blob'; data: Uint8Array; metadata: Record<string, string>; etag: string };

export function memoryKV(): KV {
  const entries = new Map<string, MemoryEntry>();

  const jsonEntry = (key: string): { body: string; etag: string } | null => {
    assertKey(key);
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.kind !== 'json') throw new Error(`KV: "${key}" holds binary data, not JSON`);
    return entry;
  };

  return {
    async getJSON<T>(key: string): Promise<T | null> {
      const entry = jsonEntry(key);
      return entry ? parse<T>(key, entry.body) : null;
    },
    async getJSONWithEtag<T>(key: string): Promise<{ value: T; etag: string } | null> {
      const entry = jsonEntry(key);
      return entry ? { value: parse<T>(key, entry.body), etag: entry.etag } : null;
    },
    async setJSON(key: string, value: unknown, opts?: KVSetOptions): Promise<{ modified: boolean; etag?: string }> {
      assertKey(key);
      const condition = conditionOf(opts);
      const body = serialize(key, value);
      const current = entries.get(key);
      if (condition.kind === 'new' && current) return { modified: false };
      if (condition.kind === 'match' && (!current || current.etag !== condition.etag)) return { modified: false };
      const etag = contentEtag(body);
      entries.set(key, { kind: 'json', body, etag });
      return { modified: true, etag };
    },
    async delete(key: string): Promise<void> {
      assertKey(key);
      entries.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      return [...entries.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async getBlob(key: string): Promise<{ data: Uint8Array; metadata: Record<string, string> } | null> {
      assertKey(key);
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.kind !== 'blob') throw new Error(`KV: "${key}" holds JSON, not binary data`);
      return { data: new Uint8Array(entry.data), metadata: { ...entry.metadata } };
    },
    async setBlob(key: string, data: Uint8Array, metadata: Record<string, string>): Promise<void> {
      assertKey(key);
      const copy = new Uint8Array(data);
      entries.set(key, { kind: 'blob', data: copy, metadata: cleanMetadata(metadata), etag: contentEtag(copy) });
    },
  };
}

// ───────────────────────── files (dev) ─────────────────────────

const JSON_EXT = '.json';
const BLOB_EXT = '.bin';
const META_EXT = '.meta';
const MAX_FILE_NAME_BYTES = 240;

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function isExisting(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * One flat directory, file name = percent-encoded key + extension, so no key can escape the
 * directory. Values are plain JSON files you can open while debugging; etag = content hash.
 * Every operation is synchronous inside, which makes each one atomic within the dev server
 * process; writes go through a temp file so a reader never sees half a value.
 */
export function fileKV(dir: string): KV {
  const root = path.resolve(dir);
  mkdirSync(root, { recursive: true });
  let tmpCounter = 0;

  const fileFor = (key: string, ext: string): string => {
    assertKey(key);
    const name = encodeURIComponent(key).replace(/\*/g, '%2A');
    if (Buffer.byteLength(name, 'utf8') > MAX_FILE_NAME_BYTES) throw new Error(`fileKV: key is too long for a file name: ${key}`);
    return path.join(root, name + ext);
  };

  const readText = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  };

  const tmpPath = (): string => path.join(root, `.${process.pid}-${++tmpCounter}.tmp`);

  const writeAtomic = (file: string, body: string | Uint8Array): void => {
    const tmp = tmpPath();
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  };

  /** Creates the file with its full content in one step, or reports false when it already exists. */
  const createExclusive = (file: string, body: string): boolean => {
    const tmp = tmpPath();
    writeFileSync(tmp, body);
    try {
      linkSync(tmp, file);
      return true;
    } catch (err) {
      if (isExisting(err)) return false;
      throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  return {
    async getJSON<T>(key: string): Promise<T | null> {
      const body = readText(fileFor(key, JSON_EXT));
      return body === null ? null : parse<T>(key, body);
    },
    async getJSONWithEtag<T>(key: string): Promise<{ value: T; etag: string } | null> {
      const body = readText(fileFor(key, JSON_EXT));
      return body === null ? null : { value: parse<T>(key, body), etag: contentEtag(body) };
    },
    async setJSON(key: string, value: unknown, opts?: KVSetOptions): Promise<{ modified: boolean; etag?: string }> {
      const file = fileFor(key, JSON_EXT);
      const condition = conditionOf(opts);
      const body = serialize(key, value);
      const etag = contentEtag(body);
      if (condition.kind === 'new') {
        return createExclusive(file, body) ? { modified: true, etag } : { modified: false };
      }
      if (condition.kind === 'match') {
        const current = readText(file);
        if (current === null || contentEtag(current) !== condition.etag) return { modified: false };
      }
      writeAtomic(file, body);
      return { modified: true, etag };
    },
    async delete(key: string): Promise<void> {
      for (const ext of [JSON_EXT, BLOB_EXT, BLOB_EXT + META_EXT]) rmSync(fileFor(key, ext), { force: true });
    },
    async list(prefix: string): Promise<string[]> {
      const keys = new Set<string>();
      for (const name of readdirSync(root)) {
        const ext = name.endsWith(JSON_EXT) ? JSON_EXT : name.endsWith(BLOB_EXT) ? BLOB_EXT : null;
        if (!ext || name.startsWith('.')) continue;
        let key: string;
        try {
          key = decodeURIComponent(name.slice(0, -ext.length));
        } catch {
          continue; // not one of ours
        }
        if (key.startsWith(prefix)) keys.add(key);
      }
      return [...keys].sort();
    },
    async getBlob(key: string): Promise<{ data: Uint8Array; metadata: Record<string, string> } | null> {
      const file = fileFor(key, BLOB_EXT);
      let data: Buffer;
      try {
        data = readFileSync(file);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
      const meta = readText(file + META_EXT);
      return { data: new Uint8Array(data), metadata: meta === null ? {} : cleanMetadata(parse<Record<string, unknown>>(key, meta)) };
    },
    async setBlob(key: string, data: Uint8Array, metadata: Record<string, string>): Promise<void> {
      const file = fileFor(key, BLOB_EXT);
      // Metadata first: a reader that finds the data file always finds its metadata too.
      writeAtomic(file + META_EXT, JSON.stringify(cleanMetadata(metadata)));
      writeAtomic(file, data);
    },
  };
}

// ───────────────────────── Netlify Blobs (production) ─────────────────────────

/** The part of the @netlify/blobs Store this adapter relies on (lets tests pass a fake). */
export interface BlobStoreLike {
  get(key: string, options: { type: 'json' }): Promise<unknown>;
  getWithMetadata(
    key: string,
    options: { type: 'json' | 'arrayBuffer' },
  ): Promise<{ data: unknown; etag?: string; metadata: Record<string, unknown> } | null>;
  setJSON(key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<{ modified: boolean; etag?: string }>;
  set(key: string, data: ArrayBuffer, options?: { metadata?: Record<string, unknown> }): Promise<{ modified: boolean; etag?: string }>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; paginate: true }): AsyncIterable<{ blobs: { key: string }[] }>;
}

function openNetlifyStore(name: string): BlobStoreLike {
  // Strong consistency: a read right after a write must see it, or the compare-and-swap loops are meaningless.
  return getStore({ name, consistency: 'strong' }) as unknown as BlobStoreLike;
}

/**
 * `storeFactory` exists for tests. The store is opened on first use, not at construction:
 * Netlify only provides the Blobs credentials once an invocation is running.
 */
export function blobsKV(storeName = 'meeting', storeFactory?: () => BlobStoreLike): KV {
  let cached: BlobStoreLike | null = null;
  const store = (): BlobStoreLike => {
    if (!cached) cached = storeFactory ? storeFactory() : openNetlifyStore(storeName);
    return cached;
  };

  return {
    async getJSON<T>(key: string): Promise<T | null> {
      assertKey(key);
      const value = await store().get(key, { type: 'json' });
      return value === undefined || value === null ? null : (value as T);
    },
    async getJSONWithEtag<T>(key: string): Promise<{ value: T; etag: string } | null> {
      assertKey(key);
      const found = await store().getWithMetadata(key, { type: 'json' });
      if (!found || found.data === null || found.data === undefined) return null;
      if (!found.etag) throw new Error(`Blob store returned no etag for "${key}"`);
      return { value: found.data as T, etag: found.etag };
    },
    async setJSON(key: string, value: unknown, opts?: KVSetOptions): Promise<{ modified: boolean; etag?: string }> {
      assertKey(key);
      const condition = conditionOf(opts);
      serialize(key, value); // fail early and clearly on values JSON cannot represent
      const options = condition.kind === 'new' ? { onlyIfNew: true } : condition.kind === 'match' ? { onlyIfMatch: condition.etag } : undefined;
      const result = await store().setJSON(key, value, options);
      return result.modified ? { modified: true, etag: result.etag || undefined } : { modified: false };
    },
    async delete(key: string): Promise<void> {
      assertKey(key);
      await store().delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      // `paginate: true` hands back one page per iteration; walking the iterator to its end reads every page.
      for await (const page of store().list(prefix ? { prefix, paginate: true } : { paginate: true })) {
        for (const blob of page.blobs) keys.push(blob.key);
      }
      return [...new Set(keys)].sort();
    },
    async getBlob(key: string): Promise<{ data: Uint8Array; metadata: Record<string, string> } | null> {
      assertKey(key);
      const found = await store().getWithMetadata(key, { type: 'arrayBuffer' });
      if (!found || found.data === null || found.data === undefined) return null;
      return { data: new Uint8Array(found.data as ArrayBuffer), metadata: cleanMetadata(found.metadata) };
    },
    async setBlob(key: string, data: Uint8Array, metadata: Record<string, string>): Promise<void> {
      assertKey(key);
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      await store().set(key, buffer, { metadata: cleanMetadata(metadata) });
    },
  };
}
