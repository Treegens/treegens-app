'use client'

import { HiExclamationTriangle, HiWifi } from 'react-icons/hi2'
import { SpeciesList } from '@/components/siteCheck/SpeciesList'
import { VerdictCard } from '@/components/siteCheck/VerdictCard'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { questionFor } from '@/modules/siteCheck/answers'
import { photoTitle } from '@/modules/siteCheck/sendSite'
import { formAreaM2, type SiteForm } from '@/modules/siteCheck/siteForm'
import type { SiteAnswers, SiteVerdict } from '@/modules/siteCheck/siteVerdict'
import type { SitePhotoKind } from '@/types'
import { formatArea } from '@/utils/geo'

type Props = {
  form: SiteForm
  verdict: SiteVerdict
  missingAnswers: (keyof SiteAnswers)[]
  missingPhotos: SitePhotoKind[]
  online: boolean
  sending: boolean
  stage: string
  error: string
  onGoTo: (step: number) => void
  onBack: () => void
  onSaveDraft: () => void
  onSubmit: () => void
}

function SiteSummary({ form, onGoTo }: Pick<Props, 'form' | 'onGoTo'>) {
  const method =
    form.boundaryMethod === 'walked'
      ? `Walked, ${form.ring.length} points`
      : `Circle of ${form.radiusM} m`
  return (
    <section className="flex flex-row items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-4">
      <div className="min-w-0">
        <p className="truncate text-base font-bold text-gray-900">
          {form.name}
        </p>
        <p className="text-sm text-gray-600">
          {formatArea(formAreaM2(form))} · {method}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onGoTo(1)}
        className="min-h-11 shrink-0 px-2 text-sm font-semibold text-tree-green-2"
      >
        Change
      </button>
    </section>
  )
}

function MissingList({
  missingAnswers,
  missingPhotos,
  onGoTo,
}: Pick<Props, 'missingAnswers' | 'missingPhotos' | 'onGoTo'>) {
  if (!missingAnswers.length && !missingPhotos.length) return null
  const item = (key: string, label: string, step: number) => (
    <li key={key}>
      <button
        type="button"
        onClick={() => onGoTo(step)}
        className="min-h-11 w-full text-left text-sm text-amber-950 underline underline-offset-2"
      >
        {label}
      </button>
    </li>
  )
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="flex flex-row items-center gap-2 text-sm font-bold text-amber-950">
        <HiExclamationTriangle className="h-5 w-5" aria-hidden />
        Before you can send for review
      </p>
      <ul className="mt-1">
        {missingAnswers.map(key =>
          item(key, `Answer: ${questionFor(key)?.title ?? key}`, 2),
        )}
        {missingPhotos.map(kind => item(kind, `Photo: ${photoTitle(kind)}`, 3))}
      </ul>
    </section>
  )
}

/** The API's answer when it cannot store the walked boundary. */
const INVALID_BOUNDARY_ERROR = 'Invalid site boundary'

function SendError({ error, onGoTo }: Pick<Props, 'error' | 'onGoTo'>) {
  if (error !== INVALID_BOUNDARY_ERROR) {
    return <p className="text-sm text-red-600">{error}</p>
  }
  return (
    <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p>
        The server could not use this boundary. Most often the walked path
        crosses itself. Go back to the location step and tap &quot;Undo last
        point&quot; or &quot;Start again&quot;.
      </p>
      <button
        type="button"
        onClick={() => onGoTo(1)}
        className="mt-1 min-h-11 font-semibold underline underline-offset-2"
      >
        Fix the boundary
      </button>
    </section>
  )
}

function OfflineNote() {
  return (
    <section className="flex flex-row gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <HiWifi className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <p>
        You are offline. Your answers and location are saved on this phone.
        Connect to the internet to send the site. Photos are not saved, so take
        them again if you close the app.
      </p>
    </section>
  )
}

/** Step 4: verdict, what to plant, what is missing, then send. */
export function ReviewStep(props: Props) {
  const { verdict, online, sending, stage, error } = props
  const incomplete =
    props.missingAnswers.length > 0 || props.missingPhotos.length > 0
  return (
    <div className="flex flex-col gap-4">
      <VerdictCard verdict={verdict} maxReasons={4} />
      <SpeciesList
        zone={verdict.recommendedZone}
        speciesIds={verdict.recommendedSpeciesIds}
      />
      <SiteSummary form={props.form} onGoTo={props.onGoTo} />
      <MissingList {...props} />
      {!online ? <OfflineNote /> : null}
      {error ? <SendError error={error} onGoTo={props.onGoTo} /> : null}
      {sending ? (
        <div className="flex flex-row items-center gap-3 rounded-xl bg-gray-50 px-4 py-3">
          <Spinner size="sm" />
          <p className="text-sm text-gray-700">{stage}</p>
        </div>
      ) : null}
      <div className="mt-2 flex flex-col gap-3">
        <Button
          color="success"
          size="lg"
          className="w-full rounded-2xl"
          disabled={!online || sending || incomplete}
          onClick={props.onSubmit}
        >
          Send for review
        </Button>
        <Button
          outline
          color="green"
          className="w-full rounded-2xl py-3"
          disabled={!online || sending}
          onClick={props.onSaveDraft}
        >
          Save draft, send later
        </Button>
        <Button
          outline
          color="gray"
          className="w-full rounded-2xl py-3"
          disabled={sending}
          onClick={props.onBack}
        >
          Back
        </Button>
      </div>
    </div>
  )
}
