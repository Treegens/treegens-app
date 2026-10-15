// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Adapted: this snapshot has no `treegens_offline_land_group` land link and no
// local group id. Its create screen holds the land-to-plant link in React
// state (the land's submission id), and create/[id] has it in its URL. So the
// record here is tagged with the land's submission id, and the live helpers
// that read the create screen's stored link (CreateScreenLink,
// readCreateScreenLink, createScreenLinkFor, recallSeedlingsForSubmission) are
// left out: create/[id] reads the record by its own id with
// recallPlantingChecks. The key, the record shape and the other helpers are
// the live ones.
/**
 * The planter's answers on the create screen for the planting in progress:
 * the wild-seedling answer from the land step and the rules confirm from the
 * plant step (Jimi 2026-10-14, see tutorial/plantingRulesCopy.ts).
 *
 * Why sessionStorage (snapshot): the land Submit and the plant clip are
 * often on two screens. After an online land upload, "Continue to after
 * video" opens create/[id], and a reload or a later visit reaches it through
 * the create screen's draft redirect. React state alone would lose the
 * seedling answer exactly while the planter is out planting, and create/[id]
 * would forget its reminder.
 *
 * ⛔ Device-local only. Nothing here goes into an upload, offlineVideoService
 * and its queue, videoService or public/sw.js (snapshot names; live lists its
 * own upload files): the backend refuses fields it does not know (this
 * snapshot's Joi upload schema too), and a queued clip it refuses fails.
 * Verifiers judge the rules from the videos.
 *
 * One record, for the one land-to-plant link the create screen holds at a
 * time, tagged with that land's submission id (snapshot; live: its
 * localGroupId). It is only ever read back onto the same land, so a stale
 * answer can never pre-fill a new planting. Snapshot lifecycle, at the points
 * where this snapshot sets and ends its land link:
 *   - written at the land Submit, once the upload returns the land's
 *     submission id (the id is made there). A land queued offline has no id
 *     yet, so it gets no record (an older one stays: it can only ever be
 *     read back onto its own submission), and create/[id] asks the seedling
 *     question again once that land has landed;
 *   - updated when the rules confirm is tapped on the create screen, and on
 *     create/[id] when the record is that submission's (never a new record
 *     there: the one slot may hold another land's answers);
 *   - read back, both answers, by create/[id] for its own submission;
 *   - removed when the planting ends: the plant Submit on the create screen,
 *     and on create/[id] (only when the record is that submission's).
 * The create screen never restores a land link after a reload (it starts at
 * the land step, and its draft redirect sends a landed land to create/[id]),
 * so unlike live it does not clear the record when it opens: create/[id]
 * needs it. That is also where a confirm tapped before a reload comes back
 * (live: on the create screen itself).
 *
 * Every access is wrapped in try/catch: blocked storage means the answers live
 * in React state only, as they did before. Import-free at run time.
 */
import type { SeedlingAnswer } from '@/components/tutorial/plantingRulesCopy'

export const PLANTING_CHECKS_KEY = 'treegens_planting_checks'

export type PlantingChecks = {
  /**
   * The land these answers belong to. Snapshot: the land's submission id
   * (live: the land clip's localGroupId).
   */
  groupId: string
  seedlings: SeedlingAnswer | null
  rulesConfirmed: boolean
}

export function isSeedlingAnswer(value: unknown): value is SeedlingAnswer {
  return value === 'none' || value === 'few' || value === 'many'
}

function read(): PlantingChecks | null {
  try {
    const raw = sessionStorage.getItem(PLANTING_CHECKS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PlantingChecks> | null
    const groupId =
      typeof parsed?.groupId === 'string' ? parsed.groupId.trim() : ''
    if (!groupId) return null
    return {
      groupId,
      seedlings: isSeedlingAnswer(parsed?.seedlings) ? parsed.seedlings : null,
      rulesConfirmed: parsed?.rulesConfirmed === true,
    }
  } catch {
    return null
  }
}

/** The answers saved for this land group, or null. */
export function recallPlantingChecks(groupId: string): PlantingChecks | null {
  const checks = read()
  return checks && checks.groupId === groupId.trim() ? checks : null
}

export function savePlantingChecks(checks: PlantingChecks): void {
  const groupId = checks.groupId.trim()
  if (!groupId) return
  try {
    sessionStorage.setItem(
      PLANTING_CHECKS_KEY,
      JSON.stringify({
        groupId,
        seedlings: isSeedlingAnswer(checks.seedlings) ? checks.seedlings : null,
        rulesConfirmed: checks.rulesConfirmed === true,
      }),
    )
  } catch {
    // Private mode can refuse storage; the answers then live in memory only.
  }
}

/**
 * Forget the answers. With a group id, only when they belong to that group
 * (create/[id] ending the create screen's link must not wipe another one).
 */
export function forgetPlantingChecks(groupId?: string | null): void {
  try {
    if (groupId !== undefined) {
      const checks = read()
      if (!checks || !groupId || checks.groupId !== groupId.trim()) return
    }
    sessionStorage.removeItem(PLANTING_CHECKS_KEY)
  } catch {
    // No storage means nothing to forget.
  }
}
