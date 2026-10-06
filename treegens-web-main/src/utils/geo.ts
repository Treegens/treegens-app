/** [longitude, latitude], GeoJSON order (same as the backend's geo.ts). */
export type LonLat = [number, number]

const EARTH_RADIUS_M = 6_371_008.8
const toRad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance between two GPS points, in metres. */
export function distanceM(a: LonLat, b: LonLat): number {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Points as [east, north] metres from the first one, on a flat projection.
 * Accurate enough for sites up to about 50 ha.
 */
export function toLocalMeters(ring: LonLat[]): [number, number][] {
  if (!ring.length) return []
  const [lon0, lat0] = ring[0]
  const kx = EARTH_RADIUS_M * Math.cos(toRad(lat0))
  return ring.map(([lon, lat]) => [
    toRad(lon - lon0) * kx,
    toRad(lat - lat0) * EARTH_RADIUS_M,
  ])
}

/** Area of a ring (open or closed) in square metres. */
export function ringAreaM2(ring: LonLat[]): number {
  if (ring.length < 3) return 0
  const points = toLocalMeters(ring)
  let twiceArea = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    twiceArea += x1 * y2 - x2 * y1
  }
  return Math.abs(twiceArea) / 2
}

function samePoint(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** The ring without repeated consecutive points or a closing point. */
function dedupeRing(ring: LonLat[]): LonLat[] {
  const out: LonLat[] = []
  for (const p of ring) {
    if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p)
  }
  while (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop()
  return out
}

type Xy = [number, number]

function orientation(p: Xy, q: Xy, r: Xy): number {
  const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
  return v > 0 ? 1 : v < 0 ? -1 : 0
}

/** Proper crossing of segments p1-p2 and q1-q2 (shared ends do not count). */
function segmentsCross(p1: Xy, p2: Xy, q1: Xy, q2: Xy): boolean {
  return (
    orientation(p1, p2, q1) * orientation(p1, p2, q2) < 0 &&
    orientation(q1, q2, p1) * orientation(q1, q2, p2) < 0
  )
}

/** True when two non-adjacent edges of the closed ring cross each other. */
function selfIntersects(points: Xy[]): boolean {
  const n = points.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a1 = points[i]
      const a2 = points[(i + 1) % n]
      if (segmentsCross(a1, a2, points[j], points[(j + 1) % n])) return true
    }
  }
  return false
}

/**
 * The API's boundary test (backend utils/geo.ts isValidRing): at least three
 * distinct points, all real coordinates, some area, no point visited twice
 * and no edges crossing. The API answers 'Invalid site boundary' otherwise.
 */
export function isValidRing(ring: LonLat[]): boolean {
  const real = ring.every(
    ([lon, lat]) =>
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90,
  )
  if (!real) return false
  const open = dedupeRing(ring)
  const distinct = new Set(open.map(p => `${p[0]},${p[1]}`))
  if (open.length < 3 || distinct.size !== open.length) return false
  return ringAreaM2(open) > 1e-6 && !selfIntersects(toLocalMeters(open))
}

/** "850 m²" below a hectare, "1.2 ha" above. */
export function formatArea(areaM2: number): string {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return '0 m²'
  if (areaM2 < 10_000) return `${Math.round(areaM2).toLocaleString()} m²`
  return `${(areaM2 / 10_000).toFixed(1)} ha`
}

/** "40 m" below a kilometre, "1.3 km" above. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return ''
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}
