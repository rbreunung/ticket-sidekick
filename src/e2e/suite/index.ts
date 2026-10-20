import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Smoke checks inside a real VS Code. Deliberately small: the chat flows need Copilot, a language
// model and real Jira/Bitbucket credentials, so they stay covered by the Vitest suite. What only a
// real host can prove is that the packaged extension activates and registers what package.json
// declares. Kept dependency-free (no mocha) — test-electron only needs an exported run().

const root = path.resolve(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  publisher: string;
  name: string;
  contributes: {
    commands?: { command: string }[];
    languageModelTools?: { name: string }[];
  };
};
const extensionId = `${manifest.publisher}.${manifest.name}`;

const tests: { name: string; fn: () => Promise<void> }[] = [
  {
    name: 'the extension activates',
    fn: async () => {
      const extension = vscode.extensions.getExtension(extensionId);
      assert.ok(extension, `extension ${extensionId} is not loaded`);
      await extension.activate();
      assert.strictEqual(extension.isActive, true);
    },
  },
  {
    name: 'every command package.json declares is registered',
    fn: async () => {
      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = (manifest.contributes.commands ?? []).map(c => c.command).filter(id => !registered.has(id));
      assert.deepStrictEqual(missing, []);
    },
  },
  {
    name: 'every language model tool package.json declares is registered',
    fn: async () => {
      const registered = new Set(vscode.lm.tools.map(t => t.name));
      const missing = (manifest.contributes.languageModelTools ?? []).map(t => t.name).filter(name => !registered.has(name));
      assert.deepStrictEqual(missing, []);
    },
  },
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ok   ${test.name}`);
    } catch (err) {
      failures.push(test.name);
      console.error(`  FAIL ${test.name}\n       ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${tests.length} e2e checks failed`);
  }
}
