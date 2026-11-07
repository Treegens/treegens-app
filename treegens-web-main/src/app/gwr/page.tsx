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
  gwrService,
  type GwrConfig,
  type GwrVideo,
} from '@/services/gwrService'
import { videoCompressionService } from '@/services/videoCompressionService'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { getVideoDuration } from '@/utils/videoValidation'

const NAME_STORAGE_KEY = 'tg_gwr_uploader_name'

type Phase =
  | { kind: 'idle' }
  | { kind: 'compressing'; progress: number; message: string }
  | { kind: 'uploading'; progress: number }
  | { kind: 'done'; video: GwrVideo }

/**
 * treegens.app/gwr — the "after" upload, and only that.
 *
 * Built for the Guinness World Record attempt: anyone on site films the trees
 * once they are in the ground and hands the clip in here. No wallet, no before
 * clip, no verifiers, no MGRO. Clips land in /gwr-vids for download.
 */
export default function GwrAfterUploadPage() {
  const [config, setConfig] = useState<GwrConfig | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [durationSec, setDurationSec] = useState<number | null>(null)
  const [validationError, setValidationError] = useState('')
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

  useEffect(() => {
    void gwrService.getConfig().then(setConfig)
    try {
      const saved = window.localStorage.getItem(NAME_STORAGE_KEY)
      if (saved) setUploaderName(saved)
    } catch {
      /* private mode: nothing to restore */
    }
  }, [])

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

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const maxDuration = config?.maxDurationSeconds ?? 60
  const maxSizeMB = config?.maxFileSizeMB ?? 100
  const hasLocation = latitude !== null && longitude !== null && !locationError
  const busy = phase.kind === 'compressing' || phase.kind === 'uploading'

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
    setFile(null)
    setDurationSec(null)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl('')
    if (inputRef.current) inputRef.current.value = ''
  }, [previewUrl])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    if (!picked) return
    setValidationError('')
    setUploadError('')
    if (phase.kind === 'done') setPhase({ kind: 'idle' })

    let duration: number | null = null
    try {
      duration = await getVideoDuration(picked)
    } catch {
      // Some phones hand over a container the browser cannot probe; let the
      // backend's size cap be the only hard limit then.
    }
    if (duration !== null && duration > maxDuration + 0.5) {
      setValidationError(
        `That clip is ${Math.round(duration)}s. Keep it under ${maxDuration} seconds so it stays uploadable on event wifi.`,
      )
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(picked)
    setDurationSec(duration)
    setPreviewUrl(URL.createObjectURL(picked))
  }

  const handleUpload = async () => {
    if (!file || busy) return
    setUploadError('')
    setValidationError('')

    try {
      window.localStorage.setItem(NAME_STORAGE_KEY, uploaderName.trim())
    } catch {
      /* ignore */
    }

    let toSend = file
    const sizeMB = file.size / (1024 * 1024)
    try {
      // Originals are what the record needs, so only compress when the clip
      // would otherwise be refused by the 100MB cap.
      if (sizeMB > maxSizeMB) {
        setPhase({
          kind: 'compressing',
          progress: 0,
          message: `Clip is ${sizeMB.toFixed(0)}MB — shrinking it to fit the ${maxSizeMB}MB limit…`,
        })
        const result = await videoCompressionService.compressVideo(file, p =>
          setPhase({
            kind: 'compressing',
            progress: p.progress,
            message: p.message,
          }),
        )
        if (!result.success || !result.compressedFile) {
          throw new Error(
            result.error ||
              `Could not shrink the clip under ${maxSizeMB}MB. Try a shorter clip or lower camera resolution.`,
          )
        }
        toSend = result.compressedFile
        if (toSend.size / (1024 * 1024) > maxSizeMB) {
          throw new Error(
            `Still ${(toSend.size / (1024 * 1024)).toFixed(0)}MB after compression. Try a shorter clip.`,
          )
        }
      }

      setPhase({ kind: 'uploading', progress: 0 })
      const video = await gwrService.uploadClip(
        toSend,
        {
          latitude: hasLocation ? latitude : null,
          longitude: hasLocation ? longitude : null,
          accuracyMeters: hasLocation ? accuracy : null,
          reverseGeocode: geocode?.success ? geocode.address : undefined,
          uploaderName,
          note,
          recordedAt: file.lastModified ? new Date(file.lastModified) : null,
          uploadCode: config?.uploadCodeRequired ? uploadCode : undefined,
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
      setUploadError(apiErrorMessage(err, 'Upload failed. Please try again.'))
    }
  }

  const canUpload =
    !!file && !busy && !(config?.uploadCodeRequired && !uploadCode.trim())

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
          <h1 className="truncate text-lg font-bold text-[#111]">
            After video
          </h1>
        </div>
        <Link
          href={routes.GwrVids}
          className="shrink-0 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-tree-green-2 hover:bg-gray-50"
        >
          All videos
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 pb-12 pt-4">
        <p className="mb-5 text-sm text-gray-600">
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
            <p className="min-w-0 flex-1 truncate text-sm text-gray-600">
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
                <p className="mt-1 break-all text-xs text-green-900/80">
                  {phase.video.downloadFilename}
                </p>
                <p className="mt-2 text-sm text-green-900/90">
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
          <p className="mb-3 text-sm text-gray-500">
            Up to {maxDuration} seconds. Original quality is kept; clips over{' '}
            {maxSizeMB}MB are shrunk on your phone first.
          </p>

          {file ? (
            <div className="relative aspect-[2/1] w-full overflow-hidden rounded-xl bg-black shadow-md">
              <video
                key={previewUrl}
                preload="metadata"
                className="h-full w-full object-contain"
                controls
                playsInline
                src={previewUrl}
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
                className="pointer-events-none h-10 w-10 text-[#435f24]"
                aria-hidden
              />
              <span className="pointer-events-none text-sm font-medium text-[#435f24]">
                Record or choose a clip
              </span>
              <input
                ref={inputRef}
                className="absolute inset-0 cursor-pointer opacity-0"
                type="file"
                accept="video/*"
                capture="environment"
                onChange={handleFileChange}
                disabled={busy}
              />
            </label>
          )}

          {file ? (
            <p className="mt-2 text-xs text-gray-500">
              {(file.size / (1024 * 1024)).toFixed(1)} MB
              {durationSec !== null ? ` · ${Math.round(durationSec)}s` : ''}
              {file.name ? ` · ${file.name}` : ''}
            </p>
          ) : null}
          {validationError ? (
            <p className="mt-2 text-sm text-red-600">{validationError}</p>
          ) : null}
        </section>

        <section className="mb-6 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Your name{' '}
              <span className="font-normal text-gray-400">(optional)</span>
            </span>
            <input
              type="text"
              value={uploaderName}
              onChange={e => setUploaderName(e.target.value)}
              maxLength={120}
              autoComplete="name"
              placeholder="So we know who filmed it"
              disabled={busy}
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-tree-green-2"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Note <span className="font-normal text-gray-400">(optional)</span>
            </span>
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={500}
              placeholder="Row, section, anything useful"
              disabled={busy}
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-tree-green-2"
            />
          </label>
          {config?.uploadCodeRequired ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Upload code
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
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-tree-green-2"
              />
            </label>
          ) : null}
        </section>

        {phase.kind === 'compressing' || phase.kind === 'uploading' ? (
          <section className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="mb-1 flex items-center justify-between text-xs text-gray-700">
              <span className="font-medium">
                {phase.kind === 'compressing' ? 'Shrinking clip' : 'Uploading'}
              </span>
              <span>{Math.min(100, Math.max(0, phase.progress))}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className={cn(
                  'h-2 rounded-full transition-[width] duration-200',
                  phase.kind === 'compressing' ? 'bg-blue-600' : 'bg-green-600',
                )}
                style={{
                  width: `${Math.min(100, Math.max(0, phase.progress))}%`,
                }}
              />
            </div>
            {phase.kind === 'compressing' ? (
              <p className="mt-1 text-xs text-gray-600">{phase.message}</p>
            ) : (
              <p className="mt-1 text-xs text-gray-600">
                Keep this page open until it reaches 100%.
              </p>
            )}
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
          {busy ? 'Please wait…' : 'Upload after video'}
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
