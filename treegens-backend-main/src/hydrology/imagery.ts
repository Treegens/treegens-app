/**
 * Data access for the satellite hydrology check: Sentinel-2 L2A scenes from
 * the public sentinel-cogs bucket (AWS open data) and the ESA WorldCover
 * 2021 land cover map. Both are read with plain HTTP range requests through
 * global fetch (geotiff.js uses it too), so no keys are needed. Network
 * blips happen, so every request is retried with a short backoff.
 */
import { fromUrl, GeoTIFFImage } from 'geotiff'
import * as mgrs from 'mgrs'
import proj4 from 'proj4'
import {
  BandScaling,
  Extent,
  extentCorners,
  extentOf,
  growExtent,
  PointSet,
  RasterGeometry,
  Ring,
  sampleNearest,
  windowCovering,
} from './math'

const SCENE_ROOT = 'sentinel-s2-l2a-cogs'
const REQUEST_TIMEOUT_MS = 60_000
const RETRY_DELAYS_MS = [1000, 2000]
/** Extra WorldCover pixels read around the window. */
const WORLDCOVER_MARGIN_PX = 2

export interface MgrsTile {
  id: string
  zone: number
  band: string
  square: string
}

export interface BandAsset extends BandScaling {
  href: string
}

export interface SceneItem {
  id: string
  /** Acquisition date, YYYY-MM-DD. */
  date: string
  cloudPct: number
  epsg: number
  green: BandAsset
  nir: BandAsset
  scl: BandAsset
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

/** UTM EPSG code for a tile: 326xx north of the equator, 327xx south. */
export function tileEpsg(tile: MgrsTile): number {
  return (tile.band >= 'N' ? 32600 : 32700) + tile.zone
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
    prefixes.push(
      `${SCENE_ROOT}/${tile.zone}/${tile.band}/${tile.square}/${month}/`,
    )
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
  }
}

/**
 * Drops scenes over the cloud limit and keeps the clearest scene per date
 * (reprocessed products share a date). Clearest first, so the best scenes
 * are read before any time limit cuts the list short.
 */
export function selectScenes(
  items: SceneItem[],
  maxCloudPct: number,
): SceneItem[] {
  const byDate = new Map<string, SceneItem>()
  for (const item of items) {
    if (item.cloudPct > maxCloudPct) continue
    const kept = byDate.get(item.date)
    if (!kept || item.cloudPct < kept.cloudPct) byDate.set(item.date, item)
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
 * own coordinates. Points outside the COG read 0.
 */
export function readBandAt(
  href: string,
  extent: Extent,
  points: PointSet,
  marginPx = 0,
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
    const rasters = await image.readRasters({
      window: [win.col0, win.row0, col1, row1],
      samples: [0],
      signal,
    })
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
): Promise<Uint16Array | null> {
  const url = worldCoverTileUrl(baseUrl, ...siteLonLat)
  if (!(await urlExists(url))) return null
  const corners: Ring = extentCorners(utmExtent).map(projection.toLonLat)
  const points = projectPoints(utmPoints, projection.toLonLat)
  return readBandAt(url, extentOf(corners), points, WORLDCOVER_MARGIN_PX)
}
