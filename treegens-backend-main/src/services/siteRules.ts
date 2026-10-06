/**
 * Pure Site Check decisions (no database, no network) so they can be unit
 * tested: which answers and photos are acceptable, how a boundary becomes a
 * stored polygon, and when verifier votes settle a site review.
 */
import {
  CauseActive,
  computeSiteVerdict,
  CurrentCover,
  DepthVsReference,
  FlowBlocked,
  HydrologySummary,
  LossCause,
  NearestMangroves,
  PreviousUse,
  Recruitment,
  ShoreExposure,
  SiteAnswers,
  SiteVerdict,
  Substrate,
  TideReach,
} from '../siteCheck/siteVerdict'
import {
  circleRing,
  closeRing,
  isValidRing,
  LonLat,
  ringAreaM2,
  ringCentroid,
} from '../utils/geo'
import { determineMajorityVote } from '../utils/verifierMajority'

/** Messages thrown by the site service; routes map them to HTTP statuses. */
export const SITE_ERRORS = {
  notFound: 'Site not found',
  accessDenied: 'Access denied',
  locked: 'Site is locked after submission',
  tooLarge: 'Site boundary is too large',
  tooSmall: 'Site boundary is too small',
  invalidBoundary: 'Invalid site boundary',
  missingAnswers: 'Answer all site questions first',
  missingPhotos: 'Add the low-tide and ground photos first',
  invalidPhotoKind: 'Invalid photo kind',
  imageOnly: 'Only image files are allowed',
  selfVote: 'You cannot vote on your own site',
  notOpen: 'Site is not open for review',
  noVerifiers: 'Cannot vote: no verifiers configured',
  allVoted: 'All verifiers have already voted',
  alreadyVoted: 'You have already voted on this site',
  linked: 'Site is linked to a planting submission',
  recheckTooSoon:
    'The satellite check can only be rerun after it fails, is skipped, or is more than 30 days old',
} as const

/** Every member of a string union; the Record type flags a missing value. */
function options<T extends string>(all: Record<T, true>): T[] {
  return Object.keys(all) as T[]
}

/** Allowed values for each multiple-choice answer, from siteVerdict.ts. */
export const ANSWER_OPTIONS = {
  previousUse: options<PreviousUse>({
    mangrove_cut: true,
    pond_or_salt_pan: true,
    farm_or_built: true,
    never_mangrove: true,
    unknown: true,
  }),
  currentCover: options<CurrentCover>({
    bare_mud: true,
    sand: true,
    seagrass: true,
    grass_or_shrub: true,
    degraded_mangrove: true,
    healthy_mangrove: true,
    rock_or_coral: true,
  }),
  tideReach: options<TideReach>({
    daily: true,
    spring_tides_only: true,
    never: true,
    always_underwater: true,
    unsure: true,
  }),
  depthVsReference: options<DepthVsReference>({
    similar: true,
    shallower: true,
    much_deeper: true,
    no_reference: true,
    not_measured: true,
  }),
  flowBlocked: options<FlowBlocked>({
    no: true,
    yes_fixed: true,
    yes_not_fixed: true,
    unsure: true,
  }),
  lossCauses: options<LossCause>({
    cutting: true,
    bark_stripping: true,
    infrastructure: true,
    blocked_flow: true,
    erosion: true,
    mining: true,
    pollution: true,
    grazing: true,
    storm: true,
    unknown: true,
  }),
  causeStillActive: options<CauseActive>({
    yes: true,
    partly: true,
    no: true,
    unsure: true,
  }),
  naturalRecruitment: options<Recruitment>({
    many: true,
    few: true,
    none: true,
    unsure: true,
  }),
  shoreExposure: options<ShoreExposure>({
    sheltered: true,
    exposed: true,
    unsure: true,
  }),
  substrate: options<Substrate>({
    soft_mud: true,
    sandy_mud: true,
    sand: true,
    rock_or_rubble: true,
    salt_crust: true,
  }),
  nearestMangroves: options<NearestMangroves>({
    within_100m: true,
    within_1km: true,
    over_1km: true,
    none_known: true,
  }),
}

/** Single-choice answers, each checked against ANSWER_OPTIONS. */
const CHOICE_KEYS = [
  'previousUse',
  'currentCover',
  'tideReach',
  'depthVsReference',
  'flowBlocked',
  'causeStillActive',
  'naturalRecruitment',
  'shoreExposure',
  'substrate',
  'nearestMangroves',
] as const

export const ANSWER_LIMITS = {
  nearbyCanopyImpact: { min: 0, max: 5 },
  tideMarkCm: { min: 0, max: 500 },
  notesMaxLength: 1000,
}

function numberIn(value: unknown, range: { min: number; max: number }) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max
    ? value
    : undefined
}

/**
 * Keeps only known answers with allowed values. Accepts a plain object or a
 * Mongoose sub-document and always returns a plain SiteAnswers object.
 */
export function sanitizeSiteAnswers(raw: unknown): SiteAnswers {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const out: SiteAnswers = {}
  for (const key of CHOICE_KEYS) {
    const allowed = ANSWER_OPTIONS[key] as string[]
    if (allowed.includes(src[key])) Object.assign(out, { [key]: src[key] })
  }
  if (Array.isArray(src.lossCauses)) {
    const causes = src.lossCauses.filter(c =>
      ANSWER_OPTIONS.lossCauses.includes(c),
    )
    if (causes.length) out.lossCauses = [...new Set<LossCause>(causes)]
  }
  if (typeof src.erosionScarps === 'boolean') {
    out.erosionScarps = src.erosionScarps
  }
  const impact = numberIn(
    src.nearbyCanopyImpact,
    ANSWER_LIMITS.nearbyCanopyImpact,
  )
  if (impact !== undefined) out.nearbyCanopyImpact = impact
  const tideMark = numberIn(src.tideMarkCm, ANSWER_LIMITS.tideMarkCm)
  if (tideMark !== undefined) out.tideMarkCm = tideMark
  const notes = typeof src.notes === 'string' ? src.notes.trim() : ''
  if (notes) out.notes = notes.slice(0, ANSWER_LIMITS.notesMaxLength)
  return out
}

/** Verdict for a stored site, with the satellite summary when there is one. */
export function siteVerdictFor(
  site: { answers?: unknown; countryCode?: string | null },
  hydrology: HydrologySummary | null,
): SiteVerdict {
  return computeSiteVerdict({
    answers: sanitizeSiteAnswers(site.answers),
    hydrology,
    countryCode: site.countryCode,
  })
}

/** ISO 3166-1 alpha-2, uppercased; undefined when it is not two letters. */
export function normalizeCountryCode(raw: unknown): string | undefined {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return /^[A-Z]{2}$/.test(code) ? code : undefined
}

export type SitePhotoKind =
  | 'low_tide_360'
  | 'ground'
  | 'tide_mark'
  | 'high_tide'

export const SITE_PHOTO_KINDS: SitePhotoKind[] = [
  'low_tide_360',
  'ground',
  'tide_mark',
  'high_tide',
]

/** A slow 360 at low tide and a ground close-up are needed to submit. */
export const REQUIRED_SITE_PHOTOS: SitePhotoKind[] = ['low_tide_360', 'ground']

export function missingSitePhotos(
  photos: { kind?: string }[] = [],
): SitePhotoKind[] {
  const have = new Set(photos.map(p => p.kind))
  return REQUIRED_SITE_PHOTOS.filter(kind => !have.has(kind))
}

export type SiteBoundaryMethod = 'walked' | 'pin_radius'

export interface SiteBoundaryInput {
  boundaryMethod: SiteBoundaryMethod
  ring?: LonLat[]
  center?: { latitude: number; longitude: number }
  radiusM?: number
}

export interface SiteGeometry {
  boundaryMethod: SiteBoundaryMethod
  boundary: { type: 'Polygon'; coordinates: LonLat[][] }
  center: { latitude: number; longitude: number }
  radiusM?: number
  areaM2: number
}

export const SITE_GEOMETRY_LIMITS = {
  minAreaM2: 50,
  minRadiusM: 5,
  maxRadiusM: 300,
}

function isLatLng(p: unknown): p is { latitude: number; longitude: number } {
  const { latitude, longitude } = (p ?? {}) as Record<string, unknown>
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
}

function pinCircle(input: SiteBoundaryInput) {
  const { center, radiusM } = input
  const { minRadiusM, maxRadiusM } = SITE_GEOMETRY_LIMITS
  if (!isLatLng(center) || !(radiusM >= minRadiusM && radiusM <= maxRadiusM)) {
    throw new Error(SITE_ERRORS.invalidBoundary)
  }
  const { latitude, longitude } = center
  return {
    ring: circleRing(latitude, longitude, radiusM),
    center: { latitude, longitude },
    radiusM,
  }
}

function walkedRing(input: SiteBoundaryInput) {
  if (!isValidRing(input.ring)) throw new Error(SITE_ERRORS.invalidBoundary)
  const ring = closeRing(input.ring)
  return { ring, center: ringCentroid(ring), radiusM: undefined }
}

/**
 * Turns a walked boundary or a pin plus radius into the stored polygon,
 * centre and area. Throws SITE_ERRORS messages for bad or oversized input.
 */
export function buildSiteGeometry(
  input: SiteBoundaryInput,
  maxAreaM2: number,
): SiteGeometry {
  const { ring, center, radiusM } =
    input.boundaryMethod === 'pin_radius' ? pinCircle(input) : walkedRing(input)
  const areaM2 = ringAreaM2(ring)
  if (areaM2 < SITE_GEOMETRY_LIMITS.minAreaM2) {
    throw new Error(SITE_ERRORS.tooSmall)
  }
  if (areaM2 > maxAreaM2) throw new Error(SITE_ERRORS.tooLarge)
  return {
    boundaryMethod: input.boundaryMethod,
    boundary: { type: 'Polygon', coordinates: [ring] },
    center,
    ...(radiusM !== undefined ? { radiusM } : {}),
    areaM2: Math.round(areaM2),
  }
}

export interface SiteReviewInput {
  votes: { voterWalletAddress: string; vote: 'yes' | 'no' }[]
  /** Wallets that are verifiers right now. */
  activeVerifierWallets: Iterable<string>
  totalVerifiers: number
  minimumActiveVerifiers: number
}

export interface SiteReviewResolution {
  outcome: 'approved' | 'rejected' | null
  majorityVote: 'yes' | 'no' | null
  /** Too few verifiers exist for any review to finalize yet. */
  blockedByVerifierThreshold: boolean
}

/**
 * Same rule as submissions: a strict majority of the whole verifier pool,
 * counting only votes from wallets that are still verifiers.
 */
export function resolveSiteReview(
  input: SiteReviewInput,
): SiteReviewResolution {
  if (input.totalVerifiers < input.minimumActiveVerifiers) {
    return {
      outcome: null,
      majorityVote: null,
      blockedByVerifierThreshold: true,
    }
  }
  const active = new Set(
    [...input.activeVerifierWallets].map(w => w.toLowerCase()),
  )
  const eligible = input.votes.filter(v =>
    active.has(String(v.voterWalletAddress || '').toLowerCase()),
  )
  const majorityVote = determineMajorityVote(eligible, input.totalVerifiers)
  const outcome =
    majorityVote === 'yes'
      ? 'approved'
      : majorityVote === 'no'
        ? 'rejected'
        : null
  return { outcome, majorityVote, blockedByVerifierThreshold: false }
}

const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** A satellite rerun is allowed after a failure, a skip, or 30 days. */
export function canRecheckHydrology(
  hydrology: { status?: string; completedAt?: Date | string | null } | null,
  now: Date,
): boolean {
  const status = hydrology?.status
  if (status === 'failed' || status === 'skipped') return true
  if (status !== 'completed') return false
  const completedAt = hydrology.completedAt
    ? new Date(hydrology.completedAt).getTime()
    : 0
  return now.getTime() - completedAt > RECHECK_AFTER_MS
}
