import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5180',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'pnpm -C packages/renderer dev -- --host 127.0.0.1 --port 5180',
    port: 5180,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
