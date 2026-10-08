'use client'

import UploadProgressModal from '@/components/Modals/UploadProgressModal'
import { SubmissionCompleteCelebration } from '@/components/submission/SubmissionCompleteCelebration'
import { TwoVideoProofSteps } from '@/components/submission/TwoVideoProofSteps'
import { Button } from '@/components/ui/Button'
import { RecordVideoCue } from '@/components/ui/PulseRings'
import { Spinner } from '@/components/ui/Spinner'
import { useConnectivity } from '@/contexts/ConnectivityProvider'
import { getSubmissionById } from '@/services/app'
import { type ReverseGeocodeResult } from '@/services/geocodingService'
import { offlineVideoService } from '@/services/offlineVideoService'
import { isValidSubmissionObjectId } from '@/services/submissionApiMappers'
import { videoService, VideoType } from '@/services/videoService'
import type { ISubmissionAiVerification, ISubmissionDoc } from '@/types'
import { submissionDocToPlanterGroup } from '@/utils/submissionPlanterGroup'
import { VIDEO_CONFIG } from '@/utils/constants'
import { validateVideoFile } from '@/utils/videoValidation'
import { getSubmissionDetailVideoUrl } from '@/utils/submissionDetailVideo'
import { useParams, useRouter } from 'next/navigation'
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import toast from 'react-hot-toast'
import { HiArrowLeft } from 'react-icons/hi2'
import { IoVideocamOutline } from 'react-icons/io5'
import { MdClose } from 'react-icons/md'

export default function CompleteSubmissionPage() {
  const params = useParams()
  const router = useRouter()
  const { isUserOnline } = useConnectivity()
  const submissionId = typeof params.id === 'string' ? params.id : ''

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [landVideoUrl, setLandVideoUrl] = useState<string | null>(null)
  const [locationText, setLocationText] = useState('')
  const [latitude, setLatitude] = useState<number | null>(null)
  const [longitude, setLongitude] = useState<number | null>(null)
  const [reverseGeocodeText, setReverseGeocodeText] = useState('')

  const [plantFile, setPlantFile] = useState<File | null>(null)
  const [plantFileUrl, setPlantFileUrl] = useState('')
  const [isDragOverPlant, setIsDragOverPlant] = useState(false)
  const [treesPlantedInput, setTreesPlantedInput] = useState('1')
  const [treeType, setTreeType] = useState('')
  const [mangroveAnswer, setMangroveAnswer] = useState<'yes' | 'no' | null>(
    null,
  )
  const [validationError, setValidationError] = useState('')

  const [isUploading, setIsUploading] = useState(false)
  const [isQueueing, setIsQueueing] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [compressionProgress, setCompressionProgress] = useState(0)
  const [compressionMessage, setCompressionMessage] = useState('')
  const [compressionStats, setCompressionStats] = useState<{
    originalSizeMB?: number
    compressedSizeMB?: number
    ratio?: number
    durationMs?: number
  }>({})

  const [plantAiAfterUpload, setPlantAiAfterUpload] =
    useState<ISubmissionAiVerification | null>(null)
  const [mangroveUploadAwaitingContinue, setMangroveUploadAwaitingContinue] =
    useState(false)
  const [showSubmissionCelebrate, setShowSubmissionCelebrate] = useState(false)
  const [celebrationVariant, setCelebrationVariant] = useState<
    'submitted' | 'queued'
  >('submitted')
  const [celebrationOfflineMangrove, setCelebrationOfflineMangrove] =
    useState(false)
  const postCelebrateHrefRef = useRef<string | null>(null)
  const [showResumeBanner, setShowResumeBanner] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem('tg_resume_step2') === '1') {
      setShowResumeBanner(true)
      sessionStorage.removeItem('tg_resume_step2')
    }
  }, [])

  const resolvedTreeType = useMemo(() => {
    if (mangroveAnswer === 'yes') return 'mangrove'
    if (mangroveAnswer === 'no') return treeType.trim()
    return ''
  }, [mangroveAnswer, treeType])

  const treesPlanted = useMemo(() => {
    const parsed = parseInt(treesPlantedInput, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }, [treesPlantedInput])

  const canSubmit = useMemo(() => {
    if (!plantFile) return false
    if (!isValidSubmissionObjectId(submissionId)) return false
    if (latitude == null || longitude == null) return false
    if (mangroveAnswer == null) return false
    if (!resolvedTreeType) return false
    return treesPlanted >= 1
  }, [
    plantFile,
    submissionId,
    latitude,
    longitude,
    mangroveAnswer,
    resolvedTreeType,
    treesPlanted,
  ])

  const dismissSubmissionCelebrate = useCallback(() => {
    setShowSubmissionCelebrate(false)
    setPlantAiAfterUpload(null)
    setCelebrationOfflineMangrove(false)
    const href = postCelebrateHrefRef.current
    postCelebrateHrefRef.current = null
    if (href) {
      router.push(href)
      router.refresh()
    }
  }, [router])

  const finishMangroveUploadModalAndCelebrate = useCallback(() => {
    setMangroveUploadAwaitingContinue(false)
    setShowUploadModal(false)
    setCelebrationVariant('submitted')
    setCelebrationOfflineMangrove(false)
    postCelebrateHrefRef.current = `/submissions/${encodeURIComponent(submissionId)}`
    setShowSubmissionCelebrate(true)
    toast.success('Submission complete')
  }, [submissionId])

  useEffect(() => {
    const load = async () => {
      if (!isValidSubmissionObjectId(submissionId)) {
        setError('Invalid submission id')
        setLoading(false)
        return
      }
      setLoading(true)
      setError('')
      try {
        const res = await getSubmissionById(submissionId)
        const doc = res.data.data as ISubmissionDoc & Record<string, unknown>
        const group = submissionDocToPlanterGroup(doc)
        const land = group.landVideo
        const plant = group.plantVideo

        if (!land) {
          setError('Land video not found for this submission')
          setLoading(false)
          return
        }
        if (plant) {
          router.replace(`/submissions/${encodeURIComponent(submissionId)}`)
          return
        }

        setLandVideoUrl(getSubmissionDetailVideoUrl(land))
        setLatitude(land.gpsCoordinates.latitude)
        setLongitude(land.gpsCoordinates.longitude)
        const fallback = `${land.gpsCoordinates.latitude.toFixed(4)}, ${land.gpsCoordinates.longitude.toFixed(4)}`
        setLocationText(land.reverseGeocode || fallback)
        setReverseGeocodeText(land.reverseGeocode || '')
      } catch (e) {
        console.error('Failed to load draft submission', e)
        setError('Failed to load submission')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [submissionId, router])

  useEffect(() => {
    return () => {
      if (plantFileUrl) URL.revokeObjectURL(plantFileUrl)
    }
  }, [plantFileUrl])

  const onPickPlantVideo = async (file: File | null) => {
    if (!file) return
    setValidationError('')
    try {
      const validation = await validateVideoFile(file)
      if (!validation.isValid) {
        setValidationError(validation.error || 'Invalid video file')
        return
      }
      setPlantFile(file)
      if (plantFileUrl) URL.revokeObjectURL(plantFileUrl)
      setPlantFileUrl(URL.createObjectURL(file))
    } catch {
      setValidationError('Failed to validate video. Please try again.')
    }
  }

  const onPlantDrop = async (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragOverPlant(false)

    const droppedFile = event.dataTransfer.files?.[0] ?? null
    await onPickPlantVideo(droppedFile)
  }

  const clearPlantVideo = () => {
    setPlantFile(null)
    if (plantFileUrl) URL.revokeObjectURL(plantFileUrl)
    setPlantFileUrl('')
  }

  const onSubmit = async () => {
    if (!canSubmit || !plantFile || latitude == null || longitude == null)
      return

    setUploadError('')
    setUploadSuccess(false)
    setShowUploadModal(true)
    setUploadProgress(0)
    setCompressionProgress(0)
    setCompressionMessage('')
    setCompressionStats({})

    const reverseGeocode: ReverseGeocodeResult | undefined = reverseGeocodeText
      ? {
          success: true,
          address: reverseGeocodeText,
          shortAddress: reverseGeocodeText,
        }
      : undefined

    const submissionDetailHref = `/submissions/${encodeURIComponent(submissionId)}`
    const isMangrove = resolvedTreeType.toLowerCase() === 'mangrove'
    let uploadedPlantAi: ISubmissionAiVerification | null = null

    try {
      if (isUserOnline) {
        setIsUploading(true)
        setPlantAiAfterUpload(null)
        setMangroveUploadAwaitingContinue(false)
        const uploadRes = await videoService.uploadVideo(
          plantFile,
          VideoType.PLANT,
          latitude,
          longitude,
          submissionId,
          treesPlanted,
          resolvedTreeType,
          reverseGeocode,
          {
            onCompressionProgress: p => {
              setCompressionProgress(p.progress)
              setCompressionMessage(p.message)
            },
            onCompressionDone: result => {
              setCompressionStats({
                originalSizeMB: result.originalSize / (1024 * 1024),
                compressedSizeMB: result.compressedSize / (1024 * 1024),
                ratio: result.compressionRatio,
                durationMs: result.durationMs,
              })
              setCompressionProgress(100)
              setCompressionMessage('Compression complete')
            },
            onUploadProgress: percent => setUploadProgress(percent),
          },
        )
        uploadedPlantAi = uploadRes?.data?.aiVerification ?? null
        setPlantAiAfterUpload(uploadedPlantAi)
      } else {
        setIsQueueing(true)
        await offlineVideoService.queueVideoUpload(
          plantFile,
          VideoType.PLANT,
          latitude,
          longitude,
          submissionId,
          treesPlanted,
          resolvedTreeType,
          p => {
            setCompressionProgress(p.progress)
            setCompressionMessage(p.message)
          },
          result => {
            setCompressionStats({
              originalSizeMB: result.originalSize / (1024 * 1024),
              compressedSizeMB: result.compressedSize / (1024 * 1024),
              ratio: result.compressionRatio,
              durationMs: result.durationMs,
            })
            setCompressionProgress(100)
            setCompressionMessage('Compression complete')
          },
        )
      }

      setUploadProgress(100)
      setUploadSuccess(true)
      clearPlantVideo()

      if (isUserOnline && isMangrove) {
        const counted = uploadedPlantAi?.countedMangroves
        if (
          uploadedPlantAi?.status === 'completed' &&
          typeof counted === 'number' &&
          Number.isFinite(counted)
        ) {
          setMangroveUploadAwaitingContinue(true)
          setUploadSuccess(true)
          toast.success(
            `AI counted ${counted} mangrove seedling${counted === 1 ? '' : 's'} in your video`,
          )
          return
        }
        setMangroveUploadAwaitingContinue(false)
        setShowUploadModal(false)
        setCelebrationVariant('submitted')
        setCelebrationOfflineMangrove(false)
        postCelebrateHrefRef.current = submissionDetailHref
        setShowSubmissionCelebrate(true)
        if (
          uploadedPlantAi?.status === 'completed' &&
          typeof counted === 'number'
        ) {
          toast.success(
            `AI counted ${counted} mangrove seedling${counted === 1 ? '' : 's'} in your video`,
          )
        } else if (uploadedPlantAi?.status === 'failed') {
          toast.error(
            uploadedPlantAi.error?.trim() ||
              'AI count failed — a verifier will review your video.',
          )
        } else {
          toast.success('Plant video uploaded')
        }
        return
      }

      if (!isUserOnline && isMangrove) {
        setShowUploadModal(false)
        setPlantAiAfterUpload(null)
        setCelebrationVariant('queued')
        setCelebrationOfflineMangrove(true)
        postCelebrateHrefRef.current = submissionDetailHref
        setShowSubmissionCelebrate(true)
        toast.success(
          'Submission queued. It will upload when you are back online.',
        )
        return
      }

      toast.success(
        isUserOnline
          ? 'Submission complete'
          : 'Submission queued. It will upload when you are back online.',
      )
      setShowUploadModal(false)
      router.push(submissionDetailHref)
      router.refresh()
    } catch (e) {
      const msg = isUserOnline
        ? 'Failed to upload plant video. Please try again.'
        : 'Failed to queue plant video. Please try again.'
      setUploadError(msg)
      toast.error(msg)
      setMangroveUploadAwaitingContinue(false)
      setPlantAiAfterUpload(null)
      console.error('Complete submission failed', e)
    } finally {
      setIsUploading(false)
      setIsQueueing(false)
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <UploadProgressModal
        isOpen={showUploadModal}
        onClose={() => {
          if (!isUploading && !isQueueing) setShowUploadModal(false)
        }}
        isQueueMode={!isUserOnline}
        compression={{
          phase: 'compressing',
          progress: compressionProgress,
          message: compressionMessage || 'Preparing video…',
          ...compressionStats,
        }}
        upload={{
          progress: uploadProgress,
          message: isUserOnline
            ? mangroveUploadAwaitingContinue
              ? 'Upload complete · review AI count below'
              : 'Uploading video…'
            : 'Video will be uploaded when online',
          success: uploadSuccess,
          error: uploadError || undefined,
        }}
        plantAiVerification={plantAiAfterUpload}
        awaitingMangroveAiContinue={mangroveUploadAwaitingContinue}
        onContinueAfterMangroveAi={finishMangroveUploadModalAndCelebrate}
      />

      <SubmissionCompleteCelebration
        open={showSubmissionCelebrate}
        onFinished={dismissSubmissionCelebrate}
        variant={celebrationVariant}
        mangrovePlantAi={plantAiAfterUpload}
        queuedOfflineMangrove={celebrationOfflineMangrove}
      />

      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-4 py-2">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md p-1 text-[#111] hover:bg-gray-100"
          aria-label="Back"
        >
          <HiArrowLeft className="h-6 w-6" />
        </button>
        <h1 className="text-[18px] font-bold text-[#111]">
          Step 2 of 2 — After video
        </h1>
        <span className="w-8" aria-hidden />
      </header>

      <div className="mx-auto max-w-3xl px-4 pb-24 pt-4">
        {loading ? (
          <div className="mt-10 flex flex-col items-center justify-center gap-3">
            <Spinner size="lg" />
            <p className="text-sm text-gray-500">Loading submission…</p>
          </div>
        ) : error ? (
          <div className="mt-10 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            {error}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {showResumeBanner ? (
              <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
                <p className="text-sm font-semibold text-sky-950">
                  Unfinished submission — continuing at step 2 (after video)
                </p>
                <p className="mt-1 text-sm text-sky-900/90">
                  Your before video is already saved. Plant in the field, then
                  upload the after clip below.
                </p>
              </div>
            ) : null}

            <div>
              <p className="text-sm font-medium text-gray-500">Step 2 of 2</p>
              <div className="mt-1 flex flex-row items-center gap-2">
                <div className="h-1 flex-1 rounded-full bg-tree-green-2" />
                <div className="h-1 flex-1 rounded-full bg-tree-green-2" />
              </div>
              <p className="mt-2 text-sm text-gray-600">
                Your before video is saved. Plant in the field, then record the
                after clip.
              </p>
            </div>

            <TwoVideoProofSteps activeStep={3} />

            <section>
              <h2 className="mb-2 text-base font-semibold text-gray-800">
                Before video (saved)
              </h2>
              {landVideoUrl ? (
                <div className="w-full overflow-hidden rounded-xl bg-black shadow-md">
                  <video
                    className="aspect-video w-full object-cover"
                    controls
                    preload="metadata"
                  >
                    <source src={landVideoUrl} type="video/mp4" />
                  </video>
                </div>
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-gray-200">
                  <IoVideocamOutline className="h-7 w-7 text-gray-500" />
                </div>
              )}
              {locationText ? (
                <p className="mt-2 text-sm text-gray-600">{locationText}</p>
              ) : null}
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-gray-800">
                After video (planted area)
              </h2>
              <p className="mb-3 text-sm text-gray-500">
                Film the same area after planting. Clips up to{' '}
                {VIDEO_CONFIG.MAX_DURATION_SECONDS} seconds are accepted.
              </p>
              {plantFile ? (
                <div className="relative aspect-[2/1] w-full overflow-hidden rounded-xl bg-black shadow-md">
                  <video
                    key={plantFileUrl}
                    src={plantFileUrl}
                    className="h-full w-full object-cover"
                    controls
                    preload="metadata"
                  >
                    <source
                      src={plantFileUrl}
                      type={plantFile.type || 'video/mp4'}
                    />
                  </video>
                  <button
                    type="button"
                    onClick={clearPlantVideo}
                    className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 p-1.5 shadow"
                    aria-label="Remove video"
                  >
                    <MdClose className="h-6 w-6 text-brown-2" />
                  </button>
                </div>
              ) : (
                <label
                  onDragEnter={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragOverPlant(true)
                  }}
                  onDragOver={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragOverPlant(true)
                  }}
                  onDragLeave={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragOverPlant(false)
                  }}
                  onDrop={e => void onPlantDrop(e)}
                  className={`relative flex aspect-[2/1] w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-[#b6bf56] shadow-md ${
                    isDragOverPlant
                      ? 'bg-[#e8f7ed] ring-2 ring-tree-green-2'
                      : 'bg-[#f7fbf3]'
                  }`}
                >
                  <RecordVideoCue label="Tap to record the planting" />
                  <input
                    type="file"
                    accept="video/*"
                    capture="environment"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    onChange={e =>
                      void onPickPlantVideo(e.target.files?.[0] || null)
                    }
                  />
                </label>
              )}
            </section>

            <section className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
              <h2 className="mb-3 text-base font-semibold text-gray-800">
                Planting details
              </h2>
              <label className="mb-1.5 block text-sm text-gray-600">
                Tree count *
              </label>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={treesPlantedInput}
                onChange={e => setTreesPlantedInput(e.target.value)}
                placeholder="e.g. 5"
                className="mb-4 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-base text-gray-900 outline-none focus:border-green-600"
              />

              <p className="mb-1.5 text-sm text-gray-600">
                Is this a Mangrove? *
              </p>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setMangroveAnswer('yes')
                    setTreeType('')
                  }}
                  className={`rounded-lg border-2 px-3 py-3 text-sm font-medium ${
                    mangroveAnswer === 'yes'
                      ? 'border-green-700 bg-green-50 text-green-800'
                      : 'border-gray-200 bg-white text-gray-700'
                  }`}
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setMangroveAnswer('no')}
                  className={`rounded-lg border-2 px-3 py-3 text-sm font-medium ${
                    mangroveAnswer === 'no'
                      ? 'border-green-700 bg-green-50 text-green-800'
                      : 'border-gray-200 bg-white text-gray-700'
                  }`}
                >
                  No
                </button>
              </div>

              {mangroveAnswer === 'no' ? (
                <>
                  <label className="mb-1.5 block text-sm text-gray-600">
                    Tree type *
                  </label>
                  <input
                    value={treeType}
                    onChange={e => setTreeType(e.target.value)}
                    placeholder="e.g. Oak, Teak"
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-base text-gray-900 outline-none focus:border-green-600"
                  />
                </>
              ) : null}
            </section>

            {validationError ? (
              <p className="text-sm text-red-600">{validationError}</p>
            ) : null}

            <Button
              onClick={() => void onSubmit()}
              disabled={!canSubmit || isUploading || isQueueing}
              color="green"
              className="w-full"
            >
              {isUploading || isQueueing ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
