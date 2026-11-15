/**
 * A `popstate` hook that always runs before the router's own listener.
 *
 * The dashboard's unsaved-changes guard has to see a press of the browser's back or forward
 * button before React Router does, so it can put the visitor back and ask first. Listeners on
 * `window` are called in the order they were added (the capture flag does not move one ahead of
 * another there), and React Router adds its listener when <BrowserRouter> mounts. So this
 * module adds one listener while the entry module is still loading (src/main.tsx imports it
 * before anything is rendered) and hands the event to whoever asked for it later.
 *
 * Without that order the router handles the event first: the page with the draft can be
 * replaced, and the draft lost, before the guard has had its say.
 */
export type PopStateInterceptor = (event: PopStateEvent) => void;

let interceptor: PopStateInterceptor | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => interceptor?.(event), true);
}

/**
 * Sees every `popstate` first. Call `event.stopImmediatePropagation()` to keep it from the
 * router. One interceptor at a time. Returns a function that removes it again.
 */
export function setPopStateInterceptor(next: PopStateInterceptor): () => void {
  interceptor = next;
  return () => {
    if (interceptor === next) interceptor = null;
  };
}
