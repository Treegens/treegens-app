// Keeping the page for signing in person (/in-person) so that it opens later with no signal. A page never passes
// through a service worker registered while it loads, so visiting it once is not enough: the worker (public/sw.js) is
// registered for /in-person, waited for, and asked to fetch and keep the page and every file it loads. Then the
// device checks that the page is really kept, and only that counts as ready. No React here, no import of the server.

const SCOPE = '/in-person';
const WAIT_MS = 30_000;

type Reg = { active: any; installing: any; waiting: any };
type Nav = { serviceWorker?: { register(url: string, o: { scope: string }): Promise<Reg> } };
type Caches = { match(u: string): Promise<any> };

/** The worker once it is active, or null when it does not get there in time (or is thrown out). */
function activeOf(reg: Reg, ms: number): Promise<any> {
  if (reg.active && (!reg.active.state || reg.active.state === 'activated')) return Promise.resolve(reg.active);
  const w = reg.installing || reg.waiting || reg.active;
  if (!w) return Promise.resolve(null);
  return new Promise((ok) => {
    const t = setTimeout(() => ok(null), ms);
    const look = () => {
      if (w.state === 'activated') (clearTimeout(t), ok(w));
      else if (w.state === 'redundant') (clearTimeout(t), ok(null));
    };
    w.addEventListener?.('statechange', look);
    look();
  });
}

/** Whether the page is kept on this device (any cache of this site). */
export async function pageKept(c: Caches | undefined = (globalThis as any).caches): Promise<boolean> {
  try {
    return !!c && !!(await c.match(SCOPE));
  } catch {
    return false;
  }
}

/**
 * Keeps /in-person and what it loads, while there is signal. Answers true only when the page is found kept
 * afterwards. `nav` and `caches` are parameters so tests run it without a browser.
 */
export async function keepPageForLater(nav: Nav = globalThis.navigator as any, c: Caches | undefined = (globalThis as any).caches, ms = WAIT_MS): Promise<boolean> {
  try {
    if (!nav?.serviceWorker || !c) return false;
    const reg = await nav.serviceWorker.register('/sw.js', { scope: SCOPE });
    const w = await activeOf(reg, ms);
    if (!w) return false;
    const answer: any = await new Promise((ok) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => (ch.port1.close(), ok(null)), ms);
      ch.port1.onmessage = (ev) => (clearTimeout(t), ch.port1.close(), ok(ev.data));
      w.postMessage({ type: 'keep-in-person' }, [ch.port2]);
    });
    return !!answer?.ok && (await pageKept(c));
  } catch {
    return false;
  }
}
