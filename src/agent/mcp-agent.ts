// src/agent/mcp-agent.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Schema } from "effect";

import {
  isSessionError,
  isStorageError,
  RunNotFoundError,
  SessionNotFoundError,
} from "../models/errors";
import type { RunRecord } from "../models/run";
import { SessionId, type SessionMetadata } from "../models/session";
import { createProxyToken } from "../proxy";
import { makeStorageLayer, StorageService, type SqlStorageInterface } from "../services/storage";
import { ToolCallEventBuilder } from "../services/telemetry";
import {
  formatErrorResponse,
  formatToolResponse,
  getResultInputSchema,
  listRunsInputSchema,
  runTaskInputSchema,
  type GetResultInput,
  type ListRunsInput,
  type RunTaskInput,
} from "./tools";

/**
 * State managed by the MCP Agent
 */
interface AgentState {
  initialized: boolean;
}

/**
 * Extended context type for accessing Durable Object internals
 * The McpAgent extends Agent which has ctx but TypeScript types don't expose sql
 */
interface AgentContext {
  ctx: {
    id: DurableObjectId;
    storage: {
      sql: SqlStorageInterface;
    };
  };
}

/**
 * Error thrown when runtime is not initialized
 */
class RuntimeNotInitializedError extends Error {
  constructor() {
    super("MCP Agent runtime not initialized. Call init() first.");
    this.name = "RuntimeNotInitializedError";
  }
}

/**
 * Get the runtime, throwing if not initialized
 */
function getRuntime(
  runtime: ManagedRuntime.ManagedRuntime<StorageService, never> | null,
): ManagedRuntime.ManagedRuntime<StorageService, never> {
  if (runtime === null) {
    throw new RuntimeNotInitializedError();
  }
  return runtime;
}

/**
 * Format error for MCP response, preserving domain error information
 */
function formatDomainError(error: unknown): ReturnType<typeof formatErrorResponse> {
  // Check for domain-specific errors and use their tags
  if (isSessionError(error)) {
    return formatErrorResponse({
      code: error._tag,
      message: error.message,
    });
  }
  if (isStorageError(error)) {
    return formatErrorResponse({
      code: error._tag,
      message: error.message,
    });
  }

  // Fallback for unknown errors
  return formatErrorResponse({
    code: "UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * OpenCode MCP Agent - Durable Object that handles MCP protocol
 */
export class OpenCodeMcpAgent extends McpAgent<Env, AgentState> {
  server = new McpServer({
    name: "opencode-sandbox",
    version: "1.0.0",
  });

  /** @public Required by McpAgent base class */
  initialState: AgentState = {
    initialized: false,
  };

  private runtime: ManagedRuntime.ManagedRuntime<StorageService, never> | null = null;

  /**
   * Access the Durable Object context with proper typing
   */
  private get agentContext(): AgentContext {
    // McpAgent extends Agent which has ctx property
    // We use a type assertion here because the SDK types don't expose sql
    return this as unknown as AgentContext;
  }

  /**
   * Initialize the MCP server with tools
   * @public Called by McpAgent framework on DO start
   */
  async init(): Promise<void> {
    // Access SQL storage from the Durable Object state
    const sql = this.agentContext.ctx.storage.sql;

    // Initialize SQLite schema
    const storage = makeStorageLayer(sql);
    this.runtime = ManagedRuntime.make(storage);

    await this.runtime.runPromise(
      Effect.gen(function* () {
        const storageService = yield* StorageService;
        yield* storageService.initSchema();
      }),
    );

    // Register tools - NEW ORDER (removed create_session)
    this.registerRunTaskTool();
    this.registerGetResultTool();
    this.registerListRunsTool();

    this.setState({ initialized: true });
  }

  /**
   * Emit telemetry for a tool call
   */
  private emitToolTelemetry(builder: ToolCallEventBuilder, success: boolean): void {
    if (success) {
      builder.setOutcome("success");
    }
    const event = builder.finalize();
    console.log(
      JSON.stringify({
        level: success ? "info" : "error",
        type: "tool.call",
        ...event,
      }),
    );
  }

  /**
   * Build the absolute web UI URL for a session.
   * Uses PROXY_BASE_URL as the base since the same worker serves both MCP and web UI.
   */
  private getWebUiUrl(sessionId: string): string {
    return `${this.env.PROXY_BASE_URL}/session/${sessionId}/`;
  }

  /**
   * Tool: opencode_run_task
   * Execute a coding task. Creates session if needed, or continues existing session.
   */
  private registerRunTaskTool(): void {
    this.server.registerTool(
      "opencode_run_task",
      {
        description:
          "Execute a coding task in a sandbox. Creates session if needed, or continues existing session.",
        inputSchema: runTaskInputSchema,
      },
      async (params: RunTaskInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_run_task", params.sessionId ?? "new");
        telemetry.startPhase("validate");

        try {
          const rt = getRuntime(this.runtime);
          let session: SessionMetadata;
          let isNewSession = false;

          // 1. Resolve or create session
          if (params.sessionId) {
            // Continue existing session
            telemetry.endPhase("validate");
            telemetry.startPhase("storage");

            const existing = await rt.runPromise(
              Effect.gen(function* () {
                const storage = yield* StorageService;
                return yield* storage.getSession(params.sessionId!);
              }),
            );

            if (existing._tag === "None") {
              const error = new SessionNotFoundError({ sessionId: params.sessionId! });
              telemetry.setError({
                type: error._tag,
                code: error._tag,
                message: error.message,
                retriable: false,
              });
              this.emitToolTelemetry(telemetry, false);
              return formatDomainError(error);
            }
            session = existing.value;
          } else {
            // Create new session
            isNewSession = true;
            // Generate a short session ID from UUID (8 hex chars, always lowercase alphanumeric)
            const rawSessionId = crypto.randomUUID().slice(0, 8);
            // Validate through Schema to get properly branded type
            const sessionId = Schema.decodeSync(SessionId)(rawSessionId);

            session = {
              sessionId,
              sandboxId: sessionId,
              createdAt: Date.now(),
              lastActivity: Date.now(),
              status: "active",
              workspacePath: "/workspace",
              webUiUrl: this.getWebUiUrl(sessionId),
              repository: params.repository
                ? {
                    url: params.repository,
                    branch: params.branch ?? "main",
                  }
                : undefined,
              clonedRepos: params.repository ? [params.repository] : [],
              config: {
                defaultModel: "claude-sonnet-4-20250514",
              },
            };

            telemetry.endPhase("validate");
            telemetry.startPhase("storage");

            await rt.runPromise(
              Effect.gen(function* () {
                const storage = yield* StorageService;
                yield* storage.putSession(session);
              }),
            );
          }

          // 2. Check if additional repo needs cloning
          const needsClone = params.repository && !session.clonedRepos?.includes(params.repository);

          // Update clonedRepos if we're adding a new repo
          if (needsClone && params.repository) {
            session = {
              ...session,
              clonedRepos: [...(session.clonedRepos ?? []), params.repository],
            };
          }

          telemetry.endPhase("storage");
          telemetry.startPhase("token");

          // 3. Create run record
          const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
          const doId = this.agentContext.ctx.id.toString();
          const model = params.model ?? session.config.defaultModel;

          // Create proxy token for zero-trust authentication
          const proxyToken = await rt.runPromise(
            createProxyToken({
              secret: this.env.PROXY_JWT_SECRET,
              sandboxId: session.sandboxId,
              sessionId: session.sessionId,
              expiresIn: "2h",
            }),
          );

          telemetry.endPhase("token");
          telemetry.startPhase("workflow");

          // 4. Create workflow to execute task
          const workflowInstance = await this.env.EXECUTE_TASK_WORKFLOW.create({
            id: runId,
            params: {
              sessionId: session.sessionId,
              sandboxId: session.sandboxId,
              task: params.task,
              model,
              runId,
              doId,
              repositoryUrl: needsClone ? params.repository : session.repository?.url,
              branch: params.branch ?? session.repository?.branch,
              existingOpencodeSessionId: session.opencodeSessionId,
              proxyToken,
              proxyBaseUrl: this.env.PROXY_BASE_URL,
            },
          });

          telemetry.endPhase("workflow");
          telemetry.startPhase("storage");

          // 5. Create run record
          const run: RunRecord = {
            runId,
            sessionId: session.sessionId,
            workflowId: workflowInstance.id,
            status: "started",
            task: params.task,
            title: params.title ?? "Processing...", // Placeholder until OpenCode generates
            model,
            startedAt: Date.now(),
          };

          await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              yield* storage.putRun(run);
            }),
          );

          // Update session last activity
          await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              yield* storage.putSession({
                ...session,
                lastActivity: Date.now(),
                status: "active",
              });
            }),
          );

          telemetry.endPhase("storage");
          telemetry.setMetadata({
            runId,
            workflowId: workflowInstance.id,
            isNewSession,
            needsClone,
          });
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            runId,
            sessionId: session.sessionId,
            status: "started",
            webUiUrl: session.webUiUrl,
          });
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          const errorMessage = error instanceof Error ? error.message : String(error);
          telemetry.setError({
            type: errorName,
            code: errorName,
            message: errorMessage,
            retriable: false,
          });
          this.emitToolTelemetry(telemetry, false);
          return formatDomainError(error);
        }
      },
    );
  }

  /**
   * Tool: opencode_get_result
   * Get the status and result of a specific task run.
   */
  private registerGetResultTool(): void {
    this.server.registerTool(
      "opencode_get_result",
      {
        description: "Get the status and result of a specific task run.",
        inputSchema: getResultInputSchema,
      },
      async (params: GetResultInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_get_result", params.runId);
        telemetry.startPhase("storage");

        try {
          const rt = getRuntime(this.runtime);

          const run = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getRun(params.runId);
            }),
          );

          if (run._tag === "None") {
            const error = new RunNotFoundError({ runId: params.runId });
            telemetry.setError({
              type: error._tag,
              code: error._tag,
              message: error.message,
              retriable: false,
            });
            this.emitToolTelemetry(telemetry, false);
            return formatDomainError(error);
          }

          // Get session for webUiUrl
          const session = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(run.value.sessionId);
            }),
          );

          telemetry.endPhase("storage");
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            runId: run.value.runId,
            sessionId: run.value.sessionId,
            status: run.value.status,
            task: run.value.task,
            title: run.value.title,
            startedAt: run.value.startedAt,
            completedAt: run.value.completedAt,
            result: run.value.result,
            webUiUrl: session._tag === "Some" ? session.value.webUiUrl : undefined,
          });
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          const errorMessage = error instanceof Error ? error.message : String(error);
          telemetry.setError({
            type: errorName,
            code: errorName,
            message: errorMessage,
            retriable: false,
          });
          this.emitToolTelemetry(telemetry, false);
          return formatDomainError(error);
        }
      },
    );
  }

  /**
   * Tool: opencode_list_runs
   * List past task runs with filtering and pagination.
   */
  private registerListRunsTool(): void {
    this.server.registerTool(
      "opencode_list_runs",
      {
        description: "List past task runs. Use to discover old work or see history.",
        inputSchema: listRunsInputSchema,
      },
      async (params: ListRunsInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_list_runs", "list");
        telemetry.startPhase("storage");

        try {
          const rt = getRuntime(this.runtime);
          const limit = params.limit ?? 10;

          const runs = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.listAllRuns({
                sessionId: params.sessionId,
                status: params.status,
                limit: limit + 1, // Fetch one extra to check hasMore
                before: params.before,
              });
            }),
          );

          const hasMore = runs.length > limit;
          const returnRuns = hasMore ? runs.slice(0, limit) : runs;

          telemetry.endPhase("storage");
          telemetry.setMetadata({ runsCount: returnRuns.length, hasMore });
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            runs: returnRuns.map((r) => ({
              runId: r.runId,
              sessionId: r.sessionId,
              status: r.status,
              title: r.title,
              task: r.task.length > 100 ? r.task.slice(0, 100) + "..." : r.task,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
              success: r.result?.success,
            })),
            hasMore,
          });
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          const errorMessage = error instanceof Error ? error.message : String(error);
          telemetry.setError({
            type: errorName,
            code: errorName,
            message: errorMessage,
            retriable: false,
          });
          this.emitToolTelemetry(telemetry, false);
          return formatDomainError(error);
        }
      },
    );
  }

  /**
   * Ensure runtime is initialized with schema.
   * Used for RPC methods that may be called before init().
   *
   * Note: Durable Objects serialize requests, so there's no race condition here.
   * If onTaskComplete arrives before init(), we need to ensure the schema exists.
   */
  private ensureRuntime(): ManagedRuntime.ManagedRuntime<StorageService, never> {
    if (this.runtime === null) {
      // Lazily initialize runtime for RPC calls that happen before init()
      const sql = this.agentContext.ctx.storage.sql;
      const storage = makeStorageLayer(sql);
      this.runtime = ManagedRuntime.make(storage);

      // Initialize schema synchronously - required for DB operations
      this.runtime.runSync(
        Effect.gen(function* () {
          const storageService = yield* StorageService;
          yield* storageService.initSchema();
        }),
      );
    }
    return this.runtime;
  }

  /**
   * RPC method called by Workflow when task completes
   * @public Called via DO RPC from ExecuteTaskWorkflow
   */
  async onTaskComplete(params: {
    runId: string;
    result: {
      success: boolean;
      output?: string;
      error?: string;
      title?: string;
      opencodeSessionId?: string;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
      };
    };
  }): Promise<void> {
    // Use ensureRuntime() instead of getRuntime() since RPC calls
    // may arrive before init() is called (e.g., when DO is woken from cold state)
    const rt = this.ensureRuntime();

    await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        const existing = yield* storage.getRun(params.runId);

        if (existing._tag === "Some") {
          // Update run with result
          const updated: RunRecord = {
            ...existing.value,
            status: params.result.success ? "completed" : "failed",
            completedAt: Date.now(),
            title: params.result.title ?? existing.value.title,
            result: {
              success: params.result.success,
              output: params.result.output ?? "",
              error: params.result.error,
            },
          };
          yield* storage.putRun(updated);

          // Update session with opencodeSessionId for continuation
          if (params.result.opencodeSessionId) {
            const session = yield* storage.getSession(existing.value.sessionId);
            if (session._tag === "Some") {
              yield* storage.putSession({
                ...session.value,
                opencodeSessionId: params.result.opencodeSessionId,
                lastActivity: Date.now(),
              });
            }
          }
        }
      }),
    );
  }
}
