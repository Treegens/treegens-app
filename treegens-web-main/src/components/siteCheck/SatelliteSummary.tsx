'use client'

import cn from 'classnames'
import { HiGlobeAlt } from 'react-icons/hi2'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import {
  HYDROLOGY_CLASS_STYLES,
  HYDROLOGY_STATUS_LABELS,
  TONE_CLASSES,
} from '@/modules/siteCheck/verdictStyle'
import type { IHydrologyResult, ISiteHydrology } from '@/types'
import { formatDistance } from '@/utils/geo'

type Props = {
  hydrology?: ISiteHydrology | null
  onRecheck?: () => void
  rechecking?: boolean
}

const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000

const SKIP_REASONS: Record<string, string> = {
  disabled: 'The satellite check is turned off on this server.',
}

const CONFIDENCE_LABELS = { low: 'Low', medium: 'Medium', high: 'High' }

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

function monthLabel(date: string | null) {
  if (!date) return ''
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return date
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

/** Same rule as the API: after a failure or skip, or a month after success. */
export function canRecheckHydrology(hydrology?: ISiteHydrology | null) {
  if (!hydrology) return false
  if (hydrology.status === 'failed' || hydrology.status === 'skipped') {
    return true
  }
  if (hydrology.status !== 'completed' || !hydrology.completedAt) return false
  return (
    Date.now() - new Date(hydrology.completedAt).getTime() > RECHECK_AFTER_MS
  )
}

/** What the reference band stands for: local mangroves or the default. */
function referenceText(reference: IHydrologyResult['reference']) {
  const local = reference.source === 'local'
  return {
    band: local ? 'Edge of nearby mangroves' : 'Typical mangrove edge',
    stops: local ? 'Nearby mangroves stop' : 'A typical mangrove edge stops',
    comparedWith: local
      ? `${reference.edgePixelCount.toLocaleString()} spots next to nearby mangroves`
      : reference.nearestMangroveM == null
        ? 'A standard Kenyan reference (no mapped mangroves nearby)'
        : 'A standard Kenyan reference (too little wet edge next to the mapped mangroves)',
  }
}

/** 0 to 100% wet: a band for the reference mangrove edge, a pin for the site. */
function WetnessBar({ result }: { result: IHydrologyResult }) {
  const { p25, p90 } = result.reference
  const site = result.site.medianWetFraction
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-3 w-full rounded-full bg-gradient-to-r from-amber-100 via-sky-100 to-sky-300">
        <div
          className="absolute inset-y-0 rounded-full bg-green-500/60"
          style={{ left: pct(p25), width: pct(Math.max(0, p90 - p25)) }}
        />
        {site != null ? (
          <div
            className="absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded-full bg-gray-900"
            style={{ left: pct(Math.min(1, Math.max(0, site))) }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex flex-row justify-between text-[11px] text-gray-500">
        <span>Never wet</span>
        <span>Always wet</span>
      </div>
      <div className="mt-1 flex flex-row flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-4 rounded-full bg-green-500/60" />
          {referenceText(result.reference).band}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-1.5 rounded-full bg-gray-900" />
          This site
        </span>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-row justify-between gap-3 border-t border-gray-100 py-2 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  )
}

function ResultView({ result }: { result: IHydrologyResult }) {
  const style = HYDROLOGY_CLASS_STYLES[result.hydrologyClass]
  const wet = result.site.medianWetFraction
  const { reference, imagery } = result
  const text = referenceText(reference)
  return (
    <div className="mt-3">
      <span
        className={cn(
          'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold',
          TONE_CLASSES[style.tone].chip,
        )}
      >
        {style.label}
      </span>
      {wet != null ? (
        <p className="mt-2 text-sm text-gray-800">
          Wet in {pct(wet)} of clear images. {text.stops} at about{' '}
          {pct(reference.p75)}.
        </p>
      ) : null}
      <WetnessBar result={result} />
      <dl className="mt-3">
        <Fact label="Compared with" value={text.comparedWith} />
        <Fact
          label="Images used"
          value={`${imagery.scenesUsed} clear images, ${monthLabel(imagery.firstSceneDate)} to ${monthLabel(imagery.lastSceneDate)}`}
        />
        <Fact
          label="Nearest mapped mangroves"
          value={
            reference.nearestMangroveM != null
              ? formatDistance(reference.nearestMangroveM)
              : 'None found nearby'
          }
        />
        <Fact label="Confidence" value={CONFIDENCE_LABELS[result.confidence]} />
      </dl>
      {result.notes.length ? (
        <details className="mt-2 text-xs text-gray-500">
          <summary className="cursor-pointer py-1">Technical notes</summary>
          <ul className="list-disc pl-5">
            {result.notes.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

function StatusBody({ hydrology }: { hydrology?: ISiteHydrology | null }) {
  const status = hydrology?.status ?? 'not_started'
  if (status === 'completed' && hydrology?.result) {
    return <ResultView result={hydrology.result} />
  }
  if (status === 'failed') {
    return (
      <div className="mt-3 text-sm text-gray-800">
        <p>The satellite check did not finish.</p>
        {hydrology?.lastError ? (
          <p className="mt-1 break-words text-xs text-gray-500">
            {hydrology.lastError}
          </p>
        ) : null}
      </div>
    )
  }
  if (status === 'skipped') {
    const reason = hydrology?.skipReason ?? ''
    const fallback = reason
      ? `The satellite check was skipped (${reason}).`
      : 'The satellite check was skipped.'
    return (
      <p className="mt-3 text-sm text-gray-800">
        {SKIP_REASONS[reason] ?? fallback}
      </p>
    )
  }
  return (
    <div className="mt-3 flex flex-row items-center gap-3">
      <Spinner size="sm" />
      <p className="text-sm text-gray-800">
        {status === 'processing'
          ? 'Looking at two years of satellite images of this place.'
          : 'Waiting for its turn.'}{' '}
        This takes a minute or two.
      </p>
    </div>
  )
}

export function SatelliteSummary({ hydrology, onRecheck, rechecking }: Props) {
  const status = hydrology?.status ?? 'not_started'
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="flex flex-row items-center justify-between gap-2">
        <h3 className="flex flex-row items-center gap-2 text-base font-bold text-gray-900">
          <HiGlobeAlt className="h-5 w-5 text-tree-green-2" aria-hidden />
          Satellite tide check
        </h3>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
          {HYDROLOGY_STATUS_LABELS[status]}
        </span>
      </div>
      <StatusBody hydrology={hydrology} />
      {onRecheck && canRecheckHydrology(hydrology) ? (
        <Button
          size="sm"
          outline
          color="green"
          className="mt-3 w-full rounded-xl py-2.5"
          disabled={rechecking}
          onClick={onRecheck}
        >
          {rechecking
            ? 'Starting…'
            : status === 'failed'
              ? 'Try again'
              : 'Run the check again'}
        </Button>
      ) : null}
    </section>
  )
}
