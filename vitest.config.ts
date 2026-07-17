import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['build/**', 'node_modules/**', 'bin/**', 'tests/live/**', 'tests/e2e*'],
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // src/vendored/** is byte-identical upstream code (see NOTICE), not our
      // coverage target -- our code is src/tools/** and src/auth/**.
      exclude: ['node_modules/', 'build/', 'bin/', 'src/vendored/**']
    }
  }
})
