import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  // Absolute base so deep-link refreshes (e.g. /coverage) resolve hashed
  // assets from the domain root. Required for the Vercel SPA fallback;
  // './' would resolve assets relative to the route path and 404.
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workaround for tabler icons loading every chunk in dev
      '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
    },
  },
  server: {
    // 5174 to dodge valsource's default 5173 - both can run side by side.
    port: 5174,
    proxy: {
      // Forward API calls to the local Bluebird backend so we don't have
      // to mess with CORS in the browser. Anything starting with /api
      // hits localhost:3001.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Same trick for the Socket.IO realtime connection - `ws: true`
      // tells Vite to handle the WebSocket upgrade. Without this entry,
      // the client falls back to long-polling (still works) but pays the
      // extra latency. With it, we get a true persistent socket.
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
