import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('apps/goapi/web'),
  server: {
    host: '0.0.0.0',
    port: 3344,
    proxy: { '/api': 'http://127.0.0.1:3333' }
  }
});
