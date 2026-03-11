import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
  },
  server: {
    port: 3000,
    fs: {
      allow: [
        path.resolve(__dirname, '..'),
        path.resolve(__dirname, '../../react-pianosound'),
      ],
    },
    proxy: {
      '/explain': {
        target: 'http://localhost:3002',
        changeOrigin: true
      },
      '/render-cues': {
        target: 'http://localhost:3002',
        changeOrigin: true
      },
      '/plan-cues': {
        target: 'http://localhost:3002',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'build'
  }
})
