'use client'

import cn from 'classnames'
import { useState } from 'react'
import { HiInformationCircle } from 'react-icons/hi2'
import { ChoiceChip } from '@/components/siteCheck/ChoiceChip'
import {
  type AnswerOptionValue,
  isAnswered,
  isQuestionRequired,
  toggleMultiAnswer,
  withAnswer,
} from '@/modules/siteCheck/answers'
import {
  QUESTIONNAIRE_TEXT,
  type SiteQuestion,
} from '@/modules/siteCheck/questions'
import type { SiteAnswers } from '@/modules/siteCheck/siteVerdict'

type Props = {
  question: SiteQuestion
  answers: SiteAnswers
  onChange: (next: SiteAnswers) => void
}

type Option = { value: AnswerOptionValue; label: string }

function ChoiceAnswer({ question, answers, onChange }: Props) {
  const options = (question.options ?? []) as readonly Option[]
  const value = answers[question.key]
  const multi = question.kind === 'multi'
  const isSelected = (o: Option) =>
    multi
      ? ((value as AnswerOptionValue[] | undefined) ?? []).includes(o.value)
      : value === o.value
  const select = (o: Option) =>
    onChange(
      multi
        ? toggleMultiAnswer(answers, question.key, o.value)
        : withAnswer(
            answers,
            question.key,
            isSelected(o) ? undefined : o.value,
          ),
    )
  return (
    <div>
      {multi ? (
        <p className="mb-2 text-xs font-medium text-gray-500">
          {QUESTIONNAIRE_TEXT.chooseAll}
        </p>
      ) : null}
      <div
        className={cn(
          'grid gap-2',
          question.kind === 'scale' ? 'grid-cols-1' : 'grid-cols-2',
        )}
      >
        {options.map(o => (
          <ChoiceChip
            key={String(o.value)}
            selected={isSelected(o)}
            onClick={() => select(o)}
          >
            {o.label}
          </ChoiceChip>
        ))}
      </div>
    </div>
  )
}

function NumberAnswer({ question, answers, onChange }: Props) {
  const stored = answers[question.key]
  const [text, setText] = useState(stored != null ? String(stored) : '')
  const min = question.min ?? 0
  const max = question.max ?? Number.MAX_SAFE_INTEGER
  const inRange = (raw: string) => {
    const n = Number(raw)
    return raw.trim() !== '' && Number.isFinite(n) && n >= min && n <= max
  }
  const update = (raw: string) => {
    setText(raw)
    onChange(
      withAnswer(answers, question.key, inRange(raw) ? Number(raw) : undefined),
    )
  }
  return (
    <div>
      <div className="flex flex-row items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={text}
          onChange={e => update(e.target.value)}
          placeholder={question.placeholder}
          className="h-12 w-32 rounded-lg border border-gray-200 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400"
        />
        {question.unit ? (
          <span className="text-base text-gray-600">{question.unit}</span>
        ) : null}
      </div>
      {text.trim() && !inRange(text) ? (
        <p className="mt-1 text-sm text-red-600">
          Enter a number from {min} to {max}.
        </p>
      ) : null}
    </div>
  )
}

function TextAnswer({ question, answers, onChange }: Props) {
  const value = answers[question.key]
  return (
    <textarea
      rows={4}
      maxLength={question.max}
      value={typeof value === 'string' ? value : ''}
      onChange={e =>
        onChange(withAnswer(answers, question.key, e.target.value))
      }
      placeholder={question.placeholder}
      className="w-full rounded-lg border border-gray-200 bg-white p-3 text-base text-gray-900 placeholder:text-gray-400"
    />
  )
}

function AnswerInput(props: Props) {
  if (props.question.kind === 'number') return <NumberAnswer {...props} />
  if (props.question.kind === 'text') return <TextAnswer {...props} />
  return <ChoiceAnswer {...props} />
}

/** One field question with its help text and answer chips or input. */
export function QuestionCard(props: Props) {
  const { question, answers } = props
  const required = isQuestionRequired(question.key, answers)
  const missing = required && !isAnswered(answers[question.key])
  return (
    <section
      className={cn(
        'rounded-2xl border bg-white p-4',
        missing ? 'border-amber-300' : 'border-gray-200',
      )}
    >
      <div className="flex flex-row items-start justify-between gap-2">
        <h3 className="text-base font-bold leading-snug text-gray-900">
          {question.title}
        </h3>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            required
              ? 'bg-amber-100 text-amber-900'
              : 'bg-gray-100 text-gray-600',
          )}
        >
          {required ? QUESTIONNAIRE_TEXT.required : QUESTIONNAIRE_TEXT.optional}
        </span>
      </div>
      <p className="mt-1.5 flex flex-row gap-1.5 text-sm leading-snug text-gray-600">
        <HiInformationCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-tree-green-1"
          aria-hidden
        />
        {question.help}
      </p>
      <div className="mt-3">
        <AnswerInput {...props} />
      </div>
    </section>
  )
}
