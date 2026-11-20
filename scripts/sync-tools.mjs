// Writes the Jira and Bitbucket tools into package.json's `contributes.languageModelTools`, from
// the tool catalogs. Run it after adding or changing a tool:  node scripts/sync-tools.mjs
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-manifest-')), 'manifest.mjs');
await build({
  stdin: {
    contents: [
      "import { JIRA_TOOLS } from './src/tools/jiraTools/catalog';",
      "import { BITBUCKET_TOOLS } from './src/tools/bitbucketTools/catalog';",
      "import { toolManifest } from './src/tools/toolManifest';",
      "export const entries = [...toolManifest(BITBUCKET_TOOLS, 'bitbucket'), ...toolManifest(JIRA_TOOLS, 'jira')];",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning',
  banner: { js: "import { createRequire as __r } from 'module'; const require = __r(import.meta.url);" },
});
const { entries } = await import(pathToFileURL(out).href);
const file = path.join(process.cwd(), 'package.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const generated = name => name.startsWith('jira_') || name.startsWith('bitbucket_');
const others = manifest.contributes.languageModelTools.filter(tool => !generated(tool.name));
manifest.contributes.languageModelTools = [...others, ...entries];
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${entries.length} Jira and Bitbucket tools to package.json (${others.length} other tools kept).`);
