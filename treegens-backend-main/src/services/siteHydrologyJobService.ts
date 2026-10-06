/**
 * Runs the satellite hydrology check for sites in the background. There is
 * no Redis here: the status lives on the site document, jobs run one at a
 * time per process from a small in-memory FIFO, and a sweeper picks up work
 * a restart or a failure left behind (same idea as the stitch retrier).
 */
import env from '../config/environment'
import {
  HydrologyInput,
  HydrologyResult,
  runSiteHydrology,
  toHydrologySummary,
} from '../hydrology'
import Site from '../models/Site'
import type { LonLat } from '../utils/geo'
import { siteVerdictFor } from './siteRules'

type HydrologyRunner = (input: HydrologyInput) => Promise<HydrologyResult>

const LOG = '[SiteHydrology]'
/** A run older than this was killed (deploy, crash) and is retried. */
const STALE_PROCESSING_MS = 20 * 60_000
const MAX_ERROR_CHARS = 500

let runHydrology: HydrologyRunner = runSiteHydrology

/** Swaps the satellite runner (tests); call with no argument to restore it. */
export function setSiteHydrologyRunner(runner?: HydrologyRunner): void {
  runHydrology = runner ?? runSiteHydrology
}

let queueTail: Promise<void> = Promise.resolve()
const queuedIds = new Set<string>()

/** Adds a site to the FIFO unless it is already waiting in it. */
function enqueue(siteId: string): Promise<void> {
  if (queuedIds.has(siteId)) return queueTail
  queuedIds.add(siteId)
  queueTail = queueTail
    .then(async () => {
      queuedIds.delete(siteId)
      await processSiteHydrology(siteId)
    })
    .catch(error =>
      console.error(`${LOG} ${siteId} job crashed`, error?.message),
    )
  return queueTail
}

/** Resolves once every queued job has finished. */
export function siteHydrologyQueueIdle(): Promise<void> {
  return queueTail
}

export function buildHydrologyInput(
  ring: LonLat[],
  siteId: string,
): HydrologyInput {
  return {
    ring,
    asOf: new Date(),
    years: env.SITE_HYDROLOGY_YEARS,
    referenceRadiusM: env.SITE_HYDROLOGY_REFERENCE_RADIUS_M,
    maxCloudPct: env.SITE_HYDROLOGY_MAX_CLOUD_PCT,
    concurrency: env.SITE_HYDROLOGY_SCENE_CONCURRENCY,
    timeoutMs: env.SITE_HYDROLOGY_TIMEOUT_MS,
    s2BucketUrl: env.SITE_HYDROLOGY_S2_BUCKET_URL,
    worldCoverUrl: env.SITE_HYDROLOGY_WORLDCOVER_URL,
    log: msg => console.log(`${LOG} ${siteId} ${msg}`),
  }
}

/**
 * Marks the site queued (or skipped when the check is switched off) and
 * schedules it. Never throws: a site without a satellite result still works.
 */
export async function triggerSiteHydrology(siteId: string): Promise<void> {
  try {
    if (!env.SITE_HYDROLOGY_ENABLED) {
      await Site.updateOne(
        { _id: siteId },
        {
          $set: {
            'hydrology.status': 'skipped',
            'hydrology.skipReason': 'disabled',
          },
        },
      )
      return
    }
    await Site.updateOne(
      { _id: siteId, 'hydrology.status': { $ne: 'processing' } },
      {
        $set: { 'hydrology.status': 'queued' },
        $unset: { 'hydrology.skipReason': '' },
      },
    )
    void enqueue(siteId)
  } catch (error: any) {
    console.error(`${LOG} ${siteId} could not be queued`, error?.message)
  }
}

/** Atomically takes the site, so two processes never run the same one. */
function claimSite(siteId: string, startedAt: Date) {
  return Site.findOneAndUpdate(
    {
      _id: siteId,
      'hydrology.status': { $in: ['queued', 'failed', 'not_started'] },
      'hydrology.attempts': { $lt: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
    },
    {
      $set: {
        'hydrology.status': 'processing',
        'hydrology.startedAt': startedAt,
      },
      $inc: { 'hydrology.attempts': 1 },
    },
    { new: true },
  ).lean()
}

/** Matches only while this run still owns the site (a boundary edit resets it). */
function ownedBy(siteId: string, startedAt: Date) {
  return {
    _id: siteId,
    'hydrology.status': 'processing',
    'hydrology.startedAt': startedAt,
  }
}

async function storeResult(
  siteId: string,
  startedAt: Date,
  result: HydrologyResult,
) {
  // Re-read so answers edited during the run are not overwritten.
  const site = await Site.findOne(ownedBy(siteId, startedAt)).lean()
  if (!site) return
  const now = new Date()
  await Site.updateOne(ownedBy(siteId, startedAt), {
    $set: {
      'hydrology.status': 'completed',
      'hydrology.result': result,
      'hydrology.completedAt': now,
      verdict: siteVerdictFor(site, toHydrologySummary(result)),
      verdictComputedAt: now,
    },
    $unset: { 'hydrology.lastError': '' },
  })
}

async function storeFailure(siteId: string, startedAt: Date, error: any) {
  const message = String(error?.message || error || 'Unknown error')
  await Site.updateOne(ownedBy(siteId, startedAt), {
    $set: {
      'hydrology.status': 'failed',
      'hydrology.lastError': message.slice(0, MAX_ERROR_CHARS),
    },
  })
}

/**
 * Claims the site, runs the satellite check and stores the result plus a
 * fresh verdict, or the error. Returns null when there was nothing to claim
 * (already running, done, or out of attempts).
 */
export async function processSiteHydrology(
  siteId: string,
): Promise<'completed' | 'failed' | null> {
  const startedAt = new Date()
  const site = await claimSite(siteId, startedAt)
  if (!site) return null
  const attempt = site.hydrology?.attempts
  console.log(`${LOG} ${siteId} started (attempt ${attempt})`)
  try {
    const ring = site.boundary.coordinates[0]
    const result = await runHydrology(buildHydrologyInput(ring, siteId))
    await storeResult(siteId, startedAt, result)
    console.log(
      `${LOG} ${siteId} completed: ${result.hydrologyClass}, ${result.confidence} confidence`,
    )
    return 'completed'
  } catch (error: any) {
    console.error(`${LOG} ${siteId} failed`, error?.message)
    await storeFailure(siteId, startedAt, error)
    return 'failed'
  }
}

/** Runs left in 'processing' by a dead process become retryable failures. */
async function failStaleRuns(now: number) {
  await Site.updateMany(
    {
      'hydrology.status': 'processing',
      'hydrology.startedAt': { $lt: new Date(now - STALE_PROCESSING_MS) },
    },
    {
      $set: {
        'hydrology.status': 'failed',
        'hydrology.lastError':
          'The satellite check was interrupted before it finished.',
      },
    },
  )
}

/** Picks up queued and retryable sites, oldest first, one at a time. */
export async function sweepSiteHydrology(limit = 3): Promise<number> {
  if (!env.SITE_HYDROLOGY_ENABLED) return 0
  await failStaleRuns(Date.now())
  const due = await Site.find(
    {
      'hydrology.status': { $in: ['queued', 'failed'] },
      'hydrology.attempts': { $lt: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
    },
    { _id: 1 },
  )
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean()
  for (const doc of due) await enqueue(String(doc._id))
  return due.length
}

let sweeping = false

export function startSiteHydrologySweeper(
  intervalMs = 5 * 60_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    void sweepSiteHydrology()
      .catch(error => console.error(`${LOG} sweep failed`, error?.message))
      .finally(() => {
        sweeping = false
      })
  }, intervalMs)
  timer.unref()
  return timer
}
