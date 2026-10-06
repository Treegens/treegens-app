import { SITE_QUESTIONS, type SiteQuestion } from './questions'
import {
  hasKnownCause,
  missingAnswers,
  REQUIRED_ANSWERS,
  type SiteAnswers,
} from './siteVerdict'

export type AnswerKey = keyof SiteAnswers
export type AnswerOptionValue = string | number | boolean

export const QUESTIONS: readonly SiteQuestion[] = SITE_QUESTIONS

/**
 * "Is this still happening?" only makes sense once a cause is known: one is
 * chosen, or "Mangroves, now cut" names cutting (same rule as the verdict).
 */
export function isQuestionShown(key: AnswerKey, answers: SiteAnswers) {
  return key !== 'causeStillActive' || hasKnownCause(answers)
}

export function isQuestionRequired(key: AnswerKey, answers: SiteAnswers) {
  if (key === 'causeStillActive') return hasKnownCause(answers)
  return REQUIRED_ANSWERS.includes(key)
}

export function requiredProgress(answers: SiteAnswers) {
  const total = REQUIRED_ANSWERS.length + (hasKnownCause(answers) ? 1 : 0)
  return { done: total - missingAnswers(answers).length, total }
}

/** Sets one answer; an empty value (undefined, '' or []) removes it. */
export function withAnswer(
  answers: SiteAnswers,
  key: AnswerKey,
  value: unknown,
): SiteAnswers {
  const next = { ...answers } as Record<string, unknown>
  if (!isAnswered(value)) delete next[key]
  else next[key] = value
  const causeKey = key === 'lossCauses' || key === 'previousUse'
  if (causeKey && !hasKnownCause(next as SiteAnswers)) {
    delete next.causeStillActive
  }
  return next as SiteAnswers
}

/** Adds or removes one value of a multi-choice answer. */
export function toggleMultiAnswer(
  answers: SiteAnswers,
  key: AnswerKey,
  value: AnswerOptionValue,
): SiteAnswers {
  const current = (answers[key] as AnswerOptionValue[] | undefined) ?? []
  const next = current.includes(value)
    ? current.filter(v => v !== value)
    : [...current, value]
  return withAnswer(answers, key, next)
}

export function isAnswered(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== ''
}

export function questionFor(key: AnswerKey): SiteQuestion | undefined {
  return QUESTIONS.find(q => q.key === key)
}

/** Human label of a stored answer, from the questionnaire copy. */
export function answerLabel(key: AnswerKey, value: unknown): string {
  const options = questionFor(key)?.options as
    | readonly { value: AnswerOptionValue; label: string }[]
    | undefined
  const labelOf = (v: unknown) =>
    options?.find(o => o.value === v)?.label ?? String(v)
  if (Array.isArray(value)) return value.map(labelOf).join(', ')
  const unit = questionFor(key)?.unit
  if (typeof value === 'number' && unit) return `${value} ${unit}`
  return labelOf(value)
}
