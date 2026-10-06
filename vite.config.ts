/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
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
