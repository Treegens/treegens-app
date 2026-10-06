import assert from 'node:assert/strict'
import test from 'node:test'
import * as mgrs from 'mgrs'
import {
  bandAsset,
  candidateTiles,
  findSiteTile,
  footprintCovers,
  forEachLimit,
  listUrl,
  mapLimit,
  mgrsTileFor,
  monthPrefixes,
  parseFootprint,
  parseListing,
  parseMgrsTile,
  parseSceneItem,
  pickTile,
  SceneItem,
  sceneItemUrl,
  selectScenes,
  squareId,
  TileRaster,
  tileEpsg,
  utmDefinition,
  utmProjection,
  withDecoderPool,
  withRetry,
  worldCoverTileUrl,
} from './imagery'
import { Ring } from './math'

const BUCKET = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com'

function stacItem(overrides: Record<string, any> = {}) {
  const asset = (file: string, band: Record<string, number>) => ({
    href: `${BUCKET}/sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2A_37MER_20250317_0_L2A/${file}`,
    'raster:bands': [band],
  })
  return {
    id: 'S2A_37MER_20250317_0_L2A',
    properties: {
      datetime: '2025-03-17T07:51:16.580000Z',
      'eo:cloud_cover': 18.9,
      'proj:epsg': 32737,
    },
    assets: {
      green: asset('B03.tif', { scale: 0.0001, offset: -0.1, nodata: 0 }),
      nir: asset('B08.tif', { scale: 0.0001, offset: -0.1, nodata: 0 }),
      scl: asset('SCL.tif', { nodata: 0 }),
    },
    ...overrides,
  }
}

function scene(
  date: string,
  cloudPct: number,
  id = date,
  footprint: Ring[][] | null = null,
): SceneItem {
  const band = { href: id, scale: 1, offset: 0 }
  const bands = { green: band, nir: band, scl: band }
  return { id, date, cloudPct, epsg: 32737, ...bands, footprint }
}

/** A 30 m circle of [lon, lat] points around a site. */
function circle(lat: number, lon: number, radiusM = 30): Ring {
  const dLat = (radiusM / 6_371_000) * (180 / Math.PI)
  const dLon = dLat / Math.cos((lat * Math.PI) / 180)
  return Array.from({ length: 32 }, (_, i) => {
    const a = (2 * Math.PI * i) / 32
    return [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]
  })
}

/** Grids of real Sentinel-2 tiles, read from their green band headers. */
function s2Raster(id: string, originX: number, originY: number): TileRaster {
  const geometry = { originX, originY, res: 10, width: 10980, height: 10980 }
  return { tile: parseMgrsTile(id), epsg: 32737, geometry }
}

const listingXml = (prefixes: string[]) =>
  `<ListBucketResult><IsTruncated>false</IsTruncated>${prefixes
    .map(p => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`)
    .join('')}</ListBucketResult>`

/** Replaces global fetch for one test; returns the URLs it was asked for. */
function stubFetch(
  t: { after: (fn: () => void) => void },
  reply: (url: URL) => Response,
): string[] {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: string | URL) => {
    seen.push(String(input))
    return reply(new URL(String(input)))
  }) as typeof fetch
  t.after(() => (globalThis.fetch = original))
  return seen
}

test('parseMgrsTile splits zone, band and square', () => {
  assert.deepEqual(parseMgrsTile('37MER'), {
    id: '37MER',
    zone: 37,
    band: 'M',
    square: 'ER',
  })
  assert.equal(parseMgrsTile('7VUM').zone, 7)
  assert.throws(() => parseMgrsTile('37MER123'), /Unexpected MGRS tile id/)
})

test('mgrsTileFor finds the Gazi Bay tile', () => {
  assert.equal(mgrsTileFor(39.507, -4.423).id, '37MER')
})

test('squareId names the same 100 km squares as the mgrs library', () => {
  for (let lat = -59.5; lat < 56; lat += 3.7) {
    for (let lon = -179.5; lon < 180; lon += 4.9) {
      const [zone, band, square] = /^(\d+)([A-Z])([A-Z]{2})$/
        .exec(mgrs.forward([lon, lat], 0))
        .slice(1)
      const epsg = (band >= 'N' ? 32600 : 32700) + Number(zone)
      const [x, y] = utmProjection(epsg).toUtm([lon, lat])
      assert.equal(squareId(Number(zone), x, y), square, `${lat}, ${lon}`)
    }
  }
  assert.equal(squareId(37, 50_000, 9_500_000), null)
})

test('candidateTiles adds the band and zone neighbours that hold real tiles', () => {
  const ids = (lon: number, lat: number) =>
    candidateTiles(lon, lat, 4000).map(t => t.id)
  // Gazi Bay is far from every edge: only its own square.
  assert.deepEqual(ids(39.514, -4.4347), ['37MER'])
  // Rufiji delta: 37LEM does not exist, 37MEM (across -8) holds the site.
  assert.deepEqual(ids(39.3, -8.05), ['37LEM', '37MEM'])
  // Niger Delta: zone 32 has no J column; zone 31 tiles cover the sliver.
  assert.deepEqual(ids(6.2, 4.5), ['32NJK', '32NJL', '31NHE', '31NHF'])
  // Kilifi, just south-east of a square corner: north and west squares too.
  assert.deepEqual(ids(39.905, -3.62), ['37MFR', '37MFS', '37MER', '37MES'])
})

test('pickTile prefers a tile holding the whole window over the own square', () => {
  // Real grids: 37MFR starts right at the Kilifi site, 37MES holds it all.
  const kilifi = circle(-3.62, 39.905)
  const fr = s2Raster('37MFR', 600_000, 9_600_040)
  const fs = s2Raster('37MFS', 600_000, 9_700_000)
  const er = s2Raster('37MER', 499_980, 9_600_040)
  const es = s2Raster('37MES', 499_980, 9_700_000)
  assert.equal(pickTile([fr, fs, er, es], kilifi, 1500, 700).id, '37MES')
  // Without it: the tile holding the site with the largest window (37MFS
  // cuts 103 columns off, 37MER 132 rows, 37MFR both).
  assert.equal(pickTile([fr, er, fs], kilifi, 1500, 700).id, '37MFS')
  // The first whole fit wins, so a site's own tile stays first.
  const gazi = circle(-4.4347, 39.514)
  assert.equal(pickTile([er, es], gazi, 1500, 700).id, '37MER')
  assert.equal(pickTile([fs], gazi, 1500, 700), null)
})

test('findSiteTile skips tiles missing from the bucket and caches lookups', async t => {
  const bucket = 'https://bucket.test/rufiji'
  const seen = stubFetch(t, url => {
    const prefix = url.searchParams.get('prefix')
    const years = prefix?.endsWith('/37/M/EM/') ? [`${prefix}2025/`] : []
    return new Response(listingXml(years))
  })
  const rufiji = circle(-8.05, 39.3)
  const tile = await findSiteTile(bucket, rufiji, 1500, 700, 4)
  assert.equal(tile.id, '37MEM')
  assert.equal(seen.length, 2)
  await findSiteTile(bucket, rufiji, 1500, 700, 4)
  assert.equal(seen.length, 2)
})

test('findSiteTile throws when no tile holds the site', async t => {
  stubFetch(t, () => new Response(listingXml([])))
  await assert.rejects(
    findSiteTile('https://bucket.test/none', circle(4.5, 6.2), 1500, 700, 4),
    /No Sentinel-2 tile holds this site \(tried 32NJK, 32NJL, 31NHE, 31NHF\)/,
  )
})

test('tileEpsg picks the UTM hemisphere from the latitude band', () => {
  assert.equal(tileEpsg(parseMgrsTile('37MER')), 32737)
  assert.equal(tileEpsg(parseMgrsTile('31UFU')), 32631)
})

test('monthPrefixes counts back from asOf without zero padding', () => {
  const prefixes = monthPrefixes(
    parseMgrsTile('37MER'),
    new Date('2026-02-10T00:00:00Z'),
    1,
  )
  assert.equal(prefixes.length, 12)
  assert.equal(prefixes[0], 'sentinel-s2-l2a-cogs/37/M/ER/2025/3/')
  assert.equal(prefixes[10], 'sentinel-s2-l2a-cogs/37/M/ER/2026/1/')
  assert.equal(prefixes[11], 'sentinel-s2-l2a-cogs/37/M/ER/2026/2/')
})

test('listUrl builds a ListObjectsV2 query', () => {
  assert.equal(
    listUrl(BUCKET, 'sentinel-s2-l2a-cogs/37/M/ER/2025/3/'),
    `${BUCKET}/?list-type=2&prefix=sentinel-s2-l2a-cogs%2F37%2FM%2FER%2F2025%2F3%2F&delimiter=%2F`,
  )
  assert.ok(
    listUrl(BUCKET, 'p/', 'a+b/c=').endsWith(
      '&continuation-token=a%2Bb%2Fc%3D',
    ),
  )
})

test('parseListing reads folders and the continuation token', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Prefix>sentinel-s2-l2a-cogs/37/M/ER/2025/3/</Prefix>
<IsTruncated>true</IsTruncated><NextContinuationToken>1x&amp;y=</NextContinuationToken>
<CommonPrefixes><Prefix>sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2A_37MER_20250317_0_L2A/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2B_37MER_20250310_0_L2A/</Prefix></CommonPrefixes>
</ListBucketResult>`
  const listing = parseListing(xml)
  assert.deepEqual(listing.prefixes, [
    'sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2A_37MER_20250317_0_L2A/',
    'sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2B_37MER_20250310_0_L2A/',
  ])
  assert.equal(listing.nextToken, '1x&y=')
  const last = parseListing(xml.replace('true', 'false'))
  assert.equal(last.nextToken, null)
})

test('sceneItemUrl points at the STAC item inside the scene folder', () => {
  assert.equal(
    sceneItemUrl(BUCKET, 'sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2A_X_L2A/'),
    `${BUCKET}/sentinel-s2-l2a-cogs/37/M/ER/2025/3/S2A_X_L2A/S2A_X_L2A.json`,
  )
})

test('bandAsset reads scale and offset with safe defaults', () => {
  assert.deepEqual(bandAsset({ href: 'a', 'raster:bands': [{ scale: 2 }] }), {
    href: 'a',
    scale: 2,
    offset: 0,
  })
  assert.deepEqual(bandAsset({ href: 'b' }), { href: 'b', scale: 1, offset: 0 })
  assert.equal(bandAsset(undefined), null)
})

test('parseSceneItem keeps the fields the check needs', () => {
  const item = parseSceneItem(stacItem())
  assert.equal(item.date, '2025-03-17')
  assert.equal(item.cloudPct, 18.9)
  assert.equal(item.epsg, 32737)
  assert.equal(item.green.scale, 0.0001)
  assert.equal(item.green.offset, -0.1)
  assert.deepEqual(
    { scale: item.scl.scale, offset: item.scl.offset },
    { scale: 1, offset: 0 },
  )
  assert.ok(item.nir.href.endsWith('/B08.tif'))
})

test('parseSceneItem keeps the footprint polygon', () => {
  const polygon = [
    [
      [39, -4],
      [40, -4],
      [40, -5],
      [39, -4],
    ],
  ]
  const item = parseSceneItem({
    ...stacItem(),
    geometry: { type: 'Polygon', coordinates: polygon },
  })
  assert.deepEqual(item.footprint, [polygon])
  assert.equal(parseSceneItem(stacItem()).footprint, null)
})

test('footprintCovers handles polygons, holes, multipolygons and unknowns', () => {
  const square = (x0: number, y0: number, size: number): Ring => [
    [x0, y0],
    [x0 + size, y0],
    [x0 + size, y0 + size],
    [x0, y0 + size],
  ]
  const holed = parseFootprint({
    type: 'Polygon',
    coordinates: [square(0, 0, 10), square(4, 4, 2)],
  })
  assert.equal(footprintCovers(holed, [1, 1]), true)
  assert.equal(footprintCovers(holed, [5, 5]), false)
  assert.equal(footprintCovers(holed, [11, 1]), false)
  const multi = parseFootprint({
    type: 'MultiPolygon',
    coordinates: [[square(0, 0, 1)], [square(5, 5, 1)]],
  })
  assert.equal(footprintCovers(multi, [5.5, 5.5]), true)
  assert.equal(parseFootprint({ type: 'Point', coordinates: [0, 0] }), null)
  assert.equal(footprintCovers(null, [0, 0]), true)
})

test('parseSceneItem handles proj:code, missing cloud and missing bands', () => {
  const base = stacItem()
  const coded = parseSceneItem({
    ...base,
    properties: { datetime: '2024-01-02T00:00:00Z', 'proj:code': 'EPSG:32737' },
  })
  assert.equal(coded.epsg, 32737)
  assert.equal(coded.cloudPct, 100)
  const noNir = parseSceneItem({
    ...base,
    assets: { green: base.assets.green, scl: base.assets.scl },
  })
  assert.equal(noNir, null)
})

test('selectScenes filters cloud, keeps the clearest per date, clearest first', () => {
  const picked = selectScenes(
    [
      scene('2025-01-01', 30, 'a0'),
      scene('2025-01-01', 10, 'a1'),
      scene('2025-01-11', 90, 'b'),
      scene('2025-01-21', 5, 'c'),
      scene('2025-01-31', 10, 'd'),
    ],
    80,
  )
  assert.deepEqual(
    picked.map(s => s.id),
    ['c', 'a1', 'd'],
  )
})

test('selectScenes keeps the same-date granule that covers the site', () => {
  // Real footprints of the two 37MER granules of 2025-10-21: _1 is clearer
  // but has no data at Gazi Bay, _0 does.
  const granule0: Ring[][] = [
    [
      [
        [39.98910131612672, -4.1643587671670055],
        [38.999828852153826, -3.9294024016809868],
        [38.99982870087146, -4.611849694663838],
        [39.98968945272844, -4.611160076907257],
        [39.98910131612672, -4.1643587671670055],
      ],
    ],
  ]
  const granule1: Ring[][] = [
    [
      [
        [38.99982891299001, -3.618524361526298],
        [38.99982881562906, -4.1046690695225685],
        [39.98932885465214, -4.34272660079622],
        [39.988464170273744, -3.617983709421384],
        [38.99982891299001, -3.618524361526298],
      ],
    ],
  ]
  const items = [
    scene('2025-10-21', 21.2, '_0', granule0),
    scene('2025-10-21', 19.8, '_1', granule1),
  ]
  const at = (lon: number, lat: number) =>
    selectScenes(items, 80, [lon, lat]).map(s => s.id)
  assert.deepEqual(at(39.53, -4.43), ['_0'])
  // Both cover a site further north: the clearer one wins.
  assert.deepEqual(at(39.53, -4.0), ['_1'])
  // Without a site, or with unknown footprints, cloud decides.
  assert.deepEqual(
    selectScenes(items, 80).map(s => s.id),
    ['_1'],
  )
})

test('utmDefinition builds proj4 strings for both hemispheres', () => {
  assert.equal(
    utmDefinition(32737),
    '+proj=utm +zone=37 +south +datum=WGS84 +units=m +no_defs',
  )
  assert.equal(
    utmDefinition(32631),
    '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs',
  )
  assert.throws(() => utmDefinition(4326), /Unsupported projection/)
})

test('utmProjection round-trips a point', () => {
  const p = utmProjection(32737)
  const [x, y] = p.toUtm([39.51, -4.425])
  assert.ok(Math.abs(x - 556582.94) < 0.1)
  assert.ok(Math.abs(y - 9510875.36) < 0.1)
  const [lon, lat] = p.toLonLat([x, y])
  assert.ok(Math.abs(lon - 39.51) < 1e-8 && Math.abs(lat + 4.425) < 1e-8)
})

test('worldCoverTileUrl names the 3 degree tile', () => {
  const base = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com'
  const name = (lon: number, lat: number) =>
    worldCoverTileUrl(base, lon, lat).split('/').pop()
  assert.equal(name(39.5, -4.4), 'ESA_WorldCover_10m_2021_v200_S06E039_Map.tif')
  assert.equal(name(-0.5, 0.5), 'ESA_WorldCover_10m_2021_v200_N00W003_Map.tif')
  assert.equal(name(-77.1, -12), 'ESA_WorldCover_10m_2021_v200_S12W078_Map.tif')
  assert.ok(
    worldCoverTileUrl(base, 39.5, -4.4).startsWith(`${base}/v200/2021/map/`),
  )
})

test('withRetry retries until it succeeds or runs out of delays', async () => {
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls < 3) throw new Error('blip')
    return 'ok'
  }
  assert.equal(await withRetry(flaky, [0, 0]), 'ok')
  assert.equal(calls, 3)
  calls = 0
  const broken = async () => {
    calls++
    throw new Error('down')
  }
  await assert.rejects(withRetry(broken, [0, 0]), /down/)
  assert.equal(calls, 3)
})

test('forEachLimit bounds concurrency and stops when asked', async () => {
  let inFlight = 0
  let peak = 0
  const seen: number[] = []
  await forEachLimit([1, 2, 3, 4, 5, 6], 2, async n => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    seen.push(n)
    inFlight--
  })
  assert.equal(peak, 2)
  assert.equal(seen.length, 6)
  const started: number[] = []
  await forEachLimit(
    [1, 2, 3, 4],
    1,
    async n => {
      started.push(n)
    },
    () => started.length >= 2,
  )
  assert.deepEqual(started, [1, 2])
})

test('withDecoderPool shares one pool and shuts it down when idle', async () => {
  let first: unknown
  await withDecoderPool(1, async outer => {
    first = outer
    assert.ok(outer)
    await withDecoderPool(1, async inner => assert.equal(inner, outer))
  })
  await withDecoderPool(1, async next => assert.notEqual(next, first))
  await withDecoderPool(0, async none => assert.equal(none, undefined))
})

test('mapLimit keeps the input order', async () => {
  const out = await mapLimit([30, 10, 20], 3, async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
    return ms * 2
  })
  assert.deepEqual(out, [60, 20, 40])
})
