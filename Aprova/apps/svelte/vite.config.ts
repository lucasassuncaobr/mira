import path from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// pdfjs-dist resolve para o vendor local (src/lib/vendor/pdf.mjs);
// pdfcache.js importa sob demanda, o chunk continua separado.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      'pdfjs-dist': path.resolve(__dirname, 'src/lib/vendor/pdf.mjs'),
    },
  },
  // Dev (porta 3355/3356): /api proxia para o Go em 3333.
  // Em produção o dist é servido pelo próprio Go (mesma origem).
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3333', changeOrigin: true },
    },
  },
});
