import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { KV } from '../../server/lib/ctx';
import { BLOBS_READ_DEADLINE_MS, blobsKV, fileKV, kvSelfTest, LIST_PAGE_SIZE, listKeyPages, memoryKV, type BlobStoreLike } from '../../server/lib/store';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'meeting-kv-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Optimistic increment, the way every list blob in the app is updated. */
async function casIncrement(kv: KV, key: string): Promise<number> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const found = await kv.getJSONWithEtag<{ n: number }>(key);
    const next = (found?.value.n ?? 0) + 1;
    const written = await kv.setJSON(key, { n: next }, found ? { onlyIfMatch: found.etag } : { onlyIfNew: true });
    if (written.modified) return next;
  }
  throw new Error('casIncrement never succeeded');
}

const backends: [string, () => KV][] = [
  ['memoryKV', () => memoryKV()],
  ['fileKV', () => fileKV(tempDir())],
];

describe.each(backends)('%s', (_name, make) => {
  it('returns null for a missing key', async () => {
    const kv = make();
    expect(await kv.getJSON('nope')).toBeNull();
    expect(await kv.getJSONWithEtag('nope')).toBeNull();
    expect(await kv.getBlob('nope')).toBeNull();
  });

  it('round-trips JSON and hands out independent copies', async () => {
    const kv = make();
    const value = { a: 1, nested: { list: [1, 2, 3], text: 'héllo 🌱' }, nothing: null };
    const written = await kv.setJSON('site', value);
    expect(written.modified).toBe(true);
    expect(written.etag).toBeTruthy();

    const first = await kv.getJSON<typeof value>('site');
    expect(first).toEqual(value);
    first!.nested.list.push(99);
    value.a = 2;
    expect(await kv.getJSON('site')).toEqual({ a: 1, nested: { list: [1, 2, 3], text: 'héllo 🌱' }, nothing: null });
  });

  it('stores falsy JSON values as values, not as "missing"', async () => {
    const kv = make();
    await kv.setJSON('zero', 0);
    await kv.setJSON('empty', []);
    await kv.setJSON('no', false);
    expect(await kv.getJSON('zero')).toBe(0);
    expect(await kv.getJSON('empty')).toEqual([]);
    expect(await kv.getJSON('no')).toBe(false);
    expect((await kv.getJSONWithEtag('zero'))?.value).toBe(0);
  });

  it('onlyIfNew writes once and never overwrites', async () => {
    const kv = make();
    const first = await kv.setJSON('claims/a', { at: 'first' }, { onlyIfNew: true });
    const second = await kv.setJSON('claims/a', { at: 'second' }, { onlyIfNew: true });
    expect(first.modified).toBe(true);
    expect(first.etag).toBeTruthy();
    expect(second.modified).toBe(false);
    expect(second.etag).toBeUndefined();
    expect(await kv.getJSON('claims/a')).toEqual({ at: 'first' });
  });

  it('onlyIfMatch writes only against the current etag', async () => {
    const kv = make();
    const created = await kv.setJSON('hosts', [{ id: 1 }]);
    const read = await kv.getJSONWithEtag<unknown[]>('hosts');
    expect(read?.etag).toBe(created.etag);

    const updated = await kv.setJSON('hosts', [{ id: 1 }, { id: 2 }], { onlyIfMatch: read!.etag });
    expect(updated.modified).toBe(true);
    expect(updated.etag).not.toBe(read!.etag);

    const stale = await kv.setJSON('hosts', [{ id: 'lost update' }], { onlyIfMatch: read!.etag });
    expect(stale.modified).toBe(false);
    expect(await kv.getJSON('hosts')).toEqual([{ id: 1 }, { id: 2 }]);

    const again = await kv.setJSON('hosts', [], { onlyIfMatch: updated.etag! });
    expect(again.modified).toBe(true);
  });

  it('onlyIfMatch never creates a missing key', async () => {
    const kv = make();
    const res = await kv.setJSON('ghost', { a: 1 }, { onlyIfMatch: 'some-etag' });
    expect(res.modified).toBe(false);
    expect(await kv.getJSON('ghost')).toBeNull();
  });

  it('rejects ambiguous or unusable conditions instead of writing unconditionally', async () => {
    const kv = make();
    await kv.setJSON('k', 1);
    await expect(kv.setJSON('k', 2, { onlyIfMatch: '' })).rejects.toThrow();
    await expect(kv.setJSON('k', 2, { onlyIfNew: true, onlyIfMatch: 'x' })).rejects.toThrow();
    expect(await kv.getJSON('k')).toBe(1);
  });

  it('rejects invalid keys and values that are not JSON', async () => {
    const kv = make();
    await expect(kv.setJSON('', 1)).rejects.toThrow();
    await expect(kv.setJSON('/leading-slash', 1)).rejects.toThrow();
    await expect(kv.getJSON('')).rejects.toThrow();
    await expect(kv.setJSON('k', undefined)).rejects.toThrow();
    await expect(kv.setJSON('x'.repeat(601), 1)).rejects.toThrow();
  });

  it('delete removes the key and is a no-op for a missing one', async () => {
    const kv = make();
    await kv.setJSON('bookings/b1', { id: 'b1' });
    await kv.delete('bookings/b1');
    await kv.delete('bookings/b1');
    await kv.delete('never-existed');
    expect(await kv.getJSON('bookings/b1')).toBeNull();
    expect(await kv.list('bookings/')).toEqual([]);
    // After a delete the key is "new" again.
    expect((await kv.setJSON('bookings/b1', 1, { onlyIfNew: true })).modified).toBe(true);
  });

  it('lists keys by prefix in ascending order, whatever the insertion order', async () => {
    const kv = make();
    const jobKeys = [
      'jobs/2026-11-17T12:00:00.000Z_job_b',
      'jobs/2026-11-17T09:30:00.000Z_job_z',
      'jobs/2026-12-01T00:00:00.000Z_job_a',
      'jobs/2026-11-17T12:00:00.000Z_job_a',
    ];
    for (const key of jobKeys) await kv.setJSON(key, { key });
    await kv.setJSON('jobsx', 1);
    await kv.setJSON('job', 1);
    await kv.setJSON('index/bookings', []);
    await kv.setBlob('assets/ast_1', new Uint8Array([1]), {});

    expect(await kv.list('jobs/')).toEqual([...jobKeys].sort());
    expect(await kv.list('jobs/2026-11-17')).toHaveLength(3);
    expect(await kv.list('nothing/')).toEqual([]);
    const all = await kv.list('');
    expect(all).toEqual([...all].sort());
    expect(all).toHaveLength(jobKeys.length + 4);
    expect(all).toContain('assets/ast_1');
  });

  it('lists the same keys a page at a time', async () => {
    const kv = make();
    const keys = Array.from({ length: LIST_PAGE_SIZE + 5 }, (_, i) => `rl/slots/${String(i).padStart(6, '0')}/0-60`);
    for (const key of [...keys].reverse()) await kv.setJSON(key, { n: 1 });
    await kv.setJSON('rlx', 1);
    const pages: string[][] = [];
    for await (const page of listKeyPages(kv, 'rl/')) pages.push(page);
    expect(pages.map((p) => p.length)).toEqual([LIST_PAGE_SIZE, 5]);
    expect(pages.flat()).toEqual(await kv.list('rl/'));
    expect(pages.flat()).toEqual(keys);
  });

  it('keeps keys with unusual characters apart and intact', async () => {
    const kv = make();
    const keys = ['a/b', 'a%2Fb', 'a b', 'a.b', '.hidden', 'ünï/cödé', 'star*', 'q?x=1&y=2', 'a/../b', 'CASE', 'x.json', 'x.bin'];
    for (const key of keys) await kv.setJSON(key, { key });
    for (const key of keys) expect(await kv.getJSON(key)).toEqual({ key });
    expect(await kv.list('')).toEqual([...keys].sort());
  });

  it('round-trips binary data and metadata byte for byte', async () => {
    const kv = make();
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 0xff;
    await kv.setBlob('assets/ast_bin', data, { contentType: 'image/png', purpose: 'avatar' });
    data[0] = 123; // the store must have taken its own copy

    const found = await kv.getBlob('assets/ast_bin');
    expect(found).not.toBeNull();
    expect(found!.data).toBeInstanceOf(Uint8Array);
    expect(found!.data.length).toBe(1024);
    const expected = new Uint8Array(256 * 4);
    for (let i = 0; i < expected.length; i++) expected[i] = (i * 7 + (i >> 8)) & 0xff;
    expect(Buffer.from(found!.data).equals(Buffer.from(expected))).toBe(true);
    expect(found!.metadata).toEqual({ contentType: 'image/png', purpose: 'avatar' });

    await kv.setBlob('assets/ast_bin', new Uint8Array([0, 255, 0]), { contentType: 'image/gif' });
    const replaced = await kv.getBlob('assets/ast_bin');
    expect([...replaced!.data]).toEqual([0, 255, 0]);
    expect(replaced!.metadata).toEqual({ contentType: 'image/gif' });

    await kv.delete('assets/ast_bin');
    expect(await kv.getBlob('assets/ast_bin')).toBeNull();
  });

  it('stores an empty blob', async () => {
    const kv = make();
    await kv.setBlob('assets/empty', new Uint8Array(0), {});
    const found = await kv.getBlob('assets/empty');
    expect(found!.data.length).toBe(0);
    expect(found!.metadata).toEqual({});
  });

  it('lets exactly one of many racing onlyIfNew writers win', async () => {
    const kv = make();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => kv.setJSON('claims/race', { winner: i }, { onlyIfNew: true })));
    expect(results.filter((r) => r.modified)).toHaveLength(1);
    const winner = results.findIndex((r) => r.modified);
    expect(await kv.getJSON('claims/race')).toEqual({ winner });
  });

  it('passes the storage self test and leaves nothing behind', async () => {
    const kv = make();
    await kv.setJSON('site', { keep: true });
    expect(await kvSelfTest(kv, 'st_run1')).toEqual({ ok: true });
    expect(await kv.list('')).toEqual(['site']);
  });

  it('loses no update when many writers increment through compare-and-swap', async () => {
    const kv = make();
    const results = await Promise.all(Array.from({ length: 30 }, () => casIncrement(kv, 'counter')));
    expect(await kv.getJSON('counter')).toEqual({ n: 30 });
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});

describe('fileKV on disk', () => {
  it('persists across instances and derives the etag from the content', async () => {
    const dir = tempDir();
    const first = fileKV(dir);
    const written = await first.setJSON('site', { name: 'Jimi' });
    await first.setBlob('assets/a', new Uint8Array([9, 8, 7]), { contentType: 'image/webp' });

    const second = fileKV(dir);
    expect(await second.getJSON('site')).toEqual({ name: 'Jimi' });
    expect((await second.getJSONWithEtag('site'))?.etag).toBe(written.etag);
    expect([...(await second.getBlob('assets/a'))!.data]).toEqual([9, 8, 7]);

    // Same content, same etag: a compare-and-swap from the other instance still lines up.
    const swapped = await second.setJSON('site', { name: 'Jimi Cohen' }, { onlyIfMatch: written.etag! });
    expect(swapped.modified).toBe(true);
    expect(await first.getJSON('site')).toEqual({ name: 'Jimi Cohen' });
  });

  it('never writes outside its directory and leaves no temp files behind', async () => {
    const parent = tempDir();
    const dir = path.join(parent, 'data');
    const kv = fileKV(dir);
    await kv.setJSON('../escape', { a: 1 });
    await kv.setJSON('a/../../escape2', { a: 2 });
    await kv.setJSON('once', 1, { onlyIfNew: true });
    await kv.setJSON('once', 2, { onlyIfNew: true });

    expect(readdirSync(parent)).toEqual(['data']);
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toHaveLength(3);
    expect(await kv.getJSON('../escape')).toEqual({ a: 1 });
  });

  it('ignores files it did not create when listing', async () => {
    const dir = tempDir();
    const kv = fileKV(dir);
    await kv.setJSON('real', 1);
    writeFileSync(path.join(dir, 'README.txt'), 'hello');
    writeFileSync(path.join(dir, '.DS_Store'), '');
    writeFileSync(path.join(dir, '%E0%A4%A.json'), '{}'); // broken percent-encoding
    expect(await kv.list('')).toEqual(['real']);
  });

  it('recovers when the data directory is removed while in use', async () => {
    const dir = path.join(tempDir(), 'data');
    const kv = fileKV(dir);
    await kv.setJSON('before', 1);
    rmSync(dir, { recursive: true, force: true });

    expect(await kv.getJSON('before')).toBeNull();
    expect(await kv.list('')).toEqual([]);
    expect((await kv.setJSON('after', 2, { onlyIfNew: true })).modified).toBe(true);
    await kv.setBlob('assets/a', new Uint8Array([1]), {});
    expect(await kv.list('')).toEqual(['after', 'assets/a']);
  });

  it('creates the data directory when it is missing', async () => {
    const dir = path.join(tempDir(), 'deep', 'er', 'data');
    const kv = fileKV(dir);
    await kv.setJSON('k', { ok: true });
    expect(await kv.getJSON('k')).toEqual({ ok: true });
  });
});

/** In-memory imitation of the @netlify/blobs Store that records how it was called. */
function fakeBlobStore(pageSize = 2) {
  const entries = new Map<string, { body: string | ArrayBuffer; etag: string; metadata: Record<string, unknown> }>();
  const calls: { op: string; key?: string; options?: unknown }[] = [];
  let version = 0;
  const nextEtag = () => `"etag-${++version}"`;

  const store: BlobStoreLike = {
    async get(key, options) {
      calls.push({ op: 'get', key, options });
      const entry = entries.get(key);
      return entry ? JSON.parse(entry.body as string) : null;
    },
    async getWithMetadata(key, options) {
      calls.push({ op: 'getWithMetadata', key, options });
      const entry = entries.get(key);
      if (!entry) return null;
      const data = options.type === 'json' ? JSON.parse(entry.body as string) : entry.body;
      return { data, etag: entry.etag, metadata: entry.metadata };
    },
    async setJSON(key, data, options) {
      calls.push({ op: 'setJSON', key, options });
      const current = entries.get(key);
      if (options?.onlyIfNew && current) return { modified: false };
      if (options?.onlyIfMatch !== undefined && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = nextEtag();
      entries.set(key, { body: JSON.stringify(data), etag, metadata: {} });
      return { modified: true, etag };
    },
    async set(key, data, options) {
      calls.push({ op: 'set', key, options });
      const etag = nextEtag();
      entries.set(key, { body: data, etag, metadata: options?.metadata ?? {} });
      return { modified: true, etag };
    },
    async delete(key) {
      calls.push({ op: 'delete', key });
      entries.delete(key);
    },
    list(options) {
      calls.push({ op: 'list', options });
      // Deliberately unsorted, and split into small pages like the real API does.
      const keys = [...entries.keys()].filter((k) => k.startsWith(options.prefix ?? '')).reverse();
      return (async function* () {
        for (let i = 0; i < keys.length; i += pageSize) yield { blobs: keys.slice(i, i + pageSize).map((key) => ({ key })) };
      })();
    },
  };
  return { store, calls, entries };
}

describe('blobsKV adapter', () => {
  it('opens the store lazily and only once', async () => {
    const fake = fakeBlobStore();
    let opened = 0;
    const kv = blobsKV('meeting', () => {
      opened++;
      return fake.store;
    });
    expect(opened).toBe(0);
    await kv.getJSON('a');
    await kv.setJSON('a', 1);
    await kv.list('');
    expect(opened).toBe(1);
  });

  it('maps onlyIfNew and onlyIfMatch onto conditional writes and reports modified', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => fake.store);

    const created = await kv.setJSON('index/bookings', [1], { onlyIfNew: true });
    expect(created).toEqual({ modified: true, etag: '"etag-1"' });
    expect(await kv.setJSON('index/bookings', [2], { onlyIfNew: true })).toEqual({ modified: false });

    const read = await kv.getJSONWithEtag<number[]>('index/bookings');
    expect(read).toEqual({ value: [1], etag: '"etag-1"' });

    const swapped = await kv.setJSON('index/bookings', [1, 2], { onlyIfMatch: read!.etag });
    expect(swapped.modified).toBe(true);
    expect(await kv.setJSON('index/bookings', [3], { onlyIfMatch: read!.etag })).toEqual({ modified: false });
    expect(await kv.getJSON('index/bookings')).toEqual([1, 2]);

    await kv.setJSON('plain', { a: 1 });
    const setCalls = fake.calls.filter((c) => c.op === 'setJSON').map((c) => c.options);
    expect(setCalls).toEqual([{ onlyIfNew: true }, { onlyIfNew: true }, { onlyIfMatch: '"etag-1"' }, { onlyIfMatch: '"etag-1"' }, undefined]);
  });

  it('never turns a broken condition into an unconditional write', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => fake.store);
    await kv.setJSON('k', 1);
    await expect(kv.setJSON('k', 2, { onlyIfMatch: '' })).rejects.toThrow();
    await expect(kv.setJSON('k', 2, { onlyIfNew: true, onlyIfMatch: 'x' })).rejects.toThrow();
    expect(await kv.getJSON('k')).toBe(1);
  });

  it('fails loudly when the store returns no etag, because compare-and-swap would be meaningless', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => ({
      ...fake.store,
      getWithMetadata: async () => ({ data: { a: 1 }, etag: undefined, metadata: {} }),
    }));
    await expect(kv.getJSONWithEtag('k')).rejects.toThrow(/etag/);
  });

  it('reads every page of a listing and returns sorted keys', async () => {
    const fake = fakeBlobStore(2);
    const kv = blobsKV('meeting', () => fake.store);
    const keys = ['jobs/5', 'jobs/1', 'jobs/3', 'jobs/2', 'jobs/4', 'bookings/x', 'jobs/7', 'jobs/6'];
    for (const key of keys) await kv.setJSON(key, 1);

    expect(await kv.list('jobs/')).toEqual(['jobs/1', 'jobs/2', 'jobs/3', 'jobs/4', 'jobs/5', 'jobs/6', 'jobs/7']);
    expect(await kv.list('')).toEqual([...keys].sort());
    const listCalls = fake.calls.filter((c) => c.op === 'list').map((c) => c.options);
    expect(listCalls).toEqual([{ prefix: 'jobs/', paginate: true }, { paginate: true }]);
  });

  it('hands out a listing page by page and asks for no page nobody wants', async () => {
    const fake = fakeBlobStore(2);
    let fetched = 0;
    const kv = blobsKV('meeting', () => ({
      ...fake.store,
      list: (options) =>
        (async function* () {
          for await (const page of fake.store.list(options)) {
            fetched++;
            yield page;
          }
        })(),
    }));
    for (const key of ['rl/a', 'rl/b', 'rl/c', 'rl/d', 'rl/e', 'site']) await kv.setJSON(key, 1);
    const seen: string[][] = [];
    for await (const page of listKeyPages(kv, 'rl/')) {
      seen.push(page);
      if (seen.length === 2) break;
    }
    expect(seen.flat()).toHaveLength(4);
    expect(fetched).toBe(2);
    // Read to the end, it is the same listing as list().
    const all: string[] = [];
    for await (const page of kv.listPages!('rl/')) all.push(...page);
    expect(all.sort()).toEqual(await kv.list('rl/'));
  });

  it('listKeyPages works with a store that can only list everything at once', async () => {
    const inner = memoryKV();
    await inner.setJSON('rl/a', 1);
    await inner.setJSON('rl/b', 1);
    const { listPages: _unused, ...withoutPages } = inner;
    const pages: string[][] = [];
    for await (const page of listKeyPages(withoutPages, 'rl/')) pages.push(page);
    expect(pages).toEqual([['rl/a', 'rl/b']]);
  });

  it('round-trips binary data as an ArrayBuffer with string metadata', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => fake.store);
    // A view into a larger buffer: only the viewed bytes may be stored.
    const backing = new Uint8Array([99, 1, 2, 3, 255, 99]);
    const view = backing.subarray(1, 5);
    await kv.setBlob('assets/ast_1', view, { contentType: 'image/png', purpose: 'logo' });

    const stored = fake.entries.get('assets/ast_1')!;
    expect(stored.body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(stored.body as ArrayBuffer)]).toEqual([1, 2, 3, 255]);

    const found = await kv.getBlob('assets/ast_1');
    expect([...found!.data]).toEqual([1, 2, 3, 255]);
    expect(found!.metadata).toEqual({ contentType: 'image/png', purpose: 'logo' });
    expect(await kv.getBlob('assets/missing')).toBeNull();
  });

  it('coerces non-string metadata coming back from the store', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => ({
      ...fake.store,
      getWithMetadata: async () => ({ data: new ArrayBuffer(2), etag: '"e"', metadata: { contentType: 'image/png', size: 2, gone: null } }),
    }));
    expect((await kv.getBlob('assets/x'))!.metadata).toEqual({ contentType: 'image/png', size: '2' });
  });

  it('sends a weakened etag back in its strong form, the only form If-Match can match', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => ({
      ...fake.store,
      getWithMetadata: async (key, options) => {
        const found = await fake.store.getWithMetadata(key, options);
        return found ? { ...found, etag: `W/${found.etag}` } : null;
      },
    }));
    await kv.setJSON('hosts', [1]);
    const read = await kv.getJSONWithEtag('hosts');
    expect(read?.etag).toBe('"etag-1"');
    expect((await kv.setJSON('hosts', [1, 2], { onlyIfMatch: read!.etag })).modified).toBe(true);
  });

  it('gives up on a read that hangs (the client retrying a failing store), with a plain error', async () => {
    expect(BLOBS_READ_DEADLINE_MS).toBe(8000);
    const fake = fakeBlobStore();
    await fake.store.setJSON('k', { a: 1 });
    // Like @netlify/blobs during an outage: it keeps retrying, five seconds apart, and answers much later.
    const slow = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(work()), 400));
    const kv = blobsKV(
      'meeting',
      () => ({
        ...fake.store,
        get: (key, options) => slow(() => fake.store.get(key, options)),
        getWithMetadata: (key, options) => slow(() => fake.store.getWithMetadata(key, options)),
        list: (options) =>
          (async function* () {
            await slow(async () => undefined);
            yield* fake.store.list(options);
          })(),
      }),
      { readDeadlineMs: 40 },
    );
    for (const [name, read] of [
      ['getJSON', () => kv.getJSON('k')],
      ['getJSONWithEtag', () => kv.getJSONWithEtag('k')],
      ['getBlob', () => kv.getBlob('assets/x')],
      ['list', () => kv.list('')],
    ] as const) {
      const started = Date.now();
      await expect(read(), name).rejects.toThrow(/did not answer within/);
      expect(Date.now() - started, name).toBeLessThan(300);
    }
  });

  it('never puts a deadline on a write: a conditional write that lands late must not look failed', async () => {
    const fake = fakeBlobStore();
    const late = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(work()), 120));
    const kv = blobsKV(
      'meeting',
      () => ({
        ...fake.store,
        setJSON: (key, data, options) => late(() => fake.store.setJSON(key, data, options)),
        delete: (key) => late(() => fake.store.delete(key)),
      }),
      { readDeadlineMs: 20 },
    );
    await expect(kv.setJSON('claims/x', { at: 'now' }, { onlyIfNew: true })).resolves.toMatchObject({ modified: true });
    await expect(kv.setJSON('claims/x', { at: 'again' }, { onlyIfNew: true })).resolves.toEqual({ modified: false });
    // A quick read is not affected by the deadline.
    expect(await kv.getJSON('claims/x')).toEqual({ at: 'now' });
    await expect(kv.delete('claims/x')).resolves.toBeUndefined();
    expect(await kv.getJSON('claims/x')).toBeNull();
  });

  it('returns null for missing JSON and deletes through the store', async () => {
    const fake = fakeBlobStore();
    const kv = blobsKV('meeting', () => fake.store);
    expect(await kv.getJSON('nope')).toBeNull();
    expect(await kv.getJSONWithEtag('nope')).toBeNull();
    await kv.setJSON('k', 1);
    await kv.delete('k');
    expect(await kv.getJSON('k')).toBeNull();
    expect(fake.calls.some((c) => c.op === 'delete' && c.key === 'k')).toBe(true);
  });
});

describe('kvSelfTest', () => {
  /** memoryKV with one guarantee deliberately broken. */
  function broken(overrides: (inner: KV) => Partial<KV>): KV {
    const inner = memoryKV();
    return { ...inner, ...overrides(inner) };
  }

  it('catches a store that ignores create-only writes', async () => {
    const kv = broken((inner) => ({ setJSON: (key, value, opts) => inner.setJSON(key, value, opts?.onlyIfNew ? undefined : opts) }));
    const result = await kvSelfTest(kv, 'st_1');
    expect(result).toEqual({ ok: false, failed: 'create-only write replaced an existing key' });
    expect(await kv.list('selftest/')).toEqual([]);
  });

  it('catches a store that ignores compare-and-swap conditions', async () => {
    const kv = broken((inner) => ({ setJSON: (key, value, opts) => inner.setJSON(key, value, opts?.onlyIfMatch ? undefined : opts) }));
    expect(await kvSelfTest(kv, 'st_2')).toEqual({ ok: false, failed: 'compare-and-swap with a stale etag went through' });
  });

  it('catches a store that refuses every conditional write', async () => {
    const kv = broken((inner) => ({
      setJSON: async (key, value, opts) => (opts?.onlyIfMatch ? { modified: false } : inner.setJSON(key, value, opts)),
    }));
    expect(await kvSelfTest(kv, 'st_3')).toEqual({ ok: false, failed: 'compare-and-swap with the current etag was refused' });
  });

  it('catches reads that lag behind writes (eventual consistency)', async () => {
    const kv = broken(() => ({ getJSONWithEtag: async () => null }));
    expect(await kvSelfTest(kv, 'st_4')).toEqual({ ok: false, failed: 'a write was not visible to the next read' });
  });

  it('reports the step when the backend throws, and still tries to clean up', async () => {
    const deleted: string[] = [];
    const kv = broken((inner) => ({
      getJSONWithEtag: async () => {
        throw new Error('Blob store returned no etag for "selftest/st_5"');
      },
      delete: async (key) => {
        deleted.push(key);
        return inner.delete(key);
      },
    }));
    const result = await kvSelfTest(kv, 'st_5');
    expect(result).toEqual({ ok: false, failed: 'read threw', error: 'Blob store returned no etag for "selftest/st_5"' });
    expect(deleted).toEqual(['selftest/st_5']);
    expect(await kv.list('')).toEqual([]);
  });

  it('never throws, even when nothing works', async () => {
    const dead: KV = {
      getJSON: async () => Promise.reject(new Error('down')),
      getJSONWithEtag: async () => Promise.reject(new Error('down')),
      setJSON: async () => Promise.reject(new Error('down')),
      delete: async () => Promise.reject(new Error('down')),
      list: async () => Promise.reject(new Error('down')),
      getBlob: async () => Promise.reject(new Error('down')),
      setBlob: async () => Promise.reject(new Error('down')),
    };
    expect(await kvSelfTest(dead, 'st_6')).toEqual({ ok: false, failed: 'create threw', error: 'down' });
  });
});
