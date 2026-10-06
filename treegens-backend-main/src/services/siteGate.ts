/**
 * Pure rules linking plant submissions to Site Checks: the snapshot a
 * submission keeps of its site, the species list sent with a plant clip, and
 * the SITE_CHECK_ENFORCEMENT gate for mangrove plantings.
 */
import { findSpecies } from '../siteCheck/mangroveSpecies'
import { distanceToRingM, haversineMeters, LonLat } from '../utils/geo'
import { SITE_GEOMETRY_LIMITS } from './siteRules'

export type SiteCheckEnforcement = 'off' | 'warn' | 'enforce'

type Gps = { latitude: number; longitude: number }

/** Where one clip was filmed relative to the site. */
export interface ClipPosition {
  insideSite: boolean
  distanceToSiteM: number
}

/**
 * What a submission records about its site: insideSite and distanceToSiteM
 * from the land clip GPS, the plant* fields from the plant clip once there.
 */
export interface SiteCheckSnapshot extends ClipPosition {
  siteId: unknown
  siteStatus: string
  verdictCode: string | null
  plantInsideSite?: boolean
  plantDistanceToSiteM?: number
  checkedAt: Date
}

export interface GateSite {
  _id?: unknown
  status: string
  boundary?: { coordinates: LonLat[][] }
  center?: Gps
  verdict?: {
    code?: string
    headline?: string
    reasons?: { severity?: string; source?: string }[]
  } | null
}

/**
 * A refusal over the Site Check link or gate that the planter can act on.
 * The upload route sends its message as HTTP 400.
 */
export class SiteCheckRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiteCheckRefusal'
  }
}

/**
 * How far a clip's GPS is from the site boundary (0 inside it), and whether
 * that is within the tolerance. A point farther from the centre than any
 * boundary may reach also counts as outside, so a thin sliver stored before
 * the extent cap cannot stretch "inside" along a whole coast.
 */
export function measureClip(
  site: GateSite,
  gps: Gps,
  toleranceM: number,
): ClipPosition {
  const ring = site.boundary?.coordinates?.[0] ?? []
  const toRing = distanceToRingM(gps.latitude, gps.longitude, ring)
  const { center } = site
  const beyondExtent = center
    ? haversineMeters(
        center.latitude,
        center.longitude,
        gps.latitude,
        gps.longitude,
      ) - SITE_GEOMETRY_LIMITS.maxExtentM
    : 0
  const distance = Math.max(toRing, beyondExtent)
  return {
    insideSite: distance <= toleranceM,
    distanceToSiteM: Math.round(distance * 10) / 10,
  }
}

export function buildSiteCheck(
  site: GateSite,
  gps: Gps,
  toleranceM: number,
  now = new Date(),
): SiteCheckSnapshot {
  const { insideSite, distanceToSiteM } = measureClip(site, gps, toleranceM)
  return {
    siteId: site._id,
    siteStatus: site.status,
    verdictCode: site.verdict?.code ?? null,
    insideSite,
    distanceToSiteM,
    checkedAt: now,
  }
}

export type SiteGateFlag =
  | 'no_site'
  | 'site_not_approved'
  | 'verdict_not_plant'
  | 'outside_site'

export interface SiteGateInput {
  enforcement: SiteCheckEnforcement
  siteCheck: Pick<
    SiteCheckSnapshot,
    | 'insideSite'
    | 'distanceToSiteM'
    | 'plantInsideSite'
    | 'plantDistanceToSiteM'
  > | null
  site: GateSite | null
}

export interface SiteGateResult {
  /** Set only under 'enforce': the upload must be refused with this text. */
  blockReason: string | null
  /** False when an AI auto-approval must go to verifiers instead. */
  allowAutoApprove: boolean
  /** Why the planting falls short of an approved, matching site. */
  flag: SiteGateFlag | null
}

/** Reason severities that never hold a verdict back from 'plant'. */
const PASSIVE_SEVERITIES = new Set(['good', 'info'])

/**
 * 'plant', or 'fix_first' only because the satellite raised 'check' doubts:
 * verifiers compared those with the photos when they approved the site.
 */
function verdictAllowsPlanting(verdict: GateSite['verdict']): boolean {
  if (verdict?.code === 'plant') return true
  if (verdict?.code !== 'fix_first') return false
  const doubts = (verdict.reasons ?? []).filter(
    r => !PASSIVE_SEVERITIES.has(String(r?.severity)),
  )
  return (
    doubts.length > 0 &&
    doubts.every(r => r.source === 'satellite' && r.severity === 'check')
  )
}

type OutsideClip = { clip: 'before' | 'planting'; distanceM: number }

/** The clip filmed farthest outside the site, or null when none is. */
function farthestOutside(
  siteCheck: NonNullable<SiteGateInput['siteCheck']>,
): OutsideClip | null {
  const land: OutsideClip | null = siteCheck.insideSite
    ? null
    : { clip: 'before', distanceM: siteCheck.distanceToSiteM }
  const plant: OutsideClip | null =
    siteCheck.plantInsideSite === false
      ? { clip: 'planting', distanceM: siteCheck.plantDistanceToSiteM ?? 0 }
      : null
  if (!land || !plant) return land ?? plant
  return plant.distanceM > land.distanceM ? plant : land
}

function gateProblem(
  siteCheck: SiteGateInput['siteCheck'],
  site: GateSite | null,
): { flag: SiteGateFlag; message: string } | null {
  if (!site || !siteCheck) {
    return {
      flag: 'no_site',
      message:
        'Mangrove planting needs an approved Site Check. Register the site first.',
    }
  }
  if (site.status === 'rejected') {
    return {
      flag: 'site_not_approved',
      message:
        'This site was rejected in review, so planting here is not rewarded.',
    }
  }
  if (site.status !== 'approved') {
    return {
      flag: 'site_not_approved',
      message: 'This site has not been approved yet.',
    }
  }
  if (!verdictAllowsPlanting(site.verdict)) {
    const headline = site.verdict?.headline ?? 'unknown'
    return {
      flag: 'verdict_not_plant',
      message: `The Site Check verdict for this site is ${headline}, so planting is not rewarded here.`,
    }
  }
  const outside = farthestOutside(siteCheck)
  if (outside) {
    const metres = Math.round(outside.distanceM)
    return {
      flag: 'outside_site',
      message: `Your ${outside.clip} video was filmed ${metres} m outside the checked site.`,
    }
  }
  return null
}

/**
 * 'off' only records the flag, 'warn' sends would-be auto-approvals to
 * verifiers, 'enforce' also refuses the planting outright.
 */
export function evaluateSiteGate(input: SiteGateInput): SiteGateResult {
  const problem = gateProblem(input.siteCheck, input.site)
  if (!problem) return { blockReason: null, allowAutoApprove: true, flag: null }
  return {
    blockReason: input.enforcement === 'enforce' ? problem.message : null,
    allowAutoApprove: input.enforcement === 'off',
    flag: problem.flag,
  }
}

/**
 * Under 'enforce', a land clip filmed outside the site it links is refused
 * before storage, while the before video can still be filmed again.
 */
export function landLinkBlockReason(
  enforcement: SiteCheckEnforcement,
  land: ClipPosition,
): string | null {
  if (enforcement !== 'enforce' || land.insideSite) return null
  const metres = Math.round(land.distanceToSiteM)
  return `This video was filmed ${metres} m outside the checked site. Film it again from inside the site.`
}

export const MAX_SPECIES_PER_PLANTING = 8

function speciesTokens(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return []
  const text = raw.trim()
  if (!text.startsWith('[')) return text.split(',')
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [text]
  } catch {
    return [text]
  }
}

/**
 * Species ids from a plant upload: a JSON array string, a comma-separated
 * list, or repeated form fields. Ids are trimmed, lowercased and de-duplicated;
 * those missing from the catalog come back in `unknown`.
 */
export function parseSpeciesIds(raw: unknown): {
  ids: string[]
  unknown: string[]
} {
  const tokens = speciesTokens(raw)
    .map(t => String(t).trim().toLowerCase())
    .filter(Boolean)
  const unique = [...new Set(tokens)]
  return {
    ids: unique.filter(id => findSpecies(id)),
    unknown: unique.filter(id => !findSpecies(id)),
  }
}
