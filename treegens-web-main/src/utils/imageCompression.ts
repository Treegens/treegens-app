const MAX_EDGE_PX = 1600
const JPEG_QUALITY = 0.8
/** Photos under this size go up as they are. */
const SKIP_BELOW_BYTES = 600 * 1024

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
 * (quality 0.8). Returns the original file when it is already small, when
 * the browser cannot decode it (e.g. HEIC outside Safari), or on any error.
 */
export async function compressImage(file: File): Promise<File> {
  if (file.size < SKIP_BELOW_BYTES || !canDecodeImages()) return file
  try {
    const blob = await downscale(file)
    if (!blob || blob.size >= file.size) return file
    return new File([blob], toJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })
  } catch (e) {
    console.warn('Photo compression failed, uploading the original', e)
    return file
  }
}
