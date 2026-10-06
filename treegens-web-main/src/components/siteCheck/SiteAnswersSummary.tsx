'use client'

import { answerLabel, isAnswered, QUESTIONS } from '@/modules/siteCheck/answers'
import type { SiteAnswers } from '@/modules/siteCheck/siteVerdict'

/** Every answered question with its answer, in questionnaire order. */
export function SiteAnswersSummary({ answers }: { answers: SiteAnswers }) {
  const rows = QUESTIONS.filter(q => isAnswered(answers[q.key]))
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <h3 className="mb-2 text-base font-bold text-gray-900">Answers</h3>
      {rows.length ? (
        <dl className="flex flex-col">
          {rows.map(q => (
            <div key={q.key} className="border-t border-gray-100 py-2.5">
              <dt className="text-xs text-gray-500">{q.title}</dt>
              <dd className="mt-0.5 whitespace-pre-line text-sm font-medium text-gray-900">
                {answerLabel(q.key, answers[q.key])}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-gray-500">No answers yet.</p>
      )}
    </section>
  )
}
