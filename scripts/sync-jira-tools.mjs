// Writes the Jira tools into package.json's `contributes.languageModelTools`, from the tool
// catalog. Run it after adding or changing a Jira tool:  node scripts/sync-jira-tools.mjs
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-manifest-')), 'manifest.mjs');
await build({
  stdin: {
    contents: "import { JIRA_TOOLS } from './src/tools/jiraTools/catalog'; import { jiraToolManifest } from './src/tools/jiraToolManifest'; export const entries = jiraToolManifest(JIRA_TOOLS);",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning',
  banner: { js: "import { createRequire as __r } from 'module'; const require = __r(import.meta.url);" },
});
const { entries } = await import(pathToFileURL(out).href);
const file = path.join(process.cwd(), 'package.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const others = manifest.contributes.languageModelTools.filter(tool => !tool.name.startsWith('jira_'));
manifest.contributes.languageModelTools = [...others, ...entries];
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${entries.length} Jira tools to package.json (${others.length} other tools kept).`);
