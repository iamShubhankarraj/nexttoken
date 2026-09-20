import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Preview build for the hosted static-artifact pipeline, which rejects
// <script type="module">. Emits a classic (non-module) IIFE bundle instead.
// Dev and production builds are unaffected — they still use vite.config.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-static',
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
