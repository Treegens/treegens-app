const MAX_EDGE_PX = 1600
const JPEG_QUALITY = 0.8
/** Photos under this size go up as they are, when every browser shows them. */
const SKIP_BELOW_BYTES = 600 * 1024
/**
 * Types the API stores that every browser can show. Anything else (HEIC,
 * GIF, AVIF, BMP...) is turned into a JPEG first: the API refuses most of
 * them, and HEIC only displays in Safari.
 */
const PASS_THROUGH_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const UNREADABLE_PHOTO_MESSAGE =
  'This photo format cannot be used. Take the photo with the camera, or choose a JPEG or PNG.'

function toJpegName(name: string) {
  const base = name.replace(/\.[^.]+$/, '') || 'photo'
  return `${base}.jpg`
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  )
}

function canDecodeImages() {
  return (
    typeof document !== 'undefined' && typeof createImageBitmap === 'function'
  )
}

async function downscale(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(
      1,
      MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvasToJpeg(canvas)
  } finally {
    bitmap.close()
  }
}

/**
 * Shrinks a camera photo to at most 1600 px on its long edge as a JPEG
 * (quality 0.8). A small JPEG, PNG or WebP goes up as it is, and so does a
 * bigger one when shrinking fails or does not help. Any other type must be
 * converted: when the browser cannot read it, this throws an Error with
 * UNREADABLE_PHOTO_MESSAGE instead of returning a file the API would refuse
 * or verifiers could not see.
 */
export async function compressImage(file: File): Promise<File> {
  const passThrough = PASS_THROUGH_TYPES.includes(file.type)
  if (passThrough && file.size < SKIP_BELOW_BYTES) return file
  if (!canDecodeImages()) {
    if (passThrough) return file
    throw new Error(UNREADABLE_PHOTO_MESSAGE)
  }
  let blob: Blob | null = null
  try {
    blob = await downscale(file)
  } catch (e) {
    console.warn('Photo compression failed', e)
  }
  if (!blob || (passThrough && blob.size >= file.size)) {
    if (passThrough) return file
    throw new Error(UNREADABLE_PHOTO_MESSAGE)
  }
  return new File([blob], toJpegName(file.name), {
    type: 'image/jpeg',
    lastModified: Date.now(),
  })
}
