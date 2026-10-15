'use client'

import Image from 'next/image'
import Link from 'next/link'
import { Tooltip } from '@/components/ui/Tooltip'
import { useState } from 'react'
import { HiPlay } from 'react-icons/hi2'
import { IoCloseCircle } from 'react-icons/io5'
import VideoModal from '@/components/Modals/VideoModal'
import { ClipStatusPill } from '@/components/ClipStatusPill'
import { SubmissionStatusBadges } from '@/components/submission-detail/SubmissionStatusBadges'
import { VideoType } from '@/services/videoService'
import type { ISubmissionAiVerification, IVideo } from '@/types'
import { ipfsGatewayUrl } from '@/utils/ipfsGatewayUrl'
import type { PlanterSubmissionBadge } from '@/utils/planterSubmissionBadge'
import { formatTimeAgo } from '@/utils/timeAgo'

export interface SubmissionCardProps {
  video: IVideo
  /** When set, the whole card links to this URL (submission detail). No in-card video controls so the surface is one tap target. */
  detailHref?: string
  status?: string
  statusMeta?: PlanterSubmissionBadge | null
  rewardClaimDisplay?: boolean | null
  /** Mangrove plant clip: show AI seedling count when available */
  aiVerification?: ISubmissionAiVerification
  /** Fallback species when clip mapper missed treeType (e.g. land-only preview) */
  treeSpecies?: string
  /** When land is uploaded but plant clip is missing */
  awaitingPlantClip?: boolean
  /** Link to finish step 2 (plant video) */
  completePlantHref?: string
  /** First verifier reason on a rejected submission; shown on the card itself. */
  rejectionReason?: string | null
}

function formatTreeCount(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

export default function SubmissionCard({
  video,
  detailHref,
  status,
  statusMeta = null,
  rewardClaimDisplay = null,
  aiVerification,
  treeSpecies,
  awaitingPlantClip = false,
  completePlantHref,
  rejectionReason = null,
}: SubmissionCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isVideoLoading, setIsVideoLoading] = useState(false)
  const [isVideoError, setIsVideoError] = useState(false)

  const ipfsVideoUrl = ipfsGatewayUrl(video.videoCID) ?? ''

  const isPlantClip = video.type === VideoType.PLANT
  const treeCountDisplay =
    video.treesPlanted != null && Number.isFinite(Number(video.treesPlanted))
      ? formatTreeCount(Math.max(0, Math.floor(Number(video.treesPlanted))))
      : null
  const speciesLabel = (video.treetype?.trim() || treeSpecies?.trim() || '')
  const isMangroveSpecies = speciesLabel.toLowerCase() === 'mangrove'
  const aiCounted =
    isMangroveSpecies &&
    aiVerification?.status === 'completed' &&
    typeof aiVerification.countedMangroves === 'number' &&
    Number.isFinite(aiVerification.countedMangroves)
      ? Math.max(0, Math.floor(aiVerification.countedMangroves))
      : null
  const showPlantOverlay = isPlantClip || awaitingPlantClip

  const locationText =
    video.reverseGeocode ||
    `${video.gpsCoordinates.latitude.toFixed(4)}, ${video.gpsCoordinates.longitude.toFixed(4)}`

  const timestamp = formatTimeAgo(video.createdAt)

  const cardClassName =
    'w-full rounded-2xl bg-white p-3 shadow-sm shadow-black/10'

  const mediaBlock = (
    <>
      <div className="relative w-full overflow-hidden rounded-xl bg-[#f3f4f6]">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#f3f4f6]">
          <video
            className="relative z-[2] h-full w-full cursor-pointer object-cover"
            preload="metadata"
            onLoadStart={() => {
              setIsVideoLoading(true)
              setIsVideoError(false)
            }}
            onLoadedData={() => setIsVideoLoading(false)}
            onError={() => {
              setIsVideoLoading(false)
              setIsVideoError(true)
            }}
            onClick={detailHref ? undefined : () => setIsModalOpen(true)}
            muted
            playsInline
            controls={!detailHref}
          >
            <source src={ipfsVideoUrl} type="video/mp4" />
            Your browser does not support the video tag.
          </video>

          {showPlantOverlay ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] flex flex-col bg-gradient-to-t from-black/92 via-black/55 to-transparent px-3 pb-3 pt-14">
              {awaitingPlantClip ? (
                <>
                  <span className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200/95">
                    After video needed
                  </span>
                  <p className="mt-1 text-sm font-bold leading-snug text-white">
                    {isMangroveSpecies
                      ? 'Upload after video for AI count'
                      : 'Upload after video to finish'}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <Image src="/img/tree.svg" alt="" width={16} height={16} />
                    <span className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-200/95">
                      {isMangroveSpecies
                        ? 'Mangroves declared'
                        : 'Trees planted'}
                    </span>
                  </div>
                  {aiCounted != null ? (
                    <p className="mt-1.5 text-[11px] font-bold uppercase tracking-wide text-sky-200">
                      AI counted{' '}
                      <span className="tabular-nums text-white">{aiCounted}</span>{' '}
                      in video
                    </p>
                  ) : isMangroveSpecies && aiVerification?.status === 'processing' ? (
                    <p className="mt-1.5 text-[11px] font-semibold text-sky-200">
                      AI counting…
                    </p>
                  ) : isMangroveSpecies && aiVerification?.status === 'failed' ? (
                    <p className="mt-1.5 text-[11px] font-semibold text-amber-200">
                      AI count pending review
                    </p>
                  ) : null}
                  <p className="mt-1 text-lg font-black tabular-nums leading-tight text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.45)]">
                    {aiCounted != null ? (
                      <>
                        <span className="text-2xl">{aiCounted}</span>
                        <span className="ml-1.5 text-sm font-bold capitalize text-emerald-100/95">
                          AI counted
                        </span>
                      </>
                    ) : treeCountDisplay != null ? (
                      <>
                        {treeCountDisplay}
                        {speciesLabel ? (
                          <span className="ml-1.5 text-sm font-bold capitalize text-emerald-100/95">
                            {speciesLabel}
                          </span>
                        ) : (
                          <span className="ml-1.5 text-sm font-semibold text-emerald-100/95">
                            trees
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-sm font-semibold text-emerald-100/90">
                        {speciesLabel || 'Open submission for count'}
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>
          ) : null}

          {isVideoLoading && (
            <div className="absolute inset-0 z-[4] flex items-center justify-center bg-gray-100/80">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
            </div>
          )}

          {isVideoError && (
            <div className="absolute inset-0 z-[4] flex flex-col items-center justify-center bg-gray-100 text-gray-500">
              <HiPlay className="mb-2 h-12 w-12 opacity-50" />
              <span className="text-sm">Failed to load video</span>
              {!detailHref ? (
                <button
                  type="button"
                  onClick={() => setIsModalOpen(true)}
                  className="mt-2 text-xs text-blue-500 hover:text-blue-600"
                >
                  Try again
                </button>
              ) : (
                <span className="mt-2 text-xs text-blue-600">
                  Open submission to retry
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-row items-start justify-between gap-2 px-0.5">
        <div className="min-w-0 max-w-[70%] flex-1">
          <p className="text-xs font-semibold text-[#1a1510]">{timestamp}</p>
          {awaitingPlantClip && completePlantHref ? (
            <Link
              href={completePlantHref}
              className="mt-1 inline-block text-xs font-semibold text-tree-green-2 underline"
              onClick={e => e.stopPropagation()}
            >
              Finish after video →
            </Link>
          ) : null}
          {video.reverseGeocode ? (
            <Tooltip content={<span>{video.reverseGeocode}</span>}>
              <p className="truncate text-xs text-[#5c534a] underline">
                {locationText}
              </p>
            </Tooltip>
          ) : (
            <p className="truncate text-xs text-[#5c534a]">{locationText}</p>
          )}
        </div>
        <div className="mt-0.5 shrink-0">
          {statusMeta || rewardClaimDisplay !== null ? (
            <SubmissionStatusBadges
              rewardClaimDisplay={rewardClaimDisplay}
              statusMeta={statusMeta}
            />
          ) : (
            <ClipStatusPill status={status ?? String(video.status)} />
          )}
        </div>
      </div>

      {rejectionReason ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
          <IoCloseCircle
            className="mt-px h-4 w-4 shrink-0 text-red-600"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-red-900">
              Rejected by verifiers
            </p>
            <p className="line-clamp-2 text-xs leading-5 text-red-900/90">
              {rejectionReason}
            </p>
            <p className="mt-0.5 text-[11px] font-semibold text-red-800 underline">
              See why and what to do next
            </p>
          </div>
        </div>
      ) : null}
    </>
  )

  return (
    <>
      {detailHref || completePlantHref ? (
        <Link
          href={
            awaitingPlantClip && completePlantHref
              ? completePlantHref
              : (detailHref as string)
          }
          className={`${cardClassName} block`}
        >
          {mediaBlock}
        </Link>
      ) : (
        <div className={cardClassName}>{mediaBlock}</div>
      )}

      {!detailHref && (
        <VideoModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          videoUrl={ipfsVideoUrl}
          video={video}
        />
      )}
    </>
  )
}
