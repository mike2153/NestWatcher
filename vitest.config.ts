import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/electronMock.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/main/src/**/*.ts', 'packages/preload/src/**/*.ts', 'packages/shared/src/**/*.ts'],
      exclude: ['tests/**', 'packages/**/dist/**', 'packages/renderer/**', 'resources/**'],
      thresholds: {
        statements: 10,
        lines: 10,
        functions: 10,
        branches: 5
      }
    }
  }
});
