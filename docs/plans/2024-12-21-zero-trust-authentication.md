# Zero-Trust Authentication Implementation Plan

## Problem Statement

The sandbox-mcp project runs arbitrary AI agents (OpenCode) inside Cloudflare Sandboxes. Because these agents are untrusted and execute arbitrary code, we should treat the sandbox as a **zero-trust environment**. Currently, we pass real secrets directly into the sandbox:

| Secret | Current Flow | Risk |
|--------|--------------|------|
| `ANTHROPIC_API_KEY` | Passed via `opencodeConfig.provider.anthropic.options.apiKey` | Any code can read/exfiltrate |
| `GITHUB_TOKEN` | Set as env vars `GH_TOKEN`, `GITHUB_TOKEN` in sandbox | Visible to all processes |
| R2 credentials | Used for `mountBucket()` - credentials passed to sandbox's s3fs | Mounted credentials accessible |

### The Goal

Real credentials should **NEVER** enter the sandbox container. Instead:
1. Sandbox receives a short-lived JWT token
2. All external API calls go through a proxy in our Worker
3. Proxy validates JWT, injects real credentials, forwards request
4. Real secrets exist only in the Worker environment

### Scope

We're building this for personal use. The only secrets we need to protect are:
- **Anthropic API key** - for OpenCode LLM calls
- **GitHub token** - for git operations
- **R2 credentials** - for workspace persistence

No need to support arbitrary user-provided providers or keys.

---

## Solution: Zero-Trust Proxy Pattern

Based on the Cloudflare Sandbox SDK authentication example, we'll implement:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       SANDBOX CONTAINER                                  │
│   OpenCode/git/s3fs sends request with JWT token (NOT real creds)       │
│   POST https://worker.dev/proxy/anthropic/v1/messages                   │
│   Headers: x-api-key: {jwt-token}                                       │
└────────────────────────────────────────┬────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE WORKER                                   │
│   1. Parse path → service="anthropic", path="/v1/messages"              │
│   2. validate(request) → extract JWT from x-api-key header              │
│   3. verifyProxyToken(token, secret) → { sandboxId, exp, iat }         │
│   4. transform(request, ctx) → inject real ANTHROPIC_API_KEY           │
│   5. Forward to api.anthropic.com                                       │
└────────────────────────────────────────┬────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICE                                    │
│                     (Anthropic, GitHub, R2)                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Services to Proxy

### 1. Anthropic (for OpenCode LLM calls)

OpenCode uses the Anthropic SDK internally. The SDK respects:
- `ANTHROPIC_BASE_URL` - Custom API endpoint
- `ANTHROPIC_API_KEY` - API key (will be JWT in our case)

The `@cloudflare/sandbox/opencode` SDK's `createOpencode()` accepts a `config` with `provider.anthropic.options.baseURL`.

**Proxy flow:**
1. Configure OpenCode with `baseURL` pointing to our proxy
2. Pass JWT as the "API key"
3. OpenCode SDK calls `/proxy/anthropic/v1/messages` with `x-api-key: {jwt}`
4. Proxy validates JWT, replaces with real `ANTHROPIC_API_KEY`, forwards to Anthropic

### 2. GitHub (for git clone/push)

Git operations need authenticated access for private repos.

**Proxy flow:**
1. Configure git URL rewriting: `git config --global url."https://worker.dev/proxy/github/".insteadOf "https://github.com/"`
2. Set extra header: `git config --global http.https://worker.dev/proxy/github/.extraheader "Authorization: Bearer {jwt}"`
3. Git commands transparently go through proxy
4. Proxy validates JWT, validates path (only git protocol paths allowed), injects real `GITHUB_TOKEN`

**Security:** Only allow git-specific paths:
```
/^\/[^\/]+\/[^\/]+(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/
```

### 3. R2 (for workspace persistence)

The `mountBucket()` SDK function supports custom endpoints. We'll point it at our proxy.

**Proxy flow:**
1. Call `mountBucket()` with proxy endpoint and JWT as credentials
2. s3fs inside container makes S3 API calls to proxy
3. Proxy validates JWT, re-signs request with real R2 credentials, forwards to R2

---

## Effect Integration Strategy

This codebase uses Effect extensively. We'll apply Effect patterns where they add value:

| Component | Approach | Rationale |
|-----------|----------|-----------|
| **Errors** | Effect `Schema.TaggedError` | Consistent with `StorageReadError`, `SessionNotFoundError` |
| **Token functions** | Return `Effect` | Integrates with Effect-based MCP agent code |
| **Proxy handler** | Keep Promise-based | HTTP boundary layer, simple pass-through |
| **Service configs** | Plain functions | Simple sandbox setup, no Effect needed |

### Effect-Style Errors

Define typed errors in `src/proxy/errors.ts` using Effect Schema:

```typescript
import { Schema } from "effect";
import * as Predicate from "effect/Predicate";

export const ProxyErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/ProxyError");
export type ProxyErrorTypeId = typeof ProxyErrorTypeId;

export class ProxyTokenExpiredError extends Schema.TaggedError<ProxyTokenExpiredError>()(
  "ProxyTokenExpiredError",
  { message: Schema.String }
) {
  readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;
}

export class ProxyTokenInvalidError extends Schema.TaggedError<ProxyTokenInvalidError>()(
  "ProxyTokenInvalidError",
  { reason: Schema.String }
) {
  readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;
}

export class ProxyTokenMissingError extends Schema.TaggedError<ProxyTokenMissingError>()(
  "ProxyTokenMissingError",
  { service: Schema.String }
) {
  readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;
}

export class ProxyServiceNotFoundError extends Schema.TaggedError<ProxyServiceNotFoundError>()(
  "ProxyServiceNotFoundError",
  { service: Schema.String, available: Schema.Array(Schema.String) }
) {
  readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;
}

export class ProxyTargetError extends Schema.TaggedError<ProxyTargetError>()(
  "ProxyTargetError",
  { service: Schema.String, cause: Schema.String }
) {
  readonly [ProxyErrorTypeId]: ProxyErrorTypeId = ProxyErrorTypeId;
}

export type ProxyError =
  | ProxyTokenExpiredError
  | ProxyTokenInvalidError
  | ProxyTokenMissingError
  | ProxyServiceNotFoundError
  | ProxyTargetError;

export const isProxyError = (u: unknown): u is ProxyError =>
  Predicate.hasProperty(u, ProxyErrorTypeId);
```

### Effect-Native Token Functions

Token functions return `Effect` for integration with MCP agent:

```typescript
// src/proxy/token.ts
import { Effect } from "effect";
import { jwtVerify, SignJWT } from "jose";
import { ProxyTokenExpiredError, ProxyTokenInvalidError } from "./errors";

export const createProxyToken = (
  options: CreateProxyTokenOptions
): Effect.Effect<string, ProxyTokenInvalidError> =>
  Effect.tryPromise({
    try: async () => {
      const { secret, sandboxId, sessionId, expiresIn = "15m" } = options;
      const secretKey = new TextEncoder().encode(secret);
      const expirationSeconds = parseExpiresIn(expiresIn);
      const now = Math.floor(Date.now() / 1000);

      return new SignJWT({ sandboxId, ...(sessionId && { sessionId }) })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(now)
        .setExpirationTime(now + expirationSeconds)
        .sign(secretKey);
    },
    catch: (error) =>
      new ProxyTokenInvalidError({
        reason: error instanceof Error ? error.message : "Token creation failed",
      }),
  });

export const verifyProxyToken = (
  options: VerifyProxyTokenOptions
): Effect.Effect<ProxyTokenPayload, ProxyTokenExpiredError | ProxyTokenInvalidError> =>
  Effect.tryPromise({
    try: async () => {
      const { secret, token } = options;
      const secretKey = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
      
      // Validate payload structure
      if (typeof payload.sandboxId !== "string") {
        throw new Error("Missing sandboxId");
      }
      
      return {
        sandboxId: payload.sandboxId,
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
        exp: payload.exp as number,
        iat: payload.iat as number,
      };
    },
    catch: (error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("expired")) {
        return new ProxyTokenExpiredError({ message: "Token has expired" });
      }
      return new ProxyTokenInvalidError({ reason: message });
    },
  });
```

---

## Implementation Plan

### Phase 1: Add Proxy Infrastructure

#### Task 1.1: Create proxy module with Effect errors

Create `src/proxy/` directory:

```
src/proxy/
├── index.ts      # Re-exports
├── types.ts      # Interfaces: ServiceConfig, ProxyContext, etc.
├── token.ts      # Effect-native createProxyToken, verifyProxyToken
├── handler.ts    # Proxy handler factory (Promise-based for HTTP layer)
└── errors.ts     # Effect Schema TaggedError classes
```

**Errors** (`errors.ts`): Use Effect `Schema.TaggedError` pattern (see above).

**Token functions** (`token.ts`): Return `Effect` types, use `Effect.tryPromise`.

**Handler** (`handler.ts`): Keep Promise-based (adapted from SDK example) since it's the HTTP boundary. The handler will convert Effect errors to HTTP responses.

**Dependencies to add:**
```bash
npm install jose aws4fetch
```

#### Task 1.2: Create service configurations

Create `src/proxy/services/`:

```
src/proxy/services/
├── index.ts       # Re-exports
├── anthropic.ts   # Anthropic API proxy + configureAnthropic()
├── github.ts      # GitHub git proxy + configureGithub()
└── r2.ts          # R2 S3 proxy
```

These remain plain functions - they're simple request transformations and sandbox config.

#### Task 1.3: Add new environment variables

In `wrangler.jsonc`, add:
```jsonc
{
  "vars": {
    "PROXY_BASE_URL": "https://sandbox-mcp.your-subdomain.workers.dev"
  }
}
```

Add secret:
```bash
wrangler secret put PROXY_JWT_SECRET
# Generate with: openssl rand -base64 32
```

Update `worker-configuration.d.ts`:
```typescript
interface Env {
  // ... existing
  PROXY_JWT_SECRET: string;
  PROXY_BASE_URL: string;
}
```

---

### Phase 2: Wire Proxy into Worker

#### Task 2.1: Add proxy route to `src/index.ts`

```typescript
import { createProxyHandler } from './proxy';
import { anthropic, github, r2 } from './proxy/services';

const proxyHandler = createProxyHandler<Env>({
  mountPath: '/proxy',
  jwtSecret: (env) => env.PROXY_JWT_SECRET,
  services: { anthropic, github, r2 }
});

// In fetch handler, before other routes:
if (url.pathname.startsWith('/proxy/')) {
  return proxyHandler(request, env);
}
```

---

### Phase 3: Update Workflow to Use Proxy

#### Task 3.1: Update `TaskParams` in `types.ts`

```typescript
export interface TaskParams {
  sessionId: string;
  sandboxId: string;
  task: string;
  model: string;
  runId: string;
  doId: string;
  repositoryUrl?: string;
  branch?: string;
  // REMOVED: opencodeConfig, githubToken
  // ADDED: proxy token (JWT - safe to serialize)
  proxyToken: string;
  proxyBaseUrl: string;
}
```

#### Task 3.2: Update `WorkflowDeps` in `types.ts`

```typescript
export interface WorkflowDeps {
  sandboxBinding: DurableObjectNamespace<any>;
  mcpAgentBinding: DurableObjectNamespace<any>;
  sessionsBucket: R2Bucket;
  // REMOVED: r2Config, githubToken (no longer needed - proxy handles auth)
}
```

#### Task 3.3: Update sandbox helpers

In `src/workflows/helpers/sandbox.ts`:

```typescript
import { configureAnthropic, configureGithub } from '../../proxy/services';

/**
 * Configure sandbox to use proxy for external services.
 */
export async function configureSandboxProxy(
  sandbox: Sandbox<unknown>,
  proxyBaseUrl: string,
  proxyToken: string,
): Promise<void> {
  await configureAnthropic(sandbox, proxyBaseUrl, proxyToken);
  await configureGithub(sandbox, proxyBaseUrl, proxyToken);
}

/**
 * Mount R2 storage via proxy (credentials never enter sandbox).
 * Uses mountBucket() with custom endpoint.
 */
export async function mountR2Storage(
  sandbox: Sandbox<unknown>,
  sessionId: string,
  proxyBaseUrl: string,
  proxyToken: string,
): Promise<void> {
  await sandbox.mountBucket(`opencode-sessions:/${sessionId}`, '/workspace', {
    endpoint: `${proxyBaseUrl}/proxy/r2`,
    credentials: {
      accessKeyId: proxyToken,    // JWT as access key
      secretAccessKey: 'unused',  // Required by format, ignored by proxy
    },
  });
}
```

#### Task 3.4: Update OpenCode helper

In `src/workflows/helpers/opencode.ts`:

```typescript
export async function executeTask(
  sandbox: Sandbox<unknown>,
  params: TaskParams,
): Promise<OpenCodeTaskResult> {
  const config: Config = {
    provider: {
      anthropic: {
        options: {
          apiKey: params.proxyToken,  // JWT, not real key
          baseURL: `${params.proxyBaseUrl}/proxy/anthropic`,
        },
      },
    },
  };

  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    port: 4096,
    directory: '/workspace',
    config,
  });
  
  // ... rest unchanged
}
```

#### Task 3.5: Update workflow execution

In `src/workflows/execute-task.ts`, update the run() method to:
1. Remove `r2Config` and `githubToken` from deps
2. Use `configureSandboxProxy()` instead of `setupGitCredentials()`
3. Update `mountR2Storage()` call to use proxy
4. Pass `params` directly to `executeTask()` (it has proxyToken and proxyBaseUrl)

---

### Phase 4: Update MCP Agent

#### Task 4.1: Update `registerRunTaskTool` in `mcp-agent.ts`

Since `createProxyToken` returns an `Effect`, we run it through the existing runtime:

```typescript
import { createProxyToken } from '../proxy';
import * as Effect from "effect/Effect";

// In registerRunTaskTool, before creating workflow:
// Note: createProxyToken returns Effect, so we run it through the runtime
const proxyToken = await rt.runPromise(
  createProxyToken({
    secret: this.env.PROXY_JWT_SECRET,
    sandboxId: session.value.sandboxId,
    sessionId: params.sessionId,
    expiresIn: '2h',
  })
);

const workflowInstance = await this.env.EXECUTE_TASK_WORKFLOW.create({
  id: runId,
  params: {
    sessionId: params.sessionId,
    sandboxId: session.value.sandboxId,
    task: params.task,
    model: params.model ?? session.value.config.defaultModel,
    runId,
    doId,
    repositoryUrl: session.value.repository?.url,
    branch: session.value.repository?.branch,
    proxyToken,
    proxyBaseUrl: this.env.PROXY_BASE_URL,
  },
});
```

The Effect-based token creation integrates naturally with the existing `ManagedRuntime` pattern used in the MCP agent. Errors from token creation will be properly typed and can be handled using Effect's error channel.

---

### Phase 5: Update Web UI Handler

#### Task 5.1: Update `/session/{sessionId}/` in `src/index.ts`

Since the web UI handler is in the Worker fetch handler (Promise-based), we use `Effect.runPromise` to execute the Effect-based token creation:

```typescript
import { Effect } from 'effect';
import { createProxyToken } from './proxy';
import { configureSandboxProxy } from './workflows/helpers/sandbox';

// In the session handler:
if (sessionMatch) {
  const sessionId = sessionMatch[1];
  const sandbox = getSandbox(env.Sandbox, sessionId, { normalizeId: true });
  
  // Run the Effect to create a proxy token
  const proxyToken = await Effect.runPromise(
    createProxyToken({
      secret: env.PROXY_JWT_SECRET,
      sandboxId: sessionId,
      expiresIn: '15m',
    })
  );
  
  await configureSandboxProxy(sandbox, env.PROXY_BASE_URL, proxyToken);
  
  const server = await createOpencodeServer(sandbox, {
    directory: '/workspace',
    config: {
      provider: {
        anthropic: {
          options: {
            apiKey: proxyToken,
            baseURL: `${env.PROXY_BASE_URL}/proxy/anthropic`,
          },
        },
      },
    },
  });
  
  return proxyToOpencode(request, sandbox, server);
}
```

Note: For better error handling, we could wrap the entire handler in `Effect.gen` and use `Effect.runPromise` at the top level, but for this simple case, running the token creation inline is sufficient.

---

## File Changes Summary

### New Files

| File | Purpose | Effect Usage |
|------|---------|--------------|
| `src/proxy/index.ts` | Re-exports proxy utilities | Exports Effect types |
| `src/proxy/types.ts` | TypeScript interfaces | Effect type params |
| `src/proxy/token.ts` | JWT creation/verification | **Effect-native** (returns `Effect`) |
| `src/proxy/handler.ts` | Proxy handler factory | Promise-based (HTTP boundary) |
| `src/proxy/errors.ts` | Error classes | **`Schema.TaggedError`** |
| `src/proxy/services/index.ts` | Service exports | Plain exports |
| `src/proxy/services/anthropic.ts` | Anthropic API proxy | Plain functions |
| `src/proxy/services/github.ts` | GitHub git proxy | Plain functions |
| `src/proxy/services/r2.ts` | R2 S3 proxy | Plain functions |

### Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Add `/proxy/*` route, update web UI handler with `Effect.runPromise` |
| `src/agent/mcp-agent.ts` | Create proxy tokens via runtime (Effect integration) |
| `src/workflows/execute-task.ts` | Remove r2Config/githubToken, use proxy |
| `src/workflows/helpers/types.ts` | Simplify `WorkflowDeps`, update `TaskParams` |
| `src/workflows/helpers/sandbox.ts` | Add `configureSandboxProxy()`, update `mountR2Storage()` |
| `src/workflows/helpers/opencode.ts` | Use proxy config from params |
| `worker-configuration.d.ts` | Add `PROXY_JWT_SECRET`, `PROXY_BASE_URL` |
| `wrangler.jsonc` | Add `PROXY_BASE_URL` var |
| `package.json` | Add `jose`, `aws4fetch` dependencies |

---

## Environment Configuration

### New Secret

```bash
wrangler secret put PROXY_JWT_SECRET
# Generate with: openssl rand -base64 32
```

### New Variable (in wrangler.jsonc)

```jsonc
{
  "vars": {
    "PROXY_BASE_URL": "https://sandbox-mcp.your-subdomain.workers.dev"
  }
}
```

### Existing Secrets (unchanged, now only accessed by proxy)

| Name | Used By |
|------|---------|
| `ANTHROPIC_API_KEY` | Proxy anthropic service |
| `GITHUB_TOKEN` | Proxy github service |
| `R2_ACCESS_KEY_ID` | Proxy r2 service |
| `R2_SECRET_ACCESS_KEY` | Proxy r2 service |
| `R2_ACCOUNT_ID` | Proxy r2 service (for R2 endpoint) |

---

## Security Improvements

| Before | After |
|--------|-------|
| `ANTHROPIC_API_KEY` in workflow params | JWT token in workflow params |
| `GITHUB_TOKEN` as env var in sandbox | Git URL rewriting through proxy |
| R2 credentials passed to `mountBucket()` | `mountBucket()` with proxy endpoint + JWT |
| Secrets visible to any process in container | Only JWT visible (2h expiry, scoped to sandbox) |
| Compromised sandbox = compromised secrets | Compromised sandbox = limited blast radius |

---

## Testing Plan

1. **Unit tests** for `createProxyToken()` / `verifyProxyToken()`
2. **Integration tests**:
   - Proxy routes return correct responses
   - Invalid/expired tokens are rejected
   - GitHub proxy only allows git protocol paths
3. **E2E tests**:
   - Create session → run task → OpenCode calls Anthropic via proxy
   - Git clone through proxy works
   - R2 mount through proxy works

---

## Deployment Notes

1. **Generate and set `PROXY_JWT_SECRET`** before deploying
2. **Set `PROXY_BASE_URL`** to your worker's URL in wrangler.jsonc
3. **No database changes** - existing sessions work (config happens at runtime)
4. **Rolling deployment safe** - proxy routes can exist before they're used
