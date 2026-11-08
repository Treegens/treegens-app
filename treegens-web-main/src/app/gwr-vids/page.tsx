'use client'

import cn from 'classnames'
import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { HiArrowDownTray, HiArrowPath, HiTrash } from 'react-icons/hi2'
import { routes } from '@/config/appConfig'
import {
  gwrErrorMessage,
  gwrService,
  type GwrConfig,
  type GwrVideo,
} from '@/services/gwrService'
import { formatTimeAgo } from '@/utils/timeAgo'

const PAGE_SIZE = 50
const ADMIN_KEY_STORAGE = 'tg_gwr_admin_key'

function formatBytes(n?: number) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  const mb = n / (1024 * 1024)
  return mb >= 1
    ? `${mb.toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`
}

function formatWhen(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * treegens.app/gwr-vids — every after-clip from the record attempt, with a
 * download link per clip and whole-collection exports. Public: no login.
 * Renders wide on a computer (MobileGate): this is where the set gets pulled
 * down for the record evidence.
 */
export default function GwrVideosPage() {
  const [config, setConfig] = useState<GwrConfig | null>(null)
  const [videos, setVideos] = useState<GwrVideo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adminKey, setAdminKey] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [downloadingAll, setDownloadingAll] = useState(false)

  const load = useCallback(async (nextPage: number, replace: boolean) => {
    setLoading(true)
    setError('')
    try {
      const res = await gwrService.listVideos(nextPage, PAGE_SIZE)
      const { videos: batch, pagination } = res.data
      // A clip uploaded between two pages shifts the next page by one; keep
      // each clip once.
      setVideos(prev => {
        if (replace) return batch
        const seen = new Set(prev.map(v => v.id))
        return [...prev, ...batch.filter(v => !seen.has(v.id))]
      })
      setTotal(pagination.total)
      setPage(pagination.page)
      setHasMore(pagination.page < pagination.totalPages)
    } catch (err) {
      setError(gwrErrorMessage(err, 'Could not load the videos.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void gwrService.getConfig().then(setConfig)
    void load(1, true)
    try {
      setAdminKey(window.sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? '')
    } catch {
      /* ignore */
    }
  }, [load])

  const enterAdmin = async () => {
    const key = window.prompt('GWR admin key')?.trim()
    if (!key) return
    // Checked first, so a wrong key never shows delete buttons that fail.
    try {
      const ok = await gwrService.checkAdminKey(key)
      if (!ok) {
        toast.error('That admin key is not right.')
        return
      }
    } catch (err) {
      toast.error(gwrErrorMessage(err, 'Could not check the key.'))
      return
    }
    setAdminKey(key)
    try {
      window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key)
    } catch {
      /* ignore */
    }
  }

  const leaveAdmin = () => {
    setAdminKey('')
    try {
      window.sessionStorage.removeItem(ADMIN_KEY_STORAGE)
    } catch {
      /* ignore */
    }
  }

  const handleDelete = async (v: GwrVideo) => {
    if (!adminKey) return
    const ok = window.confirm(
      `Delete ${v.downloadFilename}? This removes the file for good.`,
    )
    if (!ok) return
    setDeletingId(v.id)
    try {
      await gwrService.deleteVideo(v.id, adminKey)
      setVideos(prev => prev.filter(x => x.id !== v.id))
      setTotal(t => Math.max(0, t - 1))
      toast.success('Clip removed')
    } catch (err) {
      toast.error(gwrErrorMessage(err, 'Could not remove the clip.'))
    } finally {
      setDeletingId(null)
    }
  }

  /**
   * Fires one download per loaded clip, staggered so the browser queues them
   * instead of dropping some. Chrome asks once to allow multiple downloads.
   */
  const downloadAllLoaded = async () => {
    if (!videos.length || downloadingAll) return
    setDownloadingAll(true)
    try {
      for (const v of videos) {
        const a = document.createElement('a')
        a.href = v.downloadUrl
        a.download = v.downloadFilename
        a.rel = 'noopener'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        a.remove()
        await new Promise(r => setTimeout(r, 700))
      }
      toast.success(
        `Started ${videos.length} download${videos.length === 1 ? '' : 's'}`,
      )
    } finally {
      setDownloadingAll(false)
    }
  }

  const adminMode = !!adminKey

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
            After videos{total ? ` · ${total}` : ''}
          </h1>
        </div>
        <Link
          href={routes.Gwr}
          className="shrink-0 rounded-full bg-tree-green-2 px-3 py-1.5 text-xs font-semibold text-white hover:bg-tree-green-3"
        >
          Upload
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-4 md:px-6">
        <section className="mb-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={downloadAllLoaded}
            disabled={!videos.length || downloadingAll}
            className="inline-flex items-center gap-1.5 rounded-full bg-tree-green-2 px-4 py-2 text-sm font-semibold text-white hover:bg-tree-green-3 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            <HiArrowDownTray className="h-4 w-4" />
            {downloadingAll
              ? 'Starting downloads…'
              : `Download all loaded (${videos.length})`}
          </button>
          <a
            href={gwrService.manifestUrl()}
            className="rounded-full border border-gray-200 px-4 py-2 text-sm font-semibold text-tree-green-2 hover:bg-gray-50"
          >
            Manifest (CSV)
          </a>
          <a
            href={gwrService.urlListUrl()}
            className="rounded-full border border-gray-200 px-4 py-2 text-sm font-semibold text-tree-green-2 hover:bg-gray-50"
          >
            URL list (.txt)
          </a>
          <button
            type="button"
            onClick={() => load(1, true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            aria-label="Refresh"
          >
            <HiArrowPath className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </button>
          {config?.adminEnabled ? (
            <button
              type="button"
              onClick={adminMode ? leaveAdmin : enterAdmin}
              className="ml-auto rounded-full px-3 py-2 text-xs font-semibold text-gray-500 hover:text-gray-800"
            >
              {adminMode ? 'Exit manage mode' : 'Manage'}
            </button>
          ) : null}
        </section>

        <p className="mb-4 text-xs text-gray-500">
          Each file downloads as{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5">
            treegens-gwr-&lt;date-time&gt;-&lt;name&gt;-&lt;id&gt;.mp4
          </code>
          , so a folder of them sorts in filming order. For the whole set from a
          terminal:{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5">
            wget --content-disposition -i treegens-gwr-urls.txt
          </code>
        </p>

        {error ? (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {!loading && !error && videos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 px-6 py-12 text-center">
            <p className="text-base font-semibold text-gray-700">
              No clips yet
            </p>
            <p className="mt-1 text-sm text-gray-500">
              The first after video uploaded at{' '}
              <Link
                href={routes.Gwr}
                className="font-semibold text-tree-green-2 underline"
              >
                treegens.app/gwr
              </Link>{' '}
              shows up here.
            </p>
          </div>
        ) : null}

        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map(v => (
            <li
              key={v.id}
              className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
            >
              <div className="aspect-video w-full bg-black">
                <video
                  src={v.publicUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1 px-3 py-3">
                <p className="text-sm font-semibold text-gray-900">
                  {v.uploaderName || 'Unnamed'}
                  <span className="font-normal text-gray-500">
                    {' · '}
                    <time
                      dateTime={v.uploadedAt}
                      title={formatWhen(v.uploadedAt)}
                    >
                      {formatTimeAgo(v.uploadedAt)}
                    </time>
                  </span>
                </p>
                <p className="text-xs text-gray-500">
                  {formatWhen(v.uploadedAt)}
                </p>
                {v.reverseGeocode || v.gpsCoordinates ? (
                  <p
                    className="truncate text-xs text-gray-700"
                    title={v.reverseGeocode}
                  >
                    {v.reverseGeocode ||
                      `${v.gpsCoordinates!.latitude.toFixed(5)}, ${v.gpsCoordinates!.longitude.toFixed(5)}`}
                    {v.gpsCoordinates
                      ? ` (${v.gpsCoordinates.latitude.toFixed(4)}, ${v.gpsCoordinates.longitude.toFixed(4)})`
                      : ''}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">No location</p>
                )}
                {v.note ? (
                  <p className="text-xs text-gray-700">“{v.note}”</p>
                ) : null}
                <p className="mt-1 break-all font-mono text-[11px] text-gray-500">
                  {v.downloadFilename}
                  {v.sizeBytes ? ` · ${formatBytes(v.sizeBytes)}` : ''}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <a
                    href={v.downloadUrl}
                    download={v.downloadFilename}
                    rel="noopener"
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-tree-green-2 px-3 py-2 text-sm font-semibold text-white hover:bg-tree-green-3"
                  >
                    <HiArrowDownTray className="h-4 w-4" />
                    Download
                  </a>
                  {adminMode ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(v)}
                      disabled={deletingId === v.id}
                      className="inline-flex items-center justify-center rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
                      aria-label="Delete clip"
                    >
                      <HiTrash className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {hasMore ? (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => load(page + 1, false)}
              disabled={loading}
              className="rounded-full border border-gray-200 px-5 py-2.5 text-sm font-semibold text-tree-green-2 hover:bg-gray-50 disabled:opacity-60"
            >
              {loading
                ? 'Loading…'
                : `Load more (${videos.length} of ${total})`}
            </button>
          </div>
        ) : null}
        {loading && videos.length === 0 ? (
          <p className="mt-6 text-center text-sm text-gray-500">Loading…</p>
        ) : null}
      </main>
    </div>
  )
}
