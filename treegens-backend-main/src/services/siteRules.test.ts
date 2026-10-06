import assert from 'node:assert/strict'
import test from 'node:test'
import { closeRing, LonLat, ringAreaM2 } from '../utils/geo'
import {
  buildSiteGeometry,
  canRecheckHydrology,
  missingSitePhotos,
  normalizeCountryCode,
  resolveSiteReview,
  sanitizeSiteAnswers,
  SITE_ERRORS,
  siteVerdictFor,
} from './siteRules'

const LAT = -4.423
const LON = 39.507
const M_LAT = 1 / 111_195
const M_LON = M_LAT / Math.cos((LAT * Math.PI) / 180)

/** Square of `side` metres with its south-west corner at the test point. */
function square(side: number): LonLat[] {
  return [
    [LON, LAT],
    [LON + side * M_LON, LAT],
    [LON + side * M_LON, LAT + side * M_LAT],
    [LON, LAT + side * M_LAT],
  ]
}

test('sanitizeSiteAnswers keeps valid answers and drops everything else', () => {
  const answers = sanitizeSiteAnswers({
    previousUse: 'mangrove_cut',
    currentCover: 'lawn',
    tideReach: 'daily',
    lossCauses: ['cutting', 'aliens', 'cutting', 'erosion'],
    erosionScarps: 'yes',
    nearbyCanopyImpact: 3,
    tideMarkCm: 900,
    notes: '  cut for charcoal in 2019  ',
    password: 'hunter2',
  })
  assert.deepEqual(answers, {
    previousUse: 'mangrove_cut',
    tideReach: 'daily',
    lossCauses: ['cutting', 'erosion'],
    nearbyCanopyImpact: 3,
    notes: 'cut for charcoal in 2019',
  })
})

test('sanitizeSiteAnswers handles junk input and caps notes', () => {
  assert.deepEqual(sanitizeSiteAnswers(null), {})
  assert.deepEqual(sanitizeSiteAnswers('daily'), {})
  assert.deepEqual(
    sanitizeSiteAnswers({ lossCauses: ['nope'], notes: '   ' }),
    {},
  )
  const long = sanitizeSiteAnswers({ notes: 'x'.repeat(1500) })
  assert.equal(long.notes?.length, 1000)
  assert.deepEqual(
    sanitizeSiteAnswers({ erosionScarps: false, nearbyCanopyImpact: 0 }),
    { erosionScarps: false, nearbyCanopyImpact: 0 },
  )
})

test('siteVerdictFor uses only sanitized answers', () => {
  const verdict = siteVerdictFor(
    { answers: { currentCover: 'seagrass', tideReach: 'bogus' } },
    null,
  )
  assert.equal(verdict.code, 'not_suitable')
  assert.ok(verdict.reasons.some(r => r.code === 'tide_unknown'))
  assert.equal(verdict.hydrologyConsidered, false)
})

test('normalizeCountryCode accepts two letters only', () => {
  assert.equal(normalizeCountryCode(' ke '), 'KE')
  assert.equal(normalizeCountryCode('KEN'), undefined)
  assert.equal(normalizeCountryCode(''), undefined)
  assert.equal(normalizeCountryCode(null), undefined)
})

test('missingSitePhotos needs the low-tide 360 and the ground close-up', () => {
  assert.deepEqual(missingSitePhotos([]), ['low_tide_360', 'ground'])
  assert.deepEqual(missingSitePhotos([{ kind: 'ground' }]), ['low_tide_360'])
  assert.deepEqual(
    missingSitePhotos([
      { kind: 'tide_mark' },
      { kind: 'low_tide_360' },
      { kind: 'ground' },
    ]),
    [],
  )
  assert.deepEqual(missingSitePhotos(undefined), ['low_tide_360', 'ground'])
})

test('buildSiteGeometry turns a walked boundary into a closed polygon', () => {
  const ring = square(100)
  const g = buildSiteGeometry({ boundaryMethod: 'walked', ring }, 500_000)
  assert.equal(g.boundaryMethod, 'walked')
  assert.equal(g.boundary.type, 'Polygon')
  assert.deepEqual(g.boundary.coordinates[0], closeRing(ring))
  assert.ok(Math.abs(g.areaM2 - 10_000) < 50)
  assert.ok(Math.abs(g.center.latitude - (LAT + 50 * M_LAT)) < 1e-7)
  assert.equal('radiusM' in g, false)
})

test('buildSiteGeometry draws a circle for a pin and radius', () => {
  const g = buildSiteGeometry(
    {
      boundaryMethod: 'pin_radius',
      center: { latitude: LAT, longitude: LON },
      radiusM: 25,
    },
    500_000,
  )
  assert.equal(g.radiusM, 25)
  assert.deepEqual(g.center, { latitude: LAT, longitude: LON })
  const ring = g.boundary.coordinates[0]
  assert.deepEqual(ring[0], ring[ring.length - 1])
  assert.ok(Math.abs(g.areaM2 - Math.PI * 625) < 20)
})

test('buildSiteGeometry refuses bad, tiny and huge boundaries', () => {
  const walked = (ring: LonLat[]) =>
    buildSiteGeometry({ boundaryMethod: 'walked', ring }, 20_000)
  assert.throws(() => walked(square(5)), { message: SITE_ERRORS.tooSmall })
  assert.throws(() => walked(square(200)), { message: SITE_ERRORS.tooLarge })
  assert.throws(() => walked(square(100).slice(0, 2)), {
    message: SITE_ERRORS.invalidBoundary,
  })
  assert.throws(() => buildSiteGeometry({ boundaryMethod: 'walked' }, 20_000), {
    message: SITE_ERRORS.invalidBoundary,
  })
  const pin = (radiusM: number, center = { latitude: LAT, longitude: LON }) =>
    buildSiteGeometry({ boundaryMethod: 'pin_radius', center, radiusM }, 20_000)
  assert.throws(() => pin(4), { message: SITE_ERRORS.invalidBoundary })
  assert.throws(() => pin(301), { message: SITE_ERRORS.invalidBoundary })
  assert.throws(() => pin(100), { message: SITE_ERRORS.tooLarge })
  assert.throws(() => pin(10, { latitude: 95, longitude: LON }), {
    message: SITE_ERRORS.invalidBoundary,
  })
  assert.ok(ringAreaM2(pin(50).boundary.coordinates[0]) < 20_000)
})

test('buildSiteGeometry refuses a thin sliver that runs for kilometres', () => {
  // Under 0.2 ha, but 333 km long: within 50 m of it would count as inside.
  const sliver: LonLat[] = [
    [39.6, -4.6],
    [39.6000001, -3.1],
    [39.6, -1.6],
  ]
  assert.ok(ringAreaM2(closeRing(sliver)) < 2_000)
  assert.throws(
    () =>
      buildSiteGeometry({ boundaryMethod: 'walked', ring: sliver }, 500_000),
    { message: SITE_ERRORS.tooLarge },
  )
  // A long, narrow real site (1.4 km by 100 m) is still fine.
  const strip: LonLat[] = [
    [LON, LAT],
    [LON + 1400 * M_LON, LAT],
    [LON + 1400 * M_LON, LAT + 100 * M_LAT],
    [LON, LAT + 100 * M_LAT],
  ]
  const g = buildSiteGeometry(
    { boundaryMethod: 'walked', ring: strip },
    500_000,
  )
  assert.ok(Math.abs(g.areaM2 - 140_000) < 1_000)
})

test('buildSiteGeometry refuses sites over the 180th meridian', () => {
  const crossing = { message: SITE_ERRORS.crossesAntimeridian }
  // A pin near the meridian in Fiji: its circle would cross it.
  assert.throws(
    () =>
      buildSiteGeometry(
        {
          boundaryMethod: 'pin_radius',
          center: { latitude: -16.5, longitude: 179.999 },
          radiusM: 300,
        },
        500_000,
      ),
    crossing,
  )
  const walked: LonLat[] = [
    [179.999, -16.5],
    [-179.999, -16.5],
    [-179.999, -16.502],
    [179.999, -16.502],
  ]
  assert.throws(
    () =>
      buildSiteGeometry({ boundaryMethod: 'walked', ring: walked }, 500_000),
    crossing,
  )
  // Close to the meridian but not over it is fine, and stays in range.
  const g = buildSiteGeometry(
    {
      boundaryMethod: 'pin_radius',
      center: { latitude: -16.5, longitude: 179.99 },
      radiusM: 300,
    },
    500_000,
  )
  for (const [lon] of g.boundary.coordinates[0]) assert.ok(lon <= 180)
})

const yes = (w: string) => ({ voterWalletAddress: w, vote: 'yes' as const })
const no = (w: string) => ({ voterWalletAddress: w, vote: 'no' as const })
const verifiers = ['0xa', '0xb', '0xc', '0xd', '0xe']

test('resolveSiteReview waits for enough verifiers to exist', () => {
  const r = resolveSiteReview({
    votes: [yes('0xa'), yes('0xb'), yes('0xc')],
    activeVerifierWallets: verifiers.slice(0, 3),
    totalVerifiers: 3,
    minimumActiveVerifiers: 5,
  })
  assert.deepEqual(r, {
    outcome: null,
    majorityVote: null,
    blockedByVerifierThreshold: true,
  })
})

test('resolveSiteReview needs a strict majority of the whole pool', () => {
  const base = {
    activeVerifierWallets: verifiers,
    totalVerifiers: 5,
    minimumActiveVerifiers: 5,
  }
  const pending = resolveSiteReview({
    ...base,
    votes: [yes('0xa'), yes('0xb'), no('0xc')],
  })
  assert.equal(pending.outcome, null)
  assert.equal(pending.blockedByVerifierThreshold, false)
  const approved = resolveSiteReview({
    ...base,
    votes: [yes('0xa'), yes('0xb'), yes('0xc')],
  })
  assert.equal(approved.outcome, 'approved')
  assert.equal(approved.majorityVote, 'yes')
  const rejected = resolveSiteReview({
    ...base,
    votes: [no('0xa'), no('0xB'), no('0xc'), yes('0xd')],
  })
  assert.equal(rejected.outcome, 'rejected')
})

test('resolveSiteReview counts one vote per wallet', () => {
  // Two stored rows from one double tap must not count as two verifiers.
  const r = resolveSiteReview({
    votes: [yes('0xa'), yes('0xA'), yes('0xb')],
    activeVerifierWallets: verifiers,
    totalVerifiers: 5,
    minimumActiveVerifiers: 5,
  })
  assert.equal(r.outcome, null)
  assert.equal(r.majorityVote, null)
})

test('resolveSiteReview ignores votes from wallets that stopped verifying', () => {
  const r = resolveSiteReview({
    votes: [yes('0xa'), yes('0xold1'), yes('0xold2')],
    activeVerifierWallets: verifiers,
    totalVerifiers: 5,
    minimumActiveVerifiers: 5,
  })
  assert.equal(r.outcome, null)
})

test('canRecheckHydrology allows failed, skipped and month-old checks', () => {
  const now = new Date('2026-10-06T00:00:00Z')
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)
  assert.equal(canRecheckHydrology({ status: 'failed' }, now), true)
  assert.equal(canRecheckHydrology({ status: 'skipped' }, now), true)
  assert.equal(
    canRecheckHydrology({ status: 'completed', completedAt: daysAgo(31) }, now),
    true,
  )
  assert.equal(
    canRecheckHydrology({ status: 'completed', completedAt: daysAgo(5) }, now),
    false,
  )
  assert.equal(canRecheckHydrology({ status: 'queued' }, now), false)
  assert.equal(canRecheckHydrology({ status: 'processing' }, now), false)
  assert.equal(canRecheckHydrology(null, now), false)
})
