/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // `npm run dev` here + `npm --prefix ../worker run dev` (port 8787): same origin for /api in dev.
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    coverage: { provider: 'istanbul', include: ['src/**'], exclude: ['src/main.tsx', 'src/test/**'], thresholds: { lines: 70 } },
  },
})
