import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // Relative asset URLs work both at localhost:/ and GitHub Pages:/tw-daytrade/.
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
