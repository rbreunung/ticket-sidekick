import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// The shared import engine must load without VS Code and without the chat participant code. No `vscode` mock is set up in this file: an engine module that reached `vscode`,
// directly or through another module, would fail to load here.

const engineDir = resolve(__dirname, '..', 'imports');
const engineFiles = readdirSync(engineDir).filter(name => name.endsWith('.ts')).sort();

describe('shared import engine', () => {
  it.each(engineFiles)('loads %s without VS Code', async name => {
    const loaded: Record<string, unknown> = await import(join(engineDir, name));
    expect(loaded).toBeTypeOf('object');
  });

  it.each(engineFiles)('%s imports neither vscode nor the chat participant code', name => {
    const source = readFileSync(join(engineDir, name), 'utf-8');
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m => m[1]);
    expect(specifiers.filter(s => s === 'vscode' || s.includes('participant'))).toEqual([]);
  });

  it('builds both report descriptors from plain setting readers', async () => {
    const { createVeracodeDescriptor } = await import('../imports/veracode');
    const { createWaltzDescriptor } = await import('../imports/waltz');
    const veracode = createVeracodeDescriptor(
      { filter: () => ({ minSeverity: 4, includeStatuses: ['New'], maxReportBytes: 1024 }), slaDays: () => undefined },
      { reviewColumns: [] },
    );
    const waltz = createWaltzDescriptor(
      { filter: () => ({ minVulnRating: 'High', includeRemediationActions: [''], maxReportBytes: 1024 }), minVulnRating: () => 'High', workspaceRoot: () => undefined },
      { reviewColumns: [] },
    );
    expect(veracode.descriptorKind).toBe('veracode');
    expect(waltz.descriptorKind).toBe('waltz');
    // No workspace folder: the accepted list cannot be read, so nothing is hidden and nothing is written.
    expect(waltz.accepted?.service()).toBeNull();
  });
});
