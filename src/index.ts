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
 * Check if this is an OpenCode asset request (JS, CSS, images, manifest, etc.)
 */
function isAssetRequest(pathname: string): boolean {
  return (
    pathname.startsWith("/assets/") ||
    pathname === "/favicon.ico" ||
    pathname === "/favicon.svg" ||
    pathname.startsWith("/favicon-") ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/site.webmanifest" ||
    pathname.startsWith("/.well-known/")
  );
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

    // Web UI proxy - /session/{sessionId}/* routes to OpenCode web UI
    // This allows users to interact with OpenCode directly in their browser
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const subPath = sessionMatch[2] || "/";

      // Handle the ?url= redirect for OpenCode frontend
      // OpenCode's frontend defaults to localhost:4096 - we need to tell it our proxy URL
      // We set ?url= to the origin (not session path) because API calls go through root
      // and we use a cookie to track which session for asset requests
      if (!url.searchParams.has("url") && request.method === "GET") {
        const accept = request.headers.get("accept") || "";
        const isHtmlRequest = accept.includes("text/html") || subPath === "/";
        if (isHtmlRequest) {
          // Redirect to same URL but with ?url= pointing to origin
          // The frontend will make API calls to /session/list, /session/prompt etc.
          // which we'll route based on the session cookie
          url.searchParams.set("url", url.origin);
          const redirectUrl = url.toString();
          // Set cookie so we know which session for subsequent requests
          return new Response(null, {
            status: 302,
            headers: {
              Location: redirectUrl,
              "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; SameSite=Lax`,
            },
          });
        }
      }

      try {
        const response = await proxyToSandbox(request, env, sessionId, subPath);
        // Set/refresh cookie on session responses
        const headers = new Headers(response.headers);
        headers.append("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; SameSite=Lax`);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
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

    // Handle OpenCode asset requests (JS, CSS, favicons, etc.)
    // These come from the browser after loading /session/{id}/ HTML
    // and need to be routed to the correct sandbox using the session cookie
    if (isAssetRequest(url.pathname)) {
      const sessionId = getSessionFromCookie(request);
      if (sessionId) {
        try {
          return await proxyToSandbox(request, env, sessionId, url.pathname);
        } catch (error) {
          console.error("Asset proxy error:", error);
          // Fall through to 404
        }
      }
      return new Response("Not Found", { status: 404 });
    }

    // Handle OpenCode API requests that go to root paths
    // e.g., /session/list, /session/{id}/prompt (note: different from /session/{our-id}/)
    // These need to be routed based on the session cookie
    // Only match if it looks like an OpenCode API path (has UUID-like session ID)
    const opencodeApiMatch = url.pathname.match(/^\/session\/([0-9a-f-]{36})(\/.*)?$/);
    if (opencodeApiMatch || url.pathname === "/session" || url.pathname === "/session/") {
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
      return new Response(
        JSON.stringify({ error: "No session context - visit /session/{id}/ first" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
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
