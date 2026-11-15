/**
 * blobsKV against the REAL @netlify/blobs client, talking HTTP to the local Blobs server that
 * ships with the library. This pins the adapter to the library's actual behaviour (option names,
 * `modified` on refused conditional writes, pagination, binary bodies, metadata), so a library
 * upgrade that changes any of it fails here instead of in production.
 *
 * Not covered here: `getJSONWithEtag`. The local server sends no ETag on reads (Netlify's edge
 * does), and its etags have millisecond resolution, so compare-and-swap is checked with the etag
 * returned by the write and with pauses between writes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getStore } from '@netlify/blobs';
import { BlobsServer } from '@netlify/blobs/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KV } from '../../server/lib/ctx';
import { blobsKV, type BlobStoreLike } from '../../server/lib/store';

const TOKEN = 'local-test-token';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir = '';
let server: BlobsServer;
let kv: KV;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'meeting-blobs-'));
  server = new BlobsServer({ directory: dir, token: TOKEN });
  const { port } = await server.start();
  const url = `http://localhost:${port}`;
  kv = blobsKV('meeting', () => getStore({ name: 'meeting', siteID: 'site-under-test', token: TOKEN, edgeURL: url, uncachedEdgeURL: url, consistency: 'strong' }) as unknown as BlobStoreLike);
});

afterAll(async () => {
  await server?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('blobsKV with the real @netlify/blobs client', () => {
  it('reads missing keys as null', async () => {
    expect(await kv.getJSON('missing')).toBeNull();
    expect(await kv.getJSONWithEtag('missing')).toBeNull();
    expect(await kv.getBlob('missing')).toBeNull();
  });

  it('round-trips JSON, including falsy values', async () => {
    await kv.setJSON('site', { name: 'Jimi', nested: { list: [1, 2, 3] }, text: 'héllo 🌱' });
    expect(await kv.getJSON('site')).toEqual({ name: 'Jimi', nested: { list: [1, 2, 3] }, text: 'héllo 🌱' });
    await kv.setJSON('zero', 0);
    await kv.setJSON('empty-list', []);
    expect(await kv.getJSON('zero')).toBe(0);
    expect(await kv.getJSON('empty-list')).toEqual([]);
  });

  it('create-only writes succeed once and report modified: false afterwards', async () => {
    const first = await kv.setJSON('claims/job-1-0', { at: 'first' }, { onlyIfNew: true });
    expect(first.modified).toBe(true);
    expect(first.etag).toBeTruthy();
    expect(await kv.setJSON('claims/job-1-0', { at: 'second' }, { onlyIfNew: true })).toEqual({ modified: false });
    expect(await kv.getJSON('claims/job-1-0')).toEqual({ at: 'first' });
  });

  it('compare-and-swap writes only against the current etag', async () => {
    const created = await kv.setJSON('index/bookings', [{ id: 'bkg_1' }], { onlyIfNew: true });
    await pause(20);
    const swapped = await kv.setJSON('index/bookings', [{ id: 'bkg_1' }, { id: 'bkg_2' }], { onlyIfMatch: created.etag! });
    expect(swapped.modified).toBe(true);
    expect(swapped.etag).not.toBe(created.etag);
    await pause(20);
    expect(await kv.setJSON('index/bookings', [{ id: 'lost update' }], { onlyIfMatch: created.etag! })).toEqual({ modified: false });
    expect(await kv.getJSON('index/bookings')).toEqual([{ id: 'bkg_1' }, { id: 'bkg_2' }]);
    expect(await kv.setJSON('never-created', 1, { onlyIfMatch: created.etag! })).toEqual({ modified: false });
    expect(await kv.getJSON('never-created')).toBeNull();
  });

  it('lists by prefix in ascending order, with keys that carry timestamps', async () => {
    const keys = ['jobs/2026-11-17T12:00:00.000Z_job_b', 'jobs/2026-11-17T09:30:00.000Z_job_z', 'jobs/2026-12-01T00:00:00.000Z_job_a'];
    for (const key of keys) await kv.setJSON(key, { key });
    expect(await kv.list('jobs/')).toEqual([...keys].sort());
    for (const key of keys) expect(await kv.getJSON(key)).toEqual({ key });
    const all = await kv.list('');
    expect(all).toEqual([...all].sort());
    expect(all).toEqual(expect.arrayContaining(['site', 'index/bookings', ...keys]));
  });

  it('hands out the same listing a page at a time', async () => {
    const keys = ['rl/slots/a/1-60', 'rl/slots/b/1-60', 'rl/login/c/1-600'];
    for (const key of keys) await kv.setJSON(key, { n: 1 });
    const paged: string[] = [];
    for await (const page of kv.listPages!('rl/')) paged.push(...page);
    expect(paged.sort()).toEqual(await kv.list('rl/'));
    expect(paged).toEqual([...keys].sort());
  });

  it('round-trips binary data with its metadata', async () => {
    const data = new Uint8Array(512);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff;
    await kv.setBlob('assets/ast_real', data, { contentType: 'image/png', purpose: 'cover' });
    const found = await kv.getBlob('assets/ast_real');
    expect(Buffer.from(found!.data).equals(Buffer.from(data))).toBe(true);
    expect(found!.metadata).toEqual({ contentType: 'image/png', purpose: 'cover' });
  });

  it('deletes keys and tolerates deleting missing ones', async () => {
    await kv.setJSON('bookings/bkg_gone', { id: 'bkg_gone' });
    await kv.delete('bookings/bkg_gone');
    await kv.delete('bookings/bkg_gone');
    expect(await kv.getJSON('bookings/bkg_gone')).toBeNull();
    expect(await kv.list('bookings/')).toEqual([]);
  });
});
