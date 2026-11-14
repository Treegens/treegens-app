/**
 * Readability checks for a theme palette. The theme engine already repairs a few pairs on its
 * own (text on the page background, button labels), so these checks cover the pairs that are
 * used exactly as the owner picked them.
 */
import { contrastRatio, ensureContrast, isHex } from '../../../../shared/theme';
import type { ThemeColors } from '../../../../shared/types';

export type ContrastLevel = 'good' | 'ok' | 'poor';

export interface ContrastCheck {
  id: 'text' | 'muted' | 'primary';
  label: string;
  /** colour being judged */
  field: keyof ThemeColors;
  fg: string;
  bg: string;
  ratio: number;
  /** ratio we want to reach */
  target: number;
  level: ContrastLevel;
  /** plain words for what goes wrong, set when level is not "good" */
  problem?: string;
  /** the same palette with `field` nudged until it passes, or null when nothing needs fixing */
  fixed: ThemeColors | null;
}

function levelOf(ratio: number, target: number, floor: number): ContrastLevel {
  if (ratio >= target) return 'good';
  return ratio >= floor ? 'ok' : 'poor';
}

function check(colors: ThemeColors, id: ContrastCheck['id'], label: string, field: keyof ThemeColors, target: number, floor: number, problem: string): ContrastCheck {
  const fg = colors[field];
  const bg = colors.surface;
  const valid = isHex(fg) && isHex(bg);
  const ratio = valid ? contrastRatio(fg, bg) : 21;
  const level = levelOf(ratio, target, floor);
  let fixed: ThemeColors | null = null;
  if (level !== 'good' && valid) {
    const next = ensureContrast(fg, bg, target);
    if (next.toLowerCase() !== fg.toLowerCase()) fixed = { ...colors, [field]: next };
  }
  return { id, label, field, fg, bg, ratio, target, level, problem: level === 'good' ? undefined : problem, fixed };
}

/** The three pairs that decide whether a booking page is comfortable to read. */
export function contrastChecks(colors: ThemeColors): ContrastCheck[] {
  return [
    check(colors, 'text', 'Text on cards', 'text', 4.5, 3, 'Text is hard to read against the card colour.'),
    check(colors, 'muted', 'Secondary text on cards', 'muted', 4.5, 3, 'Hints and small print fade into the card.'),
    check(colors, 'primary', 'Brand colour on cards', 'primary', 3, 1.8, 'Selected days and outlined buttons barely stand out.'),
  ];
}

/** Number of checks that need attention. */
export function contrastProblems(colors: ThemeColors): number {
  return contrastChecks(colors).filter((c) => c.level !== 'good').length;
}

export function formatRatio(ratio: number): string {
  return `${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}:1`;
}
