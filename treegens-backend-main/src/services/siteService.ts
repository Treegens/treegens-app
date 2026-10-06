import mongoose from 'mongoose'
import env from '../config/environment'
import { uploadToStorage } from '../config/gcs'
import { toHydrologySummary } from '../hydrology'
import { generateUniqueFileName } from '../middleware/upload'
import Site, { SiteHydrology } from '../models/Site'
import Submission from '../models/Submission'
import User from '../models/User'
import { missingAnswers } from '../siteCheck/siteVerdict'
import type { LonLat } from '../utils/geo'
import { enqueueNotification } from './notificationService'
import { triggerSiteHydrology } from './siteHydrologyJobService'
import {
  buildSiteGeometry,
  canRecheckHydrology,
  missingSitePhotos,
  normalizeCountryCode,
  resolveSiteReview,
  sanitizeSiteAnswers,
  SITE_ERRORS,
  SITE_PHOTO_KINDS,
  SiteBoundaryMethod,
  SitePhotoKind,
  siteVerdictFor,
} from './siteRules'

export type SiteInput = {
  name?: string
  boundaryMethod?: SiteBoundaryMethod
  ring?: LonLat[]
  center?: { latitude: number; longitude: number }
  radiusM?: number
  countryCode?: string | null
  reverseGeocode?: string | null
  answers?: Record<string, unknown>
}

type UploadedFile = {
  originalname: string
  size: number
  mimetype: string
  buffer: Buffer
}

type SiteVoteRow = {
  voterWalletAddress: string
  vote: 'yes' | 'no'
  reasons?: string[]
}

function hydrologySummaryOf(hydrology?: SiteHydrology | null) {
  return hydrology?.status === 'completed' && hydrology.result
    ? toHydrologySummary(hydrology.result)
    : null
}

/** Re-derives the verdict from the site's current answers and satellite result. */
function refreshVerdict(site: any) {
  site.verdict = siteVerdictFor(site, hydrologySummaryOf(site.hydrology))
  site.verdictComputedAt = new Date()
}

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, pages: Math.ceil(total / limit) || 0 }
}

function sameRing(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

class SiteService {
  private async findSite(siteId: string) {
    if (!mongoose.Types.ObjectId.isValid(siteId)) {
      throw new Error(SITE_ERRORS.notFound)
    }
    const site = await Site.findById(siteId)
    if (!site) throw new Error(SITE_ERRORS.notFound)
    return site
  }

  /** The owner's site; someone else's reads as missing, not forbidden. */
  private async findOwnedSite(wallet: string, siteId: string) {
    const site = await this.findSite(siteId)
    if (site.userWalletAddress !== wallet.toLowerCase()) {
      throw new Error(SITE_ERRORS.notFound)
    }
    return site
  }

  private async findOwnedDraft(wallet: string, siteId: string) {
    const site = await this.findOwnedSite(wallet, siteId)
    if (site.status !== 'draft') throw new Error(SITE_ERRORS.locked)
    return site
  }

  private async isVerifier(wallet: string): Promise<boolean> {
    const user = await User.findOne({
      walletAddress: wallet.toLowerCase(),
    }).lean()
    return Boolean(user?.isVerifier)
  }

  /** Queues the satellite check, then returns the site as stored. */
  private async withHydrologyQueued(siteId: string) {
    await triggerSiteHydrology(siteId)
    return Site.findById(siteId).lean()
  }

  async createSite(wallet: string, input: SiteInput) {
    const geometry = buildSiteGeometry(
      {
        boundaryMethod: input.boundaryMethod,
        ring: input.ring,
        center: input.center,
        radiusM: input.radiusM,
      },
      env.SITE_MAX_AREA_M2,
    )
    const fields = {
      userWalletAddress: wallet.toLowerCase(),
      name: String(input.name ?? '').trim(),
      ...geometry,
      countryCode: normalizeCountryCode(input.countryCode),
      reverseGeocode: input.reverseGeocode?.trim() || undefined,
      answers: sanitizeSiteAnswers(input.answers),
      photos: [],
      hydrology: { status: 'not_started' as const, attempts: 0 },
      status: 'draft' as const,
      votes: [],
    }
    const site = await Site.create({
      ...fields,
      verdict: siteVerdictFor(fields, null),
      verdictComputedAt: new Date(),
    })
    return this.withHydrologyQueued(String(site._id))
  }

  /** Rebuilt geometry when the patch touches the boundary, otherwise null. */
  private patchedGeometry(site: any, patch: SiteInput) {
    const touched =
      patch.boundaryMethod !== undefined ||
      patch.ring !== undefined ||
      patch.center !== undefined ||
      patch.radiusM !== undefined
    if (!touched) return null
    const wasPin = site.boundaryMethod === 'pin_radius'
    return buildSiteGeometry(
      {
        boundaryMethod: patch.boundaryMethod ?? site.boundaryMethod,
        ring: patch.ring ?? site.boundary?.coordinates?.[0],
        center: patch.center ?? (wasPin ? site.center : undefined),
        radiusM: patch.radiusM ?? (wasPin ? site.radiusM : undefined),
      },
      env.SITE_MAX_AREA_M2,
    )
  }

  async updateSite(wallet: string, siteId: string, patch: SiteInput) {
    const site = await this.findOwnedDraft(wallet, siteId)
    const geometry = this.patchedGeometry(site, patch)
    // Clients may resend an unchanged boundary; only a moved one needs a
    // new satellite run.
    const moved =
      geometry &&
      !sameRing(geometry.boundary.coordinates, site.boundary?.coordinates)
    if (patch.name !== undefined) site.name = String(patch.name).trim()
    if (patch.answers !== undefined) {
      site.answers = sanitizeSiteAnswers(patch.answers)
    }
    if (patch.countryCode !== undefined) {
      site.countryCode = normalizeCountryCode(patch.countryCode)
    }
    if (patch.reverseGeocode !== undefined) {
      site.reverseGeocode = patch.reverseGeocode?.trim() || undefined
    }
    if (geometry) site.set({ ...geometry, radiusM: geometry.radiusM })
    if (moved) site.hydrology = { status: 'not_started', attempts: 0 }
    refreshVerdict(site)
    await site.save()
    if (moved) return this.withHydrologyQueued(String(site._id))
    return site.toObject()
  }

  async addPhoto(
    wallet: string,
    siteId: string,
    file: UploadedFile,
    kind: string,
    latitude?: number | string,
    longitude?: number | string,
  ) {
    if (!SITE_PHOTO_KINDS.includes(kind as SitePhotoKind)) {
      throw new Error(SITE_ERRORS.invalidPhotoKind)
    }
    if (!file.mimetype.startsWith('image/')) {
      throw new Error(SITE_ERRORS.imageOnly)
    }
    const site = await this.findOwnedDraft(wallet, siteId)
    const uploaded = await uploadToStorage(
      file.buffer,
      generateUniqueFileName(file.originalname),
      file.mimetype,
      'sites',
    )
    const lat = parseFloat(String(latitude))
    const lng = parseFloat(String(longitude))
    const hasGps =
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !Number.isNaN(lat + lng)
    const photo = {
      kind: kind as SitePhotoKind,
      objectPath: uploaded.videoCID,
      publicUrl: uploaded.publicUrl,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      ...(hasGps ? { gpsCoordinates: { latitude: lat, longitude: lng } } : {}),
      uploadedAt: new Date(),
    }
    // One photo per kind: a new one replaces the old.
    site.photos = [...site.photos.filter(p => p.kind !== kind), photo]
    await site.save()
    return site.toObject()
  }

  async submitSite(wallet: string, siteId: string) {
    const site = await this.findOwnedDraft(wallet, siteId)
    const missing = missingAnswers(sanitizeSiteAnswers(site.answers))
    if (missing.length) {
      throw new Error(`${SITE_ERRORS.missingAnswers}: ${missing.join(', ')}`)
    }
    if (missingSitePhotos(site.photos).length) {
      throw new Error(SITE_ERRORS.missingPhotos)
    }
    site.status = 'pending_review'
    site.submittedAt = new Date()
    refreshVerdict(site)
    await site.save()
    return site.toObject()
  }

  async getSiteForViewer(wallet: string, siteId: string) {
    const site = await this.findSite(siteId)
    if (site.userWalletAddress === wallet.toLowerCase()) return site.toObject()
    if (await this.isVerifier(wallet)) return site.toObject()
    throw new Error(SITE_ERRORS.accessDenied)
  }

  async listMySites(wallet: string, page: number, limit: number) {
    const filter = { userWalletAddress: wallet.toLowerCase() }
    const [sites, total] = await Promise.all([
      Site.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Site.countDocuments(filter),
    ])
    return { sites, pagination: pagination(page, limit, total) }
  }

  /** Sites waiting for this verifier: not their own, not yet voted on. */
  async listModerationQueue(wallet: string, page: number, limit: number) {
    const w = wallet.toLowerCase()
    const filter = {
      status: 'pending_review',
      userWalletAddress: { $ne: w },
      'votes.voterWalletAddress': { $ne: w },
    }
    const [sites, total] = await Promise.all([
      Site.find(filter)
        .sort({ submittedAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Site.countDocuments(filter),
    ])
    return { sites, pagination: pagination(page, limit, total) }
  }

  async castSiteVote(
    siteId: string,
    voterWallet: string,
    vote: 'yes' | 'no',
    reasons?: string[],
  ) {
    const voter = voterWallet.toLowerCase()
    const site = await this.findSite(siteId)
    // Approving your own site would let you unlock rewards for it.
    if (site.userWalletAddress === voter) throw new Error(SITE_ERRORS.selfVote)
    if (site.status !== 'pending_review') throw new Error(SITE_ERRORS.notOpen)

    const totalVerifiers = await User.countDocuments({ isVerifier: true })
    if (totalVerifiers === 0) throw new Error(SITE_ERRORS.noVerifiers)
    if (site.votes.length >= totalVerifiers) {
      throw new Error(SITE_ERRORS.allVoted)
    }
    if (site.votes.some(v => v.voterWalletAddress === voter)) {
      throw new Error(SITE_ERRORS.alreadyVoted)
    }

    const delegators = await User.find({ verifierDelegate: voter })
      .select({ walletAddress: 1 })
      .lean()
    site.votes.push({
      voterWalletAddress: voter,
      vote,
      reasons: (Array.isArray(reasons) ? reasons : [])
        .filter(r => typeof r === 'string' && r.trim())
        .map(r => r.trim())
        .slice(0, 10),
      delegatedFor: delegators.map(d =>
        String(d.walletAddress || '').toLowerCase(),
      ),
    })
    await site.save()
    return this.attemptResolveSite(String(site._id), totalVerifiers)
  }

  /**
   * Settles the review once a strict majority of verifiers agree. Unlike
   * submissions there are no minority penalties: penalties and slashing are
   * keyed to submissions and their reward pools, and a site review pays out
   * nothing to be wrong about.
   */
  private async attemptResolveSite(siteId: string, totalVerifiers: number) {
    const site = await this.findSite(siteId)
    const active = await User.find({ isVerifier: true })
      .select({ walletAddress: 1 })
      .lean()
    const resolution = resolveSiteReview({
      votes: site.votes,
      activeVerifierWallets: active.map(u => String(u.walletAddress || '')),
      totalVerifiers,
      minimumActiveVerifiers: env.MINIMUM_ACTIVE_VERIFIERS,
    })
    if (!resolution.outcome || site.status !== 'pending_review') {
      return this.buildVoteResult(site, totalVerifiers, resolution)
    }
    // Conditional on pending_review so two simultaneous final votes settle
    // (and notify) only once.
    const settled = await Site.findOneAndUpdate(
      { _id: site._id, status: 'pending_review' },
      { $set: { status: resolution.outcome, reviewedAt: new Date() } },
      { new: true },
    ).lean()
    if (settled) this.notifyOwner(settled)
    return this.buildVoteResult(settled ?? site, totalVerifiers, resolution)
  }

  private notifyOwner(site: any) {
    const approved = site.status === 'approved'
    void enqueueNotification({
      recipientWalletAddress: site.userWalletAddress,
      kind: 'site_outcome',
      title: approved ? 'Site approved' : 'Site reviewed',
      body: approved
        ? 'Verifiers approved your Site Check. You can link your plantings to this site.'
        : 'Verifiers reviewed your Site Check and did not approve it. Open the site to see why.',
      link: `/sites/${String(site._id)}`,
      payload: { siteId: String(site._id), status: site.status },
    }).catch(() => {})
  }

  private buildVoteResult(
    site: any,
    totalVerifiers: number,
    resolution: ReturnType<typeof resolveSiteReview>,
  ) {
    const votes = (site.votes as SiteVoteRow[]).map(v => ({
      voterWalletAddress: v.voterWalletAddress,
      vote: v.vote,
      reasons: v.reasons,
    }))
    return {
      siteId: String(site._id),
      status: site.status,
      yesCount: votes.filter(v => v.vote === 'yes').length,
      noCount: votes.filter(v => v.vote === 'no').length,
      totalVotes: votes.length,
      totalVerifiers,
      votes,
      ...(resolution.majorityVote
        ? { majorityVote: resolution.majorityVote }
        : {}),
      ...(resolution.blockedByVerifierThreshold
        ? { finalizationBlockedByVerifierThreshold: true }
        : {}),
    }
  }

  /** Owner or verifier may rerun a failed, skipped or month-old check. */
  async recheckHydrology(wallet: string, siteId: string) {
    const site = await this.findSite(siteId)
    const isOwner = site.userWalletAddress === wallet.toLowerCase()
    if (!isOwner && !(await this.isVerifier(wallet))) {
      throw new Error(SITE_ERRORS.accessDenied)
    }
    if (!canRecheckHydrology(site.hydrology, new Date())) {
      throw new Error(SITE_ERRORS.recheckTooSoon)
    }
    await Site.updateOne(
      { _id: site._id },
      { $set: { 'hydrology.attempts': 0 } },
    )
    return this.withHydrologyQueued(String(site._id))
  }

  async deleteDraftSite(wallet: string, siteId: string) {
    const site = await this.findOwnedDraft(wallet, siteId)
    if (await Submission.exists({ siteId: site._id })) {
      throw new Error(SITE_ERRORS.linked)
    }
    await Site.deleteOne({ _id: site._id })
    return { siteId: String(site._id), deleted: true }
  }
}

export default SiteService
