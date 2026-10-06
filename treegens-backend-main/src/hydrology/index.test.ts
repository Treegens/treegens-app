import assert from 'node:assert/strict'
import test from 'node:test'
import { HYDROLOGY_DEFAULTS, runSiteHydrology } from './index'

const GAZI: [number, number][] = [
  [39.5137, -4.4349],
  [39.5143, -4.4349],
  [39.5143, -4.4345],
  [39.5137, -4.4345],
]

const listingXml = (prefixes: string[]) =>
  `<ListBucketResult><IsTruncated>false</IsTruncated>${prefixes
    .map(p => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`)
    .join('')}</ListBucketResult>`

/** A cloudy STAC item for the scene folder at `path`. */
function cloudyItem(path: string) {
  const asset = { href: `${path}B03.tif` }
  return {
    id: path,
    properties: {
      datetime: '2025-06-01T07:50:00Z',
      'eo:cloud_cover': 95,
      'proj:epsg': 32737,
    },
    assets: { green: asset, nir: asset, scl: asset },
  }
}

/**
 * A bucket with tile 37MER and one scene a month in 2025, whose item JSON
 * is served by `item` (the scene's month as a number).
 */
function stubBucket(
  t: { after: (fn: () => void) => void },
  item: (month: number, path: string) => Response,
) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input))
    const prefix = url.searchParams.get('prefix')
    if (prefix === 'sentinel-s2-l2a-cogs/37/M/ER/') {
      return new Response(listingXml([`${prefix}2025/`]))
    }
    const month = /\/37\/M\/ER\/2025\/(\d+)\/$/.exec(prefix ?? '')
    if (month) {
      const scene = `${prefix}S2A_37MER_2025${month[1]}01_0_L2A/`
      return new Response(listingXml([scene]))
    }
    if (prefix !== null) return new Response(listingXml([]))
    const path = url.pathname.replace(/[^/]*$/, '')
    return item(Number(/\/2025\/(\d+)\//.exec(path)?.[1]), path)
  }) as typeof fetch
  t.after(() => (globalThis.fetch = original))
}

const input = (bucket: string) => ({
  ...HYDROLOGY_DEFAULTS,
  ring: GAZI,
  asOf: new Date('2025-12-15T00:00:00Z'),
  years: 1,
  s2BucketUrl: bucket,
})

test('an imagery outage fails the run instead of reporting no images', async t => {
  stubBucket(t, () => new Response('SlowDown', { status: 503 }))
  await assert.rejects(
    runSiteHydrology(input('https://bucket.test/outage')),
    /Could not fetch 12 of 12 Sentinel-2 scene items/,
  )
})

test('a few unreadable items are noted when no clear image is left', async t => {
  stubBucket(t, (month, path) =>
    month === 3
      ? new Response('SlowDown', { status: 503 })
      : Response.json(cloudyItem(path)),
  )
  const result = await runSiteHydrology(input('https://bucket.test/cloudy'))
  assert.equal(result.hydrologyClass, 'insufficient_data')
  assert.equal(result.imagery.mgrsTile, '37MER')
  assert.equal(result.imagery.scenesListed, 12)
  assert.equal(result.imagery.scenesFailed, 1)
  assert.deepEqual(result.notes, [
    'No Sentinel-2 images with at most 80% cloud were found for this site.',
    '1 image could not be read.',
  ])
})
