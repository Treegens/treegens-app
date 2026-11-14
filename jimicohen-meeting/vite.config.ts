import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is mounted at /meeting on jimicohen.com, so every asset URL carries that base.
export default defineConfig({
  base: '/meeting/',
  plugins: [react()],
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
