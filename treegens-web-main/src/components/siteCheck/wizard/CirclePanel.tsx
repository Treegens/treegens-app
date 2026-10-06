'use client'

import { type Dispatch, type SetStateAction, useEffect } from 'react'
import { HiArrowPath } from 'react-icons/hi2'
import { ChoiceChip } from '@/components/siteCheck/ChoiceChip'
import { useBoundaryWalk } from '@/hooks/useBoundaryWalk'
import {
  CIRCLE_MAX_ACCURACY_M,
  formAreaM2,
  RADIUS_CHOICES_M,
  type SiteForm,
} from '@/modules/siteCheck/siteForm'
import { formatArea } from '@/utils/geo'
import { BoundarySketch } from './BoundarySketch'
import { GpsAccuracy } from './GpsAccuracy'

type Props = {
  form: SiteForm
  setForm: Dispatch<SetStateAction<SiteForm>>
}

function positionText(
  center: SiteForm['center'],
  watching: boolean,
  accuracy: number | null,
) {
  if (center) {
    return `${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`
  }
  if (!watching) return 'No position yet'
  if (accuracy != null && accuracy > CIRCLE_MAX_ACCURACY_M) {
    return `Waiting for a better GPS fix (±${Math.round(accuracy)} m)…`
  }
  return 'Getting your position…'
}

/** Marks the site as a circle around the planter's current position. */
export function CirclePanel({ form, setForm }: Props) {
  // Keeps listening until a fix is good enough: a first, coarse fix can
  // be hundreds of metres off and would put the circle somewhere else.
  const gps = useBoundaryWalk(fix => {
    if (fix.accuracy > CIRCLE_MAX_ACCURACY_M) return
    setForm(f => ({
      ...f,
      center: { latitude: fix.latitude, longitude: fix.longitude },
    }))
    gps.stop()
  })
  const { watching, lastFix, error, start } = gps
  const accuracy = lastFix?.accuracy ?? null

  // A resumed draft keeps its saved centre until the planter asks again.
  useEffect(() => {
    if (!form.center) start()
  }, [])

  const center = form.center
  const weak = watching && accuracy != null && accuracy > CIRCLE_MAX_ACCURACY_M
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-700">
        Stand in the middle of the site. Then choose how far it reaches.
      </p>
      <div className="flex flex-row items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-500">Middle of the site</p>
          <p className="text-sm font-medium text-gray-900">
            {positionText(center, watching, accuracy)}
          </p>
        </div>
        <GpsAccuracy accuracy={accuracy} />
        <button
          type="button"
          onClick={start}
          className="shrink-0 rounded-full bg-gray-100 p-3 text-tree-green-2 hover:bg-gray-200"
          aria-label="Use my position now"
        >
          <HiArrowPath
            className={watching ? 'h-5 w-5 animate-spin' : 'h-5 w-5'}
          />
        </button>
      </div>
      {weak ? (
        <p className="text-xs text-amber-800">
          Weak GPS. Stand still in the open for a moment, away from trees and
          buildings.
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <p className="text-sm font-semibold text-gray-800">
        How far is it from you to the edge?
      </p>
      <div className="grid grid-cols-2 gap-2">
        {RADIUS_CHOICES_M.map(r => (
          <ChoiceChip
            key={r}
            selected={form.radiusM === r}
            onClick={() => setForm(f => ({ ...f, radiusM: r }))}
          >
            {r} m
          </ChoiceChip>
        ))}
      </div>
      <BoundarySketch radiusM={form.radiusM} />
      <p className="text-center text-xs text-gray-500">
        Area: {formatArea(formAreaM2(form))}
      </p>
    </div>
  )
}
