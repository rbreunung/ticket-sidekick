const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');

// The Copilot SDK loads its native FFI host (and the `koffi` module behind it) only through a
// dynamic import that the canvas launcher never reaches, so that one file stays outside the bundle.
const keepFfiHostExternal = {
  name: 'keep-ffi-host-external',
  setup(b) {
    b.onResolve({ filter: /ffiRuntimeHost\.js$/ }, args => ({ path: args.path, external: true }));
  },
};

const launcherDir = './out/prototype-launcher';

Promise.all([
  build({
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: './out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
  }),
  // The canvas launcher for the Copilot harness prototype: one self-contained ESM file plus a
  // minimal package.json, copied into the Copilot home while the prototype runs.
  build({
    entryPoints: ['./src/prototype/launcher/extension.ts'],
    bundle: true,
    outfile: `${launcherDir}/extension.mjs`,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    plugins: [keepFfiHostExternal],
    banner: { js: "import { createRequire as __tsCreateRequire } from 'module'; const require = __tsCreateRequire(import.meta.url);" },
  }).then(() => {
    const pkg = { name: 'ticket-sidekick-canvas-launcher', version: '0.0.1', private: true, type: 'module', main: 'extension.mjs' };
    fs.writeFileSync(path.join(launcherDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }),
]).catch(() => process.exit(1));
