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
} from "./tools";
import {
  StorageService,
  makeStorageLayer,
  type SqlStorageInterface,
} from "../services/storage";
import {
  isSessionError,
  isStorageError,
  isWorkflowError,
} from "../models/errors";
import type { SessionMetadata } from "../models/session";
import type { RunRecord } from "../models/run";

/**
 * State managed by the MCP Agent
 */
interface AgentState {
  initialized: boolean;
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
  runtime: ManagedRuntime.ManagedRuntime<StorageService, never> | null
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
  if (isWorkflowError(error)) {
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

  initialState: AgentState = {
    initialized: false,
  };

  private runtime: ManagedRuntime.ManagedRuntime<StorageService, never> | null =
    null;

  /**
   * Initialize the MCP server with tools
   */
  async init(): Promise<void> {
    // Access SQL storage from the Durable Object state
    // McpAgent extends Agent which has access to ctx (DurableObjectState)
    const sql = (this as unknown as { ctx: DurableObjectState }).ctx.storage
      .sql as SqlStorageInterface;

    // Initialize SQLite schema
    const storage = makeStorageLayer(sql);
    this.runtime = ManagedRuntime.make(storage);

    await this.runtime.runPromise(
      Effect.gen(function* () {
        const storageService = yield* StorageService;
        yield* storageService.initSchema();
      })
    );

    // Register tools
    this.registerCreateSessionTool();
    this.registerRunTaskTool();
    this.registerGetStatusTool();

    this.setState({ initialized: true });
  }

  /**
   * Tool: opencode_create_session
   */
  private registerCreateSessionTool(): void {
    this.server.tool(
      "opencode_create_session",
      "Create or resume an OpenCode coding session in a sandbox",
      createSessionInputSchema.shape,
      async (params) => {
        try {
          const rt = getRuntime(this.runtime);
          const sessionId =
            params.sessionId ?? crypto.randomUUID().slice(0, 8);

          // Check if session exists (resume)
          const existing = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(sessionId);
            })
          );

          if (existing._tag === "Some") {
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
          // The web UI URL points to our proxy endpoint which will wake the sandbox
          // and forward requests to OpenCode. The actual sandbox setup happens lazily
          // when the first task runs or when the user visits the web UI.
          //
          // URL pattern: /session/{sessionId}/ - handled by the web UI proxy in index.ts
          // Note: In production, this should use the actual worker URL
          const webUiUrl = `/session/${sessionId}/`;

          // Note: sessionId is a plain string here (from params or generated),
          // the branded SessionId type is for the domain model validation
          const session: SessionMetadata = {
            sessionId: sessionId as SessionMetadata["sessionId"],
            sandboxId: sessionId, // 1:1 mapping between session and sandbox
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: "idle", // Session is ready but sandbox starts lazily
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
            })
          );

          return formatToolResponse({
            sessionId: session.sessionId,
            sandboxId: session.sandboxId,
            webUiUrl: session.webUiUrl,
            status: "created",
            workspacePath: session.workspacePath,
            repository: session.repository,
          });
        } catch (error) {
          return formatDomainError(error);
        }
      }
    );
  }

  /**
   * Tool: opencode_run_task
   */
  private registerRunTaskTool(): void {
    this.server.tool(
      "opencode_run_task",
      "Execute a coding task asynchronously in an OpenCode session",
      runTaskInputSchema.shape,
      async (params) => {
        try {
          const rt = getRuntime(this.runtime);

          // Verify session exists
          const session = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(params.sessionId);
            })
          );

          if (session._tag === "None") {
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`,
            });
          }

          const runId = `run-${crypto.randomUUID().slice(0, 8)}`;

          // Get the DO ID for RPC callback
          const doId = (
            this as unknown as { ctx: DurableObjectState }
          ).ctx.id.toString();

          // Create workflow to execute task with OpenCode config
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
              // Pass OpenCode config with Anthropic API key
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

          // Create run record with workflow ID
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
            })
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
            })
          );

          return formatToolResponse({
            runId,
            workflowId: workflowInstance.id,
            status: "started",
            webUiUrl: session.value.webUiUrl,
            message: "Task started. Use opencode_get_status to check progress.",
          });
        } catch (error) {
          return formatDomainError(error);
        }
      }
    );
  }

  /**
   * Tool: opencode_get_status
   */
  private registerGetStatusTool(): void {
    this.server.tool(
      "opencode_get_status",
      "Check the status of a session and optionally a specific task run",
      getStatusInputSchema.shape,
      async (params) => {
        try {
          const rt = getRuntime(this.runtime);

          const session = await rt.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(params.sessionId);
            })
          );

          if (session._tag === "None") {
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
            })
          );

          // Get specific run if requested
          let currentRun: RunRecord | undefined;
          if (params.runId) {
            const runId = params.runId;
            const run = await rt.runPromise(
              Effect.gen(function* () {
                const storage = yield* StorageService;
                return yield* storage.getRun(runId);
              })
            );
            if (run._tag === "Some") {
              currentRun = run.value;
            }
          }

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
          return formatDomainError(error);
        }
      }
    );
  }

  /**
   * RPC method called by Workflow when task completes
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
      })
    );
  }
}
