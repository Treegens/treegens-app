import { geoGraticule10, geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from 'd3-geo'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { feature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import world from 'world-atlas/land-110m.json'
import type { MapPoint } from '../lib/api'
import { formatDate, formatInt } from '../lib/format'
import { Tooltip } from './ui/Bits'

const W = 1000
const H = 520

const LAND = feature(
  world as unknown as Topology,
  (world as unknown as Topology).objects.land as GeometryCollection,
) as unknown as GeoPermissibleObjects

export function ImpactMap({ points, onOpenPlanting }: { points: MapPoint[]; onOpenPlanting: (id: string) => void }) {
  const [focus, setFocus] = useState(false)
  const [hover, setHover] = useState<{ p: MapPoint; x: number; y: number } | null>(null)
  const ref = useRef<SVGSVGElement | null>(null)

  const projection = useMemo(() => {
    const proj = geoNaturalEarth1()
    if (focus && points.length) {
      const lats = points.map(p => p.lat)
      const lngs = points.map(p => p.lng)
      const pad = 12
      const minLat = Math.max(-85, Math.min(...lats) - pad)
      const maxLat = Math.min(85, Math.max(...lats) + pad)
      const minLng = Math.max(-180, Math.min(...lngs) - pad * 1.5)
      const maxLng = Math.min(180, Math.max(...lngs) + pad * 1.5)
      const box = {
        type: 'Polygon' as const,
        coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]],
      }
      proj.fitExtent([[24, 24], [W - 24, H - 24]], box)
    } else {
      proj.fitExtent([[10, 10], [W - 10, H - 10]], { type: 'Sphere' })
    }
    return proj
  }, [focus, points])

  const path = useMemo(() => geoPath(projection), [projection])
  const landD = useMemo(() => path(LAND) || '', [path])
  const gratD = useMemo(() => path(geoGraticule10()) || '', [path])
  const sphereD = useMemo(() => path({ type: 'Sphere' }) || '', [path])
  const maxTrees = Math.max(1, ...points.map(p => p.trees))

  useEffect(() => {
    setHover(null)
  }, [focus])

  const onMove = (p: MapPoint) => (e: MouseEvent) => setHover({ p, x: e.clientX, y: e.clientY })

  return (
    <div className="tg-card overflow-hidden" style={{ background: 'var(--chart-surface)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <p className="text-sm text-ink-2">
          <strong className="text-ink">{formatInt(points.length)}</strong> verified plantings with GPS · dot size = trees · filled = funded
        </p>
        <div className="flex gap-1" role="group" aria-label="Map extent">
          <button type="button" className="tg-chip" data-active={!focus} onClick={() => setFocus(false)}>
            World
          </button>
          <button type="button" className="tg-chip" data-active={focus} onClick={() => setFocus(true)} disabled={!points.length}>
            Zoom to plantings
          </button>
        </div>
      </div>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="World map of verified tree plantings">
        <path d={sphereD} fill="var(--surface-2)" stroke="var(--hairline)" />
        <path d={gratD} fill="none" stroke="var(--hairline)" strokeWidth={0.5} />
        <path d={landD} fill="var(--surface-3)" stroke="var(--hairline-strong)" strokeWidth={0.6} />
        <g onMouseLeave={() => setHover(null)}>
          {points.map(p => {
            const xy = projection([p.lng, p.lat])
            if (!xy) return null
            const r = 4 + 10 * Math.sqrt(p.trees / maxTrees)
            return (
              <g key={p.id} transform={`translate(${xy[0].toFixed(1)} ${xy[1].toFixed(1)})`} className="cursor-pointer" onMouseMove={onMove(p)} onMouseEnter={onMove(p)} onClick={() => onOpenPlanting(p.id)} role="button" tabIndex={0} aria-label={`${p.trees} trees in ${p.location}. Open planting.`} onKeyDown={e => e.key === 'Enter' && onOpenPlanting(p.id)}>
                <circle r={r} fill="var(--s-update)" opacity={0.35} className="tg-map-pulse" />
                <circle r={r} fill={p.funded ? 'var(--s-update)' : 'var(--chart-surface)'} stroke="var(--s-update)" strokeWidth={2} opacity={0.95} />
                <circle r={Math.max(14, r + 6)} fill="transparent" />
              </g>
            )
          })}
        </g>
      </svg>
      {hover ? (
        <Tooltip x={hover.x} y={hover.y}>
          <strong>{hover.p.location || 'Verified planting'}</strong>
          <div className="mt-1 text-sm font-bold text-ink">
            {formatInt(hover.p.trees)} {/mangrove/i.test(hover.p.species) ? 'mangroves' : 'trees'}
          </div>
          <div className="mt-0.5">
            {hover.p.species ? `${hover.p.species} · ` : ''}
            {hover.p.funded ? 'funded' : 'open to fund'} · verified {formatDate(hover.p.approvedAt)}
          </div>
          <div className="mt-1 text-ink-3">
            {hover.p.lat.toFixed(4)}, {hover.p.lng.toFixed(4)} · click for videos and proof
          </div>
        </Tooltip>
      ) : null}
    </div>
  )
}
