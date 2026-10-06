'use client'

import { type Dispatch, type SetStateAction, useEffect } from 'react'
import { HiArrowPath } from 'react-icons/hi2'
import { ChoiceChip } from '@/components/siteCheck/ChoiceChip'
import { useGeolocation } from '@/hooks/useGeolocation'
import {
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

/** Marks the site as a circle around the planter's current position. */
export function CirclePanel({ form, setForm }: Props) {
  const {
    latitude,
    longitude,
    accuracy,
    loading,
    error,
    getCurrentPosition,
    isSupported,
  } = useGeolocation({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  })

  // A resumed draft keeps its saved centre until the planter asks again.
  useEffect(() => {
    if (isSupported && !form.center) getCurrentPosition()
  }, [isSupported])

  useEffect(() => {
    if (latitude === null || longitude === null) return
    setForm(f => ({ ...f, center: { latitude, longitude } }))
  }, [latitude, longitude, setForm])

  const center = form.center
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-700">
        Stand in the middle of the site. Then choose how far it reaches.
      </p>
      <div className="flex flex-row items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-500">Middle of the site</p>
          <p className="text-sm font-medium text-gray-900">
            {center
              ? `${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`
              : loading
                ? 'Getting your position…'
                : 'No position yet'}
          </p>
        </div>
        <GpsAccuracy accuracy={accuracy} />
        <button
          type="button"
          onClick={getCurrentPosition}
          className="shrink-0 rounded-full bg-gray-100 p-3 text-tree-green-2 hover:bg-gray-200"
          aria-label="Use my position now"
        >
          <HiArrowPath
            className={loading ? 'h-5 w-5 animate-spin' : 'h-5 w-5'}
          />
        </button>
      </div>
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
