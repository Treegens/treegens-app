'use client'

// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim. The layers and the light root named below are the live app's.
// In this snapshot there is no dark mode and no `data-force-light`, so the
// card (and SpeciesPicker) always place the sheet on document.body; z-[100]
// keeps it above the bottom nav (z-50). The scroll lock finds
// MobileAppShell's `fixed inset-0 overflow-y-auto` frame, the same shape as
// live MobileGate.
import { useEffect, useId, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MdClose } from 'react-icons/md'
import {
  mangroveSpecies,
  speciesGuideUi,
  type MangroveSpeciesEntry,
  type MangroveSpeciesText,
  type SpeciesGuideUi,
} from '@/components/tutorial/mangroveSpeciesCopy'
import { plantingRules } from '@/components/tutorial/plantingRulesCopy'
import type { TutorialLang } from '@/components/tutorial/plantTutorialCopy'
import { TutorialLanguageSelector } from '@/components/tutorial/TutorialLanguageSelector'
import { RootDrawing } from './RootDrawing'

/**
 * The mangrove species guide (Jimi 2026-10-14, rule 3: planters should be able
 * to learn the species and tell them apart in the field), as a sheet over the
 * screen that opened it.
 *
 * Not ui/Modal: that one is portalled to document.body, which sits outside
 * the create screens' `data-force-light`, so in dark mode the guide would go
 * dark in the middle of the always-light filming flow. This sheet is placed
 * inside the `container` it is given (the create screen's light root, or
 * document.body on the tutorial, whose content sits in a `z-0` layer that
 * would otherwise let the sticky footer cover the sheet). z-[100], like
 * Modal: above the dock and the help chat, below the camera (z-[200]) and
 * the GPS question (z-[210]).
 *
 * Statically imported (no next/dynamic): the create screen is precached by
 * the HTML's own chunk list, so a lazy chunk would be missing with no signal.
 * No images either, for the same reason: the root drawings are inline SVG.
 */
type Props = {
  open: boolean
  onClose: () => void
  lang: TutorialLang
  onLangChange: (lang: TutorialLang) => void
  /** Where the sheet is placed. Null: in place. */
  container?: Element | null
  /**
   * The button that opened the sheet: focus goes back to it on close, and
   * the page it scrolls in is held still while the sheet is open.
   */
  returnFocusRef?: RefObject<HTMLElement | null>
}

export function MangroveSpeciesGuide({ open, container, ...rest }: Props) {
  if (!open) return null
  const sheet = <GuideSheet {...rest} />
  return container ? createPortal(sheet, container) : sheet
}

/**
 * The element that scrolls the page `el` is in. Not always the body: the app
 * scrolls inside MobileGate's `fixed inset-0 overflow-y-auto` frame, so
 * locking the body alone holds nothing still.
 */
function scrollerOf(el: Element | null | undefined): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
  }
  return null
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

function GuideSheet({
  onClose,
  lang,
  onLangChange,
  returnFocusRef,
}: Omit<Props, 'open' | 'container'>) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const ui: SpeciesGuideUi = speciesGuideUi[lang] ?? speciesGuideUi.English
  const rulesText = plantingRules[lang] ?? plantingRules.English
  // The content agent may still be filling the list; an empty or missing one
  // must show a line, not crash the filming screen.
  const species: MangroveSpeciesEntry[] = Array.isArray(mangroveSpecies)
    ? mangroveSpecies
    : []

  // Focus moves into the sheet, the page behind it stops scrolling, and both
  // come back when it closes. The opener is the button the screen passed in
  // (iOS Safari leaves document.activeElement on the body after a tap), and
  // the page is held still where it really scrolls (scrollerOf). The
  // overflow change keeps the scroll position.
  useEffect(() => {
    const opener =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    panelRef.current?.focus({ preventScroll: true })
    const locked = [document.body, scrollerOf(opener)].filter(
      (el): el is HTMLElement => el !== null,
    )
    const before = locked.map(el => el.style.overflow)
    for (const el of locked) el.style.overflow = 'hidden'
    return () => {
      locked.forEach((el, i) => {
        el.style.overflow = before[i]
      })
      opener?.focus()
    }
    // A ref object: the same one for the life of the card, so this runs once
    // per opening.
  }, [returnFocusRef])

  // Escape closes; Tab stays inside the sheet while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      {/* touch-none: a swipe on the dimmed page must not scroll it. */}
      <div
        className="absolute inset-0 touch-none bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white text-gray-900 shadow-xl outline-none sm:rounded-2xl"
      >
        {/* Header stays put while the list scrolls under it. */}
        <div className="flex-none border-b border-gray-200 bg-white px-4 pb-2 pt-3">
          <div className="flex items-start justify-between gap-3">
            <h2
              id={titleId}
              className="pt-2 text-lg font-bold leading-6 text-gray-900"
            >
              {ui.title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={ui.close}
              className="-mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-tree-green-2"
            >
              <MdClose className="h-6 w-6" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-1">
            <TutorialLanguageSelector
              value={lang}
              onChange={onLangChange}
              size="sm"
              align="start"
              groupLabel={rulesText.languageLabel}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-3">
          {ui.intro ? (
            <p className="text-sm leading-6 text-gray-700">{ui.intro}</p>
          ) : null}
          {ui.matchTip ? (
            <p className="mt-3 rounded-xl bg-[#eef7e7] p-3 text-sm font-semibold leading-6 text-tree-green-3">
              {ui.matchTip}
            </p>
          ) : null}

          {species.length === 0 ? (
            <p className="mt-4 rounded-xl bg-gray-50 p-3 text-sm leading-6 text-gray-700">
              {rulesText.guideEmpty}
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-4">
              {species.map(entry => (
                <li key={entry.id}>
                  <SpeciesCard entry={entry} lang={lang} ui={ui} />
                </li>
              ))}
            </ul>
          )}

          {ui.notListed ? (
            <p className="mt-4 text-sm leading-6 text-gray-700">
              {ui.notListed}
            </p>
          ) : null}

          <button
            type="button"
            onClick={onClose}
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-tree-green-2 px-4 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tree-green-2"
          >
            {ui.close}
          </button>
        </div>
      </div>
    </div>
  )
}

const FIELDS: [keyof MangroveSpeciesText, keyof SpeciesGuideUi][] = [
  ['roots', 'rootsLabel'],
  ['leaves', 'leavesLabel'],
  ['propagule', 'propaguleLabel'],
  ['whereItGrows', 'whereLabel'],
  ['tellApart', 'tellApartLabel'],
]

function SpeciesCard({
  entry,
  lang,
  ui,
}: {
  entry: MangroveSpeciesEntry
  lang: TutorialLang
  ui: SpeciesGuideUi
}) {
  const text = entry.text?.[lang] ?? entry.text?.English
  // A tree whose roots stay under the mud gets no drawing: the nearest shape
  // would show the planter roots they will never see. Its roots text says so.
  const showRoots = !entry.rootsNotVisible
  const rootName = ui.rootKindName?.[entry.roots]
  const localNames = (entry.localNames ?? []).filter(Boolean)
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-3.5">
      <div className="flex items-start gap-3">
        {showRoots ? (
          <div className="flex shrink-0 flex-col items-center gap-1">
            <RootDrawing kind={entry.roots} className="h-12 w-16" />
            {rootName ? (
              <span className="max-w-16 text-center text-[11px] font-semibold leading-4 text-tree-green-2">
                {rootName}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-6 text-gray-900">
            <i lang="la">{entry.scientificName}</i>
          </h3>
          {localNames.length ? (
            <p className="mt-0.5 text-sm leading-5 text-gray-700">
              <span className="font-semibold">{ui.localNameLabel}:</span>{' '}
              {localNames.join(', ')}
            </p>
          ) : null}
        </div>
      </div>
      {text ? (
        <dl className="mt-3 flex flex-col gap-2">
          {FIELDS.map(([field, label]) =>
            text[field] ? (
              <div key={field}>
                <dt className="text-xs font-bold uppercase tracking-wide text-tree-green-2">
                  {String(ui[label] ?? '')}
                </dt>
                <dd className="text-sm leading-6 text-gray-800">
                  {text[field]}
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}
    </article>
  )
}
