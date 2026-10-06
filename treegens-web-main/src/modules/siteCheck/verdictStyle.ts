/**
 * How Site Check results look: colours, short labels and icons for verdict
 * codes, reason severities, satellite classes and site statuses.
 */
import type { IconType } from 'react-icons'
import {
  HiCheckCircle,
  HiExclamationTriangle,
  HiInformationCircle,
  HiMagnifyingGlass,
  HiNoSymbol,
  HiShieldCheck,
  HiWrenchScrewdriver,
} from 'react-icons/hi2'
import { IoLeafOutline } from 'react-icons/io5'
import type { SiteHydrologyStatus, SiteStatus } from '@/types'
import type { PlantingZone } from './mangroveSpecies'
import type { HydrologyClass, ReasonSeverity, VerdictCode } from './siteVerdict'

export type Tone = 'green' | 'amber' | 'blue' | 'red' | 'gray'

/** Tailwind classes per tone: soft card, chip, solid icon disc, ink. */
export const TONE_CLASSES: Record<
  Tone,
  { card: string; chip: string; disc: string; text: string }
> = {
  green: {
    card: 'border-green-300 bg-green-50',
    chip: 'border-green-300 bg-green-100 text-green-900',
    disc: 'bg-green-600 text-white',
    text: 'text-green-900',
  },
  amber: {
    card: 'border-amber-300 bg-amber-50',
    chip: 'border-amber-300 bg-amber-100 text-amber-900',
    disc: 'bg-amber-500 text-white',
    text: 'text-amber-950',
  },
  blue: {
    card: 'border-sky-300 bg-sky-50',
    chip: 'border-sky-300 bg-sky-100 text-sky-900',
    disc: 'bg-sky-600 text-white',
    text: 'text-sky-950',
  },
  red: {
    card: 'border-red-300 bg-red-50',
    chip: 'border-red-300 bg-red-100 text-red-900',
    disc: 'bg-red-600 text-white',
    text: 'text-red-950',
  },
  gray: {
    card: 'border-gray-200 bg-gray-50',
    chip: 'border-gray-200 bg-gray-100 text-gray-700',
    disc: 'bg-gray-500 text-white',
    text: 'text-gray-800',
  },
}

export const VERDICT_STYLES: Record<
  VerdictCode,
  { label: string; tone: Tone; icon: IconType }
> = {
  plant: { label: 'Plant here', tone: 'green', icon: IoLeafOutline },
  fix_first: { label: 'Fix first', tone: 'amber', icon: HiWrenchScrewdriver },
  let_regrow: { label: 'Let it regrow', tone: 'blue', icon: HiShieldCheck },
  not_suitable: { label: 'Not suitable', tone: 'red', icon: HiNoSymbol },
}

/** Most serious first; the verdict follows the same precedence. */
export const SEVERITY_ORDER: ReasonSeverity[] = [
  'protect',
  'blocker',
  'regrow',
  'fix',
  'check',
  'good',
  'info',
]

export const SEVERITY_STYLES: Record<
  ReasonSeverity,
  { label: string; tone: Tone; icon: IconType }
> = {
  protect: { label: 'Protect', tone: 'blue', icon: HiShieldCheck },
  blocker: { label: 'Stop', tone: 'red', icon: HiNoSymbol },
  regrow: { label: 'Regrowing', tone: 'blue', icon: IoLeafOutline },
  fix: { label: 'Fix first', tone: 'amber', icon: HiWrenchScrewdriver },
  check: { label: 'Check', tone: 'amber', icon: HiMagnifyingGlass },
  good: { label: 'Good', tone: 'green', icon: HiCheckCircle },
  info: { label: 'Good to know', tone: 'gray', icon: HiInformationCircle },
}

export const REASON_SOURCE_LABELS = {
  field: 'Field',
  satellite: 'Satellite',
} as const

export const ZONE_LABELS: Record<
  PlantingZone,
  { label: string; help: string }
> = {
  seaward: {
    label: 'Seaward edge',
    help: 'The low, wet edge that faces the sea.',
  },
  middle: {
    label: 'Middle zone',
    help: 'Between the sea edge and the land edge.',
  },
  landward: {
    label: 'Landward edge',
    help: 'The high edge that only the biggest tides reach.',
  },
}

export const HYDROLOGY_CLASS_STYLES: Record<
  HydrologyClass,
  { label: string; tone: Tone }
> = {
  in_range: { label: 'Tide looks right', tone: 'green' },
  borderline_low: { label: 'At the low edge', tone: 'amber' },
  too_low: { label: 'Too wet, too low', tone: 'red' },
  permanently_wet: { label: 'Always under water', tone: 'red' },
  rarely_wet: { label: 'Rarely wet', tone: 'amber' },
  existing_mangrove: { label: 'Already mangrove forest', tone: 'blue' },
  insufficient_data: { label: 'Not enough clear images', tone: 'gray' },
}

export const HYDROLOGY_STATUS_LABELS: Record<SiteHydrologyStatus, string> = {
  not_started: 'Waiting',
  queued: 'Waiting',
  processing: 'Checking',
  completed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

export const SITE_STATUS_STYLES: Record<
  SiteStatus,
  { label: string; tone: Tone; icon: IconType }
> = {
  draft: { label: 'Draft', tone: 'gray', icon: HiInformationCircle },
  pending_review: {
    label: 'In review',
    tone: 'amber',
    icon: HiExclamationTriangle,
  },
  approved: { label: 'Approved', tone: 'green', icon: HiCheckCircle },
  rejected: { label: 'Not approved', tone: 'red', icon: HiNoSymbol },
}
