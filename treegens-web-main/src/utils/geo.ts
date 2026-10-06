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
