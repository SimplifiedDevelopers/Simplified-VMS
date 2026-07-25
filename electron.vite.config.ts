import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The Hikvision addon is a compiled .node binary loaded via a
        // runtime require() (see src/main/adapters/hikvision.ts) — Rollup
        // can't bundle it, so it must stay an untouched external require.
        external: (id: string) => id.endsWith('.node'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});
