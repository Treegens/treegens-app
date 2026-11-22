'use client';
import { useEffect } from 'react';

// Registers public/sw.js for the app's own pages (/app and below), and only there: a signing page, a form or a
// website agreement is never under it. In development it is left out, because the files of a development build
// change under the same names and a kept copy would be an old one. It draws nothing.
export function ShellWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    try {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.register('/sw.js', { scope: '/app' }).catch(() => {
        /* a browser that refuses (private mode, say) simply works without it */
      });
    } catch {
      /* the same */
    }
  }, []);
  return null;
}
