import assert from 'node:assert/strict'
import test from 'node:test'
import { circleRing } from '../utils/geo'
import {
  buildSiteCheck,
  evaluateSiteGate,
  GateSite,
  parseSpeciesIds,
  SiteCheckEnforcement,
} from './siteGate'

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
    'This video was filmed 86 m outside the checked site.',
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
