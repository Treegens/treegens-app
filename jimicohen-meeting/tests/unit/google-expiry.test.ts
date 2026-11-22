/**
 * A Google connection that Google said would end on a set day (an app still in Testing ends after 7 days):
 * the owner is emailed two days and one day before, and once it has ended the calendar alert says why.
 */
import { describe, expect, it } from 'vitest';
import type { Host } from '../../shared/types';
import { runScheduled } from '../../server/cron';
import { alertCalendarTrouble } from '../../server/lib/booking';
import { remindEndingConnections } from '../../server/lib/googleExpiry';
import { getSite, listHosts, listJobs, saveHost, updateHost } from '../../server/lib/repo';
import { defaultOwnerHost } from '../../shared/defaults';
import { makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';
import { fakeGoogle, setMain } from '../helpers/google';

const NOW = '2026-11-16T09:00:00.000Z';
const DAY = 86_400_000;
const ENDS = '2026-11-23T08:59:59.000Z';

async function setup(): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW, env: { overrides: { googleClientId: 'id.apps.googleusercontent.com', googleClientSecret: 'secret' } } });
  await getSite(ctx);
  await updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com', timezone: 'Europe/London', googleExtra: [] }));
  await markSetUp(ctx);
  return ctx;
}

const alerts = async (ctx: TestCtx) => (await listJobs(ctx)).filter((j) => (j as { kind?: string }).kind === 'host_alert') as unknown as { subject: string; body: string; hostId?: string }[];

describe('a connection with an end date', () => {
  it('is announced to the owner two days and one day before, once each', async () => {
    const ctx = await setup();
    await setMain(ctx, 'host_owner', { email: 'jimi@gmail.example', refreshExpiresAt: ENDS });
    // Six days before: nothing yet.
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 0 });

    ctx.clock.set(Date.parse(ENDS) - 2 * DAY + 60_000);
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 1 });
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 0 });
    let jobs = await alerts(ctx);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].subject).toBe('Your Google connection ends in two days: jimi@gmail.example');
    expect(jobs[0].body).toContain('Google said when you connected jimi@gmail.example that the connection ends on Monday, November 23, 2026. After that, no times are offered for meetings with you and new bookings stop reaching your calendar.');
    expect(jobs[0].body).toContain('Publish it now (Google Auth Platform, Audience, then Publish app, so it reads In production), then reconnect under Integrations.');
    expect(jobs[0].body).not.toMatch(/[‒-―]/);

    ctx.clock.set(Date.parse(ENDS) - DAY + 60_000);
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 1 });
    jobs = await alerts(ctx);
    expect(jobs.map((j) => j.subject)).toContain('Your Google connection ends tomorrow: jimi@gmail.example');

    // Reconnected after publishing: no end date, nothing more.
    await setMain(ctx, 'host_owner', { email: 'jimi@gmail.example' });
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 0 });
  });

  it('says nothing about a connection that has already stopped working: the calendar alert covers that', async () => {
    const ctx = await setup();
    await setMain(ctx, 'host_owner', { email: 'jimi@gmail.example', refreshExpiresAt: ENDS, status: 'needs_reconnect' });
    ctx.clock.set(Date.parse(ENDS) - DAY + 60_000);
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 0 });
    expect(await alerts(ctx)).toHaveLength(0);
  });

  it("names a co-host's connection to the owner, who publishes the app", async () => {
    const ctx = await setup();
    await saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: 'host_ian', role: 'member', name: 'Ian Moss', email: 'ian@example.com', googleExtra: [] } as Host);
    await setMain(ctx, 'host_ian', { email: 'ian@gmail.example', refreshExpiresAt: ENDS });
    ctx.clock.set(Date.parse(ENDS) - DAY + 60_000);
    expect(await remindEndingConnections(ctx, await listHosts(ctx))).toEqual({ reminded: 1 });
    const [job] = await alerts(ctx);
    expect(job.hostId).toBeUndefined();
    expect(job.subject).toBe("Ian's Google connection ends tomorrow: ian@gmail.example");
    expect(job.body).toContain('then ask Ian to connect again from their private link.');
  });

  it('runs with the scheduled housekeeping', async () => {
    const ctx = await setup();
    await setMain(ctx, 'host_owner', { email: 'jimi@gmail.example', refreshExpiresAt: ENDS });
    ctx.clock.set(Date.parse(ENDS) - DAY + 60_000);
    fakeGoogle(ctx);
    const summary = await runScheduled(ctx, { stepWaitMs: 5000 });
    expect((summary.housekeeping as Record<string, unknown>).ending).toEqual({ reminded: 1 });
  });

  it('once ended, the calendar alert says why it ended and that publishing is what keeps it', async () => {
    const ctx = await setup();
    const host = await setMain(ctx, 'host_owner', { email: 'jimi@gmail.example', refreshExpiresAt: ENDS, status: 'needs_reconnect' });
    ctx.clock.set(Date.parse(ENDS) + DAY);
    const ref = host.google!;
    await alertCalendarTrouble(ctx, [{ host, error: 'Google Calendar needs to be reconnected.', problems: [{ key: ref.id!, accountId: ref.id!, label: ref.email, message: 'Google Calendar needs to be reconnected.' }] }] as never);
    const [job] = await alerts(ctx);
    expect(job.body).toContain(
      'jimi@gmail.example: Google ended it on Monday, November 23, 2026, as it said it would when you connected. That usually means your Google Cloud app is still in Testing, where a connection lasts 7 days: publish it (Audience, then Publish app, so it reads In production), then reconnect. Reconnecting without publishing only lasts another 7 days.',
    );
  });
});
