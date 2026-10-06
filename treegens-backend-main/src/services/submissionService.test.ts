import assert from 'node:assert/strict'
import test, { TestContext } from 'node:test'
import axios from 'axios'
import mongoose from 'mongoose'
import Notification from '../models/Notification'
import Site from '../models/Site'
import Submission from '../models/Submission'
import { circleRing } from '../utils/geo'
import { SiteCheckRefusal } from './siteGate'
import {
  canAttachPlantClip,
  evaluateMangroveAiRouting,
  LAND_UPLOAD_INITIAL_STATUS,
} from './submissionAiRouting'
import SubmissionService from './submissionService'

test('land upload initial status is awaiting_plant', () => {
  assert.equal(LAND_UPLOAD_INITIAL_STATUS, 'awaiting_plant')
})

test('canAttachPlantClip allows plant only when awaiting_plant and plant missing', () => {
  assert.equal(
    canAttachPlantClip({
      status: 'awaiting_plant',
      plant: { uploaded: false },
    }),
    true,
  )
  assert.equal(
    canAttachPlantClip({ status: 'awaiting_plant', plant: { uploaded: true } }),
    false,
  )
  assert.equal(canAttachPlantClip({ status: 'pending_review' }), false)
})

test('evaluateMangroveAiRouting auto-approves when count and confidence match', () => {
  const r = evaluateMangroveAiRouting({
    countedMangroves: 40,
    declaredTreesPlanted: 41,
    confidence: 0.95,
    maxCountDelta: 2,
    minConfidence: 0.9,
  })
  assert.equal(r.shouldAutoApprove, true)
  assert.equal(r.decision, 'auto_approved')
  assert.equal(r.submissionStatus, 'approved')
})

test('evaluateMangroveAiRouting pending when count delta exceeds threshold', () => {
  const r = evaluateMangroveAiRouting({
    countedMangroves: 30,
    declaredTreesPlanted: 40,
    confidence: 0.95,
    maxCountDelta: 2,
    minConfidence: 0.9,
  })
  assert.equal(r.shouldAutoApprove, false)
  assert.equal(r.decision, 'pending_verifier')
  assert.equal(r.submissionStatus, 'pending_review')
})

test('evaluateMangroveAiRouting pending when confidence below threshold', () => {
  const r = evaluateMangroveAiRouting({
    countedMangroves: 40,
    declaredTreesPlanted: 40,
    confidence: 0.5,
    maxCountDelta: 2,
    minConfidence: 0.9,
  })
  assert.equal(r.shouldAutoApprove, false)
})

// Site Check wiring in uploadClip. No database or storage: models are
// stubbed, and GCS_BUCKET is empty so reaching storage fails with a known
// message instead of writing anything.

const WALLET = '0x' + 'a'.repeat(40)
const SITE_ID = new mongoose.Types.ObjectId()
const SUBMISSION_ID = new mongoose.Types.ObjectId()
const SITE_LAT = -4.423
const SITE_LON = 39.507
const M_LAT = 1 / 111_195
const STORAGE_REACHED = /GCS_BUCKET is not configured/
const FILE = {
  originalname: 'clip.mp4',
  size: 4,
  mimetype: 'video/mp4',
  buffer: Buffer.from('clip'),
}

const service = new SubmissionService()

function siteDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: SITE_ID,
    userWalletAddress: WALLET,
    status: 'approved',
    boundary: {
      type: 'Polygon',
      coordinates: [circleRing(SITE_LAT, SITE_LON, 30)],
    },
    center: { latitude: SITE_LAT, longitude: SITE_LON },
    verdict: { code: 'plant', headline: 'Plant here', reasons: [] },
    ...overrides,
  }
}

const lean = (doc: unknown) => ({ lean: async () => doc })

/** Sets env vars for one test; node:test runs each file in its own process. */
function setEnv(t: TestContext, vars: Record<string, string>) {
  const saved = Object.keys(vars).map(k => [k, process.env[k]] as const)
  Object.assign(process.env, vars)
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

function stubSite(t: TestContext, doc: unknown) {
  return t.mock.method(Site, 'findById', () => lean(doc))
}

function uploadLand(latitude: number, siteId?: string) {
  return service.uploadClip(
    FILE,
    WALLET,
    latitude,
    SITE_LON,
    'land',
    undefined,
    undefined,
    undefined,
    undefined,
    { siteId },
  )
}

function uploadPlant(latitude: number, siteId?: string) {
  return service.uploadClip(
    FILE,
    WALLET,
    latitude,
    SITE_LON,
    'plant',
    String(SUBMISSION_ID),
    100,
    'mangrove',
    undefined,
    { siteId },
  )
}

const refusal = (message: string) => (err: unknown) =>
  err instanceof SiteCheckRefusal && err.message === message

test('enforce refuses a land clip filmed outside its linked site before storage', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'enforce', GCS_BUCKET: '' })
  stubSite(t, siteDoc())
  await assert.rejects(
    uploadLand(SITE_LAT + 230 * M_LAT, String(SITE_ID)),
    refusal(
      'This video was filmed 200 m outside the checked site. Film it again from inside the site.',
    ),
  )
  // Inside the site it goes on to storage.
  await assert.rejects(uploadLand(SITE_LAT, String(SITE_ID)), STORAGE_REACHED)
})

test('off and warn keep an outside land link (the app warns instead)', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'off', GCS_BUCKET: '' })
  stubSite(t, siteDoc())
  for (const mode of ['off', 'warn']) {
    process.env.SITE_CHECK_ENFORCEMENT = mode
    await assert.rejects(
      uploadLand(SITE_LAT + 230 * M_LAT, String(SITE_ID)),
      STORAGE_REACHED,
    )
  }
})

test('a land clip with no site never looks one up', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'enforce', GCS_BUCKET: '' })
  const findSite = stubSite(t, siteDoc())
  await assert.rejects(uploadLand(SITE_LAT + 230 * M_LAT), STORAGE_REACHED)
  assert.equal(findSite.mock.callCount(), 0)
})

test("someone else's site is 'Site not found' before storage", async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'off', GCS_BUCKET: '' })
  stubSite(t, siteDoc({ userWalletAddress: '0x' + 'b'.repeat(40) }))
  await assert.rejects(
    uploadLand(SITE_LAT, String(SITE_ID)),
    refusal('Site not found'),
  )
})

function submissionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: SUBMISSION_ID,
    userWalletAddress: WALLET,
    status: 'awaiting_plant',
    land: {
      uploaded: true,
      gpsCoordinates: { latitude: SITE_LAT, longitude: SITE_LON },
    },
    plant: { uploaded: false },
    ...overrides,
  }
}

test('off: a stale plant siteId is refused before the video is stored', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'off', GCS_BUCKET: '' })
  t.mock.method(Submission, 'findById', () => lean(submissionDoc()))
  stubSite(t, null)
  await assert.rejects(
    uploadPlant(SITE_LAT, String(SITE_ID)),
    refusal('Site not found'),
  )
})

test('off: a plant upload without a siteId does not touch the database first', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'off', GCS_BUCKET: '' })
  const findSubmission = t.mock.method(Submission, 'findById', () =>
    lean(submissionDoc()),
  )
  await assert.rejects(uploadPlant(SITE_LAT), STORAGE_REACHED)
  assert.equal(findSubmission.mock.callCount(), 0)
})

test('off: a plant siteId is not checked when land already linked a site', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'off', GCS_BUCKET: '' })
  t.mock.method(Submission, 'findById', () =>
    lean(submissionDoc({ siteId: SITE_ID })),
  )
  const findSite = stubSite(t, null)
  await assert.rejects(
    uploadPlant(SITE_LAT, String(new mongoose.Types.ObjectId())),
    STORAGE_REACHED,
  )
  assert.equal(findSite.mock.callCount(), 0)
})

test('enforce judges the plant clip too and names it', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'enforce', GCS_BUCKET: '' })
  t.mock.method(Submission, 'findById', () =>
    lean(submissionDoc({ siteId: SITE_ID })),
  )
  stubSite(t, siteDoc())
  await assert.rejects(
    uploadPlant(SITE_LAT + 530 * M_LAT),
    refusal('Your planting video was filmed 500 m outside the checked site.'),
  )
  await assert.rejects(uploadPlant(SITE_LAT), STORAGE_REACHED)
})

test('enforce tells the planter a rejected site is rejected', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'enforce', GCS_BUCKET: '' })
  t.mock.method(Submission, 'findById', () =>
    lean(submissionDoc({ siteId: SITE_ID })),
  )
  stubSite(t, siteDoc({ status: 'rejected' }))
  await assert.rejects(
    uploadPlant(SITE_LAT),
    refusal(
      'This site was rejected in review, so planting here is not rewarded.',
    ),
  )
})

const formatUploadResponse = (doc: unknown, type: 'land' | 'plant') =>
  (service as any).formatUploadResponse(doc, type)

test('the land upload response carries the site snapshot only when linked', () => {
  const land = {
    videoCID: 'submissions/land.mp4',
    publicUrl: 'https://example.test/land.mp4',
    uploadedAt: new Date('2026-10-06T10:00:00Z'),
  }
  const plain = formatUploadResponse(
    { _id: SUBMISSION_ID, status: 'awaiting_plant', land },
    'land',
  )
  assert.deepEqual(Object.keys(plain), [
    'submissionId',
    'videoCID',
    'publicUrl',
    'uploadTimestamp',
    'type',
    'status',
    'treesPlanted',
    'treeType',
    'reverseGeocode',
  ])
  const linked = formatUploadResponse(
    {
      _id: SUBMISSION_ID,
      status: 'awaiting_plant',
      land,
      siteId: SITE_ID,
      siteCheck: {
        siteId: SITE_ID,
        siteStatus: 'approved',
        verdictCode: 'plant',
        insideSite: false,
        distanceToSiteM: 80.4,
        checkedAt: new Date(),
      },
    },
    'land',
  )
  assert.deepEqual(linked.siteCheck, {
    insideSite: false,
    distanceToSiteM: 80.4,
    siteStatus: 'approved',
    verdictCode: 'plant',
  })
})

/** A plant attach that reaches the AI routing, with the AI call stubbed. */
async function attachWithAi(
  t: TestContext,
  { trees, counted }: { trees: number; counted: number },
) {
  setEnv(t, {
    AI_PROVIDER: 'ultralytics',
    AI_API_BEARER_TOKEN: 'test-token',
    AI_API_PREDICT_URL: 'https://ai.example.test/predict',
    AI_ULTRALYTICS_INPUT_MODE: 'multipart_video',
    ENFORCE_TREE_BATCHES: 'true',
  })
  const doc = new Submission(submissionDoc())
  t.mock.method(doc, 'save', async () => doc)
  t.mock.method(Submission, 'findById', async () => doc)
  t.mock.method(Notification, 'create', async () => {
    throw new Error('no notifications in tests')
  })
  t.mock.method(axios, 'post', async () => ({
    status: 200,
    data: { mangrove_count: counted, confidence: 0.99 },
  }))
  await (service as any).attachPlantToSubmission(
    SUBMISSION_ID,
    WALLET,
    {
      uploaded: true,
      videoCID: `submissions/plant-${trees}.mp4`,
      gpsCoordinates: { latitude: SITE_LAT, longitude: SITE_LON },
    },
    trees,
    'mangrove',
    { buffer: FILE.buffer, originalname: 'plant.mp4', mimetype: 'video/mp4' },
    {},
  )
  return doc
}

test('warn: a site hold stores the flag and does not read auto-approved', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'warn' })
  const doc = await attachWithAi(t, { trees: 100, counted: 100 })
  assert.equal(doc.aiVerification?.status, 'completed')
  assert.equal(doc.status, 'pending_review')
  assert.equal(doc.aiVerification?.decision, 'pending_verifier')
  assert.equal(doc.get('siteGateFlag'), 'no_site')
})

test('the 100-tree batch hold alone keeps its AI decision', async t => {
  setEnv(t, { SITE_CHECK_ENFORCEMENT: 'off' })
  const doc = await attachWithAi(t, { trees: 150, counted: 150 })
  assert.equal(doc.aiVerification?.status, 'completed')
  assert.equal(doc.status, 'pending_review')
  assert.equal(doc.aiVerification?.decision, 'auto_approved')
  // 'off' still records why the planting fell short.
  assert.equal(doc.get('siteGateFlag'), 'no_site')
})

test('the upload route sends Site Check refusals as 400 without the IPFS prefix', async t => {
  setEnv(t, { JWT_SECRET: 'test-secret-at-least-16-chars' })
  const { default: router } = await import('../routes/submissions.js')
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === '/upload',
  )
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const call = async (error: Error) => {
    t.mock.method(SubmissionService.prototype, 'uploadClip', async () => {
      throw error
    })
    const res: any = {
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.body = body
        return this
      },
    }
    await handler(
      {
        body: { type: 'plant', latitude: 0, longitude: 0 },
        file: FILE,
        user: { walletAddress: WALLET },
      },
      res,
    )
    t.mock.restoreAll()
    return { status: res.statusCode, body: res.body }
  }
  assert.deepEqual(await call(new SiteCheckRefusal('Site not found')), {
    status: 400,
    body: { error: 'Site not found' },
  })
  const gate = 'This site has not been approved yet.'
  assert.deepEqual(await call(new SiteCheckRefusal(gate)), {
    status: 400,
    body: { error: gate },
  })
  assert.deepEqual(await call(new Error('Submission not found')), {
    status: 500,
    body: { error: 'Failed to upload to IPFS: Submission not found' },
  })
})
