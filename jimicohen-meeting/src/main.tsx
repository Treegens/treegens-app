import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/ui.css';
import App from './App';
import { STORAGE_KEYS, storageGetJson } from './lib/storage';

/**
 * Before React renders anything, tell the stylesheet which world this URL belongs to, so the
 * very first paint already has the right canvas colour: the dashboard palette for /admin, and
 * for public pages the background of the theme seen on the last visit (forest by default).
 */
function prepaint(): void {
  const root = document.documentElement;
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const route = window.location.pathname.slice(base.length);
  const isDashboard = /^\/admin(\/|$)/.test(route) || (import.meta.env.DEV && /^\/__kit(\/|$)/.test(route));
  root.dataset.surface = isDashboard ? 'admin' : 'public';
  if (isDashboard) return;
  const boot = storageGetJson<{ bg?: unknown; scheme?: unknown }>(STORAGE_KEYS.bootTheme);
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
