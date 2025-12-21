// src/services/opencode.ts
import { Context, Effect, Layer } from "effect";
import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Sandbox } from "@cloudflare/sandbox";
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
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
}

/**
 * OpenCode server instance
 */
export interface OpenCodeServer {
  url: string;
  client: OpencodeClient;
  close: () => void;
}

/**
 * OpenCode service interface
 */
export interface OpenCodeServiceInterface {
  /**
   * Start OpenCode server in a sandbox
   * This runs the opencode binary inside the sandbox and returns connection info
   */
  readonly startInSandbox: (
    sandbox: Sandbox<unknown>,
    options?: {
      port?: number;
      directory?: string;
    }
  ) => Effect.Effect<
    { port: number; url: string; sessionId: string },
    OpenCodeStartupError
  >;

  /**
   * Execute a task using OpenCode running in a sandbox
   * Connects to the OpenCode server running inside the sandbox
   */
  readonly executeTaskInSandbox: (
    sandbox: Sandbox<unknown>,
    params: {
      sessionId: string;
      task: string;
      model: string;
      opencodeUrl: string;
    }
  ) => Effect.Effect<
    OpenCodeTaskResult,
    OpenCodeExecutionError | OpenCodeTimeoutError
  >;

  /**
   * Start a local OpenCode server (for testing/development)
   */
  readonly startLocal: (options?: {
    port?: number;
    directory?: string;
  }) => Effect.Effect<OpenCodeServer, OpenCodeStartupError>;

  /**
   * Execute a task using local OpenCode client
   */
  readonly executeTask: (
    client: OpencodeClient,
    params: {
      sessionId: string;
      task: string;
      model: string;
    }
  ) => Effect.Effect<
    OpenCodeTaskResult,
    OpenCodeExecutionError | OpenCodeTimeoutError
  >;
}

/**
 * Parse OpenCode response to extract result info
 */
const parseOpenCodeResponse = (response: unknown): OpenCodeTaskResult => {
  // Extract meaningful info from OpenCode response
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
    filesCreated: [], // Would need to parse from response or git status
    filesModified: [],
    commits: [],
    branch: undefined,
  };
};

/**
 * Create OpenCode service
 */
export const makeOpenCodeService = (): OpenCodeServiceInterface => ({
  startInSandbox: (sandbox, options = {}) =>
    Effect.tryPromise({
      try: async () => {
        const port = options.port ?? 4096;
        const directory = options.directory ?? "/workspace";

        // Start opencode server inside the sandbox
        // The opencode binary should be available in the sandbox
        const result = await sandbox.exec(
          `cd ${directory} && opencode serve --port ${port} --json &`
        );

        if (result.exitCode !== 0) {
          throw new Error(`Failed to start opencode: ${result.stderr}`);
        }

        // Wait a bit for the server to start
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Generate a session ID
        const sessionId = `session-${Date.now()}`;

        return {
          port,
          url: `http://localhost:${port}`,
          sessionId,
        };
      },
      catch: (error) =>
        new OpenCodeStartupError({
          cause: String(error),
        }),
    }),

  executeTaskInSandbox: (sandbox, params) =>
    Effect.tryPromise({
      try: async () => {
        // Execute the task by calling the opencode API inside the sandbox
        const curlCmd = `curl -X POST ${params.opencodeUrl}/api/v1/sessions/${params.sessionId}/prompt \
          -H "Content-Type: application/json" \
          -d '${JSON.stringify({
            model: {
              providerID: "anthropic",
              modelID: params.model,
            },
            parts: [{ type: "text", text: params.task }],
          })}'`;

        const result = await sandbox.exec(curlCmd);

        if (result.exitCode !== 0) {
          throw new Error(`OpenCode request failed: ${result.stderr}`);
        }

        const response = JSON.parse(result.stdout);
        return parseOpenCodeResponse(response);
      },
      catch: (error) =>
        new OpenCodeExecutionError({
          sessionId: params.sessionId,
          cause: String(error),
        }),
    }),

  startLocal: (options = {}) =>
    Effect.tryPromise({
      try: async () => {
        const { client, server } = await createOpencode({
          port: options.port ?? 4096,
        });

        return {
          url: server.url,
          client,
          close: server.close,
        };
      },
      catch: (error) =>
        new OpenCodeStartupError({
          cause: String(error),
        }),
    }),

  executeTask: (client, params) =>
    Effect.gen(function* () {
      // Create or get session
      const sessionData = yield* Effect.tryPromise({
        try: async () => {
          try {
            const existing = await client.session.get({
              path: { id: params.sessionId },
            });
            return existing as { data: { id: string } };
          } catch {
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

      return parseOpenCodeResponse(response);
    }),
});

/**
 * OpenCode service context tag
 */
export class OpenCodeService extends Context.Tag("@sandbox-mcp/OpenCodeService")<
  OpenCodeService,
  OpenCodeServiceInterface
>() {}

/**
 * OpenCode service layer
 */
export const OpenCodeServiceLive: Layer.Layer<OpenCodeService> = Layer.succeed(
  OpenCodeService,
  makeOpenCodeService()
);
