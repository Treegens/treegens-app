import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accumulateScene,
  analyseWindow,
  classifyHydrology,
  clearShare,
  DEFAULT_REFERENCE,
  dilate,
  emptyCounts,
  fringeWetFractions,
  hydrologyConfidence,
  hydrologyNotes,
  MANGROVE_CLASS,
  nearestDistanceM,
  ObservationCounts,
  openRing,
  percentile,
  pixelCentres,
  pixelIndexAt,
  pointInRing,
  RasterGeometry,
  rasterizeRing,
  ringCentroid,
  sampleNearest,
  sceneMasks,
  SiteStats,
  siteWindow,
  wetFractions,
  windowCovering,
} from './math'

function grid(width: number, height: number): RasterGeometry {
  return { originX: 0, originY: height * 10, res: 10, width, height }
}

function siteStats(overrides: Partial<SiteStats> = {}): SiteStats {
  return {
    pixelCount: 10,
    observedPixelCount: 10,
    medianWetFraction: 0.3,
    p25WetFraction: 0.2,
    p75WetFraction: 0.4,
    permanentWaterShare: 0,
    rarelyWetShare: 0,
    mangroveCoverShare: 0,
    medianObservations: 50,
    ...overrides,
  }
}

/** Counts that give every pixel the wanted wet fraction over 50 images. */
function countsFor(wf: number[], observations = 50): ObservationCounts {
  const counts = emptyCounts(wf.length)
  wf.forEach((f, i) => {
    counts.valid[i] = observations
    counts.wet[i] = Math.round(f * observations)
  })
  return counts
}

test('openRing drops the closing vertex and needs 3 distinct points', () => {
  const ring = openRing([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ])
  assert.equal(ring.length, 3)
  assert.throws(
    () =>
      openRing([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    /at least 3 distinct points/,
  )
  assert.throws(() => openRing([]), /at least 3 distinct points/)
})

test('ringCentroid is area weighted and falls back to the vertex mean', () => {
  const square: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 2],
    [0, 2],
  ]
  assert.deepEqual(ringCentroid(square), [2, 1])
  const line: [number, number][] = [
    [0, 0],
    [1, 1],
    [5, 5],
  ]
  assert.deepEqual(ringCentroid(line), [2, 2])
})

test('pointInRing handles inside and outside points', () => {
  const tri: [number, number][] = [
    [0, 0],
    [10, 0],
    [0, 10],
  ]
  assert.equal(pointInRing(2, 2, tri), true)
  assert.equal(pointInRing(8, 8, tri), false)
})

test('windowCovering snaps outward to the grid and clamps to the raster', () => {
  const raster = { originX: 100, originY: 1000, res: 10, width: 50, height: 50 }
  const win = windowCovering(raster, {
    minX: 125,
    maxX: 151,
    minY: 905,
    maxY: 978,
  })
  assert.deepEqual(win, {
    col0: 2,
    row0: 2,
    width: 4,
    height: 8,
    originX: 120,
    originY: 980,
    res: 10,
  })
  const clamped = windowCovering(raster, {
    minX: 0,
    maxX: 200,
    minY: 400,
    maxY: 2000,
  })
  assert.equal(clamped.col0, 0)
  assert.equal(clamped.row0, 0)
  assert.equal(clamped.width, 10)
  assert.equal(clamped.height, 50)
})

test('siteWindow grows the site, caps around its centre and clamps', () => {
  const raster = {
    originX: 0,
    originY: 10000,
    res: 10,
    width: 1000,
    height: 1000,
  }
  const square: [number, number][] = [
    [4980, 4980],
    [5020, 4980],
    [5020, 5020],
    [4980, 5020],
  ]
  const grown = siteWindow(raster, square, 100, 700)
  assert.equal(grown.width, 24)
  assert.equal(grown.originX, 4880)
  const capped = siteWindow(raster, square, 3000, 100)
  assert.equal(capped.width, 100)
  assert.equal(capped.height, 100)
  assert.equal(capped.col0, 450)
  const nearEdge = siteWindow(
    raster,
    square.map(([x, y]) => [x - 4900, y] as [number, number]),
    500,
    700,
  )
  assert.equal(nearEdge.col0, 0)
  assert.equal(nearEdge.width, 62)
})

test('pixelCentres and pixelIndexAt agree', () => {
  const g = grid(3, 2)
  const { xs, ys } = pixelCentres(g)
  assert.deepEqual([...xs], [5, 15, 25, 5, 15, 25])
  assert.deepEqual([...ys], [15, 15, 15, 5, 5, 5])
  assert.equal(pixelIndexAt(g, 25, 5), 5)
  assert.equal(pixelIndexAt(g, -100, 1000), 0)
})

test('rasterizeRing keeps pixel centres inside the ring', () => {
  const g = grid(10, 10)
  const square: [number, number][] = [
    [20, 80],
    [50, 80],
    [50, 50],
    [20, 50],
  ]
  const pixels = [...rasterizeRing(g, square)].sort((a, b) => a - b)
  assert.deepEqual(pixels, [22, 23, 24, 32, 33, 34, 42, 43, 44])
})

test('rasterizeRing falls back to the pixel under a tiny ring', () => {
  const tiny: [number, number][] = [
    [31, 31],
    [33, 31],
    [33, 33],
  ]
  assert.deepEqual([...rasterizeRing(grid(10, 10), tiny)], [63])
})

test('sampleNearest maps a coarse window onto finer pixel centres', () => {
  const coarse = { originX: 0, originY: 40, res: 20, width: 2, height: 2 }
  const fine = pixelCentres({
    originX: 0,
    originY: 40,
    res: 10,
    width: 5,
    height: 4,
  })
  const out = sampleNearest([1, 2, 3, 4], coarse, fine)
  assert.deepEqual(
    [...out],
    [1, 1, 2, 2, 0, 1, 1, 2, 2, 0, 3, 3, 4, 4, 0, 3, 3, 4, 4, 0],
  )
})

test('sceneMasks applies SCL, nodata and NDWI on reflectance', () => {
  const masks = sceneMasks({
    green: [1500, 1500, 0, 900, 1500],
    nir: [1200, 3000, 1200, 800, 1200],
    scl: [6, 4, 6, 6, 9],
    greenScaling: { scale: 0.0001, offset: -0.1 },
    nirScaling: { scale: 0.0001, offset: -0.1 },
  })
  assert.deepEqual([...masks.valid], [1, 1, 0, 1, 0])
  assert.deepEqual([...masks.wet], [1, 0, 0, 1, 0])
})

test('accumulated counts give wet fractions only with enough images', () => {
  const counts = emptyCounts(2)
  for (let k = 0; k < 15; k++) {
    accumulateScene(counts, {
      valid: Uint8Array.from([1, k < 14 ? 1 : 0]),
      wet: Uint8Array.from([k < 5 ? 1 : 0, k < 14 ? 1 : 0]),
    })
  }
  const wf = wetFractions(counts)
  assert.equal(wf[0], 5 / 15)
  assert.ok(Number.isNaN(wf[1]))
  assert.equal(wetFractions(counts, 10)[1], 14 / 14)
})

test('clearShare counts clear site pixels', () => {
  const valid = Uint8Array.from([1, 0, 1, 1])
  assert.equal(clearShare(valid, Int32Array.from([0, 1])), 0.5)
  assert.equal(clearShare(valid, new Int32Array(0)), 0)
})

test('percentile interpolates like numpy', () => {
  const v = [1, 2, 3, 4]
  assert.equal(percentile(v, 25), 1.75)
  assert.equal(percentile(v, 50), 2.5)
  assert.ok(Math.abs(percentile(v, 90) - 3.7) < 1e-12)
  assert.equal(percentile([], 50), null)
})

test('dilate grows by the cross or the full square', () => {
  const mask = new Uint8Array(49)
  mask[24] = 1
  const size = { width: 7, height: 7 }
  const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0)
  assert.equal(count(dilate(mask, size, 2, 4)), 13)
  assert.equal(count(dilate(mask, size, 2, 8)), 25)
  assert.equal(count(dilate(mask, size, 1, 8)), 9)
})

test('fringeWetFractions keeps wet non-mangrove pixels next to mangrove', () => {
  // One row: mangrove, mangrove, fringe, fringe, too far, too far
  const g = grid(6, 1)
  const landcover = [95, 95, 80, 80, 80, 80]
  const wf = Float64Array.from([0, 0, 0.3, 0.6, 0.9, 0.9])
  const none = new Uint8Array(6)
  assert.deepEqual([...fringeWetFractions(landcover, wf, none, g)], [0.3, 0.6])
  const site = Uint8Array.from([0, 0, 0, 1, 0, 0])
  assert.deepEqual([...fringeWetFractions(landcover, wf, site, g)], [0.3])
  wf[2] = 0.05
  assert.deepEqual([...fringeWetFractions(landcover, wf, none, g)], [0.6])
})

test('nearestDistanceM measures in metres and returns null when none', () => {
  const g = grid(10, 10)
  assert.equal(
    nearestDistanceM(g, 0, i => i === 43),
    50,
  )
  assert.equal(
    nearestDistanceM(g, 0, () => false),
    null,
  )
})

test('classifyHydrology follows the rule order', () => {
  const ref = { p75: 0.48, p90: 0.6 }
  const cls = (o: Partial<SiteStats>) => classifyHydrology(siteStats(o), ref)
  assert.equal(cls({ observedPixelCount: 4 }), 'insufficient_data')
  assert.equal(cls({ observedPixelCount: 0 }), 'insufficient_data')
  assert.equal(
    cls({ mangroveCoverShare: 0.5, medianWetFraction: 0.95 }),
    'existing_mangrove',
  )
  assert.equal(cls({ medianWetFraction: 0.9 }), 'permanently_wet')
  assert.equal(cls({ medianWetFraction: 0.651 }), 'too_low')
  assert.equal(cls({ medianWetFraction: 0.65 }), 'borderline_low')
  assert.equal(cls({ medianWetFraction: 0.48 }), 'in_range')
  assert.equal(cls({ medianWetFraction: 0.02 }), 'in_range')
  assert.equal(cls({ medianWetFraction: 0.01 }), 'rarely_wet')
})

test('hydrologyConfidence needs a strong local reference for high', () => {
  const local = { source: 'local' as const, edgePixelCount: 200 }
  const def = { source: 'default' as const, edgePixelCount: 0 }
  const site = siteStats({ medianObservations: 40, observedPixelCount: 8 })
  assert.equal(hydrologyConfidence('in_range', site, local), 'high')
  assert.equal(hydrologyConfidence('in_range', site, def), 'medium')
  assert.equal(
    hydrologyConfidence('in_range', site, { ...local, edgePixelCount: 199 }),
    'medium',
  )
  assert.equal(
    hydrologyConfidence(
      'in_range',
      siteStats({ medianObservations: 19 }),
      local,
    ),
    'low',
  )
  assert.equal(hydrologyConfidence('insufficient_data', site, local), 'low')
})

/** 30 x 30 grid: mangrove on the left, a wet fringe, open water right. */
function syntheticBay(siteCol: number) {
  const g = grid(30, 30)
  const landcover = new Uint16Array(900)
  const wf: number[] = []
  for (let i = 0; i < 900; i++) {
    const col = i % 30
    landcover[i] = col < 10 ? MANGROVE_CLASS : 80
    wf.push(col < 10 ? 0 : col < 12 ? 0.4 : 0.95)
  }
  const site = Int32Array.from([15 * 30 + siteCol, 16 * 30 + siteCol])
  return { g, landcover, counts: countsFor(wf), site }
}

test('analyseWindow uses the local fringe and classifies the site', () => {
  const bay = syntheticBay(20)
  const result = analyseWindow({
    grid: bay.g,
    site: bay.site,
    centreIdx: bay.site[0],
    counts: bay.counts,
    landcover: bay.landcover,
  })
  assert.equal(result.hydrologyClass, 'permanently_wet')
  assert.equal(result.reference.source, 'local')
  assert.equal(result.reference.edgePixelCount, 60)
  assert.equal(result.reference.p50, 0.4)
  assert.equal(result.reference.nearestMangroveM, 110)
  assert.equal(result.reference.nearestTidalWaterM, 0)
  assert.equal(result.site.permanentWaterShare, 1)
  assert.equal(result.confidence, 'medium')
})

test('analyseWindow falls back to the default reference without mangroves', () => {
  const bay = syntheticBay(11)
  const result = analyseWindow({
    grid: bay.g,
    site: bay.site,
    centreIdx: bay.site[0],
    counts: bay.counts,
    landcover: new Uint16Array(900),
  })
  assert.equal(result.reference.source, 'default')
  assert.equal(result.reference.p50, DEFAULT_REFERENCE.p50)
  assert.equal(result.reference.nearestMangroveM, null)
  assert.equal(result.hydrologyClass, 'in_range')
})

test('hydrologyNotes are plain and explain the reference', () => {
  const bay = syntheticBay(11)
  const analysis = analyseWindow({
    grid: bay.g,
    site: bay.site,
    centreIdx: bay.site[0],
    counts: bay.counts,
    landcover: new Uint16Array(900),
  })
  const notes = hydrologyNotes({
    ...analysis,
    referenceRadiusM: 1500,
    landcoverAvailable: true,
    scenesUsed: 12,
    scenesFailed: 1,
    scenesNotRead: 3,
  })
  assert.deepEqual(notes, [
    'The site is wet in 40% of clear images, a typical mangrove fringe in about 35%.',
    'No mapped mangroves within 1.5 km, so a default Kenyan reference was used.',
    'Only 12 clear images over the site.',
    '1 image could not be read.',
    'Stopped early to stay within the time limit (3 images not read).',
  ])
  const emDash = String.fromCharCode(0x2014)
  assert.ok(notes.every(n => !n.includes(emDash)))
})
