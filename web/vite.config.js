import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the API runs on :3000. Proxying keeps everything on one
// origin so the session cookie stays SameSite=Strict.
const API = process.env.API_URL || 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/socket.io': { target: API, ws: true, changeOrigin: false }
    }
  }
})
