// What GET /api/health checks (src/server/routes-selfhost.ts), for a monitor, a container's HEALTHCHECK or a
// Kubernetes readiness probe. It answers 200 only when every check passes, and otherwise 503 with the checks that
// failed in words. It says nothing about any account, envelope or person, nothing about keys, and no number that
// changes with use: the checks, whether mail is set up, and nothing else. The limits are in src/lib/selfhost.ts.
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from './db.ts';
import { storeState } from './filestore.ts';
import { HEALTH_MIN_FREE_BYTES, TIMER_STALE_MINUTES, HEALTH_CACHE_MS, HEALTH_CHECKS, type HealthCheck } from '../lib/selfhost.ts';

const g = globalThis as any;
// When this process started, for the timer's first run (15 minutes in).
g.__sgStartedAt ??= Date.now();

/** Called by tick() in src/server/cron.ts when a run starts and when it ends. */
export function noteTickStart(at = Date.now()) {
  g.__sgTick = { ...(g.__sgTick || {}), startedAt: at, running: true };
}
export function noteTick(ok: boolean, at = Date.now()) {
  g.__sgTick = { ...(g.__sgTick || {}), running: false, endedAt: at, ok };
}

export type Health = {
  ok: boolean;
  checks: Record<HealthCheck, 'ok' | 'failed'>;
  /** What failed, in words, in the order of the checks. Empty when ok. */
  problems: string[];
  /** Whether a mail server is set up. Not a failure either way: without one, emails are recorded as "Not emailed". */
  mail: 'configured' | 'not configured';
};

// The tests stand in for the disk (free space, a folder that cannot be written to) through these.
type Probe = { now?: number; freeBytes?: (dir: string) => number; canWrite?: (dir: string) => boolean; fresh?: boolean };

function timerOk(now: number): boolean {
  const stale = TIMER_STALE_MINUTES * 60_000;
  const t = g.__sgTick;
  if (!t?.startedAt) return now - g.__sgStartedAt < stale; // no run yet: the first is due 15 minutes after the start
  if (t.running) return now - t.startedAt < stale;
  return !!t.ok && now - t.endedAt < stale;
}

function writable(dir: string): boolean {
  const f = path.join(dir, `.health-${process.pid}`);
  try {
    fs.writeFileSync(f, String(Date.now()));
    fs.rmSync(f, { force: true });
    return true;
  } catch {
    return false;
  }
}

const statFree = (dir: string) => {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

export function health(o: Probe = {}): Health {
  const now = o.now ?? Date.now();
  if (!o.fresh && g.__sgHealth && now - g.__sgHealth.at < HEALTH_CACHE_MS) return g.__sgHealth.value;
  const dir = dataDir();
  const checks = {} as Record<HealthCheck, 'ok' | 'failed'>;
  const set = (k: HealthCheck, ok: () => boolean) => {
    try {
      checks[k] = ok() ? 'ok' : 'failed';
    } catch {
      checks[k] = 'failed';
    }
  };
  set('database', () => {
    db().prepare('SELECT count(*) n FROM sqlite_master').get();
    return true;
  });
  set('data_folder', () => (o.canWrite || writable)(dir));
  set('disk_space', () => (o.freeBytes || statFree)(dir) > HEALTH_MIN_FREE_BYTES);
  set('file_store', () => !storeState(path.join(dir, 'blobs')).stop);
  set('timer', () => timerOk(now));
  const problems = (Object.keys(HEALTH_CHECKS) as HealthCheck[]).filter((k) => checks[k] !== 'ok').map((k) => HEALTH_CHECKS[k]);
  const value: Health = { ok: !problems.length, checks, problems, mail: (process.env.SMTP_URL || '').trim() ? 'configured' : 'not configured' };
  g.__sgHealth = { at: now, value };
  return value;
}
