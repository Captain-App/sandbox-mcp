// src/workflows/helpers/opencode.ts
import type { Sandbox } from "@cloudflare/sandbox";
import { createOpencode, type OpencodeServer } from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";

/**
 * Forward an event to the RealtimeChannel DO
 */
async function publishToRealtime(proxyBaseUrl: string, sessionId: string, type: string, data: any) {
  try {
    const url = `${proxyBaseUrl}/internal/realtime/${sessionId}/publish`;
    console.log(`[Realtime] Publishing event type=${type} to ${url}`);
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ type, data }),
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.error(`[Realtime] Publish failed: ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error(`[Realtime] Failed to publish event for ${sessionId}:`, e);
  }
}

import { toContainerUrl } from "../../proxy";
import type {
  OpenCodePart,
  OpenCodePromptResponse,
  OpenCodeSessionCreateResponse,
  OpenCodeSessionGetResponse,
  OpenCodeSessionListResponse,
  OpenCodeTaskResult,
  TaskParams,
} from "./types";

// Diagnostic logging helper
function log(phase: string, message: string, data?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level: "info",
      type: "opencode.diagnostic",
      phase,
      message,
      ...data,
      timestamp: new Date().toISOString(),
    }),
  );
}

function logError(phase: string, message: string, error: unknown, data?: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      type: "opencode.diagnostic",
      phase,
      message,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      ...data,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Extract text output from OpenCode response parts.
 * We now use unstructured output - the AI's natural language response.
 */
function extractTextOutput(parts: OpenCodePart[]): string {
  const textParts: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    }
  }

  return textParts.join("\n\n");
}

/**
 * Enhance task description with output instructions.
 * This ensures the AI provides useful information in its response.
 */
function enhanceTask(task: string): string {
  return `${task}

## IMPORTANT: Maintain a PLAN.md

Throughout your work, maintain a file called \`PLAN.md\` in the workspace root.
Update it as you work to reflect:
- Current objective
- Steps completed (with checkmarks)
- Current step in progress
- Next steps planned
- Any blockers or decisions needed

Example format:
\`\`\`markdown
# Plan

## Objective
Build a landing page with hero section

## Progress
- [x] Created project structure
- [x] Added Tailwind CSS
- [ ] **Building hero component** <- current
- [ ] Add feature cards
- [ ] Deploy to preview

## Notes
Using React + Vite for fast iteration
\`\`\`

Update PLAN.md frequently so users can follow your progress in real-time.

When you're done, please summarize:
- What you accomplished
- Files created, modified, or deleted
- Any commits made (with commit hashes and which repos)
- Any issues or warnings`;
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
 * Result of executeTask including the OpenCode session ID for continuation
 */
interface ExecuteTaskResult {
  result: OpenCodeTaskResult;
  opencodeSessionId: string;
}

/**
 * Execute an OpenCode task inside the sandbox.
 *
 * Starts OpenCode server with proxy configuration, creates/gets session,
 * and executes the task. All API calls go through the proxy.
 *
 * IMPORTANT: The server is NOT closed after task execution. This is intentional
 * because OpenCode tracks shell command processes internally, and closing the
 * server would orphan those processes and cause CommandNotFoundError.
 * The server will be reused on subsequent calls (SDK handles this).
 *
 * @param sandbox - The sandbox instance
 * @param params - Task parameters (including optional existingOpencodeSessionId)
 * @param workingDirectory - The directory to run OpenCode in (e.g., /workspace/repo)
 * @returns The task result and OpenCode session ID for continuation
 */
export async function executeTask(
  sandbox: Sandbox<unknown>,
  params: TaskParams,
  workingDirectory: string,
): Promise<ExecuteTaskResult> {
  const taskId = crypto.randomUUID().slice(0, 8);
  log("executeTask.start", "Starting OpenCode task execution", {
    taskId,
    sessionId: params.sessionId,
    sandboxId: params.sandboxId,
    workingDirectory,
    existingOpencodeSessionId: params.existingOpencodeSessionId,
    model: params.model,
  });

  // Build proxy-based config
  const config = buildProxyConfig(params.proxyBaseUrl, params.proxyToken);
  log("executeTask.config", "Built proxy config", {
    taskId,
    proxyBaseUrl: params.proxyBaseUrl,
    containerProxyUrl: toContainerUrl(params.proxyBaseUrl),
  });

  let server: OpencodeServer | null = null;
  let client: OpencodeClient | null = null;

  try {
    // Start OpenCode server in the sandbox and get SDK client
    log("executeTask.createOpencode", "Creating OpenCode server and client", {
      taskId,
    });
    const result = await createOpencode<OpencodeClient>(sandbox, {
      port: 4096,
      directory: workingDirectory,
      config,
    });
    server = result.server;
    client = result.client;

    log("executeTask.serverReady", "OpenCode server ready", {
      taskId,
      serverPort: server.port,
      serverUrl: server.url,
    });

    let opencodeSessionId: string;

    // Check if we should continue an existing OpenCode session
    if (params.existingOpencodeSessionId) {
      // Use the existing session for continuation
      opencodeSessionId = params.existingOpencodeSessionId;
      log("executeTask.reuseSession", "Using existing OpenCode session", {
        taskId,
        opencodeSessionId,
      });
    } else {
      // Try to list existing sessions with proper directory context
      log("executeTask.listSessions", "Listing existing sessions", {
        taskId,
        workingDirectory,
      });
      const existingSessions = (await client.session.list({
        query: { directory: workingDirectory },
      })) as OpenCodeSessionListResponse;

      log("executeTask.listSessionsResult", "Listed sessions", {
        taskId,
        sessionCount: existingSessions.data?.length ?? 0,
        sessionIds: existingSessions.data?.map((s) => s.id),
      });

      if (existingSessions.data && existingSessions.data.length > 0) {
        // Use the first existing session
        opencodeSessionId = existingSessions.data[0].id;
        log("executeTask.useExisting", "Using first existing session", {
          taskId,
          opencodeSessionId,
        });
      } else {
        // Create a new session with directory context (no title - let OpenCode auto-generate)
        log("executeTask.createSession", "Creating new session", {
          taskId,
          workingDirectory,
        });
        const created = (await client.session.create({
          query: { directory: workingDirectory },
        })) as OpenCodeSessionCreateResponse;

        if (!created.data?.id) {
          const error = new Error("Failed to create OpenCode session: no ID returned");
          logError("executeTask.createSessionFailed", "No session ID in response", error, {
            taskId,
            response: created,
          });
          throw error;
        }
        opencodeSessionId = created.data.id;
        log("executeTask.sessionCreated", "New session created", {
          taskId,
          opencodeSessionId,
        });
      }
    }

    // NOTE: SSE event streaming via client.global.event() doesn't work because
    // sandbox.containerFetch doesn't properly support streaming responses.
    // Instead, we publish discrete events at key moments (start, completion).
    // See: https://github.com/cloudflare/sandbox/issues/XXX

    // Publish task started event
    await publishToRealtime(params.proxyBaseUrl, params.sessionId, "task.started", {
      taskId,
      runId: params.runId,
      opencodeSessionId,
      model: params.model,
      timestamp: new Date().toISOString(),
    });

    // Execute the task with enhanced prompt for better output
    const enhancedTask = enhanceTask(params.task);
    log("executeTask.prompt", "Sending prompt to OpenCode", {
      taskId,
      opencodeSessionId,
      model: params.model,
      taskLength: params.task.length,
      enhancedTaskLength: enhancedTask.length,
    });

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
            text: enhancedTask,
          },
        ],
      },
    })) as OpenCodePromptResponse;

    log("executeTask.promptComplete", "Received response from OpenCode", {
      taskId,
      opencodeSessionId,
      hasData: !!response?.data,
      partsCount: response?.data?.parts?.length ?? 0,
      tokens: response?.data?.info?.tokens,
      finish: response?.data?.info?.finish,
      hasError: !!response?.data?.info?.error,
    });

    // Extract text output from response
    const output = extractTextOutput(response?.data?.parts ?? []);

    // Check for errors in the response
    if (response?.data?.info?.error) {
      const errorInfo = response.data.info.error;
      logError("executeTask.promptError", "OpenCode returned error in response", errorInfo, {
        taskId,
        opencodeSessionId,
        errorName: errorInfo.name,
        errorMessage: errorInfo.data.message,
      });
      // Publish task failed event
      await publishToRealtime(params.proxyBaseUrl, params.sessionId, "task.failed", {
        taskId,
        runId: params.runId,
        opencodeSessionId,
        error: errorInfo.data.message,
        tokens: response.data.info.tokens,
        timestamp: new Date().toISOString(),
      });
      return {
        result: {
          success: false,
          output,
          error: errorInfo.data.message,
          tokens: response.data.info.tokens,
        },
        opencodeSessionId,
      };
    }

    log("executeTask.success", "Task completed successfully", {
      taskId,
      opencodeSessionId,
      outputLength: output.length,
      tokens: response?.data?.info?.tokens,
    });

    // Publish task completed event
    await publishToRealtime(params.proxyBaseUrl, params.sessionId, "task.completed", {
      taskId,
      runId: params.runId,
      opencodeSessionId,
      success: true,
      outputPreview: output.slice(0, 500), // First 500 chars as preview
      tokens: response?.data?.info?.tokens,
      timestamp: new Date().toISOString(),
    });

    return {
      result: {
        success: true,
        output,
        tokens: response?.data?.info?.tokens,
      },
      opencodeSessionId,
    };
  } catch (error) {
    logError("executeTask.error", "Task execution failed", error, {
      taskId,
      existingOpencodeSessionId: params.existingOpencodeSessionId,
    });

    // Publish task failed event (best effort - may fail if proxy is unreachable)
    try {
      await publishToRealtime(params.proxyBaseUrl, params.sessionId, "task.failed", {
        taskId,
        runId: params.runId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    } catch (publishError) {
      logError("executeTask.publishError", "Failed to publish error event", publishError, {
        taskId,
      });
    }

    // Return a failed result but still need to return some session ID
    // In case of error, we may not have a valid session ID
    return {
      result: {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      },
      opencodeSessionId: params.existingOpencodeSessionId ?? "unknown",
    };
  }
  // NOTE: We intentionally do NOT close the server here.
  // The OpenCode server tracks shell command processes internally.
  // Closing the server would orphan those processes and cause CommandNotFoundError.
  // The SDK's ensureOpencodeServer() reuses existing servers on the same port.
}

/**
 * Get the title of an OpenCode session.
 * OpenCode auto-generates titles based on the conversation.
 *
 * IMPORTANT: The server is NOT closed after getting the title. This is intentional
 * to maintain process tracking consistency with executeTask().
 *
 * @param sandbox - The sandbox instance
 * @param opencodeSessionId - The OpenCode session ID
 * @param proxyBaseUrl - Base URL of the proxy
 * @param proxyToken - JWT proxy token
 * @param workingDirectory - The directory to run OpenCode in
 * @returns The session title or "Untitled" if not available
 */
export async function getSessionTitle(
  sandbox: Sandbox<unknown>,
  opencodeSessionId: string,
  proxyBaseUrl: string,
  proxyToken: string,
  workingDirectory: string,
): Promise<string> {
  log("getSessionTitle.start", "Getting session title", {
    opencodeSessionId,
    workingDirectory,
  });

  const config = buildProxyConfig(proxyBaseUrl, proxyToken);

  try {
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      port: 4096,
      directory: workingDirectory,
      config,
    });

    const session = (await client.session.get({
      path: { id: opencodeSessionId },
    })) as OpenCodeSessionGetResponse;

    const title = session.data?.title ?? "Untitled";
    log("getSessionTitle.success", "Got session title", {
      opencodeSessionId,
      title,
    });

    return title;
  } catch (error) {
    logError("getSessionTitle.error", "Failed to get session title", error, {
      opencodeSessionId,
    });
    return "Untitled";
  }
  // NOTE: We intentionally do NOT close the server here.
  // The SDK reuses existing servers on the same port.
}
