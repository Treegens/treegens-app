// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim. `hasPlanted.ts`, named below, is a live app file. In this
// snapshot the tutorial offers all four languages, but its own steps exist in
// English and Swahili only (Amharic and Oromo show them in English).
/**
 * The language a planter picked for the planting guidance, kept on the phone.
 *
 * The tutorial used to forget its language on every visit, and the create
 * screen never heard it at all. The planting rules and the species guide now
 * show on the tutorial AND on both create screens (Jimi 2026-10-14: make the
 * rules super clear to mangrove planters), so the choice made once is the one
 * they read everywhere after.
 *
 * Device-local and best-effort, like `hasPlanted.ts`: a blocked or full
 * storage keeps the choice in memory for this page load and the screens fall
 * back to English on the next one. Every access is wrapped in try/catch.
 *
 * Import-free at run time (the language type is a type-only import) so a
 * `node --test --experimental-strip-types` script can load it.
 */
import type { TutorialLang } from '@/components/tutorial/plantTutorialCopy'

export const TUTORIAL_LANG_KEY = 'treegens_tutorial_lang'

/** Same-page signal: every card on the create screen follows one choice. */
export const TUTORIAL_LANG_EVENT = 'treegens:tutorial-lang'

/**
 * Every language the tutorial offers. A Record, so adding a language to
 * `tutorialLanguages` without adding it here is a type error rather than a
 * saved choice that is silently thrown away.
 */
const KNOWN: Record<TutorialLang, true> = {
  English: true,
  Swahili: true,
  Amharic: true,
  Oromo: true,
}

/** Held when storage refuses the write, so this page load still follows it. */
let remembered: TutorialLang | null = null

export function isTutorialLang(value: unknown): value is TutorialLang {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(KNOWN, value)
  )
}

/** The saved choice, or null when there is none (or it is not a language). */
export function readSavedTutorialLang(): TutorialLang | null {
  try {
    const saved = localStorage.getItem(TUTORIAL_LANG_KEY)
    if (isTutorialLang(saved)) return saved
  } catch {
    // Storage blocked (private mode, in-app browser): use what this load chose.
  }
  return remembered
}

/** Saves the choice and tells every listening card on this page. */
export function saveTutorialLang(lang: TutorialLang): void {
  if (!isTutorialLang(lang)) return
  remembered = lang
  try {
    localStorage.setItem(TUTORIAL_LANG_KEY, lang)
  } catch {
    // Not saved for next time; this page load still follows it.
  }
  try {
    window.dispatchEvent(new CustomEvent(TUTORIAL_LANG_EVENT, { detail: lang }))
  } catch {
    // No window (a Node test): nothing on screen to update.
  }
}

/**
 * For `useSyncExternalStore`: calls back when the choice changes on this page
 * or in another tab.
 */
export function subscribeTutorialLang(onChange: () => void): () => void {
  try {
    window.addEventListener(TUTORIAL_LANG_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(TUTORIAL_LANG_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  } catch {
    return () => {}
  }
}
