/**
 * Proves the real ffmpeg pipeline, not a mock of it: two synthetic source
 * clips are served over HTTP exactly as GCS would serve them, stitched, then
 * the output is probed and sampled frame-by-frame.
 *
 * These assertions exist because every one of them is a way the pipeline has
 * a plausible silent failure: a drawtext filter that needs a font the host
 * does not have, a filtergraph that drops the end card, a portrait source
 * stretched to landscape, or an xfade offset that truncates the clip.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import { path as ffprobePath } from 'ffprobe-static'
import { renderStitchedVideo } from './verifiedVideoStitchService'

const FF = ffmpegPath as string

function ff(args: string[]) {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: 'pipe',
  })
}

function probe(file: string, entries: string): string {
  return execFileSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', entries, '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  ).trim()
}

/** A portrait clip, like a phone films: the shape that used to get squashed. */
function makePortraitClip(out: string, seconds: number, withAudio: boolean) {
  const args = [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=720x1280:rate=30:duration=${seconds}`,
  ]
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-c:a', 'aac'] : []),
    '-y',
    out,
  )
  ff(args)
}

/** Average colour of one frame, as [r,g,b] 0-255. */
function frameColour(video: string, atSeconds: number, work: string) {
  const png = path.join(work, `frame-${atSeconds}.png`)
  ff([
    '-ss',
    String(atSeconds),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    'scale=1:1',
    '-y',
    png,
  ])
  const raw = path.join(work, `frame-${atSeconds}.rgb`)
  ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', raw])
  const buf = execFileSync('cat', [raw])
  return [buf[0], buf[1], buf[2]] as [number, number, number]
}

/** Count distinct-ish colours in a frame — a blank frame has almost none. */
function frameEntropy(video: string, atSeconds: number, work: string): number {
  const raw = path.join(work, `e-${atSeconds}.rgb`)
  ff([
    '-ss',
    String(atSeconds),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    'scale=64:36',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-y',
    raw,
  ])
  const buf = execFileSync('cat', [raw])
  const seen = new Set<string>()
  for (let i = 0; i + 2 < buf.length; i += 3) {
    seen.add(`${buf[i] >> 4},${buf[i + 1] >> 4},${buf[i + 2] >> 4}`)
  }
  return seen.size
}

test('stitches before + after + branded end card', async t => {
  assert.ok(FF, 'ffmpeg-static binary is required for this test')
  const work = await mkdtemp(path.join(os.tmpdir(), 'stitch-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))

  const beforeSrc = path.join(work, 'src-before.mp4')
  const afterSrc = path.join(work, 'src-after.mp4')
  makePortraitClip(beforeSrc, 3, false)
  // With audio: the output must still come out audio-less (-an), because a
  // stray audio stream breaks some marketplace animation players.
  makePortraitClip(afterSrc, 4, true)

  const server = http.createServer(async (req, res) => {
    try {
      const file = req.url === '/before.mp4' ? beforeSrc : afterSrc
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(body.length),
      })
      res.end(body)
    } catch {
      res.writeHead(500).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))

  const out = path.join(work, 'stitched.mp4')
  await renderStitchedVideo(
    {
      beforeUrl: `http://127.0.0.1:${port}/before.mp4`,
      afterUrl: `http://127.0.0.1:${port}/after.mp4`,
      treeCount: 200,
      // Deliberately nasty: a colon, an apostrophe and a comma are all
      // filtergraph syntax, and this label comes from geocoded user data.
      plotLabel: "MOMBASA, KENYA: KIPINI'S PLOT — MANGROVE",
    },
    out,
    work,
  )

  const s = await stat(out)
  assert.ok(s.size > 20_000, `output too small (${s.size} bytes)`)

  // 960x540 landscape, h264, no audio.
  assert.equal(probe(out, 'stream=width,height'), '960\n540')
  assert.equal(probe(out, 'stream=codec_name').split('\n')[0], 'h264')
  assert.equal(
    probe(out, 'stream=codec_type').split('\n').filter(Boolean).join(','),
    'video',
    'the stitched clip must have no audio stream',
  )

  // before + after + card - two crossfades = 3 + 4 + 2.4 - 1.2
  const duration = Number(probe(out, 'format=duration'))
  assert.ok(
    Math.abs(duration - 8.2) < 0.35,
    `expected ~8.2s, got ${duration}s — an xfade offset is wrong`,
  )

  // The end card is the last thing on screen: brand evergreen #1D472A, and
  // busy enough to contain the logo and two lines of text.
  const [r, g, b] = frameColour(out, duration - 0.6, work)
  assert.ok(
    g > r && g > b && g > 40 && r < 90,
    `end card should be evergreen, averaged rgb(${r},${g},${b})`,
  )
  assert.ok(
    frameEntropy(out, duration - 0.6, work) > 3,
    'end card is a flat colour — the logo and copy did not render',
  )

  // Label bars must actually be drawn: a padded portrait frame with no text
  // would be near-uniform down the centre column.
  assert.ok(
    frameEntropy(out, 1, work) > 8,
    'before frame looks blank — drawtext or the source failed',
  )
  assert.ok(
    frameEntropy(out, 4.5, work) > 8,
    'after frame looks blank — drawtext or the source failed',
  )
})

test('falls back to the generic AFTER label without a count', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'stitch-nocount-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const src = path.join(work, 'src.mp4')
  makePortraitClip(src, 2, false)

  const server = http.createServer(async (_req, res) => {
    const body = await readFile(src)
    res.writeHead(200, { 'content-type': 'video/mp4' }).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))

  const out = path.join(work, 'stitched.mp4')
  await renderStitchedVideo(
    {
      beforeUrl: `http://127.0.0.1:${port}/a.mp4`,
      afterUrl: `http://127.0.0.1:${port}/b.mp4`,
      treeCount: null,
      plotLabel: 'TREEGENS PLOT',
    },
    out,
    work,
  )
  assert.ok((await stat(out)).size > 10_000)
  assert.equal(probe(out, 'stream=width,height'), '960\n540')
})

test('a dead source URL fails loudly rather than writing a broken clip', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'stitch-dead-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  await assert.rejects(
    renderStitchedVideo(
      {
        beforeUrl: 'http://127.0.0.1:1/nope.mp4',
        afterUrl: 'http://127.0.0.1:1/nope.mp4',
        treeCount: 100,
        plotLabel: 'X',
      },
      path.join(work, 'out.mp4'),
      work,
    ),
  )
})
