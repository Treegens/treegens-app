// The signing page and its two ways of showing a document (src/lib/readview.ts): telling the server the first time
// each is used, and "See this on the page" in Easy reading, which opens the page view at that spot. No React here.
import type { ReadView } from '@/lib/readview';

const told = new Set<string>();

/**
 * Says once per tab which view this person is using, so the audit trail has its first use and the certificate can
 * name it. A preview (base /preview/...) records nothing, and a failure is let go: it never stops anyone signing.
 */
export function noteView(base: string, view: ReadView) {
  if (!base.startsWith('/sign/')) return;
  const key = `${base}:${view}`;
  if (told.has(key)) return;
  told.add(key);
  fetch(`/api${base}/view`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view }) })
    .then((r) => { if (!r.ok && r.status >= 500) told.delete(key); })
    .catch(() => told.delete(key));
}

/**
 * After the page view is back on the screen: brings page `page` of document `docId` to the top part of the screen,
 * at `y` (0 to 1 from the top of that page), and puts the keyboard focus on it, so a keyboard or screen reader user
 * lands where they asked. The pages take a moment to be laid out, so it looks for a little while.
 */
export function showOnPage(docId: string, page: number, y: number) {
  let tries = 0;
  const look = () => {
    const el = document.querySelector<HTMLElement>(`[data-doc="${CSS.escape(docId)}"] .pdfpage[data-page="${page}"]`);
    if (!el || !el.getBoundingClientRect().height) {
      if (++tries < 60) requestAnimationFrame(look);
      return;
    }
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, window.scrollY + r.top + r.height * Math.max(0, y - 0.02) - window.innerHeight * 0.2) });
    // The picture of the page says which page it is ("Page 2 of 5, shown as a picture"), so the focus goes there.
    const target = el.querySelector<HTMLElement>('canvas') || el;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };
  requestAnimationFrame(look);
}

/** Waits a little while for an element to be laid out (Easy reading reads the words first), then does `then` with it. */
function whenThere(find: () => HTMLElement | null, then: (el: HTMLElement) => void) {
  let tries = 0;
  const look = () => {
    const el = find();
    if (!el || !el.getBoundingClientRect().height) {
      if (++tries < 120) requestAnimationFrame(look);
      return;
    }
    then(el);
  };
  requestAnimationFrame(look);
}

/**
 * After switching to Easy reading: the keyboard focus goes to its banner, at the top of it, so a keyboard or screen
 * reader user is taken there instead of being left on the page with the focus nowhere.
 */
export function focusEasy() {
  whenThere(() => document.getElementById('sg-flow-banner'), (el) => {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -80);
  });
}

/**
 * Back from "See this on the page": Easy reading again at the part the person came from (`id`, the part's section,
 * see EasyReading.tsx partId), with the focus on its "See this on the page", so they carry on where they were.
 */
export function backToPart(id: string) {
  whenThere(() => document.getElementById(`${id}-sec`), (el) => {
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, window.scrollY + r.top - window.innerHeight * 0.2) });
    const target = el.querySelector<HTMLElement>('.sg-flow-see') || el;
    if (target === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });
}

/** The id of a part of a page in Easy reading (EasyReading.tsx), so the signing page can come back to it. */
export const partId = (docId: string, page: number, part: number) => `sg-flow-${docId}-${page}-${part}`;
