'use client'

import cn from 'classnames'
import type { Dispatch, SetStateAction } from 'react'
import toast from 'react-hot-toast'
import type { IconType } from 'react-icons'
import { IoLocateOutline, IoWalkOutline } from 'react-icons/io5'
import { useBoundaryWalk } from '@/hooks/useBoundaryWalk'
import {
  appendWalkPoint,
  locationProblem,
  type SiteForm,
  trimWalkOvershoot,
} from '@/modules/siteCheck/siteForm'
import type { SiteBoundaryMethod } from '@/types'
import { CirclePanel } from './CirclePanel'
import { StepNav } from './StepNav'
import { WalkBoundaryPanel } from './WalkBoundaryPanel'

type Props = {
  form: SiteForm
  setForm: Dispatch<SetStateAction<SiteForm>>
  onNext: () => void
}

const METHODS: {
  value: SiteBoundaryMethod
  icon: IconType
  title: string
  text: string
}[] = [
  {
    value: 'walked',
    icon: IoWalkOutline,
    title: 'Walk the boundary',
    text: 'Best. Walk all the way around the site.',
  },
  {
    value: 'pin_radius',
    icon: IoLocateOutline,
    title: 'Circle around me',
    text: 'Quick. Stand in the middle and pick a size.',
  },
]

function MethodChoice({
  value,
  onChange,
}: {
  value: SiteBoundaryMethod | null
  onChange: (method: SiteBoundaryMethod) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {METHODS.map(({ value: method, icon: Icon, title, text }) => (
        <button
          key={method}
          type="button"
          onClick={() => onChange(method)}
          aria-pressed={value === method}
          className={cn(
            'flex flex-col items-start gap-2 rounded-2xl border-2 p-3 text-left transition-colors',
            value === method
              ? 'border-tree-green-2 bg-[#E8F7ED]'
              : 'border-gray-200 bg-white',
          )}
        >
          <Icon className="h-8 w-8 text-tree-green-2" aria-hidden />
          <span className="text-sm font-bold text-gray-900">{title}</span>
          <span className="text-xs text-gray-600">{text}</span>
        </button>
      ))}
    </div>
  )
}

function NameField({ form, setForm }: Omit<Props, 'onNext'>) {
  return (
    <div>
      <label
        htmlFor="siteName"
        className="mb-1.5 block text-sm font-semibold text-gray-800"
      >
        Name of the site
      </label>
      <input
        id="siteName"
        type="text"
        maxLength={80}
        value={form.name}
        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
        placeholder="e.g. Gazi creek, north bank"
        className="h-12 w-full rounded-lg border border-gray-200 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400"
      />
      {form.reverseGeocode ? (
        <p className="mt-1 text-xs text-gray-500">{form.reverseGeocode}</p>
      ) : null}
    </div>
  )
}

/** Step 1: mark the site by walking its edge or as a circle, and name it. */
export function LocationStep({ form, setForm, onNext }: Props) {
  const walk = useBoundaryWalk(fix =>
    setForm(f => ({
      ...f,
      ring: appendWalkPoint(
        f.ring,
        [fix.longitude, fix.latitude],
        fix.accuracy,
      ),
    })),
  )

  const chooseMethod = (method: SiteBoundaryMethod) => {
    walk.stop()
    setForm(f => ({ ...f, boundaryMethod: method }))
  }

  const finishWalk = () => {
    walk.stop()
    // Walking a little past the start makes the path cross itself.
    const ring = trimWalkOvershoot(form.ring)
    if (ring !== form.ring) setForm(f => ({ ...f, ring }))
    toast.success(`Boundary saved with ${ring.length} points`)
  }

  const problem = locationProblem(form)
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-2 text-base font-semibold text-gray-800">
          How do you want to mark the site?
        </p>
        <MethodChoice value={form.boundaryMethod} onChange={chooseMethod} />
      </div>
      {form.boundaryMethod === 'walked' ? (
        <WalkBoundaryPanel
          ring={form.ring}
          walk={walk}
          onFinish={finishWalk}
          onUndo={() => setForm(f => ({ ...f, ring: f.ring.slice(0, -1) }))}
          onClear={() => setForm(f => ({ ...f, ring: [] }))}
        />
      ) : null}
      {form.boundaryMethod === 'pin_radius' ? (
        <CirclePanel form={form} setForm={setForm} />
      ) : null}
      <NameField form={form} setForm={setForm} />
      <StepNav
        onNext={onNext}
        nextDisabled={!!problem || walk.watching}
        hint={
          walk.watching ? 'Tap Finish when you are back at the start.' : problem
        }
      />
    </div>
  )
}
