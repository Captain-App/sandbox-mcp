// src/services/opencode.ts
import { Context, Effect, Layer } from "effect";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
  type OpencodeServer,
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Config } from "@opencode-ai/sdk";
import {
  OpenCodeStartupError,
  OpenCodeExecutionError,
  OpenCodeTimeoutError,
} from "../models/errors";

/**
 * OpenCode task execution result
 */
export interface OpenCodeTaskResult {
  success: boolean;
  output: string;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
}

/**
 * OpenCode instance running in a sandbox
 */
export interface OpenCodeInstance {
  client: OpencodeClient;
  server: OpencodeServer;
}

/**
 * Options for starting OpenCode in a sandbox
 */
export interface OpenCodeOptions {
  /** Port to run the server on (default: 4096) */
  port?: number;
  /** Working directory for OpenCode (default: /workspace) */
  directory?: string;
  /** OpenCode configuration including provider API keys */
  config?: Config;
}

/**
 * OpenCode service interface - runs OpenCode inside Cloudflare Sandboxes
 */
export interface OpenCodeServiceInterface {
  /**
   * Start OpenCode server in a sandbox and get a typed SDK client.
   * The client routes all requests through the sandbox container.
   */
  readonly startOpencode: (
    sandbox: Sandbox<unknown>,
    options?: OpenCodeOptions
  ) => Effect.Effect<OpenCodeInstance, OpenCodeStartupError>;

  /**
   * Start OpenCode server only (without SDK client).
   * Use this if you only need to proxy web UI requests.
   */
  readonly startServer: (
    sandbox: Sandbox<unknown>,
    options?: OpenCodeOptions
  ) => Effect.Effect<OpencodeServer, OpenCodeStartupError>;

  /**
   * Execute a task using OpenCode running in a sandbox.
   * Creates or reuses a session and sends the prompt.
   */
  readonly executeTask: (
    instance: OpenCodeInstance,
    params: {
      sessionId: string;
      task: string;
      model: string;
    }
  ) => Effect.Effect<
    OpenCodeTaskResult,
    OpenCodeExecutionError | OpenCodeTimeoutError
  >;

  /**
   * Proxy an HTTP request to the OpenCode web UI.
   * Handles the ?url= parameter required for OpenCode's frontend.
   */
  readonly proxyWebUI: (
    request: Request,
    sandbox: Sandbox<unknown>,
    server: OpencodeServer
  ) => Effect.Effect<Response, OpenCodeExecutionError>;
}

/**
 * Create OpenCode service
 */
export const makeOpenCodeService = (): OpenCodeServiceInterface => ({
  startOpencode: (sandbox, options = {}) =>
    Effect.tryPromise({
      try: async () => {
        const { client, server } = await createOpencode<OpencodeClient>(
          sandbox,
          {
            port: options.port ?? 4096,
            directory: options.directory ?? "/workspace",
            config: options.config,
          }
        );

        return { client, server };
      },
      catch: (error) =>
        new OpenCodeStartupError({
          cause: String(error),
        }),
    }),

  startServer: (sandbox, options = {}) =>
    Effect.tryPromise({
      try: async () => {
        return await createOpencodeServer(sandbox, {
          port: options.port ?? 4096,
          directory: options.directory ?? "/workspace",
          config: options.config,
        });
      },
      catch: (error) =>
        new OpenCodeStartupError({
          cause: String(error),
        }),
    }),

  executeTask: (instance, params) =>
    Effect.gen(function* () {
      const { client } = instance;

      // Create or get session
      const sessionData = yield* Effect.tryPromise({
        try: async () => {
          try {
            // Try to get existing session
            const existing = await client.session.get({
              path: { id: params.sessionId },
            });
            return existing as { data: { id: string } };
          } catch {
            // Create new session if doesn't exist
            const created = await client.session.create({
              body: { title: `Task: ${params.task.slice(0, 50)}` },
            });
            return created as { data: { id: string } };
          }
        },
        catch: (error) =>
          new OpenCodeExecutionError({
            sessionId: params.sessionId,
            cause: `Failed to create/get session: ${error}`,
          }),
      });

      // Execute task with timeout
      const response = yield* Effect.tryPromise({
        try: () =>
          client.session.prompt({
            path: { id: sessionData.data.id },
            body: {
              model: {
                providerID: "anthropic",
                modelID: params.model,
              },
              parts: [
                {
                  type: "text",
                  text: params.task,
                },
              ],
            },
          }),
        catch: (error) =>
          new OpenCodeExecutionError({
            sessionId: params.sessionId,
            cause: String(error),
          }),
      }).pipe(
        Effect.timeout("50 minutes"),
        Effect.catchTag("TimeoutException", () =>
          Effect.fail(
            new OpenCodeTimeoutError({
              sessionId: params.sessionId,
              timeoutMinutes: 50,
            })
          )
        )
      );

      // Parse response
      return parseOpenCodeResponse(response);
    }),

  proxyWebUI: (request, sandbox, server) =>
    Effect.tryPromise({
      try: async () => {
        const result = proxyToOpencode(request, sandbox, server);
        // proxyToOpencode can return Response or Promise<Response>
        return result instanceof Promise ? await result : result;
      },
      catch: (error) =>
        new OpenCodeExecutionError({
          sessionId: "webui",
          cause: `Failed to proxy request: ${error}`,
        }),
    }),
});

/**
 * Parse OpenCode response to extract result info
 */
function parseOpenCodeResponse(response: unknown): OpenCodeTaskResult {
  const data = response as {
    data?: {
      parts?: Array<{ type: string; text?: string }>;
    };
  };

  const textParts =
    data?.data?.parts
      ?.filter((p) => p.type === "text")
      ?.map((p) => p.text ?? "") ?? [];

  return {
    success: true,
    output: textParts.join("\n"),
    filesCreated: [],
    filesModified: [],
    commits: [],
    branch: undefined,
  };
}

/**
 * OpenCode service context tag
 */
export class OpenCodeService extends Context.Tag(
  "@sandbox-mcp/OpenCodeService"
)<OpenCodeService, OpenCodeServiceInterface>() {}

/**
 * OpenCode service layer
 */
export const OpenCodeServiceLive: Layer.Layer<OpenCodeService> = Layer.succeed(
  OpenCodeService,
  makeOpenCodeService()
);
