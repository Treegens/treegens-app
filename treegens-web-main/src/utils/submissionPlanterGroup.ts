import { submissionDocToVideos } from '@/services/submissionApiMappers'
import { VideoType } from '@/services/videoService'
import type {
  ISubmissionAiVerification,
  ISubmissionDoc,
  ISubmissionRejection,
  IVideo,
  SubmissionStatus,
  Vote,
} from '@/types'

/** Planter submission detail — mirrors `mobile/utils/submissionAdapter` `SubmissionGroup`. */
export type PlanterSubmissionGroup = {
  submissionId: string
  userWalletAddress: string
  createdAt: string
  location?: string
  landVideo?: IVideo
  plantVideo?: IVideo
  submissionStatus: SubmissionStatus
  /** When verifiers reached a verdict (approved or rejected). */
  reviewedAt?: string
  votes: Vote[]
  /** API summary of the verifier no votes; only on rejected submissions. */
  rejection?: ISubmissionRejection
  aiVerification?: ISubmissionAiVerification
  /** Mirrors Submission document — fallback if clip mapper missed fields */
  submissionTreesPlanted?: number
  submissionTreeSpecies?: string
}

function readSubmissionTreeSpecies(
  doc: ISubmissionDoc & Record<string, unknown>,
): string | undefined {
  const a = typeof doc.treeType === 'string' ? doc.treeType.trim() : ''
  const b = typeof doc.treetype === 'string' ? doc.treetype.trim() : ''
  return a || b || undefined
}

function readSubmissionTreesPlanted(
  doc: ISubmissionDoc & Record<string, unknown>,
): number | undefined {
  const n = doc.treesPlanted
  if (typeof n !== 'number' || Number.isNaN(n)) return undefined
  return Math.max(0, Math.floor(n))
}

export function submissionDocToPlanterGroup(
  doc: ISubmissionDoc & Record<string, unknown>,
): PlanterSubmissionGroup {
  const videos = submissionDocToVideos(
    doc as Parameters<typeof submissionDocToVideos>[0],
  )
  const landVideo = videos.find(v => v.type === VideoType.LAND)
  const plantVideo = videos.find(v => v.type === VideoType.PLANT)
  const location =
    plantVideo?.reverseGeocode || landVideo?.reverseGeocode || undefined
  const submissionTreesPlanted = readSubmissionTreesPlanted(doc)
  const submissionTreeSpecies = readSubmissionTreeSpecies(doc)
  return {
    submissionId: String(doc._id),
    userWalletAddress: doc.userWalletAddress,
    createdAt: doc.createdAt,
    location,
    landVideo,
    plantVideo,
    submissionStatus: doc.status,
    reviewedAt: typeof doc.reviewedAt === 'string' ? doc.reviewedAt : undefined,
    votes: doc.votes ?? [],
    rejection:
      typeof doc.rejection === 'object' && doc.rejection != null
        ? doc.rejection
        : undefined,
    submissionTreesPlanted,
    submissionTreeSpecies,
    aiVerification:
      typeof doc.aiVerification === 'object' && doc.aiVerification != null
        ? (doc.aiVerification as ISubmissionAiVerification)
        : undefined,
  }
}
