import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// In development the API runs on :3000. Proxying keeps everything on one
// origin so the session cookie stays SameSite=Strict.
const API = process.env.API_URL || 'http://localhost:3000'

export default defineConfig({
  plugins: [
    react(),
    // Keeps the till's own files on the device, so it opens and sells with no
    // internet, even after Chrome restarts. Data lives in IndexedDB (src/offline).
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: false, // public/manifest.webmanifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io/],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/socket.io': { target: API, ws: true, changeOrigin: false }
    }
  }
})
