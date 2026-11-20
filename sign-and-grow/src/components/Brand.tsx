// The growsigning logo, drawn inline from the path data in src/lib/brandMark.ts. No hooks, no files to fetch and no
// imports from src/server, so it renders the same in client and server components and in the first paint.
// Not used anywhere yet: the rename pass wires it in (brand/README.md, "Wiring it in").
import type { CSSProperties } from 'react';
import { LOGO, MARK, MARK_SMALL, TONES } from '@/lib/brandMark';

/** 'light' for paper or white behind it, 'dark' for deep green or ink, 'mono' for one colour (the CSS colour). */
export type BrandTone = 'light' | 'dark' | 'mono';

type Common = {
  tone?: BrandTone;
  /** What a screen reader says. Pass '' when the name is already written next to it, to hide the picture. */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

const named = (label: string) => (label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const });

/** The leaf alone, `size` px square (the leaf fills the middle 7/8). Under 24 px it switches to the drawing with the nib opened wider, as on the app icon, so the hole and slit still show. */
export function Mark({ size = 24, tone = 'light', label = 'growsigning', className, style }: Common & { size?: number }) {
  const m = size < 24 ? MARK_SMALL : MARK;
  return (
    <svg viewBox={m.viewBox} width={size} height={size} {...named(label)} focusable="false" className={className} style={{ flex: 'none', ...style }}>
      {tone === 'mono' ? (
        <path fill="currentColor" d={m.mono} />
      ) : (
        <>
          <path fill={TONES[tone].lit} d={m.lit} />
          <path fill={TONES[tone].shade} d={m.shade} />
        </>
      )}
    </svg>
  );
}

/** The horizontal logo, `height` px tall from the top of the leaf to its point. 16 px is the smallest it should go. */
export function Logo({ height = 22, tone = 'light', label = 'growsigning', className, style }: Common & { height?: number }) {
  const width = Math.round(((height * LOGO.width) / LOGO.height) * 100) / 100;
  const t = tone === 'mono' ? null : TONES[tone];
  return (
    <svg viewBox={LOGO.viewBox} width={width} height={height} {...named(label)} focusable="false" className={className} style={{ flex: 'none', ...style }}>
      {t ? (
        <>
          <path fill={t.lit} d={LOGO.mark.lit} />
          <path fill={t.shade} d={LOGO.mark.shade} />
          <path fill={t.grow} d={LOGO.grow} />
          <path fill={t.signing} d={LOGO.signing} />
        </>
      ) : (
        <g fill="currentColor">
          <path d={LOGO.mark.mono} />
          <path d={LOGO.grow} />
          <path d={LOGO.signing} />
        </g>
      )}
    </svg>
  );
}

/**
 * "sent with growsigning", for the signing page header beside the sender's own logo: their brand leads, ours follows
 * quietly. The words sit on the logo's baseline. Screen readers hear "sent with growsigning".
 */
export function SentWith({ height = 18, tone = 'light', className, style }: Omit<Common, 'label'> & { height?: number }) {
  // Lowering the logo by the depth under its baseline puts the word's baseline on the line of text.
  const drop = -Math.round(((height * (LOGO.height - LOGO.baseline)) / LOGO.height) * 100) / 100;
  return (
    <span
      className={className}
      style={{
        display: 'inline-block',
        whiteSpace: 'nowrap',
        fontSize: Math.max(11, Math.round(height * 0.64)),
        lineHeight: `${height}px`,
        color: tone === 'dark' ? 'rgba(246, 243, 236, 0.8)' : tone === 'mono' ? 'currentColor' : '#5f6d64',
        ...style,
      }}
    >
      sent with{' '}
      <Logo height={height} tone={tone} style={{ verticalAlign: drop, marginLeft: Math.round(height * 0.12) }} />
    </span>
  );
}
