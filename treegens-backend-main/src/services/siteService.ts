import mongoose from 'mongoose'
import env from '../config/environment'
import {
  deleteFromStorage,
  SITE_PHOTO_CACHE_CONTROL,
  uploadToStorage,
} from '../config/gcs'
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

/** Tries at saving a draft change while the site keeps changing under it. */
const DRAFT_SAVE_TRIES = 3

/** Deletes stored site photos; only ever objects under sites/. */
async function deleteSitePhotoObjects(paths: (string | undefined)[]) {
  await Promise.all(
    paths
      .filter((p): p is string => typeof p === 'string')
      .filter(p => p.startsWith('sites/'))
      .map(p => deleteFromStorage(p)),
  )
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

  /** Lowercased wallets of everyone who is a verifier right now. */
  private async activeVerifierWallets(): Promise<string[]> {
    const active = await User.find({ isVerifier: true })
      .select({ walletAddress: 1 })
      .lean()
    return active.map(u => String(u.walletAddress || '').toLowerCase())
  }

  /**
   * Loads the owner's draft, applies `change` and saves it, but only while
   * it is still a draft and its satellite check has not moved on since it
   * was read (the verdict is computed from that state). A submit or a
   * finished satellite run in between makes it read the site again and redo
   * the change, so neither a submitted site nor a newer verdict is
   * overwritten.
   */
  private async saveDraftChange(
    wallet: string,
    siteId: string,
    change: (site: any) => void,
  ) {
    for (let tries = 1; ; tries++) {
      const site = await this.findOwnedDraft(wallet, siteId)
      const seen = {
        status: site.hydrology?.status ?? null,
        completedAt: site.hydrology?.completedAt ?? null,
      }
      change(site)
      site.$where = {
        status: 'draft',
        'hydrology.status': seen.status,
        'hydrology.completedAt': seen.completedAt,
      }
      try {
        await site.save()
        return site
      } catch (error) {
        const raced =
          error instanceof mongoose.Error.DocumentNotFoundError ||
          error instanceof mongoose.Error.VersionError
        if (!raced || tries >= DRAFT_SAVE_TRIES) throw error
      }
    }
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
    // Each new site queues a satellite run; unfinished ones are capped so
    // one wallet cannot keep piling them up.
    const drafts = await Site.countDocuments({
      userWalletAddress: wallet.toLowerCase(),
      status: 'draft',
    })
    if (drafts >= env.SITE_MAX_DRAFTS_PER_WALLET) {
      throw new Error(SITE_ERRORS.tooManyDrafts)
    }
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
    let moved = false
    const site = await this.saveDraftChange(wallet, siteId, site => {
      const geometry = this.patchedGeometry(site, patch)
      // Clients may resend an unchanged boundary; only a moved one needs a
      // new satellite run.
      moved = Boolean(
        geometry &&
          !sameRing(geometry.boundary.coordinates, site.boundary?.coordinates),
      )
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
      // The run count is kept: moving the boundary must not become a way
      // around SITE_HYDROLOGY_MAX_ATTEMPTS. Only a recheck resets it.
      if (moved) {
        site.hydrology = {
          status: 'not_started',
          attempts: site.hydrology?.attempts ?? 0,
        }
      }
      refreshVerdict(site)
    })
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
    // Short cache: a replaced or deleted photo must stop being served soon.
    const uploaded = await uploadToStorage(
      file.buffer,
      generateUniqueFileName(file.originalname),
      file.mimetype,
      'sites',
      SITE_PHOTO_CACHE_CONTROL,
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
    // One photo per kind: a new one replaces the old. A single update that
    // only matches a draft, so a photo cannot land on a site submitted
    // during the upload, and an upload of another kind is not lost.
    const before = await Site.findOneAndUpdate(
      {
        _id: site._id,
        userWalletAddress: site.userWalletAddress,
        status: 'draft',
      },
      [
        {
          $set: {
            photos: {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ['$photos', []] },
                    cond: { $ne: ['$$this.kind', kind] },
                  },
                },
                { $literal: [photo] },
              ],
            },
          },
        },
      ],
      { new: false, projection: { photos: 1 } },
    ).lean()
    if (!before) {
      await deleteSitePhotoObjects([photo.objectPath])
      throw new Error(SITE_ERRORS.locked)
    }
    // The replaced photo's file is public; do not leave it behind.
    void deleteSitePhotoObjects(
      (before.photos ?? [])
        .filter(p => p.kind === kind && p.objectPath !== photo.objectPath)
        .map(p => p.objectPath),
    )
    return Site.findById(site._id).lean()
  }

  async submitSite(wallet: string, siteId: string) {
    const site = await this.saveDraftChange(wallet, siteId, site => {
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
    })
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
    const active = await this.activeVerifierWallets()
    // Votes of wallets that stopped verifying no longer count, so they must
    // not use up the turns of the verifiers who are left either.
    const counted = new Set(
      site.votes.map(v => v.voterWalletAddress).filter(w => active.includes(w)),
    )
    if (counted.size >= totalVerifiers) {
      throw new Error(SITE_ERRORS.allVoted)
    }
    if (site.votes.some(v => v.voterWalletAddress === voter)) {
      throw new Error(SITE_ERRORS.alreadyVoted)
    }

    const delegators = await User.find({ verifierDelegate: voter })
      .select({ walletAddress: 1 })
      .lean()
    const row = {
      voterWalletAddress: voter,
      vote,
      reasons: (Array.isArray(reasons) ? reasons : [])
        .filter(r => typeof r === 'string' && r.trim())
        .map(r => r.trim())
        .slice(0, 10),
      delegatedFor: delegators.map(d =>
        String(d.walletAddress || '').toLowerCase(),
      ),
      createdAt: new Date(),
    }
    // The checks above only pick the right message. This conditional push is
    // what stops a double tap or parallel requests from storing one
    // verifier's vote twice (and so counting it twice).
    const pushed = await Site.updateOne(
      {
        _id: site._id,
        status: 'pending_review',
        userWalletAddress: { $ne: voter },
        'votes.voterWalletAddress': { $ne: voter },
      },
      { $push: { votes: row } },
    )
    if (pushed.matchedCount === 0) {
      const fresh = await this.findSite(siteId)
      if (fresh.status !== 'pending_review') {
        throw new Error(SITE_ERRORS.notOpen)
      }
      throw new Error(SITE_ERRORS.alreadyVoted)
    }
    return this.attemptResolveSite(String(site._id), totalVerifiers, active)
  }

  /**
   * Settles the review once a strict majority of verifiers agree. Unlike
   * submissions there are no minority penalties: penalties and slashing are
   * keyed to submissions and their reward pools, and a site review pays out
   * nothing to be wrong about.
   */
  private async attemptResolveSite(
    siteId: string,
    totalVerifiers: number,
    activeWallets?: string[],
  ) {
    const site = await this.findSite(siteId)
    const resolution = resolveSiteReview({
      votes: site.votes,
      activeVerifierWallets:
        activeWallets ?? (await this.activeVerifierWallets()),
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

  /**
   * Recounts every pending site after the verifier pool changed (someone
   * became a verifier or lost their stake). A majority can then exist with
   * nobody left to cast the vote that would settle it; mirrors
   * SubmissionService.attemptResolvePendingSubmissions.
   */
  async attemptResolvePendingSites() {
    const totalVerifiers = await User.countDocuments({ isVerifier: true })
    if (totalVerifiers < env.MINIMUM_ACTIVE_VERIFIERS) {
      return { processed: 0, resolved: 0, totalVerifiers }
    }
    const active = await this.activeVerifierWallets()
    const pending = await Site.find(
      { status: 'pending_review' },
      { _id: 1 },
    ).lean()
    let resolved = 0
    for (const p of pending) {
      try {
        const result = await this.attemptResolveSite(
          String(p._id),
          totalVerifiers,
          active,
        )
        if (result.status === 'approved' || result.status === 'rejected') {
          resolved += 1
        }
      } catch (error: any) {
        console.error(
          `[SiteService] could not resolve site ${String(p._id)}`,
          error?.message,
        )
      }
    }
    return { processed: pending.length, resolved, totalVerifiers }
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
    // Conditional on draft, so a submit that lands in between wins.
    const deleted = await Site.findOneAndDelete({
      _id: site._id,
      status: 'draft',
    }).lean()
    if (!deleted) throw new Error(SITE_ERRORS.locked)
    // Photo files are public; deleting the site removes them too.
    await deleteSitePhotoObjects((deleted.photos ?? []).map(p => p.objectPath))
    return { siteId: String(site._id), deleted: true }
  }
}

export default SiteService
