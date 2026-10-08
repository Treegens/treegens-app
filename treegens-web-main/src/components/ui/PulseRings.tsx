import { IoVideocam } from 'react-icons/io5'

/**
 * Three staggered rings that ripple out from a round button. Drop it inside a
 * `relative` box and size it with `className` to sit exactly on the circle.
 * Purely decorative: hidden from screen readers and never takes a tap
 * (globals.css, `.tg-ripple`).
 */
export function PulseRings({ className = '' }: { className?: string }) {
  return (
    <>
      <span aria-hidden className={`tg-ripple ${className}`} />
      <span aria-hidden className={`tg-ripple tg-ripple-2 ${className}`} />
      <span aria-hidden className={`tg-ripple tg-ripple-3 ${className}`} />
    </>
  )
}

/**
 * What an empty land/plant video slot shows: a pulsing record button, in the
 * tree button's colours, over a line saying what to film. The slot's hidden
 * file input does the work, so none of this takes a tap.
 */
export function RecordVideoCue({ label }: { label: string }) {
  return (
    <span className="pointer-events-none flex flex-col items-center gap-4">
      <span className="relative flex h-16 w-16 items-center justify-center">
        <PulseRings className="inset-0" />
        <span className="tg-breathe relative flex h-16 w-16 items-center justify-center rounded-full bg-lime-gradient shadow-md">
          <IoVideocam className="h-8 w-8 text-[#435f24]" aria-hidden />
        </span>
      </span>
      {/* relative: paints over the ripples instead of under them */}
      <span className="relative text-sm font-semibold text-[#435f24]">
        {label}
      </span>
    </span>
  )
}
