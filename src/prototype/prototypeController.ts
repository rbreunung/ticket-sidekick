import { LocalhostServer, type ServerStats } from './localhostServer';
import { createMcpHandler, type JiraAccess } from './mcpEndpoint';
import { createCanvasHandler, type CommentPlan } from './canvasRoutes';
import { PlanStore } from './planStore';
import { generateKey } from './keys';
import { placeLauncher, writeEntry, removeEntry, removeFolder, isProcessAlive } from './prototypeFolder';

// The prototype's lifecycle for one VS Code window, free of `vscode` so it can be tested with
// temporary folders. Start: new keys, the localhost server, the launcher folder and this window's
// rendezvous entry. Stop: the reverse. Nothing is persisted; a VS Code restart starts stopped.

export interface ControllerDeps {
  getJira(): Promise<JiraAccess>;
  getProjectKey(): string;
  confirmWrite(preview: string): Promise<boolean>;
  workspaceFolders(): string[];
  /** Folder holding the bundled launcher files (extension.mjs, package.json). */
  launcherSourceDir: string;
  /** The prototype folder in the Copilot home. */
  prototypeFolder: string;
  pid: number;
  isAlive?(pid: number): boolean;
  /** Whether MCP requests may be served right now; the server refuses them otherwise. */
  isMcpAllowed?(): boolean;
  onError?(message: string): void;
}

export interface McpDefinition {
  url: string;
  headers: Record<string, string>;
}

interface Running {
  port: number;
  mcpKey: string;
  canvasKey: string;
}

export class PrototypeController {
  private readonly server: LocalhostServer;
  private readonly plans = new PlanStore<CommentPlan>();
  private running: Running | undefined;
  /** The MCP key of the last run, kept in memory after a stop so the report can check whether it was stored. */
  private lastMcpKey: string | undefined;
  private starting: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ControllerDeps) {
    this.server = new LocalhostServer({
      onMcp: createMcpHandler({ getJira: deps.getJira, confirmWrite: deps.confirmWrite, onError: deps.onError }),
      onCanvas: createCanvasHandler({ getJira: deps.getJira, getProjectKey: deps.getProjectKey, plans: this.plans, onError: deps.onError }),
      allowMcp: deps.isMcpAllowed,
      onError: deps.onError,
    });
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  port(): number | undefined {
    return this.running?.port;
  }

  /** Called whenever the prototype starts or stops, so the MCP provider can announce the change. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Starts the prototype; a start requested while one is already under way joins it. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.doStart().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const keys = { mcpKey: generateKey(), canvasKey: generateKey() };
    const port = await this.server.start(keys);
    try {
      await placeLauncher(this.deps.prototypeFolder, this.deps.launcherSourceDir);
      await writeEntry(this.deps.prototypeFolder, {
        pid: this.deps.pid,
        port,
        canvasKey: keys.canvasKey,
        workspaceFolders: this.deps.workspaceFolders(),
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      await this.server.stop();
      await removeEntry(this.deps.prototypeFolder, this.deps.pid, this.isAlive).catch(() => undefined);
      throw err;
    }
    this.running = { port, ...keys };
    this.emit();
  }

  /** Stops the server and removes this window's traces; the folder goes when no other window uses it. */
  async stop(): Promise<{ folderRemoved: boolean }> {
    const wasRunning = this.running !== undefined;
    if (this.running) this.lastMcpKey = this.running.mcpKey;
    this.running = undefined;
    this.plans.clear();
    await this.server.stop();
    const result = await removeEntry(this.deps.prototypeFolder, this.deps.pid, this.isAlive);
    if (wasRunning) this.emit();
    return result;
  }

  /** Stops, then deletes the given prototype folders entirely, whatever other windows left there. */
  async removeLeftovers(folders: string[]): Promise<string[]> {
    if (this.running) await this.stop();
    const removed: string[] = [];
    for (const folder of [...new Set(folders)]) {
      if (await removeFolder(folder)) removed.push(folder);
    }
    return removed;
  }

  mcpDefinition(): McpDefinition | undefined {
    if (!this.running) return undefined;
    return {
      url: `http://127.0.0.1:${this.running.port}/mcp`,
      headers: { Authorization: `Bearer ${this.running.mcpKey}` },
    };
  }

  /** The secrets a report must never contain: the current keys and the last run's MCP key. */
  secrets(): string[] {
    const current = this.running ? [this.running.mcpKey, this.running.canvasKey] : [];
    return this.lastMcpKey ? [...current, this.lastMcpKey] : current;
  }

  /**
   * The MCP key the report searches stored files for: the current one while running, otherwise the
   * one from the last run in this window (to see whether a stored copy outlives a stop).
   */
  keyToSearch(): { key: string; kind: 'current' | 'last-run' } | undefined {
    if (this.running) return { key: this.running.mcpKey, kind: 'current' };
    return this.lastMcpKey ? { key: this.lastMcpKey, kind: 'last-run' } : undefined;
  }

  stats(): ServerStats {
    return this.server.stats();
  }

  private readonly isAlive = (pid: number): boolean => (this.deps.isAlive ?? isProcessAlive)(pid);

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
