'use client'

import { HiStop } from 'react-icons/hi2'
import { IoWalkOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/Button'
import type { useBoundaryWalk } from '@/hooks/useBoundaryWalk'
import {
  MIN_WALK_POINTS,
  WALK_MAX_ACCURACY_M,
} from '@/modules/siteCheck/siteForm'
import { formatArea, type LonLat, ringAreaM2 } from '@/utils/geo'
import { BoundarySketch } from './BoundarySketch'
import { GpsAccuracy } from './GpsAccuracy'

type Props = {
  ring: LonLat[]
  walk: ReturnType<typeof useBoundaryWalk>
  onFinish: () => void
  onUndo: () => void
  onClear: () => void
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#f7fbf3] px-2 py-2.5 text-center">
      <p className="text-lg font-bold text-tree-green-2">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}

function WalkButtons({ ring, walk, onFinish, onUndo, onClear }: Props) {
  if (walk.watching) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Button
          outline
          color="gray"
          size="lg"
          className="rounded-2xl"
          onClick={walk.stop}
        >
          <HiStop className="h-5 w-5" aria-hidden />
          Stop
        </Button>
        <Button
          color="success"
          size="lg"
          className="rounded-2xl"
          disabled={ring.length < MIN_WALK_POINTS}
          onClick={onFinish}
        >
          Finish
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        color="success"
        size="lg"
        className="w-full rounded-2xl"
        onClick={walk.start}
      >
        <IoWalkOutline className="h-6 w-6" aria-hidden />
        {ring.length ? 'Keep walking' : 'Start walking'}
      </Button>
      {ring.length ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            outline
            color="gray"
            className="rounded-xl py-2.5"
            onClick={onUndo}
          >
            Undo last point
          </Button>
          <Button
            outline
            color="red"
            className="rounded-xl py-2.5"
            onClick={onClear}
          >
            Start again
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Records the boundary from GPS fixes while the planter walks around the site. */
export function WalkBoundaryPanel(props: Props) {
  const { ring, walk } = props
  const weak = walk.lastFix && walk.lastFix.accuracy > WALK_MAX_ACCURACY_M
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-700">
        Walk slowly along the edge of the site, all the way around. A point is
        saved every 5 m while the GPS is good.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Points" value={String(ring.length)} />
        <Stat label="Area" value={formatArea(ringAreaM2(ring))} />
      </div>
      {walk.watching ? (
        <div className="flex flex-row items-center gap-2">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
          <span className="text-sm font-medium text-gray-800">Recording</span>
          <GpsAccuracy accuracy={walk.lastFix?.accuracy ?? null} />
        </div>
      ) : null}
      {weak ? (
        <p className="text-xs text-amber-800">
          Weak GPS. Wait a moment, or move away from trees and buildings.
        </p>
      ) : null}
      {walk.error ? <p className="text-sm text-red-600">{walk.error}</p> : null}
      <BoundarySketch ring={ring} />
      <WalkButtons {...props} />
    </div>
  )
}
