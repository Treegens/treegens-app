'use client'

import cn from 'classnames'
import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { GrLocation } from 'react-icons/gr'
import { HiArrowPath, HiCheckCircle } from 'react-icons/hi2'
import { IoVideocamOutline } from 'react-icons/io5'
import { MdClose } from 'react-icons/md'
import { routes } from '@/config/appConfig'
import { useGeolocation } from '@/hooks/useGeolocation'
import type { ReverseGeocodeResult } from '@/services/geocodingService'
import { reverseGeocode } from '@/services/geocodingService'
import {
  gwrErrorMessage,
  gwrService,
  isUploadCodeRefusal,
  type GwrConfig,
  type GwrVideo,
} from '@/services/gwrService'
import { getVideoDuration } from '@/utils/videoValidation'

const NAME_STORAGE_KEY = 'tg_gwr_uploader_name'

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'done'; video: GwrVideo }

/** A picked clip and the id every attempt to send it will carry. */
type Picked = { file: File; uploadId: string; previewUrl: string }

const newUploadId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * treegens.app/gwr — the "after" upload, and only that.
 *
 * Built for the Guinness World Record attempt: anyone on site films the trees
 * once they are in the ground and hands the clip in here. No wallet, no before
 * clip, no verifiers, no MGRO. Clips land in /gwr-vids for download.
 *
 * ⚠️ Deliberately NOT a planting-evidence screen, so the record-only rule
 * (utils/recordOnly.ts, utils/verifierDesktop.ts) does not apply here: a
 * GWR clip is not verified and earns nothing, and the record's footage,
 * drone shots included, is mostly filmed before this page is opened. So this
 * video input may open the gallery and renders on a computer. It must never
 * be wired into submissions.
 */
export default function GwrAfterUploadPage() {
  const [config, setConfig] = useState<GwrConfig | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [durationSec, setDurationSec] = useState<number | null>(null)
  const [uploaderName, setUploaderName] = useState('')
  const [note, setNote] = useState('')
  const [uploadCode, setUploadCode] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [uploadError, setUploadError] = useState('')
  const [uploadCount, setUploadCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    latitude,
    longitude,
    accuracy,
    loading: locationLoading,
    error: locationError,
    getCurrentPosition,
    isSupported: geoSupported,
  } = useGeolocation({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 10000,
  })
  const [geocode, setGeocode] = useState<ReverseGeocodeResult | null>(null)
  const triedLocation = useRef(false)

  const loadConfig = useCallback(async () => {
    const c = await gwrService.getConfig()
    if (c) setConfig(c)
    return c
  }, [])

  useEffect(() => {
    void loadConfig()
    try {
      const saved = window.localStorage.getItem(NAME_STORAGE_KEY)
      if (saved) setUploaderName(saved)
    } catch {
      /* private mode: nothing to restore */
    }
  }, [loadConfig])

  useEffect(() => {
    if (geoSupported && !triedLocation.current) {
      triedLocation.current = true
      getCurrentPosition()
    }
  }, [geoSupported, getCurrentPosition])

  useEffect(() => {
    if (latitude === null || longitude === null) return
    let cancelled = false
    reverseGeocode(latitude, longitude, { zoom: 16, language: 'en' })
      .then(r => {
        if (!cancelled) setGeocode(r)
      })
      .catch(() => {
        if (!cancelled) setGeocode(null)
      })
    return () => {
      cancelled = true
    }
  }, [latitude, longitude])

  // The preview URL follows the picked clip; let go of the old one.
  useEffect(() => {
    const url = picked?.previewUrl
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [picked])

  const busy = phase.kind === 'uploading'

  // While a clip is in flight the browser asks before a close or reload: a
  // navigation kills the request.
  useEffect(() => {
    if (!busy) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])

  const hasLocation = latitude !== null && longitude !== null && !locationError

  const locationLabel = useMemo(() => {
    if (locationLoading) return 'Getting location…'
    if (locationError) return 'Location unavailable (the clip still uploads)'
    if (latitude === null || longitude === null) return 'No location yet'
    const short = geocode?.success
      ? geocode.shortAddress || geocode.address
      : ''
    const coords = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
    return short ? `${short} · ${coords}` : coords
  }, [locationLoading, locationError, latitude, longitude, geocode])

  const clearFile = useCallback(() => {
    setPicked(null)
    setDurationSec(null)
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError('')
    if (phase.kind === 'done') setPhase({ kind: 'idle' })
    // Show the clip at once; the length is filled in when the browser has
    // read the header, which on some phones takes seconds or never happens.
    const next: Picked = {
      file,
      uploadId: newUploadId(),
      previewUrl: URL.createObjectURL(file),
    }
    setPicked(next)
    setDurationSec(null)
    getVideoDuration(file)
      .then(d => {
        setDurationSec(prev => (Number.isFinite(d) ? d : prev))
      })
      .catch(() => {
        // Nothing is refused for it: the clip is what it is.
      })
  }

  const handleUpload = async () => {
    if (!picked || busy) return
    setUploadError('')

    try {
      window.localStorage.setItem(NAME_STORAGE_KEY, uploaderName.trim())
    } catch {
      /* ignore */
    }

    // Never assume "no code needed" just because the config fetch failed
    // earlier: ask once more now, and send whatever code was typed anyway.
    const cfg = config ?? (await loadConfig())
    if (cfg?.uploadCodeRequired && !uploadCode.trim()) {
      setUploadError('Enter the upload code you were given at the record.')
      return
    }

    try {
      setPhase({ kind: 'uploading', progress: 0 })
      const video = await gwrService.uploadClip(
        picked.file,
        {
          uploadId: picked.uploadId,
          latitude: hasLocation ? latitude : null,
          longitude: hasLocation ? longitude : null,
          accuracyMeters: hasLocation ? accuracy : null,
          reverseGeocode: geocode?.success ? geocode.address : undefined,
          uploaderName,
          note,
          recordedAt: picked.file.lastModified
            ? new Date(picked.file.lastModified)
            : null,
          uploadCode,
        },
        percent => setPhase({ kind: 'uploading', progress: percent }),
      )
      setPhase({ kind: 'done', video })
      setUploadCount(n => n + 1)
      clearFile()
      setNote('')
      toast.success('Clip saved. Thank you!')
    } catch (err) {
      setPhase({ kind: 'idle' })
      if (isUploadCodeRefusal(err)) {
        // The API wants a code whatever the config said: show the field.
        setConfig(c => ({
          uploadCodeRequired: true,
          adminEnabled: c?.adminEnabled ?? false,
          maxFileSizeMB: c?.maxFileSizeMB ?? null,
          maxDurationSeconds: c?.maxDurationSeconds ?? null,
        }))
        setUploadError(
          uploadCode.trim()
            ? 'That upload code is not right. Check it and tap Upload again.'
            : 'This upload needs the code given out at the record. Enter it below and tap Upload again.',
        )
        return
      }
      setUploadError(gwrErrorMessage(err, 'Upload failed. Please try again.'))
    }
  }

  // Code field: shown when the API asks for one, and also while the API has
  // not answered yet, so a volunteer who was given a code can type it.
  const showCodeField = config === null || config.uploadCodeRequired
  const canUpload = !!picked && !busy

  return (
    <div className="relative flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-100 bg-white px-4 py-3">
        <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-full">
          <Image
            src="/img/treegens-logo.svg"
            alt="Treegens"
            fill
            sizes="36px"
            className="object-cover"
            priority
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-tree-green-1">
            Guinness World Record attempt
          </p>
          <h1 className="truncate text-lg font-bold text-gray-900">
            After video
          </h1>
        </div>
        {busy ? (
          <span className="shrink-0 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-400">
            All videos
          </span>
        ) : (
          <Link
            href={routes.GwrVids}
            className="shrink-0 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-tree-green-2 hover:bg-gray-50"
          >
            All videos
          </Link>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 pb-28 pt-4">
        <p className="mb-5 text-sm text-gray-700">
          Film the trees you planted at the record, then upload the clip here.
          No account needed. Nothing else to do.
        </p>

        <div className="mb-5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <GrLocation
              className={cn(
                'h-[18px] w-[18px] shrink-0 text-tree-green-2',
                locationLoading && 'animate-pulse',
                locationError && 'text-amber-600',
              )}
            />
            <p className="min-w-0 flex-1 truncate text-sm text-gray-700">
              {locationLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={getCurrentPosition}
            className="shrink-0 rounded-full bg-gray-100 p-2 text-tree-green-2 hover:bg-gray-200"
            aria-label="Refresh location"
          >
            <HiArrowPath className="h-[18px] w-[18px]" />
          </button>
        </div>

        {phase.kind === 'done' ? (
          <section className="mb-5 rounded-xl border border-green-200 bg-green-50 px-4 py-4">
            <div className="flex items-start gap-3">
              <HiCheckCircle className="mt-0.5 h-6 w-6 shrink-0 text-green-700" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-green-900">
                  Clip {uploadCount} saved
                </p>
                <p className="mt-1 break-all text-xs text-green-800">
                  {phase.video.downloadFilename}
                </p>
                <p className="mt-2 text-sm text-green-900">
                  Got another angle? Pick the next clip below.{' '}
                  <Link
                    href={routes.GwrVids}
                    className="font-semibold underline"
                  >
                    See all videos
                  </Link>
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="mb-5">
          <h2 className="mb-1 text-base font-semibold text-gray-800">
            After video (planted trees)
          </h2>
          <p className="mb-3 text-sm text-gray-700">
            Record now or pick a clip you already filmed. Any length, original
            quality, straight from your phone or a drone.
          </p>

          {picked ? (
            <div className="relative aspect-[2/1] w-full overflow-hidden rounded-xl bg-black shadow-md">
              <video
                key={picked.previewUrl}
                preload="metadata"
                className="h-full w-full object-contain"
                controls
                playsInline
                src={picked.previewUrl}
              />
              {!busy ? (
                <button
                  type="button"
                  onClick={clearFile}
                  className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 p-1.5 shadow"
                  aria-label="Remove video"
                >
                  <MdClose className="h-6 w-6 text-brown-2" />
                </button>
              ) : null}
            </div>
          ) : (
            <label className="relative flex aspect-[2/1] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-[#f7fbf3] shadow-md">
              <IoVideocamOutline
                className="pointer-events-none h-10 w-10 text-tree-green-2"
                aria-hidden
              />
              <span className="pointer-events-none text-sm font-medium text-tree-green-2">
                Record or choose a clip
              </span>
              {/* No capture="environment" on purpose: see the note at the top
                  of this file, and the matching exception in scripts/verify.mjs. */}
              <input
                ref={inputRef}
                className="absolute inset-0 cursor-pointer opacity-0"
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                disabled={busy}
              />
            </label>
          )}

          {picked ? (
            <p className="mt-2 text-xs text-gray-700">
              {(picked.file.size / (1024 * 1024)).toFixed(1)} MB
              {durationSec !== null ? ` · ${Math.round(durationSec)}s` : ''}
              {picked.file.name ? ` · ${picked.file.name}` : ''}
            </p>
          ) : null}
        </section>

        <section className="mb-6 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Your name{' '}
              <span className="font-normal text-gray-500">(optional)</span>
            </span>
            <input
              type="text"
              value={uploaderName}
              onChange={e => setUploaderName(e.target.value)}
              maxLength={120}
              autoComplete="name"
              placeholder="So we know who filmed it"
              disabled={busy}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-tree-green-2"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Note <span className="font-normal text-gray-500">(optional)</span>
            </span>
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={500}
              placeholder="Row, section, anything useful"
              disabled={busy}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-tree-green-2"
            />
          </label>
          {showCodeField ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Upload code{' '}
                {config === null ? (
                  <span className="font-normal text-gray-500">
                    (if you were given one)
                  </span>
                ) : null}
              </span>
              <input
                type="text"
                value={uploadCode}
                onChange={e => setUploadCode(e.target.value)}
                maxLength={200}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="Given out at the record site"
                disabled={busy}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-tree-green-2"
              />
            </label>
          ) : null}
        </section>

        {phase.kind === 'uploading' ? (
          <section className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="mb-1 flex items-center justify-between text-xs text-gray-700">
              <span className="font-medium">
                {phase.progress >= 100 ? 'Saving on the server…' : 'Uploading'}
              </span>
              <span>{Math.min(100, Math.max(0, phase.progress))}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-2 rounded-full bg-green-600 transition-[width] duration-200"
                style={{
                  width: `${Math.min(100, Math.max(0, phase.progress))}%`,
                }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-700">
              Keep the screen on and this page open until you see “Clip saved”.
              A big clip on event wifi can take a few minutes, and the server
              needs a moment after 100%.
            </p>
          </section>
        ) : null}

        {uploadError ? (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {uploadError}
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleUpload}
          disabled={!canUpload}
          className={cn(
            'w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white transition-colors',
            canUpload
              ? 'bg-tree-green-2 hover:bg-tree-green-3'
              : 'cursor-not-allowed bg-gray-300',
          )}
        >
          {busy
            ? 'Uploading…'
            : uploadError && picked
              ? 'Try the upload again'
              : 'Upload after video'}
        </button>

        {!hasLocation && !locationLoading ? (
          <p className="mt-3 text-center text-xs text-gray-500">
            Location helps the record evidence. Allow it if your phone asks,
            then tap the refresh icon.
          </p>
        ) : null}
      </main>
    </div>
  )
}
