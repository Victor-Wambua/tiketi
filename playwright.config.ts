import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4283);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // CI installs Playwright's own Chromium; locally you may point at an existing one.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    // A throwaway database, seeded with the same synthetic data as `npm run seed`.
    command: 'npx tsx src/server/seed.ts && npx tsx src/server/index.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_PATH: 'data/e2e.db',
      TICKET_KEY_PATH: 'data/e2e-key.pem',
      MPESA_CALLBACK_SECRET: 'e2e-callback-secret',
    },
  },
});
