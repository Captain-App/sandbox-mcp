// src/agent/mcp-agent.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  createSessionInputSchema,
  runTaskInputSchema,
  getStatusInputSchema,
  formatToolResponse,
  formatErrorResponse,
  type CreateSessionInput,
  type RunTaskInput,
  type GetStatusInput,
} from "./tools";
import { StorageService, makeStorageLayer, type SqlStorageInterface } from "../services/storage";
import { isSessionError, isStorageError } from "../models/errors";
import type { SessionMetadata } from "../models/session";
import type { RunRecord } from "../models/run";
import { ToolCallEventBuilder } from "../services/telemetry";

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

    // Register tools using the recommended registerTool() method
    this.registerCreateSessionTool();
    this.registerRunTaskTool();
    this.registerGetStatusTool();

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
   * Tool: opencode_create_session
   * Uses registerTool() with proper Zod schema format
   */
  private registerCreateSessionTool(): void {
    this.server.registerTool(
      "opencode_create_session",
      {
        description: "Create or resume an OpenCode coding session in a sandbox",
        inputSchema: createSessionInputSchema,
      },
      async (params: CreateSessionInput) => {
        const telemetry = new ToolCallEventBuilder(
          "opencode_create_session",
          params.sessionId ?? "new",
        );
        telemetry.startPhase("validate");

        try {
          const rt = getRuntime(this.runtime);
          const sessionId = params.sessionId ?? crypto.randomUUID().slice(0, 8);

          telemetry.endPhase("validate");
          telemetry.startPhase("storage");

          // Check if session exists (resume)
          const existing = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(sessionId);
            }),
          );

          if (existing._tag === "Some") {
            telemetry.setMetadata({ action: "resume" });
            this.emitToolTelemetry(telemetry, true);
            return formatToolResponse({
              sessionId: existing.value.sessionId,
              sandboxId: existing.value.sandboxId,
              webUiUrl: existing.value.webUiUrl,
              status: "resumed",
              workspacePath: existing.value.workspacePath,
              repository: existing.value.repository,
            });
          }

          // Create session metadata
          const webUiUrl = `/session/${sessionId}/`;

          const session: SessionMetadata = {
            sessionId: sessionId as SessionMetadata["sessionId"],
            sandboxId: sessionId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: "idle",
            workspacePath: "/workspace",
            webUiUrl,
            repository: params.repositoryUrl
              ? {
                  url: params.repositoryUrl,
                  branch: params.branch ?? "main",
                }
              : undefined,
            title: params.title,
            config: {
              defaultModel: "claude-sonnet-4-20250514",
            },
          };

          await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              yield* storage.putSession(session);
            }),
          );

          telemetry.endPhase("storage");
          telemetry.setMetadata({ action: "create" });
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            sessionId: session.sessionId,
            sandboxId: session.sandboxId,
            webUiUrl: session.webUiUrl,
            status: "created",
            workspacePath: session.workspacePath,
            repository: session.repository,
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
   * Tool: opencode_run_task
   */
  private registerRunTaskTool(): void {
    this.server.registerTool(
      "opencode_run_task",
      {
        description: "Execute a coding task asynchronously in an OpenCode session",
        inputSchema: runTaskInputSchema,
      },
      async (params: RunTaskInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_run_task", params.sessionId);
        telemetry.startPhase("validate");

        try {
          const rt = getRuntime(this.runtime);

          // Verify session exists
          const session = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(params.sessionId);
            }),
          );

          if (session._tag === "None") {
            telemetry.setError({
              type: "SessionNotFoundError",
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`,
              retriable: false,
            });
            this.emitToolTelemetry(telemetry, false);
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`,
            });
          }

          telemetry.endPhase("validate");
          telemetry.startPhase("workflow");

          const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
          const doId = this.agentContext.ctx.id.toString();

          // Create workflow to execute task
          const workflowInstance = await this.env.EXECUTE_TASK_WORKFLOW.create({
            id: runId,
            params: {
              sessionId: params.sessionId,
              sandboxId: session.value.sandboxId,
              task: params.task,
              model: params.model ?? session.value.config.defaultModel,
              runId,
              doId,
              repositoryUrl: session.value.repository?.url,
              branch: session.value.repository?.branch,
              opencodeConfig: {
                provider: {
                  anthropic: {
                    options: {
                      apiKey: this.env.ANTHROPIC_API_KEY,
                    },
                  },
                },
              },
            },
          });

          telemetry.endPhase("workflow");
          telemetry.startPhase("storage");

          // Create run record
          const run: RunRecord = {
            runId,
            sessionId: params.sessionId,
            workflowId: workflowInstance.id,
            status: "queued",
            task: params.task,
            model: params.model ?? session.value.config.defaultModel,
            startedAt: Date.now(),
            retryCount: 0,
            maxRetries: 3,
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
                ...session.value,
                lastActivity: Date.now(),
                status: "active",
              });
            }),
          );

          telemetry.endPhase("storage");
          telemetry.setMetadata({ runId, workflowId: workflowInstance.id });
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            runId,
            workflowId: workflowInstance.id,
            status: "started",
            webUiUrl: session.value.webUiUrl,
            message: "Task started. Use opencode_get_status to check progress.",
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
   * Tool: opencode_get_status
   */
  private registerGetStatusTool(): void {
    this.server.registerTool(
      "opencode_get_status",
      {
        description: "Check the status of a session and optionally a specific task run",
        inputSchema: getStatusInputSchema,
      },
      async (params: GetStatusInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_get_status", params.sessionId);
        telemetry.startPhase("storage");

        try {
          const rt = getRuntime(this.runtime);

          const session = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(params.sessionId);
            }),
          );

          if (session._tag === "None") {
            telemetry.setError({
              type: "SessionNotFoundError",
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`,
              retriable: false,
            });
            this.emitToolTelemetry(telemetry, false);
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`,
            });
          }

          // Get recent runs
          const runs = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.listRuns(params.sessionId, 10);
            }),
          );

          // Get specific run if requested
          let currentRun: RunRecord | undefined;
          if (params.runId) {
            const runId = params.runId;
            const run = await rt.runPromise(
              Effect.gen(function* () {
                const storage = yield* StorageService;
                return yield* storage.getRun(runId);
              }),
            );
            if (run._tag === "Some") {
              currentRun = run.value;
            }
          }

          telemetry.endPhase("storage");
          telemetry.setMetadata({ runsCount: runs.length });
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            sessionId: session.value.sessionId,
            webUiUrl: session.value.webUiUrl,
            status: session.value.status,
            workspacePath: session.value.workspacePath,
            createdAt: session.value.createdAt,
            lastActivity: session.value.lastActivity,
            repository: session.value.repository,
            recentRuns: runs.map((r) => ({
              runId: r.runId,
              status: r.status,
              task: r.task.slice(0, 100) + (r.task.length > 100 ? "..." : ""),
              startedAt: r.startedAt,
              completedAt: r.completedAt,
            })),
            ...(currentRun && { currentRun }),
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
   * RPC method called by Workflow when task completes
   * @public Called via DO RPC from ExecuteTaskWorkflow
   */
  async onTaskComplete(params: {
    runId: string;
    result: {
      success: boolean;
      output?: string;
      error?: string;
      filesCreated: string[];
      filesModified: string[];
      commits: string[];
      branch?: string;
    };
  }): Promise<void> {
    const rt = getRuntime(this.runtime);

    await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        const existing = yield* storage.getRun(params.runId);

        if (existing._tag === "Some") {
          const updated: RunRecord = {
            ...existing.value,
            status: params.result.success ? "completed" : "failed",
            completedAt: Date.now(),
            result: params.result,
          };
          yield* storage.putRun(updated);
        }
      }),
    );
  }
}
