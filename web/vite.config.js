import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The dev server proxies /api to the Python FastAPI engine (server.py) so the
// browser talks to a single origin and HTTP Range / SSE work without CORS.
// Only api.js knows about the backend; flip USE_FIXTURES there to go offline.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_ORIGIN || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
