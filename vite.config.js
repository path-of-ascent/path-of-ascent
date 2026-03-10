import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Path of Ascent',
        short_name: 'Path of Ascent',
        description: 'Your PoB companion — leveling guides, gem links, passive trees, and trade searches from Path of Building exports',
        theme_color: '#090a0c',
        background_color: '#090a0c',
        display: 'standalone',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      }
    })
  ],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api/trade': {
        target: 'https://www.pathofexile.com',
        changeOrigin: true,
        headers: {
          'User-Agent': 'PoB-Trade-PWA/1.0'
        }
      }
    }
  }
})
