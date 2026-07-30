import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the panel is served by Vite while the backend runs separately.
    // Proxying keeps the browser on one origin, so CORS never enters the picture and the
    // production nginx setup behaves the same way.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
