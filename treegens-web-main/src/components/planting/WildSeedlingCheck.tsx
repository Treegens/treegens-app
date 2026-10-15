'use client'

// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim. In this snapshot Submit has no GPS wait: the screens pass
// `disabled` while the clip uploads or is queued, for the same reason (Submit
// read the answer when it was tapped, and saves that one).
import classNames from 'classnames'
import { useId } from 'react'
import {
  seedlingAnswers,
  seedlingCheck,
  type SeedlingAnswer,
} from '@/components/tutorial/plantingRulesCopy'
import type { TutorialLang } from '@/components/tutorial/plantTutorialCopy'
import { useTutorialLang } from './useTutorialLang'

/**
 * "Did you look for wild mangrove seedlings here?" on the land step (Jimi
 * 2026-10-14, rule 4: look for natural regeneration before planting).
 *
 * The planter must answer, so there is no default: an answer the form gave is
 * not one they gave (the mangrove question works the same way). No answer
 * blocks or flags anything. "A few" and "Many" both get the same advice,
 * shown under the choice; Jimi chose advice only.
 *
 * The answer stays on the phone (plantingChecks.ts). It is never sent: the
 * land video is the evidence, which is why the film line is here.
 *
 * create/[id] asks it too when the phone has no answer from the land step (a
 * land filmed before this release, in another session or on another build).
 * Its land video is already filmed, so it hides the film line.
 */
type Props = {
  value: SeedlingAnswer | null
  onChange: (answer: SeedlingAnswer) => void
  className?: string
  /** Defaults to the planter's saved guidance language. */
  lang?: TutorialLang
  /**
   * While Submit waits for a GPS fix: it read the answer when it was
   * tapped, and saves that one.
   */
  disabled?: boolean
  /** "Film the wild seedlings ... in this land video". Off once it is filmed. */
  filmLine?: boolean
}

export function WildSeedlingCheck({
  value,
  onChange,
  className,
  lang,
  disabled = false,
  filmLine = true,
}: Props) {
  const [savedLang] = useTutorialLang()
  const t = seedlingCheck[lang ?? savedLang] ?? seedlingCheck.English
  const questionId = useId()
  const helpId = useId()

  return (
    <section
      aria-labelledby={questionId}
      data-seedling-check
      className={classNames(
        'rounded-2xl border-2 border-tree-green-2 bg-white p-3.5',
        className,
      )}
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-tree-green-2">
        {t.label}
      </p>
      <h2
        id={questionId}
        className="mt-0.5 text-base font-bold leading-6 text-[#111]"
      >
        <span aria-hidden="true">🌱 </span>
        {t.question}
      </h2>
      <div id={helpId}>
        <p className="mt-1 text-sm leading-6 text-gray-700">{t.help}</p>
        <ul className="mt-1 flex flex-col gap-1">
          {t.signs.map(sign => (
            <li
              key={sign}
              className="flex items-start gap-2 text-sm leading-6 text-gray-700"
            >
              <span aria-hidden="true" className="text-tree-green-2">
                •
              </span>
              {sign}
            </li>
          ))}
        </ul>
      </div>

      <div
        role="radiogroup"
        aria-labelledby={questionId}
        aria-describedby={helpId}
        aria-required="true"
        className="mt-3 grid grid-cols-3 gap-2"
      >
        {seedlingAnswers.map(answer => {
          const active = value === answer
          return (
            <button
              key={answer}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(answer)}
              className={classNames(
                'min-h-11 rounded-lg border-2 px-2 py-2 text-sm font-semibold leading-5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tree-green-2 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none',
                active
                  ? 'border-tree-green-2 bg-tree-green-2 text-white'
                  : 'border-gray-300 bg-white text-gray-700',
              )}
            >
              {t.answers[answer]}
            </button>
          )
        })}
      </div>

      {/* Always in the page, so a screen reader hears the advice the moment
          an answer is chosen. */}
      <div aria-live="polite">
        {value === 'few' || value === 'many' ? (
          <div className="mt-3 rounded-xl bg-amber-50 p-3">
            <p className="text-sm font-bold text-amber-900">{t.adviceLabel}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {t.advice.map(line => (
                <li
                  key={line}
                  className="flex items-start gap-2 text-sm font-semibold leading-6 text-amber-900"
                >
                  <span aria-hidden="true">✓</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : value === 'none' ? (
          <p className="mt-3 rounded-xl bg-[#eef7e7] p-3 text-sm font-semibold leading-6 text-tree-green-3">
            {t.none}
          </p>
        ) : null}
      </div>

      {filmLine ? (
        <p className="mt-3 text-sm font-semibold leading-6 text-tree-green-2">
          <span aria-hidden="true">🎥 </span>
          {t.film}
        </p>
      ) : null}
    </section>
  )
}
