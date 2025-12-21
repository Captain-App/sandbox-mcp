// src/workflows/helpers/opencode.ts
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Sandbox } from "@cloudflare/sandbox";
import type {
  TaskParams,
  OpenCodeTaskResult,
  OpenCodeSessionListResponse,
  OpenCodeSessionCreateResponse,
  OpenCodePromptResponse,
} from "./types";

/**
 * Execute an OpenCode task inside the sandbox.
 * Starts OpenCode server, creates/gets session, executes task.
 */
export async function executeTask(
  sandbox: Sandbox<unknown>,
  params: TaskParams
): Promise<OpenCodeTaskResult> {
  // Start OpenCode server in the sandbox and get SDK client
  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    port: 4096,
    directory: "/workspace",
    config: params.opencodeConfig,
  });

  try {
    // Get or create OpenCode session
    let opencodeSessionId: string;

    // Try to list existing sessions with proper directory context
    const existingSessions = (await client.session.list({
      query: { directory: "/workspace" },
    })) as OpenCodeSessionListResponse;

    if (existingSessions.data && existingSessions.data.length > 0) {
      // Use the first existing session
      opencodeSessionId = existingSessions.data[0].id;
    } else {
      // Create a new session with directory context
      const created = (await client.session.create({
        body: { title: `Session: ${params.sessionId}` },
        query: { directory: "/workspace" },
      })) as OpenCodeSessionCreateResponse;

      if (!created.data?.id) {
        throw new Error("Failed to create OpenCode session: no ID returned");
      }
      opencodeSessionId = created.data.id;
    }

    // Execute the task with proper directory context
    const response = (await client.session.prompt({
      path: { id: opencodeSessionId },
      query: { directory: "/workspace" },
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
    })) as OpenCodePromptResponse;

    // Extract text from response
    const textParts =
      response?.data?.parts
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
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
      filesCreated: [],
      filesModified: [],
      commits: [],
    };
  } finally {
    // Always close the server
    await server.close();
  }
}
