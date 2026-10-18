'use client'

import { Button } from '@/components/ui/Button'

type Props = {
  onBack?: () => void
  onNext: () => void
  nextDisabled?: boolean
  nextLabel?: string
  hint?: string | null
}

/** Back / Next row at the end of a wizard step. */
export function StepNav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel = 'Next',
  hint,
}: Props) {
  return (
    <div className="mt-6 flex flex-col gap-2">
      {hint ? (
        <p className="text-center text-sm text-orange-600">{hint}</p>
      ) : null}
      <div className="flex flex-row gap-3">
        {onBack ? (
          <Button
            outline
            color="gray"
            className="flex-1 rounded-2xl py-3.5 text-base"
            onClick={onBack}
          >
            Back
          </Button>
        ) : null}
        <Button
          color="success"
          className="flex-1 rounded-2xl py-3.5 text-base"
          disabled={nextDisabled}
          onClick={onNext}
        >
          {nextLabel}
        </Button>
      </div>
    </div>
  )
}
