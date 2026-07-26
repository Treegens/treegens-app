/**
 * Verified-planting video stitcher.
 *
 * world.treegens.app's NFT rail serves `plant.publicUrl` as the token's
 * animation_url (see routes/distributions.ts). Until now that was the raw
 * phone clip of the seedlings, with nothing on it to say the planting was
 * verified or who funded it. At approval we now replace it with one branded
 * clip:
 *
 *   [PLOT badge] BEFORE — RAW PLOT FOOTAGE
 *           ⤵ 0.6s crossfade
 *   [PLOT badge] AFTER — AI COUNT: N TREES VERIFIED
 *           ⤵ 0.6s crossfade
 *   Treegens end card — VERIFIED BY AI · FUNDED BY $MGRO
 *
 * The raw clip is never destroyed: it moves to `plant.rawPublicUrl` /
 * `plant.rawVideoCID` first, so the source is always recoverable and the
 * stitch can be re-run.
 *
 * Ported from the `video-stitch/` reference tool and treegens-backend's
 * shareVideoService, with two deliberate changes:
 *  - Labels are drawn by ffmpeg's `drawtext` rather than pre-rendered Pillow
 *    PNGs. The reference tool needed PNGs only because Homebrew's ffmpeg has
 *    no drawtext; the `ffmpeg-static` binary we ship is built
 *    --enable-libfreetype, so text is drawn directly. The font travels with
 *    us as an npm dependency because a Linux container has no system fonts.
 *  - Sources are letterboxed onto the brand green instead of being stretched
 *    to 960x540. Planting clips are portrait; the reference tool's plain
 *    `scale=960:540` squashed them.
 */
import { spawn } from 'child_process'
import { createWriteStream } from 'fs'
import { mkdtemp, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import ffmpegPath from 'ffmpeg-static'
import { path as ffprobePath } from 'ffprobe-static'
import Submission from '../models/Submission'
import { uploadToStorage } from '../config/gcs'
import { approvedTreeCount } from '../utils/treeBatch'

/** treegens.org palette, same values as video-stitch/make_labels.py. */
const LEAF = '0xD1ED6E'
const OLIVE = '0x9FB857'
const EVERGREEN = '0x1D472A'
/** Label bars: evergreen at the reference tool's 200/255 alpha. */
const BOX_ALPHA = '0.78'

const WIDTH = 960
const HEIGHT = 540
const FPS = 30
const XFADE = 0.6
const CARD_SECONDS = 2.4

const STITCH_TIMEOUT_MS = Number(process.env.STITCH_TIMEOUT_MS || 240_000)

/** One stitch per submission at a time; concurrent triggers await the same work. */
const inFlight = new Map<string, Promise<string>>()

function fontFile(): string {
  // Bundled with the app: a Linux container has no fonts of its own, and
  // fontconfig would silently pick something different on every host.
  return require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf')
}

function logoFile(): string {
  return path.join(__dirname, '..', 'assets', 'treegens-logo-light.png')
}

function run(
  bin: string,
  args: string[],
  timeoutMs = STITCH_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => {
      stdout += d.toString()
    })
    proc.stderr.on('data', d => {
      stderr += d.toString()
      if (stderr.length > 65536) stderr = stderr.slice(-32768)
    })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${path.basename(bin)} timed out`))
    }, timeoutMs)
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout || stderr)
      else
        reject(
          new Error(
            `${path.basename(bin)} exited ${code}: ${stderr.slice(-500)}`,
          ),
        )
    })
  })
}

function ffmpeg(args: string[], timeoutMs?: number) {
  if (!ffmpegPath) {
    return Promise.reject(new Error('ffmpeg-static binary unavailable'))
  }
  return run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], timeoutMs)
}

async function durationSeconds(file: string): Promise<number> {
  const out = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      file,
    ],
    30_000,
  )
  const value = Number.parseFloat(out.trim())
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`could not read duration of ${path.basename(file)}`)
  }
  return value
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`source video fetch failed (${res.status})`)
  }
  await pipeline(res.body as never, createWriteStream(dest))
  const s = await stat(dest)
  if (s.size < 1024) throw new Error('source video is empty')
}

/**
 * Label text goes through a file, not the filter string. Text can contain
 * colons, quotes and backslashes — all of which are filtergraph syntax — and
 * the plot label is derived from user-supplied location data.
 */
type Label = { file: string; text: string }

async function writeLabel(dir: string, name: string, text: string): Promise<Label> {
  const file = path.join(dir, `${name}.txt`)
  await writeFile(file, text, 'utf8')
  return { file, text }
}

function drawtext(
  label: Label,
  opts: { size: number; x: string; y: string; color?: string; box?: boolean },
): string {
  const parts = [
    `fontfile=${escapePath(fontFile())}`,
    `textfile=${escapePath(label.file)}`,
    `fontsize=${opts.size}`,
    `fontcolor=${opts.color ?? LEAF}`,
    `x=${opts.x}`,
    `y=${opts.y}`,
  ]
  if (opts.box !== false) {
    parts.push('box=1', `boxcolor=${EVERGREEN}@${BOX_ALPHA}`, 'boxborderw=14')
  }
  return `drawtext=${parts.join(':')}`
}

/** Filtergraph paths need `\` before the characters ffmpeg parses. */
function escapePath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Fit a portrait phone clip into the 960x540 frame without stretching it, and
 * fill the sides with a darkened blur of the clip itself rather than flat
 * colour. Planting clips are portrait, so a plain letterbox leaves two thirds
 * of an NFT's animation as empty bars.
 *
 * `idx` is the input index; the labels are appended by the caller.
 */
function fitToFrame(idx: number): string {
  const tag = `s${idx}`
  return [
    `[${idx}:v]fps=${FPS},format=yuv420p,setsar=1,split=2[${tag}bg][${tag}fg]`,
    `[${tag}bg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},boxblur=24:2,eq=brightness=-0.14[${tag}bgb]`,
    `[${tag}fg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[${tag}fgs]`,
    `[${tag}bgb][${tag}fgs]overlay=(W-w)/2:(H-h)/2[${tag}base]`,
  ].join(';')
}

export type StitchSources = {
  beforeUrl: string
  afterUrl: string
  /** AI-verified tree count; omitted gives the generic AFTER label. */
  treeCount?: number | null
  plotLabel: string
}

/**
 * Render the stitched clip to `outPath`. Exported so the pipeline can be
 * exercised from a test without Mongo or GCS.
 */
export async function renderStitchedVideo(
  sources: StitchSources,
  outPath: string,
  workDir: string,
): Promise<void> {
  const before = path.join(workDir, 'before.mp4')
  const after = path.join(workDir, 'after.mp4')
  await Promise.all([
    download(sources.beforeUrl, before),
    download(sources.afterUrl, after),
  ])

  const [beforeDur, afterDur] = await Promise.all([
    durationSeconds(before),
    durationSeconds(after),
  ])

  const afterText =
    typeof sources.treeCount === 'number' && sources.treeCount > 0
      ? `AFTER — AI COUNT: ${sources.treeCount} TREES VERIFIED`
      : 'AFTER — AI TREE COUNTING'

  const badge = await writeLabel(workDir, 'badge', sources.plotLabel)
  const beforeLabel = await writeLabel(
    workDir,
    'before',
    'BEFORE — RAW PLOT FOOTAGE',
  )
  const afterLabel = await writeLabel(workDir, 'after', afterText)
  const cardLine = await writeLabel(
    workDir,
    'card',
    'VERIFIED BY AI · FUNDED BY $MGRO',
  )
  const cardSite = await writeLabel(workDir, 'site', 'treegens.org')

  // xfade consumes `duration` seconds from the END of the left input, so each
  // offset is where the outgoing clip starts fading, not where it ends.
  const firstFade = Math.max(0.1, beforeDur - XFADE)
  const secondFade = Math.max(0.2, beforeDur - XFADE + afterDur - XFADE)

  const bottom = `y=h-th-28`
  const centre = `x=(w-tw)/2`

  const filter = [
    // BEFORE: badge top-left, so it never sits over an AI counter overlay.
    fitToFrame(0),
    `[s0base]${drawtext(badge, { size: 22, x: '24', y: '24' })},` +
      `${drawtext(beforeLabel, { size: 26, x: centre.slice(2), y: bottom.slice(2) })}[v0]`,
    // AFTER: badge top-RIGHT, so it stays clear of a top-left counter.
    fitToFrame(1),
    `[s1base]${drawtext(badge, { size: 22, x: 'w-tw-24', y: '24' })},` +
      `${drawtext(afterLabel, { size: 26, x: centre.slice(2), y: bottom.slice(2) })}[v1]`,
    // End card: brand green, logo, then the two lines of copy.
    `[2:v]format=yuv420p,setsar=1[card0]`,
    `[card0][3:v]overlay=(W-w)/2:150:format=auto[card1]`,
    `[card1]` +
      `${drawtext(cardLine, { size: 30, x: centre.slice(2), y: '330', box: false })},` +
      `${drawtext(cardSite, { size: 22, x: centre.slice(2), y: '390', color: OLIVE, box: false })}[card]`,
    `[v0][v1]xfade=transition=fade:duration=${XFADE}:offset=${firstFade.toFixed(3)}[ba]`,
    `[ba][card]xfade=transition=fade:duration=${XFADE}:offset=${secondFade.toFixed(3)}[v]`,
  ].join(';')

  await ffmpeg([
    '-y',
    '-i',
    before,
    '-i',
    after,
    '-f',
    'lavfi',
    '-i',
    `color=c=${EVERGREEN}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${CARD_SECONDS}`,
    '-i',
    logoFile(),
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outPath,
  ])

  const s = await stat(outPath)
  if (s.size < 4096) throw new Error('stitched video is suspiciously small')
}

function plotLabelFor(submission: {
  _id: unknown
  treeType?: string | null
  plant?: { reverseGeocode?: string | null } | null
  land?: { reverseGeocode?: string | null } | null
}): string {
  const place = (
    submission.plant?.reverseGeocode ||
    submission.land?.reverseGeocode ||
    ''
  ).trim()
  const species = (submission.treeType || '').trim().toUpperCase()
  if (place) return species ? `${place} — ${species}` : place
  return species ? `TREEGENS — ${species}` : 'TREEGENS PLOT'
}

/**
 * The AFTER clip. This backend's AI providers return counts, not an annotated
 * render, so the count is carried by the label rather than burnt into the
 * video by the model. Prefers the preserved raw URL so a re-run never stitches
 * an already-stitched clip into itself.
 */
function afterSourceUrl(submission: any): string | null {
  return submission.plant?.rawPublicUrl || submission.plant?.publicUrl || null
}

function beforeSourceUrl(submission: any): string | null {
  return submission.land?.rawPublicUrl || submission.land?.publicUrl || null
}

export type StitchOutcome =
  | { status: 'done'; url: string; cached: boolean }
  | { status: 'skipped'; reason: string }

/**
 * Build (once) the branded clip for an approved submission and make it the
 * URL the NFT rail serves.
 *
 * Idempotent: `plant.stitchedAt` short-circuits a second run, and the raw URL
 * is preserved before `publicUrl` is overwritten so a re-run always has its
 * sources. Never throws — approval must not fail because a transcode did.
 */
export async function stitchVerifiedVideo(
  submissionId: string,
): Promise<StitchOutcome> {
  const existing = inFlight.get(submissionId)
  if (existing) return { status: 'done', url: await existing, cached: true }

  const work = (async (): Promise<string> => {
    const submission: any = await Submission.findById(submissionId)
    if (!submission) throw new Error('Submission not found')
    if (submission.plant?.stitchedAt && submission.plant?.publicUrl) {
      return submission.plant.publicUrl
    }

    const beforeUrl = beforeSourceUrl(submission)
    const afterUrl = afterSourceUrl(submission)
    if (!beforeUrl || !afterUrl) {
      throw new Error('Submission does not have both clips stored')
    }

    // Remember the raw clip BEFORE anything overwrites publicUrl, or a failed
    // run leaves us unable to find the source again.
    if (!submission.plant.rawPublicUrl) {
      submission.plant.rawPublicUrl = submission.plant.publicUrl
      submission.plant.rawVideoCID = submission.plant.videoCID
    }
    if (!submission.land.rawPublicUrl) {
      submission.land.rawPublicUrl = submission.land.publicUrl
    }
    submission.plant.stitchStatus = 'processing'
    submission.plant.stitchError = undefined
    await submission.save()

    const dir = await mkdtemp(path.join(os.tmpdir(), 'treegens-stitch-'))
    try {
      const outPath = path.join(dir, 'stitched.mp4')
      await renderStitchedVideo(
        {
          beforeUrl,
          afterUrl,
          treeCount: approvedTreeCount(submission),
          plotLabel: plotLabelFor(submission),
        },
        outPath,
        dir,
      )
      const buffer = await import('fs/promises').then(fs =>
        fs.readFile(outPath),
      )
      const upload = await uploadToStorage(
        buffer,
        `stitched-${submissionId}-${Date.now()}.mp4`,
        'video/mp4',
      )
      // The NFT rail reads plant.publicUrl — this line is the whole point.
      submission.plant.publicUrl = upload.publicUrl
      submission.plant.stitchedPublicUrl = upload.publicUrl
      submission.plant.stitchedAt = new Date()
      submission.plant.stitchStatus = 'done'
      await submission.save()
      return upload.publicUrl
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })()

  inFlight.set(submissionId, work)
  try {
    const url = await work
    return { status: 'done', url, cached: false }
  } catch (error) {
    const message = (error as Error)?.message || String(error)
    console.error('[Stitch] verified-video stitch failed', {
      submissionId,
      message,
    })
    await Submission.updateOne(
      { _id: submissionId },
      {
        $set: {
          'plant.stitchStatus': 'failed',
          'plant.stitchError': message.slice(0, 500),
        },
      },
    ).catch(() => {})
    return { status: 'skipped', reason: message }
  } finally {
    inFlight.delete(submissionId)
  }
}

export type StitchReadiness = {
  ready: boolean
  ffmpeg: boolean
  /** drawtext needs libfreetype; a build without it renders no labels at all. */
  drawtext: boolean
  font: string | null
  logo: boolean
  problems: string[]
}

/**
 * Can this container actually render a stitched clip?
 *
 * Worth an endpoint because the three things that can be missing are all
 * host-specific and all invisible until a real approval fails: the ffmpeg
 * binary, a drawtext filter compiled against libfreetype, and the bundled
 * font and logo surviving the build's asset copy. A local test cannot prove
 * any of them about Render's container.
 */
export async function checkStitchReadiness(): Promise<StitchReadiness> {
  const problems: string[] = []
  const hasFfmpeg = Boolean(ffmpegPath)
  if (!hasFfmpeg) problems.push('ffmpeg-static binary missing')

  let drawtext = false
  if (hasFfmpeg) {
    try {
      const out = await run(ffmpegPath as string, ['-h', 'filter=drawtext'], 15_000)
      drawtext = /libfreetype/i.test(out)
      if (!drawtext) problems.push('ffmpeg has no drawtext filter')
    } catch (error) {
      problems.push(`drawtext probe failed: ${(error as Error).message}`)
    }
  }

  let font: string | null = null
  try {
    font = path.basename(fontFile())
  } catch {
    problems.push('bundled font not resolvable')
  }

  const { existsSync } = await import('fs')
  const logo = existsSync(logoFile())
  if (!logo) problems.push(`logo missing at ${logoFile()}`)

  return {
    ready: problems.length === 0,
    ffmpeg: hasFfmpeg,
    drawtext,
    font,
    logo,
    problems,
  }
}

let sweeping = false

/**
 * Retries submissions whose stitch never finished — a transcode killed by a
 * deploy, or a source URL that was briefly unreachable. Without this an
 * approved planting could sit forever serving the raw clip as its NFT
 * animation, which is exactly the bug this service exists to fix.
 */
export async function retryPendingStitches(limit = 2): Promise<number> {
  const pending = await Submission.find(
    {
      status: 'approved',
      'plant.stitchedAt': { $exists: false },
      'plant.stitchStatus': { $in: ['processing', 'failed'] },
    },
    { _id: 1 },
  )
    .sort({ reviewedAt: 1 })
    .limit(limit)
    .lean()

  let done = 0
  for (const doc of pending) {
    const result = await stitchVerifiedVideo(String(doc._id))
    if (result.status === 'done') done += 1
  }
  return done
}

export function startStitchRetrier(intervalMs = 10 * 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    void retryPendingStitches()
      .catch(error =>
        console.error('[Stitch] retry sweep failed', error?.message),
      )
      .finally(() => {
        sweeping = false
      })
  }, intervalMs)
  timer.unref()
  return timer
}
