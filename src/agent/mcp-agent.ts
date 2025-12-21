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
import type { SessionMetadata } from "../models/session";
import type { RunRecord } from "../models/run";

/**
 * State managed by the MCP Agent
 */
interface AgentState {
  initialized: boolean;
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
          const sessionId =
            params.sessionId ?? crypto.randomUUID().slice(0, 8);

          // Check if session exists (resume)
          const existing = await this.runtime!.runPromise(
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

          // TODO: Create sandbox, mount R2, clone repo, start OpenCode
          // For now, create session metadata only
          const session: SessionMetadata = {
            sessionId,
            sandboxId: sessionId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: "creating",
            workspacePath: "/workspace",
            webUiUrl: `https://${sessionId}.sandbox.example.com`, // Placeholder
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

          await this.runtime!.runPromise(
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
          return formatErrorResponse({
            code: "SESSION_CREATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
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
          // Verify session exists
          const session = await this.runtime!.runPromise(
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

          await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              yield* storage.putRun(run);
            })
          );

          // Update session last activity
          await this.runtime!.runPromise(
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
          return formatErrorResponse({
            code: "TASK_START_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
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
          const session = await this.runtime!.runPromise(
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
          const runs = await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.listRuns(params.sessionId, 10);
            })
          );

          // Get specific run if requested
          let currentRun: RunRecord | undefined;
          if (params.runId) {
            const run = await this.runtime!.runPromise(
              Effect.gen(function* () {
                const storage = yield* StorageService;
                return yield* storage.getRun(params.runId!);
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
          return formatErrorResponse({
            code: "STATUS_CHECK_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
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
    await this.runtime!.runPromise(
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
