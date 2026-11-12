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
  // VS Code up to 1.146 passes a plugin to the agent host only when it finds a skill, agent, command,
  // hook, instruction or MCP server in it; a plugin with nothing but a canvas program is dropped
  // (microsoft/vscode#347397, fixed for 1.147). The skill keeps the plugin from looking empty.
  fs.rmSync(path.join(pluginDir, 'skills'), { recursive: true, force: true });
  fs.cpSync('./plugin/skills', path.join(pluginDir, 'skills'), { recursive: true });
  const pkg = { name: 'ticket-sidekick-canvases', version, private: true, type: 'module', main: 'extension.mjs' };
  fs.writeFileSync(path.join(canvasDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

// The board pages are plain files served by the extension's localhost server: the shared client
// and style, one folder per board, and the VS Code Elements bundle at its pinned version.
function copyCanvasPages() {
  const target = './out/canvas-pages';
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync('./canvas-pages', target, { recursive: true });
  fs.copyFileSync('./node_modules/@vscode-elements/elements/dist/bundled.js', path.join(target, 'shared', 'vscode-elements.js'));
}
copyCanvasPages();

// Which commit and when: shown in the diagnostics report, so an installed build can be told from another of the same version.
function buildId() {
  let commit = 'unknown';
  try {
    commit = require('child_process').execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (require('child_process').execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) commit += '+changes';
  } catch {
    // Built outside a git checkout.
  }
  return `${commit} built ${new Date().toISOString()}`;
}

Promise.all([
  build({
    define: { __TS_BUILD__: JSON.stringify(buildId()) },
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: './out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
  }),
  build({
    define: { __TS_BUILD__: JSON.stringify(buildId()) },
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
