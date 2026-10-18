import type {
  HydrologyClass,
  SiteAnswers,
  SiteVerdict,
  VerdictCode,
} from '@/modules/siteCheck/siteVerdict'
import { VideoType } from '@/services/videoService'

export interface IPlantCard {
  image: string
  date: Date
  title: string
  status: string
}

export interface ISubmission {
  id: string
  user: IUser
  status: string
  location: string
  date: Date
  treesMounted: number
}

export interface IUser {
  id: number
  name: string
  address: string
}

export interface ILeaderboardItem {
  id: number
  name: string
  address: string
  treesMounted: number
}

// API response types for leaderboard
export interface ILeaderboardUser {
  _id: string
  walletAddress: string
  name?: string
  treesPlanted: number
  videoCount: number
  createdAt: string
  rank: number
}

export interface ILeaderboardResponse {
  message: string
  data: {
    users: ILeaderboardUser[]
    pagination: {
      page: number
      limit: number
      total: number
      pages: number
    }
  }
}

export interface IFundedLeaderboardRow {
  walletAddress: string
  totalBurnedMgroWei: string
  burnCount: number
  updatedAt: string
}

export interface IFundedLeaderboardUser {
  _id: string
  walletAddress: string
  totalBurnedMgroWei: string
  burnCount: number
  updatedAt: string
  rank: number
}

export interface IFundedLeaderboardResponse {
  message: string
  data: {
    users: IFundedLeaderboardUser[]
    pagination: {
      page: number
      limit: number
      total: number
      pages: number
    }
  }
}

/** GET /api/users/:wallet/public */
export interface IPublicProfilePayload {
  user: {
    walletAddress: string
    name?: string
    treesPlanted?: number
    isVerifier?: boolean
    verifierSince?: string
    createdAt: string
    socialPointsTotal?: number
  }
  burns: {
    totalBurnedMgroWei: string
    burnCount: number
    updatedAt: string
  } | null
  approvedSubmissionCount: number
}

export interface IPublicProfileEnvelope {
  message: string
  data: IPublicProfilePayload
}

export interface IUserProfile {
  _id: string
  walletAddress: string
  name?: string
  ensName?: string
  phone?: number
  experience?: string
  /** MGRO claimed (wei), as returned by the API */
  tokensClaimed?: string | number
  treesPlanted?: number
  /** Loyalty points (social quests); convertible to TGN per program rules */
  socialPointsTotal?: number
  completedSocialTasks?: Array<{ taskKey: string; completedAt: string }>
  // Verifier related fields
  isVerifier?: boolean
  verifierSince?: string
  /** Off-chain vote proxy — wallet address of verifier receiving delegated credit */
  verifierDelegate?: string | null
  verifierDelegateSetAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface ISocialRewardsTask {
  taskKey: string
  title: string
  description: string
  points: number
  completed: boolean
  completedAt: string | null
  /** ISO start time for timed quests (e.g. X Space). */
  startsAt?: string | null
  /** Retired catalog key — show history only; do not allow re-completion. */
  retired?: boolean
}

export interface ISocialRewardsSummary {
  pointsTotal: number
  tasks: ISocialRewardsTask[]
}

export interface ISocialRewardsEnvelope {
  message: string
  data: ISocialRewardsSummary
}

export interface ICompleteSocialTaskEnvelope {
  message: string
  data: {
    newlyCompleted: boolean
    pointsEarned: number
    pointsTotal: number
  }
}

export enum VideoStatus {
  REJECTED = 'rejected',
  PENDING = 'pending',
  APPROVED = 'approved',
  QUEUED = 'queued', // FE only
}

export interface IGpsCoordinates {
  latitude: number
  longitude: number
}

export interface Vote {
  voterWalletAddress: string
  vote: 'yes' | 'no'
  reasons: string[]
  createdAt: string
}

export interface IVideo {
  gpsCoordinates: IGpsCoordinates
  _id: string
  userWalletAddress: string
  originalFilename: string
  ipfsHash: string
  videoCID: string
  type: VideoType
  status: VideoStatus
  uploadTimestamp: string
  createdAt: string
  updatedAt: string
  submissionId?: string
  treesPlanted?: number
  treetype?: string
  votes?: Vote[]
  reverseGeocode?: string
}

export interface IModerationVideo extends IVideo {
  yesCount: number
  noCount: number
  totalVotes: number
  votes: Vote[]
}

export interface IModerationListResponse {
  message: string
  data: {
    videos: IModerationVideo[]
    pagination: { page: number; limit: number; total: number; pages: number }
  }
}

export interface IVerifierRequestResponse {
  message: string
  data: {
    eligible: boolean
    balanceWei: string
    balanceTokens: number
  }
}

export interface IVerifierCheckResponse {
  message: string
  data: {
    isVerifier: boolean
  }
}

export interface IVideoVoteResponse {
  message: string
  data: {
    videoId: string
    status: string
    yesCount: number
    totalVotes: number
    votes: Vote[]
  }
}

export interface ICreateUserRequest {
  walletAddress: string
  name?: string
  ensName?: string
  phone?: number
  experience?: string
}

export interface ICreateUserResponse {
  message: string
  data: {
    user: IUserProfile
    action: 'created' | 'updated'
  }
}

export interface IGetUserResponse {
  message: string
  data: IUserProfile
}

export interface IVerifierWarningBanner {
  shouldShow: boolean
  warningCount: number
  messageVariant: 'first' | 'again'
  submissionId?: string
  submissionOwnerWalletAddress?: string
  healthCheckId?: string
  warnedAt?: string
}

export interface IVerifierWarningBannerResponse {
  message: string
  data: IVerifierWarningBanner
}

export interface IUserVideosResponse {
  data: {
    videos: IVideo[]
    totalPages: number
    currentPage: number
    totalVideos: number
    hasLandVideo: boolean
    hasPlantVideo: boolean
  }
  message: string
}

// Submission related types
export interface ISubmissionGroup {
  submissionId: string
  landVideo?: IVideo
  plantVideo?: IVideo
  location?: string
  createdAt: string
  treesPlanted?: number
  treetype?: string
}

export type SubmissionStatus =
  | 'draft'
  | 'awaiting_plant'
  | 'pending_review'
  | 'approved'
  | 'rejected'

export type AiVerificationStatus =
  | 'skipped'
  | 'processing'
  | 'completed'
  | 'failed'

export type AiVerificationDecision =
  | 'auto_approved'
  | 'pending_verifier'
  | 'skipped'
  | 'ai_failed'

export interface ISubmissionAiVerification {
  status: AiVerificationStatus
  provider?: string
  countedMangroves?: number
  confidence?: number
  verifiedAt?: string
  decision?: AiVerificationDecision
  error?: string
  skipReason?: string
  rawResponse?: string
  walletAddress?: string
  gpsCoordinates?: { latitude: number; longitude: number }
  declaredTreesPlanted?: number
  autoApproveThreshold?: {
    minConfidence?: number
    maxCountDelta?: number
  }
}

export interface ISubmissionDoc {
  _id: string
  userWalletAddress: string
  status: SubmissionStatus
  reviewedAt?: string
  treesPlanted?: number
  planterRewardClaimedWei?: string
  /** Backend may expose tree type on submission (camelCase schema) */
  treeType?: string
  /** Alternate key from some payloads */
  treetype?: string
  votes?: Vote[]
  /** Mangrove plant AI count / routing (present after plant upload for mangrove) */
  aiVerification?: ISubmissionAiVerification
  /** Site Check this planting is linked to, if any */
  siteId?: string
  siteCheck?: ISubmissionSiteCheck
  /** Mangrove species ids from modules/siteCheck/mangroveSpecies */
  species?: string[]
  createdAt: string
  updatedAt: string
}

export interface IMySubmissionsResponse {
  message: string
  data: {
    submissions: ISubmissionDoc[]
    totalPages: number
    currentPage: number
    totalSubmissions: number
    hasLandClip?: boolean
    hasPlantClip?: boolean
  }
}

export type HealthCheckStatus = 'pending_review' | 'approved' | 'rejected'

export interface IHealthCheckDoc {
  _id: string
  submissionId: string
  checkpointIndex: number
  treesAlive: number
  distanceMeters: number
  videoCID?: string
  publicUrl?: string
  status: HealthCheckStatus
  votes?: Array<{
    voterWalletAddress: string
    vote: 'yes' | 'no'
    reasons?: string[]
  }>
  uploadedAt?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * The submission's snapshot of its Site Check: insideSite and
 * distanceToSiteM from the land clip GPS, plant* from the plant clip GPS.
 */
export interface ISubmissionSiteCheck {
  siteId?: string
  siteStatus?: SiteStatus
  verdictCode?: VerdictCode | null
  insideSite?: boolean
  distanceToSiteM?: number
  plantInsideSite?: boolean
  plantDistanceToSiteM?: number
  checkedAt?: string
}

export type SiteStatus = 'draft' | 'pending_review' | 'approved' | 'rejected'

export type SiteBoundaryMethod = 'walked' | 'pin_radius'

export type SitePhotoKind =
  | 'low_tide_360'
  | 'ground'
  | 'tide_mark'
  | 'high_tide'

export interface ISitePhoto {
  kind: SitePhotoKind
  objectPath: string
  publicUrl: string
  mimeType?: string
  sizeBytes?: number
  gpsCoordinates?: IGpsCoordinates
  uploadedAt: string
}

/** Sentinel-2 hydrology result (backend src/hydrology/types.ts). */
export interface IHydrologyResult {
  version: 'hydrology-s2-v1'
  hydrologyClass: HydrologyClass
  confidence: 'low' | 'medium' | 'high'
  notes: string[]
  site: {
    pixelCount: number
    observedPixelCount: number
    medianWetFraction: number | null
    p25WetFraction: number | null
    p75WetFraction: number | null
    permanentWaterShare: number
    rarelyWetShare: number
    mangroveCoverShare: number
    medianObservations: number
  }
  reference: {
    source: 'local' | 'default'
    edgePixelCount: number
    p25: number
    p50: number
    p75: number
    p90: number
    nearestMangroveM: number | null
    nearestTidalWaterM: number | null
  }
  imagery: {
    provider: string
    landcover: string
    mgrsTile: string
    epsg: number
    scenesListed: number
    scenesAfterCloudFilter: number
    scenesUsed: number
    scenesFailed: number
    firstSceneDate: string | null
    lastSceneDate: string | null
    windowPx: [number, number]
  }
  params: {
    years: number
    referenceRadiusM: number
    ndwiWetThreshold: number
    maxCloudPct: number
    minObservations: number
  }
  computedAt: string
  elapsedMs: number
}

export type SiteHydrologyStatus =
  | 'not_started'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface ISiteHydrology {
  status: SiteHydrologyStatus
  attempts?: number
  lastError?: string
  skipReason?: string
  startedAt?: string
  completedAt?: string
  result?: IHydrologyResult
}

export interface ISiteDoc {
  _id: string
  userWalletAddress: string
  name: string
  /** GeoJSON polygon, one closed ring of [lon, lat] pairs */
  boundary: { type: 'Polygon'; coordinates: [number, number][][] }
  boundaryMethod: SiteBoundaryMethod
  radiusM?: number
  center: IGpsCoordinates
  areaM2: number
  countryCode?: string
  reverseGeocode?: string
  answers: SiteAnswers
  photos: ISitePhoto[]
  hydrology?: ISiteHydrology
  verdict?: SiteVerdict
  verdictComputedAt?: string
  status: SiteStatus
  submittedAt?: string
  reviewedAt?: string
  votes?: Vote[]
  createdAt: string
  updatedAt: string
}

export interface ISiteVoteResult {
  siteId: string
  status: SiteStatus
  yesCount: number
  noCount: number
  totalVotes: number
  totalVerifiers: number
  majorityVote?: 'yes' | 'no'
  finalizationBlockedByVerifierThreshold?: boolean
}
