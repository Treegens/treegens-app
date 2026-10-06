const EARTH_RADIUS_M = 6_371_000

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Great-circle distance in meters (WGS84 sphere). */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_M * c
}

/** A [longitude, latitude] pair, GeoJSON order. */
export type LonLat = [number, number]

type Xy = { x: number; y: number }

const M_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_M

function samePoint(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** The ring without repeated consecutive vertices or a closing vertex. */
function openRing(ring: LonLat[]): LonLat[] {
  const out: LonLat[] = []
  for (const p of ring) {
    if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p)
  }
  while (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop()
  return out
}

/**
 * The ring with its first vertex repeated at the end (GeoJSON style) and
 * repeated consecutive vertices (a GPS fix taken twice) dropped.
 */
export function closeRing(ring: LonLat[]): LonLat[] {
  const open = openRing(ring)
  return open.length ? [...open, open[0]] : []
}

/**
 * Local equirectangular projection to metres around an origin. Accurate
 * enough for sites of a few hundred metres, the only scale used here.
 */
function projector(originLat: number, originLon: number) {
  const cosLat = Math.cos(toRad(originLat))
  return ([lon, lat]: LonLat): Xy => {
    const dLon = ((((lon - originLon) % 360) + 540) % 360) - 180
    return { x: dLon * cosLat * M_PER_DEG, y: (lat - originLat) * M_PER_DEG }
  }
}

function vertexMean(ring: LonLat[]): { latitude: number; longitude: number } {
  const open = openRing(ring)
  const n = open.length || 1
  return {
    latitude: open.reduce((s, p) => s + p[1], 0) / n,
    longitude: open.reduce((s, p) => s + p[0], 0) / n,
  }
}

/** Ring vertices in metres around their own mean, ready for planar maths. */
function projectRing(ring: LonLat[]): { points: Xy[]; origin: LonLat } {
  const { latitude, longitude } = vertexMean(ring)
  const project = projector(latitude, longitude)
  return { points: openRing(ring).map(project), origin: [longitude, latitude] }
}

/** Twice the signed planar area (shoelace). */
function doubleSignedArea(points: Xy[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum
}

/** Area of the ring in square metres. */
export function ringAreaM2(ring: LonLat[]): number {
  return Math.abs(doubleSignedArea(projectRing(ring).points)) / 2
}

/** Area-weighted centroid; the vertex mean when the ring has no area. */
export function ringCentroid(ring: LonLat[]): {
  latitude: number
  longitude: number
} {
  const { points, origin } = projectRing(ring)
  const twiceArea = doubleSignedArea(points)
  if (Math.abs(twiceArea) < 1e-9) return vertexMean(ring)
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const cross = a.x * b.y - b.x * a.y
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  const cosLat = Math.cos(toRad(origin[1]))
  return {
    latitude: origin[1] + cy / (3 * twiceArea) / M_PER_DEG,
    longitude: origin[0] + cx / (3 * twiceArea) / (cosLat * M_PER_DEG),
  }
}

/** Ray casting in metres around the point itself. */
export function pointInRing(lat: number, lon: number, ring: LonLat[]): boolean {
  const points = openRing(ring).map(projector(lat, lon))
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * -a.y) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** Distance from the origin to the segment a-b, in the segment's units. */
function originToSegment(a: Xy, b: Xy): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lenSq))
  return Math.hypot(a.x + t * dx, a.y + t * dy)
}

/** 0 inside the ring, otherwise metres to the nearest edge. */
export function distanceToRingM(
  lat: number,
  lon: number,
  ring: LonLat[],
): number {
  if (pointInRing(lat, lon, ring)) return 0
  const points = openRing(ring).map(projector(lat, lon))
  let best = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = originToSegment(points[i], points[(i + 1) % points.length])
    best = Math.min(best, d)
  }
  return best
}

/** Closed ring approximating a circle of `radiusM` around a point. */
export function circleRing(
  lat: number,
  lon: number,
  radiusM: number,
  segments = 32,
): LonLat[] {
  const cosLat = Math.cos(toRad(lat))
  const ring: LonLat[] = []
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments
    ring.push([
      lon + (radiusM * Math.sin(angle)) / (cosLat * M_PER_DEG),
      lat + (radiusM * Math.cos(angle)) / M_PER_DEG,
    ])
  }
  return closeRing(ring)
}

function orientation(p: Xy, q: Xy, r: Xy): number {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
  return v > 0 ? 1 : v < 0 ? -1 : 0
}

/** Proper crossing of segments p1-p2 and q1-q2 (shared ends do not count). */
function segmentsCross(p1: Xy, p2: Xy, q1: Xy, q2: Xy): boolean {
  return (
    orientation(p1, p2, q1) * orientation(p1, p2, q2) < 0 &&
    orientation(q1, q2, p1) * orientation(q1, q2, p2) < 0
  )
}

/** True when two non-adjacent edges of the ring cross each other. */
function selfIntersects(points: Xy[]): boolean {
  const n = points.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a = [points[i], points[(i + 1) % n]] as const
      const b = [points[j], points[(j + 1) % n]] as const
      if (segmentsCross(a[0], a[1], b[0], b[1])) return true
    }
  }
  return false
}

function isLonLat(p: unknown): p is LonLat {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    p.every(v => typeof v === 'number' && Number.isFinite(v)) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90
  )
}

/**
 * At least three distinct vertices, all real coordinates, some area, and no
 * vertex visited twice or crossing edges (MongoDB's 2dsphere index refuses
 * such polygons).
 */
export function isValidRing(ring: unknown): ring is LonLat[] {
  if (!Array.isArray(ring) || !ring.every(isLonLat)) return false
  const open = openRing(ring)
  const distinct = new Set(open.map(p => `${p[0]},${p[1]}`))
  if (open.length < 3 || distinct.size !== open.length) return false
  const { points } = projectRing(ring)
  return ringAreaM2(ring) > 1e-6 && !selfIntersects(points)
}
