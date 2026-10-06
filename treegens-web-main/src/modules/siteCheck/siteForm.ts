/**
 * The Site Check wizard's form: how a walked or circled boundary is built
 * and checked, and how the form maps to the API body, the offline draft and
 * an existing site.
 */
import type { SiteInput } from '@/services/siteService'
import type {
  IGpsCoordinates,
  ISiteDoc,
  ISiteHydrology,
  SiteBoundaryMethod,
} from '@/types'
import {
  distanceM,
  isValidRing,
  type LonLat,
  ringAreaM2,
  ringExtentM,
} from '@/utils/geo'
import type { SiteDraft } from '@/utils/siteDraftStore'
import type { HydrologySummary, SiteAnswers } from './siteVerdict'

/** Fixes worse than this are ignored while walking the boundary. */
export const WALK_MAX_ACCURACY_M = 20
/** The middle of a circle site waits for a GPS fix at least this good. */
export const CIRCLE_MAX_ACCURACY_M = WALK_MAX_ACCURACY_M
/** A new boundary point is kept only this far from the last one. */
export const WALK_MIN_SPACING_M = 5
export const MIN_WALK_POINTS = 3
/** The API takes at most this many boundary points. */
export const MAX_RING_POINTS = 500
export const RADIUS_CHOICES_M = [10, 25, 50, 100] as const
export const MIN_SITE_AREA_M2 = 50
export const MAX_SITE_AREA_M2 = 500_000
/**
 * Farthest a boundary point may be from the site's centre (the backend's
 * SITE_GEOMETRY_LIMITS.maxExtentM); keep the two in step.
 */
export const MAX_SITE_EXTENT_M = 1500
/** finishWalk drops at most this many points walked past the start. */
const MAX_OVERSHOOT_POINTS = 4

export const CROSSING_PATH_PROBLEM =
  'Your path crosses itself. Tap "Undo last point" until this message goes away, or tap "Start again".'
export const TOO_LONG_PROBLEM =
  'The site is too long. Keep every point within 1.5 km of the middle, or split it into two sites.'

export interface SiteForm {
  name: string
  boundaryMethod: SiteBoundaryMethod | null
  /** Walked points, [lon, lat], not closed */
  ring: LonLat[]
  center: IGpsCoordinates | null
  radiusM: number
  countryCode: string
  reverseGeocode: string
  answers: SiteAnswers
}

export const EMPTY_SITE_FORM: SiteForm = {
  name: '',
  boundaryMethod: null,
  ring: [],
  center: null,
  radiusM: 25,
  countryCode: '',
  reverseGeocode: '',
  answers: {},
}

/** Adds a GPS fix to the walk when it is accurate and far enough along. */
export function appendWalkPoint(
  ring: LonLat[],
  point: LonLat,
  accuracyM: number,
): LonLat[] {
  if (!(accuracyM <= WALK_MAX_ACCURACY_M)) return ring
  const last = ring[ring.length - 1]
  if (last && distanceM(last, point) < WALK_MIN_SPACING_M) return ring
  return [...ring, point]
}

export function formAreaM2(form: SiteForm): number {
  if (form.boundaryMethod === 'walked') return ringAreaM2(form.ring)
  if (form.boundaryMethod === 'pin_radius' && form.center) {
    return Math.PI * form.radiusM ** 2
  }
  return 0
}

/** First point we know for the site, for reverse geocoding. */
export function formAnchor(form: SiteForm): IGpsCoordinates | null {
  if (form.boundaryMethod === 'pin_radius') return form.center
  const first = form.ring[0]
  return first ? { latitude: first[1], longitude: first[0] } : null
}

/** Keeps every n-th point of a long walk so it fits the API limit. */
export function thinRing(ring: LonLat[]): LonLat[] {
  if (ring.length <= MAX_RING_POINTS) return ring
  const step = Math.ceil(ring.length / MAX_RING_POINTS)
  return ring.filter((_, i) => i % step === 0)
}

/**
 * True when a point of the boundary the API is sent lies farther from its
 * centre than the API allows.
 */
export function ringTooLong(ring: LonLat[]): boolean {
  return ringExtentM(thinRing(ring)) > MAX_SITE_EXTENT_M
}

/** What is wrong with a walked boundary, in plain words, or null. */
export function walkedRingProblem(ring: LonLat[]): string | null {
  if (ring.length < MIN_WALK_POINTS) {
    return 'Walk around the site until at least 3 points are saved.'
  }
  const area = ringAreaM2(ring)
  if (area < MIN_SITE_AREA_M2) {
    return 'The area is too small. Walk around the whole site.'
  }
  if (area > MAX_SITE_AREA_M2) {
    return 'The area is too big. Check at most 50 hectares at a time.'
  }
  // The same test the API runs on the points it is sent.
  if (!isValidRing(thinRing(ring))) return CROSSING_PATH_PROBLEM
  if (ringTooLong(ring)) return TOO_LONG_PROBLEM
  return null
}

/**
 * Drops the last few points when that turns a crossing walk into a good
 * boundary: walking a few metres past the start makes the last edge cross
 * the first one. Returns the ring unchanged when trimming does not help.
 */
export function trimWalkOvershoot(ring: LonLat[]): LonLat[] {
  if (walkedRingProblem(ring) !== CROSSING_PATH_PROBLEM) return ring
  for (let drop = 1; drop <= MAX_OVERSHOOT_POINTS; drop++) {
    const trimmed = ring.slice(0, -drop)
    if (trimmed.length < MIN_WALK_POINTS) break
    if (!walkedRingProblem(trimmed)) return trimmed
  }
  return ring
}

/** What still blocks the location step, in plain words, or null. */
export function locationProblem(form: SiteForm): string | null {
  if (!form.boundaryMethod) return 'Choose how to mark the site.'
  if (form.boundaryMethod === 'pin_radius' && !form.center) {
    return 'Waiting for your GPS position.'
  }
  if (form.boundaryMethod === 'walked') {
    const problem = walkedRingProblem(form.ring)
    if (problem) return problem
  }
  if (!form.name.trim()) return 'Give the site a name.'
  return null
}

function boundaryInput(form: SiteForm): Partial<SiteInput> {
  if (form.boundaryMethod === 'walked') {
    return { boundaryMethod: 'walked', ring: thinRing(form.ring) }
  }
  return {
    boundaryMethod: 'pin_radius',
    center: form.center ?? undefined,
    radiusM: form.radiusM,
  }
}

function detailsInput(form: SiteForm) {
  return {
    name: form.name.trim().slice(0, 80),
    countryCode: form.countryCode || undefined,
    reverseGeocode: form.reverseGeocode.slice(0, 500) || undefined,
    answers: form.answers,
  }
}

export function formToInput(form: SiteForm): SiteInput {
  return { ...detailsInput(form), ...boundaryInput(form) } as SiteInput
}

/** PATCH body: the details always, the boundary only when it moved. */
export function formToPatch(
  form: SiteForm,
  site: ISiteDoc,
): Partial<SiteInput> {
  const moved =
    JSON.stringify(boundaryInput(form)) !==
    JSON.stringify(boundaryInput(siteToForm(site)))
  return moved
    ? { ...detailsInput(form), ...boundaryInput(form) }
    : detailsInput(form)
}

export function formToDraft(form: SiteForm): SiteDraft {
  return {
    name: form.name,
    boundaryMethod: form.boundaryMethod,
    ring: form.ring,
    center: form.center ?? undefined,
    radiusM: form.radiusM,
    countryCode: form.countryCode,
    reverseGeocode: form.reverseGeocode,
    answers: form.answers,
    updatedAt: new Date().toISOString(),
  }
}

export function draftToForm(draft: SiteDraft): SiteForm {
  return {
    name: draft.name ?? '',
    boundaryMethod: draft.boundaryMethod ?? null,
    ring: Array.isArray(draft.ring) ? draft.ring : [],
    center: draft.center ?? null,
    radiusM: draft.radiusM ?? EMPTY_SITE_FORM.radiusM,
    countryCode: draft.countryCode ?? '',
    reverseGeocode: draft.reverseGeocode ?? '',
    answers: draft.answers ?? {},
  }
}

/** The stored ring is closed; the form keeps it open. */
function openRing(ring: LonLat[]): LonLat[] {
  const first = ring[0]
  const last = ring[ring.length - 1]
  const closed = ring.length > 1 && first[0] === last[0] && first[1] === last[1]
  return closed ? ring.slice(0, -1) : ring
}

export function siteToForm(site: ISiteDoc): SiteForm {
  const walked = site.boundaryMethod === 'walked'
  return {
    name: site.name,
    boundaryMethod: site.boundaryMethod,
    ring: walked ? openRing(site.boundary?.coordinates?.[0] ?? []) : [],
    center: site.center,
    radiusM: site.radiusM ?? EMPTY_SITE_FORM.radiusM,
    countryCode: site.countryCode ?? '',
    reverseGeocode: site.reverseGeocode ?? '',
    answers: site.answers ?? {},
  }
}

/** The parts of a finished satellite check the verdict rules use. */
export function hydrologySummaryOf(
  hydrology?: ISiteHydrology | null,
): HydrologySummary | null {
  const result = hydrology?.status === 'completed' ? hydrology.result : null
  if (!result) return null
  return {
    hydrologyClass: result.hydrologyClass,
    confidence: result.confidence,
    medianWetFraction: result.site.medianWetFraction,
    referenceP50: result.reference.p50,
  }
}
