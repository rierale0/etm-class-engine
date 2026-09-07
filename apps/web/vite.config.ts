import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: directory,
  plugins: [react()],
  build: {
    outDir: resolve(directory, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
