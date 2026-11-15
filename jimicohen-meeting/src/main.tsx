// First on purpose: its popstate listener has to be added before the router adds its own.
import './lib/historyGuard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/ui.css';
import App from './App';
import { OWN_BOOT_THEME_KEY, STORAGE_KEYS, brandBootThemeKey, storageGetJson } from './lib/storage';

function metaContent(name: string): string | null {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
}

/**
 * Before React renders anything, tell the stylesheet which world this URL belongs to, so the
 * very first paint already has the right canvas colour: the dashboard palette for /admin, and
 * for public pages the background of the theme seen on the last visit (forest by default).
 *
 * A short link's page carries its boot colours in meta tags, and names its brand when it has one
 * (jimicohen.com/pod). It then paints the look of that brand seen last, or for a link in the owner's own
 * look (jimicohen.com/meet) the owner's look seen last, else the colours its page carries: never another
 * look seen since, so /meet never opens in Eco Champions sand after a visit to /pod.
 */
function prepaint(): void {
  const root = document.documentElement;
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const route = window.location.pathname.slice(base.length);
  const isDashboard = /^\/admin(\/|$)/.test(route) || (import.meta.env.DEV && /^\/__kit(\/|$)/.test(route));
  root.dataset.surface = isDashboard ? 'admin' : 'public';
  if (isDashboard) return;
  type Boot = { bg?: unknown; scheme?: unknown; brand?: unknown };
  const brand = metaContent('meeting-boot-brand');
  const shortPage = metaContent('meeting-boot-bg') !== null;
  const own = (): Boot | null => {
    const last = storageGetJson<Boot>(STORAGE_KEYS.bootTheme);
    return storageGetJson<Boot>(OWN_BOOT_THEME_KEY) ?? (last && typeof last.brand !== 'string' ? last : null);
  };
  const saved = brand ? storageGetJson<Boot>(brandBootThemeKey(brand)) : shortPage ? own() : storageGetJson<Boot>(STORAGE_KEYS.bootTheme);
  const boot = shortPage && !saved ? { bg: metaContent('meeting-boot-bg'), scheme: metaContent('meeting-boot-scheme') } : saved;
  if (boot && typeof boot.bg === 'string' && /^#[0-9a-f]{6}$/i.test(boot.bg)) root.style.setProperty('--boot-bg', boot.bg);
  if (boot && (boot.scheme === 'light' || boot.scheme === 'dark')) root.style.setProperty('--boot-scheme', boot.scheme);
}

prepaint();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
