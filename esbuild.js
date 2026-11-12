const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');

// The Copilot SDK loads its native FFI host (and the `koffi` module behind it) only through a
// dynamic import that the canvas program never reaches, so that one file stays outside the bundle.
const keepFfiHostExternal = {
  name: 'keep-ffi-host-external',
  setup(b) {
    b.onResolve({ filter: /ffiRuntimeHost\.js$/ }, args => ({ path: args.path, external: true }));
  },
};

// The agent plugin the extension contributes (contributes.chatPlugins): its manifest, with the
// extension's version, and the canvas program as one self-contained ESM file with a minimal
// package.json, under the plugin's Copilot namespace.
const pluginDir = './out/plugin';
const canvasDir = `${pluginDir}/com.github.copilot/extensions/ticket-sidekick`;

function writePluginFiles() {
  const version = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;
  const manifest = JSON.parse(fs.readFileSync('./plugin/plugin.json', 'utf8'));
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
  const pkg = { name: 'ticket-sidekick-canvases', version, private: true, type: 'module', main: 'extension.mjs' };
  fs.writeFileSync(path.join(canvasDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

Promise.all([
  build({
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: './out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
  }),
  build({
    entryPoints: ['./src/canvas/launcher/extension.ts'],
    bundle: true,
    outfile: `${canvasDir}/extension.mjs`,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    plugins: [keepFfiHostExternal],
    banner: { js: "import { createRequire as __tsCreateRequire } from 'module'; const require = __tsCreateRequire(import.meta.url);" },
  }).then(writePluginFiles),
]).catch(() => process.exit(1));
