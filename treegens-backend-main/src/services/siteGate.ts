/**
 * Pure rules linking plant submissions to Site Checks: the snapshot a
 * submission keeps of its site, the species list sent with a plant clip, and
 * the SITE_CHECK_ENFORCEMENT gate for mangrove plantings.
 */
import { findSpecies } from '../siteCheck/mangroveSpecies'
import { distanceToRingM, LonLat } from '../utils/geo'

export type SiteCheckEnforcement = 'off' | 'warn' | 'enforce'

/** What a submission records about its site, from the land clip GPS. */
export interface SiteCheckSnapshot {
  siteId: unknown
  siteStatus: string
  verdictCode: string | null
  insideSite: boolean
  distanceToSiteM: number
  checkedAt: Date
}

export interface GateSite {
  _id?: unknown
  status: string
  boundary?: { coordinates: LonLat[][] }
  verdict?: { code?: string; headline?: string } | null
}

export function buildSiteCheck(
  site: GateSite,
  gps: { latitude: number; longitude: number },
  toleranceM: number,
  now = new Date(),
): SiteCheckSnapshot {
  const ring = site.boundary?.coordinates?.[0] ?? []
  const distance = distanceToRingM(gps.latitude, gps.longitude, ring)
  return {
    siteId: site._id,
    siteStatus: site.status,
    verdictCode: site.verdict?.code ?? null,
    insideSite: distance <= toleranceM,
    distanceToSiteM: Math.round(distance * 10) / 10,
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
  siteCheck: Pick<SiteCheckSnapshot, 'insideSite' | 'distanceToSiteM'> | null
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
  if (site.status !== 'approved') {
    return {
      flag: 'site_not_approved',
      message: 'This site has not been approved yet.',
    }
  }
  if (site.verdict?.code !== 'plant') {
    const headline = site.verdict?.headline ?? 'unknown'
    return {
      flag: 'verdict_not_plant',
      message: `The Site Check verdict for this site is ${headline}, so planting is not rewarded here.`,
    }
  }
  if (!siteCheck.insideSite) {
    const metres = Math.round(siteCheck.distanceToSiteM)
    return {
      flag: 'outside_site',
      message: `This video was filmed ${metres} m outside the checked site.`,
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
