/**
 * Pure maths for the satellite hydrology check: per-pixel wet counts from
 * Sentinel-2 scenes, the site's wet fraction, and the reference fringe where
 * nearby mapped mangroves stop growing. No I/O here, so it is easy to test.
 *
 * Grids are north-up: pixel (col, row) of a raster covers x from
 * originX + col * res and y down from originY - row * res.
 */
import { HydrologyClass } from '../siteCheck/siteVerdict'
import { HydrologyResult } from './types'

/** A pixel needs this many clear images before its wet fraction counts. */
export const MIN_OBSERVATIONS = 15
/** NDWI above this means open water or wet mud at that moment. */
export const NDWI_WET_THRESHOLD = 0
/** ESA WorldCover class for mangroves. */
export const MANGROVE_CLASS = 95
/** SCL classes treated as clear: dark area, vegetation, bare, water, other. */
export const CLEAR_SCL_CLASSES = [2, 4, 5, 6, 7]
/** A scene only counts when at least this share of the site is clear. */
export const MIN_SCENE_CLEAR_SHARE = 0.5
/**
 * Used when a site has no local fringe: the mean of the fringe percentiles
 * this engine measured at three Kenyan sites over 2024-01 to 2025-12, Gazi
 * Bay (0.254 / 0.398 / 0.522 / 0.662), Mida Creek (0.158 / 0.269 / 0.396 /
 * 0.600) and Kipini, Tana delta (0.219 / 0.442 / 0.590 / 0.641).
 */
export const DEFAULT_REFERENCE = { p25: 0.21, p50: 0.37, p75: 0.5, p90: 0.63 }

const MIN_LOCAL_FRINGE_PX = 50
const HIGH_CONFIDENCE_FRINGE_PX = 200
const FRINGE_MIN_WET = 0.05
const FRINGE_DILATION_STEPS = 2
/**
 * The 3x3 cross, as in the Python prototype (scipy's default) that the
 * Kenyan reference values were calibrated with. The full 3x3 square (8)
 * reaches diagonal pixels further out in the water and reads about 0.04
 * wetter at the median (Gazi Bay 0.40 against 0.36).
 */
const FRINGE_CONNECTIVITY = 4
const PERMANENT_WATER_WF = 0.9
const RARELY_WET_WF = 0.02
const TIDAL_WATER_WF = 0.5
const TOO_LOW_MARGIN = 0.05
const MIN_OBSERVED_SHARE = 0.5

const CLEAR_SCL = new Uint8Array(256)
CLEAR_SCL_CLASSES.forEach(c => (CLEAR_SCL[c] = 1))

export type Ring = [number, number][]
export type SiteStats = HydrologyResult['site']
export type ReferenceStats = HydrologyResult['reference']
export type Confidence = HydrologyResult['confidence']

export interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A north-up raster: top-left corner, square pixel size, size in pixels. */
export interface RasterGeometry {
  originX: number
  originY: number
  res: number
  width: number
  height: number
}

/** A window cut from a raster. Its origin is the window's own corner. */
export interface GridWindow extends RasterGeometry {
  col0: number
  row0: number
}

export interface PointSet {
  xs: Float64Array
  ys: Float64Array
}

export interface BandScaling {
  scale: number
  offset: number
}

/** One scene's bands, already resampled onto the analysis grid. */
export interface SceneBands {
  green: ArrayLike<number>
  nir: ArrayLike<number>
  scl: ArrayLike<number>
  greenScaling: BandScaling
  nirScaling: BandScaling
}

export interface SceneMasks {
  valid: Uint8Array
  wet: Uint8Array
}

export interface ObservationCounts {
  valid: Uint16Array
  wet: Uint16Array
}

// Geometry

/** Drops a repeated closing vertex and checks the ring has a shape. */
export function openRing(ring: Ring): Ring {
  const points = (ring || []).map(([x, y]) => [x, y] as [number, number])
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) {
    points.pop()
  }
  const finite = points.every(p => Number.isFinite(p[0] + p[1]))
  const distinct = new Set(points.map(p => `${p[0]},${p[1]}`)).size
  if (!finite || distinct < 3) {
    throw new Error('A site boundary needs at least 3 distinct points')
  }
  return points
}

export function extentOf(points: Ring): Extent {
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

export function growExtent(e: Extent, by: number): Extent {
  return {
    minX: e.minX - by,
    minY: e.minY - by,
    maxX: e.maxX + by,
    maxY: e.maxY + by,
  }
}

/** Area-weighted centroid; the vertex mean when the ring has no area. */
export function ringCentroid(ring: Ring): [number, number] {
  const [ox, oy] = ring[0]
  let area2 = 0
  let cx = 0
  let cy = 0
  ring.forEach(([x1, y1], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length]
    const a = (x1 - ox) * (y2 - oy) - (x2 - ox) * (y1 - oy)
    area2 += a
    cx += (x1 + x2 - 2 * ox) * a
    cy += (y1 + y2 - 2 * oy) * a
  })
  const e = extentOf(ring)
  if (Math.abs(area2) <= 1e-9 * (e.maxX - e.minX) * (e.maxY - e.minY)) {
    const n = ring.length
    return [
      ring.reduce((s, p) => s + p[0], 0) / n,
      ring.reduce((s, p) => s + p[1], 0) / n,
    ]
  }
  return [ox + cx / (3 * area2), oy + cy / (3 * area2)]
}

/** Even-odd ray casting test. */
export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function colSpan(r: RasterGeometry, e: Extent): [number, number] {
  return [
    Math.floor((e.minX - r.originX) / r.res),
    Math.ceil((e.maxX - r.originX) / r.res),
  ]
}

function rowSpan(r: RasterGeometry, e: Extent): [number, number] {
  return [
    Math.floor((r.originY - e.maxY) / r.res),
    Math.ceil((r.originY - e.minY) / r.res),
  ]
}

function clampSpan([a, b]: [number, number], size: number): [number, number] {
  const start = Math.min(Math.max(a, 0), size)
  return [start, Math.min(Math.max(b, start), size)]
}

/** Keeps a span at most maxPx long, centred on the given pixel. */
function capSpan(
  [a, b]: [number, number],
  centre: number,
  maxPx: number,
): [number, number] {
  if (b - a <= maxPx) return [a, b]
  const start = centre - Math.floor(maxPx / 2)
  return [start, start + maxPx]
}

function makeWindow(
  r: RasterGeometry,
  [col0, col1]: [number, number],
  [row0, row1]: [number, number],
): GridWindow {
  return {
    col0,
    row0,
    width: col1 - col0,
    height: row1 - row0,
    originX: r.originX + col0 * r.res,
    originY: r.originY - row0 * r.res,
    res: r.res,
  }
}

/** The raster's pixels covering an extent, snapped outward and clamped. */
export function windowCovering(r: RasterGeometry, e: Extent): GridWindow {
  return makeWindow(
    r,
    clampSpan(colSpan(r, e), r.width),
    clampSpan(rowSpan(r, e), r.height),
  )
}

/** Columns and rows the analysis window wants, before clamping. */
function siteSpans(
  r: RasterGeometry,
  ring: Ring,
  radiusM: number,
  maxPx: number,
): [[number, number], [number, number]] {
  const e = extentOf(ring)
  const grown = growExtent(e, radiusM)
  const [col, row] = pixelOf(r, (e.minX + e.maxX) / 2, (e.minY + e.maxY) / 2)
  return [
    capSpan(colSpan(r, grown), col, maxPx),
    capSpan(rowSpan(r, grown), row, maxPx),
  ]
}

/**
 * The analysis window: the site's bounding box grown by radiusM on every
 * side, snapped outward to the raster grid, capped at maxPx around the
 * site's centre and clamped to the raster.
 */
export function siteWindow(
  r: RasterGeometry,
  ring: Ring,
  radiusM: number,
  maxPx: number,
): GridWindow {
  const [cols, rows] = siteSpans(r, ring, radiusM, maxPx)
  return makeWindow(r, clampSpan(cols, r.width), clampSpan(rows, r.height))
}

/**
 * Share of the wanted analysis window that lies on the raster: 1 when the
 * raster's edges cut nothing off, 0 when the window misses it.
 */
export function windowCoverage(
  r: RasterGeometry,
  ring: Ring,
  radiusM: number,
  maxPx: number,
): number {
  const [[c0, c1], [r0, r1]] = siteSpans(r, ring, radiusM, maxPx)
  const win = siteWindow(r, ring, radiusM, maxPx)
  const wanted = (c1 - c0) * (r1 - r0)
  return wanted > 0 ? (win.width * win.height) / wanted : 0
}

export function gridExtent(g: RasterGeometry): Extent {
  return {
    minX: g.originX,
    minY: g.originY - g.height * g.res,
    maxX: g.originX + g.width * g.res,
    maxY: g.originY,
  }
}

export function extentCorners(e: Extent): Ring {
  return [
    [e.minX, e.minY],
    [e.minX, e.maxY],
    [e.maxX, e.minY],
    [e.maxX, e.maxY],
  ]
}

/** Map coordinates of every pixel centre, row by row. */
export function pixelCentres(g: RasterGeometry): PointSet {
  const xs = new Float64Array(g.width * g.height)
  const ys = new Float64Array(g.width * g.height)
  for (let row = 0, i = 0; row < g.height; row++) {
    const y = g.originY - (row + 0.5) * g.res
    for (let col = 0; col < g.width; col++, i++) {
      xs[i] = g.originX + (col + 0.5) * g.res
      ys[i] = y
    }
  }
  return { xs, ys }
}

/** Column and row of the pixel containing (x, y), possibly outside. */
export function pixelOf(
  g: RasterGeometry,
  x: number,
  y: number,
): [number, number] {
  return [
    Math.floor((x - g.originX) / g.res),
    Math.floor((g.originY - y) / g.res),
  ]
}

/** Index of the pixel containing (x, y), clamped into the grid. */
export function pixelIndexAt(g: RasterGeometry, x: number, y: number): number {
  const [col, row] = pixelOf(g, x, y)
  const c = Math.min(Math.max(col, 0), g.width - 1)
  const r = Math.min(Math.max(row, 0), g.height - 1)
  return r * g.width + c
}

/**
 * Pixels whose centres fall inside the ring. A ring smaller than a pixel
 * gets the single pixel nearest its centroid.
 */
export function rasterizeRing(g: RasterGeometry, ring: Ring): Int32Array {
  const e = extentOf(ring)
  const [c0, c1] = clampSpan(colSpan(g, e), g.width)
  const [r0, r1] = clampSpan(rowSpan(g, e), g.height)
  const inside: number[] = []
  for (let row = r0; row < r1; row++) {
    const y = g.originY - (row + 0.5) * g.res
    for (let col = c0; col < c1; col++) {
      const x = g.originX + (col + 0.5) * g.res
      if (pointInRing(x, y, ring)) inside.push(row * g.width + col)
    }
  }
  if (!inside.length) inside.push(pixelIndexAt(g, ...ringCentroid(ring)))
  return Int32Array.from(inside)
}

/**
 * Nearest-neighbour sample of a window's values at arbitrary points given
 * in the window's own coordinates. Points outside the window read 0.
 */
export function sampleNearest(
  src: ArrayLike<number>,
  win: RasterGeometry,
  points: PointSet,
): Uint16Array {
  const out = new Uint16Array(points.xs.length)
  for (let i = 0; i < out.length; i++) {
    const col = Math.floor((points.xs[i] - win.originX) / win.res)
    const row = Math.floor((win.originY - points.ys[i]) / win.res)
    if (col >= 0 && col < win.width && row >= 0 && row < win.height) {
      out[i] = src[row * win.width + col]
    }
  }
  return out
}

// Scenes

/**
 * Clear and wet pixels of one scene. Clear: SCL says so and both bands have
 * data. Wet: NDWI = (green - nir) / (green + nir) on reflectance is above
 * the threshold.
 */
export function sceneMasks(b: SceneBands): SceneMasks {
  const n = b.green.length
  const valid = new Uint8Array(n)
  const wet = new Uint8Array(n)
  const { greenScaling: gs, nirScaling: ns } = b
  for (let i = 0; i < n; i++) {
    if (!b.green[i] || !b.nir[i] || !CLEAR_SCL[b.scl[i]]) continue
    const g = b.green[i] * gs.scale + gs.offset
    const r = b.nir[i] * ns.scale + ns.offset
    valid[i] = 1
    wet[i] = (g - r) / Math.max(g + r, 1e-6) > NDWI_WET_THRESHOLD ? 1 : 0
  }
  return { valid, wet }
}

/** Share of the given pixels that are clear. */
export function clearShare(valid: Uint8Array, pixels: Int32Array): number {
  let clear = 0
  pixels.forEach(i => (clear += valid[i]))
  return pixels.length ? clear / pixels.length : 0
}

export function emptyCounts(n: number): ObservationCounts {
  return { valid: new Uint16Array(n), wet: new Uint16Array(n) }
}

export function accumulateScene(
  counts: ObservationCounts,
  masks: SceneMasks,
): void {
  for (let i = 0; i < counts.valid.length; i++) {
    counts.valid[i] += masks.valid[i]
    counts.wet[i] += masks.wet[i]
  }
}

/** wet / clear per pixel, NaN where there are too few clear images. */
export function wetFractions(
  counts: ObservationCounts,
  minObservations = MIN_OBSERVATIONS,
): Float64Array {
  const wf = new Float64Array(counts.valid.length)
  for (let i = 0; i < wf.length; i++) {
    const v = counts.valid[i]
    wf[i] = v >= minObservations ? counts.wet[i] / v : NaN
  }
  return wf
}

// Statistics

/** Percentile (0..100) of sorted values, interpolated like numpy. */
export function percentile(
  sorted: ArrayLike<number>,
  q: number,
): number | null {
  if (!sorted.length) return null
  const pos = ((sorted.length - 1) * q) / 100
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Sorted finite values of pick(i) over the given indices. */
function sortedValues(
  indices: ArrayLike<number>,
  pick: (i: number) => number,
): Float64Array {
  const out: number[] = []
  for (let k = 0; k < indices.length; k++) {
    const v = pick(indices[k])
    if (Number.isFinite(v)) out.push(v)
  }
  return Float64Array.from(out).sort()
}

function countWhere(
  indices: ArrayLike<number>,
  test: (i: number) => boolean,
): number {
  let n = 0
  for (let k = 0; k < indices.length; k++) n += +test(indices[k])
  return n
}

function shareOf(values: Float64Array, test: (v: number) => boolean) {
  return values.length ? countWhere(values, test) / values.length : 0
}

function round3(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1000) / 1000
}

// Morphology and distances

export type Connectivity = 4 | 8

function stampNeighbours(
  out: Uint8Array,
  g: Pick<RasterGeometry, 'width' | 'height'>,
  i: number,
  connectivity: Connectivity,
) {
  const row = Math.floor(i / g.width)
  const col = i % g.width
  const [r0, r1] = [Math.max(row - 1, 0), Math.min(row + 1, g.height - 1)]
  const [c0, c1] = [Math.max(col - 1, 0), Math.min(col + 1, g.width - 1)]
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (connectivity === 8 || r === row || c === col) out[r * g.width + c] = 1
    }
  }
}

/** Binary dilation: 4 grows by the 3x3 cross, 8 by the full 3x3 square. */
export function dilate(
  mask: Uint8Array,
  g: Pick<RasterGeometry, 'width' | 'height'>,
  steps: number,
  connectivity: Connectivity,
): Uint8Array {
  let current = mask
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(current.length)
    current.forEach((v, i) => v && stampNeighbours(next, g, i, connectivity))
    current = next
  }
  return current
}

/**
 * Wet fractions (sorted) of the fringe: pixels outside the site that are
 * not mangrove but lie within 2 px of mapped mangrove, and are wet in more
 * than 5% of clear images (dry land behind the forest is left out).
 */
export function fringeWetFractions(
  landcover: ArrayLike<number>,
  wf: Float64Array,
  siteMask: Uint8Array,
  g: RasterGeometry,
): Float64Array {
  const mangrove = Uint8Array.from(landcover, c => +(c === MANGROVE_CLASS))
  const near = dilate(mangrove, g, FRINGE_DILATION_STEPS, FRINGE_CONNECTIVITY)
  const out: number[] = []
  for (let i = 0; i < near.length; i++) {
    if (near[i] && !mangrove[i] && !siteMask[i] && wf[i] > FRINGE_MIN_WET) {
      out.push(wf[i])
    }
  }
  return Float64Array.from(out).sort()
}

/** Metres from one pixel to the nearest pixel passing the test. */
export function nearestDistanceM(
  g: RasterGeometry,
  from: number,
  test: (i: number) => boolean,
): number | null {
  const fromRow = Math.floor(from / g.width)
  const fromCol = from % g.width
  let best = Infinity
  for (let i = 0; i < g.width * g.height; i++) {
    if (!test(i)) continue
    const dr = Math.floor(i / g.width) - fromRow
    const dc = (i % g.width) - fromCol
    best = Math.min(best, dr * dr + dc * dc)
  }
  return best === Infinity ? null : Math.round(Math.sqrt(best) * g.res)
}

// Classification

export function summarizeSite(
  site: Int32Array,
  counts: ObservationCounts,
  wf: Float64Array,
  landcover: ArrayLike<number>,
): SiteStats {
  const observed = sortedValues(site, i => wf[i])
  const observations = sortedValues(site, i => counts.valid[i])
  const mangrove = countWhere(site, i => landcover[i] === MANGROVE_CLASS)
  return {
    pixelCount: site.length,
    observedPixelCount: observed.length,
    medianWetFraction: round3(percentile(observed, 50)),
    p25WetFraction: round3(percentile(observed, 25)),
    p75WetFraction: round3(percentile(observed, 75)),
    permanentWaterShare: round3(
      shareOf(observed, v => v >= PERMANENT_WATER_WF),
    ),
    rarelyWetShare: round3(shareOf(observed, v => v < RARELY_WET_WF)),
    mangroveCoverShare: round3(site.length ? mangrove / site.length : 0),
    medianObservations: percentile(observations, 50) ?? 0,
  }
}

/** Local fringe percentiles, or the default when the fringe is too small. */
export function fringeReference(
  fringe: Float64Array,
): Omit<ReferenceStats, 'nearestMangroveM' | 'nearestTidalWaterM'> {
  if (fringe.length < MIN_LOCAL_FRINGE_PX) {
    return {
      source: 'default',
      edgePixelCount: fringe.length,
      ...DEFAULT_REFERENCE,
    }
  }
  return {
    source: 'local',
    edgePixelCount: fringe.length,
    p25: round3(percentile(fringe, 25)),
    p50: round3(percentile(fringe, 50)),
    p75: round3(percentile(fringe, 75)),
    p90: round3(percentile(fringe, 90)),
  }
}

function observedShare(site: SiteStats): number {
  return site.pixelCount ? site.observedPixelCount / site.pixelCount : 0
}

export function classifyHydrology(
  site: SiteStats,
  ref: Pick<ReferenceStats, 'p75' | 'p90'>,
): HydrologyClass {
  if (!site.observedPixelCount || observedShare(site) < MIN_OBSERVED_SHARE) {
    return 'insufficient_data'
  }
  if (site.mangroveCoverShare >= 0.5) return 'existing_mangrove'
  const m = site.medianWetFraction
  if (m >= PERMANENT_WATER_WF) return 'permanently_wet'
  if (m > round3(ref.p90 + TOO_LOW_MARGIN)) return 'too_low'
  if (m > ref.p75) return 'borderline_low'
  if (m >= RARELY_WET_WF) return 'in_range'
  return 'rarely_wet'
}

/** Default-reference results can reach 'medium' at most. */
export function hydrologyConfidence(
  hydrologyClass: HydrologyClass,
  site: SiteStats,
  ref: Pick<ReferenceStats, 'source' | 'edgePixelCount'>,
): Confidence {
  if (hydrologyClass === 'insufficient_data') return 'low'
  if (
    ref.source === 'local' &&
    ref.edgePixelCount >= HIGH_CONFIDENCE_FRINGE_PX &&
    site.medianObservations >= 40 &&
    observedShare(site) >= 0.8
  ) {
    return 'high'
  }
  return site.medianObservations >= 20 ? 'medium' : 'low'
}

export interface WindowData {
  grid: RasterGeometry
  /** Site pixel indices into the grid. */
  site: Int32Array
  /** Pixel holding the site's centroid. */
  centreIdx: number
  counts: ObservationCounts
  /** WorldCover class per grid pixel (all 0 when unavailable). */
  landcover: ArrayLike<number>
}

export interface WindowAnalysis {
  hydrologyClass: HydrologyClass
  confidence: Confidence
  site: SiteStats
  reference: ReferenceStats
}

export function analyseWindow(d: WindowData): WindowAnalysis {
  const wf = wetFractions(d.counts)
  const siteMask = new Uint8Array(wf.length)
  d.site.forEach(i => (siteMask[i] = 1))
  const site = summarizeSite(d.site, d.counts, wf, d.landcover)
  const fringe = fringeWetFractions(d.landcover, wf, siteMask, d.grid)
  const reference: ReferenceStats = {
    ...fringeReference(fringe),
    nearestMangroveM: nearestDistanceM(
      d.grid,
      d.centreIdx,
      i => d.landcover[i] === MANGROVE_CLASS,
    ),
    nearestTidalWaterM: nearestDistanceM(
      d.grid,
      d.centreIdx,
      i => wf[i] >= TIDAL_WATER_WF,
    ),
  }
  const hydrologyClass = classifyHydrology(site, reference)
  const confidence = hydrologyConfidence(hydrologyClass, site, reference)
  return { hydrologyClass, confidence, site, reference }
}

// Notes

export interface NoteFacts extends WindowAnalysis {
  referenceRadiusM: number
  landcoverAvailable: boolean
  scenesUsed: number
  scenesFailed: number
  /** Scenes left unread because the time budget ran out. */
  scenesNotRead: number
  /** Share of the search area on the satellite tile (see windowCoverage). */
  windowCoverage?: number
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function percent(v: number): string {
  return `${Math.round(v * 100)}%`
}

function classNote(f: NoteFacts): string {
  if (f.hydrologyClass === 'insufficient_data') {
    return `Fewer than half of the site had ${MIN_OBSERVATIONS} clear images, so how often it is wet could not be measured.`
  }
  if (f.hydrologyClass === 'existing_mangrove') {
    return `${percent(f.site.mangroveCoverShare)} of the site is mapped as mangrove forest.`
  }
  // p75 is where mangroves stop (the in_range limit), as on the web card;
  // p50 is a typical fringe spot, which picks the planting zone.
  const ref = f.reference
  const stop = `stop at about ${percent(ref.p75)}`
  const typical = `is wet in about ${percent(ref.p50)}`
  const reference =
    ref.source === 'local'
      ? `Nearby mangroves ${stop}, and a typical spot on their fringe ${typical}.`
      : `Mangroves usually ${stop}, and a typical spot on a mangrove fringe ${typical}.`
  return `The site is wet in ${percent(f.site.medianWetFraction)} of clear images. ${reference}`
}

function radiusLabel(f: NoteFacts): string {
  return `${Number((f.referenceRadiusM / 1000).toFixed(1))} km`
}

function referenceNote(f: NoteFacts): string {
  const km = radiusLabel(f)
  const n = f.reference.edgePixelCount
  if (f.reference.source === 'local') {
    return `Compared with ${plural(n, 'fringe pixel')} next to mapped mangroves within ${km}.`
  }
  const fallback = 'so a default Kenyan reference was used.'
  if (!f.landcoverAvailable) {
    return `No land cover map covers this area, ${fallback}`
  }
  if (f.reference.nearestMangroveM === null) {
    return `No mapped mangroves within ${km}, ${fallback}`
  }
  if (!n) {
    return `The mapped mangroves within ${km} have no wet fringe, ${fallback}`
  }
  return `Only ${plural(n, 'fringe pixel')} next to mapped mangroves within ${km}, ${fallback}`
}

/** Short plain-English notes on how the result was reached. */
export function hydrologyNotes(f: NoteFacts): string[] {
  const notes = [classNote(f), referenceNote(f)]
  if (f.windowCoverage < 1) {
    const share = `${Math.floor(f.windowCoverage * 100)}%`
    notes.push(
      `The satellite tile ends near this site, so only ${share} of the area within ${radiusLabel(f)} was searched.`,
    )
  }
  if (f.scenesUsed < 20) {
    notes.push(`Only ${plural(f.scenesUsed, 'clear image')} over the site.`)
  }
  if (f.scenesFailed) {
    notes.push(`${plural(f.scenesFailed, 'image')} could not be read.`)
  }
  if (f.scenesNotRead) {
    notes.push(
      `Stopped early to stay within the time limit (${plural(f.scenesNotRead, 'image')} not read).`,
    )
  }
  return notes
}
