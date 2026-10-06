import { HydrologyClass } from '../siteCheck/siteVerdict'

export const HYDROLOGY_VERSION = 'hydrology-s2-v1'

/** What the satellite hydrology check needs to run for one site. */
export interface HydrologyInput {
  /** Ring of [lon, lat] (GeoJSON order), WGS84. Closed or open. */
  ring: [number, number][]
  /** The analysis window ends with this month (inclusive). */
  asOf: Date
  /** How many years of imagery to read, 1 to 5. */
  years: number
  /** The window is the site's bounding box grown by this many metres. */
  referenceRadiusM: number
  /** Tile-level cloud cover filter, in percent. */
  maxCloudPct: number
  /** Scenes read in parallel. */
  concurrency: number
  /** Overall time budget. Reading stops when it runs out. */
  timeoutMs: number
  s2BucketUrl: string
  worldCoverUrl: string
  log?: (msg: string) => void
}

export interface HydrologyResult {
  version: typeof HYDROLOGY_VERSION
  hydrologyClass: HydrologyClass
  confidence: 'low' | 'medium' | 'high'
  /** Short plain-English notes on how the result was reached. */
  notes: string[]
  site: {
    pixelCount: number
    /** Pixels with enough clear observations to trust. */
    observedPixelCount: number
    medianWetFraction: number | null
    p25WetFraction: number | null
    p75WetFraction: number | null
    /** Share of observed site pixels wet in at least 90% of images. */
    permanentWaterShare: number
    /** Share of observed site pixels wet in under 2% of images. */
    rarelyWetShare: number
    /** Share of site pixels mapped as mangrove (WorldCover class 95). */
    mangroveCoverShare: number
    medianObservations: number
  }
  reference: {
    /** 'local' when enough fringe pixels sit next to mapped mangroves. */
    source: 'local' | 'default'
    edgePixelCount: number
    p25: number
    p50: number
    p75: number
    p90: number
    nearestMangroveM: number | null
    nearestTidalWaterM: number | null
  }
  imagery: {
    provider: string
    landcover: string
    mgrsTile: string
    epsg: number
    scenesListed: number
    scenesAfterCloudFilter: number
    scenesUsed: number
    scenesFailed: number
    firstSceneDate: string | null
    lastSceneDate: string | null
    windowPx: [number, number]
  }
  params: {
    years: number
    referenceRadiusM: number
    ndwiWetThreshold: number
    maxCloudPct: number
    minObservations: number
  }
  computedAt: string
  elapsedMs: number
}
