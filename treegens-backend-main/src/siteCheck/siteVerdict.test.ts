import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  findSpecies,
  MANGROVE_SPECIES,
  mangrovesNative,
  regionForCountry,
  speciesFor,
} from './mangroveSpecies'
import {
  computeSiteVerdict,
  HydrologySummary,
  missingAnswers,
  REQUIRED_ANSWERS,
  SITE_RULES_VERSION,
  SiteAnswers,
  SiteVerdict,
} from './siteVerdict'

/** A cleared site with the tide coming in daily: the textbook "plant". */
const GOOD: SiteAnswers = {
  previousUse: 'mangrove_cut',
  currentCover: 'bare_mud',
  tideReach: 'daily',
  depthVsReference: 'similar',
  flowBlocked: 'no',
  lossCauses: ['cutting'],
  causeStillActive: 'no',
  naturalRecruitment: 'none',
  shoreExposure: 'sheltered',
  substrate: 'soft_mud',
  nearestMangroves: 'within_100m',
}

const sat = (
  hydrologyClass: HydrologySummary['hydrologyClass'],
  confidence: HydrologySummary['confidence'] = 'high',
  medianWetFraction: number | null = 0.3,
  referenceP50: number | null = 0.36,
): HydrologySummary => ({
  hydrologyClass,
  confidence,
  medianWetFraction,
  referenceP50,
})

function verdict(
  answers: SiteAnswers,
  hydrology: HydrologySummary | null = null,
  countryCode: string | null = 'KE',
): SiteVerdict {
  return computeSiteVerdict({ answers, hydrology, countryCode })
}

const codes = (v: SiteVerdict) => v.reasons.map(r => r.code)
const reason = (v: SiteVerdict, code: string) =>
  v.reasons.find(r => r.code === code)

// --- Outcomes and precedence ---

test('a cleared, tidal, sheltered site with an in-range satellite result is "plant"', () => {
  const v = verdict(GOOD, sat('in_range'))
  assert.equal(v.code, 'plant')
  assert.equal(v.headline, 'Plant here')
  assert.equal(v.needsFieldCheck, false)
  assert.equal(v.hydrologyConsidered, true)
  assert.equal(v.rulesVersion, SITE_RULES_VERSION)
  assert.equal(v.recommendedZone, 'middle')
  assert.deepEqual(v.recommendedSpeciesIds, [
    'rhizophora_mucronata',
    'ceriops_tagal',
    'bruguiera_gymnorhiza',
  ])
  assert.ok(codes(v).includes('mix_species'))
  assert.equal(reason(v, 'sat_in_range')?.source, 'satellite')
  assert.equal(reason(v, 'daily_tides')?.source, 'field')
})

test('the verdict is the same for the same input (pure)', () => {
  assert.deepEqual(
    verdict(GOOD, sat('in_range')),
    verdict(GOOD, sat('in_range')),
  )
})

test('before the satellite runs, a good site is still "plant" with a pending note', () => {
  const v = verdict(GOOD)
  assert.equal(v.code, 'plant')
  assert.equal(v.hydrologyConsidered, false)
  assert.equal(reason(v, 'satellite_pending')?.severity, 'info')
  assert.equal(v.recommendedZone, 'middle')
})

test('healthy forest is "let_regrow", even when a blocker is also present', () => {
  const v = verdict({
    ...GOOD,
    currentCover: 'healthy_mangrove',
    tideReach: 'always_underwater',
  })
  assert.equal(v.code, 'let_regrow')
  assert.equal(v.headline, 'Protect it and let it regrow')
  assert.ok(codes(v).includes('healthy_forest'))
  assert.ok(codes(v).includes('always_underwater'))
  assert.equal(v.recommendedZone, null)
  assert.deepEqual(v.recommendedSpeciesIds, [])
})

test('a blocker beats natural regrowth', () => {
  const v = verdict({
    ...GOOD,
    currentCover: 'seagrass',
    naturalRecruitment: 'many',
  })
  assert.equal(v.code, 'not_suitable')
  assert.equal(v.headline, 'Not a mangrove site')
  assert.ok(codes(v).includes('natural_regrowth'))
  assert.equal(v.recommendedZone, null)
})

test('natural regrowth beats things to fix', () => {
  const v = verdict({
    ...GOOD,
    naturalRecruitment: 'many',
    flowBlocked: 'yes_not_fixed',
  })
  assert.equal(v.code, 'let_regrow')
  assert.ok(codes(v).includes('flow_blocked'))
})

test('something to fix gives "fix_first" with a zone and species', () => {
  const v = verdict({ ...GOOD, flowBlocked: 'yes_not_fixed' })
  assert.equal(v.code, 'fix_first')
  assert.equal(v.headline, 'Fix first')
  assert.equal(reason(v, 'flow_blocked')?.severity, 'fix')
  assert.equal(v.needsFieldCheck, false)
  assert.equal(v.recommendedZone, 'middle')
  assert.ok(v.recommendedSpeciesIds.length > 0)
  assert.equal(codes(v).includes('mix_species'), false)
})

test('something to check also gives "fix_first" and asks for a field check', () => {
  const v = verdict({ ...GOOD, tideReach: 'unsure' })
  assert.equal(v.code, 'fix_first')
  assert.equal(reason(v, 'tide_unknown')?.severity, 'check')
  assert.equal(v.needsFieldCheck, true)
  // No tide answer and no satellite: no zone to recommend.
  assert.equal(v.recommendedZone, null)
  assert.deepEqual(v.recommendedSpeciesIds, [])
})

// --- Field rules ---

test('ground that never held mangroves blocks open ground only', () => {
  const bare = verdict({ ...GOOD, previousUse: 'never_mangrove' })
  assert.equal(bare.code, 'not_suitable')
  assert.equal(reason(bare, 'never_mangrove')?.severity, 'blocker')
  const degraded = verdict({
    ...GOOD,
    previousUse: 'never_mangrove',
    currentCover: 'degraded_mangrove',
  })
  assert.equal(codes(degraded).includes('never_mangrove'), false)
})

test('rock, coral and always-underwater spots are not mangrove sites', () => {
  for (const answers of [
    { ...GOOD, substrate: 'rock_or_rubble' as const },
    { ...GOOD, currentCover: 'rock_or_coral' as const },
    { ...GOOD, tideReach: 'always_underwater' as const },
    { ...GOOD, depthVsReference: 'much_deeper' as const },
  ]) {
    assert.equal(verdict(answers).code, 'not_suitable')
  }
})

test('above the tide is a blocker unless a blocked flow explains it', () => {
  const dry = verdict({ ...GOOD, tideReach: 'never' })
  assert.equal(dry.code, 'not_suitable')
  assert.ok(codes(dry).includes('above_tide'))
  const blocked = verdict({
    ...GOOD,
    tideReach: 'never',
    flowBlocked: 'yes_not_fixed',
  })
  assert.equal(blocked.code, 'fix_first')
  assert.ok(codes(blocked).includes('tide_blocked'))
  // The blocked flow is reported once, as the tide reason.
  assert.equal(codes(blocked).includes('flow_blocked'), false)
})

test('a spot kept underwater by a blocked flow is "fix_first", not a blocker', () => {
  const pond: SiteAnswers = {
    ...GOOD,
    previousUse: 'pond_or_salt_pan',
    tideReach: 'always_underwater',
    flowBlocked: 'yes_not_fixed',
  }
  const v = verdict(pond)
  assert.equal(v.code, 'fix_first')
  assert.equal(reason(v, 'water_trapped')?.severity, 'fix')
  assert.equal(codes(v).includes('always_underwater'), false)
  // The blocked flow is reported once, as the tide reason.
  assert.equal(codes(v).includes('flow_blocked'), false)
  // A satellite reading of the trapped water asks for a recheck only.
  for (const cls of ['permanently_wet', 'too_low'] as const) {
    const wet = verdict(pond, sat(cls, 'high'))
    assert.equal(wet.code, 'fix_first', cls)
    const r = reason(wet, `sat_${cls}`)
    assert.equal(r?.severity, 'check', cls)
    assert.match(r!.message, /blocked flow/)
  }
  // Without the blocked flow, standing water is still not a mangrove site.
  const open = verdict({ ...pond, flowBlocked: 'no' }, sat('permanently_wet'))
  assert.equal(open.code, 'not_suitable')
  assert.equal(reason(open, 'sat_permanently_wet')?.severity, 'blocker')
})

test('an active cause of loss must stop first, and its name is in the message', () => {
  for (const causeStillActive of ['yes', 'partly'] as const) {
    const v = verdict({
      ...GOOD,
      lossCauses: ['cutting', 'grazing', 'unknown'],
      causeStillActive,
    })
    assert.equal(v.code, 'fix_first')
    const r = reason(v, 'cause_active')
    assert.equal(r?.severity, 'fix')
    assert.match(r!.message, /\(tree cutting, animals grazing or digging\)/)
  }
  const unsure = verdict({ ...GOOD, causeStillActive: 'unsure' })
  assert.equal(reason(unsure, 'cause_unknown')?.severity, 'check')
  const onlyUnknown = verdict({
    ...GOOD,
    previousUse: 'pond_or_salt_pan',
    lossCauses: ['unknown'],
    causeStillActive: 'yes',
  })
  assert.equal(codes(onlyUnknown).includes('cause_active'), false)
})

test('"Mangroves, now cut" counts as cutting even with no cause chosen', () => {
  for (const lossCauses of [undefined, ['unknown' as const]]) {
    const v = verdict({ ...GOOD, lossCauses, causeStillActive: 'yes' })
    assert.equal(v.code, 'fix_first')
    assert.match(reason(v, 'cause_active')!.message, /\(tree cutting\)/)
  }
  // Cutting is named once, after the planter's own causes.
  const both = verdict({
    ...GOOD,
    lossCauses: ['grazing', 'cutting'],
    causeStillActive: 'partly',
  })
  assert.match(
    reason(both, 'cause_active')!.message,
    /\(animals grazing or digging, tree cutting\)/,
  )
})

test('exposed and eroding shores', () => {
  const both = verdict({
    ...GOOD,
    shoreExposure: 'exposed',
    erosionScarps: true,
  })
  assert.equal(both.code, 'not_suitable')
  assert.ok(codes(both).includes('exposed_eroding'))
  const exposed = verdict({ ...GOOD, shoreExposure: 'exposed' })
  assert.equal(exposed.code, 'fix_first')
  assert.equal(reason(exposed, 'exposed')?.severity, 'fix')
  const scarps = verdict({ ...GOOD, erosionScarps: true })
  assert.equal(reason(scarps, 'erosion')?.severity, 'check')
})

test('"Not sure" about waves or wild seedlings asks for a check', () => {
  for (const [answers, code] of [
    [{ ...GOOD, shoreExposure: 'unsure' }, 'exposure_unknown'],
    [{ ...GOOD, naturalRecruitment: 'unsure' }, 'regrowth_unknown'],
  ] as const) {
    const v = verdict(answers, sat('in_range'))
    assert.equal(v.code, 'fix_first', code)
    assert.equal(reason(v, code)?.severity, 'check', code)
    assert.equal(v.needsFieldCheck, true, code)
  }
  // Unsure waves do not hide the erosion check.
  const both = verdict({
    ...GOOD,
    shoreExposure: 'unsure',
    erosionScarps: true,
  })
  assert.ok(codes(both).includes('exposure_unknown'))
  assert.ok(codes(both).includes('erosion'))
})

test('sand, salt crust and no nearby mangroves each ask for a check', () => {
  for (const [answers, code] of [
    [{ ...GOOD, substrate: 'sand' }, 'sandy'],
    [{ ...GOOD, substrate: 'salt_crust' }, 'hypersaline'],
    [{ ...GOOD, nearestMangroves: 'none_known' }, 'no_reference'],
    [{ ...GOOD, flowBlocked: 'unsure' }, 'flow_unknown'],
  ] as const) {
    const v = verdict(answers)
    assert.equal(v.code, 'fix_first', code)
    assert.equal(reason(v, code)?.severity, 'check')
  }
})

test('notes that do not change the verdict', () => {
  const v = verdict({
    ...GOOD,
    previousUse: 'pond_or_salt_pan',
    naturalRecruitment: 'few',
    nearbyCanopyImpact: 4,
  })
  assert.equal(v.code, 'plant')
  for (const code of ['former_pond', 'some_regrowth', 'nearby_impacted']) {
    assert.equal(reason(v, code)?.severity, 'info', code)
  }
  const unknownInForest = verdict({
    ...GOOD,
    previousUse: 'unknown',
    currentCover: 'degraded_mangrove',
  })
  assert.equal(reason(unknownInForest, 'history_unknown')?.severity, 'info')
  assert.equal(unknownInForest.code, 'plant')
})

test('unknown history on open ground asks for a check, like "Never" would block', () => {
  for (const currentCover of ['bare_mud', 'sand', 'grass_or_shrub'] as const) {
    const v = verdict(
      { ...GOOD, previousUse: 'unknown', currentCover },
      sat('insufficient_data', 'low', null, null),
    )
    assert.equal(v.code, 'fix_first', currentCover)
    assert.equal(reason(v, 'history_unknown')?.severity, 'check')
    assert.equal(v.needsFieldCheck, true)
  }
})

// --- Satellite rules ---

test('a confident "too low" or "always wet" satellite result is a blocker', () => {
  for (const cls of ['too_low', 'permanently_wet'] as const) {
    for (const confidence of ['medium', 'high'] as const) {
      const v = verdict(GOOD, sat(cls, confidence))
      assert.equal(v.code, 'not_suitable', `${cls} ${confidence}`)
      assert.equal(reason(v, `sat_${cls}`)?.severity, 'blocker')
    }
  }
})

test('a low-confidence satellite result only asks for a check', () => {
  for (const cls of ['too_low', 'permanently_wet'] as const) {
    const v = verdict(GOOD, sat(cls, 'low'))
    assert.equal(v.code, 'fix_first', cls)
    const r = reason(v, `sat_${cls}`)
    assert.equal(r?.severity, 'check')
    assert.equal(r?.source, 'satellite')
    assert.equal(v.needsFieldCheck, true)
  }
})

test('a low-confidence "too low" or "always wet" result points to seaward species', () => {
  for (const cls of ['too_low', 'permanently_wet'] as const) {
    const v = verdict(GOOD, sat(cls, 'low', 0.8, 0.36))
    assert.equal(v.code, 'fix_first', cls)
    assert.equal(v.recommendedZone, 'seaward', cls)
    assert.deepEqual(v.recommendedSpeciesIds, [
      'sonneratia_alba',
      'avicennia_marina',
      'rhizophora_mucronata',
    ])
  }
})

test('borderline low asks for a high-tide photo and points to seaward species', () => {
  const v = verdict(GOOD, sat('borderline_low'))
  assert.equal(v.code, 'fix_first')
  assert.equal(reason(v, 'sat_borderline_low')?.severity, 'check')
  assert.equal(v.recommendedZone, 'seaward')
  assert.deepEqual(v.recommendedSpeciesIds, [
    'sonneratia_alba',
    'avicennia_marina',
    'rhizophora_mucronata',
  ])
})

test('rarely wet is a check only when the planter says the tide comes daily', () => {
  const daily = verdict(GOOD, sat('rarely_wet'))
  assert.equal(reason(daily, 'sat_rarely_wet')?.severity, 'check')
  assert.equal(daily.code, 'fix_first')
  const spring = verdict(
    { ...GOOD, tideReach: 'spring_tides_only' },
    sat('rarely_wet'),
  )
  assert.equal(reason(spring, 'sat_rarely_wet')?.severity, 'info')
  assert.equal(spring.code, 'plant')
  assert.equal(spring.recommendedZone, 'landward')
})

test('mapped forest: protect it, unless the planter says it was cleared', () => {
  const unanswered = verdict(
    { ...GOOD, currentCover: undefined },
    sat('existing_mangrove'),
  )
  assert.equal(unanswered.code, 'let_regrow')
  assert.equal(reason(unanswered, 'sat_existing_forest')?.severity, 'protect')
  // Cut since the 2021 map, or damaged: the old map does not hold it back.
  const cleared = verdict(GOOD, sat('existing_mangrove'))
  assert.equal(cleared.code, 'plant')
  const note = reason(cleared, 'sat_forest_mismatch')
  assert.equal(note?.severity, 'info')
  assert.match(note!.message, /2021/)
  const damaged = verdict(
    {
      ...GOOD,
      previousUse: 'pond_or_salt_pan',
      currentCover: 'degraded_mangrove',
    },
    sat('existing_mangrove'),
  )
  assert.equal(reason(damaged, 'sat_forest_mismatch')?.severity, 'info')
  assert.equal(damaged.code, 'plant')
  // Open ground with no word of cutting: the conflict needs a check.
  const conflict = verdict(
    { ...GOOD, previousUse: 'pond_or_salt_pan' },
    sat('existing_mangrove'),
  )
  assert.equal(conflict.code, 'fix_first')
  assert.equal(reason(conflict, 'sat_forest_mismatch')?.severity, 'check')
})

test('too little imagery is noted but not counted as a satellite result', () => {
  const v = verdict(GOOD, sat('insufficient_data', 'low', null, null))
  assert.equal(v.code, 'plant')
  assert.equal(reason(v, 'sat_no_data')?.severity, 'info')
  assert.equal(v.hydrologyConsidered, false)
})

// --- Planting zone ---

test('zone: spring tides or shallower water mean landward, whatever the satellite says', () => {
  const spring = verdict(
    { ...GOOD, tideReach: 'spring_tides_only' },
    sat('in_range', 'high', 0.5, 0.3),
  )
  assert.equal(spring.recommendedZone, 'landward')
  const shallower = verdict({ ...GOOD, depthVsReference: 'shallower' })
  assert.equal(shallower.recommendedZone, 'landward')
  assert.deepEqual(shallower.recommendedSpeciesIds, [
    'avicennia_marina',
    'ceriops_tagal',
    'bruguiera_gymnorhiza',
    'xylocarpus_granatum',
    'lumnitzera_racemosa',
    'heritiera_littoralis',
  ])
})

test('zone: in range and wetter than the reference median is seaward, drier is middle', () => {
  assert.equal(
    verdict(GOOD, sat('in_range', 'high', 0.4, 0.36)).recommendedZone,
    'seaward',
  )
  assert.equal(
    verdict(GOOD, sat('in_range', 'high', 0.36, 0.36)).recommendedZone,
    'seaward',
  )
  assert.equal(
    verdict(GOOD, sat('in_range', 'high', 0.2, 0.36)).recommendedZone,
    'middle',
  )
  // Without the numbers it falls back to the tide answer.
  assert.equal(
    verdict(GOOD, sat('in_range', 'high', null, null)).recommendedZone,
    'middle',
  )
})

test('zone: none for sites that should not be planted', () => {
  assert.equal(
    verdict({ ...GOOD, currentCover: 'seagrass' }).recommendedZone,
    null,
  )
  assert.equal(
    verdict({ ...GOOD, naturalRecruitment: 'many' }).recommendedZone,
    null,
  )
})

// --- Species by country ---

test('species are limited to the country region', () => {
  const kenya = verdict(GOOD, sat('in_range', 'high', 0.4, 0.36), 'KE')
  assert.deepEqual(kenya.recommendedSpeciesIds, [
    'sonneratia_alba',
    'avicennia_marina',
    'rhizophora_mucronata',
  ])
  const usa = verdict(GOOD, sat('in_range', 'high', 0.4, 0.36), 'US')
  assert.deepEqual(usa.recommendedSpeciesIds, ['rhizophora_mangle'])
  const fiji = verdict(GOOD, sat('in_range', 'high', 0.4, 0.36), 'fj')
  assert.deepEqual(fiji.recommendedSpeciesIds, [
    'sonneratia_alba',
    'avicennia_marina',
    'rhizophora_stylosa',
    'rhizophora_samoensis',
  ])
})

test('where mangroves are not native, nothing is planted', () => {
  const v = verdict(GOOD, sat('in_range', 'high', 0.4, 0.36), 'pf')
  assert.equal(v.code, 'not_suitable')
  assert.equal(reason(v, 'not_native')?.severity, 'blocker')
  assert.deepEqual(v.recommendedSpeciesIds, [])
  assert.equal(regionForCountry('PF'), null)
  assert.equal(mangrovesNative(' pf '), false)
  assert.equal(mangrovesNative('KE'), true)
  assert.equal(mangrovesNative(null), true)
  assert.equal(codes(verdict(GOOD)).includes('not_native'), false)
})

test('an unknown country gets every species for the zone', () => {
  const v = verdict(GOOD, sat('in_range', 'high', 0.4, 0.36), null)
  const seaward = MANGROVE_SPECIES.filter(s => s.zones.includes('seaward'))
  assert.deepEqual(
    v.recommendedSpeciesIds,
    seaward.map(s => s.id),
  )
  assert.equal(regionForCountry('XX'), null)
  assert.equal(regionForCountry(' ke '), 'east_africa')
  assert.equal(regionForCountry(undefined), null)
})

test('speciesFor with no zone lists the whole region', () => {
  const ids = speciesFor(null, 'US').map(s => s.id)
  assert.deepEqual(ids, [
    'rhizophora_mangle',
    'avicennia_germinans',
    'laguncularia_racemosa',
  ])
  assert.equal(speciesFor(null, null).length, MANGROVE_SPECIES.length)
})

test('the species catalog is consistent', () => {
  const ids = MANGROVE_SPECIES.map(s => s.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const s of MANGROVE_SPECIES) {
    assert.ok(s.zones.length > 0, s.id)
    assert.ok(s.regions.length > 0, s.id)
    assert.match(s.id, /^[a-z]+_[a-z]+$/)
  }
  assert.equal(findSpecies('avicennia_marina')?.localNames?.sw, 'Mchu')
  assert.equal(findSpecies('oak'), undefined)
})

// --- Required answers ---

test('missingAnswers lists every required answer for an empty form', () => {
  assert.deepEqual(missingAnswers({}), REQUIRED_ANSWERS)
  assert.deepEqual(missingAnswers(GOOD), [])
})

test('missingAnswers asks whether a named cause is still active', () => {
  const rest = { ...GOOD, causeStillActive: undefined }
  assert.deepEqual(missingAnswers(rest), ['causeStillActive'])
  const pond = { ...rest, previousUse: 'pond_or_salt_pan' as const }
  assert.deepEqual(missingAnswers({ ...pond, lossCauses: ['unknown'] }), [])
  assert.deepEqual(missingAnswers({ ...pond, lossCauses: [] }), [])
  assert.deepEqual(missingAnswers({ ...GOOD, tideReach: undefined }), [
    'tideReach',
  ])
})

test('missingAnswers: "Mangroves, now cut" always asks if cutting goes on', () => {
  const rest = { ...GOOD, causeStillActive: undefined }
  for (const lossCauses of [undefined, [], ['unknown' as const]]) {
    assert.deepEqual(missingAnswers({ ...rest, lossCauses }), [
      'causeStillActive',
    ])
  }
})

// --- Mirror into the web app ---

const WEB_COPY_DIR = path.resolve(
  __dirname,
  '../../../treegens-web-main/src/modules/siteCheck',
)

for (const file of ['siteVerdict.ts', 'mangroveSpecies.ts']) {
  test(`${file} is mirrored byte-for-byte in the web app`, t => {
    const webCopy = path.join(WEB_COPY_DIR, file)
    if (!fs.existsSync(webCopy)) {
      t.skip(`no web copy at ${webCopy}`)
      return
    }
    assert.equal(
      fs.readFileSync(webCopy, 'utf8'),
      fs.readFileSync(path.join(__dirname, file), 'utf8'),
      `${file} differs from the web copy; edit both together`,
    )
  })
}
