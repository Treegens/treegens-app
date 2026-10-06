/**
 * Satellite hydrology check for a planting site. Reads about two years of
 * Sentinel-2 images around the site, counts how often each 10 m pixel is
 * wet, and compares the site with the fringe where nearby mapped mangroves
 * stop growing. math.ts holds the rules, imagery.ts the data access.
 */
import { HydrologySummary } from '../siteCheck/siteVerdict'
import {
  fetchSceneItems,
  forEachLimit,
  listScenePrefixes,
  MgrsTile,
  mgrsTileFor,
  monthPrefixes,
  readBandAt,
  readRasterGeometry,
  readWorldCover,
  SceneItem,
  selectScenes,
  tileEpsg,
  UtmProjection,
  utmProjection,
} from './imagery'
import {
  accumulateScene,
  analyseWindow,
  clearShare,
  emptyCounts,
  gridExtent,
  GridWindow,
  hydrologyNotes,
  MIN_OBSERVATIONS,
  MIN_SCENE_CLEAR_SHARE,
  NDWI_WET_THRESHOLD,
  ObservationCounts,
  openRing,
  pixelCentres,
  pixelIndexAt,
  PointSet,
  rasterizeRing,
  Ring,
  ringCentroid,
  SceneMasks,
  sceneMasks,
  siteWindow,
  WindowAnalysis,
} from './math'
import { HYDROLOGY_VERSION, HydrologyInput, HydrologyResult } from './types'

export * from './types'

const PROVIDER = 'Sentinel-2 L2A COGs (AWS open data)'
const LANDCOVER = 'ESA WorldCover 2021 v200'
const MAX_WINDOW_PX = 700
const PROGRESS_EVERY = 20

export const HYDROLOGY_DEFAULTS = {
  years: 2,
  referenceRadiusM: 1500,
  maxCloudPct: 80,
  concurrency: 8,
  timeoutMs: 300_000,
  s2BucketUrl: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com',
  worldCoverUrl: 'https://esa-worldcover.s3.eu-central-1.amazonaws.com',
}

type Options = Required<HydrologyInput>

/** Where the scenes are and which ones are worth reading. */
interface SceneSearch {
  tile: MgrsTile
  listed: number
  itemsFailed: number
  scenes: SceneItem[]
}

/** The analysis grid around the site, in the tile's UTM zone. */
interface SiteFrame {
  projection: UtmProjection
  grid: GridWindow
  centres: PointSet
  site: Int32Array
  centreIdx: number
}

interface SceneTally {
  counts: ObservationCounts
  dates: string[]
  started: number
  failed: number
  lastError: string | null
}

function pick(value: number, fallback: number, min: number, max: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

function withDefaults(input: HydrologyInput): Options {
  const d = HYDROLOGY_DEFAULTS
  const trim = (url: string, fallback: string) =>
    (url || fallback).replace(/\/+$/, '')
  return {
    ring: input.ring,
    asOf: input.asOf ?? new Date(),
    years: Math.round(pick(input.years, d.years, 1, 5)),
    referenceRadiusM: pick(input.referenceRadiusM, d.referenceRadiusM, 0, 5000),
    maxCloudPct: pick(input.maxCloudPct, d.maxCloudPct, 0, 100),
    concurrency: Math.round(pick(input.concurrency, d.concurrency, 1, 16)),
    timeoutMs: pick(input.timeoutMs, d.timeoutMs, 1000, 3_600_000),
    s2BucketUrl: trim(input.s2BucketUrl, d.s2BucketUrl),
    worldCoverUrl: trim(input.worldCoverUrl, d.worldCoverUrl),
    log: input.log ?? (() => {}),
  }
}

async function findScenes(opts: Options, tile: MgrsTile): Promise<SceneSearch> {
  const months = monthPrefixes(tile, opts.asOf, opts.years)
  const bucket = opts.s2BucketUrl
  const prefixes = await listScenePrefixes(bucket, months, opts.concurrency)
  const fetched = await fetchSceneItems(bucket, prefixes, opts.concurrency * 2)
  const selected = selectScenes(fetched.items, opts.maxCloudPct)
  const scenes = selected.filter(s => s.epsg === selected[0].epsg)
  opts.log(
    `${tile.id}: ${prefixes.length} scenes listed, ${scenes.length} at or under ${opts.maxCloudPct}% cloud`,
  )
  return {
    tile,
    listed: prefixes.length,
    itemsFailed: fetched.failed,
    scenes,
  }
}

async function buildFrame(
  opts: Options,
  ringLonLat: Ring,
  first: SceneItem,
): Promise<SiteFrame> {
  const projection = utmProjection(first.epsg)
  const ring = ringLonLat.map(p => projection.toUtm(p))
  const raster = await readRasterGeometry(first.green.href)
  const grid = siteWindow(raster, ring, opts.referenceRadiusM, MAX_WINDOW_PX)
  if (!grid.width || !grid.height) {
    throw new Error('The site is outside its Sentinel-2 tile')
  }
  const [cx, cy] = ringCentroid(ring)
  opts.log(`Window ${grid.width} x ${grid.height} px in EPSG:${first.epsg}`)
  return {
    projection,
    grid,
    centres: pixelCentres(grid),
    site: rasterizeRing(grid, ring),
    centreIdx: pixelIndexAt(grid, cx, cy),
  }
}

async function readLandcover(
  opts: Options,
  siteLonLat: [number, number],
  frame: SiteFrame,
): Promise<Uint16Array | null> {
  const landcover = await readWorldCover(
    opts.worldCoverUrl,
    siteLonLat,
    gridExtent(frame.grid),
    frame.centres,
    frame.projection,
  )
  const centre = landcover ? `class ${landcover[frame.centreIdx]}` : 'no map'
  opts.log(`WorldCover at the site centre: ${centre}`)
  return landcover
}

async function readSceneMasks(
  scene: SceneItem,
  frame: SiteFrame,
): Promise<SceneMasks> {
  const extent = gridExtent(frame.grid)
  const [green, nir, scl] = await Promise.all(
    [scene.green, scene.nir, scene.scl].map(band =>
      readBandAt(band.href, extent, frame.centres),
    ),
  )
  return sceneMasks({
    green,
    nir,
    scl,
    greenScaling: scene.green,
    nirScaling: scene.nir,
  })
}

/** Reads scenes in parallel until done or out of time, adding up counts. */
async function readScenes(
  opts: Options,
  frame: SiteFrame,
  scenes: SceneItem[],
  deadline: number,
): Promise<SceneTally> {
  const tally: SceneTally = {
    counts: emptyCounts(frame.centres.xs.length),
    dates: [],
    started: 0,
    failed: 0,
    lastError: null,
  }
  const readOne = async (scene: SceneItem) => {
    tally.started++
    try {
      const masks = await readSceneMasks(scene, frame)
      if (clearShare(masks.valid, frame.site) >= MIN_SCENE_CLEAR_SHARE) {
        accumulateScene(tally.counts, masks)
        tally.dates.push(scene.date)
      }
    } catch (err) {
      tally.failed++
      tally.lastError = err instanceof Error ? err.message : String(err)
    }
    if (tally.started % PROGRESS_EVERY === 0) {
      opts.log(`Read ${tally.started} of ${scenes.length} scenes`)
    }
  }
  await forEachLimit(scenes, opts.concurrency, readOne, () => {
    return Date.now() >= deadline
  })
  if (tally.started && tally.failed === tally.started) {
    throw new Error(`No Sentinel-2 scene could be read: ${tally.lastError}`)
  }
  return tally
}

/** What one run measured, before it is packed into a result. */
interface Outcome {
  analysis: WindowAnalysis
  notes: string[]
  epsg: number
  windowPx: [number, number]
  dates: string[]
  failed: number
}

async function measureSite(
  opts: Options,
  ring: Ring,
  search: SceneSearch,
  deadline: number,
): Promise<Outcome> {
  const frame = await buildFrame(opts, ring, search.scenes[0])
  const landcover = await readLandcover(opts, ringCentroid(ring), frame)
  const tally = await readScenes(opts, frame, search.scenes, deadline)
  const analysis = analyseWindow({
    grid: frame.grid,
    site: frame.site,
    centreIdx: frame.centreIdx,
    counts: tally.counts,
    landcover: landcover ?? new Uint16Array(frame.centres.xs.length),
  })
  const notes = hydrologyNotes({
    ...analysis,
    referenceRadiusM: opts.referenceRadiusM,
    landcoverAvailable: !!landcover,
    scenesUsed: tally.dates.length,
    scenesFailed: search.itemsFailed + tally.failed,
    scenesNotRead: search.scenes.length - tally.started,
  })
  const { grid, projection } = frame
  return {
    analysis,
    notes,
    epsg: projection.epsg,
    windowPx: [grid.width, grid.height],
    dates: tally.dates,
    failed: tally.failed,
  }
}

/** No usable scenes in the period: an empty window reads as no data. */
function noScenes(opts: Options, search: SceneSearch): Outcome {
  const grid = { originX: 0, originY: 0, res: 10, width: 0, height: 0 }
  const analysis = analyseWindow({
    grid,
    site: new Int32Array(0),
    centreIdx: 0,
    counts: emptyCounts(0),
    landcover: [],
  })
  const notes = [
    `No Sentinel-2 images with at most ${opts.maxCloudPct}% cloud were found for this site.`,
  ]
  const epsg = tileEpsg(search.tile)
  return { analysis, notes, epsg, windowPx: [0, 0], dates: [], failed: 0 }
}

function assemble(
  opts: Options,
  search: SceneSearch,
  o: Outcome,
  startedAt: number,
): HydrologyResult {
  const dates = [...o.dates].sort()
  return {
    version: HYDROLOGY_VERSION,
    hydrologyClass: o.analysis.hydrologyClass,
    confidence: o.analysis.confidence,
    notes: o.notes,
    site: o.analysis.site,
    reference: o.analysis.reference,
    imagery: {
      provider: PROVIDER,
      landcover: LANDCOVER,
      mgrsTile: search.tile.id,
      epsg: o.epsg,
      scenesListed: search.listed,
      scenesAfterCloudFilter: search.scenes.length,
      scenesUsed: dates.length,
      scenesFailed: search.itemsFailed + o.failed,
      firstSceneDate: dates[0] ?? null,
      lastSceneDate: dates[dates.length - 1] ?? null,
      windowPx: o.windowPx,
    },
    params: {
      years: opts.years,
      referenceRadiusM: opts.referenceRadiusM,
      ndwiWetThreshold: NDWI_WET_THRESHOLD,
      maxCloudPct: opts.maxCloudPct,
      minObservations: MIN_OBSERVATIONS,
    },
    computedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * Runs the check for one site. Throws when the imagery cannot be reached
 * at all (listing, the first COG header or every scene failing), so the
 * caller can retry later. Partial failures and the time budget only
 * lower the confidence and show up in the notes.
 */
export async function runSiteHydrology(
  input: HydrologyInput,
): Promise<HydrologyResult> {
  const startedAt = Date.now()
  const opts = withDefaults(input)
  const ring = openRing(opts.ring)
  const search = await findScenes(opts, mgrsTileFor(...ringCentroid(ring)))
  const outcome = search.scenes.length
    ? await measureSite(opts, ring, search, startedAt + opts.timeoutMs)
    : noScenes(opts, search)
  opts.log(`Done: ${outcome.analysis.hydrologyClass}`)
  return assemble(opts, search, outcome, startedAt)
}

/** The parts of a hydrology result the verdict rules use. */
export function toHydrologySummary(r: HydrologyResult): HydrologySummary {
  return {
    hydrologyClass: r.hydrologyClass,
    confidence: r.confidence,
    medianWetFraction: r.site.medianWetFraction,
    referenceP50: r.reference.p50,
  }
}
