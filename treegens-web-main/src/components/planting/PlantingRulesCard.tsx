'use client'

// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim but for one comment below (the guide's host). useGpsRecordGate,
// named below, is the live app's; this snapshot's record tap is a plain
// file input, and it is not gated either. "Submit waits for a GPS fix" here
// reads "Submit is uploading or queueing the clip".
import classNames from 'classnames'
import { useId, useRef, useState } from 'react'
import { speciesGuideUi } from '@/components/tutorial/mangroveSpeciesCopy'
import {
  plantingRules,
  type PlantingRulesText,
  type SeedlingAnswer,
} from '@/components/tutorial/plantingRulesCopy'
import type { TutorialLang } from '@/components/tutorial/plantTutorialCopy'
import { TutorialLanguageSelector } from '@/components/tutorial/TutorialLanguageSelector'
import { MangroveSpeciesGuide } from './MangroveSpeciesGuide'
import { useTutorialLang } from './useTutorialLang'

/**
 * The four planting rules (Jimi 2026-10-14; the rules and their sources are in
 * tutorial/plantingRulesCopy.ts), on every screen a planter meets before they
 * plant:
 *
 *   - 'tutorial': read-only, in the tutorial's own language.
 *   - 'land': read-only, on the create screen's land step, before the trip.
 *   - 'plant': above "Tap to record the planting", with the one tap the plant
 *     Submit needs for mangroves. Controlled: the screen owns `confirmed`,
 *     because it has to survive an app-update reload (see plantingChecks.ts).
 *     `disabled` while Submit waits for a GPS fix or hands the clip over:
 *     Submit read the confirm when it was tapped, so a tap taken back during
 *     that wait would not stop it.
 *
 * The confirm never gates the record tap: iOS opens the camera only from a
 * direct tap on the file input (see useGpsRecordGate), and a clip filmed
 * first and confirmed after is fine. Submit is what waits for it.
 *
 * Every variant opens the species guide (rule 3).
 */
type Common = { className?: string }
type Props = Common &
  (
    | {
        variant: 'tutorial'
        lang: TutorialLang
        onLangChange: (lang: TutorialLang) => void
      }
    | { variant: 'land' }
    | {
        variant: 'plant'
        confirmed: boolean
        onConfirm: (confirmed: boolean) => void
        /** The land step's answer: "A few" or "Many" shows a reminder. */
        seedlingAnswer?: SeedlingAnswer | null
        disabled?: boolean
      }
  )

export function PlantingRulesCard(props: Props) {
  const [savedLang, saveLang] = useTutorialLang()
  const lang = props.variant === 'tutorial' ? props.lang : savedLang
  const setLang = props.variant === 'tutorial' ? props.onLangChange : saveLang
  const t = plantingRules[lang] ?? plantingRules.English
  const learnLabel = (speciesGuideUi[lang] ?? speciesGuideUi.English).open

  const titleId = useId()
  const cardRef = useRef<HTMLElement>(null)
  // Focus goes back here when the guide closes. Not document.activeElement:
  // iOS Safari does not focus a button on tap, so that would be the body and
  // a VoiceOver user would lose their place on a long screen.
  const learnRef = useRef<HTMLButtonElement>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideHost, setGuideHost] = useState<Element | null>(null)
  const openGuide = () => {
    // Inside the filming screens' light root when there is one, so the sheet
    // stays light in dark mode; otherwise over the whole page.
    // (Snapshot: there is no dark mode and no `data-force-light` root here,
    // so this is always document.body. Kept as is to stay in step.)
    setGuideHost(
      cardRef.current?.closest('[data-force-light]') ?? document.body,
    )
    setGuideOpen(true)
  }

  const onCreateScreen = props.variant !== 'tutorial'
  // On the tutorial the card sits among h3 sections under the page's h1; on
  // the create screens it is a section of its own, like "Land video" (h2).
  const Title = onCreateScreen ? 'h2' : 'h3'
  const Sub = onCreateScreen ? 'h3' : 'h4'

  return (
    <section
      ref={cardRef}
      aria-labelledby={titleId}
      data-planting-rules={props.variant}
      className={classNames(
        'overflow-hidden rounded-2xl border-2 border-tree-green-2 bg-[#eef7e7] shadow-sm',
        props.className,
      )}
    >
      {/* Solid brand green on purpose: this is the card that must not be
          scrolled past. White on #435F24 reads the same in both themes. */}
      <div className="bg-tree-green-2 px-3.5 py-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-white">
          {t.label}
        </p>
        <Title
          id={titleId}
          className="mt-0.5 text-lg font-bold leading-6 text-white"
        >
          <span aria-hidden="true">🌱 </span>
          {t.title}
        </Title>
      </div>

      <div className="p-3.5">
        {onCreateScreen ? (
          <div className="mb-3">
            <TutorialLanguageSelector
              value={lang}
              onChange={setLang}
              size="sm"
              align="start"
              groupLabel={t.languageLabel}
            />
          </div>
        ) : null}

        <p className="text-sm leading-6 text-[#111]">{t.intro}</p>

        <ol className="mt-3 flex flex-col gap-3">
          {t.rules.map((rule, i) => (
            <li
              key={rule.title}
              className={classNames(
                'flex items-start gap-3',
                // The 2 m rule is the one verifiers check on every planting:
                // first, boxed and bold.
                i === 0 && 'rounded-xl bg-white p-3 ring-2 ring-tree-green-2',
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-tree-green-2 text-sm font-bold text-white"
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <Sub
                  className={classNames(
                    'font-bold text-tree-green-3',
                    i === 0 ? 'text-base leading-6' : 'text-[15px] leading-6',
                  )}
                >
                  {rule.title}
                </Sub>
                <p
                  className={classNames(
                    'mt-0.5 text-sm leading-6 text-[#111]',
                    i === 0 && 'font-semibold',
                  )}
                >
                  {/* The create screens show each rule in its fewest words:
                      the record area sits under this card, and a planter
                      films several plantings a day. In full one tap below. */}
                  {onCreateScreen ? rule.short : rule.body}
                </p>
                {i === 0 ? <DistanceDiagram t={t} /> : null}
              </div>
            </li>
          ))}
        </ol>

        {onCreateScreen ? (
          <details className="mt-3 rounded-xl bg-white">
            <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-semibold leading-6 text-tree-green-2">
              {t.fullRulesLabel}
            </summary>
            <ol className="flex list-decimal flex-col gap-2 px-3 pb-3 pl-8">
              {t.rules.map(rule => (
                <li key={rule.title} className="text-sm leading-6 text-[#111]">
                  {/* No "." after the title: Amharic ends a sentence with ። */}
                  <span className="block font-semibold text-tree-green-3">
                    {rule.title}
                  </span>
                  {rule.body}
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        <button
          ref={learnRef}
          type="button"
          onClick={openGuide}
          aria-haspopup="dialog"
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border-2 border-tree-green-2 bg-white px-4 text-sm font-bold text-tree-green-2 transition-colors hover:bg-green-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tree-green-2 motion-reduce:transition-none"
        >
          <span aria-hidden="true">🌿</span>
          {learnLabel}
        </button>

        {/* The reason in full on the tutorial; folded on the create screens,
            where the screen is for doing, not reading. */}
        {onCreateScreen ? (
          <details className="mt-3 rounded-xl bg-white">
            {/* Left as a list item so the browser keeps its open/closed
                marker: a flex summary loses it in Chrome. */}
            <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-semibold leading-6 text-tree-green-2">
              {t.whyLabel}
            </summary>
            <div className="px-3 pb-3">
              <WhyBody t={t} />
            </div>
          </details>
        ) : (
          <div className="mt-4 rounded-xl bg-white p-3">
            <Sub className="text-sm font-bold text-tree-green-2">
              {t.whyLabel}
            </Sub>
            <div className="mt-1">
              <WhyBody t={t} />
            </div>
          </div>
        )}

        {props.variant === 'land' ? (
          <p className="mt-3 text-sm font-semibold leading-6 text-tree-green-3">
            {t.landNote}
          </p>
        ) : null}

        {props.variant === 'plant' ? (
          <PlantConfirm
            t={t}
            confirmed={props.confirmed}
            onConfirm={props.onConfirm}
            seedlingAnswer={props.seedlingAnswer ?? null}
            disabled={props.disabled ?? false}
          />
        ) : null}
      </div>

      <MangroveSpeciesGuide
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        lang={lang}
        onLangChange={setLang}
        container={guideHost}
        returnFocusRef={learnRef}
      />
    </section>
  )
}

function WhyBody({ t }: { t: PlantingRulesText }) {
  return (
    <>
      <p className="text-sm leading-6 text-[#111]">{t.why}</p>
      <figure className="mt-2 border-l-4 border-tree-green-1 pl-3">
        <p className="text-xs leading-5 text-gray-600">{t.quoteIntro}</p>
        <blockquote
          lang="en"
          className="mt-0.5 text-sm italic leading-6 text-[#111]"
        >
          “{t.quote}”
        </blockquote>
        <figcaption className="mt-0.5 text-xs leading-5 text-gray-600">
          {t.quoteSource}
        </figcaption>
      </figure>
      <p className="mt-2 text-sm leading-6 text-[#111]">{t.quoteMeaning}</p>
    </>
  )
}

/**
 * A living tree, a new propagule beside it, and the 2 m between them.
 * Literal colours and its own pale panel, so it reads the same in both themes;
 * the caption under it says the same in words.
 */
function DistanceDiagram({ t }: { t: PlantingRulesText }) {
  const wood = '#435f24'
  const leaf = '#6b8c3b'
  return (
    <figure className="mt-3">
      <svg
        viewBox="0 0 240 104"
        aria-hidden="true"
        focusable="false"
        className="h-auto w-full max-w-xs"
      >
        <rect x="0" y="0" width="240" height="104" rx="10" fill="#f7fbf3" />
        <rect x="0" y="78" width="240" height="26" fill="#e7d8bf" />
        <path d="M0 78 L240 78" stroke="#7a4a1e" strokeWidth="1.5" />
        {/* The living tree: crown, trunk, stilt roots. */}
        <ellipse cx="52" cy="24" rx="34" ry="16" fill={leaf} />
        <path
          d="M52 30 L52 58"
          stroke={wood}
          strokeWidth="5"
          strokeLinecap="round"
        />
        <g fill="none" stroke={wood} strokeWidth="2.5" strokeLinecap="round">
          <path d="M52 50 Q34 52 28 78" />
          <path d="M52 50 Q70 52 76 78" />
          <path d="M52 56 Q42 60 40 78" />
          <path d="M52 56 Q62 60 64 78" />
        </g>
        {/* The new propagule, same species, planted in the mud. */}
        <path
          d="M196 44 L196 82"
          stroke={wood}
          strokeWidth="4"
          strokeLinecap="round"
        />
        <ellipse cx="190" cy="44" rx="7" ry="4" fill={leaf} />
        <ellipse cx="202" cy="42" rx="7" ry="4" fill={leaf} />
        {/* The distance, with its limit. */}
        <g stroke="#303e1a" strokeWidth="2" strokeLinecap="round" fill="none">
          <path d="M84 68 L186 68" />
          <path d="M92 62 L84 68 L92 74" />
          <path d="M178 62 L186 68 L178 74" />
        </g>
        <text
          x="135"
          y="58"
          textAnchor="middle"
          fontSize="15"
          fontWeight="700"
          fill="#303e1a"
        >
          {t.diagramMax}
        </text>
      </svg>
      <figcaption className="mt-1 text-xs leading-5 text-tree-green-3">
        {t.diagramCaption}
      </figcaption>
    </figure>
  )
}

function PlantConfirm({
  t,
  confirmed,
  onConfirm,
  seedlingAnswer,
  disabled,
}: {
  t: PlantingRulesText
  confirmed: boolean
  onConfirm: (confirmed: boolean) => void
  seedlingAnswer: SeedlingAnswer | null
  disabled: boolean
}) {
  const statusId = useId()
  const sawSeedlings = seedlingAnswer === 'few' || seedlingAnswer === 'many'
  return (
    <div className="mt-4">
      {sawSeedlings ? (
        <p className="mb-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold leading-6 text-amber-900">
          <span aria-hidden="true">🌱 </span>
          {t.seedlingReminder}
        </p>
      ) : null}
      {/* One tap, not a list of ticks: "A box that must be ticked to get
          anywhere gets ticked without reading" (Jimi 2026-08-06, on the
          verifier modal). The rules are read above; this says they were
          followed. A toggle, so a tap made too early can be taken back. */}
      <button
        type="button"
        aria-pressed={confirmed}
        aria-describedby={statusId}
        disabled={disabled}
        onClick={() => onConfirm(!confirmed)}
        className={classNames(
          'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-2 px-4 py-2 text-base font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tree-green-2 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none',
          confirmed
            ? 'border-green-700 bg-[#dcfce7] text-green-900'
            : 'border-tree-green-2 bg-tree-green-2 text-white',
        )}
      >
        <span
          aria-hidden="true"
          className={classNames(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-sm',
            confirmed
              ? 'border-green-700 bg-green-700 text-white'
              : 'border-white text-transparent',
          )}
        >
          ✓
        </span>
        {t.confirmButton}
      </button>
      <p
        id={statusId}
        aria-live="polite"
        className={classNames(
          'mt-2 text-center text-sm leading-5',
          confirmed ? 'font-semibold text-green-900' : 'text-gray-700',
        )}
      >
        {confirmed ? `✓ ${t.confirmed}` : t.confirmNeeded}
      </p>
    </div>
  )
}
