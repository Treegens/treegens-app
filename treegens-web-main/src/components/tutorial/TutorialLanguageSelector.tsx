'use client'

// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim. This snapshot had no selector. It is used, as on live, by the
// tutorial, the planting rules cards and the species guide.
import classNames from 'classnames'
import {
  tutorialLanguageLabel,
  tutorialLanguages,
  type TutorialLang,
} from './plantTutorialCopy'

type Props = {
  value: TutorialLang
  onChange: (lang: TutorialLang) => void
  /**
   * 'sm' is the compact size for the planting rules cards and the species
   * guide header: smaller text and padding, the same 44 px tap target.
   */
  size?: 'md' | 'sm'
  align?: 'start' | 'end'
  /** The group's name for screen readers. */
  groupLabel?: string
}

/** Segmented English / Kiswahili / Amharic / Afaan Oromoo selector. */
export function TutorialLanguageSelector({
  value,
  onChange,
  size = 'md',
  align = 'end',
  groupLabel = 'Tutorial language',
}: Props) {
  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      className={classNames(
        'flex flex-wrap',
        align === 'end' ? 'justify-end' : 'justify-start',
        size === 'sm' ? 'gap-1' : 'gap-1.5',
      )}
    >
      {tutorialLanguages.map(lang => {
        const active = value === lang
        const label = tutorialLanguageLabel[lang]
        return (
          <button
            key={lang}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            onClick={() => onChange(lang)}
            className={classNames(
              'inline-flex min-h-11 items-center rounded-full border border-green-600 font-semibold transition-colors motion-reduce:transition-none',
              size === 'sm' ? 'px-2.5 text-xs' : 'px-3 text-sm',
              active
                ? 'bg-green-600 text-white'
                : 'bg-white text-green-700 hover:bg-green-50',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
