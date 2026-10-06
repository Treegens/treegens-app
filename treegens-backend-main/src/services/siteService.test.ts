import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { Storage } from '@google-cloud/storage'
import Notification from '../models/Notification'
import Site from '../models/Site'
import Submission from '../models/Submission'
import User from '../models/User'
import { circleRing } from '../utils/geo'
import { SITE_ERRORS } from './siteRules'
import SiteService from './siteService'

const SITE_ID = '64b7f0c2a1b2c3d4e5f60718'
const OWNER = '0xowner'
const VERIFIERS = ['0xa', '0xb', '0xc', '0xd', '0xe']

const original = {
  site: {
    findById: Site.findById,
    find: Site.find,
    findOneAndUpdate: Site.findOneAndUpdate,
    findOneAndDelete: Site.findOneAndDelete,
    updateOne: Site.updateOne,
    countDocuments: Site.countDocuments,
    create: Site.create,
  },
  user: { find: User.find, countDocuments: User.countDocuments },
  collectionUpdateOne: Site.collection.updateOne,
  notificationCreate: Notification.create,
  submissionExists: Submission.exists,
  bucket: Storage.prototype.bucket,
}
const ENV_KEYS = [
  'SITE_MAX_DRAFTS_PER_WALLET',
  'MINIMUM_ACTIVE_VERIFIERS',
  'SITE_HYDROLOGY_ENABLED',
  'GCS_BUCKET',
]
const savedEnv = ENV_KEYS.map(k => [k, process.env[k]] as const)

const ANSWERS = {
  previousUse: 'mangrove_cut',
  currentCover: 'bare_mud',
  tideReach: 'daily',
  flowBlocked: 'no',
  naturalRecruitment: 'none',
  shoreExposure: 'sheltered',
  substrate: 'soft_mud',
  nearestMangroves: 'within_100m',
  causeStillActive: 'no',
}

function photo(kind: string, objectPath: string) {
  return {
    kind,
    objectPath,
    publicUrl: `https://storage.googleapis.com/b/${objectPath}`,
    uploadedAt: new Date('2026-10-01T00:00:00Z'),
  }
}

/** The one site the stubbed database holds, as Mongo would store it. */
let stored: any

function draftSite(): any {
  return {
    _id: SITE_ID,
    userWalletAddress: OWNER,
    name: 'Mida creek',
    boundary: {
      type: 'Polygon',
      coordinates: [circleRing(-4.423, 39.507, 30)],
    },
    boundaryMethod: 'pin_radius',
    radiusM: 30,
    center: { latitude: -4.423, longitude: 39.507 },
    areaM2: 2827,
    answers: { ...ANSWERS },
    photos: [
      photo('low_tide_360', 'sites/low.jpg'),
      photo('ground', 'sites/ground.jpg'),
    ],
    hydrology: { status: 'processing', attempts: 1 },
    status: 'draft',
    votes: [],
    __v: 0,
  }
}

function satelliteResult() {
  return {
    hydrologyClass: 'permanently_wet',
    confidence: 'high',
    site: { medianWetFraction: 0.97 },
    reference: { p50: 0.36 },
  }
}

/** A query stub that can be awaited (hydrated doc) or `.lean()`ed. */
function siteQuery() {
  const snapshot = () => (stored ? structuredClone(stored) : null)
  return {
    lean: async () => snapshot(),
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      const doc = snapshot()
      return Promise.resolve(doc ? Site.hydrate(doc) : null).then(
        resolve,
        reject,
      )
    },
  }
}

function setPath(target: any, path: string, value: unknown) {
  const keys = path.split('.')
  let node = target
  for (const k of keys.slice(0, -1)) node = node[k] ??= {}
  node[keys[keys.length - 1]] = value
}

type SaveCall = { where: any; update: any }
let saves: SaveCall[]
/** Runs before a save is matched, to simulate a concurrent write. */
let beforeSave: ((call: number) => void) | null
let deletedObjects: string[]
let savedObjects: string[]

/** Stubs what `doc.save()` sends: matches `where` like Mongo would. */
function stubSave() {
  ;(Site.collection as any).updateOne = async (where: any, update: any) => {
    saves.push({ where, update })
    beforeSave?.(saves.length)
    const matches = Object.entries(where).every(([key, value]) => {
      if (key === '_id') return String(value) === stored?._id
      const actual = key
        .split('.')
        .reduce((node: any, k) => (node == null ? undefined : node[k]), stored)
      if (value === null) return actual == null
      if (value instanceof Date) {
        return actual instanceof Date && actual.getTime() === value.getTime()
      }
      return actual === value
    })
    if (!matches) return { matchedCount: 0, modifiedCount: 0 }
    for (const [path, value] of Object.entries(update.$set ?? {})) {
      setPath(stored, path, structuredClone(value))
    }
    return { matchedCount: 1, modifiedCount: 1 }
  }
}

function stubVerifiers(wallets: string[]) {
  ;(User.countDocuments as any) = async () => wallets.length
  ;(User.find as any) = (filter: any) => ({
    select: () => ({
      lean: async () =>
        filter.isVerifier ? wallets.map(w => ({ walletAddress: w })) : [],
    }),
  })
}

beforeEach(() => {
  stored = draftSite()
  saves = []
  beforeSave = null
  deletedObjects = []
  savedObjects = []
  ;(Site.findById as any) = () => siteQuery()
  ;(Notification.create as any) = async () => {
    throw new Error('notifications are not under test')
  }
  ;(Storage.prototype as any).bucket = () => ({
    file: (name: string) => ({
      save: async () => {
        savedObjects.push(name)
      },
      delete: async () => {
        deletedObjects.push(name)
      },
    }),
  })
  process.env.GCS_BUCKET = 'test-bucket'
  stubSave()
})

afterEach(() => {
  Object.assign(Site, original.site)
  Object.assign(User, original.user)
  ;(Site.collection as any).updateOne = original.collectionUpdateOne
  ;(Notification.create as any) = original.notificationCreate
  ;(Submission.exists as any) = original.submissionExists
  Storage.prototype.bucket = original.bucket
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** Lets fire-and-forget work (photo cleanup) finish. */
const settle = () => new Promise(resolve => setImmediate(resolve))

test('a double-tapped vote is stored once; the second request is refused', async () => {
  stored.status = 'pending_review'
  stubVerifiers(VERIFIERS)
  const pushes: any[] = []
  // Mongo applies a filtered update atomically; so does this stub.
  ;(Site.updateOne as any) = async (filter: any, update: any) => {
    pushes.push(filter)
    const voter = update.$push.votes.voterWalletAddress
    const open =
      stored.status === filter.status &&
      stored.userWalletAddress !== voter &&
      !stored.votes.some((v: any) => v.voterWalletAddress === voter)
    if (!open) return { matchedCount: 0 }
    stored.votes.push(update.$push.votes)
    return { matchedCount: 1 }
  }
  const service = new SiteService()
  const results = await Promise.allSettled([
    service.castSiteVote(SITE_ID, '0xA', 'yes'),
    service.castSiteVote(SITE_ID, '0xA', 'yes'),
  ])
  assert.equal(stored.votes.length, 1)
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const refused = results.find(r => r.status === 'rejected') as any
  assert.equal(refused.reason.message, SITE_ERRORS.alreadyVoted)
  assert.deepEqual(pushes[0]['votes.voterWalletAddress'], { $ne: '0xa' })
  assert.equal(pushes[0].status, 'pending_review')
})

test('votes of wallets that stopped verifying do not block the ones left', async () => {
  stored.status = 'pending_review'
  // Four of five turns look used, but 0xold is no longer a verifier.
  stored.votes = ['0xa', '0xb', '0xc', '0xold'].map(w => ({
    voterWalletAddress: w,
    vote: 'no',
    reasons: [],
    delegatedFor: [],
  }))
  stored.votes.push({
    voterWalletAddress: '0xd',
    vote: 'yes',
    reasons: [],
    delegatedFor: [],
  })
  stubVerifiers(VERIFIERS)
  ;(Site.updateOne as any) = async (_filter: any, update: any) => {
    stored.votes.push(update.$push.votes)
    return { matchedCount: 1 }
  }
  ;(Site.findOneAndUpdate as any) = () => ({ lean: async () => null })
  const result = await new SiteService().castSiteVote(SITE_ID, '0xe', 'yes')
  assert.equal(stored.votes.length, 6)
  assert.equal(result.totalVerifiers, 5)
})

test('pending sites are recounted when the verifier pool changes', async () => {
  process.env.MINIMUM_ACTIVE_VERIFIERS = '5'
  stored.status = 'pending_review'
  // 3 yes of 6 was no majority; with 0xf gone, 3 of 5 is.
  stored.votes = [
    ['0xa', 'yes'],
    ['0xb', 'yes'],
    ['0xc', 'yes'],
    ['0xd', 'no'],
    ['0xe', 'no'],
  ].map(([w, vote]) => ({
    voterWalletAddress: w,
    vote,
    reasons: [],
    delegatedFor: [],
  }))
  stubVerifiers(VERIFIERS)
  ;(Site.find as any) = () => ({ lean: async () => [{ _id: SITE_ID }] })
  const settles: any[] = []
  ;(Site.findOneAndUpdate as any) = (filter: any, update: any) => {
    settles.push({ filter, update })
    return { lean: async () => ({ ...stored, ...update.$set }) }
  }
  const result = await new SiteService().attemptResolvePendingSites()
  assert.deepEqual(result, { processed: 1, resolved: 1, totalVerifiers: 5 })
  assert.equal(settles[0].filter.status, 'pending_review')
  assert.equal(settles[0].update.$set.status, 'approved')
})

test('no pending site is recounted while there are too few verifiers', async () => {
  process.env.MINIMUM_ACTIVE_VERIFIERS = '5'
  stubVerifiers(VERIFIERS.slice(0, 4))
  let scanned = false
  ;(Site.find as any) = () => {
    scanned = true
    return { lean: async () => [] }
  }
  const result = await new SiteService().attemptResolvePendingSites()
  assert.deepEqual(result, { processed: 0, resolved: 0, totalVerifiers: 4 })
  assert.equal(scanned, false)
})

test('a wallet with too many unfinished sites cannot register another', async () => {
  process.env.SITE_MAX_DRAFTS_PER_WALLET = '3'
  let countFilter: any
  ;(Site.countDocuments as any) = async (filter: any) => {
    countFilter = filter
    return 3
  }
  let created = false
  ;(Site.create as any) = async () => {
    created = true
  }
  await assert.rejects(
    new SiteService().createSite('0xOWNER', {
      name: 'Another',
      boundaryMethod: 'pin_radius',
      center: { latitude: -4.423, longitude: 39.507 },
      radiusM: 30,
    }),
    { message: SITE_ERRORS.tooManyDrafts },
  )
  assert.deepEqual(countFilter, { userWalletAddress: OWNER, status: 'draft' })
  assert.equal(created, false)
})

test('moving a draft boundary keeps the satellite run count', async () => {
  process.env.SITE_HYDROLOGY_ENABLED = 'false'
  stored.hydrology = { status: 'failed', attempts: 2, lastError: 'S3 down' }
  ;(Site.updateOne as any) = async () => ({ matchedCount: 1 })
  await new SiteService().updateSite(OWNER, SITE_ID, {
    center: { latitude: -4.424, longitude: 39.507 },
  })
  const { where, update } = saves[0]
  assert.deepEqual(update.$set.hydrology, {
    status: 'not_started',
    attempts: 2,
  })
  // Saved only while it is a draft whose satellite state is as read.
  assert.equal(where.status, 'draft')
  assert.equal(where['hydrology.status'], 'failed')
  assert.equal(where['hydrology.completedAt'], null)
})

test('a satellite result landing during submit is not overwritten', async () => {
  const completedAt = new Date('2026-10-06T10:00:00Z')
  beforeSave = call => {
    if (call !== 1) return
    stored.hydrology = {
      status: 'completed',
      attempts: 1,
      completedAt,
      result: satelliteResult(),
    }
  }
  const site = await new SiteService().submitSite(OWNER, SITE_ID)
  assert.equal(saves.length, 2)
  assert.equal(saves[0].where['hydrology.status'], 'processing')
  assert.equal(saves[1].where['hydrology.status'], 'completed')
  assert.equal(stored.status, 'pending_review')
  assert.equal(stored.verdict.hydrologyConsidered, true)
  assert.equal(site.verdict?.hydrologyConsidered, true)
})

test('an edit that loses the race with a submit is refused as locked', async () => {
  beforeSave = call => {
    if (call === 1) stored.status = 'pending_review'
  }
  await assert.rejects(
    new SiteService().updateSite(OWNER, SITE_ID, { name: 'Renamed' }),
    { message: SITE_ERRORS.locked },
  )
  assert.equal(stored.name, 'Mida creek')
})

function upload() {
  return {
    originalname: 'ground.jpg',
    size: 1234,
    mimetype: 'image/jpeg',
    buffer: Buffer.from('jpeg'),
  }
}

test('a replaced photo is swapped in one draft-only update and its old file deleted', async () => {
  const calls: any[] = []
  ;(Site.findOneAndUpdate as any) = (
    filter: any,
    update: any,
    options: any,
  ) => {
    calls.push({ filter, update, options })
    const before = structuredClone(stored)
    const fresh = update[0].$set.photos.$concatArrays[1].$literal
    stored.photos = [
      ...stored.photos.filter((p: any) => p.kind !== 'ground'),
      ...fresh,
    ]
    return { lean: async () => before }
  }
  const site: any = await new SiteService().addPhoto(
    OWNER,
    SITE_ID,
    upload(),
    'ground',
  )
  await settle()
  assert.equal(calls[0].filter.status, 'draft')
  assert.equal(calls[0].filter.userWalletAddress, OWNER)
  assert.ok(Array.isArray(calls[0].update), 'one atomic pipeline update')
  assert.equal(savedObjects.length, 1)
  assert.ok(savedObjects[0].startsWith('sites/'))
  assert.deepEqual(deletedObjects, ['sites/ground.jpg'])
  const ground = site.photos.filter((p: any) => p.kind === 'ground')
  assert.equal(ground.length, 1)
  assert.equal(ground[0].objectPath, savedObjects[0])
})

test('a photo for a site submitted during the upload is refused and removed', async () => {
  ;(Site.findOneAndUpdate as any) = () => ({ lean: async () => null })
  await assert.rejects(
    new SiteService().addPhoto(OWNER, SITE_ID, upload(), 'ground'),
    { message: SITE_ERRORS.locked },
  )
  assert.equal(savedObjects.length, 1)
  assert.deepEqual(deletedObjects, savedObjects)
})

test('deleting a draft removes its photo files; a submitted site stays', async () => {
  ;(Submission.exists as any) = async () => null
  let deleteFilter: any
  ;(Site.findOneAndDelete as any) = (filter: any) => {
    deleteFilter = filter
    return { lean: async () => structuredClone(stored) }
  }
  const result = await new SiteService().deleteDraftSite(OWNER, SITE_ID)
  assert.deepEqual(result, { siteId: SITE_ID, deleted: true })
  assert.equal(deleteFilter.status, 'draft')
  assert.deepEqual(deletedObjects.sort(), ['sites/ground.jpg', 'sites/low.jpg'])

  deletedObjects = []
  ;(Site.findOneAndDelete as any) = () => ({ lean: async () => null })
  await assert.rejects(new SiteService().deleteDraftSite(OWNER, SITE_ID), {
    message: SITE_ERRORS.locked,
  })
  assert.deepEqual(deletedObjects, [])
})
