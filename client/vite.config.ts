import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Server-side modules under ../src ship their tests next to the source;
    // the client vitest run is the project's single test entry point.
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', '../src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
  optimizeDeps: {
    include: ['events'],
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
      '/convert': {
        target: 'http://localhost:8080',
        changeOrigin: true
      },
      '/perform': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'build'
  }
})
