// Ported from Treegens/treegens-web (lang-en) PR #15; keep in step.
// Verbatim. (The globals.css dark-mode retrofit named below is the live
// app's; this snapshot has none, and the literal colours are kept anyway.)
import type { RootKind } from '@/components/tutorial/mangroveSpeciesCopy'

/**
 * A tiny drawing of each root shape, the first thing a planter can see from
 * the mud. Decoration only (aria-hidden): the root's name is always written
 * next to it.
 *
 * Literal colours, not classes: the dark-mode retrofit in globals.css remaps
 * classes, and these drawings must look the same in both themes. The pale
 * panel is drawn in the SVG for the same reason.
 */
const SKY = '#f7fbf3'
const MUD = '#e7d8bf'
const MUD_LINE = '#7a4a1e'
const WOOD = '#435f24'
const LEAF = '#6b8c3b'

const ROOTS: Record<RootKind, React.ReactNode> = {
  // Arching props from the trunk down into the mud.
  stilt: (
    <g fill="none" stroke={WOOD} strokeWidth="2" strokeLinecap="round">
      <path d="M32 18 Q16 18 10 36" />
      <path d="M32 18 Q48 18 54 36" />
      <path d="M32 22 Q21 24 18 36" />
      <path d="M32 22 Q43 24 46 36" />
      <path d="M32 26 Q27 29 26 36" />
      <path d="M32 26 Q37 29 38 36" />
    </g>
  ),
  // Thin roots standing up out of the mud, from a root line under it.
  pencil: (
    <g fill="none" stroke={WOOD} strokeWidth="2" strokeLinecap="round">
      <path d="M32 24 L32 36" />
      <path d="M6 40 L58 40" strokeOpacity="0.45" />
      <path d="M9 36 L9 29" />
      <path d="M15 36 L15 31" />
      <path d="M21 36 L21 28" />
      <path d="M43 36 L43 28" />
      <path d="M49 36 L49 31" />
      <path d="M55 36 L55 29" />
    </g>
  ),
  // Roots that bend up out of the mud and back down, like knees.
  knee: (
    <g
      fill="none"
      stroke={WOOD}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M32 24 L32 36" />
      <path d="M6 36 L10 28 L14 36" />
      <path d="M17 36 L21 29 L25 36" />
      <path d="M39 36 L43 29 L47 36" />
      <path d="M50 36 L54 28 L58 36" />
    </g>
  ),
  // Flat, wavy planks running out from the trunk along the mud.
  plank: (
    <g
      fill={WOOD}
      fillOpacity="0.25"
      stroke={WOOD}
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M30 20 C28 28 22 30 16 31 C12 32 9 34 6 36 L30 36 Z" />
      <path d="M34 20 C36 28 42 30 48 31 C52 32 55 34 58 36 L34 36 Z" />
    </g>
  ),
}

export function RootDrawing({
  kind,
  className = 'h-12 w-16',
}: {
  kind: RootKind
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 64 48"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect x="0" y="0" width="64" height="48" rx="6" fill={SKY} />
      <rect x="0" y="36" width="64" height="12" fill={MUD} />
      <path d="M0 36 L64 36" stroke={MUD_LINE} strokeWidth="1.5" />
      {/* Trunk and crown, the same on every drawing so only the roots differ. */}
      <path
        d="M32 6 L32 24"
        stroke={WOOD}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <ellipse cx="32" cy="8" rx="13" ry="6" fill={LEAF} />
      {ROOTS[kind] ?? null}
    </svg>
  )
}
