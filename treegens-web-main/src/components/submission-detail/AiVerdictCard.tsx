'use client'

import type { ISubmissionAiVerification } from '@/types'
import { formatTimeAgo } from '@/utils/timeAgo'
import cn from 'classnames'
import { useEffect, useMemo, useRef, useState } from 'react'

function useCountUp(target: number, durationMs = 900) {
  const [val, setVal] = useState(0)
  const startRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    startRef.current = null
    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now
      const t = Math.min(1, (now - startRef.current) / durationMs)
      const eased = 1 - (1 - t) ** 3
      setVal(Math.round(target * eased))
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [target, durationMs])

  return val
}

function decisionUi(decision?: string) {
  switch (decision) {
    case 'auto_approved':
      return { label: 'Auto-approved', className: 'bg-lime-100 text-lime-950 ring-lime-300/60' }
    case 'pending_verifier':
      return {
        label: 'Flag for review',
        className: 'bg-amber-100 text-amber-950 ring-amber-300/60',
      }
    case 'ai_failed':
      // The AI run failed, so the clip goes to human review. It is not a verdict.
      return {
        label: 'Needs verifier review',
        className: 'bg-amber-100 text-amber-950 ring-amber-300/60',
      }
    case 'skipped':
      return { label: 'Skipped', className: 'bg-gray-100 text-gray-800 ring-gray-300/60' }
    default:
      return { label: 'Pending', className: 'bg-gray-100 text-gray-800 ring-gray-300/60' }
  }
}

type Props = {
  aiVerification: ISubmissionAiVerification
  declaredTrees?: number
}

export function AiVerdictCard({ aiVerification, declaredTrees }: Props) {
  const counted = aiVerification.countedMangroves ?? 0
  const displayCount = useCountUp(
    typeof counted === 'number' && Number.isFinite(counted) ? counted : 0,
  )
  const conf =
    typeof aiVerification.confidence === 'number' &&
    Number.isFinite(aiVerification.confidence)
      ? aiVerification.confidence
      : null

  const declared = declaredTrees ?? aiVerification.declaredTreesPlanted
  const delta =
    typeof declared === 'number' &&
    typeof counted === 'number' &&
    Number.isFinite(declared) &&
    Number.isFinite(counted)
      ? counted - declared
      : null

  const pill = useMemo(
    () => decisionUi(aiVerification.decision),
    [aiVerification.decision],
  )

  const ringPct =
    conf !== null ? Math.max(0, Math.min(100, Math.round(conf * 100))) : 0

  const verifiedAt = aiVerification.verifiedAt
    ? new Date(aiVerification.verifiedAt)
    : null

  return (
    <div className="tg-card mt-2 overflow-hidden border-tree-green-2/15 bg-gradient-to-br from-[#fdfef9] via-white to-[#eef6e4] p-4">
      <div className="flex flex-row items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-tree-green-2/80">
            AI tree count
          </p>
          <p className="mt-1 font-mono text-4xl font-black tabular-nums text-[#1a2610]">
            {displayCount}
          </p>
        </div>
        <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
          <svg viewBox="0 0 36 36" className="h-16 w-16 -rotate-90">
            <path
              className="text-gray-200"
              stroke="currentColor"
              strokeWidth="3"
              fill="none"
              d="M18 2.0845
                a 15.9155 15.9155 0 0 1 0 31.831
                a 15.9155 15.9155 0 0 1 0 -31.831"
            />
            <path
              className="text-[#6B8C3B]"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${ringPct}, 100`}
              d="M18 2.0845
                a 15.9155 15.9155 0 0 1 0 31.831
                a 15.9155 15.9155 0 0 1 0 -31.831"
            />
          </svg>
          <span className="absolute text-[11px] font-bold text-[#435F24]">
            {conf !== null ? `${ringPct}%` : '—'}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset',
            pill.className,
          )}
        >
          {pill.label}
        </span>
        {delta !== null ? (
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ring-1 ring-inset',
              delta === 0
                ? 'bg-gray-100 text-gray-800 ring-gray-200'
                : delta > 0
                  ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
                  : 'bg-orange-50 text-orange-950 ring-orange-200',
            )}
          >
            {delta > 0 ? '+' : ''}
            {delta} vs declared
          </span>
        ) : null}
      </div>

      {verifiedAt && aiVerification.verifiedAt ? (
        <p
          className="mt-3 text-xs text-[#6b6560]"
          title={new Date(aiVerification.verifiedAt).toLocaleString()}
        >
          Verified {formatTimeAgo(aiVerification.verifiedAt)}
        </p>
      ) : null}

      {aiVerification.status === 'failed' && aiVerification.error ? (
        <div className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200/80">
          {aiVerification.error}
        </div>
      ) : null}
    </div>
  )
}
