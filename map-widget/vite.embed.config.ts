import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Builds the widget as a self-contained bundle (React included) for the Python-served website.
// Output: ../static/map-widget/{map-widget.js, map-widget.css, maplibre-gl-worker.mjs}
export default defineConfig({
  plugins: [react()],
  publicDir: false, // the demo's public/ files are not part of the widget
  base: './', // asset URLs resolve relative to map-widget.js, wherever it is served from
  build: {
    outDir: '../static/map-widget',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: 'src/embed.tsx',
      output: {
        entryFileNames: 'map-widget.js',
        chunkFileNames: '[name].js',
        assetFileNames: (info) => (info.names?.[0]?.endsWith('.css') ? 'map-widget.css' : '[name][extname]'),
      },
    },
  },
})
