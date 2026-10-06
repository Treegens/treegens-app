/**
 * Runs the satellite hydrology check for sites in the background. There is
 * no Redis here: the status lives on the site document, jobs run one at a
 * time per process from a small in-memory FIFO, and a sweeper picks up work
 * a restart or a failure left behind (same idea as the stitch retrier).
 *
 * The FIFO is bounded: one wallet may have only a few runs queued or running
 * (SITE_HYDROLOGY_MAX_PER_WALLET) and the FIFO itself has a maximum length
 * (SITE_HYDROLOGY_MAX_QUEUE). A site over either limit stays 'queued' in the
 * database and the sweeper starts it later, one site per wallet per sweep,
 * so nobody can fill the queue and make everyone else wait for hours. The
 * limits only apply while this process runs the sweeper: without it nothing
 * would ever start a site left waiting, so every site is queued directly.
 */
import mongoose from 'mongoose'
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
/** A site still 'not_started' this long after its last write lost its trigger. */
const LOST_TRIGGER_MS = 2 * 60_000
const MAX_ERROR_CHARS = 500
/** Tries at saving a result while the site keeps changing under it. */
const STORE_TRIES = 3
const OUT_OF_ATTEMPTS_ERROR =
  'The satellite check has run as many times as it may for this site. Use Retry to run it again.'

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
    decoderWorkers: env.SITE_HYDROLOGY_DECODER_WORKERS,
    timeoutMs: env.SITE_HYDROLOGY_TIMEOUT_MS,
    s2BucketUrl: env.SITE_HYDROLOGY_S2_BUCKET_URL,
    worldCoverUrl: env.SITE_HYDROLOGY_WORLDCOVER_URL,
    log: msg => console.log(`${LOG} ${siteId} ${msg}`),
  }
}

/**
 * Room in the FIFO for this site: the FIFO is not full and the owner does
 * not already have their share of runs queued or running.
 */
async function hasQueueRoom(siteId: string, owner: string): Promise<boolean> {
  if (queuedIds.size >= env.SITE_HYDROLOGY_MAX_QUEUE) return false
  const busy = await Site.countDocuments({
    userWalletAddress: owner,
    _id: { $ne: siteId },
    'hydrology.status': { $in: ['queued', 'processing'] },
    'hydrology.attempts': { $lt: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
  })
  return busy < env.SITE_HYDROLOGY_MAX_PER_WALLET
}

/** Set while this process runs the sweeper (startSiteHydrologySweeper). */
let sweeperTimer: NodeJS.Timeout | null = null

/**
 * Marks the site queued (or skipped when the check is switched off) and
 * schedules it when there is room (otherwise the sweeper starts it later).
 * Without a running sweeper it is always scheduled, as nothing else would
 * start it.
 * A site whose runs are used up (a moved boundary keeps the count) is marked
 * failed, so the app offers Retry. Never throws: a site without a satellite
 * result still works.
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
    const site = await Site.findOneAndUpdate(
      {
        _id: siteId,
        'hydrology.status': { $ne: 'processing' },
        'hydrology.attempts': { $lt: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
      },
      {
        $set: { 'hydrology.status': 'queued' },
        $unset: { 'hydrology.skipReason': '' },
      },
      { new: true, projection: { userWalletAddress: 1 } },
    ).lean()
    if (!site) {
      await Site.updateOne(
        {
          _id: siteId,
          'hydrology.status': { $nin: ['processing', 'failed'] },
          'hydrology.attempts': { $gte: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
        },
        {
          $set: {
            'hydrology.status': 'failed',
            'hydrology.lastError': OUT_OF_ATTEMPTS_ERROR,
          },
          $unset: { 'hydrology.skipReason': '' },
        },
      )
      return
    }
    if (
      !sweeperTimer ||
      (await hasQueueRoom(siteId, String(site.userWalletAddress)))
    ) {
      void enqueue(siteId)
    }
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
  // The verdict also depends on the answers, so it is computed from a fresh
  // read and written only if the site has not changed since (an answers
  // edit in between means reading it again).
  for (let tries = 0; tries < STORE_TRIES; tries++) {
    const site = await Site.findOne(ownedBy(siteId, startedAt)).lean()
    if (!site) return
    const now = new Date()
    const written = await Site.updateOne(
      { ...ownedBy(siteId, startedAt), updatedAt: site.updatedAt ?? null },
      {
        $set: {
          'hydrology.status': 'completed',
          'hydrology.result': result,
          'hydrology.completedAt': now,
          verdict: siteVerdictFor(site, toHydrologySummary(result)),
          verdictComputedAt: now,
        },
        $unset: { 'hydrology.lastError': '' },
      },
    )
    if (written.matchedCount > 0) return
  }
  throw new Error(
    'The site kept changing while the satellite result was saved.',
  )
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

/**
 * A site left waiting with its runs used up (the limit was lowered, or a
 * moved boundary lost its trigger) would never be picked up again; it is
 * marked failed so the app offers Retry.
 */
async function failExhaustedWaits(now: number) {
  await Site.updateMany(
    {
      $or: [
        { 'hydrology.status': 'queued' },
        {
          'hydrology.status': 'not_started',
          updatedAt: { $lt: new Date(now - LOST_TRIGGER_MS) },
        },
      ],
      'hydrology.attempts': { $gte: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
    },
    {
      $set: {
        'hydrology.status': 'failed',
        'hydrology.lastError': OUT_OF_ATTEMPTS_ERROR,
      },
    },
  )
}

/**
 * With the check switched off, work left waiting (the in-memory queue died
 * with the restart that applied the change) or killed mid-run is marked
 * skipped, so the app stops showing a spinner and offers a recheck.
 */
async function skipOrphanedRuns(now: number) {
  await Site.updateMany(
    {
      $or: [
        { 'hydrology.status': { $in: ['queued', 'not_started'] } },
        {
          'hydrology.status': 'processing',
          'hydrology.startedAt': { $lt: new Date(now - STALE_PROCESSING_MS) },
        },
      ],
    },
    {
      $set: {
        'hydrology.status': 'skipped',
        'hydrology.skipReason': 'disabled',
      },
    },
  )
}

/** Ids waiting in this process's FIFO, as ObjectIds for an aggregation. */
function idsInQueue(): mongoose.Types.ObjectId[] {
  return [...queuedIds]
    .filter(id => mongoose.Types.ObjectId.isValid(id))
    .map(id => new mongoose.Types.ObjectId(id))
}

/**
 * Picks up queued, retryable and lost ('not_started' for a while) sites and
 * runs them one at a time: at most one site per wallet per sweep, the
 * wallets whose oldest waiting site is oldest first, so one wallet's
 * backlog cannot crowd out everyone else's.
 */
export async function sweepSiteHydrology(limit = 3): Promise<number> {
  const now = Date.now()
  if (!env.SITE_HYDROLOGY_ENABLED) {
    await skipOrphanedRuns(now)
    return 0
  }
  await failStaleRuns(now)
  await failExhaustedWaits(now)
  const room = Math.min(limit, env.SITE_HYDROLOGY_MAX_QUEUE - queuedIds.size)
  if (room <= 0) return 0
  const due = await Site.aggregate<{ siteId: unknown }>([
    {
      $match: {
        $or: [
          { 'hydrology.status': { $in: ['queued', 'failed'] } },
          {
            'hydrology.status': 'not_started',
            updatedAt: { $lt: new Date(now - LOST_TRIGGER_MS) },
          },
        ],
        'hydrology.attempts': { $lt: env.SITE_HYDROLOGY_MAX_ATTEMPTS },
        _id: { $nin: idsInQueue() },
      },
    },
    { $sort: { updatedAt: 1 } },
    {
      $group: {
        _id: '$userWalletAddress',
        siteId: { $first: '$_id' },
        updatedAt: { $first: '$updatedAt' },
      },
    },
    { $sort: { updatedAt: 1 } },
    { $limit: room },
  ])
  for (const doc of due) await enqueue(String(doc.siteId))
  return due.length
}

let sweeping = false

/**
 * Sweeps every `intervalMs`. While it runs, sites over the queue limits are
 * left for it instead of being run directly.
 */
export function startSiteHydrologySweeper(
  intervalMs = 5 * 60_000,
): NodeJS.Timeout {
  stopSiteHydrologySweeper()
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
  sweeperTimer = timer
  return timer
}

/** Stops the sweeper; new sites are then always queued directly. */
export function stopSiteHydrologySweeper(): void {
  if (sweeperTimer) clearInterval(sweeperTimer)
  sweeperTimer = null
}
