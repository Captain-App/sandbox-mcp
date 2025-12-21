// src/index.ts
import { OpenCodeMcpAgent } from "./agent/mcp-agent";
import { ExecuteTaskWorkflow } from "./workflows/execute-task";
import { getSandbox } from "@cloudflare/sandbox";
import {
  createOpencodeServer,
  proxyToOpencode,
} from "@cloudflare/sandbox/opencode";
import type { Config } from "@opencode-ai/sdk";

// Export Sandbox class from @cloudflare/sandbox (required for containers)
export { Sandbox } from "@cloudflare/sandbox";

// Export Durable Object and Workflow classes
export { OpenCodeMcpAgent };
export { ExecuteTaskWorkflow };

/**
 * Get OpenCode config with provider API keys
 */
function getOpencodeConfig(env: Env): Config {
  return {
    provider: {
      anthropic: {
        options: {
          apiKey: env.ANTHROPIC_API_KEY,
        },
      },
    },
  };
}

// Worker fetch handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // MCP endpoint - route to McpAgent
    if (url.pathname.startsWith("/mcp")) {
      return OpenCodeMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    // Web UI proxy - /session/{sessionId}/* routes to OpenCode web UI
    // This allows users to interact with OpenCode directly in their browser
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];

      try {
        // Get sandbox for this session (will wake it up if sleeping)
        const sandbox = getSandbox(env.Sandbox, sessionId, {
          normalizeId: true,
        });

        // Start OpenCode server if not already running
        const server = await createOpencodeServer(sandbox, {
          directory: "/workspace",
          config: getOpencodeConfig(env),
        });

        // Proxy the request to OpenCode's web UI
        return proxyToOpencode(request, sandbox, server);
      } catch (error) {
        console.error("Web UI proxy error:", error);
        return new Response(
          JSON.stringify({
            error: "Failed to connect to session",
            message: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Default response
    return new Response(
      JSON.stringify({
        name: "sandbox-mcp",
        version: "1.0.0",
        endpoints: {
          health: "/health",
          mcp: "/mcp",
          webUi: "/session/{sessionId}/",
        },
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};
