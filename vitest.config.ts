import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['build/**', 'node_modules/**', 'bin/**', 'tests/live/**', 'tests/e2e*'],
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // *.ts only -- `src/**` also matches the non-code doc fixtures under
      // src/docs/*.md, which the v8 provider then fails to parse as JS.
      include: ['src/**/*.ts'],
      // src/vendored/** is byte-identical upstream code (see NOTICE), not our
      // coverage target -- our code is src/tools/** and src/auth/**.
      exclude: ['node_modules/', 'build/', 'bin/', 'src/vendored/**'],
      // Global (aggregate) gate over our code -- fails `test:coverage` on
      // regression. branches sits at 90 (not 95) because of a couple of
      // pre-existing, low-value gaps (registry.ts:32, errors.ts:30,217).
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 }
    }
  }
})
