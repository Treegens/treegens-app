'use client';
import { useEffect } from 'react';

// A link to something inside a closed fold (<details>) opens the fold and brings the thing into view. Without this
// a link such as /pricing#expiry would land on a closed "All the rules" in browsers that do not open it themselves.
export function OpenOnHash() {
  useEffect(() => {
    const go = () => {
      let id = '';
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      const el = id ? document.getElementById(id) : null;
      const fold = el?.closest('details');
      if (!el || !fold || fold.open) return;
      fold.open = true;
      el.scrollIntoView({ block: 'start' });
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);
  return null;
}
