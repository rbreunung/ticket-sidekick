import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a real VS Code with this extension loaded from the repo (the bundled out/extension.js)
// and runs the smoke suite inside it. `npm run test:e2e` builds first. On Linux CI it needs a
// display: `xvfb-run -a npm run test:e2e`; on Windows and macOS it just opens a window briefly.
//
// Optional environment variables:
//   VSCODE_TEST_VERSION     VS Code to download, e.g. 1.95.0 (the engines floor) or insiders; default stable
//   VSCODE_TEST_EXECUTABLE  path to an installed Code.exe / code to use instead of downloading
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const sandbox = path.join(extensionDevelopmentPath, '.vscode-test');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    version: process.env.VSCODE_TEST_VERSION || undefined,
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE || undefined,
    launchArgs: [
      // Only this extension: no Copilot or other installed extensions needed or wanted.
      '--disable-extensions',
      '--disable-workspace-trust',
      // Separate profile, so a VS Code you already have open is not touched or reused.
      `--user-data-dir=${path.join(sandbox, 'user-data')}`,
    ],
  });
}

main().catch((err) => {
  console.error('e2e run failed:', err);
  process.exit(1);
});
