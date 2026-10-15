/**
 * Live smoke test for the satellite hydrology check around one point.
 *
 * Usage (from treegens-backend-main):
 *   yarn site:hydrology-smoke <lat> <lon> [radiusM=30] [years=2]
 *     [--reference-radius=1500] [--as-of=YYYY-MM] [--concurrency=4]
 *     [--decoder-workers=1]
 *
 * Example (Gazi Bay mangroves, Kenya):
 *   yarn site:hydrology-smoke -4.423 39.507
 *
 * Needs outbound HTTPS to the sentinel-cogs and esa-worldcover S3 buckets.
 * Behind a proxy, set NODE_USE_ENV_PROXY=1 (and NODE_EXTRA_CA_CERTS if the
 * proxy has its own CA). Progress goes to stderr, the result JSON to stdout.
 * The run's wall time, peak memory and longest event-loop stall (how long
 * an API sharing the process would have been unable to answer) go to
 * stderr at the end. The default reads and decoder workers are the API's
 * (SITE_HYDROLOGY_SCENE_CONCURRENCY and SITE_HYDROLOGY_DECODER_WORKERS),
 * so a run without flags measures what the API runs.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { HYDROLOGY_DEFAULTS, runSiteHydrology } from '../hydrology'

const EARTH_RADIUS_M = 6_371_000

function circleRing(
  lat: number,
  lon: number,
  radiusM: number,
  segments = 32,
): [number, number][] {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI)
  const dLon = dLat / Math.cos((lat * Math.PI) / 180)
  const ring: [number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const a = (2 * Math.PI * (i % segments)) / segments
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  return ring
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length)
}

function asOfDate(value: string | undefined): Date {
  if (!value) return new Date()
  const [year, month] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 15))
}

const [lat, lon, radiusM = 30, years = 2] = process.argv
  .slice(2)
  .filter(a => !a.startsWith('--'))
  .map(Number)

if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error(
    'Usage: yarn site:hydrology-smoke <lat> <lon> [radiusM=30] [years=2] [--reference-radius=1500] [--as-of=YYYY-MM] [--concurrency=4] [--decoder-workers=1]',
  )
  process.exit(1)
}

async function main() {
  const started = Date.now()
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()
  const result = await runSiteHydrology({
    ...HYDROLOGY_DEFAULTS,
    ring: circleRing(lat, lon, radiusM),
    asOf: asOfDate(flag('as-of')),
    years,
    referenceRadiusM: Number(
      flag('reference-radius') ?? HYDROLOGY_DEFAULTS.referenceRadiusM,
    ),
    concurrency: Number(flag('concurrency') ?? HYDROLOGY_DEFAULTS.concurrency),
    decoderWorkers: Number(
      flag('decoder-workers') ?? HYDROLOGY_DEFAULTS.decoderWorkers,
    ),
    log: msg =>
      console.error(`[${Math.round((Date.now() - started) / 1000)}s] ${msg}`),
  })
  loopDelay.disable()
  console.log(JSON.stringify(result, null, 2))
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const peakMb = Math.round(process.resourceUsage().maxRSS / 1024)
  const ms = (ns: number) => Math.round(ns / 1e6)
  console.error(
    `${seconds} s, peak memory ${peakMb} MB, event loop delay p99 ${ms(loopDelay.percentile(99))} ms, max ${ms(loopDelay.max)} ms`,
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
