'use client'

import cn from 'classnames'
import type { ReactNode } from 'react'

type Props = {
  selected: boolean
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
}

/** Big tap target with a check box, the app's selected-chip look. */
export function ChoiceChip({
  selected,
  onClick,
  children,
  disabled,
  className,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex min-h-12 w-full flex-row items-center gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left transition-colors disabled:opacity-50',
        selected
          ? 'border-tree-green-2 bg-[#E8F7ED]'
          : 'border-gray-200 bg-white',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded border-2',
          selected
            ? 'border-tree-green-2 bg-tree-green-2'
            : 'border-gray-300 bg-white',
        )}
        aria-hidden
      >
        {selected ? (
          <span className="text-[10px] font-bold text-white">✓</span>
        ) : null}
      </span>
      <span
        className={cn(
          'text-sm font-medium leading-snug',
          selected ? 'text-tree-green-2' : 'text-gray-800',
        )}
      >
        {children}
      </span>
    </button>
  )
}
