import assert from 'node:assert/strict'
import test from 'node:test'
import {
  circleRing,
  closeRing,
  crossesAntimeridian,
  distanceToRingM,
  haversineMeters,
  isValidRing,
  LonLat,
  pointInRing,
  ringAreaM2,
  ringCentroid,
  wrapLon,
} from './geo'

test('haversineMeters is ~0 for same point', () => {
  const m = haversineMeters(40.7128, -74.006, 40.7128, -74.006)
  assert.ok(m < 1)
})

test('haversineMeters short distance is plausible', () => {
  const m = haversineMeters(40.7128, -74.006, 40.713, -74.0061)
  assert.ok(m > 10 && m < 50)
})

// A 100 m x 100 m square at Gazi Bay, Kenya, built from metre offsets.
const LAT = -4.423
const LON = 39.507
const DEG_LAT = 100 / 111_195
const DEG_LON = DEG_LAT / Math.cos((LAT * Math.PI) / 180)
const square: LonLat[] = [
  [LON, LAT],
  [LON + DEG_LON, LAT],
  [LON + DEG_LON, LAT + DEG_LAT],
  [LON, LAT + DEG_LAT],
]

test('closeRing repeats the first vertex once and drops GPS repeats', () => {
  const closed = closeRing([square[0], square[1], square[1], square[2]])
  assert.deepEqual(closed, [square[0], square[1], square[2], square[0]])
  assert.deepEqual(closeRing(closed), closed)
  assert.deepEqual(closeRing([]), [])
})

test('ringAreaM2 measures a 100 m square as about one hectare', () => {
  const area = ringAreaM2(square)
  assert.ok(Math.abs(area - 10_000) < 50, `area ${area}`)
  assert.equal(ringAreaM2(closeRing(square)), area)
  assert.equal(ringAreaM2([...square].reverse()), area)
})

test('ringCentroid finds the middle of the square', () => {
  const c = ringCentroid(square)
  assert.ok(Math.abs(c.latitude - (LAT + DEG_LAT / 2)) < 1e-7)
  assert.ok(Math.abs(c.longitude - (LON + DEG_LON / 2)) < 1e-7)
})

test('ringCentroid weights by area, not by vertex count', () => {
  // Extra vertices along one edge must not drag the centroid towards it.
  const mid: LonLat = [LON + DEG_LON / 2, LAT]
  const quarter: LonLat = [LON + DEG_LON / 4, LAT]
  const c = ringCentroid([square[0], quarter, mid, ...square.slice(1)])
  assert.ok(Math.abs(c.latitude - (LAT + DEG_LAT / 2)) < 1e-7)
})

test('pointInRing tells inside from outside', () => {
  assert.equal(pointInRing(LAT + DEG_LAT / 2, LON + DEG_LON / 2, square), true)
  assert.equal(pointInRing(LAT - DEG_LAT / 2, LON + DEG_LON / 2, square), false)
  assert.equal(pointInRing(LAT + DEG_LAT / 2, LON + 2 * DEG_LON, square), false)
})

test('distanceToRingM is 0 inside and the gap to the nearest edge outside', () => {
  assert.equal(distanceToRingM(LAT + DEG_LAT / 2, LON + DEG_LON / 2, square), 0)
  const south = distanceToRingM(LAT - DEG_LAT / 2, LON + DEG_LON / 2, square)
  assert.ok(Math.abs(south - 50) < 0.5, `south ${south}`)
  // Diagonal from the corner: 30 m east and 40 m south is 50 m away.
  const corner = distanceToRingM(
    LAT - 0.4 * DEG_LAT,
    LON + 1.3 * DEG_LON,
    square,
  )
  assert.ok(Math.abs(corner - 50) < 0.5, `corner ${corner}`)
})

test('circleRing is closed, round and the expected size', () => {
  const ring = circleRing(LAT, LON, 30)
  assert.equal(ring.length, 33)
  assert.deepEqual(ring[0], ring[32])
  for (const [lon, lat] of ring.slice(0, -1)) {
    const r = haversineMeters(LAT, LON, lat, lon)
    assert.ok(Math.abs(r - 30) < 0.1, `radius ${r}`)
  }
  const area = ringAreaM2(ring)
  assert.ok(Math.abs(area - Math.PI * 900) / (Math.PI * 900) < 0.01)
  const c = ringCentroid(ring)
  assert.ok(haversineMeters(LAT, LON, c.latitude, c.longitude) < 0.01)
  assert.equal(circleRing(LAT, LON, 30, 8).length, 9)
})

test('isValidRing accepts a real boundary, open or closed', () => {
  assert.equal(isValidRing(square), true)
  assert.equal(isValidRing(closeRing(square)), true)
  assert.equal(isValidRing(circleRing(LAT, LON, 10)), true)
})

test('isValidRing rejects junk, lines and crossing boundaries', () => {
  assert.equal(isValidRing('not a ring'), false)
  assert.equal(isValidRing(square.slice(0, 2)), false)
  assert.equal(isValidRing([square[0], square[1], square[0]]), false)
  assert.equal(isValidRing([...square.slice(0, 3), [LON, NaN]]), false)
  assert.equal(
    isValidRing([
      [200, 0],
      [201, 0],
      [201, 1],
    ]),
    false,
  )
  assert.equal(
    isValidRing([
      [0, 91],
      [1, 91],
      [1, 92],
    ]),
    false,
  )
  // Three points on one line have no area.
  const line: LonLat[] = [
    [LON, LAT],
    [LON + DEG_LON, LAT],
    [LON + 2 * DEG_LON, LAT],
  ]
  assert.equal(isValidRing(line), false)
  // A bow tie: the second and fourth edges cross.
  const bowTie: LonLat[] = [square[0], square[1], square[3], square[2]]
  assert.equal(isValidRing(bowTie), false)
  // A boundary that passes through the same corner twice.
  const pinched: LonLat[] = [...square, square[1], [LON + 2 * DEG_LON, LAT]]
  assert.equal(isValidRing(pinched), false)
})

test('wrapLon folds longitudes into [-180, 180)', () => {
  assert.equal(wrapLon(39.5), 39.5)
  assert.equal(wrapLon(-179.5), -179.5)
  assert.ok(Math.abs(wrapLon(180.25) - -179.75) < 1e-9)
  assert.ok(Math.abs(wrapLon(-180.25) - 179.75) < 1e-9)
  assert.ok(Math.abs(wrapLon(540.5) - -179.5) < 1e-9)
})

test('circleRing never goes past the 180th meridian', () => {
  // Fiji: a 300 m circle 100 m west of the meridian.
  const ring = circleRing(-16.5, 179.999, 300)
  for (const [lon] of ring) assert.ok(Math.abs(lon) <= 180, `lon ${lon}`)
  assert.equal(crossesAntimeridian(ring), true)
  assert.equal(crossesAntimeridian(circleRing(-16.5, 179.99, 300)), false)
})

test('crossesAntimeridian spots an edge over the 180th meridian only', () => {
  const fiji: LonLat[] = [
    [179.999, -16.5],
    [-179.999, -16.5],
    [-179.999, -16.502],
    [179.999, -16.502],
  ]
  assert.equal(crossesAntimeridian(fiji), true)
  assert.equal(crossesAntimeridian(closeRing(fiji)), true)
  assert.equal(crossesAntimeridian(square), false)
  assert.equal(crossesAntimeridian(closeRing(square)), false)
  assert.equal(crossesAntimeridian('not a ring'), false)
  assert.equal(
    crossesAntimeridian([
      [200, 0],
      [-200, 0],
      [0, 1],
    ]),
    false,
  )
})

test('area and centroid stay right for a ring over the 180th meridian', () => {
  // About 214 m by 222 m around the meridian.
  const ring: LonLat[] = [
    [179.999, -16.5],
    [-179.999, -16.5],
    [-179.999, -16.502],
    [179.999, -16.502],
  ]
  const area = ringAreaM2(ring)
  assert.ok(Math.abs(area - 213.3 * 222.4) < 600, `area ${area}`)
  const c = ringCentroid(ring)
  assert.ok(Math.abs(Math.abs(c.longitude) - 180) < 1e-6, `lon ${c.longitude}`)
  assert.ok(Math.abs(c.latitude - -16.501) < 1e-6)
})
