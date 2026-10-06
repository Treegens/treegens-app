import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bandAsset,
  forEachLimit,
  listUrl,
  mapLimit,
  mgrsTileFor,
  monthPrefixes,
  parseListing,
  parseMgrsTile,
  parseSceneItem,
  SceneItem,
  sceneItemUrl,
  selectScenes,
  tileEpsg,
  utmDefinition,
  utmProjection,
  withRetry,
  worldCoverTileUrl,
} from './imagery'

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

function scene(date: string, cloudPct: number, id = date): SceneItem {
  const band = { href: id, scale: 1, offset: 0 }
  return { id, date, cloudPct, epsg: 32737, green: band, nir: band, scl: band }
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

test('mapLimit keeps the input order', async () => {
  const out = await mapLimit([30, 10, 20], 3, async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
    return ms * 2
  })
  assert.deepEqual(out, [60, 20, 40])
})
