import type { ISubmissionSiteCheck } from '@/types'
import { apiErrorMessage } from '@/utils/apiErrorMessage'

/**
 * How each Site Check refusal from the upload API starts (the backend's
 * siteGate.ts): the planting gate under SITE_CHECK_ENFORCEMENT=enforce, a
 * land clip filmed outside its linked site, and a site that is not the
 * uploader's. public/sw.js keeps the same list for queued uploads.
 */
const GATE_MESSAGE_STARTS = [
  'Mangrove planting needs an approved Site Check',
  'This site has not been approved yet',
  'This site was rejected in review',
  'The Site Check verdict for this site is',
  'Your before video was filmed',
  'Your planting video was filmed',
  'This video was filmed',
  'Site not found',
]

/** The Site Check refusal inside an upload error, or null for other errors. */
export function siteGateReason(err: unknown): string | null {
  const text = apiErrorMessage(err, '')
  const start = GATE_MESSAGE_STARTS.map(s => text.indexOf(s))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)[0]
  return start === undefined ? null : text.slice(start)
}

/**
 * Warning for a saved before (land) clip filmed outside its linked site, or
 * ''. Where a planting is measured from is fixed by this clip.
 */
export function outsideSiteWarning(siteCheck?: ISubmissionSiteCheck): string {
  if (siteCheck?.insideSite !== false) return ''
  const metres = Math.round(siteCheck.distanceToSiteM ?? 0)
  return `Your before video was filmed ${metres} m outside the checked site. Film it again from inside the site.`
}
