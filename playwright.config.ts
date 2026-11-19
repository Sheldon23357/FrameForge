import { defineConfig } from '@playwright/test';
import { editorTestOrigin } from './tests/e2e/server-url';
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
    baseURL: editorTestOrigin,
    screenshot: 'only-on-failure',
  },
});
