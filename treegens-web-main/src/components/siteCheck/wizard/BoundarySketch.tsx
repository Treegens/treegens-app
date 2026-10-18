'use client'

import { type LonLat, toLocalMeters } from '@/utils/geo'

const SIZE = 160
const PAD = 12

type Props = { ring?: LonLat[]; radiusM?: number }

/** Small drawing of the walked shape (or the circle) so the planter can see it. */
export function BoundarySketch({ ring = [], radiusM }: Props) {
  if (radiusM) {
    return (
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="mx-auto h-32 w-32"
        aria-hidden
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={SIZE / 2 - PAD}
          className="fill-[#E8F7ED] stroke-tree-green-2"
          strokeWidth={3}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={5}
          className="fill-tree-green-2"
        />
        <text
          x={SIZE / 2}
          y={SIZE / 2 + 24}
          textAnchor="middle"
          className="fill-gray-700 text-[14px] font-semibold"
        >
          {radiusM} m
        </text>
      </svg>
    )
  }
  if (ring.length < 2) return null
  const pts = toLocalMeters(ring)
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  const minX = Math.min(...xs)
  const maxY = Math.max(...ys)
  const span = Math.max(Math.max(...xs) - minX, maxY - Math.min(...ys), 1)
  const scale = (SIZE - 2 * PAD) / span
  const svgPts = pts.map(([x, y]) => [
    PAD + (x - minX) * scale,
    PAD + (maxY - y) * scale,
  ])
  const path = svgPts
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="mx-auto h-32 w-32"
      aria-hidden
    >
      {svgPts.length >= 3 ? (
        <polygon
          points={path}
          className="fill-[#E8F7ED] stroke-tree-green-2"
          strokeWidth={3}
          strokeLinejoin="round"
        />
      ) : (
        <polyline
          points={path}
          className="fill-none stroke-tree-green-2"
          strokeWidth={3}
        />
      )}
      {svgPts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={4} className="fill-tree-green-2" />
      ))}
    </svg>
  )
}
