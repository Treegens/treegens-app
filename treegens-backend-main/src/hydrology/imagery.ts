/**
 * Data access for the satellite hydrology check: Sentinel-2 L2A scenes from
 * the public sentinel-cogs bucket (AWS open data) and the ESA WorldCover
 * 2021 land cover map. Both are read with plain HTTP range requests through
 * global fetch (geotiff.js uses it too), so no keys are needed. Network
 * blips happen, so every request is retried with a short backoff.
 */
import { fromUrl, GeoTIFFImage, Pool } from 'geotiff'
import * as mgrs from 'mgrs'
import proj4 from 'proj4'
import {
  BandScaling,
  Extent,
  extentCorners,
  extentOf,
  growExtent,
  pixelOf,
  pointInRing,
  PointSet,
  RasterGeometry,
  Ring,
  ringCentroid,
  sampleNearest,
  siteWindow,
  windowCovering,
  windowCoverage,
} from './math'

const SCENE_ROOT = 'sentinel-s2-l2a-cogs'
const REQUEST_TIMEOUT_MS = 60_000
const RETRY_DELAYS_MS = [1000, 2000]
/** Extra WorldCover pixels read around the window. */
const WORLDCOVER_MARGIN_PX = 2
const S2_PIXEL_M = 10
/** Extra reach for tile candidates: the site centroid is not its box centre. */
const REACH_MARGIN_M = 500
const MGRS_BANDS = 'CDEFGHJKLMNPQRSTUVWX'
const MGRS_COLUMNS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV'
/** The neighbouring latitude band is tried when the site is this close. */
const BAND_EDGE_DEG = 1
/** Eastings below this are a zone's first 100 km column, often a sliver. */
const FIRST_COLUMN_END_M = 200_000
const METRES_PER_DEGREE = 111_320

export interface MgrsTile {
  id: string
  zone: number
  band: string
  square: string
}

export interface BandAsset extends BandScaling {
  href: string
}

/** Polygons of [lon, lat] rings: outer ring first, then any holes. */
export type Footprint = Ring[][]

export interface SceneItem {
  id: string
  /** Acquisition date, YYYY-MM-DD. */
  date: string
  cloudPct: number
  epsg: number
  green: BandAsset
  nir: BandAsset
  scl: BandAsset
  /** Where the scene has data; null when the item does not say. */
  footprint: Footprint | null
}

/** A tile's projection and pixel grid, from one scene's green band. */
export interface TileRaster {
  tile: MgrsTile
  epsg: number
  geometry: RasterGeometry
}

export interface Listing {
  prefixes: string[]
  nextToken: string | null
}

export interface UtmProjection {
  epsg: number
  toUtm(lonLat: [number, number]): [number, number]
  toLonLat(xy: [number, number]): [number, number]
}

// Pure helpers

/** Splits an MGRS 100 km tile id such as '37MER' or '7VUM'. */
export function parseMgrsTile(id: string): MgrsTile {
  const m = /^(\d{1,2})([C-X])([A-Z]{2})$/.exec(id)
  if (!m) throw new Error(`Unexpected MGRS tile id: ${id}`)
  return { id, zone: Number(m[1]), band: m[2], square: m[3] }
}

export function mgrsTileFor(lon: number, lat: number): MgrsTile {
  return parseMgrsTile(mgrs.forward([lon, lat], 0))
}

/** The MGRS 100 km square letters of a UTM position, e.g. 'ER'. */
export function squareId(
  zone: number,
  easting: number,
  northing: number,
): string | null {
  const columns = MGRS_COLUMNS[(zone - 1) % 3]
  const column = columns[Math.floor(easting / 100_000) - 1]
  const row = Math.floor(northing / 100_000) + (zone % 2 ? 0 : 5)
  return column ? column + MGRS_ROWS[((row % 20) + 20) % 20] : null
}

/** The latitude band letter, plus a neighbour within BAND_EDGE_DEG. */
function nearbyBands(lat: number): string[] {
  const i = Math.min(Math.max(Math.floor((lat + 80) / 8), 0), 19)
  const south = -80 + i * 8
  const bands = [MGRS_BANDS[i]]
  if (i > 0 && lat - south < BAND_EDGE_DEG) bands.push(MGRS_BANDS[i - 1])
  if (i < 19 && south + 8 - lat < BAND_EDGE_DEG) bands.push(MGRS_BANDS[i + 1])
  return bands
}

function utmPosition(zone: number, lon: number, lat: number) {
  return utmProjection(32600 + zone).toUtm([lon, lat])
}

/**
 * Sentinel-2 tiles that may hold a site, the site's own MGRS square first.
 * That square's tile does not always exist: a square across a latitude band
 * edge is filed under one band only, and the narrow first column of a UTM
 * zone is covered by the previous zone's tiles. A tile reaches 9.8 km past
 * its square to the east and south only, so the squares reachM north and
 * west of the site are tried too (for windows crossing those edges).
 */
export function candidateTiles(
  lon: number,
  lat: number,
  reachM: number,
): MgrsTile[] {
  const own = mgrsTileFor(lon, lat)
  const dLat = reachM / METRES_PER_DEGREE
  const dLon = dLat / Math.cos((lat * Math.PI) / 180)
  const points: [number, number][] = [
    [lon, lat],
    [lon, lat + dLat],
    [lon - dLon, lat],
    [lon - dLon, lat + dLat],
  ]
  const zones = [own.zone]
  if (utmPosition(own.zone, lon, lat)[0] - reachM < FIRST_COLUMN_END_M) {
    zones.push(((own.zone + 58) % 60) + 1)
  }
  const ids = new Set([own.id])
  for (const zone of zones) {
    for (const [x, y] of points) {
      const square = squareId(zone, ...utmPosition(zone, x, y))
      if (square) nearbyBands(y).forEach(b => ids.add(`${zone}${b}${square}`))
    }
  }
  return [...ids].map(parseMgrsTile)
}

/** How well a tile's raster holds the site's analysis window. */
function tileFit(
  r: TileRaster,
  ringLonLat: Ring,
  radiusM: number,
  maxPx: number,
) {
  const projection = utmProjection(r.epsg)
  const ring = ringLonLat.map(p => projection.toUtm(p))
  const g = r.geometry
  const [col, row] = pixelOf(g, ...ringCentroid(ring))
  const win = siteWindow(g, ring, radiusM, maxPx)
  return {
    whole: windowCoverage(g, ring, radiusM, maxPx) === 1,
    holdsSite: col >= 0 && col < g.width && row >= 0 && row < g.height,
    pixels: win.width * win.height,
  }
}

/**
 * The first tile holding the whole analysis window, else the one holding
 * the site centroid with the largest window, else null.
 */
export function pickTile(
  rasters: TileRaster[],
  ringLonLat: Ring,
  radiusM: number,
  maxPx: number,
): MgrsTile | null {
  const fits = rasters.map(r => tileFit(r, ringLonLat, radiusM, maxPx))
  const whole = fits.findIndex(f => f.whole)
  if (whole >= 0) return rasters[whole].tile
  let best = -1
  fits.forEach((f, i) => {
    if (f.holdsSite && (best < 0 || f.pixels > fits[best].pixels)) best = i
  })
  return best < 0 ? null : rasters[best].tile
}

/** UTM EPSG code for a tile: 326xx north of the equator, 327xx south. */
export function tileEpsg(tile: MgrsTile): number {
  return (tile.band >= 'N' ? 32600 : 32700) + tile.zone
}

function tilePrefix(tile: MgrsTile): string {
  return `${SCENE_ROOT}/${tile.zone}/${tile.band}/${tile.square}/`
}

/** Bucket prefixes for each month, oldest first, ending with asOf's month. */
export function monthPrefixes(
  tile: MgrsTile,
  asOf: Date,
  years: number,
): string[] {
  const end = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth()
  const prefixes: string[] = []
  for (let k = end - years * 12 + 1; k <= end; k++) {
    const month = `${Math.floor(k / 12)}/${(k % 12) + 1}`
    prefixes.push(`${tilePrefix(tile)}${month}/`)
  }
  return prefixes
}

/** S3 ListObjectsV2 URL listing the folders under a prefix. */
export function listUrl(
  bucket: string,
  prefix: string,
  token?: string | null,
): string {
  const query = `list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F`
  const next = token ? `&continuation-token=${encodeURIComponent(token)}` : ''
  return `${bucket}/?${query}${next}`
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Folder prefixes and the continuation token of a ListObjectsV2 reply. */
export function parseListing(xml: string): Listing {
  const prefixes = [
    ...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g),
  ].map(m => decodeXml(m[1]))
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml)
  const token = /<NextContinuationToken>([^<]*)</.exec(xml)
  return {
    prefixes,
    nextToken: truncated && token ? decodeXml(token[1]) : null,
  }
}

/** STAC item JSON of a scene folder: {prefix}{name}.json. */
export function sceneItemUrl(bucket: string, scenePrefix: string): string {
  const name = scenePrefix.replace(/\/+$/, '').split('/').pop()
  return `${bucket}/${scenePrefix}${name}.json`
}

/** Reflectance = dn * scale + offset; 1 and 0 when the item has none. */
export function bandAsset(asset: any): BandAsset | null {
  if (typeof asset?.href !== 'string') return null
  const band = asset['raster:bands']?.[0] ?? {}
  return {
    href: asset.href,
    scale: Number.isFinite(band.scale) ? band.scale : 1,
    offset: Number.isFinite(band.offset) ? band.offset : 0,
  }
}

function itemEpsg(properties: any): number {
  const code = /^EPSG:(\d+)$/.exec(properties['proj:code'] ?? '')
  return Number(properties['proj:epsg'] ?? code?.[1])
}

/** A GeoJSON Polygon or MultiPolygon as a footprint, else null. */
export function parseFootprint(geometry: any): Footprint | null {
  const coords = geometry?.coordinates
  if (!Array.isArray(coords)) return null
  if (geometry.type === 'Polygon') return [coords]
  if (geometry.type === 'MultiPolygon') return coords
  return null
}

/** True when the point lies in the footprint, or the footprint is unknown. */
export function footprintCovers(
  footprint: Footprint | null,
  [lon, lat]: [number, number],
): boolean {
  if (!footprint) return true
  return footprint.some(
    ([outer, ...holes]) =>
      pointInRing(lon, lat, outer) &&
      !holes.some(hole => pointInRing(lon, lat, hole)),
  )
}

/** The fields the check needs from a STAC item, or null if any is missing. */
export function parseSceneItem(item: any): SceneItem | null {
  const p = item?.properties ?? {}
  const green = bandAsset(item?.assets?.green)
  const nir = bandAsset(item?.assets?.nir)
  const scl = bandAsset(item?.assets?.scl)
  const date = typeof p.datetime === 'string' ? p.datetime.slice(0, 10) : ''
  const epsg = itemEpsg(p)
  if (!green || !nir || !scl || !date || !Number.isFinite(epsg)) return null
  const cloud = p['eo:cloud_cover']
  return {
    id: String(item.id ?? date),
    date,
    cloudPct: Number.isFinite(cloud) ? cloud : 100,
    epsg,
    green,
    nir,
    scl,
    footprint: parseFootprint(item.geometry),
  }
}

/**
 * Drops scenes over the cloud limit and keeps one scene per date: one whose
 * footprint covers the site when there is one (a date can have partial
 * granules from different datastrips), then the clearest (reprocessed
 * products share a date too). Clearest first, so the best scenes are read
 * before any time limit cuts the list short.
 */
export function selectScenes(
  items: SceneItem[],
  maxCloudPct: number,
  siteLonLat?: [number, number],
): SceneItem[] {
  const covers = (s: SceneItem) =>
    !siteLonLat || footprintCovers(s.footprint, siteLonLat)
  const better = (a: SceneItem, b: SceneItem) =>
    covers(a) === covers(b) ? a.cloudPct < b.cloudPct : covers(a)
  const byDate = new Map<string, SceneItem>()
  for (const item of items) {
    if (item.cloudPct > maxCloudPct) continue
    const kept = byDate.get(item.date)
    if (!kept || better(item, kept)) byDate.set(item.date, item)
  }
  return [...byDate.values()].sort(
    (a, b) => a.cloudPct - b.cloudPct || a.date.localeCompare(b.date),
  )
}

export function utmDefinition(epsg: number): string {
  const zone = epsg % 100
  const south = epsg - zone === 32700
  if ((!south && epsg - zone !== 32600) || zone < 1 || zone > 60) {
    throw new Error(`Unsupported projection EPSG:${epsg}`)
  }
  const hemisphere = south ? ' +south' : ''
  return `+proj=utm +zone=${zone}${hemisphere} +datum=WGS84 +units=m +no_defs`
}

export function utmProjection(epsg: number): UtmProjection {
  const converter = proj4('WGS84', utmDefinition(epsg))
  return {
    epsg,
    toUtm: p => converter.forward(p) as [number, number],
    toLonLat: p => converter.inverse(p) as [number, number],
  }
}

/** 'S06', 'E039': hemisphere letter and zero-padded whole degrees. */
function degreeLabel(deg: number, pos: string, neg: string, digits: number) {
  const label = String(Math.abs(deg)).padStart(digits, '0')
  return `${deg >= 0 ? pos : neg}${label}`
}

/** The 3 x 3 degree WorldCover tile holding a point, e.g. S06E039. */
export function worldCoverTileUrl(
  baseUrl: string,
  lon: number,
  lat: number,
): string {
  const ns = degreeLabel(Math.floor(lat / 3) * 3, 'N', 'S', 2)
  const ew = degreeLabel(Math.floor(lon / 3) * 3, 'E', 'W', 3)
  return `${baseUrl}/v200/2021/map/ESA_WorldCover_10m_2021_v200_${ns}${ew}_Map.tif`
}

// Async helpers

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Rejects once the signal aborts, even if the work never settles. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Loads a value once; a failed load is dropped so the next call retries. */
function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let value = cache.get(key)
  if (!value) {
    value = load()
    cache.set(key, value)
    value.catch(() => cache.delete(key))
  }
  return value
}

/** Runs fn, retrying after each delay in turn when it throws. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= delaysMs.length) throw err
      await sleep(delaysMs[attempt])
    }
  }
}

/**
 * Calls fn for each item with at most `limit` calls in flight. Starts no
 * new calls once shouldStop() returns true.
 */
export async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++
      await fn(items[index], index)
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  await forEachLimit(items, limit, async (item, i) => {
    out[i] = await fn(item)
  })
  return out
}

async function fetchOk(url: string, method = 'GET'): Promise<Response> {
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res
}

const getText = (url: string) =>
  withRetry(async () => (await fetchOk(url)).text())

const getJson = (url: string) =>
  withRetry(async () => (await fetchOk(url)).json())

/** False when the server says the file does not exist (403 or 404). */
async function urlExists(url: string): Promise<boolean> {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status === 403 || res.status === 404) return false
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return true
  })
}

// Scene listing

async function listFolders(bucket: string, prefix: string): Promise<string[]> {
  const folders: string[] = []
  let token: string | null = null
  do {
    const page = parseListing(await getText(listUrl(bucket, prefix, token)))
    folders.push(...page.prefixes)
    token = page.nextToken
  } while (token)
  return folders
}

/** Sorts folders such as '.../2025/9/' and '.../2025/10/' by number. */
const lastNumber = (prefix: string) =>
  Number(prefix.replace(/\/+$/, '').split('/').pop())
const byLastNumber = (a: string, b: string) => lastNumber(a) - lastNumber(b)

/** The Sentinel-2 tiling never changes, so lookups are kept per process. */
const tileYearsCache = new Map<string, Promise<string[]>>()
const tileRasterCache = new Map<string, Promise<TileRaster>>()

/** Year folders of a tile, newest last; none when the tile does not exist. */
export function listTileYears(
  bucket: string,
  tile: MgrsTile,
): Promise<string[]> {
  const prefix = tilePrefix(tile)
  return cached(tileYearsCache, `${bucket}/${prefix}`, async () =>
    (await listFolders(bucket, prefix)).sort(byLastNumber),
  )
}

/** The newest scene item of a tile. */
async function newestSceneItem(
  bucket: string,
  tile: MgrsTile,
): Promise<SceneItem> {
  for (const year of [...(await listTileYears(bucket, tile))].reverse()) {
    const months = (await listFolders(bucket, year)).sort(byLastNumber)
    for (const month of months.reverse()) {
      const scenes = (await listFolders(bucket, month)).filter(p =>
        p.endsWith('_L2A/'),
      )
      for (const scene of scenes) {
        const item = parseSceneItem(await getJson(sceneItemUrl(bucket, scene)))
        if (item) return item
      }
    }
  }
  throw new Error(`No Sentinel-2 scene found in tile ${tile.id}`)
}

/** A tile's projection and grid, from its newest scene's green band. */
export function readTileRaster(
  bucket: string,
  tile: MgrsTile,
): Promise<TileRaster> {
  return cached(tileRasterCache, `${bucket}/${tile.id}`, async () => {
    const item = await newestSceneItem(bucket, tile)
    const geometry = await readRasterGeometry(item.green.href)
    return { tile, epsg: item.epsg, geometry }
  })
}

/**
 * The Sentinel-2 tile to read for a site (see candidateTiles and pickTile).
 * Throws when no tile in the bucket holds the site.
 */
export async function findSiteTile(
  bucket: string,
  ringLonLat: Ring,
  radiusM: number,
  maxPx: number,
  concurrency: number,
): Promise<MgrsTile> {
  const reachM = (maxPx * S2_PIXEL_M) / 2 + REACH_MARGIN_M
  const candidates = candidateTiles(...ringCentroid(ringLonLat), reachM)
  const years = await mapLimit(candidates, concurrency, t =>
    listTileYears(bucket, t),
  )
  const tiles = candidates.filter((_, i) => years[i].length)
  if (tiles.length === 1) return tiles[0]
  const rasters = await mapLimit(tiles, concurrency, t =>
    readTileRaster(bucket, t),
  )
  const tile = pickTile(rasters, ringLonLat, radiusM, maxPx)
  if (!tile) {
    const tried = candidates.map(t => t.id).join(', ')
    throw new Error(`No Sentinel-2 tile holds this site (tried ${tried})`)
  }
  return tile
}

/** L2A scene folders for the given months. */
export async function listScenePrefixes(
  bucket: string,
  months: string[],
  concurrency: number,
): Promise<string[]> {
  const folders = await mapLimit(months, concurrency, m =>
    listFolders(bucket, m),
  )
  return folders.flat().filter(p => p.endsWith('_L2A/'))
}

/** Parsed STAC items; `failed` counts items that could not be fetched. */
export async function fetchSceneItems(
  bucket: string,
  prefixes: string[],
  concurrency: number,
): Promise<{ items: SceneItem[]; failed: number }> {
  const results = await mapLimit(prefixes, concurrency, p =>
    getJson(sceneItemUrl(bucket, p)).then(parseSceneItem, () => undefined),
  )
  return {
    items: results.filter(Boolean),
    failed: results.filter(r => r === undefined).length,
  }
}

// Rasters

let sharedPool: { pool: Pool; users: number } | null = null

/**
 * Runs fn with a pool of `size` worker threads that inflate COG tiles, so
 * the CPU-heavy decoding stays off the event loop. Runs in flight share
 * one pool (the first run's size wins); it is shut down when the last one
 * finishes, so an idle process keeps no threads. Size 0 decodes on the
 * main thread.
 */
export async function withDecoderPool<T>(
  size: number,
  fn: (pool: Pool | undefined) => Promise<T>,
): Promise<T> {
  if (size < 1) return fn(undefined)
  const shared = (sharedPool ??= { pool: new Pool(size), users: 0 })
  shared.users++
  try {
    return await fn(shared.pool)
  } finally {
    if (--shared.users === 0) {
      if (sharedPool === shared) sharedPool = null
      void shared.pool.destroy()
    }
  }
}

interface OpenRaster {
  image: GeoTIFFImage
  geometry: RasterGeometry
}

async function openRaster(
  href: string,
  signal: AbortSignal,
): Promise<OpenRaster> {
  const tiff = await fromUrl(href, {}, signal)
  const image = await tiff.getImage()
  const [originX, originY] = image.getOrigin()
  const [res] = image.getResolution()
  const width = image.getWidth()
  const height = image.getHeight()
  return { image, geometry: { originX, originY, res, width, height } }
}

/** Origin, pixel size and size of a COG, read from its header. */
export function readRasterGeometry(href: string): Promise<RasterGeometry> {
  return withRetry(async () => {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    return (await openRaster(href, signal)).geometry
  })
}

/**
 * Reads the part of a COG covering `extent` (plus a margin in source
 * pixels) and samples it at the given points, which must be in the COG's
 * own coordinates. Points outside the COG read 0. Tiles are decoded in
 * `pool` when given.
 */
export function readBandAt(
  href: string,
  extent: Extent,
  points: PointSet,
  marginPx = 0,
  pool?: Pool,
): Promise<Uint16Array> {
  return withRetry(async () => {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const { image, geometry } = await openRaster(href, signal)
    const win = windowCovering(
      geometry,
      growExtent(extent, marginPx * geometry.res),
    )
    if (!win.width || !win.height) return new Uint16Array(points.xs.length)
    const [col1, row1] = [win.col0 + win.width, win.row0 + win.height]
    const read = image.readRasters({
      window: [win.col0, win.row0, col1, row1],
      samples: [0],
      pool,
      signal,
    })
    // A decode job lost with a crashed worker would never settle.
    const rasters = await untilAborted(read, signal)
    return sampleNearest(rasters[0] as ArrayLike<number>, win, points)
  })
}

function projectPoints(
  points: PointSet,
  project: (p: [number, number]) => [number, number],
): PointSet {
  const xs = new Float64Array(points.xs.length)
  const ys = new Float64Array(points.xs.length)
  for (let i = 0; i < xs.length; i++) {
    ;[xs[i], ys[i]] = project([points.xs[i], points.ys[i]])
  }
  return { xs, ys }
}

/**
 * ESA WorldCover class at each UTM point (nearest pixel), or null when no
 * WorldCover tile covers the site. Reads only the needed window.
 */
export async function readWorldCover(
  baseUrl: string,
  siteLonLat: [number, number],
  utmExtent: Extent,
  utmPoints: PointSet,
  projection: UtmProjection,
  pool?: Pool,
): Promise<Uint16Array | null> {
  const url = worldCoverTileUrl(baseUrl, ...siteLonLat)
  if (!(await urlExists(url))) return null
  const corners: Ring = extentCorners(utmExtent).map(projection.toLonLat)
  const points = projectPoints(utmPoints, projection.toLonLat)
  const extent = extentOf(corners)
  return readBandAt(url, extent, points, WORLDCOVER_MARGIN_PX, pool)
}
