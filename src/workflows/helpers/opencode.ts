// src/workflows/helpers/opencode.ts
import type { Sandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";

import { toContainerUrl } from "../../proxy";
import type {
  OpenCodePart,
  OpenCodePromptResponse,
  OpenCodeSessionCreateResponse,
  OpenCodeSessionListResponse,
  OpenCodeTaskResult,
  TaskParams,
} from "./types";

/**
 * Extract meaningful content from OpenCode response parts.
 *
 * Extracts:
 * - Text parts: The AI's explanations and summaries
 * - Tool outputs: Results from bash commands, file reads, etc.
 */
function extractResponseContent(parts: OpenCodePart[]): {
  textOutput: string;
  toolOutputs: Array<{ tool: string; title?: string; output?: string }>;
} {
  const textParts: string[] = [];
  const toolOutputs: Array<{ tool: string; title?: string; output?: string }> = [];

  for (const part of parts) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (part.type === "tool" && part.tool && part.state) {
      // Only include completed tool calls with output
      if (part.state.status === "completed" && part.state.output) {
        toolOutputs.push({
          tool: part.tool,
          title: part.state.title,
          output: part.state.output,
        });
      } else if (part.state.status === "error" && part.state.error) {
        toolOutputs.push({
          tool: part.tool,
          title: part.state.title,
          output: `Error: ${part.state.error}`,
        });
      }
    }
  }

  return {
    textOutput: textParts.join("\n\n"),
    toolOutputs,
  };
}

/**
 * Build OpenCode config that uses the proxy for API calls.
 *
 * The JWT token is passed as the API key, and the baseURL points to our proxy.
 * The proxy validates the JWT and injects the real ANTHROPIC_API_KEY.
 */
function buildProxyConfig(proxyBaseUrl: string, proxyToken: string): Config {
  const containerProxyUrl = toContainerUrl(proxyBaseUrl);
  return {
    provider: {
      anthropic: {
        options: {
          apiKey: proxyToken,
          baseURL: `${containerProxyUrl}/proxy/anthropic`,
        },
      },
    },
  };
}

/**
 * Execute an OpenCode task inside the sandbox.
 *
 * Starts OpenCode server with proxy configuration, creates/gets session,
 * and executes the task. All API calls go through the proxy.
 *
 * @param sandbox - The sandbox instance
 * @param params - Task parameters
 * @param workingDirectory - The directory to run OpenCode in (e.g., /workspace/repo)
 */
export async function executeTask(
  sandbox: Sandbox<unknown>,
  params: TaskParams,
  workingDirectory: string,
): Promise<OpenCodeTaskResult> {
  // Build proxy-based config
  const config = buildProxyConfig(params.proxyBaseUrl, params.proxyToken);

  // Start OpenCode server in the sandbox and get SDK client
  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    port: 4096,
    directory: workingDirectory,
    config,
  });

  try {
    // Get or create OpenCode session
    let opencodeSessionId: string;

    // Try to list existing sessions with proper directory context
    const existingSessions = (await client.session.list({
      query: { directory: workingDirectory },
    })) as OpenCodeSessionListResponse;

    if (existingSessions.data && existingSessions.data.length > 0) {
      // Use the first existing session
      opencodeSessionId = existingSessions.data[0].id;
    } else {
      // Create a new session with directory context
      const created = (await client.session.create({
        body: { title: `Session: ${params.sessionId}` },
        query: { directory: workingDirectory },
      })) as OpenCodeSessionCreateResponse;

      if (!created.data?.id) {
        throw new Error("Failed to create OpenCode session: no ID returned");
      }
      opencodeSessionId = created.data.id;
    }

    // Execute the task with proper directory context
    const response = (await client.session.prompt({
      path: { id: opencodeSessionId },
      query: { directory: workingDirectory },
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

    // Extract meaningful output from response
    const { textOutput, toolOutputs } = extractResponseContent(response?.data?.parts ?? []);

    // Check for errors in the response
    if (response?.data?.info?.error) {
      return {
        success: false,
        output: textOutput,
        toolOutputs,
        error: response.data.info.error.data.message,
        filesCreated: [],
        filesModified: [],
        commits: [],
        tokens: response.data.info.tokens,
      };
    }

    return {
      success: true,
      output: textOutput,
      toolOutputs,
      filesCreated: [],
      filesModified: [],
      commits: [],
      branch: undefined,
      tokens: response?.data?.info?.tokens,
    };
  } catch (error) {
    // Extract detailed error information from various error formats
    let errorMessage = error instanceof Error ? error.message : String(error);

    // Check for SDK-style errors with response data
    if (error && typeof error === "object") {
      const errorObj = error as Record<string, unknown>;

      // SDK errors often have response property
      if ("response" in errorObj && errorObj.response) {
        const response = errorObj.response as Record<string, unknown>;
        if (response.status) {
          errorMessage = `HTTP ${response.status}: ${errorMessage}`;
        }
      }

      // Check for error.data pattern
      if ("data" in errorObj && errorObj.data) {
        const data = errorObj.data as Record<string, unknown>;
        if (data.message) {
          errorMessage = String(data.message);
        }
        if (data.error) {
          errorMessage = String(data.error);
        }
      }

      // Check for error.error pattern (nested)
      if ("error" in errorObj && errorObj.error) {
        const nestedError = errorObj.error as Record<string, unknown>;
        if (nestedError.message) {
          errorMessage = String(nestedError.message);
        }
      }
    }

    console.error("OpenCode task error:", {
      error: errorMessage,
      raw: JSON.stringify(error, null, 2),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      success: false,
      output: "",
      toolOutputs: [],
      error: errorMessage,
      filesCreated: [],
      filesModified: [],
      commits: [],
    };
  } finally {
    // Always close the server
    await server.close();
  }
}
