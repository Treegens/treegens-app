import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { shortPagesPlugin } from './scripts/shortPages';

// The app is mounted at /meeting on jimicohen.com, so every asset URL carries that base. The short links'
// static pages (jimicohen.com/meet, /pod) are written next to it by shortPagesPlugin: dist/meet, dist/pod.
export default defineConfig({
  base: '/meeting/',
  plugins: [react(), shortPagesPlugin()],
  build: {
    outDir: 'dist/meeting',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
    proxy: {
      '/meeting/api': { target: 'http://127.0.0.1:8788', changeOrigin: false },
    },
  },
});
