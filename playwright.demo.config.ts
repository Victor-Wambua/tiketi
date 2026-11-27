import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.DEMO_PORT ?? 9004);

// Smoke tests for the static demo: build it, serve the built files, drive them in a browser.
export default defineConfig({
  testDir: 'demo/test',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-demo' }]]
    : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npm run demo:build && npx vite preview --config demo/vite.config.ts --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
