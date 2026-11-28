import { describe, expect, it } from 'vitest';
import { ALL_DAY_HOURS, DEFAULT_ASSISTANT, WEEKDAY_HOURS, defaultOwnerHost, defaultSchedule, defaultSite, newEventType, starterEventTypes } from '../../shared/defaults';
import type { EventType, Host, SiteSettings, WeeklyHours } from '../../shared/types';
import type { KV } from '../../server/lib/ctx';
import * as repo from '../../server/lib/repo';
import { MODEL_MOVE_MARKER, MOVE_MARKER, OLD_DEFAULT_MODEL, POD_DESCRIPTION, planShortLinks, runAssistantModelMove, runOpenHoursMove, runOwnerAllDayMove, runShortLinkMove } from '../../server/lib/seed';
import { runScheduled } from '../../server/cron';
import { envFromProcess } from '../../server/lib/runtime';
import { memoryKV } from '../../server/lib/store';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

const ECO = 'brand_eco_champions';
const LIVE_WELCOME = 'Host of the Eco Champions podcast and Founder of Treegens. Pick a meeting type below and choose a time that works.';

function owner(): Host {
  return { ...defaultOwnerHost(TEST_NOW, 'America/New_York'), email: 'jimi@example.com' };
}

function coHost(id: string, name: string, joined: string): Host {
  return { ...owner(), id, role: 'member', name, email: `${id}@example.com`, schedules: [defaultSchedule()], createdAt: joined, updatedAt: joined };
}

function liveSite(over: Partial<SiteSettings> = {}): SiteSettings {
  const s = defaultSite(TEST_NOW);
  return { ...s, profile: { ...s.profile, headline: 'Book time with Jimi', welcome: LIVE_WELCOME }, ...over };
}

function joint(id: string, title: string, hostIds: string[], over: Partial<EventType> = {}): EventType {
  return newEventType(TEST_NOW, { id, slug: id.replace(/^evt_/, '').replace(/_/g, '-'), title, kind: 'collective', hostIds, position: 5, ...over });
}

const IAN = coHost('host_ian', 'Ian Poirier', '2026-11-10T10:00:00.000Z');

describe('planShortLinks', () => {
  it('on the live data: /meet opens "Meeting" renamed "Meeting with Jimi", /pod a new unlisted Eco Champions event', () => {
    const before = starterEventTypes(TEST_NOW);
    const plan = planShortLinks(before, [owner()], liveSite(), TEST_NOW);
    expect(plan.changed).toBe(true);
    expect(plan.targets).toEqual({ meet: 'evt_meeting', pod: 'evt_eco_champions' });
    const meet = plan.list.find((e) => e.id === 'evt_meeting')!;
    // A name that reads in a sentence ("Your Meeting with Jimi is confirmed"). The link preview says "Meet with Jimi".
    expect(meet.title).toBe('Meeting with Jimi');
    // Only the starter title changes: slug, description, lengths, hosts and brand stay.
    const original = before.find((e) => e.id === 'evt_meeting')!;
    expect({ ...meet, title: original.title }).toEqual(original);
    const pod = plan.list.find((e) => e.id === 'evt_eco_champions')!;
    expect(pod).toMatchObject({
      slug: 'eco-champions',
      title: 'Eco Champions conversation',
      description: POD_DESCRIPTION,
      emoji: '🌿',
      color: '',
      kind: 'solo',
      hostIds: ['host_owner'],
      durations: [30, 60],
      defaultDuration: 30,
      locations: [{ type: 'google_meet' }],
      visibility: 'unlisted',
      active: true,
      brandId: ECO,
      position: 2,
      googleInvite: true,
    });
    expect(pod.reminders.map((r) => r.id)).toEqual(['rem_email_24h', 'rem_call_2h', 'rem_email_1h', 'rem_sms_15m']);
    expect(plan.list.find((e) => e.id === 'evt_intro')).toEqual(before.find((e) => e.id === 'evt_intro'));
    expect(plan.report).toEqual({ meet: { eventTypeId: 'evt_meeting', renamed: true }, pod: { eventTypeId: 'evt_eco_champions', created: true, branded: true } });
    expect(JSON.stringify(plan.list)).not.toMatch(/[–—]/);
  });

  it('with Ian on the team the pod event is a joint meeting, the owner first, then co-hosts as they joined', () => {
    const sam = coHost('host_sam', 'Sam Lee', '2026-11-12T10:00:00.000Z');
    const plan = planShortLinks(starterEventTypes(TEST_NOW), [owner(), sam, IAN], liveSite(), TEST_NOW);
    expect(plan.list.find((e) => e.id === 'evt_eco_champions')).toMatchObject({ kind: 'collective', hostIds: ['host_owner', 'host_ian', 'host_sam'] });
  });

  it('keeps a title Jimi chose for "Meeting"', () => {
    const list = starterEventTypes(TEST_NOW).map((e) => (e.id === 'evt_meeting' ? { ...e, title: 'Coffee chat' } : e));
    const plan = planShortLinks(list, [owner()], liveSite(), TEST_NOW);
    expect(plan.targets.meet).toBe('evt_meeting');
    expect(plan.list.find((e) => e.id === 'evt_meeting')!.title).toBe('Coffee chat');
  });

  it('gives /meet to another solo meeting of Jimi when "Meeting" is gone, and makes one when there is none', () => {
    const noMeeting = starterEventTypes(TEST_NOW).filter((e) => e.id !== 'evt_meeting');
    expect(planShortLinks(noMeeting, [owner()], liveSite(), TEST_NOW).targets.meet).toBe('evt_intro');

    const plan = planShortLinks([], [owner()], liveSite(), TEST_NOW);
    const made = plan.list.find((e) => e.id === plan.targets.meet)!;
    expect(made).toMatchObject({ id: 'evt_meet_with_jimi', title: 'Meeting with Jimi', slug: 'meet-with-jimi', kind: 'solo', hostIds: ['host_owner'], visibility: 'public', durations: [30, 45, 60] });
    expect(made.brandId).toBeUndefined();
  });

  it('prefers an active solo meeting to a paused "Meeting", and takes a paused one only when nothing else is there', () => {
    const paused = starterEventTypes(TEST_NOW).map((e) => (e.id === 'evt_meeting' ? { ...e, active: false } : e));
    expect(planShortLinks(paused, [owner()], liveSite(), TEST_NOW).targets.meet).toBe('evt_intro');
    const allPaused = paused.map((e) => ({ ...e, active: false }));
    expect(planShortLinks(allPaused, [owner()], liveSite(), TEST_NOW).targets.meet).toBe('evt_meeting');
  });

  it('never gives /meet to "Meeting" turned into a joint meeting', () => {
    const list = starterEventTypes(TEST_NOW).map((e) => (e.id === 'evt_meeting' ? { ...e, kind: 'collective' as const, hostIds: ['host_owner', 'host_ian'] } : e));
    const plan = planShortLinks(list, [owner(), IAN], liveSite(), TEST_NOW);
    expect(plan.targets.meet).toBe('evt_intro');
    // Its title is not the pod's business either: "Meeting" does not say Eco Champions.
    expect(plan.targets.pod).toBe('evt_eco_champions');
  });

  it('does not take over a joint meeting whose name says nothing about Eco Champions', () => {
    const list = [...starterEventTypes(TEST_NOW), joint('evt_jimi_ian', 'Meet Jimi and Ian', ['host_owner', 'host_ian'])];
    const plan = planShortLinks(list, [owner(), IAN], liveSite(), TEST_NOW);
    expect(plan.targets.pod).toBe('evt_eco_champions');
    expect(plan.list.find((e) => e.id === 'evt_jimi_ian')).toEqual(list[2]);
  });

  it('takes over a joint meeting called "Eco Champions call": branded, nothing else changed', () => {
    const own = joint('evt_eco_call', 'Eco Champions call', ['host_owner', 'host_ian'], { description: 'Our own words', durations: [45], defaultDuration: 45 });
    const plan = planShortLinks([...starterEventTypes(TEST_NOW), own], [owner(), IAN], liveSite(), TEST_NOW);
    expect(plan.targets.pod).toBe('evt_eco_call');
    expect(plan.list.find((e) => e.id === 'evt_eco_call')).toEqual({ ...own, brandId: ECO });
    expect(plan.list.some((e) => e.id === 'evt_eco_champions')).toBe(false);
    expect(plan.report.pod).toEqual({ eventTypeId: 'evt_eco_call', takenOver: true, branded: true });
  });

  it('of two eco-named joint meetings takes the one with the most hosts', () => {
    const sam = coHost('host_sam', 'Sam Lee', '2026-11-12T10:00:00.000Z');
    const two = joint('evt_pod_two', 'Pod recording', ['host_owner', 'host_ian']);
    const three = joint('evt_pod_three', 'Champions round', ['host_owner', 'host_ian', 'host_sam']);
    const plan = planShortLinks([...starterEventTypes(TEST_NOW), two, three], [owner(), IAN, sam], liveSite(), TEST_NOW);
    expect(plan.targets.pod).toBe('evt_pod_three');
  });

  it('finds a free link when "eco-champions" is taken', () => {
    const taken = newEventType(TEST_NOW, { id: 'evt_other', slug: 'eco-champions', title: 'Something else', active: false, position: 3 });
    const plan = planShortLinks([...starterEventTypes(TEST_NOW), taken], [owner()], liveSite(), TEST_NOW);
    expect(plan.list.find((e) => e.id === 'evt_eco_champions')!.slug).toBe('eco-champions-2');
  });

  it('puts at most 20 hosts on the pod event', () => {
    const many = Array.from({ length: 25 }, (_, i) => coHost(`host_c${String(i).padStart(2, '0')}`, `Co ${i}`, `2026-11-${String(10 + (i % 10)).padStart(2, '0')}T10:00:${String(i).padStart(2, '0')}.000Z`));
    const plan = planShortLinks(starterEventTypes(TEST_NOW), [owner(), ...many], liveSite(), TEST_NOW);
    const pod = plan.list.find((e) => e.id === 'evt_eco_champions')!;
    expect(pod.hostIds).toHaveLength(20);
    expect(pod.hostIds[0]).toBe('host_owner');
  });

  it('changes nothing for a link already in the map, also one turned off', () => {
    const list = starterEventTypes(TEST_NOW);
    const plan = planShortLinks(list, [owner()], liveSite({ shortLinks: { meet: null, pod: 'evt_intro' } }), TEST_NOW);
    expect(plan.changed).toBe(false);
    expect(plan.targets).toEqual({});
    expect(plan.list).toEqual(list);
    expect(plan.report).toEqual({ meet: 'kept', pod: 'kept' });
  });

  it('ends the same when applied again on its own result', () => {
    const first = planShortLinks(starterEventTypes(TEST_NOW), [owner(), IAN], liveSite(), TEST_NOW);
    const second = planShortLinks(first.list, [owner(), IAN], liveSite(), TEST_NOW);
    expect(second.changed).toBe(false);
    expect(second.list).toEqual(first.list);
    expect(second.targets).toEqual(first.targets);
  });
});

describe('runShortLinkMove', () => {
  async function live(kv: KV = memoryKV()) {
    const ctx = makeTestCtx({ kv });
    await repo.getSite(ctx);
    await repo.saveSite(ctx, liveSite());
    await repo.updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com' }));
    return ctx;
  }

  it('runs once on the live data: the links, the events, the marker; the profile, welcome and look untouched', async () => {
    const ctx = await live();
    const before = await repo.getSite(ctx);
    const report = await runShortLinkMove(ctx);
    expect(report).toMatchObject({ meet: { eventTypeId: 'evt_meeting', renamed: true }, pod: { eventTypeId: 'evt_eco_champions', created: true } });
    const after = await repo.getSite(ctx);
    expect(after.shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_eco_champions' });
    expect({ ...after, shortLinks: undefined, updatedAt: before.updatedAt }).toEqual({ ...before, shortLinks: undefined });
    expect(after.brands).toBeUndefined();
    expect((await repo.getEventType(ctx, 'evt_meeting'))!.title).toBe('Meeting with Jimi');
    expect((await repo.getEventType(ctx, 'evt_eco_champions'))!.brandId).toBe(ECO);
    expect(await ctx.kv.getJSON(MOVE_MARKER)).toEqual({ at: TEST_NOW, report });
    // Again: nothing to do, nothing written.
    expect(await runShortLinkMove(ctx)).toBe('already_done');
  });

  it('never runs again once the marker is there, also after Jimi turned /pod off or deleted its event', async () => {
    const ctx = await live();
    await runShortLinkMove(ctx);
    await repo.updateSite(ctx, (s) => ({ ...s, shortLinks: { ...s.shortLinks, pod: null } }));
    await repo.deleteEventType(ctx, 'evt_eco_champions');
    await repo.updateEventTypes(ctx, (list) => ({ next: list.map((e) => (e.id === 'evt_meeting' ? { ...e, title: 'Meeting' } : e)), result: null }));
    // A fresh context on the same store, as a new scheduled run is: it reads the marker and stops.
    const next = makeTestCtx({ kv: ctx.kv });
    expect(await runShortLinkMove(next, { readMarker: true })).toBe('already_done');
    expect((await repo.getSite(next)).shortLinks).toEqual({ meet: 'evt_meeting', pod: null });
    expect(await repo.getEventType(next, 'evt_eco_champions')).toBeNull();
    expect((await repo.getEventType(next, 'evt_meeting'))!.title).toBe('Meeting');
  });

  it('two runs at the same moment make one pod event', async () => {
    const kv = memoryKV();
    await live(kv);
    const a = makeTestCtx({ kv });
    const b = makeTestCtx({ kv });
    await Promise.all([runShortLinkMove(a), runShortLinkMove(b)]);
    const list = await repo.listEventTypes(a);
    expect(list.filter((e) => e.brandId === ECO)).toHaveLength(1);
    expect(list.filter((e) => e.title === 'Meeting with Jimi')).toHaveLength(1);
    expect((await repo.getSite(a)).shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_eco_champions' });
  });

  it('a choice Jimi saves between the two steps wins', async () => {
    const ctx = await live();
    const kv = ctx.kv;
    const original = kv.setJSON.bind(kv);
    let raced = false;
    // Right before the setup writes the link map, Jimi points /pod at "Intro call" in the dashboard.
    kv.setJSON = (async (key: string, value: unknown, opts?: Parameters<KV['setJSON']>[2]) => {
      if (key === 'site' && !raced && (value as SiteSettings).shortLinks) {
        raced = true;
        await original('site', { ...(await kv.getJSON<SiteSettings>('site'))!, shortLinks: { pod: 'evt_intro' } });
      }
      return original(key, value, opts);
    }) as KV['setJSON'];
    await runShortLinkMove(ctx);
    expect(raced).toBe(true);
    expect((await repo.getSite(ctx)).shortLinks).toEqual({ pod: 'evt_intro', meet: 'evt_meeting' });
  });

  it('a write that was reported refused but did land still ends right', async () => {
    const ctx = await live();
    const kv = ctx.kv;
    const original = kv.setJSON.bind(kv);
    let lied = false;
    kv.setJSON = (async (key: string, value: unknown, opts?: Parameters<KV['setJSON']>[2]) => {
      const written = await original(key, value, opts);
      if (key === 'event-types' && !lied && written.modified) {
        lied = true;
        return { ...written, modified: false };
      }
      return written;
    }) as KV['setJSON'];
    await runShortLinkMove(ctx);
    expect(lied).toBe(true);
    const list = await repo.listEventTypes(ctx);
    expect(list.filter((e) => e.id === 'evt_eco_champions')).toHaveLength(1);
    expect(list.find((e) => e.id === 'evt_meeting')!.title).toBe('Meeting with Jimi');
    expect(await ctx.kv.getJSON(MOVE_MARKER)).not.toBeNull();
  });

  it('throws when the store fails, and writes no marker', async () => {
    const ctx = await live();
    ctx.kv.setJSON = (async () => {
      throw new Error('store down');
    }) as KV['setJSON'];
    await expect(runShortLinkMove(makeTestCtx({ kv: ctx.kv }))).rejects.toThrow('store down');
    expect(await ctx.kv.getJSON(MOVE_MARKER)).toBeNull();
  });
});

describe('runAssistantModelMove (off the old default model, once)', () => {
  /** A site as it is stored live: the old default model, saved when that was the default. */
  async function stored(model = OLD_DEFAULT_MODEL, env?: NonNullable<Parameters<typeof makeTestCtx>[0]>['env']) {
    const ctx = makeTestCtx({ kv: memoryKV(), env });
    const site = await repo.getSite(ctx);
    await repo.saveSite(ctx, { ...site, assistant: { ...site.assistant, model } });
    return ctx;
  }
  const modelOf = async (ctx: ReturnType<typeof makeTestCtx>) => (await repo.getSite(ctx)).assistant.model;

  it('moves a site that says "claude-opus-5-5" and never had a key to Claude Haiku 5.5, once', async () => {
    const ctx = await stored();
    const before = await repo.getSite(ctx);
    expect(await runAssistantModelMove(ctx)).toBe('moved');
    expect(await modelOf(ctx)).toBe('claude-haiku-5-5');
    expect(await modelOf(ctx)).toBe(DEFAULT_ASSISTANT.model);
    // Only the model changed.
    expect({ ...(await repo.getSite(ctx)), assistant: before.assistant, updatedAt: before.updatedAt }).toEqual(before);
    expect(await ctx.kv.getJSON(MODEL_MOVE_MARKER)).toMatchObject({ result: 'moved', keySaved: false });

    // Once: an owner who then chooses Opus on purpose keeps it.
    await repo.updateSite(ctx, (s) => ({ ...s, assistant: { ...s.assistant, model: OLD_DEFAULT_MODEL } }));
    expect(await runAssistantModelMove(makeTestCtx({ kv: ctx.kv }), { readMarker: true })).toBe('already_done');
    expect(await modelOf(ctx)).toBe(OLD_DEFAULT_MODEL);
  });

  it('leaves the choice alone when a key was saved in the dashboard', async () => {
    const ctx = await stored();
    await repo.saveSecrets(ctx, { anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' } });
    expect(await runAssistantModelMove(ctx)).toBe('kept');
    expect(await modelOf(ctx)).toBe(OLD_DEFAULT_MODEL);
    expect(await ctx.kv.getJSON(MODEL_MOVE_MARKER)).toMatchObject({ result: 'kept', keySaved: true });
  });

  it('counts a key in the environment only when it is a real one (the AI Gateway value is not)', async () => {
    const names = ['ANTHROPIC_API_KEY', 'NETLIFY_AI_GATEWAY_KEY'] as const;
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      process.env.ANTHROPIC_API_KEY = 'nf-gateway-credential-value';
      process.env.NETLIFY_AI_GATEWAY_KEY = 'nf-gateway-credential-value';
      const gateway = await stored(OLD_DEFAULT_MODEL, { overrides: envFromProcess().overrides });
      expect(await runAssistantModelMove(gateway)).toBe('moved');

      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-real-key-set-on-the-site';
      const real = await stored(OLD_DEFAULT_MODEL, { overrides: envFromProcess().overrides });
      expect(await runAssistantModelMove(real)).toBe('kept');
      expect(await modelOf(real)).toBe(OLD_DEFAULT_MODEL);
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it('never touches another model, and writes nothing to the site then', async () => {
    const ctx = await stored('claude-sonnet-5-5');
    const before = await repo.getSite(ctx);
    expect(await runAssistantModelMove(ctx)).toBe('kept');
    expect(await repo.getSite(ctx)).toEqual(before);
  });

  it('runs from the scheduled run of the deploy, and only from there', async () => {
    const ctx = await stored();
    await runScheduled(ctx);
    expect(await modelOf(ctx)).toBe(OLD_DEFAULT_MODEL);
    const summary = await runScheduled(makeTestCtx({ kv: ctx.kv }), { oneTimeMoves: true, stepWaitMs: 50 });
    expect(summary.assistantModel).toBe('moved');
    expect(await modelOf(ctx)).toBe('claude-haiku-5-5');
    expect((await runScheduled(makeTestCtx({ kv: ctx.kv }), { oneTimeMoves: true, stepWaitMs: 50 })).assistantModel).toBe('already_done');
  });
});

describe('runOpenHoursMove (the old 9 to 5 starter hours become every day, all day, once)', () => {
  it('opens an untouched starter schedule, leaves a changed one alone, and runs once', async () => {
    const ctx = makeTestCtx({ kv: memoryKV() });
    const [owner] = await repo.listHosts(ctx);
    const custom = { id: 'sch_custom', name: 'Mornings', weekly: { ...structuredClone(WEEKDAY_HOURS), 1: [{ start: '08:00', end: '12:00' }] }, overrides: [] };
    await repo.updateHost(ctx, owner.id, (h) => ({ ...h, schedules: [{ ...h.schedules[0], weekly: structuredClone(WEEKDAY_HOURS) }, custom] }));

    expect(await runOpenHoursMove(ctx)).toEqual({ opened: 1 });
    const after = (await repo.listHosts(ctx)).find((h) => h.id === owner.id)!;
    expect(after.schedules[0].weekly).toEqual(ALL_DAY_HOURS);
    expect(after.schedules[1]).toEqual(custom);

    // Once: hours set back to 9 to 5 on purpose afterwards stay.
    await repo.updateHost(ctx, owner.id, (h) => ({ ...h, schedules: [{ ...h.schedules[0], weekly: structuredClone(WEEKDAY_HOURS) }] }));
    expect(await runOpenHoursMove(ctx, { readMarker: true })).toBe('already_done');
    expect((await repo.listHosts(ctx))[0].schedules[0].weekly).toEqual(WEEKDAY_HOURS);
  });

});

describe('runOwnerAllDayMove (the owner asked for every free spot, once)', () => {
  it("opens all of the owner's schedules and clears the hour window and daily cap on their events, not a co-host's hours", async () => {
    const ctx = makeTestCtx({ kv: memoryKV() });
    const [owner] = await repo.listHosts(ctx);
    const mornings: WeeklyHours = { 0: [], 1: [{ start: '09:00', end: '11:30' }], 2: [], 3: [], 4: [], 5: [], 6: [] };
    await repo.updateHost(ctx, owner.id, (h) => ({ ...h, schedules: [{ ...h.schedules[0], weekly: mornings, overrides: [{ date: '2026-12-24', ranges: [] }] }] }));
    const coHost: Host = { ...structuredClone(owner), id: 'host_ian', role: 'member', email: 'ian@example.com', schedules: [{ id: 'sch_ian', name: 'Working hours', weekly: mornings, overrides: [] }], defaultScheduleId: 'sch_ian' };
    await repo.saveHost(ctx, coHost);
    const types = await repo.listEventTypes(ctx);
    await repo.updateEventTypes(ctx, (list) => ({ next: list.map((e, i) => (i === 0 ? { ...e, scheduling: { ...e.scheduling, restrictHours: mornings, maxPerDay: 5 } } : e)), result: undefined }));

    expect(await runOwnerAllDayMove(ctx)).toEqual({ schedules: 1, eventTypes: types[0].hostIds.includes(owner.id) ? 1 : 0 });
    const hosts = await repo.listHosts(ctx);
    const after = hosts.find((h) => h.id === owner.id)!;
    expect(after.schedules[0].weekly).toEqual(ALL_DAY_HOURS);
    expect(after.schedules[0].overrides).toEqual([{ date: '2026-12-24', ranges: [] }]);
    expect(hosts.find((h) => h.id === 'host_ian')!.schedules[0].weekly).toEqual(mornings);
    const first = (await repo.listEventTypes(ctx))[0];
    expect(first.scheduling.restrictHours ?? null).toBeNull();
    expect(first.scheduling.maxPerDay ?? null).toBeNull();

    // Once.
    await repo.updateHost(ctx, owner.id, (h) => ({ ...h, schedules: [{ ...h.schedules[0], weekly: mornings }] }));
    expect(await runOwnerAllDayMove(ctx, { readMarker: true })).toBe('already_done');
    expect((await repo.listHosts(ctx)).find((h) => h.id === owner.id)!.schedules[0].weekly).toEqual(mornings);
  });
});
