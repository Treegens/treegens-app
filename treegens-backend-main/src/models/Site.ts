import mongoose, { type Model } from 'mongoose'
import type { HydrologyResult } from '../hydrology'
import {
  ANSWER_LIMITS,
  ANSWER_OPTIONS,
  SITE_PHOTO_KINDS,
  type SiteBoundaryMethod,
  type SitePhotoKind,
} from '../services/siteRules'
import type { SiteAnswers, SiteVerdict } from '../siteCheck/siteVerdict'
import type { LonLat } from '../utils/geo'

export type SiteStatus = 'draft' | 'pending_review' | 'approved' | 'rejected'

export type SiteHydrologyStatus =
  | 'not_started'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped'

export type SiteGps = { latitude: number; longitude: number }

export type SitePhoto = {
  kind: SitePhotoKind
  objectPath: string
  publicUrl: string
  mimeType?: string
  sizeBytes?: number
  gpsCoordinates?: SiteGps
  uploadedAt: Date
}

export type SiteHydrology = {
  status: SiteHydrologyStatus
  attempts: number
  lastError?: string
  skipReason?: string
  startedAt?: Date
  completedAt?: Date
  result?: HydrologyResult
}

export type SiteVote = {
  voterWalletAddress: string
  vote: 'yes' | 'no'
  reasons: string[]
  delegatedFor: string[]
  createdAt?: Date
}

export type SiteDoc = {
  userWalletAddress: string
  name: string
  boundary: { type: 'Polygon'; coordinates: LonLat[][] }
  boundaryMethod: SiteBoundaryMethod
  radiusM?: number
  center: SiteGps
  areaM2: number
  countryCode?: string
  reverseGeocode?: string
  answers: SiteAnswers
  photos: SitePhoto[]
  hydrology: SiteHydrology
  verdict?: SiteVerdict
  verdictComputedAt?: Date
  status: SiteStatus
  submittedAt?: Date
  reviewedAt?: Date
  votes: SiteVote[]
  createdAt?: Date
  updatedAt?: Date
}

const gpsSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
)

/** GeoJSON polygon: one closed ring of [lon, lat] pairs. */
const polygonSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Polygon'], required: true },
    coordinates: { type: [[[Number]]], required: true },
  },
  { _id: false },
)

const choice = (values: string[]) => ({
  type: String,
  enum: values,
  required: false,
})

/** Field questionnaire; values mirror the unions in siteVerdict.ts. */
const answersSchema = new mongoose.Schema(
  {
    previousUse: choice(ANSWER_OPTIONS.previousUse),
    currentCover: choice(ANSWER_OPTIONS.currentCover),
    tideReach: choice(ANSWER_OPTIONS.tideReach),
    depthVsReference: choice(ANSWER_OPTIONS.depthVsReference),
    flowBlocked: choice(ANSWER_OPTIONS.flowBlocked),
    lossCauses: { type: [choice(ANSWER_OPTIONS.lossCauses)], default: [] },
    causeStillActive: choice(ANSWER_OPTIONS.causeStillActive),
    naturalRecruitment: choice(ANSWER_OPTIONS.naturalRecruitment),
    shoreExposure: choice(ANSWER_OPTIONS.shoreExposure),
    erosionScarps: { type: Boolean, required: false },
    substrate: choice(ANSWER_OPTIONS.substrate),
    nearestMangroves: choice(ANSWER_OPTIONS.nearestMangroves),
    nearbyCanopyImpact: {
      type: Number,
      required: false,
      ...ANSWER_LIMITS.nearbyCanopyImpact,
    },
    tideMarkCm: { type: Number, required: false, ...ANSWER_LIMITS.tideMarkCm },
    notes: {
      type: String,
      required: false,
      maxlength: ANSWER_LIMITS.notesMaxLength,
    },
  },
  { _id: false },
)

const photoSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: SITE_PHOTO_KINDS, required: true },
    /** Storage object path (same role as a clip's videoCID). */
    objectPath: { type: String, required: true },
    publicUrl: { type: String, required: true },
    mimeType: { type: String, required: false },
    sizeBytes: { type: Number, min: 0, required: false },
    gpsCoordinates: { type: gpsSchema, required: false },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

/** Background Sentinel-2 check; `result` is a HydrologyResult. */
const hydrologySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        'not_started',
        'queued',
        'processing',
        'completed',
        'failed',
        'skipped',
      ],
      default: 'not_started',
    },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, required: false },
    skipReason: { type: String, required: false },
    startedAt: { type: Date, required: false },
    completedAt: { type: Date, required: false },
    result: { type: mongoose.Schema.Types.Mixed, required: false },
  },
  { _id: false },
)

const voteSchema = new mongoose.Schema(
  {
    voterWalletAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    vote: { type: String, enum: ['yes', 'no'], required: true },
    reasons: { type: [String], default: [] },
    /** Wallets that delegated off-chain stake voting power to this verifier for this ballot. */
    delegatedFor: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

/** A planting site registered for a Site Check before mangroves go in. */
const siteSchema = new mongoose.Schema(
  {
    userWalletAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    boundary: { type: polygonSchema, required: true },
    boundaryMethod: {
      type: String,
      enum: ['walked', 'pin_radius'],
      required: true,
    },
    radiusM: { type: Number, min: 0, required: false },
    center: { type: gpsSchema, required: true },
    areaM2: { type: Number, min: 0, required: true },
    countryCode: {
      type: String,
      required: false,
      uppercase: true,
      trim: true,
      maxlength: 2,
    },
    reverseGeocode: { type: String, required: false, maxlength: 500 },
    answers: { type: answersSchema, default: () => ({}) },
    photos: { type: [photoSchema], default: [] },
    hydrology: { type: hydrologySchema, default: () => ({}) },
    /** SiteVerdict snapshot from siteVerdict.ts. */
    verdict: { type: mongoose.Schema.Types.Mixed, required: false },
    verdictComputedAt: { type: Date, required: false },
    status: {
      type: String,
      enum: ['draft', 'pending_review', 'approved', 'rejected'],
      default: 'draft',
      index: true,
    },
    submittedAt: { type: Date, required: false },
    reviewedAt: { type: Date, required: false },
    votes: { type: [voteSchema], default: [] },
  },
  { timestamps: true },
)

siteSchema.index({ userWalletAddress: 1, createdAt: -1 })
siteSchema.index({ status: 1, updatedAt: -1 })
siteSchema.index({ 'votes.voterWalletAddress': 1 })
siteSchema.index({ boundary: '2dsphere' })
// The hydrology sweeper scans by status, oldest first.
siteSchema.index({ 'hydrology.status': 1, updatedAt: 1 })

const Site: Model<SiteDoc> =
  (mongoose.models.Site as Model<SiteDoc> | undefined) ||
  mongoose.model<SiteDoc>('Site', siteSchema)

export default Site
