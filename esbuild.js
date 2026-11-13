const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');

// The board pages are plain files a board's editor tab loads from the extension folder: the shared
// client and style, one folder per board, and the VS Code Elements bundle at its pinned version.
function copyBoardPages() {
  const target = './out/board-pages';
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync('./board-pages', target, { recursive: true });
  fs.copyFileSync('./node_modules/@vscode-elements/elements/dist/bundled.js', path.join(target, 'shared', 'vscode-elements.js'));
}
copyBoardPages();

build({
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
}).catch(() => process.exit(1));
