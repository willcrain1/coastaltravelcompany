import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text', 'json', 'json-summary'],
      thresholds: {
        lines:      95,
        functions:  95,
        branches:   95,
        statements: 95,
      },
    },
  },
});
