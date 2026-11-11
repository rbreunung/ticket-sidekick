import type { DiagLogger } from '../utils/diagTypes';
import { generateKey, keyFingerprint } from './keys';
import { LocalhostServer, type CanvasHandler, type ServerStats } from './localhostServer';
import { createMcpHandler, type McpServerInfo, type McpToolDefinition, type ToolCallOutcome } from './mcpServer';
import { MCP_PATH } from './requestGuard';

// The MCP server's lifecycle for one VS Code window, free of `vscode` so it can be tested over a
// real socket. Each start makes a new bearer key. Starts and stops run one after another in the
// order they were asked for, so a stop has finished before the next start begins and the history
// shows the real order. After each one the setting is read again and the server follows it, so
// the last change of the setting wins even when changes arrive faster than a start or stop
// completes. Everything the diagnostics report needs is kept here in memory: the start/stop
// history, the definition handshake counts and the tool-call outcomes. Keys of earlier starts are
// remembered only as short fingerprints, so a stale client can be recognised without keeping its
// key.

/** What started or stopped the server. */
export type LifecycleTrigger = 'activation' | 'entry added' | 'entry removed' | 'deactivate';

export interface HistoryEntry {
  at: string;
  event: 'started' | 'stopped' | 'start failed';
  trigger: LifecycleTrigger;
  port?: number;
}

export interface ToolCallCounts {
  ok: number;
  /** Failures by error label: `HTTP <status>` or the error class. */
  failed: Record<string, number>;
}

/** The key-free facts the diagnostics report shows about the server. */
export interface ControllerSnapshot {
  running: boolean;
  port: number | undefined;
  history: HistoryEntry[];
  /** How often the provider announced a change of its server definitions. */
  announcements: number;
  /** Resolve-hook calls answered with the current definition, and refused while stopped. */
  resolveServed: number;
  resolveRefused: number;
  /** Request counters since the last start. */
  stats: ServerStats;
  toolCalls: Record<string, ToolCallCounts>;
}

export interface McpDefinition {
  url: string;
  headers: { Authorization: string };
}

export interface McpServerControllerOptions<Deps> {
  tools: readonly McpToolDefinition<Deps>[];
  toolDeps: Deps;
  serverInfo: McpServerInfo;
  /** Whether MCP requests may be served and the definition handed out right now. */
  isMcpAllowed(): boolean;
  /** Serves canvas pages under the canvas key; without it, the server has no canvas route. */
  onCanvas?: CanvasHandler;
  onDiag?: DiagLogger;
}

interface Running {
  port: number;
  mcpKey: string;
  canvasKey: string;
}

/** Where canvas pages of the running server are reached; never logged. */
export interface CanvasAccess {
  port: number;
  canvasKey: string;
}

export class McpServerController<Deps> {
  private readonly server: LocalhostServer;
  private running: Running | undefined;
  /** The start or stop under way and those queued behind it, run one at a time. */
  private queue: Promise<void> = Promise.resolve();
  /** Set by the deactivation stop: nothing starts the server afterwards. */
  private ended = false;
  private readonly earlierFingerprints = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly history: HistoryEntry[] = [];
  private readonly toolCalls: Record<string, ToolCallCounts> = {};
  private announcements = 0;
  private resolveServed = 0;
  private resolveRefused = 0;

  constructor(private readonly options: McpServerControllerOptions<Deps>) {
    this.server = new LocalhostServer({
      onMcp: createMcpHandler(options.tools, options.toolDeps, options.serverInfo, { onToolCall: outcome => this.recordToolCall(outcome) }),
      onCanvas: options.onCanvas,
      allowMcp: options.isMcpAllowed,
      isEarlierKey: key => this.earlierFingerprints.has(keyFingerprint(key)),
      onRefused: (reason, path) => options.onDiag?.('warn', `MCP request refused: ${reason}`, { path }),
      onError: message => options.onDiag?.('error', `MCP request failed: ${message}`),
    });
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  port(): number | undefined {
    return this.running?.port;
  }

  /** Called whenever the server starts or stops, so the provider can announce the change. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /**
   * Starts the server unless it runs already, after any start or stop asked for earlier. A failed
   * start is logged and recorded, not thrown, and not retried until the next start is asked for.
   */
  start(trigger: LifecycleTrigger): Promise<void> {
    return this.enqueue(async () => {
      if (this.ended) return;
      const ok = await this.doStart(trigger);
      await this.followSetting(ok);
    });
  }

  /**
   * Stops the server after any start or stop asked for earlier. The deactivation stop is final;
   * any other stop is followed by a check of the setting, which starts the server again if the
   * entry came back in the meantime.
   */
  stop(trigger: LifecycleTrigger): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop(trigger);
      if (trigger === 'deactivate') this.ended = true;
      else await this.followSetting(true);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Brings the server in line with the setting as it is now; a start that just failed is not retried. */
  private async followSetting(lastStartOk: boolean): Promise<void> {
    if (this.ended) return;
    const allowed = this.options.isMcpAllowed();
    if (allowed && !this.running && lastStartOk) await this.doStart('entry added');
    else if (!allowed && this.running) await this.doStop('entry removed');
  }

  /** Returns false only when a start was tried and failed. */
  private async doStart(trigger: LifecycleTrigger): Promise<boolean> {
    if (this.running) return true;
    const mcpKey = generateKey();
    const canvasKey = generateKey();
    try {
      const port = await this.server.start(mcpKey, canvasKey);
      this.running = { port, mcpKey, canvasKey };
      this.history.push({ at: new Date().toISOString(), event: 'started', trigger, port });
      this.options.onDiag?.('info', `MCP server started on 127.0.0.1:${port} (${trigger})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.history.push({ at: new Date().toISOString(), event: 'start failed', trigger });
      this.options.onDiag?.('error', `MCP server could not start (${trigger}): ${message}`);
      return false;
    }
    this.emit();
    return true;
  }

  private async doStop(trigger: LifecycleTrigger): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.running = undefined;
    this.earlierFingerprints.add(keyFingerprint(running.mcpKey));
    await this.server.stop();
    this.history.push({ at: new Date().toISOString(), event: 'stopped', trigger, port: running.port });
    this.options.onDiag?.('info', `MCP server stopped (${trigger})`);
    this.emit();
  }

  /** The definition the provider offers: the current URL and key while running and allowed. */
  definition(): McpDefinition | undefined {
    if (!this.running || !this.options.isMcpAllowed()) return undefined;
    return {
      url: `http://127.0.0.1:${this.running.port}${MCP_PATH}`,
      headers: { Authorization: `Bearer ${this.running.mcpKey}` },
    };
  }

  /** What the resolve hook hands VS Code just before it connects; counted for the report. */
  resolveDefinition(): McpDefinition | undefined {
    const definition = this.definition();
    if (definition) this.resolveServed++;
    else this.resolveRefused++;
    return definition;
  }

  /** The running server's key, for redacting the report and searching stored files; never logged. */
  currentKey(): string | undefined {
    return this.running?.mcpKey;
  }

  /** Port and canvas key while the server runs, for the window note; never logged. */
  canvasAccess(): CanvasAccess | undefined {
    return this.running ? { port: this.running.port, canvasKey: this.running.canvasKey } : undefined;
  }

  snapshot(): ControllerSnapshot {
    return {
      running: this.isRunning(),
      port: this.port(),
      history: this.history.map(e => ({ ...e })),
      announcements: this.announcements,
      resolveServed: this.resolveServed,
      resolveRefused: this.resolveRefused,
      stats: this.server.stats(),
      toolCalls: JSON.parse(JSON.stringify(this.toolCalls)) as Record<string, ToolCallCounts>,
    };
  }

  private recordToolCall(outcome: ToolCallOutcome): void {
    const counts = (this.toolCalls[outcome.tool] ??= { ok: 0, failed: {} });
    if (outcome.ok) {
      counts.ok++;
      this.options.onDiag?.('info', `MCP tool call ${outcome.tool}: ok`);
    } else {
      counts.failed[outcome.error] = (counts.failed[outcome.error] ?? 0) + 1;
      this.options.onDiag?.('warn', `MCP tool call ${outcome.tool}: failed (${outcome.error})`);
    }
  }

  private emit(): void {
    this.announcements++;
    for (const listener of this.listeners) listener();
  }
}
