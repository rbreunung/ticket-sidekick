import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Lets Vitest load the handful of `vscode`-importing modules narrow enough to be worth
      // testing (currently just loadHandler.ts's extracted load core — KTD8 in
      // docs/plans/2026-09-02-2247-feat-load-ticket-parity-plan.md). Never touches the
      // compiled extension (`tsc`/`vsce package`) — alias resolution is a Vitest-only concept.
      vscode: fileURLToPath(new URL('./src/test/mocks/vscode.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    pool: 'forks',
  },
});
