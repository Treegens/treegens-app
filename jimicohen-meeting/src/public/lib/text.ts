/**
 * Small text helpers shared by the public screens.
 */
import type { PublicEventType, PublicHost } from '../../../shared/types';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

/** "Jimi", "Jimi and Alex", "Jimi, Alex and Sam". */
export function joinNames(names: string[], conjunction: 'and' | 'or' = 'and'): string {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${list[list.length - 1]}`;
}

/** Who the visitor meets: full names for one or two hosts, first names beyond that. */
export function hostNames(hosts: PublicHost[], kind: PublicEventType['kind'] = 'solo'): string {
  if (!hosts.length) return '';
  const conj = kind === 'round_robin' ? 'or' : 'and';
  if (hosts.length <= 2) return joinNames(hosts.map((h) => h.name), conj);
  return joinNames(hosts.map((h) => firstName(h.name)), conj);
}

/** Replaces {{variable}} placeholders. Unknown variables render empty, like the server does. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const p = new URL(value).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

/** "example.com" from a URL, for "Taking you to example.com". */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Splits owner-written text into paragraphs on blank lines. Single line breaks are kept by CSS. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** "1 time", "3 times" */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Stable 32 bit hash for deterministic preview data. */
export function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
