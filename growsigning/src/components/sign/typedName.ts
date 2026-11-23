// The name that was typed for the signature, kept in the tab next to the kept signature (readKept in fields.ts), so
// the "Check your name" step at Finish still comes after a reload. It is only ever compared with the name on the
// document (nameDiffers in actions.ts): nothing is signed with it, and it never leaves the browser.
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (token: string) => `sg:typed:${token}`;

/** The typed name kept for this link, or null: also when the tab has no storage, or what is there is not a name. */
export function readTypedName(token: string, store?: Store): string | null {
  try {
    const v = (store || sessionStorage).getItem(key(token));
    return typeof v === 'string' && v.trim() && v.length <= 200 ? v : null;
  } catch {
    return null;
  }
}

/** Keeps the typed name, or forgets it (a drawn or uploaded signature has none; so does a finished document). */
export function writeTypedName(token: string, name: string | null | undefined, store?: Store) {
  try {
    if (name && name.trim()) (store || sessionStorage).setItem(key(token), name.slice(0, 200));
    else (store || sessionStorage).removeItem(key(token));
  } catch {
    /* Private mode or a full store: the name is simply not kept across a reload. */
  }
}
