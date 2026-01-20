// src/index.ts
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencodeServer } from "@cloudflare/sandbox/opencode";
import type { Config } from "@opencode-ai/sdk";
import { Effect, Option, pipe } from "effect";
import { withSentry as sentryWrapper } from "@sentry/cloudflare";
import * as Sentry from "@sentry/cloudflare";
import { instrument } from "@microlabs/otel-cf-workers";

import { OpenCodeMcpAgent } from "./agent/mcp-agent";
import { RealtimeChannel } from "./realtime";
import type { SessionMetadata, RunRecord, SessionId } from "@shipbox/shared";
import { DEFAULT_MODEL, withRequestContext, withSentry, LoggerLayer } from "@shipbox/shared";
import {
  anthropic,
  cloudflare,
  createProxyHandler,
  createProxyToken,
  github,
  handleDeployRequest,
  toContainerUrl,
  verifyProxyTokenAsync,
} from "./proxy";
import { makeSessionStorageLayer, SessionStorage } from "./services/session";
import { makeRunStorageLayer, RunStorage } from "./services/run";
import { ExecuteTaskWorkflow } from "./workflows/execute-task";
import { ensureSandboxReady } from "./workflows/helpers/sandbox";

// Export Sandbox class from @cloudflare/sandbox
export { Sandbox } from "@cloudflare/sandbox";

// Export Durable Object and Workflow classes
export { OpenCodeMcpAgent };
export { RealtimeChannel };
export { ExecuteTaskWorkflow };

/**
 * Create proxy handler for zero-trust authentication.
 *
 * Routes:
 * - /proxy/anthropic/* → Anthropic API (injects ANTHROPIC_API_KEY)
 * - /proxy/github/* → GitHub (injects GITHUB_TOKEN for git operations)
 */
const proxyHandler = createProxyHandler<Env>({
  mountPath: "/proxy",
  jwtSecret: (env) => env.PROXY_JWT_SECRET,
  services: { anthropic, github, cloudflare },
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
 * Get request ID from header
 */
function getRequestIdFromRequest(request: Request): string | null {
  return request.headers.get("X-Request-Id");
}

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
 * Get session metadata from R2 using the SessionStorage service.
 * Returns null if session not found or on error.
 */
function getSessionMetadata(
  bucket: R2Bucket,
  sessionId: string,
): Effect.Effect<SessionMetadata | null> {
  const layer = makeSessionStorageLayer(bucket);

  return Effect.gen(function* () {
    const storage = yield* SessionStorage;
    const result = yield* storage.getSession(sessionId);
    return Option.getOrNull(result);
  }).pipe(
    Effect.provide(layer),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

/**
 * Proxy request to the appropriate sandbox.
 *
 * This function ensures the sandbox is ready before proxying:
 * - Restores OpenCode backup if needed
 * - Clones repository if needed
 * - Configures proxy credentials if needed
 *
 * All initialization is idempotent - safe to call on every request.
 */
/**
 * Helper to get sandbox with OTel-safe binding.
 * OTel wraps bindings in a Proxy, which can cause "Illegal invocation"
 * when passed to library functions like getSandbox().
 */
function getSafeSandbox(env: Env, sessionId: string) {
  const { Sandbox } = env;
  return getSandbox(
    {
      get: Sandbox.get.bind(Sandbox),
      idFromName: Sandbox.idFromName.bind(Sandbox),
      idFromString: Sandbox.idFromString.bind(Sandbox),
      newUniqueId: Sandbox.newUniqueId.bind(Sandbox),
    } as any,
    sessionId,
    { normalizeId: true },
  );
}

/**
 * Proxy request to a sandbox.
 * Handles waking up the sandbox, balance checks, and proxying.
 */
async function proxyToSandbox(
  request: Request,
  env: Env,
  sessionId: string,
  targetPath: string,
  port?: number,
): Promise<Response> {
  // Get sandbox for this session (will wake it up if sleeping)
  const sandbox = getSafeSandbox(env, sessionId);

  // Get session metadata to know repository info and userId
  const metadata = await Effect.runPromise(getSessionMetadata(env.SESSIONS_BUCKET, sessionId));

  // Pre-flight balance check
  if (metadata?.userId) {
    const balanceRes = await env.SHIPBOX_API.fetch(
      `http://api/internal/check-balance/${metadata.userId}`,
    );
    if (!balanceRes.ok) {
      const errorData = (await balanceRes.json()) as any;
      return new Response(JSON.stringify({ error: errorData.error || "Insufficient balance" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Create a short-lived proxy token for web UI access
  const proxyToken = await Effect.runPromise(
    createProxyToken({
      secret: env.PROXY_JWT_SECRET,
      sandboxId: sessionId,
      userId: metadata?.userId || "unknown",
      expiresIn: "15m", // Short-lived for web UI sessions
    }),
  );

  // Derive base URL from request (no need for env var)
  const requestUrl = new URL(request.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

  // Ensure sandbox is ready (idempotent - checks state before acting)
  const ready = await ensureSandboxReady({
    sandbox,
    sessionId,
    bucket: env.SESSIONS_BUCKET,
    proxyBaseUrl: baseUrl,
    proxyToken,
    repository: metadata?.repository,
    userId: metadata?.userId,
  });

  let fetchPort = port;
  if (!fetchPort) {
    // Start OpenCode server with proxy-based config and correct workspace path
    const server = await createOpencodeServer(sandbox, {
      directory: ready.workspacePath,
      config: getProxyOpencodeConfig(baseUrl, proxyToken),
    });
    fetchPort = server.port;
  }

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
  return sandbox.containerFetch(rewrittenRequest, fetchPort);
}

// Worker fetch handler
const workerFetch = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const url = new URL(request.url);

  // Set Sentry context
  const requestId = getRequestIdFromRequest(request);
  if (requestId) {
    Sentry.setTag("requestId", requestId);
  }

  // Health check
  if (url.pathname === "/health") {
    return new Response("OK", { status: 200 });
  }

  // Wildcard subdomain handler for *.preview.shipbox.dev
  // Routes {sessionId}.preview.shipbox.dev to the deployed worker in Workers for Platforms
  const hostname = url.hostname;
  if (hostname.endsWith(".preview.shipbox.dev") && env.SANDBOX_WORKERS) {
    const sessionId = hostname.replace(".preview.shipbox.dev", "");
    const workerName = `sandbox-${sessionId}`;
    try {
      const userWorker = env.SANDBOX_WORKERS.get(workerName);
      return userWorker.fetch(request);
    } catch (error) {
      console.error(`Preview subdomain dispatch error for ${workerName}:`, error);
      return new Response(
        JSON.stringify({
          error: "Worker not found",
          message: error instanceof Error ? error.message : String(error),
          hint: `Deploy a worker using opencode_deploy_worker for session ${sessionId}`,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Deploy proxy - special handler for deployment requests from sandbox tools
  // Must be before generic proxy handler to intercept /proxy/deploy/* paths
  if (url.pathname.startsWith("/proxy/deploy/")) {
    // Validate JWT token
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const jwt = await verifyProxyTokenAsync({
        secret: env.PROXY_JWT_SECRET,
        token: authHeader.slice(7),
      });

      // Handle deployment request with JWT context
      return handleDeployRequest(request, { jwt, env, service: "deploy", request });
    } catch (_error) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
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

  // Preview route - proxy to miniflare inside sandbox (ephemeral, requires running container)
  // Note: We use a simpler proxy for preview that doesn't need full sandbox initialization.
  // The MCP agent's opencode_preview_worker tool already started wrangler dev on port 8787.
  const previewMatch = url.pathname.match(/^\/preview\/([0-9a-f]{8})(\/.*)?$/);
  if (previewMatch) {
    const sessionId = previewMatch[1];
    const targetPath = previewMatch[2] || "/";
    try {
      // Get sandbox stub for this session
      const sandbox = getSafeSandbox(env, sessionId);

      // Rewrite URL to the target path
      const rewrittenUrl = new URL(targetPath, url.origin);
      rewrittenUrl.search = url.search;

      // Create new request with rewritten URL
      const rewrittenRequest = new Request(rewrittenUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        redirect: request.redirect,
      });

      // Proxy directly to container's miniflare port
      return sandbox.containerFetch(rewrittenRequest, 8787);
    } catch (error) {
      // Log the error and return a helpful message
      console.error(`Preview proxy error for session ${sessionId}:`, error);
      return new Response(
        JSON.stringify({
          error: "Preview proxy failed",
          message: error instanceof Error ? error.message : String(error),
          hint: "Make sure the worker is running via opencode_preview_worker tool",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Deployed worker route - dispatch to Workers for Platforms (persistent, no container needed)
  // URL pattern: /deployed/{workerName}/* or /site/{sessionId}/*
  // The opencode_deploy_worker tool deploys workers with name "sandbox-{sessionId}"
  const deployedMatch = url.pathname.match(/^\/(?:deployed|site)\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (deployedMatch && env.SANDBOX_WORKERS) {
    const workerName = deployedMatch[1];
    const targetPath = deployedMatch[2] || "/";
    try {
      // For /site/{sessionId}, convert to worker name format
      const actualWorkerName = deployedMatch[0].startsWith("/site/")
        ? `sandbox-${workerName}`
        : workerName;

      // Get the deployed worker from the dispatch namespace
      const userWorker = env.SANDBOX_WORKERS.get(actualWorkerName);

      // Rewrite URL to the target path
      const rewrittenUrl = new URL(targetPath, url.origin);
      rewrittenUrl.search = url.search;

      // Create new request with rewritten URL
      const rewrittenRequest = new Request(rewrittenUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        redirect: request.redirect,
      });

      // Dispatch to the worker
      return userWorker.fetch(rewrittenRequest);
    } catch (error) {
      console.error(`Deployed worker dispatch error for ${workerName}:`, error);
      return new Response(
        JSON.stringify({
          error: "Worker dispatch failed",
          message: error instanceof Error ? error.message : String(error),
          hint: "Make sure the worker was deployed via opencode_deploy_worker tool",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // INTERNAL API for auth wrapper (cloud-box-castle-api)
  // List all sessions
  if (url.pathname === "/internal/sessions" && request.method === "GET") {
    const requestId = getRequestIdFromRequest(request) || crypto.randomUUID();
    const result = await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const storage = yield* SessionStorage;
          return yield* storage.listSessions();
        }),
        Effect.provide(makeSessionStorageLayer(env.SESSIONS_BUCKET)),
        withRequestContext(requestId),
        withSentry(Sentry as any),
        Effect.provide(LoggerLayer),
      ),
    );
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create session
  if (url.pathname === "/internal/sessions" && request.method === "POST") {
    const body = (await request.json()) as {
      userId: string;
      repository?: string;
      branch?: string;
      name?: string;
      title?: string;
      model?: string;
      region?: string;
    };
    const sessionId = crypto.randomUUID().slice(0, 8) as SessionId;
    const now = Date.now();
    // Use public URL for webUiUrl, not the internal service binding URL
    const publicBaseUrl =
      url.hostname === "sandbox" ? "https://engine.shipbox.dev" : `${url.protocol}//${url.host}`;
    const session: SessionMetadata = {
      sessionId,
      sandboxId: sessionId,
      createdAt: now,
      lastActivity: now,
      status: "active" as const,
      workspacePath: "/workspace",
      webUiUrl: `${publicBaseUrl}/session/${sessionId}/`,
      userId: body.userId,
      repository:
        body.repository && body.repository.trim() !== ""
          ? { url: body.repository, branch: body.branch ?? "main" }
          : undefined,
      title: body.name || body.title || "New Session",
      config: {
        defaultModel: body.model || "claude-sonnet-4-5",
        region: body.region || "lhr",
      },
      clonedRepos: body.repository && body.repository.trim() !== "" ? [body.repository] : [],
    };

    const requestId = getRequestIdFromRequest(request) || crypto.randomUUID();
    await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const storage = yield* SessionStorage;
          yield* storage.putSession(session);
        }),
        Effect.provide(makeSessionStorageLayer(env.SESSIONS_BUCKET)),
        withRequestContext(requestId, body.userId, sessionId),
        withSentry(Sentry as any),
        Effect.provide(LoggerLayer),
      ),
    );
    return new Response(JSON.stringify(session), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get/Delete/Start session
  const internalMatch = url.pathname.match(/^\/internal\/sessions\/([0-9a-f]{8})(\/start)?$/);
  if (internalMatch) {
    const sessionId = internalMatch[1];
    const isStart = !!internalMatch[2];

    if (isStart && request.method === "POST") {
      // Just waking it up - proxyToSandbox does this idempotently
      await proxyToSandbox(request, env, sessionId, "/health");
      return new Response(JSON.stringify({ success: true, status: "active" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const requestId = getRequestIdFromRequest(request) || crypto.randomUUID();

    // Start task for session (internal)
    if (request.method === "POST" && !isStart) {
      const body = (await request.json()) as any;
      const task = body.task;
      if (!task) return new Response("Task is required", { status: 400 });

      // 1. Get session
      const sessionResult = await Effect.runPromise(
        pipe(
          Effect.gen(function* () {
            const storage = yield* SessionStorage;
            return yield* storage.getSession(sessionId);
          }),
          Effect.provide(makeSessionStorageLayer(env.SESSIONS_BUCKET)),
          withRequestContext(requestId, undefined, sessionId),
          withSentry(Sentry as any),
          Effect.provide(LoggerLayer),
        ),
      );

      if (sessionResult._tag === "None") return new Response("Session not found", { status: 404 });
      const session = sessionResult.value;

      // 2. Create proxy token
      const proxyToken = await Effect.runPromise(
        createProxyToken({
          secret: env.PROXY_JWT_SECRET,
          sandboxId: sessionId,
          userId: session.userId || "unknown",
          expiresIn: "2h",
        }),
      );

      const publicBaseUrl = "https://engine.shipbox.dev";
      const runId = crypto.randomUUID();
      const now = Date.now();
      const model = body.model || session.config?.defaultModel || DEFAULT_MODEL;

      // 3. Start workflow first to get handle/id
      const runHandle = await env.EXECUTE_TASK_WORKFLOW.create({
        id: runId,
        params: {
          sessionId: session.sessionId,
          sandboxId: session.sandboxId,
          task: task,
          model,
          runId,
          title: body.title || "Task",
          proxyToken,
          proxyBaseUrl: publicBaseUrl,
          userId: session.userId || "unknown",
          requestId,
          existingOpencodeSessionId: session.opencodeSessionId,
        },
      });

      // 4. Create run record with correct fields
      const run: RunRecord = {
        runId,
        sessionId,
        workflowId: runHandle.id,
        status: "started",
        title: body.title || "Task",
        task,
        model,
        startedAt: now,
      };

      await Effect.runPromise(
        pipe(
          Effect.gen(function* () {
            const storage = yield* RunStorage;
            yield* storage.putRun(run);
          }),
          Effect.provide(makeRunStorageLayer(env.SESSIONS_BUCKET)),
          withRequestContext(requestId, session.userId, sessionId),
          withSentry(Sentry as any),
          Effect.provide(LoggerLayer),
        ),
      );

      return new Response(JSON.stringify({ runId, status: "started" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      const sessionResult = await Effect.runPromise(
        pipe(
          Effect.gen(function* () {
            const storage = yield* SessionStorage;
            return yield* storage.getSession(sessionId);
          }),
          Effect.provide(makeSessionStorageLayer(env.SESSIONS_BUCKET)),
          withRequestContext(requestId, undefined, sessionId),
          withSentry(Sentry as any),
          Effect.provide(LoggerLayer),
        ),
      );
      if (sessionResult._tag === "None") return new Response("Not found", { status: 404 });

      const session = sessionResult.value;
      const realtimeToken = await Effect.runPromise(
        createProxyToken({
          secret: env.PROXY_JWT_SECRET,
          sandboxId: session.sandboxId,
          userId: session.userId || "unknown",
          expiresIn: "2h",
        }),
      );

      return new Response(JSON.stringify({ ...session, realtimeToken }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "DELETE") {
      const requestId = getRequestIdFromRequest(request) || crypto.randomUUID();
      await Effect.runPromise(
        pipe(
          Effect.gen(function* () {
            const storage = yield* SessionStorage;
            yield* storage.deleteSession(sessionId);
          }),
          Effect.provide(makeSessionStorageLayer(env.SESSIONS_BUCKET)),
          withRequestContext(requestId, undefined, sessionId),
          withSentry(Sentry as any),
          Effect.provide(LoggerLayer),
        ),
      );
      return new Response(JSON.stringify({ success: true }));
    }
  }

  // Get file content from sandbox (internal)
  const fileMatch = url.pathname.match(/^\/internal\/sessions\/([0-9a-f]{8})\/files\/(.+)$/);
  if (fileMatch && request.method === "GET") {
    const sessionId = fileMatch[1];
    const filePath = decodeURIComponent(fileMatch[2]);

    try {
      // Get session metadata to know workspace path
      const metadata = await Effect.runPromise(getSessionMetadata(env.SESSIONS_BUCKET, sessionId));
      if (!metadata) return new Response("Session not found", { status: 404 });

      const sandbox = getSafeSandbox(env, sessionId);

      // Resolve path relative to workspace if not absolute
      const absolutePath = filePath.startsWith("/")
        ? filePath
        : `${metadata.workspacePath || "/workspace"}/${filePath}`;

      // Use cat to read the file content
      const result = await sandbox.exec(`cat "${absolutePath}"`);
      if (result.exitCode !== 0) {
        return new Response(
          JSON.stringify({
            error: "File not found or unreadable",
            details: result.stderr,
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(result.stdout, {
        headers: { "Content-Type": "text/plain" },
      });
    } catch (error) {
      console.error(`Error reading file ${filePath} from session ${sessionId}:`, error);
      return new Response(
        JSON.stringify({
          error: "Failed to read file",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Get run status
  const runMatch = url.pathname.match(/^\/internal\/runs\/([a-z0-9-]+)$/);
  if (runMatch && request.method === "GET") {
    const runId = runMatch[1];
    const requestId = getRequestIdFromRequest(request) || crypto.randomUUID();
    const result = await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const storage = yield* RunStorage;
          return yield* storage.getRun(runId);
        }),
        Effect.provide(makeRunStorageLayer(env.SESSIONS_BUCKET)),
        withRequestContext(requestId),
        withSentry(Sentry as any),
        Effect.provide(LoggerLayer),
      ),
    );
    if (result._tag === "None") return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(result.value), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get session logs
  const logsMatch = url.pathname.match(/^\/internal\/sessions\/([0-9a-f]{8})\/logs$/);
  if (logsMatch && request.method === "GET") {
    const sessionId = logsMatch[1];
    const prefix = `command-logs/${sessionId}/`;
    const objects = await env.SESSIONS_BUCKET.list({ prefix });

    // Sort by key (contains timestamp) descending and take top 50
    const sortedKeys = objects.objects.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 50);

    // Fetch log contents
    const logs = await Promise.all(
      sortedKeys.map(async (obj) => {
        const entry = await env.SESSIONS_BUCKET.get(obj.key);
        return entry ? entry.json() : null;
      }),
    );

    return new Response(JSON.stringify(logs.filter(Boolean)), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Real-time WebSocket upgrade (public)
  if (url.pathname === "/realtime") {
    const sessionId = url.searchParams.get("sessionId");
    const token = url.searchParams.get("token");
    if (!sessionId) return new Response("Session ID required", { status: 400 });
    if (!token) return new Response("Token required", { status: 401 });

    try {
      // Validate token
      const payload = await verifyProxyTokenAsync({
        secret: env.PROXY_JWT_SECRET,
        token: token,
      });

      // Optional: Verify that token matches requested sessionId
      if (payload.sandboxId !== sessionId) {
        return new Response("Forbidden: Session mismatch", { status: 403 });
      }
    } catch {
      return new Response("Unauthorized: Invalid or expired token", {
        status: 401,
      });
    }

    const id = env.REALTIME_CHANNEL.idFromName(sessionId);
    const stub = env.REALTIME_CHANNEL.get(id);
    return stub.fetch(request);
  }

  // Real-time Internal Publish (internal only)
  const realtimePublishMatch = url.pathname.match(/^\/internal\/realtime\/([0-9a-f]{8})\/publish$/);
  if (realtimePublishMatch && request.method === "POST") {
    const sessionId = realtimePublishMatch[1];
    const id = env.REALTIME_CHANNEL.idFromName(sessionId);
    const stub = env.REALTIME_CHANNEL.get(id);
    // Rewrite URL to /publish for the DO (it expects requests at /publish, not the full path)
    const rewrittenUrl = new URL("/publish", url.origin);
    const rewrittenRequest = new Request(rewrittenUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return stub.fetch(rewrittenRequest);
  }

  // Web UI entry point - /session/{sessionId} sets cookie and redirects to OpenCode
  // OpenCode expects URLs like /{base64(directory)}/session/{opencode-session-id}
  // We query R2 to get the actual OpenCode session ID and workspace path
  //
  // IMPORTANT: Don't match OpenCode's own API routes like /session/status, /session/list
  // Our session IDs are 8 hex chars (e.g., "a1b2c3d4"), so we use that pattern
  const sessionMatch = url.pathname.match(/^\/session\/([0-9a-f]{8})\/?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];

    // Look up session info from R2
    const metadata = await Effect.runPromise(getSessionMetadata(env.SESSIONS_BUCKET, sessionId));

    if (!metadata) {
      return new Response(JSON.stringify({ error: "Session not found", sessionId }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Use the stored workspace path, or default to /workspace
    const workspacePath = metadata.workspacePath || "/workspace";
    const workspaceBase64 = btoa(workspacePath);

    // Build redirect URL - include OpenCode session ID if available
    let redirectPath = `/${workspaceBase64}/session`;
    if (metadata.opencodeSessionId) {
      redirectPath += `/${metadata.opencodeSessionId}`;
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
      const startTime = Date.now();
      const response = await proxyToSandbox(request, env, sessionId, url.pathname);
      const durationMs = Date.now() - startTime;

      // Background: Report usage to shipbox-api if userId is known
      ctx.waitUntil(
        (async () => {
          const metadata = await Effect.runPromise(
            getSessionMetadata(env.SESSIONS_BUCKET, sessionId),
          );
          if (metadata?.userId) {
            const requestId = getRequestIdFromRequest(request) || crypto.randomUUID();
            await env.SHIPBOX_API.fetch("http://api/internal/report-usage", {
              method: "POST",
              body: JSON.stringify({
                userId: metadata.userId,
                sessionId,
                durationMs,
              }),
              headers: {
                "Content-Type": "application/json",
                "X-Request-Id": requestId,
              },
            });
          }
        })(),
      );

      return response;
    } catch (error) {
      const requestId = getRequestIdFromRequest(request);
      Sentry.captureException(error, {
        extra: { requestId, sessionId },
      });
      console.error(
        JSON.stringify({
          level: "error",
          message: "API proxy error",
          error: error instanceof Error ? error.message : String(error),
          requestId,
          sessionId,
        }),
      );
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
};

export default instrument(
  sentryWrapper(
    (env: Env) => ({
      dsn: env.SENTRY_DSN,
      tracesSampleRate: 1.0,
    }),
    {
      fetch: workerFetch,
    },
  ),
  (env: Env) => ({
    exporter: {
      url: "https://api.honeycomb.io/v1/traces",
      headers: {
        "x-honeycomb-team": env.HONEYCOMB_API_KEY || "",
        "x-honeycomb-dataset": env.HONEYCOMB_DATASET || "shipbox-engine",
      },
    },
    service: { name: "shipbox-engine" },
  }),
);
