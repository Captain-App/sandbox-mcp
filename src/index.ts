// src/index.ts
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencodeServer, proxyToOpencode } from "@cloudflare/sandbox/opencode";
import type { Config } from "@opencode-ai/sdk";
import { Effect } from "effect";

import { OpenCodeMcpAgent } from "./agent/mcp-agent";
import {
  anthropic,
  configureAnthropic,
  configureGithub,
  createProxyHandler,
  createProxyToken,
  github,
  r2,
  toContainerUrl,
} from "./proxy";
import { ExecuteTaskWorkflow } from "./workflows/execute-task";

// Export Sandbox class from @cloudflare/sandbox (required for containers)
export { Sandbox } from "@cloudflare/sandbox";

// Export Durable Object and Workflow classes
export { OpenCodeMcpAgent };
export { ExecuteTaskWorkflow };

/**
 * Create proxy handler for zero-trust authentication.
 *
 * Routes:
 * - /proxy/anthropic/* → Anthropic API (injects ANTHROPIC_API_KEY)
 * - /proxy/github/* → GitHub (injects GITHUB_TOKEN for git operations)
 * - /proxy/r2/* → R2 bucket (re-signs with R2 credentials)
 */
const proxyHandler = createProxyHandler<Env>({
  mountPath: "/proxy",
  jwtSecret: (env) => env.PROXY_JWT_SECRET,
  services: { anthropic, github, r2 },
});

/**
 * Get OpenCode config that uses the proxy for API calls.
 *
 * The JWT token is passed as the API key, and the baseURL points to our proxy.
 * The proxy validates the JWT and injects the real ANTHROPIC_API_KEY.
 */
function getProxyOpencodeConfig(proxyBaseUrl: string, proxyToken: string): Config {
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

// Worker fetch handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Proxy routes - zero-trust authentication for sandbox requests
    // Must be before other routes to intercept /proxy/* paths
    if (url.pathname.startsWith("/proxy/")) {
      return proxyHandler(request, env);
    }

    // MCP endpoint - route to McpAgent
    if (url.pathname.startsWith("/mcp")) {
      return OpenCodeMcpAgent.serve("/mcp", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
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

        // Create a short-lived proxy token for web UI access
        const proxyToken = await Effect.runPromise(
          createProxyToken({
            secret: env.PROXY_JWT_SECRET,
            sandboxId: sessionId,
            expiresIn: "15m", // Short-lived for web UI sessions
          }),
        );

        // Configure sandbox to use proxy for external services
        const containerProxyUrl = toContainerUrl(env.PROXY_BASE_URL);
        await configureAnthropic(sandbox, containerProxyUrl, proxyToken);
        await configureGithub(sandbox, containerProxyUrl, proxyToken);

        // Start OpenCode server with proxy-based config
        const server = await createOpencodeServer(sandbox, {
          directory: "/workspace",
          config: getProxyOpencodeConfig(env.PROXY_BASE_URL, proxyToken),
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
          },
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
          proxy: "/proxy/{service}/*",
        },
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};
