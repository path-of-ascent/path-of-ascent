import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120000, // PoB bridge calls can be slow
    include: ['tests/**/*.test.js'],
  },
});
