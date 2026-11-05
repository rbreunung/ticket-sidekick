import type * as vscode from 'vscode';

// Local types for the MCP server definition API (VS Code 1.101+). The extension's `engines.vscode`
// floor and its `@types/vscode` are older, so the API is read from the `vscode` module at runtime
// and used only when it exists.

export interface McpHttpServerDefinitionLike {
  readonly label: string;
}

export type McpHttpServerDefinitionCtor = new (
  label: string,
  uri: vscode.Uri,
  headers?: Record<string, string>,
  version?: string,
) => McpHttpServerDefinitionLike;

export interface McpServerDefinitionProviderLike {
  readonly onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions(token: vscode.CancellationToken): vscode.ProviderResult<McpHttpServerDefinitionLike[]>;
  resolveMcpServerDefinition?(server: McpHttpServerDefinitionLike, token: vscode.CancellationToken): vscode.ProviderResult<McpHttpServerDefinitionLike>;
}

export interface McpApi {
  registerMcpServerDefinitionProvider(id: string, provider: McpServerDefinitionProviderLike): vscode.Disposable;
  McpHttpServerDefinition: McpHttpServerDefinitionCtor;
}

/** The MCP provider API when this VS Code has it, otherwise undefined. */
export function detectMcpApi(vscodeModule: typeof vscode): McpApi | undefined {
  const lm = vscodeModule.lm as unknown as { registerMcpServerDefinitionProvider?: McpApi['registerMcpServerDefinitionProvider'] } | undefined;
  const ctor = (vscodeModule as unknown as { McpHttpServerDefinition?: McpHttpServerDefinitionCtor }).McpHttpServerDefinition;
  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function' || typeof ctor !== 'function') return undefined;
  return {
    registerMcpServerDefinitionProvider: lm.registerMcpServerDefinitionProvider.bind(lm),
    McpHttpServerDefinition: ctor,
  };
}
