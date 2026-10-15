'use client'

// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim. hooks/useHydrated.ts, named below, is a live app file; the same
// first-render rule holds here.
import { useCallback, useSyncExternalStore } from 'react'
import type { TutorialLang } from '@/components/tutorial/plantTutorialCopy'
import {
  readSavedTutorialLang,
  saveTutorialLang,
  subscribeTutorialLang,
} from '@/utils/tutorialLanguage'

const serverSnapshot = (): TutorialLang | null => null

/**
 * The planter's saved guidance language, shared by every card on the page.
 *
 * English on the server and on the first client render (the server cannot
 * read localStorage, and a first render that differs from the server HTML
 * throws the page away; see hooks/useHydrated.ts), then the saved choice.
 * Changing it saves it and moves every card that uses this hook together.
 */
export function useTutorialLang(): [
  TutorialLang,
  (lang: TutorialLang) => void,
] {
  const saved = useSyncExternalStore(
    subscribeTutorialLang,
    readSavedTutorialLang,
    serverSnapshot,
  )
  const setLang = useCallback(
    (lang: TutorialLang) => saveTutorialLang(lang),
    [],
  )
  return [saved ?? 'English', setLang]
}
