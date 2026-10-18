'use client'

import { Fragment, useMemo } from 'react'
import { VerdictCard } from '@/components/siteCheck/VerdictCard'
import {
  isQuestionShown,
  QUESTIONS,
  requiredProgress,
} from '@/modules/siteCheck/answers'
import {
  QUESTION_SECTIONS,
  QUESTIONNAIRE_TEXT,
} from '@/modules/siteCheck/questions'
import {
  computeSiteVerdict,
  type HydrologySummary,
  type SiteAnswers,
} from '@/modules/siteCheck/siteVerdict'
import { QuestionCard } from './QuestionCard'
import { StepNav } from './StepNav'

type Props = {
  answers: SiteAnswers
  countryCode: string
  /** Of the site, so the verdict can tell Hawaii from the rest of the US */
  longitude: number | null
  /** A finished satellite result, when editing a saved site */
  hydrology: HydrologySummary | null
  onChange: (next: SiteAnswers) => void
  onBack: () => void
  onNext: () => void
}

/** Step 2: the field questionnaire with a live verdict preview. */
export function QuestionsStep({
  answers,
  countryCode,
  longitude,
  hydrology,
  onChange,
  onBack,
  onNext,
}: Props) {
  const progress = requiredProgress(answers)
  const verdict = useMemo(
    () => computeSiteVerdict({ answers, hydrology, countryCode, longitude }),
    [answers, hydrology, countryCode, longitude],
  )
  const shown = QUESTIONS.filter(q => isQuestionShown(q.key, answers))

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-[#f7fbf3] px-3 py-2 text-sm font-medium text-tree-green-2">
        {QUESTIONNAIRE_TEXT.progress(progress.done, progress.total)}
      </p>
      {shown.map((q, i) => (
        <Fragment key={q.key}>
          {i === 0 || shown[i - 1].section !== q.section ? (
            <h2 className="mt-2 text-lg font-bold text-[#1a2610]">
              {QUESTION_SECTIONS[q.section]}
            </h2>
          ) : null}
          <QuestionCard question={q} answers={answers} onChange={onChange} />
        </Fragment>
      ))}
      {progress.done > 0 ? (
        <VerdictCard
          verdict={verdict}
          title={QUESTIONNAIRE_TEXT.previewTitle}
          note={hydrology ? undefined : QUESTIONNAIRE_TEXT.previewNote}
        />
      ) : null}
      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  )
}
