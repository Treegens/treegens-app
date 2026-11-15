/**
 * localStorage / sessionStorage that never throws: private mode, blocked cookies and
 * sandboxed embeds all make storage unavailable, and the app must keep working without it.
 */

function area(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function storageGet(key: string, kind: 'local' | 'session' = 'local'): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string, kind: 'local' | 'session' = 'local'): boolean {
  try {
    const store = area(kind);
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key: string, kind: 'local' | 'session' = 'local'): void {
  try {
    area(kind)?.removeItem(key);
  } catch {
    // ignore
  }
}

export function storageGetJson<T>(key: string, kind: 'local' | 'session' = 'local'): T | null {
  const raw = storageGet(key, kind);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function storageSetJson(key: string, value: unknown, kind: 'local' | 'session' = 'local'): boolean {
  try {
    return storageSet(key, JSON.stringify(value), kind);
  } catch {
    return false;
  }
}

/** Keys used across the app, in one place so they never collide. */
export const STORAGE_KEYS = {
  /** visitor's manually chosen time zone on public pages */
  zone: 'mtg:zone',
  /** visitor's manual 12h / 24h choice: "12" | "24" */
  hourFormat: 'mtg:hour-format',
  /** last public theme seen, so the next visit paints the right colours before the API answers */
  bootTheme: 'mtg:boot-theme',
} as const;

/** The last look of one brand seen ("mtg:boot-theme:brand_eco_champions"), for the first paint of its short link. */
export function brandBootThemeKey(brandId: string): string {
  return `${STORAGE_KEYS.bootTheme}:${brandId}`;
}

/**
 * The owner's own look seen last ("mtg:boot-theme:own": any page without a brand), for the first paint of a short
 * link in that look (jimicohen.com/meet), which must never boot in a brand's look seen since.
 */
export const OWN_BOOT_THEME_KEY = `${STORAGE_KEYS.bootTheme}:own`;
