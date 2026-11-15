/**
 * The storage pieces the short links and brands rest on (repo.updateSite, updateEventTypes, the brand kept
 * by saveEventType) and the browser client's new calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newEventType } from '../../shared/defaults';
import type { SiteSettings } from '../../shared/types';
import type { KV } from '../../server/lib/ctx';
import * as repo from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import * as api from '../../src/lib/api';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

const ECO = 'brand_eco_champions';

describe('repo.updateSite', () => {
  it('runs again on what somebody else wrote in between, so both changes land', async () => {
    const ctx = makeTestCtx();
    await repo.getSite(ctx);
    const setJSON = ctx.kv.setJSON.bind(ctx.kv);
    let raced = false;
    ctx.kv.setJSON = (async (key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => {
      if (key === 'site' && o?.onlyIfMatch && !raced) {
        raced = true;
        const now = (await ctx.kv.getJSON<SiteSettings>('site'))!;
        await setJSON('site', { ...now, profile: { ...now.profile, headline: 'Written in between' } });
      }
      return setJSON(key, value, o);
    }) as KV['setJSON'];
    let runs = 0;
    const saved = await repo.updateSite(ctx, (fresh) => {
      runs++;
      return { ...fresh, shortLinks: { pod: 'evt_x' } };
    });
    expect(runs).toBe(2);
    expect(saved.shortLinks).toEqual({ pod: 'evt_x' });
    expect(saved.profile.headline).toBe('Written in between');
    expect(await repo.getSite(ctx)).toEqual(saved);
  });

  it('two updates at the same moment both land', async () => {
    const kv = memoryKV();
    const a = makeTestCtx({ kv });
    const b = makeTestCtx({ kv });
    await repo.getSite(a);
    await Promise.all([
      repo.updateSite(a, (s) => ({ ...s, shortLinks: { ...(s.shortLinks ?? {}), meet: 'evt_meeting' } })),
      repo.updateSite(b, (s) => ({ ...s, shortLinks: { ...(s.shortLinks ?? {}), pod: 'evt_pod' } })),
    ]);
    expect((await repo.getSite(a)).shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_pod' });
  });

  it('recognises its own write when the store lost the answer', async () => {
    const ctx = makeTestCtx();
    await repo.getSite(ctx);
    const setJSON = ctx.kv.setJSON.bind(ctx.kv);
    let lied = false;
    ctx.kv.setJSON = (async (key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => {
      const written = await setJSON(key, value, o);
      if (key === 'site' && !lied) {
        lied = true;
        return { ...written, modified: false };
      }
      return written;
    }) as KV['setJSON'];
    let runs = 0;
    await repo.updateSite(ctx, (fresh) => {
      runs++;
      return { ...fresh, profile: { ...fresh.profile, headline: `${fresh.profile.headline}!` } };
    });
    // Not applied a second time on top of itself.
    expect(runs).toBe(1);
    expect((await repo.getSite(ctx)).profile.headline).toBe('Book time with Jimi!');
  });

  it('gives up with 503 busy after 16 lost rounds', async () => {
    const ctx = makeTestCtx();
    await repo.getSite(ctx);
    const setJSON = ctx.kv.setJSON.bind(ctx.kv);
    ctx.kv.setJSON = (async (key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => (key === 'site' && o?.onlyIfMatch ? { modified: false } : setJSON(key, value, o))) as KV['setJSON'];
    await expect(repo.updateSite(ctx, (s) => ({ ...s, shortLinks: {} }))).rejects.toMatchObject({ status: 503, code: 'busy' });
  });
});

describe('the brand of a stored event type', () => {
  it('saveEventType keeps the stored brand unless the caller sets it', async () => {
    const ctx = makeTestCtx();
    await repo.getSite(ctx);
    const intro = (await repo.getEventType(ctx, 'evt_intro'))!;
    await repo.saveEventType(ctx, { ...intro, brandId: ECO }, { setBrand: true });
    // A save built from the earlier read (no brand) does not wipe it...
    await repo.saveEventType(ctx, { ...intro, title: 'Intro' });
    expect((await repo.getEventType(ctx, 'evt_intro'))!).toMatchObject({ title: 'Intro', brandId: ECO });
    // ...nor does one that names another brand without meaning to.
    await repo.saveEventType(ctx, { ...intro, brandId: null });
    expect((await repo.getEventType(ctx, 'evt_intro'))!.brandId).toBe(ECO);
    await repo.saveEventType(ctx, { ...intro, brandId: null }, { setBrand: true });
    expect((await repo.getEventType(ctx, 'evt_intro'))!.brandId).toBeNull();
    // An event type never stored before takes the brand it is given.
    await repo.saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_new', slug: 'new', title: 'New', brandId: ECO }));
    expect((await repo.getEventType(ctx, 'evt_new'))!.brandId).toBe(ECO);
    // A record without the field stays without it.
    const meeting = (await repo.getEventType(ctx, 'evt_meeting'))!;
    await repo.saveEventType(ctx, { ...meeting, brandId: ECO });
    expect('brandId' in (await repo.getEventType(ctx, 'evt_meeting'))!).toBe(false);
  });

  it('updateEventTypes changes several at once and stamps only the ones that changed', async () => {
    const ctx = makeTestCtx();
    await repo.getSite(ctx);
    const before = await repo.listEventTypes(ctx);
    ctx.clock.advance(60_000);
    const result = await repo.updateEventTypes(ctx, (list) => ({ next: list.map((e) => (e.id === 'evt_intro' ? { ...e, title: 'Hello' } : e)), result: 'done' }));
    expect(result).toBe('done');
    const after = await repo.listEventTypes(ctx);
    expect(after.find((e) => e.id === 'evt_intro')!.updatedAt).not.toBe(before.find((e) => e.id === 'evt_intro')!.updatedAt);
    expect(after.find((e) => e.id === 'evt_meeting')).toEqual(before.find((e) => e.id === 'evt_meeting'));
    expect(await repo.updateEventTypes(ctx, () => ({ keep: 'nothing' }))).toBe('nothing');
  });
});

// ───────────────────────── the browser client ─────────────────────────

interface Seen {
  url: string;
  init: RequestInit;
}

describe('client calls for short links and brands', () => {
  let seen: Seen[] = [];
  let answer: unknown = {};
  beforeEach(() => {
    seen = [];
    answer = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const last = () => seen[seen.length - 1];
  const body = () => JSON.parse(String(last().init.body));

  it('asks what a short link opens', async () => {
    answer = { name: 'pod', state: 'closed', reason: 'unassigned', url: 'https://jimicohen.com/pod', site: {} };
    const res = await api.getShortLink('pod');
    expect(last().url).toBe(`${api.API_BASE}/public/short/pod`);
    expect(last().init.method).toBe('GET');
    expect(res.state).toBe('closed');
  });

  it('adds a co-host to the meetings ticked', async () => {
    await api.createHost({ name: 'Ian Poirier', email: 'ian@example.com', addToEventTypeIds: ['evt_eco_champions'] });
    expect(last().url).toBe(`${api.API_BASE}/admin/hosts`);
    expect(body()).toEqual({ name: 'Ian Poirier', email: 'ian@example.com', addToEventTypeIds: ['evt_eco_champions'] });
  });

  it('saves a brand and points a short link', async () => {
    answer = { brand: {}, site: { profile: { name: 'Jimi Cohen' } } };
    const site = await api.updateBrand(ECO, { emailFromName: 'Eco Champions' });
    expect(last().url).toBe(`${api.API_BASE}/admin/brands/${ECO}`);
    expect(last().init.method).toBe('PUT');
    expect(body()).toEqual({ emailFromName: 'Eco Champions' });
    expect(site.profile.name).toBe('Jimi Cohen');

    answer = { shortLinks: { pod: 'evt_intro' } };
    await api.setShortLink('pod', 'evt_intro', true);
    expect(last().url).toBe(`${api.API_BASE}/admin/short-links`);
    expect(body()).toEqual({ name: 'pod', eventTypeId: 'evt_intro', brand: true });
    await api.setShortLink('meet', null);
    expect(body()).toEqual({ name: 'meet', eventTypeId: null });
  });
});
