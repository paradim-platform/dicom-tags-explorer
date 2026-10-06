/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Static hosts like GitHub Pages cannot send headers, so the Content Security Policy is also put in the built
// index.html. `connect-src 'none'` makes the browser guarantee that the app cannot send the files anywhere.
// Not applied to the dev server, whose hot reload needs a websocket. (frame-ancestors is header-only: see docker/.)
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const cspMeta: Plugin = {
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' },
  ],
};

export default defineConfig({
  plugins: [svelte(), cspMeta],
  // Relative asset paths so the build works from any sub-path (GitHub Pages, internal web server, file share...).
  base: './',
  build: {
    // The bundle embeds the whole DICOM data dictionary (~130 KB gzipped), which is expected.
    chunkSizeWarningLimit: 800,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
