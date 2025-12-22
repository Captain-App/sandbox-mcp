// src/index.ts
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencodeServer } from "@cloudflare/sandbox/opencode";
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

/**
 * Cookie name for tracking which session the web UI is viewing.
 * This is needed because OpenCode's frontend loads assets from root (/)
 * and we need to know which sandbox to proxy those requests to.
 */
const SESSION_COOKIE_NAME = "opencode_session_id";

/**
 * Get session ID from cookie
 */
function getSessionFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=");
    if (name === SESSION_COOKIE_NAME && value) {
      return value;
    }
  }
  return null;
}

/**
 * Proxy request to the appropriate sandbox
 */
async function proxyToSandbox(
  request: Request,
  env: Env,
  sessionId: string,
  targetPath: string,
): Promise<Response> {
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

  // Rewrite URL to the target path - OpenCode expects requests at root
  const url = new URL(request.url);
  const rewrittenUrl = new URL(targetPath, url.origin);
  rewrittenUrl.search = url.search;

  // Create new request with rewritten URL but preserve method/headers/body
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    redirect: request.redirect,
  });

  // Proxy directly to container
  return sandbox.containerFetch(rewrittenRequest, server.port);
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

    // Web UI entry point - /session/{sessionId} sets cookie and redirects to OpenCode
    // OpenCode expects URLs like /{base64(directory)}/session/{opencode-session-id}
    // We query the DO to get the actual OpenCode session ID and workspace path
    //
    // IMPORTANT: Don't match OpenCode's own API routes like /session/status, /session/list
    // Our session IDs are 8 hex chars (e.g., "a1b2c3d4"), so we use that pattern
    const sessionMatch = url.pathname.match(/^\/session\/([0-9a-f]{8})\/?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];

      // Look up session info from R2
      // Session metadata is stored as JSON in R2 at sessions/{sessionId}.json
      // This is written by the MCP agent when sessions are created/updated
      const metadataKey = `sessions/${sessionId}.json`;
      const metadataObject = await env.SESSIONS_BUCKET.get(metadataKey);

      let sessionInfo: {
        found: boolean;
        opencodeSessionId?: string;
        workspacePath?: string;
      };

      if (metadataObject) {
        try {
          const metadata = await metadataObject.json<{
            opencodeSessionId?: string;
            workspacePath?: string;
          }>();
          sessionInfo = {
            found: true,
            opencodeSessionId: metadata.opencodeSessionId,
            workspacePath: metadata.workspacePath,
          };
        } catch {
          sessionInfo = { found: false };
        }
      } else {
        sessionInfo = { found: false };
      }

      if (!sessionInfo.found) {
        return new Response(JSON.stringify({ error: "Session not found", sessionId }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Use the stored workspace path, or default to /workspace
      const workspacePath = sessionInfo.workspacePath || "/workspace";
      const workspaceBase64 = btoa(workspacePath);

      // Build redirect URL - include OpenCode session ID if available
      let redirectPath = `/${workspaceBase64}/session`;
      if (sessionInfo.opencodeSessionId) {
        redirectPath += `/${sessionInfo.opencodeSessionId}`;
      }

      const redirectUrl = new URL(redirectPath, url.origin);
      redirectUrl.searchParams.set("url", url.origin);

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; SameSite=Lax`,
        },
      });
    }

    // Catch-all: Proxy ANY request to the sandbox when session cookie is present
    // This handles OpenCode API routes like /path, /project, /provider, /global/event,
    // /session/list, /session/{uuid}/prompt, etc.
    // Must come BEFORE the default JSON response
    const sessionId = getSessionFromCookie(request);
    if (sessionId) {
      try {
        return await proxyToSandbox(request, env, sessionId, url.pathname);
      } catch (error) {
        console.error("API proxy error:", error);
        return new Response(JSON.stringify({ error: "Failed to proxy request" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
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
