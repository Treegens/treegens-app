import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import type { HydrologyInput, HydrologyResult } from '../hydrology'
import Site from '../models/Site'
import { circleRing } from '../utils/geo'
import {
  processSiteHydrology,
  setSiteHydrologyRunner,
  siteHydrologyQueueIdle,
  sweepSiteHydrology,
  triggerSiteHydrology,
} from './siteHydrologyJobService'

const original = {
  findOneAndUpdate: Site.findOneAndUpdate,
  findOne: Site.findOne,
  find: Site.find,
  updateOne: Site.updateOne,
  updateMany: Site.updateMany,
  countDocuments: Site.countDocuments,
  aggregate: Site.aggregate,
}
const ENV_KEYS = [
  'SITE_HYDROLOGY_ENABLED',
  'SITE_HYDROLOGY_MAX_ATTEMPTS',
  'SITE_HYDROLOGY_YEARS',
  'SITE_HYDROLOGY_MAX_PER_WALLET',
  'SITE_HYDROLOGY_MAX_QUEUE',
]
const savedEnv = ENV_KEYS.map(k => [k, process.env[k]] as const)

const ring = circleRing(-4.423, 39.507, 30)

function storedSite(id = 'site-1') {
  return {
    _id: id,
    boundary: { type: 'Polygon', coordinates: [ring] },
    answers: {
      previousUse: 'mangrove_cut',
      currentCover: 'bare_mud',
      tideReach: 'daily',
      flowBlocked: 'no',
      naturalRecruitment: 'none',
      shoreExposure: 'sheltered',
      substrate: 'soft_mud',
      nearestMangroves: 'within_100m',
    },
    countryCode: 'KE',
    hydrology: { status: 'processing', attempts: 1 },
    updatedAt: new Date('2026-10-06T10:00:00Z'),
  }
}

function fakeResult(): HydrologyResult {
  return {
    version: 'hydrology-s2-v1',
    hydrologyClass: 'in_range',
    confidence: 'high',
    notes: [],
    site: {
      pixelCount: 28,
      observedPixelCount: 28,
      medianWetFraction: 0.31,
      p25WetFraction: 0.25,
      p75WetFraction: 0.36,
      permanentWaterShare: 0,
      rarelyWetShare: 0,
      mangroveCoverShare: 0,
      medianObservations: 60,
    },
    reference: {
      source: 'local',
      edgePixelCount: 900,
      p25: 0.22,
      p50: 0.36,
      p75: 0.48,
      p90: 0.61,
      nearestMangroveM: 40,
      nearestTidalWaterM: 120,
    },
    imagery: {
      provider: 'Sentinel-2 L2A COGs (AWS open data)',
      landcover: 'ESA WorldCover 2021 v200',
      mgrsTile: '37MER',
      epsg: 32737,
      scenesListed: 140,
      scenesAfterCloudFilter: 90,
      scenesUsed: 70,
      scenesFailed: 0,
      firstSceneDate: '2024-10-02',
      lastSceneDate: '2026-09-28',
      windowPx: [306, 306],
    },
    params: {
      years: 2,
      referenceRadiusM: 1500,
      ndwiWetThreshold: 0,
      maxCloudPct: 80,
      minObservations: 15,
    },
    computedAt: '2026-10-06T00:00:00.000Z',
    elapsedMs: 1000,
  }
}

type Call = { filter: any; update?: any }
let claims: Call[]
let triggers: Call[]
let updates: Call[]
let bulkUpdates: Call[]
let counts: any[]
let claimable: Set<string>
let triggerable: boolean
let busyRuns: number
let storeMisses: number
let ownedAtFinish: boolean
let runnerCalls: HydrologyInput[]

const lean = (value: unknown) => ({ lean: async () => value })

beforeEach(() => {
  claims = []
  triggers = []
  updates = []
  bulkUpdates = []
  counts = []
  claimable = new Set(['site-1', 'site-2', 'site-3'])
  triggerable = true
  busyRuns = 0
  storeMisses = 0
  ownedAtFinish = true
  runnerCalls = []
  ;(Site.findOneAndUpdate as any) = (filter: any, update: any) => {
    if (update.$set?.['hydrology.status'] === 'queued') {
      triggers.push({ filter, update })
      return lean(
        triggerable ? { _id: filter._id, userWalletAddress: '0xowner' } : null,
      )
    }
    claims.push({ filter, update })
    const id = String(filter._id)
    const hit = claimable.delete(id)
    return lean(hit ? storedSite(id) : null)
  }
  ;(Site.findOne as any) = (filter: any) =>
    lean(ownedAtFinish ? storedSite(String(filter._id)) : null)
  ;(Site.updateOne as any) = async (filter: any, update: any) => {
    updates.push({ filter, update })
    const storing = update.$set?.['hydrology.status'] === 'completed'
    if (storing && storeMisses > 0) {
      storeMisses -= 1
      return { matchedCount: 0, modifiedCount: 0 }
    }
    return { matchedCount: 1, modifiedCount: 1 }
  }
  ;(Site.countDocuments as any) = async (filter: any) => {
    counts.push(filter)
    return busyRuns
  }
  ;(Site.updateMany as any) = async (filter: any, update: any) => {
    bulkUpdates.push({ filter, update })
    return { modifiedCount: 0 }
  }
  setSiteHydrologyRunner(async input => {
    runnerCalls.push(input)
    return fakeResult()
  })
})

afterEach(() => {
  Object.assign(Site, original)
  setSiteHydrologyRunner()
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('a run claims the site, reads the satellite and stores a new verdict', async () => {
  process.env.SITE_HYDROLOGY_MAX_ATTEMPTS = '4'
  process.env.SITE_HYDROLOGY_YEARS = '3'

  assert.equal(await processSiteHydrology('site-1'), 'completed')

  const claim = claims[0]
  assert.deepEqual(claim.filter['hydrology.status'], {
    $in: ['queued', 'failed', 'not_started'],
  })
  assert.deepEqual(claim.filter['hydrology.attempts'], { $lt: 4 })
  assert.deepEqual(claim.update.$inc, { 'hydrology.attempts': 1 })
  const startedAt = claim.update.$set['hydrology.startedAt']

  assert.equal(runnerCalls.length, 1)
  assert.deepEqual(runnerCalls[0].ring, ring)
  assert.equal(runnerCalls[0].years, 3)
  assert.equal(runnerCalls[0].referenceRadiusM, 1500)

  const done = updates[0]
  assert.equal(done.filter['hydrology.status'], 'processing')
  assert.equal(done.filter['hydrology.startedAt'], startedAt)
  // Written only if nothing (an answers edit) changed the site meanwhile.
  assert.deepEqual(done.filter.updatedAt, storedSite().updatedAt)
  const set = done.update.$set
  assert.equal(set['hydrology.status'], 'completed')
  assert.equal(set['hydrology.result'].hydrologyClass, 'in_range')
  assert.ok(set['hydrology.completedAt'] instanceof Date)
  assert.equal(set.verdict.code, 'plant')
  assert.equal(set.verdict.hydrologyConsidered, true)
  assert.ok(set.verdict.reasons.some((r: any) => r.code === 'sat_in_range'))
  assert.deepEqual(done.update.$unset, { 'hydrology.lastError': '' })
})

test('a failed run stores the error, trimmed to 500 characters', async () => {
  setSiteHydrologyRunner(async () => {
    throw new Error('S3 said no. '.repeat(80))
  })
  assert.equal(await processSiteHydrology('site-1'), 'failed')
  const set = updates[0].update.$set
  assert.equal(set['hydrology.status'], 'failed')
  assert.equal(set['hydrology.lastError'].length, 500)
  assert.ok(set['hydrology.lastError'].startsWith('S3 said no.'))
})

test('nothing runs when the site cannot be claimed (attempts used up)', async () => {
  claimable.clear()
  assert.equal(await processSiteHydrology('site-1'), null)
  assert.equal(runnerCalls.length, 0)
  assert.equal(updates.length, 0)
})

test('a result is dropped when the boundary changed during the run', async () => {
  ownedAtFinish = false
  assert.equal(await processSiteHydrology('site-1'), 'completed')
  assert.equal(updates.length, 0)
})

test('a result is recomputed when the site changed while it was saved', async () => {
  storeMisses = 1
  assert.equal(await processSiteHydrology('site-1'), 'completed')
  const stores = updates.filter(
    u => u.update.$set?.['hydrology.status'] === 'completed',
  )
  assert.equal(stores.length, 2)
})

test('a site that keeps changing gets a retryable failure, not a stale verdict', async () => {
  storeMisses = 3
  assert.equal(await processSiteHydrology('site-1'), 'failed')
  const last = updates[updates.length - 1].update.$set
  assert.equal(last['hydrology.status'], 'failed')
  assert.match(last['hydrology.lastError'], /kept changing/)
})

test('trigger skips the check when it is switched off', async () => {
  process.env.SITE_HYDROLOGY_ENABLED = 'false'
  await triggerSiteHydrology('site-1')
  await siteHydrologyQueueIdle()
  assert.deepEqual(updates[0].update.$set, {
    'hydrology.status': 'skipped',
    'hydrology.skipReason': 'disabled',
  })
  assert.equal(claims.length, 0)
})

test('trigger queues the site and runs jobs one at a time', async () => {
  let running = 0
  let peak = 0
  setSiteHydrologyRunner(async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 5))
    running -= 1
    return fakeResult()
  })
  await triggerSiteHydrology('site-1')
  await triggerSiteHydrology('site-2')
  assert.equal(triggers.length, 2)
  assert.deepEqual(triggers[0].filter['hydrology.status'], {
    $ne: 'processing',
  })
  await siteHydrologyQueueIdle()
  assert.equal(peak, 1)
  assert.deepEqual(
    claims.map(c => c.filter._id),
    ['site-1', 'site-2'],
  )
})

test('trigger never throws, even when the database does', async () => {
  ;(Site.findOneAndUpdate as any) = () => ({
    lean: async () => {
      throw new Error('connection reset')
    },
  })
  await assert.doesNotReject(triggerSiteHydrology('site-1'))
})

test('a wallet with its share of runs waiting is left for the sweeper', async () => {
  process.env.SITE_HYDROLOGY_MAX_PER_WALLET = '2'
  busyRuns = 2
  await triggerSiteHydrology('site-1')
  await siteHydrologyQueueIdle()
  // Marked queued in the database, but not run from the in-process queue.
  assert.equal(triggers.length, 1)
  assert.equal(claims.length, 0)
  assert.equal(counts[0].userWalletAddress, '0xowner')
  assert.deepEqual(counts[0]._id, { $ne: 'site-1' })
  assert.deepEqual(counts[0]['hydrology.status'], {
    $in: ['queued', 'processing'],
  })
  busyRuns = 1
  await triggerSiteHydrology('site-2')
  await siteHydrologyQueueIdle()
  assert.deepEqual(
    claims.map(c => c.filter._id),
    ['site-2'],
  )
})

test('the in-process queue stops growing at its maximum length', async () => {
  process.env.SITE_HYDROLOGY_MAX_QUEUE = '1'
  let release!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  setSiteHydrologyRunner(async () => {
    await blocked
    return fakeResult()
  })
  await triggerSiteHydrology('site-1')
  // Let site-1 start running, so it no longer waits in the queue.
  await new Promise(resolve => setImmediate(resolve))
  await triggerSiteHydrology('site-2')
  await triggerSiteHydrology('site-3')
  release()
  await siteHydrologyQueueIdle()
  assert.equal(triggers.length, 3)
  assert.deepEqual(
    claims.map(c => c.filter._id),
    ['site-1', 'site-2'],
  )
})

test('a site with its runs used up is marked failed instead of queued', async () => {
  process.env.SITE_HYDROLOGY_MAX_ATTEMPTS = '3'
  triggerable = false
  await triggerSiteHydrology('site-1')
  await siteHydrologyQueueIdle()
  assert.deepEqual(triggers[0].filter['hydrology.attempts'], { $lt: 3 })
  const failed = updates[0]
  assert.deepEqual(failed.filter['hydrology.attempts'], { $gte: 3 })
  assert.deepEqual(failed.filter['hydrology.status'], {
    $nin: ['processing', 'failed'],
  })
  assert.equal(failed.update.$set['hydrology.status'], 'failed')
  assert.match(failed.update.$set['hydrology.lastError'], /Retry/)
  assert.equal(claims.length, 0)
})

function stubAggregate(rows: { _id: string; siteId: string }[]) {
  const pipelines: any[] = []
  ;(Site.aggregate as any) = async (pipeline: any) => {
    pipelines.push(pipeline)
    return rows
  }
  return pipelines
}

test('the sweeper fails stale runs, then retries due sites one wallet at a time', async () => {
  process.env.SITE_HYDROLOGY_MAX_ATTEMPTS = '3'
  const pipelines = stubAggregate([
    { _id: '0xa', siteId: 'site-2' },
    { _id: '0xb', siteId: 'site-3' },
  ])
  assert.equal(await sweepSiteHydrology(), 2)
  const stale = bulkUpdates[0]
  assert.equal(stale.filter['hydrology.status'], 'processing')
  const cutoff = stale.filter['hydrology.startedAt'].$lt.getTime()
  assert.ok(Math.abs(Date.now() - 20 * 60_000 - cutoff) < 5_000)
  assert.equal(stale.update.$set['hydrology.status'], 'failed')
  // Waiting sites with no runs left are failed, so they offer Retry.
  const exhausted = bulkUpdates[1]
  assert.deepEqual(exhausted.filter['hydrology.attempts'], { $gte: 3 })
  assert.equal(exhausted.update.$set['hydrology.status'], 'failed')

  const [match, sort, group, , limit] = pipelines[0]
  assert.deepEqual(match.$match.$or[0], {
    'hydrology.status': { $in: ['queued', 'failed'] },
  })
  // A site whose trigger was lost is picked up after a while too.
  const lost = match.$match.$or[1]
  assert.equal(lost['hydrology.status'], 'not_started')
  const lostCutoff = lost.updatedAt.$lt.getTime()
  assert.ok(Math.abs(Date.now() - 2 * 60_000 - lostCutoff) < 5_000)
  assert.deepEqual(match.$match['hydrology.attempts'], { $lt: 3 })
  assert.deepEqual(sort, { $sort: { updatedAt: 1 } })
  assert.equal(group.$group._id, '$userWalletAddress')
  assert.deepEqual(limit, { $limit: 3 })
  assert.deepEqual(
    claims.map(c => c.filter._id),
    ['site-2', 'site-3'],
  )
  assert.equal(runnerCalls.length, 2)
})

test('the sweeper takes no more than the in-process queue has room for', async () => {
  process.env.SITE_HYDROLOGY_MAX_QUEUE = '2'
  const pipelines = stubAggregate([])
  await sweepSiteHydrology(5)
  assert.deepEqual(pipelines[0][4], { $limit: 2 })
})

test('with the check switched off the sweeper marks waiting work skipped', async () => {
  process.env.SITE_HYDROLOGY_ENABLED = 'false'
  const pipelines = stubAggregate([{ _id: '0xa', siteId: 'site-2' }])
  assert.equal(await sweepSiteHydrology(), 0)
  assert.equal(pipelines.length, 0)
  assert.equal(bulkUpdates.length, 1)
  const { filter, update } = bulkUpdates[0]
  assert.deepEqual(filter.$or[0], {
    'hydrology.status': { $in: ['queued', 'not_started'] },
  })
  // A run another instance may still be finishing is left alone.
  assert.equal(filter.$or[1]['hydrology.status'], 'processing')
  assert.ok(filter.$or[1]['hydrology.startedAt'].$lt instanceof Date)
  assert.deepEqual(update.$set, {
    'hydrology.status': 'skipped',
    'hydrology.skipReason': 'disabled',
  })
  assert.equal(claims.length, 0)
})
