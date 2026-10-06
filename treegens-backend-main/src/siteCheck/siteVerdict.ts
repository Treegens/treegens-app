/**
 * Site Check verdict: turns a planter's field answers (and, when it has run,
 * the satellite hydrology check) into one of four plain-language outcomes.
 *
 *   plant        green   the site looks right, here is what to plant
 *   fix_first    amber   something must be fixed or checked before planting
 *   let_regrow   blue    healthy forest or natural regrowth: protect it
 *   not_suitable red     not a mangrove site
 *
 * The rules follow the CBEMR workshop pack: IUCN MSG "Pause before you
 * Plant" (most planting fails on mudflats and seagrass that never held
 * mangroves; fix the cause of loss first; natural regeneration is often
 * enough) and the SPREP mangrove monitoring manual (mangroves live between
 * mean tide and high tide on sheltered, muddy shores; impact codes).
 *
 * MIRRORED FILE: an identical copy lives at
 * treegens-web-main/src/modules/siteCheck/siteVerdict.ts so the app can
 * show a verdict offline. Edit both together (siteVerdict.test.ts checks).
 */
import { PlantingZone, speciesFor } from './mangroveSpecies'

export const SITE_RULES_VERSION = 'site-rules-v1'

export type PreviousUse =
  | 'mangrove_cut'
  | 'pond_or_salt_pan'
  | 'farm_or_built'
  | 'never_mangrove'
  | 'unknown'
export type CurrentCover =
  | 'bare_mud'
  | 'sand'
  | 'seagrass'
  | 'grass_or_shrub'
  | 'degraded_mangrove'
  | 'healthy_mangrove'
  | 'rock_or_coral'
export type TideReach =
  | 'daily'
  | 'spring_tides_only'
  | 'never'
  | 'always_underwater'
  | 'unsure'
/** High-tide water depth here compared with the nearest natural stand. */
export type DepthVsReference =
  | 'similar'
  | 'shallower'
  | 'much_deeper'
  | 'no_reference'
  | 'not_measured'
export type FlowBlocked = 'no' | 'yes_fixed' | 'yes_not_fixed' | 'unsure'
/** Pressures, after the manual's Table 4 impact codes (CO, ER, EC/BS, MI, OT). */
export type LossCause =
  | 'cutting'
  | 'bark_stripping'
  | 'infrastructure'
  | 'blocked_flow'
  | 'erosion'
  | 'mining'
  | 'pollution'
  | 'grazing'
  | 'storm'
  | 'unknown'
export type CauseActive = 'yes' | 'partly' | 'no' | 'unsure'
export type Recruitment = 'many' | 'few' | 'none' | 'unsure'
export type ShoreExposure = 'sheltered' | 'exposed' | 'unsure'
export type Substrate =
  | 'soft_mud'
  | 'sandy_mud'
  | 'sand'
  | 'rock_or_rubble'
  | 'salt_crust'
export type NearestMangroves =
  | 'within_100m'
  | 'within_1km'
  | 'over_1km'
  | 'none_known'

export interface SiteAnswers {
  previousUse?: PreviousUse
  currentCover?: CurrentCover
  tideReach?: TideReach
  depthVsReference?: DepthVsReference
  flowBlocked?: FlowBlocked
  lossCauses?: LossCause[]
  causeStillActive?: CauseActive
  naturalRecruitment?: Recruitment
  shoreExposure?: ShoreExposure
  erosionScarps?: boolean
  substrate?: Substrate
  nearestMangroves?: NearestMangroves
  /** Canopy impact of the nearest stand, 0 (none) to 5 (severe), manual Table 3. */
  nearbyCanopyImpact?: number
  /** Height of the high-tide stain on nearby trunks above the mud, in cm. */
  tideMarkCm?: number
  notes?: string
}

/** Answers a planter must give before a site can be submitted. */
export const REQUIRED_ANSWERS: (keyof SiteAnswers)[] = [
  'previousUse',
  'currentCover',
  'tideReach',
  'flowBlocked',
  'naturalRecruitment',
  'shoreExposure',
  'substrate',
  'nearestMangroves',
]

export function missingAnswers(answers: SiteAnswers): (keyof SiteAnswers)[] {
  const missing = REQUIRED_ANSWERS.filter(k => answers[k] === undefined)
  if (hasKnownCause(answers) && answers.causeStillActive === undefined) {
    missing.push('causeStillActive')
  }
  return missing
}

export type HydrologyClass =
  | 'in_range'
  | 'borderline_low'
  | 'too_low'
  | 'permanently_wet'
  | 'rarely_wet'
  | 'existing_mangrove'
  | 'insufficient_data'

/** The parts of the satellite hydrology result the rules need. */
export interface HydrologySummary {
  hydrologyClass: HydrologyClass
  confidence: 'low' | 'medium' | 'high'
  medianWetFraction?: number | null
  referenceP50?: number | null
}

export type VerdictCode = 'plant' | 'fix_first' | 'let_regrow' | 'not_suitable'
export type ReasonSeverity =
  | 'protect'
  | 'blocker'
  | 'regrow'
  | 'fix'
  | 'check'
  | 'good'
  | 'info'

export interface VerdictReason {
  code: string
  severity: ReasonSeverity
  source: 'field' | 'satellite'
  message: string
}

export interface SiteVerdict {
  code: VerdictCode
  headline: string
  reasons: VerdictReason[]
  /** True when a high-tide photo or expert visit should settle a doubt. */
  needsFieldCheck: boolean
  recommendedZone: PlantingZone | null
  recommendedSpeciesIds: string[]
  /** False until the satellite check has produced a usable result. */
  hydrologyConsidered: boolean
  rulesVersion: string
}

export interface VerdictInput {
  answers: SiteAnswers
  hydrology?: HydrologySummary | null
  countryCode?: string | null
}

const HEADLINES: Record<VerdictCode, string> = {
  plant: 'Plant here',
  fix_first: 'Fix first',
  let_regrow: 'Protect it and let it regrow',
  not_suitable: 'Not a mangrove site',
}

const CAUSE_LABELS: Record<LossCause, string> = {
  cutting: 'tree cutting',
  bark_stripping: 'bark stripping',
  infrastructure: 'building or dumping',
  blocked_flow: 'blocked tidal flow',
  erosion: 'erosion',
  mining: 'sand or mud mining',
  pollution: 'pollution or garbage',
  grazing: 'animals grazing or digging',
  storm: 'storm damage',
  unknown: 'an unknown cause',
}

function hasKnownCause(a: SiteAnswers): boolean {
  return (a.lossCauses ?? []).some(c => c !== 'unknown')
}

type Push = (
  code: string,
  severity: ReasonSeverity,
  message: string,
  source?: 'field' | 'satellite',
) => void

function coverAndHistoryRules(a: SiteAnswers, push: Push): void {
  if (a.currentCover === 'healthy_mangrove') {
    push(
      'healthy_forest',
      'protect',
      'This is healthy mangrove forest. Protecting it does more good than planting into it.',
    )
  }
  if (a.currentCover === 'seagrass') {
    push(
      'seagrass',
      'blocker',
      'Seagrass meadows are a valuable habitat of their own. Never plant mangroves on seagrass.',
    )
  }
  if (a.currentCover === 'rock_or_coral' || a.substrate === 'rock_or_rubble') {
    push(
      'rocky_ground',
      'blocker',
      'Mangroves need soft sediment to root in. Rock and coral rubble will not hold them.',
    )
  }
  const openGround =
    a.currentCover === 'bare_mud' ||
    a.currentCover === 'sand' ||
    a.currentCover === 'grass_or_shrub'
  if (a.previousUse === 'never_mangrove' && openGround) {
    push(
      'never_mangrove',
      'blocker',
      'Ground that never held mangroves is where most mass planting fails. Only plant here if a mangrove expert confirms it.',
    )
  }
  if (a.previousUse === 'pond_or_salt_pan') {
    push(
      'former_pond',
      'info',
      'Old ponds and salt pans can often be restored once the tide flows in and out freely again.',
    )
  }
  if (a.previousUse === 'unknown') {
    push(
      'history_unknown',
      'info',
      'Ask older community members whether mangroves grew here before. It is the best sign the site can work.',
    )
  }
}

function tideRules(a: SiteAnswers, push: Push): void {
  switch (a.tideReach) {
    case 'always_underwater':
      push(
        'always_underwater',
        'blocker',
        'This spot stays underwater. Mangroves need to dry out between tides.',
      )
      break
    case 'never':
      if (a.flowBlocked === 'yes_not_fixed') {
        push(
          'tide_blocked',
          'fix',
          'The tide cannot reach this spot because the flow is blocked. Reopen it, then check again.',
        )
      } else {
        push(
          'above_tide',
          'blocker',
          'The tide never reaches this spot. Mangroves need regular flooding by seawater.',
        )
      }
      break
    case 'spring_tides_only':
      push(
        'upper_zone',
        'good',
        'Only the biggest tides reach here, so it suits landward species.',
      )
      break
    case 'daily':
      push('daily_tides', 'good', 'The tide reaches this spot every day.')
      break
    default:
      push(
        'tide_unknown',
        'check',
        'Visit at high tide and photograph the water level, so we know the tide reaches this spot.',
      )
  }
  if (a.depthVsReference === 'much_deeper') {
    push(
      'too_deep',
      'blocker',
      'At high tide it floods much deeper here than where the same mangroves grow naturally. It is too low.',
    )
  } else if (a.depthVsReference === 'similar') {
    push(
      'depth_matches',
      'good',
      'High-tide depth matches the nearest natural mangroves.',
    )
  }
}

function flowAndCauseRules(a: SiteAnswers, push: Push): void {
  if (a.flowBlocked === 'yes_not_fixed' && a.tideReach !== 'never') {
    push(
      'flow_blocked',
      'fix',
      'Pond walls, dykes, roads or a blocked creek are cutting off the tide. Open the flow first. Often nature then replants on its own.',
    )
  } else if (a.flowBlocked === 'unsure') {
    push(
      'flow_unknown',
      'check',
      'Walk the creeks and edges and look for walls, roads or blocked channels that stop the tide.',
    )
  }
  if (!hasKnownCause(a)) return
  const causes = (a.lossCauses ?? [])
    .filter(c => c !== 'unknown')
    .map(c => CAUSE_LABELS[c])
    .join(', ')
  if (a.causeStillActive === 'yes' || a.causeStillActive === 'partly') {
    push(
      'cause_active',
      'fix',
      `What destroyed the mangroves is still happening (${causes}). New trees will die the same way unless it stops.`,
    )
  } else if (a.causeStillActive === 'unsure') {
    push(
      'cause_unknown',
      'check',
      `Find out whether ${causes} still happens here before planting.`,
    )
  }
}

function regrowthRules(a: SiteAnswers, push: Push): void {
  if (a.naturalRecruitment === 'many') {
    push(
      'natural_regrowth',
      'regrow',
      'Wild seedlings are already arriving. Protect them and let the site regrow. Plant only gaps that stay empty after a year.',
    )
  } else if (a.naturalRecruitment === 'few') {
    push(
      'some_regrowth',
      'info',
      'A few wild seedlings are arriving. Plant only the gaps and leave the wildlings in place.',
    )
  } else if (a.naturalRecruitment === 'none') {
    push(
      'no_regrowth',
      'good',
      'No wild seedlings are arriving, so planting can help here.',
    )
  }
}

function shoreAndGroundRules(a: SiteAnswers, push: Push): void {
  if (a.shoreExposure === 'exposed' && a.erosionScarps) {
    push(
      'exposed_eroding',
      'blocker',
      'The shore is exposed to waves and eroding. Seedlings will wash away.',
    )
  } else if (a.shoreExposure === 'exposed') {
    push(
      'exposed',
      'fix',
      'The shore is exposed to waves. Mangroves need calm water, so get expert advice on shelter first.',
    )
  } else if (a.erosionScarps) {
    push(
      'erosion',
      'check',
      'Small mud cliffs at the edge mean erosion. Find out why before planting.',
    )
  }
  if (a.substrate === 'sand') {
    push(
      'sandy',
      'check',
      'Sand shifts and drains fast, and only a few species cope with it. Ask an expert which ones.',
    )
  } else if (a.substrate === 'salt_crust') {
    push(
      'hypersaline',
      'check',
      'A salt crust means very salty ground. Check salinity with an expert before planting.',
    )
  }
  if (a.nearestMangroves === 'none_known') {
    push(
      'no_reference',
      'check',
      'No natural mangroves nearby means no seed source and nothing to compare with. Ask an expert to confirm the site.',
    )
  }
  if ((a.nearbyCanopyImpact ?? 0) >= 4) {
    push(
      'nearby_impacted',
      'info',
      'The nearest mangroves are heavily damaged. The same pressures may reach this site.',
    )
  }
}

function hydrologyRules(
  a: SiteAnswers,
  h: HydrologySummary | null | undefined,
  push: Push,
): void {
  const sat = (code: string, severity: ReasonSeverity, message: string) =>
    push(code, severity, message, 'satellite')
  if (!h) {
    sat(
      'satellite_pending',
      'info',
      'The satellite tide check has not run yet.',
    )
    return
  }
  const confident = h.confidence !== 'low'
  switch (h.hydrologyClass) {
    case 'permanently_wet':
      sat(
        'sat_permanently_wet',
        confident ? 'blocker' : 'check',
        'Satellite images show this spot under water almost every time. It is too low for mangroves.',
      )
      break
    case 'too_low':
      sat(
        'sat_too_low',
        confident ? 'blocker' : 'check',
        'Satellite images show this spot wet more often than the edge where nearby mangroves stop growing. It is likely too low.',
      )
      break
    case 'borderline_low':
      sat(
        'sat_borderline_low',
        'check',
        'This spot is at the low edge of where mangroves grow nearby. Only seaward species may survive. Confirm with a high-tide photo.',
      )
      break
    case 'in_range':
      sat(
        'sat_in_range',
        'good',
        'Satellite images show the tide covering this spot about as often as where nearby mangroves grow.',
      )
      break
    case 'rarely_wet':
      sat(
        'sat_rarely_wet',
        a.tideReach === 'daily' ? 'check' : 'info',
        'Satellite images rarely show water here. It may be the upper tidal zone, or above the tide. A high-tide photo will tell.',
      )
      break
    case 'existing_mangrove':
      if (!a.currentCover || a.currentCover === 'healthy_mangrove') {
        sat(
          'sat_existing_forest',
          'protect',
          'Satellite land-cover maps show mangrove forest here already.',
        )
      } else {
        sat(
          'sat_forest_mismatch',
          'check',
          'Land-cover maps from 2021 show mangrove forest here. If it was cleared since, say so in the notes. Verifiers will compare with your photos.',
        )
      }
      break
    case 'insufficient_data':
      sat(
        'sat_no_data',
        'info',
        'Too few clear satellite images to judge the tides here. Verifiers will rely on your photos.',
      )
      break
  }
}

function pickZone(
  a: SiteAnswers,
  h: HydrologySummary | null | undefined,
): PlantingZone | null {
  if (a.tideReach === 'spring_tides_only' || a.depthVsReference === 'shallower')
    return 'landward'
  if (h?.hydrologyClass === 'rarely_wet') return 'landward'
  if (h?.hydrologyClass === 'borderline_low') return 'seaward'
  const wf = h?.medianWetFraction
  const ref = h?.referenceP50
  if (h?.hydrologyClass === 'in_range' && wf != null && ref != null) {
    return wf >= ref ? 'seaward' : 'middle'
  }
  if (a.tideReach === 'daily') return 'middle'
  return null
}

function decide(reasons: VerdictReason[]): VerdictCode {
  const has = (s: ReasonSeverity) => reasons.some(r => r.severity === s)
  if (has('protect')) return 'let_regrow'
  if (has('blocker')) return 'not_suitable'
  if (has('regrow')) return 'let_regrow'
  if (has('fix') || has('check')) return 'fix_first'
  return 'plant'
}

/** Pure: same input, same verdict, on the server and on the phone. */
export function computeSiteVerdict(input: VerdictInput): SiteVerdict {
  const { answers: a, hydrology: h, countryCode } = input
  const reasons: VerdictReason[] = []
  const push: Push = (code, severity, message, source = 'field') =>
    reasons.push({ code, severity, source, message })

  coverAndHistoryRules(a, push)
  tideRules(a, push)
  flowAndCauseRules(a, push)
  regrowthRules(a, push)
  shoreAndGroundRules(a, push)
  hydrologyRules(a, h, push)

  const code = decide(reasons)
  const zone = code === 'plant' || code === 'fix_first' ? pickZone(a, h) : null
  const species = zone ? speciesFor(zone, countryCode).map(s => s.id) : []
  if (code === 'plant' && species.length >= 3) {
    push(
      'mix_species',
      'info',
      'Plant a mix of at least three of the recommended species. Single-species stands are weaker.',
    )
  }
  return {
    code,
    headline: HEADLINES[code],
    reasons,
    needsFieldCheck: reasons.some(r => r.severity === 'check'),
    recommendedZone: zone,
    recommendedSpeciesIds: species,
    hydrologyConsidered: !!h && h.hydrologyClass !== 'insufficient_data',
    rulesVersion: SITE_RULES_VERSION,
  }
}
