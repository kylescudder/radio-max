import { defineConfig } from 'astro/config'

export default defineConfig({
  build: {
    // The server caches /_astro/ forever; keep CSS there rather than inlined.
    inlineStylesheets: 'never'
  },
  vite: {
    build: { target: 'es2022', assetsInlineLimit: 0 }
  }
})
