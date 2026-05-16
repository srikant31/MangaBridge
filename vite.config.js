import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'copy-extension-assets',
      closeBundle() {
        const dirs = ['dist/content', 'dist/background', 'dist/data']
        dirs.forEach(d => mkdirSync(d, { recursive: true }))
        copyFileSync('src/content/detector.js',  'dist/content/detector.js')
        copyFileSync('src/background/worker.js', 'dist/background/worker.js')
        copyFileSync('src/data/mappings.json',   'dist/data/mappings.json')
        copyFileSync('manifest.json',            'dist/manifest.json')
        if (existsSync('public/icon128.png'))
          copyFileSync('public/icon128.png', 'dist/icon128.png')
      }
    }
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { popup: resolve(__dirname, 'index.html') }
    }
  }
})