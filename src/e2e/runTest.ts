import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a real VS Code with this extension loaded from the repo (the bundled out/extension.js)
// and runs the smoke suite inside it. Needs a display: `xvfb-run -a npm run test:e2e` on Linux CI.
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // Only this extension: no Copilot or other installed extensions needed or wanted.
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error('e2e run failed:', err);
  process.exit(1);
});
