/**
 * Label bars and end card for the verified-planting stitcher, rendered as
 * PNGs and composited by ffmpeg's `overlay`.
 *
 * Why not ffmpeg's own `drawtext`: the Linux `ffmpeg-static` build has no
 * such filter. It reports `No such filter: 'drawtext'` on Render while the
 * macOS build of the same package renders it happily — which is exactly the
 * trap `video-stitch/make_labels.py` was written to avoid, using Pillow.
 * This is that same design in Node, so the pipeline behaves identically on a
 * laptop and in the container.
 *
 * pureimage is pure JavaScript: no node-gyp, no prebuilt binary to go missing
 * on a platform we did not test.
 */
import { createWriteStream } from 'fs'
import path from 'path'
import * as pi from 'pureimage'

/** treegens.org palette, same values as video-stitch/make_labels.py. */
const LEAF = '#D1ED6E'
const OLIVE = '#9FB857'
const EVERGREEN = '#1D472A'
/** Label bars sit on evergreen at the reference tool's 200/255 alpha. */
const BOX = 'rgba(29,71,42,0.784)'

const FONT_FAMILY = 'TreegensLabel'
let fontReady = false

function ensureFont(): void {
  if (fontReady) return
  // Bundled as a dependency: a Linux container has no system fonts, and
  // relying on fontconfig would render differently per host.
  const file = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf')
  pi.registerFont(file, FONT_FAMILY).loadSync()
  fontReady = true
}

function write(bitmap: pi.Bitmap, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(file)
    pi.encodePNGToStream(bitmap, stream).then(() => resolve(), reject)
  })
}

/** A rounded-off label bar: leaf text on a translucent evergreen box. */
async function bar(text: string, size: number, file: string): Promise<void> {
  ensureFont()
  const padX = 18
  const padY = 10
  const probe = pi.make(1, 1).getContext('2d')
  probe.font = `${size}pt '${FONT_FAMILY}'`
  const textWidth = Math.ceil(probe.measureText(text).width)
  const height = Math.round(size * 2.6) + padY * 2
  const img = pi.make(textWidth + padX * 2, height)
  const ctx = img.getContext('2d')
  ctx.fillStyle = BOX
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.fillStyle = LEAF
  ctx.font = `${size}pt '${FONT_FAMILY}'`
  ctx.fillText(text, padX, Math.round(size * 1.9) + padY)
  await write(img, file)
}

/** Centre one line of text on an existing context. */
function centreText(
  ctx: pi.Context,
  text: string,
  size: number,
  y: number,
  colour: string,
  canvasWidth: number,
): void {
  ctx.font = `${size}pt '${FONT_FAMILY}'`
  ctx.fillStyle = colour
  const w = ctx.measureText(text).width
  ctx.fillText(text, Math.round((canvasWidth - w) / 2), y)
}

export type LabelSet = {
  badge: string
  before: string
  after: string
  endCard: string
}

/**
 * Render every still the filtergraph needs. `logoPath` is composited into the
 * end card here rather than by ffmpeg, so the card is a single input.
 */
export async function renderLabels(opts: {
  workDir: string
  plotLabel: string
  afterText: string
  logoPath: string
  width: number
  height: number
}): Promise<LabelSet> {
  ensureFont()
  const out = {
    badge: path.join(opts.workDir, 'badge.png'),
    before: path.join(opts.workDir, 'label_before.png'),
    after: path.join(opts.workDir, 'label_after.png'),
    endCard: path.join(opts.workDir, 'endcard.png'),
  }

  await bar(opts.plotLabel, 22, out.badge)
  await bar('BEFORE — RAW PLOT FOOTAGE', 26, out.before)
  await bar(opts.afterText, 26, out.after)

  const card = pi.make(opts.width, opts.height)
  const ctx = card.getContext('2d')
  ctx.fillStyle = EVERGREEN
  ctx.fillRect(0, 0, opts.width, opts.height)

  try {
    const logo = await pi.decodePNGFromStream(
      (await import('fs')).createReadStream(opts.logoPath),
    )
    const logoWidth = 300
    const logoHeight = Math.round((logo.height * logoWidth) / logo.width)
    ctx.drawImage(
      logo,
      0,
      0,
      logo.width,
      logo.height,
      Math.round((opts.width - logoWidth) / 2),
      150,
      logoWidth,
      logoHeight,
    )
  } catch {
    // A missing logo must not cost us the whole end card — the wordmark below
    // still carries the brand and the claim.
    centreText(ctx, 'TREEGENS', 40, 240, LEAF, opts.width)
  }

  centreText(ctx, 'VERIFIED BY AI · FUNDED BY $MGRO', 30, 360, LEAF, opts.width)
  centreText(ctx, 'treegens.org', 22, 410, OLIVE, opts.width)
  await write(card, out.endCard)

  return out
}
