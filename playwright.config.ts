import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: '**/echo-*.spec.ts',
  globalSetup: 'tests/e2e/global-setup.ts',
  timeout: 45000,
  expect: { timeout: 8000 },
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1600, height: 1000 },
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 20000,
  },
});
