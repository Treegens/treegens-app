import assert from 'node:assert/strict'
import test from 'node:test'
import { circleRing } from '../utils/geo'
import {
  buildSiteCheck,
  evaluateSiteGate,
  GateSite,
  landLinkBlockReason,
  measureClip,
  parseSpeciesIds,
  SiteCheckEnforcement,
  SiteCheckRefusal,
} from './siteGate'
import { SITE_GEOMETRY_LIMITS } from './siteRules'

const LAT = -4.423
const LON = 39.507
const M_LAT = 1 / 111_195

const approvedSite: GateSite = {
  _id: 'site-1',
  status: 'approved',
  boundary: { coordinates: [circleRing(LAT, LON, 30)] },
  verdict: { code: 'plant', headline: 'Plant here' },
}

const inside = { insideSite: true, distanceToSiteM: 0 }
const MODES: SiteCheckEnforcement[] = ['off', 'warn', 'enforce']

test('buildSiteCheck snapshots status, verdict and distance from the land GPS', () => {
  const now = new Date('2026-10-06T10:00:00Z')
  const centre = buildSiteCheck(
    approvedSite,
    { latitude: LAT, longitude: LON },
    50,
    now,
  )
  assert.deepEqual(centre, {
    siteId: 'site-1',
    siteStatus: 'approved',
    verdictCode: 'plant',
    insideSite: true,
    distanceToSiteM: 0,
    checkedAt: now,
  })
  // 70 m north of the centre is 40 m outside a 30 m circle.
  const near = buildSiteCheck(
    approvedSite,
    { latitude: LAT + 70 * M_LAT, longitude: LON },
    50,
  )
  assert.equal(near.insideSite, true)
  assert.ok(Math.abs(near.distanceToSiteM - 40) < 0.5)
  const far = buildSiteCheck(
    approvedSite,
    { latitude: LAT + 230 * M_LAT, longitude: LON },
    50,
  )
  assert.equal(far.insideSite, false)
  assert.ok(Math.abs(far.distanceToSiteM - 200) < 0.5)
})

test('buildSiteCheck records a missing verdict as null', () => {
  const draft = { ...approvedSite, status: 'draft', verdict: null }
  const check = buildSiteCheck(draft, { latitude: LAT, longitude: LON }, 50)
  assert.equal(check.verdictCode, null)
  assert.equal(check.siteStatus, 'draft')
})

test('an approved plant site with the clip inside passes in every mode', () => {
  for (const enforcement of MODES) {
    assert.deepEqual(
      evaluateSiteGate({ enforcement, siteCheck: inside, site: approvedSite }),
      { blockReason: null, allowAutoApprove: true, flag: null },
    )
  }
})

test("'off' never blocks and never changes auto-approval, only flags", () => {
  const r = evaluateSiteGate({
    enforcement: 'off',
    siteCheck: null,
    site: null,
  })
  assert.deepEqual(r, {
    blockReason: null,
    allowAutoApprove: true,
    flag: 'no_site',
  })
})

test("'warn' never blocks but sends every shortfall to verifiers", () => {
  const cases = [
    { siteCheck: null, site: null, flag: 'no_site' },
    {
      siteCheck: inside,
      site: { ...approvedSite, status: 'pending_review' },
      flag: 'site_not_approved',
    },
    {
      siteCheck: inside,
      site: { ...approvedSite, verdict: { code: 'fix_first' } },
      flag: 'verdict_not_plant',
    },
    {
      siteCheck: { insideSite: false, distanceToSiteM: 120 },
      site: approvedSite,
      flag: 'outside_site',
    },
  ]
  for (const c of cases) {
    const r = evaluateSiteGate({ enforcement: 'warn', ...c })
    assert.equal(r.blockReason, null)
    assert.equal(r.allowAutoApprove, false)
    assert.equal(r.flag, c.flag)
  }
})

test("'enforce' blocks with a plain message for each shortfall", () => {
  const block = (
    input: Omit<Parameters<typeof evaluateSiteGate>[0], 'enforcement'>,
  ) => evaluateSiteGate({ enforcement: 'enforce', ...input })
  assert.equal(
    block({ siteCheck: null, site: null }).blockReason,
    'Mangrove planting needs an approved Site Check. Register the site first.',
  )
  assert.equal(
    block({ siteCheck: inside, site: { ...approvedSite, status: 'draft' } })
      .blockReason,
    'This site has not been approved yet.',
  )
  const notPlant = block({
    siteCheck: inside,
    site: {
      ...approvedSite,
      verdict: { code: 'let_regrow', headline: 'Protect it and let it regrow' },
    },
  })
  assert.equal(
    notPlant.blockReason,
    'The Site Check verdict for this site is Protect it and let it regrow, so planting is not rewarded here.',
  )
  assert.equal(notPlant.allowAutoApprove, false)
  assert.equal(
    block({
      siteCheck: { insideSite: false, distanceToSiteM: 86.4 },
      site: approvedSite,
    }).blockReason,
    'Your before video was filmed 86 m outside the checked site.',
  )
})

test('the gate checks approval before the verdict and the verdict before GPS', () => {
  const r = evaluateSiteGate({
    enforcement: 'warn',
    siteCheck: { insideSite: false, distanceToSiteM: 500 },
    site: {
      ...approvedSite,
      status: 'rejected',
      verdict: { code: 'fix_first' },
    },
  })
  assert.equal(r.flag, 'site_not_approved')
  const r2 = evaluateSiteGate({
    enforcement: 'warn',
    siteCheck: { insideSite: false, distanceToSiteM: 500 },
    site: { ...approvedSite, verdict: { code: 'not_suitable' } },
  })
  assert.equal(r2.flag, 'verdict_not_plant')
})

test('a site without a snapshot counts as no site', () => {
  const r = evaluateSiteGate({
    enforcement: 'enforce',
    siteCheck: null,
    site: approvedSite,
  })
  assert.equal(r.flag, 'no_site')
})

test('parseSpeciesIds reads JSON arrays, comma lists and repeated fields', () => {
  assert.deepEqual(parseSpeciesIds('["avicennia_marina","Ceriops_Tagal"]'), {
    ids: ['avicennia_marina', 'ceriops_tagal'],
    unknown: [],
  })
  assert.deepEqual(parseSpeciesIds(' rhizophora_mucronata, ceriops_tagal ,'), {
    ids: ['rhizophora_mucronata', 'ceriops_tagal'],
    unknown: [],
  })
  assert.deepEqual(parseSpeciesIds(['sonneratia_alba', 'sonneratia_alba']), {
    ids: ['sonneratia_alba'],
    unknown: [],
  })
})

test('parseSpeciesIds reports unknown ids and tolerates empty input', () => {
  assert.deepEqual(parseSpeciesIds('oak,avicennia_marina'), {
    ids: ['avicennia_marina'],
    unknown: ['oak'],
  })
  assert.deepEqual(parseSpeciesIds('[not json'), {
    ids: [],
    unknown: ['[not json'],
  })
  assert.deepEqual(parseSpeciesIds(''), { ids: [], unknown: [] })
  assert.deepEqual(parseSpeciesIds(undefined), { ids: [], unknown: [] })
  assert.deepEqual(parseSpeciesIds('[]'), { ids: [], unknown: [] })
})

const NO_SITE_MESSAGE =
  'Mangrove planting needs an approved Site Check. Register the site first.'
const REJECTED_MESSAGE =
  'This site was rejected in review, so planting here is not rewarded.'

const enforce = (
  input: Omit<Parameters<typeof evaluateSiteGate>[0], 'enforcement'>,
) => evaluateSiteGate({ enforcement: 'enforce', ...input })

test('every gate branch under enforce: flag and exact message', () => {
  const cases: {
    name: string
    siteCheck: Parameters<typeof enforce>[0]['siteCheck']
    site: GateSite | null
    flag: string | null
    message: string | null
  }[] = [
    {
      name: 'no site',
      siteCheck: null,
      site: null,
      flag: 'no_site',
      message: NO_SITE_MESSAGE,
    },
    {
      name: 'draft site',
      siteCheck: inside,
      site: { ...approvedSite, status: 'draft' },
      flag: 'site_not_approved',
      message: 'This site has not been approved yet.',
    },
    {
      name: 'site in review',
      siteCheck: inside,
      site: { ...approvedSite, status: 'pending_review' },
      flag: 'site_not_approved',
      message: 'This site has not been approved yet.',
    },
    {
      name: 'rejected site',
      siteCheck: inside,
      site: { ...approvedSite, status: 'rejected' },
      flag: 'site_not_approved',
      message: REJECTED_MESSAGE,
    },
    {
      name: 'verdict without a headline',
      siteCheck: inside,
      site: { ...approvedSite, verdict: null },
      flag: 'verdict_not_plant',
      message:
        'The Site Check verdict for this site is unknown, so planting is not rewarded here.',
    },
    {
      name: 'before clip outside',
      siteCheck: { insideSite: false, distanceToSiteM: 80.4 },
      site: approvedSite,
      flag: 'outside_site',
      message: 'Your before video was filmed 80 m outside the checked site.',
    },
    {
      name: 'planting clip outside',
      siteCheck: {
        insideSite: true,
        distanceToSiteM: 0,
        plantInsideSite: false,
        plantDistanceToSiteM: 1234.6,
      },
      site: approvedSite,
      flag: 'outside_site',
      message:
        'Your planting video was filmed 1235 m outside the checked site.',
    },
    {
      name: 'both inside',
      siteCheck: { ...inside, plantInsideSite: true, plantDistanceToSiteM: 12 },
      site: approvedSite,
      flag: null,
      message: null,
    },
  ]
  for (const c of cases) {
    const r = enforce({ siteCheck: c.siteCheck, site: c.site })
    assert.equal(r.flag, c.flag, c.name)
    assert.equal(r.blockReason, c.message, c.name)
    assert.equal(r.allowAutoApprove, c.flag === null, c.name)
  }
})

test('a rejected site is reported as rejected, never as still waiting', () => {
  const rejected = { ...approvedSite, status: 'rejected' }
  for (const enforcement of MODES) {
    const r = evaluateSiteGate({
      enforcement,
      siteCheck: inside,
      site: rejected,
    })
    assert.equal(r.flag, 'site_not_approved')
    assert.equal(
      r.blockReason,
      enforcement === 'enforce' ? REJECTED_MESSAGE : null,
    )
  }
})

test('when both clips are outside, the message names the one farther out', () => {
  const site = approvedSite
  const before = enforce({
    site,
    siteCheck: {
      insideSite: false,
      distanceToSiteM: 300,
      plantInsideSite: false,
      plantDistanceToSiteM: 120,
    },
  })
  assert.equal(
    before.blockReason,
    'Your before video was filmed 300 m outside the checked site.',
  )
  const planting = enforce({
    site,
    siteCheck: {
      insideSite: false,
      distanceToSiteM: 60,
      plantInsideSite: false,
      plantDistanceToSiteM: 75.5,
    },
  })
  assert.equal(
    planting.blockReason,
    'Your planting video was filmed 76 m outside the checked site.',
  )
})

test("'warn' holds a planting whose plant clip is outside the site", () => {
  const r = evaluateSiteGate({
    enforcement: 'warn',
    site: approvedSite,
    siteCheck: {
      ...inside,
      plantInsideSite: false,
      plantDistanceToSiteM: 400,
    },
  })
  assert.deepEqual(r, {
    blockReason: null,
    allowAutoApprove: false,
    flag: 'outside_site',
  })
})

const satelliteDoubt = {
  code: 'sat_forest_mismatch',
  severity: 'check',
  source: 'satellite',
}

const SATELLITE_DONE = new Date('2026-10-01T08:00:00Z')
const REVIEWED = new Date('2026-10-02T08:00:00Z')

/** By default its satellite result was stored before verifiers approved it. */
function fixFirstSite(
  reasons: { code: string; severity: string; source: string }[],
  status = 'approved',
  dates: Pick<GateSite, 'reviewedAt' | 'hydrology'> = {
    reviewedAt: REVIEWED,
    hydrology: { completedAt: SATELLITE_DONE },
  },
): GateSite {
  return {
    ...approvedSite,
    status,
    verdict: { code: 'fix_first', headline: 'Fix first', reasons },
    ...dates,
  }
}

test('an approved fix_first site with only satellite doubts passes like plant', () => {
  const site = fixFirstSite([
    { code: 'tide_daily', severity: 'good', source: 'field' },
    satelliteDoubt,
    { code: 'sat_borderline_low', severity: 'check', source: 'satellite' },
    { code: 'satellite_pending', severity: 'info', source: 'satellite' },
  ])
  for (const enforcement of MODES) {
    assert.deepEqual(
      evaluateSiteGate({ enforcement, siteCheck: inside, site }),
      {
        blockReason: null,
        allowAutoApprove: true,
        flag: null,
      },
    )
  }
  // It still has to be filmed inside the site.
  assert.equal(
    enforce({ site, siteCheck: { insideSite: false, distanceToSiteM: 90 } })
      .flag,
    'outside_site',
  )
})

test('fix_first stays blocked when a field reason or a satellite fix holds it back', () => {
  const blocked = [
    fixFirstSite([
      satelliteDoubt,
      { code: 'c', severity: 'check', source: 'field' },
    ]),
    fixFirstSite([
      satelliteDoubt,
      { code: 'f', severity: 'fix', source: 'field' },
    ]),
    fixFirstSite([{ code: 'f', severity: 'fix', source: 'satellite' }]),
    fixFirstSite([
      satelliteDoubt,
      { code: 'b', severity: 'blocker', source: 'field' },
    ]),
    fixFirstSite([]),
    { ...approvedSite, verdict: { code: 'fix_first', headline: 'Fix first' } },
    fixFirstSite([{ code: 's', severity: 'check', source: undefined as any }]),
  ]
  for (const site of blocked) {
    const r = enforce({ siteCheck: inside, site })
    assert.equal(r.flag, 'verdict_not_plant')
    assert.equal(
      r.blockReason,
      'The Site Check verdict for this site is Fix first, so planting is not rewarded here.',
    )
  }
})

test('satellite doubts that arrived after the approval keep fix_first blocked', () => {
  const doubts = [
    { code: 'sat_too_low', severity: 'check', source: 'satellite' },
    { code: 'tide_daily', severity: 'good', source: 'field' },
  ]
  const late = new Date(REVIEWED.getTime() + 60_000)
  const unseen = [
    // The run finished, or a recheck stored a new result, after the review.
    fixFirstSite(doubts, 'approved', {
      reviewedAt: REVIEWED,
      hydrology: { completedAt: late },
    }),
    fixFirstSite(doubts, 'approved', {
      reviewedAt: REVIEWED.toISOString(),
      hydrology: { completedAt: late.toISOString() },
    }),
    // Without both dates nobody can tell, so it is not taken on trust.
    fixFirstSite(doubts, 'approved', { reviewedAt: REVIEWED }),
    fixFirstSite(doubts, 'approved', {
      hydrology: { completedAt: SATELLITE_DONE },
    }),
    fixFirstSite(doubts, 'approved', {
      reviewedAt: REVIEWED,
      hydrology: null,
    }),
  ]
  for (const site of unseen) {
    assert.equal(enforce({ siteCheck: inside, site }).flag, 'verdict_not_plant')
    assert.deepEqual(
      evaluateSiteGate({ enforcement: 'warn', siteCheck: inside, site }),
      { blockReason: null, allowAutoApprove: false, flag: 'verdict_not_plant' },
    )
  }
  // A result stored at the very moment of the review counts as seen.
  const sameTime = fixFirstSite(doubts, 'approved', {
    reviewedAt: REVIEWED,
    hydrology: { completedAt: REVIEWED.toISOString() },
  })
  assert.equal(enforce({ siteCheck: inside, site: sameTime }).flag, null)
  // A 'plant' verdict does not depend on when the satellite result came.
  assert.equal(
    enforce({
      siteCheck: inside,
      site: { ...approvedSite, hydrology: { completedAt: late } },
    }).flag,
    null,
  )
})

test('satellite doubts do not let an unapproved or non-fix_first site through', () => {
  assert.equal(
    enforce({
      siteCheck: inside,
      site: fixFirstSite([satelliteDoubt], 'pending_review'),
    }).flag,
    'site_not_approved',
  )
  const regrow: GateSite = {
    ...approvedSite,
    verdict: {
      code: 'let_regrow',
      headline: 'Protect it and let it regrow',
      reasons: [satelliteDoubt],
    },
  }
  assert.equal(
    enforce({ siteCheck: inside, site: regrow }).flag,
    'verdict_not_plant',
  )
})

test('landLinkBlockReason refuses an outside land clip only under enforce', () => {
  const outside = { insideSite: false, distanceToSiteM: 80.4 }
  assert.equal(
    landLinkBlockReason('enforce', outside),
    'This video was filmed 80 m outside the checked site. Film it again from inside the site.',
  )
  assert.equal(landLinkBlockReason('enforce', inside), null)
  assert.equal(landLinkBlockReason('warn', outside), null)
  assert.equal(landLinkBlockReason('off', outside), null)
})

test('SiteCheckRefusal is an Error carrying the message as is', () => {
  const e = new SiteCheckRefusal('Site not found')
  assert.ok(e instanceof Error)
  assert.equal(e.message, 'Site not found')
  assert.equal(e.name, 'SiteCheckRefusal')
})

// A 1 cm wide sliver along 333 km of coast: under 1 ha, so the area cap
// alone lets it through, and every point near the line is within 50 m.
const sliver: GateSite = {
  _id: 'sliver',
  status: 'approved',
  boundary: {
    coordinates: [
      [
        [39.6, -4.6],
        [39.6000001, -3.1],
        [39.6, -1.6],
        [39.6, -4.6],
      ],
    ],
  },
  center: { latitude: -3.1, longitude: 39.6 },
  verdict: { code: 'plant', headline: 'Plant here' },
}

test('a clip far from the centre is outside even beside a sliver edge', () => {
  const nearEdgeFar = measureClip(
    sliver,
    { latitude: -4.5, longitude: 39.6003 },
    50,
  )
  assert.equal(nearEdgeFar.insideSite, false)
  // About 155 km from the centre, so far beyond the 1500 m extent.
  assert.ok(nearEdgeFar.distanceToSiteM > 150_000)
  const snapshot = buildSiteCheck(
    sliver,
    { latitude: -2.0, longitude: 39.6003 },
    50,
  )
  assert.equal(snapshot.insideSite, false)
  const nearCentre = measureClip(
    sliver,
    { latitude: -3.1, longitude: 39.6003 },
    50,
  )
  assert.equal(nearCentre.insideSite, true)
  assert.ok(nearCentre.distanceToSiteM < 50)
})

test('the extent check never changes the result for a normal site', () => {
  const site: GateSite = {
    ...approvedSite,
    center: { latitude: LAT, longitude: LON },
  }
  for (const metres of [
    0,
    20,
    70,
    230,
    1000,
    SITE_GEOMETRY_LIMITS.maxExtentM,
  ]) {
    const gps = { latitude: LAT + metres * M_LAT, longitude: LON }
    assert.deepEqual(
      measureClip(site, gps, 50),
      measureClip({ ...site, center: undefined }, gps, 50),
      `${metres} m`,
    )
  }
})

test('the extent cut-off sits at the extent plus the tolerance', () => {
  // 33 m beside the sliver line, so only the distance from the centre counts.
  const at = (metresFromCentre: number) =>
    measureClip(
      sliver,
      { latitude: -3.1 + metresFromCentre * M_LAT, longitude: 39.6003 },
      50,
    )
  const max = SITE_GEOMETRY_LIMITS.maxExtentM
  assert.equal(at(max + 40).insideSite, true)
  assert.ok(Math.abs(at(max + 40).distanceToSiteM - 40) < 1)
  assert.equal(at(max + 70).insideSite, false)
  assert.ok(Math.abs(at(max + 70).distanceToSiteM - 70) < 1)
})
