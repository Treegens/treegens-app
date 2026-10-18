'use client'

import cn from 'classnames'

export const WIZARD_STEPS = [
  'Location',
  'Questions',
  'Photos',
  'Check and send',
] as const

/** "Step 2 of 4: Questions" with one bar per step. */
export function WizardProgress({ step }: { step: number }) {
  return (
    <div className="mb-5">
      <p className="text-sm font-medium text-gray-500">
        Step {step} of {WIZARD_STEPS.length}: {WIZARD_STEPS[step - 1]}
      </p>
      <div className="mt-1 flex flex-row items-center gap-2">
        {WIZARD_STEPS.map((label, i) => (
          <div
            key={label}
            className={cn(
              'h-1 flex-1 rounded-full',
              i < step ? 'bg-tree-green-2' : 'bg-gray-200',
            )}
          />
        ))}
      </div>
    </div>
  )
}
