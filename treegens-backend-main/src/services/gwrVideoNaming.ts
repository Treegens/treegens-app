/**
 * Pure helpers for the GWR clip collection: the on-disk filename each clip
 * downloads under, and the CSV manifest. Kept free of I/O so they are easy to
 * test and the route stays thin.
 */

export const GWR_STORAGE_PREFIX = 'gwr/'

/**
 * The only extensions a clip is stored and served under. The uploader's
 * filename is taken at its word ONLY when it ends in one of these: the
 * public URL is fed to bulk downloaders (wget -i, "Download all"), so a
 * `.exe` or `.hta` with a video/* part type must never reach anyone's disk
 * under that name. Anything else falls back to the declared MIME type, then
 * to mp4.
 */
export const GWR_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
})

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
})

/** Filename extension to store the clip under, derived from the upload. */
export function gwrFileExtension(
  originalFilename: string | undefined,
  mimeType: string | undefined,
): string {
  const fromName = (originalFilename || '')
    .toLowerCase()
    .match(/\.([a-z0-9]{2,5})$/)?.[1]
  if (fromName && GWR_EXTENSIONS[fromName]) return fromName
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()
  return MIME_TO_EXTENSION[mime] || 'mp4'
}

/** The MIME type the object is served with: from OUR extension, never the
 * uploader's declared part type. */
export function gwrMimeForExtension(extension: string): string {
  return GWR_EXTENSIONS[extension] || 'video/mp4'
}

/** Lower-case, ascii, dash-separated; empty when nothing usable is left. */
export function slugify(input: string | undefined, maxLength = 40): string {
  if (!input) return ''
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, maxLength).replace(/-+$/g, '')
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** `20261107-143012` in UTC — sorts chronologically in any file browser. */
export function utcStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  )
}

/**
 * `treegens-gwr-20261107-143012-jimi-3f9a2c.mp4`
 * Timestamp first so a folder of downloads lists in filming order, then the
 * uploader's name (when given), then a short unique tail so two clips uploaded
 * in the same second never collide.
 */
export function buildGwrDownloadFilename(params: {
  uploadedAt: Date
  uploaderName?: string
  uniqueId: string
  extension: string
}): string {
  const name = slugify(params.uploaderName)
  const tail = params.uniqueId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 6)
    .toLowerCase()
  const parts = [
    'treegens-gwr',
    utcStamp(params.uploadedAt),
    name,
    tail,
  ].filter(Boolean)
  return `${parts.join('-')}.${params.extension}`
}

/**
 * RFC 4180-style escaping, plus the spreadsheet guard: a cell that starts
 * with `=`, `+`, `-`, `@` or a tab/CR is prefixed with an apostrophe so
 * Excel / Sheets show it as text instead of running it as a formula. The
 * uploader name and note come from an open form, and the manifest is made to
 * be opened in a spreadsheet.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  // Only text: a negative number is a number, not a formula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export interface GwrManifestRow {
  downloadFilename: string
  publicUrl: string
  uploadedAt: Date | string
  uploaderName?: string | null
  latitude?: number | null
  longitude?: number | null
  accuracyMeters?: number | null
  reverseGeocode?: string | null
  sizeBytes?: number | null
  note?: string | null
}

export const GWR_MANIFEST_HEADER = [
  'filename',
  'uploaded_at_utc',
  'uploader',
  'latitude',
  'longitude',
  'gps_accuracy_m',
  'location',
  'size_bytes',
  'note',
  'url',
]

export function buildGwrManifestCsv(rows: GwrManifestRow[]): string {
  const lines = [GWR_MANIFEST_HEADER.join(',')]
  for (const r of rows) {
    const uploadedAt =
      r.uploadedAt instanceof Date ? r.uploadedAt : new Date(r.uploadedAt)
    lines.push(
      [
        r.downloadFilename,
        Number.isNaN(uploadedAt.getTime()) ? '' : uploadedAt.toISOString(),
        r.uploaderName ?? '',
        r.latitude ?? '',
        r.longitude ?? '',
        r.accuracyMeters ?? '',
        r.reverseGeocode ?? '',
        r.sizeBytes ?? '',
        r.note ?? '',
        r.publicUrl,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
