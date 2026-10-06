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
}
const ENV_KEYS = [
  'SITE_HYDROLOGY_ENABLED',
  'SITE_HYDROLOGY_MAX_ATTEMPTS',
  'SITE_HYDROLOGY_YEARS',
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
let updates: Call[]
let bulkUpdates: Call[]
let claimable: Set<string>
let ownedAtFinish: boolean
let runnerCalls: HydrologyInput[]

const lean = (value: unknown) => ({ lean: async () => value })

beforeEach(() => {
  claims = []
  updates = []
  bulkUpdates = []
  claimable = new Set(['site-1', 'site-2', 'site-3'])
  ownedAtFinish = true
  runnerCalls = []
  ;(Site.findOneAndUpdate as any) = (filter: any, update: any) => {
    claims.push({ filter, update })
    const id = String(filter._id)
    const hit = claimable.delete(id)
    return lean(hit ? storedSite(id) : null)
  }
  ;(Site.findOne as any) = (filter: any) =>
    lean(ownedAtFinish ? storedSite(String(filter._id)) : null)
  ;(Site.updateOne as any) = async (filter: any, update: any) => {
    updates.push({ filter, update })
    return { modifiedCount: 1 }
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
  const queued = updates.filter(
    u => u.update.$set?.['hydrology.status'] === 'queued',
  )
  assert.equal(queued.length, 2)
  assert.deepEqual(queued[0].filter['hydrology.status'], { $ne: 'processing' })
  await siteHydrologyQueueIdle()
  assert.equal(peak, 1)
  assert.deepEqual(
    claims.map(c => c.filter._id),
    ['site-1', 'site-2'],
  )
})

test('trigger never throws, even when the database does', async () => {
  ;(Site.updateOne as any) = async () => {
    throw new Error('connection reset')
  }
  await assert.doesNotReject(triggerSiteHydrology('site-1'))
})

test('the sweeper fails stale runs, then retries due sites in order', async () => {
  process.env.SITE_HYDROLOGY_MAX_ATTEMPTS = '3'
  let findFilter: any
  ;(Site.find as any) = (filter: any) => {
    findFilter = filter
    const chain = {
      sort: () => chain,
      limit: () => chain,
      lean: async () => [{ _id: 'site-2' }, { _id: 'site-3' }],
    }
    return chain
  }
  assert.equal(await sweepSiteHydrology(), 2)
  const stale = bulkUpdates[0]
  assert.equal(stale.filter['hydrology.status'], 'processing')
  const cutoff = stale.filter['hydrology.startedAt'].$lt.getTime()
  assert.ok(Math.abs(Date.now() - 20 * 60_000 - cutoff) < 5_000)
  assert.equal(stale.update.$set['hydrology.status'], 'failed')
  assert.deepEqual(findFilter['hydrology.attempts'], { $lt: 3 })
  assert.deepEqual(
    claims.map(c => c.filter._id),
    ['site-2', 'site-3'],
  )
  assert.equal(runnerCalls.length, 2)
})

test('the sweeper does nothing while the check is switched off', async () => {
  process.env.SITE_HYDROLOGY_ENABLED = 'false'
  assert.equal(await sweepSiteHydrology(), 0)
  assert.equal(bulkUpdates.length, 0)
})
