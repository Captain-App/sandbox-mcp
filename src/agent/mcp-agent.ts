// src/agent/mcp-agent.ts
import type { Connection, ConnectionContext } from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Sentry from "@sentry/cloudflare";

import {
  isRunStorageError,
  isSessionError,
  isSessionStorageError,
  RunNotFoundError,
  SessionNotFoundError,
  DEFAULT_MODEL,
  SessionId,
  type SessionMetadata,
  withRequestContext,
  withSentry,
  LoggerLayer,
  captureEffectError,
} from "@shipbox/shared";
import { pipe } from "effect";
import { createProxyToken } from "../proxy";
import { makeRunStorageLayer, RunStorage } from "../services/run";
import { makeSessionStorageLayer, SessionStorage } from "../services/session";
import { ToolCallEventBuilder } from "../services/telemetry";
import { Miniflare, Deploy, Sandbox as SandboxHelper } from "../workflows/helpers";
import {
  formatErrorResponse,
  formatToolResponse,
  getResultInputSchema,
  listRunsInputSchema,
  previewWorkerInputSchema,
  deployWorkerInputSchema,
  runTaskInputSchema,
  type GetResultInput,
  type ListRunsInput,
  type PreviewWorkerInput,
  type DeployWorkerInput,
  type RunTaskInput,
} from "./tools";

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
 * Combined service type for the MCP Agent runtime
 * - SessionStorage: R2 for sessions (persistent, cross-DO)
 * - RunStorage: R2 for runs (persistent, cross-DO)
 */
type AgentServices = SessionStorage | RunStorage;

/**
 * Get the runtime, throwing if not initialized
 */
function getRuntime(
  runtime: ManagedRuntime.ManagedRuntime<AgentServices, never> | null,
): ManagedRuntime.ManagedRuntime<AgentServices, never> {
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
  if (isSessionStorageError(error)) {
    return formatErrorResponse({
      code: error._tag,
      message: error.message,
    });
  }
  if (isRunStorageError(error)) {
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
 *
 * Storage architecture:
 * - Sessions: Stored in R2 (shared across all DO instances)
 * - Runs: Stored in R2 (shared across all DO instances)
 *
 * Both sessions and runs are stored in R2 so they can be accessed from any
 * DO instance, solving the cross-DO access problem inherent in the MCP
 * library's per-connection DO model.
 */
export class OpenCodeMcpAgent extends McpAgent<Env, AgentState> {
  // Use type assertion to handle version mismatch between @modelcontextprotocol/sdk versions
  server = new McpServer({
    name: "opencode-sandbox",
    version: "1.0.0",
  }) as any;

  /** @public Required by McpAgent base class */
  initialState: AgentState = {
    initialized: false,
  };

  private runtime: ManagedRuntime.ManagedRuntime<AgentServices, never> | null = null;

  /**
   * Get the R2 bucket for storage
   */
  private get sessionsBucket(): R2Bucket {
    return this.env.SESSIONS_BUCKET;
  }

  /**
   * Initialize the MCP server with tools
   * @public Called by McpAgent framework on DO start
   */
  async init(): Promise<void> {
    // Create combined layer with both R2 storage services
    const sessionLayer = makeSessionStorageLayer(this.sessionsBucket);
    const runLayer = makeRunStorageLayer(this.sessionsBucket);
    const combinedLayer = Layer.merge(sessionLayer, runLayer);
    this.runtime = ManagedRuntime.make(combinedLayer);

    // Register MCP tools
    this.registerRunTaskTool();
    this.registerGetResultTool();
    this.registerListRunsTool();
    this.registerPreviewWorkerTool();
    this.registerDeployWorkerTool();

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

  /** Cached base URL, set during onConnect */
  private baseUrl: string | null = null;

  /** Cached user ID, set during onConnect from X-User-Id header */
  private userId: string | null = null;

  /** Cached request ID, set during onConnect from X-Request-Id header */
  private requestId: string | null = null;

  /**
   * Called when a client connects. We capture the base URL and user ID
   * from the request so we can use it later in tool handlers.
   */
  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    // Extract and cache the base URL from the connection request
    // Use engine URL if we're being called via:
    // - Service binding (hostname is "sandbox")
    // - Internal workers URL
    // - API proxy (backend.shipbox.dev) - needs engine URL for proxy routes
    const url = new URL(ctx.request.url);
    const needsEngineUrl =
      url.hostname === "sandbox" ||
      url.hostname.includes("workers.internal") ||
      url.hostname === "localhost" ||
      url.hostname === "backend.shipbox.dev";
    this.baseUrl = needsEngineUrl ? "https://engine.shipbox.dev" : `${url.protocol}//${url.host}`;

    // Extract user ID from header injected by shipbox-api
    this.userId = ctx.request.headers.get("X-User-Id");

    // Extract request ID from header injected by shipbox-api
    this.requestId = ctx.request.headers.get("X-Request-Id");

    // Set Sentry context
    if (this.userId) {
      Sentry.setUser({ id: this.userId });
      Sentry.setTag("userId", this.userId);
    }
    if (this.requestId) {
      Sentry.setTag("requestId", this.requestId);
    }

    Sentry.addBreadcrumb({
      category: "mcp",
      message: `Client connected: ${this.userId}`,
      level: "info",
    });

    // Call parent implementation
    return super.onConnect(connection, ctx);
  }

  /**
   * Get the request ID for this connection.
   */
  private getRequestId(): string {
    return this.requestId || "unknown";
  }

  /**
   * Get the base URL for this worker.
   */
  private getBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error("Base URL not available - onConnect must be called first");
    }
    return this.baseUrl;
  }

  /**
   * Get the user ID for this connection.
   */
  private getUserId(): string {
    if (!this.userId) {
      // In development/local without proxy, default to "unknown"
      return "unknown";
    }
    return this.userId;
  }

  /**
   * Build the absolute web UI URL for a session.
   */
  private getWebUiUrl(sessionId: string): string {
    return `${this.getBaseUrl()}/session/${sessionId}/`;
  }

  /**
   * Tool: opencode_run_task
   * Execute a coding task. Creates session if needed, or continues existing session.
   *
   * Note: This tool only creates the session and workflow. The workflow itself
   * creates the run record in R2 (in the "create-run" step).
   */
  private registerRunTaskTool(): void {
    this.server.registerTool(
      "opencode_run_task",
      {
        description:
          "Execute a coding task in a sandbox. Creates session if needed, or continues existing session. Returns immediately with status 'started'. IMPORTANT: (1) Share the webUiUrl with the user for real-time progress tracking. (2) Poll opencode_get_result every 10-30 seconds using the returned runId until status is 'completed' or 'failed' to get the final result.",
        inputSchema: runTaskInputSchema,
      },
      async (params: RunTaskInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_run_task", this.getRequestId());
        telemetry.startPhase("validate");

        Sentry.addBreadcrumb({
          category: "tool",
          message: `opencode_run_task: ${params.sessionId || "new"}`,
          data: { sessionId: params.sessionId, model: params.model },
        });

        try {
          const rt = getRuntime(this.runtime);
          let session: SessionMetadata;
          let isNewSession = false;

          // 1. Resolve or create session (from R2)
          if (params.sessionId) {
            // Continue existing session
            telemetry.endPhase("validate");
            telemetry.startPhase("storage");

            const existing = await rt.runPromiseExit(
              pipe(
                Effect.gen(function* () {
                  const sessionStorage = yield* SessionStorage;
                  return yield* sessionStorage.getSession(params.sessionId as string);
                }),
                withRequestContext(this.getRequestId(), this.userId || undefined, params.sessionId),
                withSentry(Sentry as any),
                Effect.provide(LoggerLayer),
              ),
            );

            if (existing._tag === "Failure") {
              captureEffectError(existing.cause, Sentry as any, {
                sessionId: params.sessionId,
                tool: "opencode_run_task",
              });
              const error = formatDomainError(existing.cause);
              this.emitToolTelemetry(telemetry, false);
              return error;
            }

            if (existing.value._tag === "None") {
              const error = new SessionNotFoundError({ sessionId: params.sessionId });
              telemetry.setError({
                type: error._tag,
                code: error._tag,
                message: error.message,
                retriable: false,
              });
              this.emitToolTelemetry(telemetry, false);
              return formatDomainError(error);
            }
            session = existing.value.value;
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
              userId: this.getUserId(), // Capture userId in session
              repository: params.repository
                ? {
                    url: params.repository,
                    branch: params.branch ?? "main",
                  }
                : undefined,
              clonedRepos: params.repository ? [params.repository] : [],
              config: {
                defaultModel: DEFAULT_MODEL,
              },
            };

            telemetry.endPhase("validate");
            telemetry.startPhase("storage");

            // Save new session to R2
            const result = await rt.runPromiseExit(
              pipe(
                Effect.gen(function* () {
                  const sessionStorage = yield* SessionStorage;
                  yield* sessionStorage.putSession(session);
                }),
                withRequestContext(this.getRequestId(), this.userId || undefined, sessionId),
                withSentry(Sentry as any),
                Effect.provide(LoggerLayer),
              ),
            );

            if (result._tag === "Failure") {
              captureEffectError(result.cause, Sentry as any, {
                sessionId,
                userId: session.userId,
                tool: "opencode_run_task",
              });
            }
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

          // 3. Generate run ID and create proxy token
          const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
          const model = params.model ?? session.config.defaultModel;

          // Create proxy token for zero-trust authentication
          const proxyToken = await rt.runPromise(
            createProxyToken({
              secret: this.env.PROXY_JWT_SECRET,
              sandboxId: session.sandboxId,
              userId: session.userId || this.getUserId(),
              sessionId: session.sessionId,
              expiresIn: "2h",
            }),
          );

          telemetry.endPhase("token");
          telemetry.startPhase("workflow");

          // 4. Create workflow to execute task
          // Note: The workflow creates the run record in R2 (not us)
          const workflowInstance = await this.env.EXECUTE_TASK_WORKFLOW.create({
            id: runId,
            params: {
              sessionId: session.sessionId,
              sandboxId: session.sandboxId,
              task: params.task,
              model,
              runId,
              title: params.title ?? "Processing...",
              repositoryUrl: needsClone ? params.repository : session.repository?.url,
              branch: params.branch ?? session.repository?.branch,
              existingOpencodeSessionId: session.opencodeSessionId,
              proxyToken,
              proxyBaseUrl: this.getBaseUrl(),
              userId: this.getUserId(),
              requestId: this.getRequestId(),
            },
          });

          telemetry.endPhase("workflow");
          telemetry.startPhase("storage");

          // 5. Update session last activity in R2
          const updatedSession = {
            ...session,
            lastActivity: Date.now(),
            status: "active" as const,
          };
          await rt.runPromise(
            Effect.gen(function* () {
              const sessionStorage = yield* SessionStorage;
              yield* sessionStorage.putSession(updatedSession);
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
          Sentry.captureException(error, {
            extra: { params, tool: "opencode_run_task" },
          });
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
        description:
          "Get the status and result of a specific task run. Use this to poll for completion after calling opencode_run_task. Poll every 10-30 seconds until status is 'completed' or 'failed'. Status values: 'started' (just queued), 'running' (in progress), 'completed' (success), 'failed' (error).",
        inputSchema: getResultInputSchema,
      },
      async (params: GetResultInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_get_result", this.getRequestId());
        telemetry.startPhase("storage");

        try {
          const rt = getRuntime(this.runtime);

          // Get run from R2 (no sessionId needed - flat global index)
          const run = await rt.runPromise(
            Effect.gen(function* () {
              const runStorage = yield* RunStorage;
              return yield* runStorage.getRun(params.runId);
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

          // Get session for webUiUrl from R2 (using sessionId from the run)
          const session = await rt.runPromise(
            Effect.gen(function* () {
              const sessionStorage = yield* SessionStorage;
              return yield* sessionStorage.getSession(run.value.sessionId);
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
          Sentry.captureException(error, {
            extra: { params, tool: "opencode_get_result" },
          });
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
   * List past task runs with optional filters.
   */
  private registerListRunsTool(): void {
    this.server.registerTool(
      "opencode_list_runs",
      {
        description:
          "List past task runs with pagination support. Filter by session, status, or time. Use to: (1) Resume work from previous sessions, (2) Check history of completed tasks, (3) Find sessionId for continuing work. Returns most recent runs first.",
        inputSchema: listRunsInputSchema,
      },
      async (params: ListRunsInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_list_runs", this.getRequestId());
        telemetry.startPhase("storage");

        try {
          const rt = getRuntime(this.runtime);
          const limit = params.limit ?? 10;

          // Get runs from R2 with optional filters
          const result = await rt.runPromise(
            Effect.gen(function* () {
              const runStorage = yield* RunStorage;
              return yield* runStorage.listRuns({
                sessionId: params.sessionId,
                status: params.status,
                before: params.before,
                limit: limit + 1, // Fetch one extra to check hasMore
              });
            }),
          );

          const hasMore = result.runs.length > limit;
          const returnRuns = hasMore ? result.runs.slice(0, limit) : result.runs;

          telemetry.endPhase("storage");
          telemetry.setMetadata({ runsCount: returnRuns.length, hasMore });
          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            runs: returnRuns.map((r) => ({
              runId: r.runId,
              sessionId: r.sessionId, // Now from the run entry itself
              status: r.status,
              title: r.title,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
            })),
            hasMore,
          });
        } catch (error) {
          Sentry.captureException(error, {
            extra: { params, tool: "opencode_list_runs" },
          });
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
   * Tool: opencode_preview_worker
   * Start miniflare inside the sandbox to preview a worker.
   */
  private registerPreviewWorkerTool(): void {
    this.server.registerTool(
      "opencode_preview_worker",
      {
        description:
          "Start a miniflare development server inside the sandbox to preview a worker. Returns a preview URL that can be used to test the worker in real-time.",
        inputSchema: previewWorkerInputSchema,
      },
      async (params: PreviewWorkerInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_preview_worker", this.getRequestId());
        telemetry.startPhase("validate");

        if (!params.sessionId) {
          return formatErrorResponse({
            code: "MISSING_SESSION_ID",
            message: "sessionId is required for preview_worker.",
          });
        }

        try {
          const rt = getRuntime(this.runtime);

          // 1. Get session to verify it exists
          const sessionResult = await rt.runPromiseExit(
            pipe(
              Effect.gen(function* () {
                const sessionStorage = yield* SessionStorage;
                return yield* sessionStorage.getSession(params.sessionId!);
              }),
              withRequestContext(this.getRequestId(), this.userId || undefined, params.sessionId),
            ),
          );

          if (sessionResult._tag === "Failure" || sessionResult.value._tag === "None") {
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session ${params.sessionId} not found.`,
            });
          }

          const session = sessionResult.value.value;

          telemetry.endPhase("validate");
          telemetry.startPhase("sandbox");

          // 2. Get sandbox and start miniflare
          const sandbox = SandboxHelper.getSandbox(
            { sandboxBinding: this.env.Sandbox, sessionsBucket: this.env.SESSIONS_BUCKET },
            session.sandboxId,
          );

          const port = params.port ?? 8787;
          const result = await Miniflare.startMiniflare(sandbox, params.workerPath, port);

          telemetry.endPhase("sandbox");

          // Check if miniflare failed to start
          if (!result.success) {
            telemetry.setError({
              type: "MiniflareStartupError",
              code: "MINIFLARE_STARTUP_FAILED",
              message: result.error || "Miniflare failed to start",
              retriable: true,
            });
            this.emitToolTelemetry(telemetry, false);
            return formatToolResponse({
              success: false,
              error: result.error || "Miniflare failed to start",
              logPath: result.logPath,
            });
          }

          const previewUrl = `${this.getBaseUrl()}/preview/${session.sessionId}${
            port === 8787 ? "" : `:${port}`
          }/`;

          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            success: result.success,
            previewUrl,
            port: result.port,
            logPath: result.logPath,
          });
        } catch (error) {
          Sentry.captureException(error, {
            extra: { params, tool: "opencode_preview_worker" },
          });
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
   * Tool: opencode_deploy_worker
   * Bundle and deploy a worker to Workers for Platforms.
   */
  private registerDeployWorkerTool(): void {
    this.server.registerTool(
      "opencode_deploy_worker",
      {
        description:
          "Bundle and deploy a worker to the production preview environment (Workers for Platforms). Returns the production URL for the deployed worker.",
        inputSchema: deployWorkerInputSchema,
      },
      async (params: DeployWorkerInput) => {
        const telemetry = new ToolCallEventBuilder("opencode_deploy_worker", this.getRequestId());
        telemetry.startPhase("validate");

        if (!params.sessionId) {
          return formatErrorResponse({
            code: "MISSING_SESSION_ID",
            message: "sessionId is required for deploy_worker.",
          });
        }

        try {
          const rt = getRuntime(this.runtime);

          // 1. Get session to verify it exists
          const sessionResult = await rt.runPromiseExit(
            pipe(
              Effect.gen(function* () {
                const sessionStorage = yield* SessionStorage;
                return yield* sessionStorage.getSession(params.sessionId!);
              }),
              withRequestContext(this.getRequestId(), this.userId || undefined, params.sessionId),
            ),
          );

          if (sessionResult._tag === "Failure" || sessionResult.value._tag === "None") {
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session ${params.sessionId} not found.`,
            });
          }

          const session = sessionResult.value.value;

          telemetry.endPhase("validate");
          telemetry.startPhase("deploy");

          // 2. Get sandbox and deploy
          const sandbox = SandboxHelper.getSandbox(
            { sandboxBinding: this.env.Sandbox, sessionsBucket: this.env.SESSIONS_BUCKET },
            session.sandboxId,
          );

          // Get proxy token for sandbox-to-engine API calls if needed
          const proxyToken = await rt.runPromise(
            createProxyToken({
              secret: this.env.PROXY_JWT_SECRET,
              sandboxId: session.sandboxId,
              userId: session.userId || this.getUserId(),
              sessionId: session.sessionId,
              expiresIn: "1h",
            }),
          );

          const result = await Deploy.deployWorker({
            sandbox,
            sessionId: session.sessionId,
            workerPath: params.workerPath,
            name: params.name,
            accountId: (this.env as any).CLOUDFLARE_ACCOUNT_ID,
            apiToken: (this.env as any).CLOUDFLARE_API_TOKEN,
            dispatchNamespace:
              (this.env as any).CLOUDFLARE_DISPATCH_NAMESPACE || "sandbox-preview-workers",
            proxyBaseUrl: this.getBaseUrl(),
            proxyToken,
          });

          telemetry.endPhase("deploy");

          if (!result.success) {
            this.emitToolTelemetry(telemetry, false);
            return formatErrorResponse({
              code: "DEPLOYMENT_FAILED",
              message: result.error || "Unknown deployment error",
            });
          }

          this.emitToolTelemetry(telemetry, true);

          return formatToolResponse({
            success: true,
            workerName: result.workerName,
            url: result.url,
          });
        } catch (error) {
          Sentry.captureException(error, {
            extra: { params, tool: "opencode_deploy_worker" },
          });
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
}
