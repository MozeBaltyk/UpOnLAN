import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Layers live in test/{unit,integration,e2e,smoke}; helpers are shared.
    include: ['test/**/*.test.js'],
    // Node env (no jsdom needed — server-side app).
    environment: 'node',
    // Server boots + socket handshakes can take a moment on cold CI.
    testTimeout: 15000,
    hookTimeout: 15000,
    // Each test file boots its own server on port 0 — no shared state.
    fileParallelism: false,
    sequence: { concurrent: false },
    // v8 coverage is built into @vitest/coverage-v8; thresholds intentionally
    // not enforced — the goal is meaningful coverage, not a number.
    coverage: {
      provider: 'v8',
      include: ['services/**/*.js', 'app.js', 'routes/**/*.js', 'sockets/**/*.js'],
      exclude: ['test/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
