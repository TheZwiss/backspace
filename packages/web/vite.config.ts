/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { devCspPreamble } from './src/build/devCsp';
import { preloadStartupChunks } from './src/build/startupChunks';
import { PRECACHE_GLOB_PATTERNS, PRECACHE_MAX_FILE_BYTES } from './src/build/precache';

export default defineConfig({
  plugins: [
    devCspPreamble(),
    preloadStartupChunks(),
    react(),
    VitePWA({
      // 'prompt' keeps a new build waiting until SwAutoUpdate applies it, so an
      // update never reloads the page out from under a live voice session.
      registerType: 'prompt',
      includeAssets: ['icons/favicon-32.png', 'icons/favicon-16.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Backspace',
        short_name: 'Backspace',
        description: 'The self-hosted Discord and TeamSpeak alternative. HD voice, video, and screen share — open source and free (AGPL-3.0).',
        display: 'standalone',
        start_url: '/',
        theme_color: '#0b0b10',
        background_color: '#0b0b10',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/uploads/],
        // No skipWaiting: a new worker activates only on SwAutoUpdate's
        // SKIP_WAITING message. The one exception is replacing a worker from
        // before that flow, which public/sw-rollover.js handles.
        // clientsClaim only matters on the first install, where there is no
        // older worker to replace.
        importScripts: ['sw-rollover.js'],
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The precached file types; the CI size check reads the same list.
        globPatterns: PRECACHE_GLOB_PATTERNS,
        // CI fails when a precached file nears this limit; see src/build/precache.ts.
        maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES,
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts', '.json'],
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3005',
        ws: true,
      },
    },
  },
});
