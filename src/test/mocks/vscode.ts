// A minimal, narrowly-scoped fake of the `vscode` module, aliased in `vitest.config.ts` so
// Vitest can load `src/participant/jira/loadHandler.ts`'s extracted load core (KTD8) and give
// it a real integration test. Covers only what that core touches: `Uri.joinPath`/`Uri.file`,
// an in-memory `workspace.fs` (`createDirectory`/`writeFile`/`readFile`), and
// `workspace.getConfiguration('ticketSidekick').get('jira.baseUrl')`.
//
// This is deliberately NOT a general-purpose vscode API shim (KTD8) — extend it only when a
// unit under test genuinely needs another piece of the real API, not for convenience.

export class FakeUri {
  constructor(public readonly fsPath: string) {}
  toString(): string {
    return this.fsPath;
  }
}

function joinPath(base: { fsPath: string }, ...segments: string[]): FakeUri {
  const parts = [base.fsPath.replace(/\/+$/, ''), ...segments];
  return new FakeUri(parts.join('/'));
}

export const Uri = {
  file: (path: string): FakeUri => new FakeUri(path),
  joinPath,
};

/** In-memory filesystem, keyed by `fsPath`. Exported so tests can assert on written content. */
export const fakeFiles = new Map<string, Uint8Array>();
/** Directories `workspace.fs.createDirectory` was asked to create. */
export const fakeDirectories = new Set<string>();

/** Clears the in-memory filesystem and resets the configured base URL. Call between tests. */
export function resetVscodeMock(): void {
  fakeFiles.clear();
  fakeDirectories.clear();
  configuredBaseUrl = '';
}

let configuredBaseUrl = '';
/** Sets what `workspace.getConfiguration('ticketSidekick').get('jira.baseUrl')` returns. */
export function setFakeBaseUrl(url: string): void {
  configuredBaseUrl = url;
}

/** `logDiag` (`src/utils/diagLog.ts`) lazily creates one output channel via this — the load
 * core's failure paths call it, so a no-op stand-in is needed even though this test suite
 * asserts on skipped/error results, not on log output. */
export const window = {
  createOutputChannel(_name: string) {
    return { appendLine(_line: string) {}, show() {}, dispose() {} };
  },
};

export const workspace = {
  workspaceFolders: [{ uri: new FakeUri('/workspace'), name: 'workspace', index: 0 }],
  fs: {
    async createDirectory(uri: FakeUri): Promise<void> {
      fakeDirectories.add(uri.fsPath);
    },
    async writeFile(uri: FakeUri, content: Uint8Array): Promise<void> {
      fakeFiles.set(uri.fsPath, content);
    },
    async readFile(uri: FakeUri): Promise<Uint8Array> {
      const content = fakeFiles.get(uri.fsPath);
      if (!content) throw new Error(`ENOENT: ${uri.fsPath}`);
      return content;
    },
  },
  getConfiguration(_section: string) {
    return {
      get<T>(_key: string): T | undefined {
        return configuredBaseUrl as unknown as T;
      },
    };
  },
};
