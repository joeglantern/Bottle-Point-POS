import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The console is its own app on its own host. In development the API runs
// on :3000 and is proxied so the session cookie stays on one origin.
const API = process.env.API_URL || 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api/console': { target: API, changeOrigin: false }
    }
  }
})
