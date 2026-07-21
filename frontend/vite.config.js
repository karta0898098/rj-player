import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend (Rust/axum) runs at http://127.0.0.1:8080 (dsd.md §3). We proxy
// /api and /media through the Vite dev server so the app can use same-origin
// relative paths (fetch('/api/...'), <video src="/media/...">, ws('/api/.../events'))
// without needing CORS headers on the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
      '/media': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
