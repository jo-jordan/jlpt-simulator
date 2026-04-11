import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    {
      name: 'cf-js-stamp',
      apply: 'build',
      generateBundle(_, bundle) {
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type === 'chunk' && fileName.endsWith('.js')) {
            chunk.code = `/* jlpt-simulator cf-js-stamp */\n${chunk.code}`
          }
        }
      },
    },
  ],
  build: {
    modulePreload: {
      polyfill: false,
    },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash]-cf.js',
        chunkFileNames: 'assets/[name]-[hash]-cf.js',
      },
    },
  },
})
