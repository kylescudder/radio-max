import { defineConfig } from '@playwright/test'

const port = 8199
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests',
  // One shared radio server: listener counts must not interleave.
  workers: 1,
  use: { baseURL },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } }
  ],
  // The real radio server, serving the production dashboard build.
  webServer: {
    command: 'bun run build && cd server && bun src/server.ts',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(port),
      WEB_ROOT: '../web/dist',
      DASHBOARD_ORIGIN: baseURL,
      STREAM_HOSTS: '127.0.0.1'
    }
  }
})
