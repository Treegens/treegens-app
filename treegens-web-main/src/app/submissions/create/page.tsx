'use client'

import { Button } from '@/components/ui/Button'
import { useRouter, useSearchParams } from 'next/navigation'
import cn from 'classnames'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { GrLocation } from 'react-icons/gr'
import { HiArrowLeft, HiArrowPath } from 'react-icons/hi2'
import { IoVideocamOutline } from 'react-icons/io5'
import { MdClose } from 'react-icons/md'
import { guidelines } from '@/modules/createSubmission/guidelines'
import UploadProgressModal from '@/components/Modals/UploadProgressModal'
import VideoSavedSuccessModal from '@/components/Modals/VideoSavedSuccessModal'
import { TwoVideoProofSteps } from '@/components/submission/TwoVideoProofSteps'
import { SubmissionCompleteCelebration } from '@/components/submission/SubmissionCompleteCelebration'
import { MangroveSiteFields } from '@/components/siteCheck/MangroveSiteFields'
import { PlantingSiteCard } from '@/components/siteCheck/PlantingSiteCard'
import { UNSENT_VIDEO_LEAVE_WARNING } from '@/components/siteCheck/SitePicker'
import { useConnectivity } from '@/contexts/ConnectivityProvider'
import { useUser } from '@/contexts/UserProvider'
import { getMySubmissions } from '@/services/app'
import { useGeolocation } from '@/hooks/useGeolocation'
import {
  outsideSiteWarning,
  siteGateReason,
} from '@/modules/siteCheck/siteGateMessage'
import type { ReverseGeocodeResult } from '@/services/geocodingService'
import { reverseGeocode } from '@/services/geocodingService'
import { offlineVideoService } from '@/services/offlineVideoService'
import { getSite } from '@/services/siteService'
import { CompressionProgress } from '@/services/videoCompressionService'
import { isValidSubmissionObjectId } from '@/services/submissionApiMappers'
import {
  type SiteLinkFields,
  videoService,
  VideoType,
  VideoUploadResponse,
} from '@/services/videoService'
import type { ISiteDoc, ISubmissionAiVerification } from '@/types'
import { VIDEO_CONFIG } from '@/utils/constants'
import { validateVideoFile } from '@/utils/videoValidation'

const MAX_VIDEO_DURATION = VIDEO_CONFIG.MAX_DURATION_SECONDS

export default function NewPlant() {
  const { setQueueStatus, refetchVideos } = useUser()
  const { isUserOnline } = useConnectivity()

  const [landFile, setLandFile] = useState<File | null>(null)
  const [plantFile, setPlantFile] = useState<File | null>(null)
  const [videoFileURL, setVideoFileURL] = useState<string>('')
  const [videoFileURL2, setVideoFileURL2] = useState<string>('')
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string>('')
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [compressionProgress, setCompressionProgress] = useState<number>(0)
  const [compressionMessage, setCompressionMessage] = useState<string>('')
  const [compressionStats, setCompressionStats] = useState<{
    originalSizeMB?: number
    compressedSizeMB?: number
    ratio?: number
    durationMs?: number
  }>({})
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [showSubmissionCelebrate, setShowSubmissionCelebrate] = useState(false)
  const [celebrationVariant, setCelebrationVariant] = useState<
    'submitted' | 'queued'
  >('submitted')
  const [plantAiAfterUpload, setPlantAiAfterUpload] =
    useState<ISubmissionAiVerification | null>(null)
  const [mangroveUploadAwaitingContinue, setMangroveUploadAwaitingContinue] =
    useState(false)
  const [celebrationOfflineMangrove, setCelebrationOfflineMangrove] =
    useState(false)
  const [validationError, setValidationError] = useState<string>('')
  const [isMounted, setIsMounted] = useState(false)
  const [isQueueing, setIsQueueing] = useState(false)
  const [hasUploadedLandVideo, setHasUploadedLandVideo] = useState(false)
  /** Set from server after land upload; required for plant upload. */
  const [serverSubmissionId, setServerSubmissionId] = useState<string | null>(
    null,
  )
  const [showLandSavedModal, setShowLandSavedModal] = useState(false)
  const [pendingResumeSubmissionId, setPendingResumeSubmissionId] = useState<
    string | null
  >(null)

  // Plant video specific fields (aligned with mobile create submission)
  const [treesPlantedInput, setTreesPlantedInput] = useState<string>('1')
  const [treetype, setTreetype] = useState<string>('')
  const [mangroveAnswer, setMangroveAnswer] = useState<'yes' | 'no' | null>(
    null,
  )

  const router = useRouter()
  /** Site Check linked to the land clip; `?siteId=` preselects one. */
  const searchParams = useSearchParams()
  const [siteId, setSiteId] = useState(() => searchParams.get('siteId') ?? '')
  /** Plant step on this page: the site sent with the land clip, if any. */
  const [landSiteId, setLandSiteId] = useState('')
  const [landSiteWarning, setLandSiteWarning] = useState('')
  /** Plant step on this page, mangroves: a site picked now, and species. */
  const [pickedSiteId, setPickedSiteId] = useState('')
  const [plantSiteDoc, setPlantSiteDoc] = useState<ISiteDoc | null>(null)
  const [species, setSpecies] = useState<string[]>([])

  useEffect(() => {
    if (!landSiteId) return
    getSite(landSiteId)
      .then(res => setPlantSiteDoc(res.data.data))
      .catch(e => console.warn('Could not load the linked site', e))
  }, [landSiteId])

  const resetPlantSite = () => {
    setLandSiteId('')
    setLandSiteWarning('')
    setPickedSiteId('')
    setPlantSiteDoc(null)
    setSpecies([])
  }

  const dismissSubmissionCelebrate = useCallback(() => {
    setShowSubmissionCelebrate(false)
    setPlantAiAfterUpload(null)
    setCelebrationOfflineMangrove(false)
  }, [])

  const finishMangroveUploadModalAndCelebrate = useCallback(async () => {
    setMangroveUploadAwaitingContinue(false)
    setShowUploadModal(false)
    setCelebrationVariant('submitted')
    setCelebrationOfflineMangrove(false)
    await refetchVideos()
    setShowSubmissionCelebrate(true)
    toast.success('Submission complete')
  }, [refetchVideos])

  // Use the custom hook instead of managing state manually
  const {
    latitude,
    longitude,
    accuracy: locationAccuracy,
    loading: locationLoading,
    error: locationError,
    getCurrentPosition,
    isSupported,
  } = useGeolocation({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 10000,
  })

  const [locationAddress, setLocationAddress] = useState<string>('')
  const [geocodingError, setGeocodingError] = useState<string>('')
  const [hasTriedLocation, setHasTriedLocation] = useState(false)
  const [reverseGeocodeResult, setReverseGeocodeResult] =
    useState<ReverseGeocodeResult | null>(null)

  // Ensure we're on the client side before doing anything
  useEffect(() => {
    setIsMounted(true)
  }, [])

  /** Resume an in-progress draft (land uploaded, plant missing) instead of starting over. */
  useEffect(() => {
    if (!isMounted || !isUserOnline) return
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await getMySubmissions({ page: 1, limit: 20 })
        const docs = (data?.data?.submissions ?? []) as Array<{
          _id: string
          status?: string
          plant?: { uploaded?: boolean }
        }>
        const draft = docs.find(
          d =>
            d.status === 'awaiting_plant' &&
            d.plant?.uploaded !== true,
        )
        if (!cancelled && draft?._id) {
          sessionStorage.setItem('tg_resume_step2', '1')
          router.replace(
            `/submissions/create/${encodeURIComponent(String(draft._id))}`,
          )
        }
      } catch (e) {
        console.warn('Could not check for draft submissions', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isMounted, isUserOnline, router])

  // Get location when component mounts (only once and only on client)
  useEffect(() => {
    if (isMounted && isSupported && !hasTriedLocation) {
      console.log('🎯 Attempting to get initial location...')
      getCurrentPosition()
      setHasTriedLocation(true)
    }
  }, [isMounted, isSupported, getCurrentPosition, hasTriedLocation])

  // Handle reverse geocoding when coordinates change
  useEffect(() => {
    if (isMounted && latitude !== null && longitude !== null) {
      handleReverseGeocode(latitude, longitude)
    }
  }, [isMounted, latitude, longitude])

  const handleReverseGeocode = async (lat: number, lng: number) => {
    try {
      setGeocodingError('')
      const result = await reverseGeocode(lat, lng, {
        zoom: 16, // Good balance of accuracy and detail
        language: 'en',
      })

      if (result.success) {
        setReverseGeocodeResult(result)
        setLocationAddress(result.shortAddress || result.address || '')
      } else {
        setReverseGeocodeResult(result)
        setGeocodingError(result.error || 'Failed to get address')
        console.warn('Geocoding failed:', result.error)
      }
    } catch (error) {
      setReverseGeocodeResult(null)
      setGeocodingError('Geocoding service unavailable')
      console.error('Geocoding error:', error)
    }
  }

  const handleRetryLocation = () => {
    console.log('🔄 Retrying location request...')
    setHasTriedLocation(false) // Reset so it will try again
    getCurrentPosition()
  }

  const resolvedTreeType = useMemo(() => {
    if (mangroveAnswer === 'yes') return 'mangrove'
    if (mangroveAnswer === 'no') return treetype.trim()
    return ''
  }, [mangroveAnswer, treetype])

  const treesPlanted = useMemo(() => {
    const parsed = parseInt(treesPlantedInput, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }, [treesPlantedInput])

  const isLandStep = !hasUploadedLandVideo
  const isPlantStep = hasUploadedLandVideo
  const isOfflineLandQueued =
    isPlantStep && !isValidSubmissionObjectId(serverSubmissionId || '')
  const isFullySubmitted = false

  useEffect(() => {
    console.log('location error', locationError)
  }, [locationError])

  const formatLocation = () => {
    if (locationLoading) return 'Getting location...'
    if (locationError) return 'Location unavailable'
    if (latitude === null || longitude === null) return 'No location data'

    // Prefer human-readable address
    if (locationAddress) {
      return locationAddress
    }

    // Show geocoding error if any
    if (geocodingError) {
      return `${latitude.toFixed(4)}, ${longitude.toFixed(4)} (${geocodingError})`
    }

    // Fallback to coordinates
    return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
  }

  const hasValidLocation = (): boolean => {
    return latitude !== null && longitude !== null && !locationError
  }

  const handleVideoRecorded = async (file: File, type: VideoType) => {
    setValidationError('')

    try {
      console.log(`🎬 Validating ${type} video:`, {
        fileName: file.name,
        fileSize: `${(file.size / (1024 * 1024)).toFixed(2)}MB`,
        fileType: file.type,
      })

      // Validate the video file
      const validation = await validateVideoFile(file)

      if (!validation.isValid) {
        console.log(`❌ ${type} video validation FAILED:`, validation.error)
        setValidationError(`${type.toUpperCase()} VIDEO: ${validation.error}`)
        return
      }

      console.log(`✅ ${type} video validation PASSED:`, {
        duration: `${validation.duration?.toFixed(1)}s`,
        fileSize: `${validation.fileSize?.toFixed(2)}MB`,
        fileName: file.name,
        maxAllowed: `${MAX_VIDEO_DURATION}s`,
      })

      const finalFile = file
      const finalFileURL = URL.createObjectURL(file)

      // Set the final file and create URL for preview
      if (type === VideoType.LAND) {
        setLandFile(finalFile)
        if (videoFileURL) {
          URL.revokeObjectURL(videoFileURL)
        }
        setVideoFileURL(finalFileURL)
      } else {
        setPlantFile(finalFile)
        if (videoFileURL2) {
          URL.revokeObjectURL(videoFileURL2)
        }
        setVideoFileURL2(finalFileURL)
      }
    } catch (error) {
      console.error(`❌ Video validation failed for ${type}:`, error)
      setValidationError(
        `Failed to validate ${type} video. Please try recording again.`,
      )
    }
  }

  const handleRemoveVideo = (type: VideoType) => {
    if (type === VideoType.LAND) {
      setLandFile(null)
      if (videoFileURL) {
        URL.revokeObjectURL(videoFileURL)
        setVideoFileURL('')
      }
    } else {
      setPlantFile(null)
      if (videoFileURL2) {
        URL.revokeObjectURL(videoFileURL2)
        setVideoFileURL2('')
      }
    }
    setValidationError('') // Clear any validation errors
  }

  const handleCloseUploadModal = async () => {
    setShowUploadModal(false)
    if (landFile) {
      handleRemoveVideo(VideoType.LAND)
    }
    if (plantFile) {
      handleRemoveVideo(VideoType.PLANT)
    }
    setCompressionMessage('')
    setCompressionProgress(0)
    setCompressionStats({})
    setTreesPlantedInput('1')
    setTreetype('')
    setMangroveAnswer(null)
    setUploadSuccess(false)
    setUploadError('')
    setValidationError('')
    // Clear file inputs, if any lingering values
    if (inputRef.current) inputRef.current.value = ''
    if (inputRef2.current) inputRef2.current.value = ''
  }

  const inputRef = useRef<HTMLInputElement>(null)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0]
      await handleVideoRecorded(file, VideoType.LAND)
    }
  }

  const inputRef2 = useRef<HTMLInputElement>(null)
  const handleFileChange2 = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0]
      await handleVideoRecorded(file, VideoType.PLANT)
    }
  }

  const uploadVideo = async (
    file: File,
    type: VideoType,
    /** Required for plant clip; use the id returned from a land upload in the same session */
    plantSubmissionId?: string,
    /** Plant clip only: site picked at plant time and mangrove species */
    plantSiteLink?: SiteLinkFields,
  ): Promise<VideoUploadResponse> => {
    if (!hasValidLocation()) {
      throw new Error('Location data is required for video upload')
    }

    const submissionIdForUpload =
      type === VideoType.PLANT
        ? plantSubmissionId || serverSubmissionId || ''
        : ''

    if (type === VideoType.PLANT) {
      if (!isValidSubmissionObjectId(submissionIdForUpload)) {
        throw new Error('A valid submission is required for the plant video')
      }
      if (treesPlanted < 1) {
        throw new Error('Trees planted count is required for plant video')
      }
      if (!resolvedTreeType.trim()) {
        throw new Error('Tree type is required for plant video')
      }
    }

    console.log('plant submission id', plantSubmissionId)

    try {
      setUploadProgress(0)
      const result = await videoService.uploadVideo(
        file,
        type,
        latitude!,
        longitude!,
        submissionIdForUpload,
        type === VideoType.PLANT ? treesPlanted : undefined,
        type === VideoType.PLANT ? resolvedTreeType : undefined,
        reverseGeocodeResult || undefined,
        {
          onCompressionProgress: handleCompressionProgress,
          onCompressionDone: r => {
            setCompressionStats({
              originalSizeMB: r.originalSize / (1024 * 1024),
              compressedSizeMB: r.compressedSize / (1024 * 1024),
              ratio: r.compressionRatio,
              durationMs: r.durationMs,
            })
          },
          onUploadProgress: p => setUploadProgress(p),
          ...(type === VideoType.LAND ? { siteId } : plantSiteLink),
        },
      )

      console.log('Upload successful:', result)
      setUploadProgress(100)
      setUploadSuccess(true)
      return result
    } catch (error) {
      console.error('Video upload failed:', error)
      setUploadSuccess(false)
      throw error
    }
  }

  // Helper function to handle compression progress (used for both normal and queue uploads)
  const handleCompressionProgress = (progress: CompressionProgress) => {
    setCompressionProgress(progress.progress)
    setCompressionMessage(progress.message)
  }

  // Helper function to reset compression progress state
  const resetCompressionProgress = () => {
    setCompressionProgress(0)
    setCompressionMessage('')
    setCompressionStats({})
  }

  const handleLandSubmit = async () => {
    if (!landFile) return

    if (!hasValidLocation()) {
      setUploadError(
        'Location data is required for verification. Please enable location access.',
      )
      return
    }

    setIsUploading(isUserOnline)
    setIsQueueing(!isUserOnline)
    setUploadError('')
    setValidationError('')

    try {
      if (isUserOnline) {
        setShowUploadModal(true)
        const landRes = await uploadVideo(landFile, VideoType.LAND)
        const sid = landRes?.data?.submissionId
        if (!sid?.trim()) {
          setUploadError(
            'Land upload succeeded but no submission id was returned. Try again.',
          )
          setShowUploadModal(false)
          return
        }
        setServerSubmissionId(sid)
        setHasUploadedLandVideo(true)
        setLandSiteId(siteId)
        const warning = outsideSiteWarning(landRes.data.siteCheck)
        setLandSiteWarning(warning)
        if (warning) toast.error(warning, { duration: 10000 })
        handleRemoveVideo(VideoType.LAND)
        await refetchVideos()
        toast.success('Before video saved.')
        setShowUploadModal(false)
        setPendingResumeSubmissionId(sid)
        setShowLandSavedModal(true)
        return
      } else {
        resetCompressionProgress()
        setShowUploadModal(true)

        await offlineVideoService.queueVideoUpload(
          landFile,
          VideoType.LAND,
          latitude!,
          longitude!,
          '',
          undefined,
          undefined,
          handleCompressionProgress,
          r => {
            setCompressionStats({
              originalSizeMB: r.originalSize / (1024 * 1024),
              compressedSizeMB: r.compressedSize / (1024 * 1024),
              ratio: r.compressionRatio,
              durationMs: r.durationMs,
            })
          },
          { siteId },
        )

        const status = await offlineVideoService.getQueueStatus()
        setQueueStatus(status)

        setHasUploadedLandVideo(true)
        setServerSubmissionId(null)
        handleRemoveVideo(VideoType.LAND)
        toast.success(
          'Land video queued. It will upload automatically when you are back online.',
        )
      }
    } catch (error) {
      console.error('Land upload error:', error)
      const errorMessage =
        siteGateReason(error) ??
        (error instanceof Error
          ? error.message
          : isUserOnline
            ? 'Failed to upload land video. Please try again.'
            : 'Failed to queue land video. Please try again.')
      setUploadError(errorMessage)
    } finally {
      setIsUploading(false)
      setIsQueueing(false)
    }
  }

  const handlePlantSubmit = async () => {
    if (!plantFile) return

    if (!hasValidLocation()) {
      setUploadError(
        'Location data is required for verification. Please enable location access.',
      )
      return
    }

    const submissionIdForPlant = serverSubmissionId || ''
    if (!isValidSubmissionObjectId(submissionIdForPlant)) {
      setUploadError(
        'Land upload must finish first so we have a valid submission id.',
      )
      return
    }

    if (mangroveAnswer === null || !resolvedTreeType || treesPlanted < 1) {
      setUploadError(
        'Enter tree count (≥1), and choose mangrove or enter a tree type.',
      )
      return
    }

    setIsUploading(isUserOnline)
    setIsQueueing(!isUserOnline)
    setUploadError('')
    setValidationError('')

    const isMangrove = resolvedTreeType.toLowerCase() === 'mangrove'
    const siteLink = isMangrove
      ? { siteId: landSiteId ? undefined : pickedSiteId, species }
      : undefined

    try {
      if (isUserOnline) {
        setShowUploadModal(true)
        setPlantAiAfterUpload(null)
        setMangroveUploadAwaitingContinue(false)
        const plantRes = await uploadVideo(
          plantFile,
          VideoType.PLANT,
          submissionIdForPlant,
          siteLink,
        )
        const ai = plantRes?.data?.aiVerification
        setPlantAiAfterUpload(ai ?? null)

        handleRemoveVideo(VideoType.PLANT)
        setMangroveAnswer(null)
        setTreetype('')
        setTreesPlantedInput('1')
        setHasUploadedLandVideo(false)
        setServerSubmissionId(null)
        resetPlantSite()
        await refetchVideos()

        if (isMangrove) {
          const counted = ai?.countedMangroves
          if (
            ai?.status === 'completed' &&
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
          setShowSubmissionCelebrate(true)
          if (ai?.status === 'failed') {
            toast.error(
              ai.error?.trim() ||
                'AI count failed — a verifier will review your video.',
            )
          } else {
            toast.success('Submission complete')
          }
        } else {
          setShowUploadModal(false)
          setCelebrationVariant('submitted')
          setCelebrationOfflineMangrove(false)
          setShowSubmissionCelebrate(true)
          toast.success('Submission complete')
        }
      } else {
        resetCompressionProgress()
        setShowUploadModal(true)

        await offlineVideoService.queueVideoUpload(
          plantFile,
          VideoType.PLANT,
          latitude!,
          longitude!,
          submissionIdForPlant,
          treesPlanted,
          resolvedTreeType,
          handleCompressionProgress,
          r => {
            setCompressionStats({
              originalSizeMB: r.originalSize / (1024 * 1024),
              compressedSizeMB: r.compressedSize / (1024 * 1024),
              ratio: r.compressionRatio,
              durationMs: r.durationMs,
            })
          },
          siteLink,
        )

        const status = await offlineVideoService.getQueueStatus()
        setQueueStatus(status)

        handleRemoveVideo(VideoType.PLANT)
        setMangroveAnswer(null)
        setTreetype('')
        setTreesPlantedInput('1')
        setHasUploadedLandVideo(false)
        setServerSubmissionId(null)
        resetPlantSite()

        setShowUploadModal(false)
        setPlantAiAfterUpload(null)
        setCelebrationVariant('queued')
        setCelebrationOfflineMangrove(isMangrove)
        setShowSubmissionCelebrate(true)
        toast.success(
          'Plant video queued. It will upload automatically when you are back online.',
        )
      }
    } catch (error) {
      console.error('Plant upload error:', error)
      setMangroveUploadAwaitingContinue(false)
      setPlantAiAfterUpload(null)
      const errorMessage =
        siteGateReason(error) ??
        (error instanceof Error
          ? error.message
          : isUserOnline
            ? 'Failed to upload plant video. Please try again.'
            : 'Failed to queue plant video. Please try again.')
      setUploadError(errorMessage)
    } finally {
      setIsUploading(false)
      setIsQueueing(false)
    }
  }

  const handlePrimarySubmit = () => {
    if (isLandStep) void handleLandSubmit()
    else if (isPlantStep) void handlePlantSubmit()
  }

  // Cleanup URLs and compression service on unmount
  useEffect(() => {
    return () => {
      if (videoFileURL) URL.revokeObjectURL(videoFileURL)
      if (videoFileURL2) URL.revokeObjectURL(videoFileURL2)
    }
  }, [videoFileURL, videoFileURL2])

  return (
    <div className="relative flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-10 flex flex-row items-center justify-between border-b border-gray-100 bg-white px-4 py-2">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md p-0.5 text-[#111] hover:bg-gray-100"
          aria-label="Back"
        >
          <HiArrowLeft className="h-6 w-6" />
        </button>
        <h1 className="text-[22px] font-bold text-[#111]">Create Submission</h1>
        <span className="w-6 shrink-0" aria-hidden />
      </header>

      <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-10 pt-2">
        <div className="mb-6">
          <p className="text-sm font-medium text-gray-500">
            Step {isPlantStep ? 2 : 1} of 2
          </p>
          <div className="mt-1 flex flex-row items-center gap-2">
            <div
              className={cn(
                'h-1 flex-1 rounded-full',
                isLandStep || isPlantStep ? 'bg-tree-green-2' : 'bg-gray-200',
              )}
            />
            <div
              className={cn(
                'h-1 flex-1 rounded-full',
                isPlantStep ? 'bg-tree-green-2' : 'bg-gray-200',
              )}
            />
          </div>
        </div>

        <TwoVideoProofSteps
          activeStep={isLandStep ? 1 : 3}
          className="mb-6"
        />

        <div className="mb-6 flex flex-row items-center justify-between gap-2">
          <div className="flex min-h-0 min-w-0 flex-1 flex-row items-center gap-2">
            <GrLocation
              className={cn(
                'h-[18px] w-[18px] shrink-0 text-tree-green-2',
                locationLoading && 'animate-pulse',
                locationError && 'text-red-500',
              )}
            />
            <p className="min-w-0 flex-1 text-sm text-gray-600">
              {formatLocation()}
            </p>
          </div>
          <button
            type="button"
            onClick={handleRetryLocation}
            className="shrink-0 rounded-full bg-gray-100 p-2 text-tree-green-2 hover:bg-gray-200"
            aria-label="Refresh location"
          >
            <HiArrowPath className="h-[18px] w-[18px]" />
          </button>
        </div>

        {isLandStep ? (
          <PlantingSiteCard
            value={siteId}
            onChange={id => setSiteId(id)}
            className="mb-6"
            leaveWarning={landFile ? UNSENT_VIDEO_LEAVE_WARNING : undefined}
          />
        ) : null}

        {isPlantStep && landSiteWarning ? (
          <p className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {landSiteWarning}
          </p>
        ) : null}

        {validationError ? (
          <p className="mb-4 text-sm text-red-600">{validationError}</p>
        ) : null}

        {isOfflineLandQueued ? (
          <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
            <p className="text-sm font-bold text-amber-950">
              Before video queued for upload
            </p>
            <p className="mt-1 text-sm text-amber-900/90">
              Come back online so your before video can upload. Then plant your
              trees in the field and return here for the after video.
            </p>
          </section>
        ) : null}

        {!isFullySubmitted && (isLandStep || isPlantStep) && !isOfflineLandQueued ? (
          <section className="mb-6">
            <h2 className="mb-2 text-base font-semibold text-gray-800">
              {isLandStep ? 'Before video (land)' : 'After video (planted area)'}
            </h2>
            <p className="mb-3 text-sm text-gray-500">
              {isLandStep
                ? `Film the empty land before planting. Clips up to ${MAX_VIDEO_DURATION} seconds are accepted.`
                : `Film the same area after planting. Clips up to ${MAX_VIDEO_DURATION} seconds are accepted.`}
            </p>
            {isLandStep ? (
              landFile ? (
                <div className="relative aspect-[2/1] w-full overflow-hidden rounded-xl bg-black shadow-md">
                  <video
                    preload="metadata"
                    className="h-full w-full object-cover"
                    controls
                  >
                    <source src={videoFileURL} type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                  <button
                    type="button"
                    onClick={() => handleRemoveVideo(VideoType.LAND)}
                    className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 p-1.5 shadow"
                    aria-label="Remove video"
                  >
                    <MdClose className="h-6 w-6 text-brown-2" />
                  </button>
                </div>
              ) : (
                <label className="relative flex aspect-[2/1] w-full cursor-pointer items-center justify-center rounded-xl bg-[#f7fbf3] shadow-md">
                  <IoVideocamOutline
                    className="pointer-events-none h-10 w-10 text-[#435f24]"
                    aria-hidden
                  />
                  <input
                    className="absolute inset-0 cursor-pointer opacity-0"
                    ref={inputRef}
                    onChange={handleFileChange}
                    type="file"
                    accept="video/*"
                    capture="environment"
                  />
                </label>
              )
            ) : plantFile ? (
              <div className="relative aspect-[2/1] w-full overflow-hidden rounded-xl bg-black shadow-md">
                <video
                  preload="metadata"
                  className="h-full w-full object-cover"
                  controls
                >
                  <source src={videoFileURL2} type="video/mp4" />
                  Your browser does not support the video tag.
                </video>
                <button
                  type="button"
                  onClick={() => handleRemoveVideo(VideoType.PLANT)}
                  className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 p-1.5 shadow"
                  aria-label="Remove video"
                >
                  <MdClose className="h-6 w-6 text-brown-2" />
                </button>
              </div>
            ) : (
              <label className="relative flex aspect-[2/1] w-full cursor-pointer items-center justify-center rounded-xl bg-[#f7fbf3] shadow-md">
                <IoVideocamOutline
                  className="pointer-events-none h-10 w-10 text-[#435f24]"
                  aria-hidden
                />
                <input
                  className="absolute inset-0 cursor-pointer opacity-0"
                  ref={inputRef2}
                  onChange={handleFileChange2}
                  type="file"
                  accept="video/*"
                  capture="environment"
                />
              </label>
            )}
          </section>
        ) : null}

        {isPlantStep && !isFullySubmitted && !isOfflineLandQueued ? (
          <section className="mb-6 rounded-xl border border-gray-200 bg-gray-50/50 p-4">
            <h3 className="mb-3 text-base font-semibold text-gray-800">
              Planting details
            </h3>
            <label
              htmlFor="treesPlanted"
              className="mb-1.5 block text-sm text-gray-600"
            >
              Tree count *
            </label>
            <input
              id="treesPlanted"
              type="number"
              min={1}
              inputMode="numeric"
              value={treesPlantedInput}
              onChange={e => setTreesPlantedInput(e.target.value)}
              placeholder="e.g. 5"
              className="mb-4 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-400"
            />
            <p className="mb-1.5 text-sm text-gray-600">
              Is this a Mangrove? *
            </p>
            <div className="mb-4 flex flex-row gap-3">
              <button
                type="button"
                onClick={() => {
                  setMangroveAnswer('yes')
                  setTreetype('')
                }}
                className={cn(
                  'flex flex-1 flex-row items-center justify-center gap-2 rounded-lg border-2 px-3 py-3 transition-colors',
                  mangroveAnswer === 'yes'
                    ? 'border-tree-green-2 bg-[#E8F7ED]'
                    : 'border-gray-200 bg-white',
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded border-2',
                    mangroveAnswer === 'yes'
                      ? 'border-tree-green-2 bg-tree-green-2'
                      : 'border-gray-300 bg-white',
                  )}
                >
                  {mangroveAnswer === 'yes' ? (
                    <span className="text-[10px] font-bold text-white">✓</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'text-base font-medium',
                    mangroveAnswer === 'yes'
                      ? 'text-tree-green-2'
                      : 'text-gray-700',
                  )}
                >
                  Yes
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMangroveAnswer('no')}
                className={cn(
                  'flex flex-1 flex-row items-center justify-center gap-2 rounded-lg border-2 px-3 py-3 transition-colors',
                  mangroveAnswer === 'no'
                    ? 'border-tree-green-2 bg-[#E8F7ED]'
                    : 'border-gray-200 bg-white',
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded border-2',
                    mangroveAnswer === 'no'
                      ? 'border-tree-green-2 bg-tree-green-2'
                      : 'border-gray-300 bg-white',
                  )}
                >
                  {mangroveAnswer === 'no' ? (
                    <span className="text-[10px] font-bold text-white">✓</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'text-base font-medium',
                    mangroveAnswer === 'no'
                      ? 'text-tree-green-2'
                      : 'text-gray-700',
                  )}
                >
                  No
                </span>
              </button>
            </div>
            {mangroveAnswer === 'no' ? (
              <>
                <label
                  htmlFor="treetype"
                  className="mb-1.5 block text-sm text-gray-600"
                >
                  Tree type *
                </label>
                <input
                  id="treetype"
                  type="text"
                  value={treetype}
                  onChange={e => setTreetype(e.target.value)}
                  placeholder="e.g. Oak, Teak"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-400"
                />
              </>
            ) : null}
            {mangroveAnswer === 'yes' ? (
              <MangroveSiteFields
                linked={!!landSiteId}
                site={plantSiteDoc}
                pickedSiteId={pickedSiteId}
                onPickSite={(id, picked) => {
                  setPickedSiteId(id)
                  setPlantSiteDoc(picked)
                }}
                species={species}
                onSpeciesChange={setSpecies}
                leaveWarning={
                  plantFile ? UNSENT_VIDEO_LEAVE_WARNING : undefined
                }
              />
            ) : null}
          </section>
        ) : null}

        {(isLandStep || (isPlantStep && !isOfflineLandQueued)) &&
        !isFullySubmitted ? (
          <div className="mb-10">
            <Button
              type="button"
              onClick={handlePrimarySubmit}
              disabled={
                isUploading ||
                isQueueing ||
                !hasValidLocation() ||
                !!validationError ||
                (isLandStep && !landFile) ||
                (isPlantStep &&
                  (!plantFile ||
                    !isValidSubmissionObjectId(serverSubmissionId || '') ||
                    mangroveAnswer === null ||
                    !resolvedTreeType.trim() ||
                    treesPlanted < 1))
              }
              pill
              color="success"
              className="w-full"
            >
              {isUploading || isQueueing ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        ) : null}

        <div className="border-t border-gray-200 pt-4">
          <p className="mb-3 text-sm font-semibold text-gray-700">
            Tips for a good video
          </p>
          <ul className="flex flex-col gap-3">
            {guidelines.map((g, i) => (
              <li key={g.title} className="flex flex-row gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#E8F7ED] text-xs font-semibold text-tree-green-2">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-gray-800">{g.title}</p>
                  <p className="mt-0.5 text-sm text-gray-500">
                    {g.description}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {uploadError ? (
          <p className="text-center text-sm text-red-600">{uploadError}</p>
        ) : null}

        {!hasValidLocation() && !locationLoading ? (
          <p className="mt-2 text-center text-sm text-orange-600">
            Location is required. Allow access or refresh when prompted.
          </p>
        ) : null}

        {isPlantStep &&
        plantFile &&
        (mangroveAnswer === null ||
          !resolvedTreeType.trim() ||
          treesPlanted < 1) ? (
          <p className="mt-2 text-center text-sm text-orange-600">
            Enter tree count (≥1), and choose mangrove or enter a tree type.
          </p>
        ) : null}
      </div>

      {isUserOnline && isUploading ? (
        <div className="fixed bottom-6 left-1/2 z-50 w-[92%] max-w-md -translate-x-1/2">
          <div className="rounded-lg border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-700">
                Uploading video…
              </span>
              <span className="text-xs text-gray-600">{uploadProgress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-2 rounded-full bg-green-600 transition-[width] duration-200"
                style={{
                  width: `${Math.min(100, Math.max(0, uploadProgress))}%`,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <VideoSavedSuccessModal
        isOpen={showLandSavedModal}
        onClose={() => setShowLandSavedModal(false)}
        onDone={() => {
          setShowLandSavedModal(false)
          const sid = pendingResumeSubmissionId
          setPendingResumeSubmissionId(null)
          if (sid?.trim()) {
            router.push(`/submissions/create/${encodeURIComponent(sid)}`)
          }
        }}
        locationInfo={{
          hasValidLocation: hasValidLocation(),
          formatLocation,
          accuracy: locationAccuracy,
        }}
      />

      <SubmissionCompleteCelebration
        open={showSubmissionCelebrate}
        onFinished={dismissSubmissionCelebrate}
        variant={celebrationVariant}
        mangrovePlantAi={plantAiAfterUpload}
        queuedOfflineMangrove={celebrationOfflineMangrove}
      />

      <UploadProgressModal
        isOpen={showUploadModal}
        onClose={handleCloseUploadModal}
        isQueueMode={!isUserOnline}
        compression={{
          phase: '',
          progress: compressionProgress,
          message: compressionMessage,
          originalSizeMB: compressionStats.originalSizeMB,
          compressedSizeMB: compressionStats.compressedSizeMB,
          ratio: compressionStats.ratio,
          durationMs: compressionStats.durationMs,
        }}
        upload={{
          progress: isUserOnline ? uploadProgress : 0,
          success: isUserOnline && uploadSuccess,
          message: isUserOnline
            ? mangroveUploadAwaitingContinue
              ? 'Upload complete · review AI count below'
              : undefined
            : 'Video will be uploaded when online',
        }}
        plantAiVerification={plantAiAfterUpload}
        awaitingMangroveAiContinue={mangroveUploadAwaitingContinue}
        onContinueAfterMangroveAi={finishMangroveUploadModalAndCelebrate}
      />
    </div>
  )
}
