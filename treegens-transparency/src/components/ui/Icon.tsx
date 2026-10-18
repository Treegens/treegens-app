import type { SVGProps } from 'react'

export type IconName =
  | 'in'
  | 'out'
  | 'sprout'
  | 'flame'
  | 'shield'
  | 'camera'
  | 'vote'
  | 'external'
  | 'play'
  | 'close'
  | 'sun'
  | 'moon'
  | 'pin'
  | 'check'
  | 'copy'
  | 'arrow'
  | 'chain'
  | 'leaf'
  | 'globe'
  | 'search'

const PATHS: Record<IconName, string> = {
  in: 'M12 3v12m0 0 4-4m-4 4-4-4M4 21h16',
  out: 'M12 21V9m0 0 4 4m-4-4-4 4M4 3h16',
  sprout: 'M12 22V12m0 0c0-4 3-7 8-7-0 4-3 7-8 7Zm0 0c0-4-3-7-8-7 0 4 3 7 8 7Z',
  flame: 'M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-3 3 0-3-1-6-4-8 0 4-4 6-4 12 0 4 3 7 7 7Z',
  shield: 'M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3Zm-3 10 2 2 4-4',
  camera: 'M3 7h3l2-2h8l2 2h3v12H3V7Zm9 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
  vote: 'M9 12l2 2 4-5M5 4h14v16H5V4Z',
  external: 'M14 4h6v6m0-6L10 14M5 8v11h11',
  play: 'M8 5v14l11-7-11-7Z',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.6-5.6 1.4-1.4M4.9 19.1l1.4-1.4m0-11.3L4.9 4.9m14.2 14.2-1.4-1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  moon: 'M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z',
  pin: 'M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  check: 'M5 12l5 5L20 7',
  copy: 'M9 9h10v12H9V9Zm-4 6V3h10',
  arrow: 'M5 12h14m0 0-5-5m5 5-5 5',
  chain: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5',
  leaf: 'M20 4c-9 0-15 5-15 13 0 1 0 2 .3 3C9 16 13 12 20 4Zm0 0c0 9-5 15-13 15',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c3 3 4 6 4 10s-1 7-4 10m0-20C9 5 8 8 8 12s1 7 4 10M2 12h20',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4',
}

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
