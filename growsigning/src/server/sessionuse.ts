// Listeners for "a person signed in used the account". The router (router.ts) calls them before the handler of
// every request that comes with a browser session. One listener per name, so a module that is loaded twice is heard
// once. They must be quick, and what they throw is logged and never reaches the person. This file imports nothing,
// so anything can register here without a circle of imports.
const g = globalThis as any;
const listeners: Map<string, (c: any) => void> = (g.__tssessionuse ??= new Map());
export const onSessionUse = (name: string, fn: (c: any) => void) => void listeners.set(name, fn);
export function sessionUsed(c: any) {
  for (const heard of listeners.values()) {
    try {
      heard(c);
    } catch (e) {
      console.error('[api] a session-use listener failed', e);
    }
  }
}
