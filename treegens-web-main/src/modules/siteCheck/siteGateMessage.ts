import { apiErrorMessage } from '@/utils/apiErrorMessage'

/**
 * How each refusal starts when the API enforces Site Check on a mangrove
 * planting (SITE_CHECK_ENFORCEMENT=enforce).
 */
const GATE_MESSAGE_STARTS = [
  'Mangrove planting needs an approved Site Check',
  'This site has not been approved yet',
  'The Site Check verdict for this site is',
  'This video was filmed',
]

/** The Site Check refusal inside an upload error, or null for other errors. */
export function siteGateReason(err: unknown): string | null {
  const text = apiErrorMessage(err, '')
  const start = GATE_MESSAGE_STARTS.map(s => text.indexOf(s)).find(i => i >= 0)
  return start === undefined ? null : text.slice(start)
}
