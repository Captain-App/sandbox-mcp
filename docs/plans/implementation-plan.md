# OpenCode Sandbox MCP Server - Implementation Plan

## Overview

This document outlines the step-by-step implementation plan for building an Effect-first MCP server that exposes OpenCode running in Cloudflare Sandboxes. This plan follows modern TypeScript best practices (December 2025) and draws heavily from the `effect-cloudflare` reference implementation.

---

## Tech Stack

### Core Dependencies
```json
{
  "dependencies": {
    "effect": "^3.11.0",
    "@effect/platform": "^0.71.0",
    "@effect/schema": "^0.77.0",
    "@cloudflare/agents": "latest",
    "@cloudflare/sandbox": "latest"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241127.0",
    "@cloudflare/vitest-pool-workers": "latest",
    "oxlint": "^0.16.0",
    "typescript": "^5.7.2",
    "wrangler": "^3.98.0",
    "vitest": "^2.1.8",
    "tsx": "^4.19.2"
  }
}
```

### Tooling Choices

| Tool | Purpose | Why |
|------|---------|-----|
| **Effect TS** | Type-safe business logic | Compile-time error tracking, structured concurrency, retry logic |
| **Oxlint** | Linting | 50-100x faster than ESLint, simpler than Biome |
| **Vitest** | Testing | Cloudflare Workers integration via `@cloudflare/vitest-pool-workers` |
| **TypeScript 5.7** | Type checking | Current stable (TS Go not ready yet) |
| **tsx** | Script execution | Fast TypeScript execution for dev scripts |

---

## Project Structure

```
src/
  services/                 # Effect services (pure business logic)
    sandbox.service.ts      # Sandbox SDK wrapper
    opencode.service.ts     # OpenCode SDK wrapper
    storage.service.ts      # Durable Object storage wrapper
    workflow.service.ts     # Workflow orchestration
    r2.service.ts           # R2 bucket operations
  
  layers/                   # Effect layers (dependency injection)
    app.layer.ts            # Main application layer composition
    logger.layer.ts         # Logging layer (dev vs prod)
    env.layer.ts            # Environment/config layer
  
  models/                   # Data models with Effect Schema
    session.model.ts        # Session metadata, states, schemas
    run.model.ts            # Task run records, results
    errors.model.ts         # All error types (tagged errors)
  
  agent/                    # Durable Object implementation
    opencode-mcp-agent.ts   # McpAgent with Effect runtime
  
  tools/                    # MCP tool handlers
    create-session.tool.ts  # opencode_create_session
    run-task.tool.ts        # opencode_run_task
    get-status.tool.ts      # opencode_get_status
  
  workflows/                # Workflow definitions
    execute-task.workflow.ts # Long-running OpenCode task execution
  
  utils/                    # Utilities
    ids.ts                  # UUID generation, validation
    constants.ts            # Constants, defaults
  
  internal/                 # Internal utilities (inspired by effect-cloudflare)
    context.ts              # ExecutionContext wrapper
    env.ts                  # Environment wrapper
  
  index.ts                  # Worker entrypoint
  
tests/
  services/                 # Service tests
  agent/                    # Integration tests
  tools/                    # Tool tests
  
docs/
  plans/
    sandbox-mcp-design.md   # Design document (existing)
    implementation-plan.md  # This document
  effect-llms.txt           # Effect documentation reference
  rules-of-durable-objects.md
```

---

## Implementation Phases

## Phase 1: Foundation & Core Infrastructure

### 1.1 Project Setup

**Goal:** Set up modern tooling and dependencies

**Tasks:**
- [x] Scaffold with create-cloudflare (already done)
- [ ] Install all dependencies (Effect, Agents SDK, Sandbox SDK)
- [ ] Configure Oxlint
- [ ] Configure Vitest with Workers pool
- [ ] Set up TypeScript configuration (strict mode)
- [ ] Configure wrangler with bindings (DO, R2, Workflows)
- [ ] Add npm scripts (dev, deploy, test, lint, typecheck)

**Files to create/modify:**
- `package.json`
- `oxlint.config.json` (if needed, Oxlint is mostly zero-config)
- `vitest.config.ts`
- `tsconfig.json` (ensure strict mode)
- `wrangler.jsonc` (add bindings)

**Success criteria:**
- ✅ `npm run dev` starts Wrangler
- ✅ `npm run lint` runs Oxlint
- ✅ `npm run test` runs Vitest
- ✅ `npm run typecheck` passes

---

### 1.2 Error Models

**Goal:** Define all error types using `Schema.TaggedError` pattern from effect-cloudflare

**Pattern to follow:**
```typescript
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>(
  "@opencode-mcp/SessionError/NotFound"
)("SessionNotFoundError", {
  sessionId: Schema.String,
}) {
  readonly [TypeId]: typeof TypeId = TypeId;
  
  override get message(): string {
    return `Session "${this.sessionId}" not found`;
  }
}
```

**Error Categories:**

**Session Errors:**
- `SessionNotFoundError` - Session doesn't exist
- `SessionAlreadyExistsError` - Trying to create existing session
- `SessionCreationError` - Failed to create session
- `InvalidSessionIdError` - Invalid session ID format

**Repository Errors:**
- `RepositoryCloneError` - Failed to clone repository
- `RepositoryAuthError` - GitHub authentication failed
- `InvalidRepositoryUrlError` - Malformed URL

**Sandbox Errors:**
- `SandboxStartupError` - Sandbox failed to start
- `SandboxConnectionLostError` - Lost connection to sandbox
- `SandboxTimeoutError` - Sandbox operation timed out
- `R2MountError` - Failed to mount R2 bucket

**OpenCode Errors:**
- `OpenCodeStartupError` - OpenCode server failed to start
- `OpenCodeExecutionError` - Task execution failed
- `OpenCodeTimeoutError` - Task took too long

**Workflow Errors:**
- `WorkflowCreationError` - Failed to create workflow
- `WorkflowExecutionError` - Workflow execution failed
- `WorkflowTimeoutError` - Workflow exceeded timeout

**Storage Errors:**
- `StorageReadError` - Failed to read from DO storage
- `StorageWriteError` - Failed to write to DO storage
- `StorageInvalidDataError` - Data doesn't match schema

**Validation Errors:**
- `InvalidInputError` - MCP tool input validation failed
- `SchemaValidationError` - Data doesn't match schema

**Files to create:**
- `src/models/errors.model.ts` - All error definitions
- `src/models/errors.test.ts` - Error construction tests

**Success criteria:**
- ✅ All errors extend `Schema.TaggedError`
- ✅ All errors have TypeId
- ✅ All errors have comprehensive JSDoc
- ✅ Error union types defined (e.g., `SessionError`, `SandboxError`)
- ✅ Tests verify error construction and messages

---

### 1.3 Data Models & Schemas

**Goal:** Define core data models using Effect Schema

**Models to define:**

**Session Model:**
```typescript
import { Schema as S } from "@effect/schema";

// Session states
export const SessionStatus = S.Literal(
  "creating",
  "active", 
  "idle",
  "stopped",
  "error"
);

export const SessionMetadata = S.Struct({
  sessionId: S.String.pipe(
    S.pattern(/^[a-z0-9-]+$/),
    S.maxLength(64)
  ),
  sandboxId: S.String,
  createdAt: S.Number,
  lastActivity: S.Number,
  status: SessionStatus,
  
  workspacePath: S.String,
  webUiUrl: S.String,
  
  repository: S.optional(S.Struct({
    url: S.String.pipe(S.startsWith("https://github.com/")),
    branch: S.String,
  })),
  
  config: S.Struct({
    githubTokenConfigured: S.Boolean,
    defaultModel: S.String,
  })
});

export type SessionMetadata = S.Schema.Type<typeof SessionMetadata>;
```

**Run Model:**
```typescript
export const RunStatus = S.Literal(
  "queued",
  "running",
  "completed", 
  "failed",
  "retrying"
);

export const RunResult = S.Struct({
  success: S.Boolean,
  output: S.optional(S.String),
  error: S.optional(S.String),
  filesCreated: S.Array(S.String),
  filesModified: S.Array(S.String),
  commits: S.Array(S.String),
  branch: S.optional(S.String),
});

export const RunRecord = S.Struct({
  runId: S.String,
  workflowId: S.String,
  status: RunStatus,
  
  task: S.String,
  model: S.String,
  
  startedAt: S.Number,
  completedAt: S.optional(S.Number),
  
  result: S.optional(RunResult),
  
  retryCount: S.Number,
  maxRetries: S.Number,
});

export type RunRecord = S.Schema.Type<typeof RunRecord>;
```

**MCP Tool Input/Output Schemas:**
```typescript
// Tool inputs
export const CreateSessionInput = S.Struct({
  sessionId: S.optional(S.String.pipe(
    S.pattern(/^[a-z0-9-]+$/),
    S.maxLength(64)
  )),
  repositoryUrl: S.optional(S.String.pipe(
    S.startsWith("https://github.com/")
  )),
  branch: S.optional(S.String),
  directory: S.optional(S.String),
  title: S.optional(S.String),
});

export const RunTaskInput = S.Struct({
  sessionId: S.String,
  task: S.String.pipe(S.maxLength(50000)),
  model: S.optional(S.String),
});

export const GetStatusInput = S.Struct({
  sessionId: S.String,
  runId: S.optional(S.String),
  includeGitStatus: S.optional(S.Boolean),
});

// Tool outputs
export const CreateSessionOutput = S.Struct({
  sessionId: S.String,
  sandboxId: S.String,
  webUiUrl: S.String,
  status: S.Literal("created", "resumed"),
  workspacePath: S.String,
  repository: S.optional(S.Struct({
    url: S.String,
    branch: S.String,
  })),
});

// ... similar for other tools
```

**Files to create:**
- `src/models/session.model.ts`
- `src/models/run.model.ts`
- `src/models/tool-schemas.model.ts`
- `src/models/*.test.ts` - Schema validation tests

**Success criteria:**
- ✅ All models use Effect Schema
- ✅ Runtime validation with `S.decodeUnknown`
- ✅ Type inference with `S.Schema.Type<>`
- ✅ Tests verify schema parsing (valid + invalid cases)

---

### 1.4 Internal Utilities (effect-cloudflare pattern)

**Goal:** Create CF-specific utilities following effect-cloudflare patterns

**ExecutionContext Wrapper:**
```typescript
// src/internal/context.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface CloudflareExecutionContext {
  readonly waitUntil: <A, E>(effect: Effect.Effect<A, E>) => void;
  readonly passThroughOnException: Effect.Effect<void>;
  readonly ["~raw"]: globalThis.ExecutionContext;
}

export const makeExecutionContext = (
  ctx: globalThis.ExecutionContext
): CloudflareExecutionContext => ({
  waitUntil: <A, E>(effect: Effect.Effect<A, E>) => {
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.asVoid
        )
      )
    );
  },
  passThroughOnException: Effect.sync(() => ctx.passThroughOnException?.()),
  ["~raw"]: ctx,
});

export class ExecutionContext extends Context.Tag(
  "@opencode-mcp/ExecutionContext"
)<ExecutionContext, CloudflareExecutionContext>() {}

export const layer = (ctx: globalThis.ExecutionContext) =>
  Layer.succeed(ExecutionContext, makeExecutionContext(ctx));
```

**Environment Wrapper:**
```typescript
// src/internal/env.ts
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export interface CloudflareEnv {
  readonly GITHUB_TOKEN: string;
  readonly GIT_AUTHOR_NAME: string;
  readonly GIT_AUTHOR_EMAIL: string;
  readonly ENVIRONMENT: "development" | "production";
  
  // Bindings (raw CF types, wrapped in services)
  readonly ["~raw"]: Env;
}

export const makeEnv = (env: Env): CloudflareEnv => ({
  GITHUB_TOKEN: env.GITHUB_TOKEN,
  GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || "OpenCode Bot",
  GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || "bot@opencode.dev",
  ENVIRONMENT: (env.ENVIRONMENT || "development") as "development" | "production",
  ["~raw"]: env,
});

export class Env extends Context.Tag("@opencode-mcp/Env")<Env, CloudflareEnv>() {}

export const layer = (env: Env) =>
  Layer.succeed(Env, makeEnv(env));
```

**Files to create:**
- `src/internal/context.ts`
- `src/internal/env.ts`
- `src/internal/worker.ts` (Worker entry point helper)

---

### 1.5 Logger Layer

**Goal:** Create Effect logger with Cloudflare-specific formatting

**Implementation:**
```typescript
// src/layers/logger.layer.ts
import { Logger, LogLevel } from "effect";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { Env } from "../internal/env";

// Production: Structured JSON logging for Cloudflare
const CloudflareLoggerLive = Layer.succeed(
  Logger.Logger,
  Logger.make(({ logLevel, message, cause, context, spans, annotations }) => {
    const structuredLog = {
      level: logLevel.label,
      message: message,
      timestamp: new Date().toISOString(),
      ...context,
      ...(cause && { 
        error: {
          message: cause.message,
          stack: cause.stack,
        }
      }),
      ...(spans.length > 0 && { 
        spans: spans.map(span => ({
          label: span.label,
          timing: span.timing
        }))
      }),
    };
    
    // Cloudflare's console.log captures structured data
    console.log(JSON.stringify(structuredLog));
  })
);

// Development: Pretty console output
const DevelopmentLoggerLive = Logger.pretty;

// Switch based on environment
export const LoggerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const env = yield* Env;
    
    return env.ENVIRONMENT === "production"
      ? CloudflareLoggerLive
      : DevelopmentLoggerLive;
  })
);
```

**Files to create:**
- `src/layers/logger.layer.ts`
- `src/layers/logger.test.ts`

**Success criteria:**
- ✅ Pretty logs in dev (`wrangler dev`)
- ✅ Structured JSON in production
- ✅ Context propagation through Effect fibers
- ✅ Error causes logged automatically

---

## Phase 2: Service Layer Implementation

### 2.1 Storage Service (DO Storage Wrapper)

**Goal:** Wrap Durable Object storage with Effect

**Pattern from effect-cloudflare:**
```typescript
// src/services/storage.service.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "@effect/schema/Schema";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

export class StorageService extends Context.Tag("@opencode-mcp/StorageService")<
  StorageService,
  {
    // Get with schema validation
    readonly get: <A, I, R>(
      key: string,
      schema: Schema.Schema<A, I, R>
    ) => Effect.Effect<Option.Option<A>, StorageReadError, R>;
    
    // Put with schema encoding
    readonly put: <A, I, R>(
      key: string,
      value: A,
      schema: Schema.Schema<A, I, R>
    ) => Effect.Effect<void, StorageWriteError, R>;
    
    // Delete
    readonly delete: (key: string) => Effect.Effect<void, StorageWriteError>;
    
    // List keys
    readonly list: (prefix?: string) => Effect.Effect<
      ReadonlyArray<string>,
      StorageReadError
    >;
    
    // SQL (for SQLite DOs)
    readonly sql: {
      readonly exec: <T>(
        query: string,
        ...params: unknown[]
      ) => Effect.Effect<
        { results: ReadonlyArray<T>; changes: number },
        StorageSQLError
      >;
    };
  }
>() {
  static layer = (storage: DurableObjectStorage) =>
    Layer.succeed(
      StorageService,
      StorageService.of({
        get: (key, schema) =>
          Effect.gen(function* () {
            const raw = yield* Effect.tryPromise({
              try: () => storage.get(key),
              catch: (error) => new StorageReadError({ key, cause: error })
            });
            
            if (raw === undefined) return Option.none();
            
            // Decode with schema
            const decoded = yield* Schema.decodeUnknown(schema)(raw);
            return Option.some(decoded);
          }),
        
        put: (key, value, schema) =>
          Effect.gen(function* () {
            // Encode with schema
            const encoded = yield* Schema.encode(schema)(value);
            
            yield* Effect.tryPromise({
              try: () => storage.put(key, encoded),
              catch: (error) => new StorageWriteError({ key, cause: error })
            });
          }),
        
        // ... other methods
      })
    );
}
```

**Files to create:**
- `src/services/storage.service.ts`
- `src/services/storage.test.ts`

**Success criteria:**
- ✅ Type-safe get/put with schemas
- ✅ Proper error mapping
- ✅ SQL wrapper for SQLite DOs
- ✅ Tests with mocked storage

---

### 2.2 R2 Service

**Goal:** Wrap R2 bucket operations with Effect (following effect-cloudflare pattern)

**Implementation:**
```typescript
// src/services/r2.service.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export class R2Service extends Context.Tag("@opencode-mcp/R2Service")<
  R2Service,
  {
    readonly get: (key: string) => Effect.Effect<
      Option.Option<R2ObjectBody>,
      R2GetError
    >;
    
    readonly put: (
      key: string,
      value: ReadableStream | ArrayBuffer | string
    ) => Effect.Effect<Option.Option<R2Object>, R2PutError>;
    
    readonly delete: (key: string) => Effect.Effect<void, R2DeleteError>;
    
    readonly list: (prefix: string) => Effect.Effect<
      R2Objects,
      R2ListError
    >;
  }
>() {
  static layer = (bucket: R2Bucket) =>
    Layer.succeed(
      R2Service,
      R2Service.of({
        get: (key) =>
          Effect.tryPromise({
            try: async () => {
              const result = await bucket.get(key);
              return result === null ? Option.none() : Option.some(result);
            },
            catch: (error) => new R2GetError({ key, cause: error })
          }),
        
        put: (key, value) =>
          Effect.tryPromise({
            try: async () => {
              const result = await bucket.put(key, value);
              return result === null ? Option.none() : Option.some(result);
            },
            catch: (error) => new R2PutError({ key, cause: error })
          }),
        
        // ... other methods
      })
    );
}
```

**Note:** Can borrow heavily from `/home/ghost_000/github/effect-cloudflare/src/internal/r2-bucket.ts`

**Files to create:**
- `src/services/r2.service.ts`
- `src/services/r2.test.ts`

**Success criteria:**
- ✅ All R2 operations wrapped with Effect
- ✅ `Option` for nullable returns
- ✅ Comprehensive error mapping
- ✅ Tests with mocked R2

---

### 2.3 Sandbox Service

**Goal:** Wrap Cloudflare Sandbox SDK with Effect

**Implementation:**
```typescript
// src/services/sandbox.service.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { getSandbox } from "@cloudflare/sandbox";

export class SandboxService extends Context.Tag("@opencode-mcp/SandboxService")<
  SandboxService,
  {
    readonly createSandbox: (
      sandboxId: string
    ) => Effect.Effect<Sandbox, SandboxStartupError>;
    
    readonly mountR2: (
      sandbox: Sandbox,
      sessionId: string
    ) => Effect.Effect<void, R2MountError>;
    
    readonly setupGitCredentials: (
      sandbox: Sandbox
    ) => Effect.Effect<void, SandboxConfigError>;
    
    readonly cloneRepository: (
      sandbox: Sandbox,
      url: string,
      branch?: string
    ) => Effect.Effect<void, RepositoryCloneError>;
    
    readonly exposePort: (
      sandbox: Sandbox,
      port: number
    ) => Effect.Effect<string, SandboxError>;
    
    readonly getSandboxStatus: (
      sandboxId: string
    ) => Effect.Effect<
      "active" | "idle" | "stopped",
      SandboxError
    >;
    
    readonly getGitStatus: (
      sandbox: Sandbox
    ) => Effect.Effect<GitStatus, SandboxError>;
  }
>() {
  static layer = (env: Env) =>
    Layer.effect(
      SandboxService,
      Effect.gen(function* () {
        const envService = yield* Env;
        const r2Service = yield* R2Service;
        const logger = yield* Effect.loggerWith;
        
        return SandboxService.of({
          createSandbox: (sandboxId) =>
            Effect.gen(function* () {
              yield* Effect.log("Creating sandbox", { sandboxId });
              
              const sandbox = yield* Effect.try({
                try: () => getSandbox(env["~raw"].Sandbox, sandboxId),
                catch: (error) => new SandboxStartupError({ 
                  sandboxId, 
                  cause: error 
                })
              });
              
              return sandbox;
            }),
          
          mountR2: (sandbox, sessionId) =>
            Effect.gen(function* () {
              yield* Effect.log("Mounting R2 bucket", { sessionId });
              
              yield* Effect.tryPromise({
                try: () => sandbox.mountBucket(
                  'opencode-sessions',
                  '/workspace',
                  { prefix: `session-${sessionId}/workspace/` }
                ),
                catch: (error) => new R2MountError({ sessionId, cause: error })
              });
            }),
          
          setupGitCredentials: (sandbox) =>
            Effect.gen(function* () {
              const env = yield* Env;
              
              yield* Effect.tryPromise({
                try: () => sandbox.setEnvVars({
                  GITHUB_TOKEN: env.GITHUB_TOKEN,
                  GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME,
                  GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL,
                }),
                catch: (error) => new SandboxConfigError({ cause: error })
              });
            }),
          
          cloneRepository: (sandbox, url, branch) =>
            Effect.gen(function* () {
              yield* Effect.log("Cloning repository", { url, branch });
              
              yield* Effect.tryPromise({
                try: () => sandbox.gitCheckout({
                  url,
                  ref: branch,
                  path: '/workspace'
                }),
                catch: (error) => new RepositoryCloneError({ 
                  url, 
                  branch,
                  cause: error 
                })
              }).pipe(
                Effect.timeout("5 minutes"),
                Effect.retry(Schedule.exponential("5 seconds", 2).pipe(
                  Schedule.compose(Schedule.recurs(2))
                ))
              );
            }),
          
          // ... other methods
        });
      })
    );
}
```

**Files to create:**
- `src/services/sandbox.service.ts`
- `src/services/sandbox.test.ts`

**Success criteria:**
- ✅ All Sandbox SDK operations wrapped
- ✅ Timeout and retry logic for network operations
- ✅ Dependency on R2Service and Env
- ✅ Tests with mocked Sandbox

---

### 2.4 OpenCode Service

**Goal:** Wrap OpenCode SDK with Effect

**Implementation:**
```typescript
// src/services/opencode.service.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { createOpencodeServer } from "@cloudflare/sandbox/opencode";

export interface OpenCodeTaskParams {
  readonly sandbox: Sandbox;
  readonly sessionId: string;
  readonly task: string;
  readonly model: string;
}

export interface OpenCodeTaskResult {
  readonly success: boolean;
  readonly output: string;
  readonly filesCreated: ReadonlyArray<string>;
  readonly filesModified: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<string>;
  readonly branch: Option.Option<string>;
}

export class OpenCodeService extends Context.Tag("@opencode-mcp/OpenCodeService")<
  OpenCodeService,
  {
    readonly startServer: (
      sandbox: Sandbox
    ) => Effect.Effect<OpenCodeServer, OpenCodeStartupError>;
    
    readonly executeTask: (
      params: OpenCodeTaskParams
    ) => Effect.Effect<OpenCodeTaskResult, OpenCodeExecutionError>;
  }
>() {
  static layer = Layer.effect(
    OpenCodeService,
    Effect.gen(function* () {
      const logger = yield* Effect.loggerWith;
      
      return OpenCodeService.of({
        startServer: (sandbox) =>
          Effect.gen(function* () {
            yield* Effect.log("Starting OpenCode server");
            
            const server = yield* Effect.tryPromise({
              try: () => createOpencodeServer(sandbox, {
                // OpenCode config
              }),
              catch: (error) => new OpenCodeStartupError({ cause: error })
            }).pipe(
              Effect.timeout("2 minutes")
            );
            
            return server;
          }),
        
        executeTask: (params) =>
          Effect.gen(function* () {
            const { sandbox, sessionId, task, model } = params;
            
            yield* Effect.log("Executing OpenCode task", { 
              sessionId, 
              taskLength: task.length 
            });
            
            // Get OpenCode client
            const { client } = yield* Effect.tryPromise({
              try: () => createOpencodeServer(sandbox),
              catch: (error) => new OpenCodeExecutionError({ 
                sessionId,
                cause: error 
              })
            });
            
            // Get or create session
            const session = yield* Effect.tryPromise({
              try: async () => {
                // Try to get existing session, or create new
                try {
                  return await client.session.get(sessionId);
                } catch {
                  return await client.session.create({
                    id: sessionId,
                    model
                  });
                }
              },
              catch: (error) => new OpenCodeExecutionError({ 
                sessionId,
                cause: error 
              })
            });
            
            // Execute task (this is the long-running part)
            const result = yield* Effect.tryPromise({
              try: () => client.session.prompt({
                sessionId: session.id,
                body: {
                  parts: [{ text: task }]
                }
              }),
              catch: (error) => new OpenCodeExecutionError({ 
                sessionId,
                cause: error 
              })
            }).pipe(
              Effect.timeout("50 minutes"), // Leave 10min buffer for workflow
              Effect.tapError(err => 
                Effect.log("OpenCode task failed", { error: err })
              )
            );
            
            // Parse result (extract files changed, commits, etc.)
            const parsed = yield* parseOpenCodeResult(result);
            
            return parsed;
          }),
      });
    })
  );
}
```

**Files to create:**
- `src/services/opencode.service.ts`
- `src/services/opencode.test.ts`

**Success criteria:**
- ✅ Server startup with timeout
- ✅ Task execution with timeout (50min)
- ✅ Result parsing
- ✅ Error handling for all failure modes

---

### 2.5 Workflow Service

**Goal:** Wrap Cloudflare Workflows API with Effect

**Implementation:**
```typescript
// src/services/workflow.service.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Workflow } from "@cloudflare/workers-types";

export interface WorkflowTaskParams {
  readonly sessionId: string;
  readonly sandboxId: string;
  readonly task: string;
  readonly model: string;
  readonly runId: string;
}

export class WorkflowService extends Context.Tag("@opencode-mcp/WorkflowService")<
  WorkflowService,
  {
    readonly createTaskWorkflow: (
      params: WorkflowTaskParams
    ) => Effect.Effect<WorkflowInstance, WorkflowCreationError>;
    
    readonly getWorkflowStatus: (
      workflowId: string
    ) => Effect.Effect<WorkflowStatus, WorkflowError>;
  }
>() {
  static layer = (env: Env) =>
    Layer.succeed(
      WorkflowService,
      WorkflowService.of({
        createTaskWorkflow: (params) =>
          Effect.gen(function* () {
            yield* Effect.log("Creating workflow", { runId: params.runId });
            
            const workflow = yield* Effect.tryPromise({
              try: () => env["~raw"].OPENCODE_WORKFLOW.create({
                id: params.runId,
                params
              }),
              catch: (error) => new WorkflowCreationError({ 
                runId: params.runId,
                cause: error 
              })
            });
            
            return {
              id: workflow.id,
              status: "running" as const
            };
          }),
        
        getWorkflowStatus: (workflowId) =>
          Effect.gen(function* () {
            const workflow = yield* Effect.try({
              try: () => env["~raw"].OPENCODE_WORKFLOW.get(workflowId),
              catch: (error) => new WorkflowError({ workflowId, cause: error })
            });
            
            const status = yield* Effect.tryPromise({
              try: () => workflow.status(),
              catch: (error) => new WorkflowError({ workflowId, cause: error })
            });
            
            return status;
          }),
      })
    );
}
```

**Files to create:**
- `src/services/workflow.service.ts`
- `src/services/workflow.test.ts`

**Success criteria:**
- ✅ Workflow creation wrapped
- ✅ Status queries wrapped
- ✅ Error handling
- ✅ Tests with mocked Workflow binding

---

### 2.6 Session Service (Orchestration)

**Goal:** High-level session management orchestrating all services

**Implementation:**
```typescript
// src/services/session.service.ts
export class SessionService extends Context.Tag("@opencode-mcp/SessionService")<
  SessionService,
  {
    readonly createSession: (
      params: CreateSessionParams
    ) => Effect.Effect<
      SessionMetadata,
      SessionCreationError | RepositoryCloneError | SandboxStartupError,
      SandboxService | R2Service | StorageService
    >;
    
    readonly getSession: (
      sessionId: string
    ) => Effect.Effect<SessionMetadata, SessionNotFoundError, StorageService>;
    
    readonly updateSession: (
      sessionId: string,
      updates: Partial<SessionMetadata>
    ) => Effect.Effect<void, StorageWriteError, StorageService>;
  }
>() {
  static layer = Layer.effect(
    SessionService,
    Effect.gen(function* () {
      return SessionService.of({
        createSession: (params) =>
          Effect.gen(function* () {
            const sandboxService = yield* SandboxService;
            const storageService = yield* StorageService;
            
            // Generate session ID if not provided
            const sessionId = params.sessionId ?? crypto.randomUUID();
            
            // Check if session already exists
            const existing = yield* storageService.get(
              `session:${sessionId}`,
              SessionMetadata
            ).pipe(Effect.ignore);
            
            if (Option.isSome(existing)) {
              // Resume existing session
              yield* Effect.log("Resuming session", { sessionId });
              return existing.value;
            }
            
            // Create new session
            yield* Effect.log("Creating new session", { sessionId });
            
            // Create sandbox
            const sandbox = yield* sandboxService.createSandbox(sessionId);
            
            // Mount R2
            yield* sandboxService.mountR2(sandbox, sessionId);
            
            // Setup git credentials
            yield* sandboxService.setupGitCredentials(sandbox);
            
            // Clone repository if provided
            if (params.repositoryUrl) {
              yield* sandboxService.cloneRepository(
                sandbox,
                params.repositoryUrl,
                params.branch
              );
            }
            
            // Start OpenCode server
            const opencodeService = yield* OpenCodeService;
            yield* opencodeService.startServer(sandbox);
            
            // Expose web UI
            const webUiUrl = yield* sandboxService.exposePort(sandbox, 4096);
            
            // Create metadata
            const metadata: SessionMetadata = {
              sessionId,
              sandboxId: sessionId, // 1:1 mapping
              createdAt: Date.now(),
              lastActivity: Date.now(),
              status: "active",
              workspacePath: "/workspace",
              webUiUrl,
              repository: params.repositoryUrl ? {
                url: params.repositoryUrl,
                branch: params.branch ?? "main"
              } : undefined,
              config: {
                githubTokenConfigured: true,
                defaultModel: "claude-haiku-4-5"
              }
            };
            
            // Save to storage
            yield* storageService.put(
              `session:${sessionId}`,
              metadata,
              SessionMetadata
            );
            
            return metadata;
          }).pipe(
            Effect.tapError(err => 
              Effect.log("Session creation failed", { error: err })
            )
          ),
        
        // ... other methods
      });
    })
  );
}
```

**Files to create:**
- `src/services/session.service.ts`
- `src/services/session.test.ts`

**Success criteria:**
- ✅ Complete session lifecycle
- ✅ Idempotent (can call create multiple times)
- ✅ Orchestrates all lower-level services
- ✅ Comprehensive error handling

---

### 2.7 Task Service

**Goal:** Task execution orchestration

**Implementation:**
```typescript
// src/services/task.service.ts
export class TaskService extends Context.Tag("@opencode-mcp/TaskService")<
  TaskService,
  {
    readonly startTask: (
      params: StartTaskParams
    ) => Effect.Effect<
      { runId: string; workflowId: string },
      WorkflowCreationError | SessionNotFoundError,
      SessionService | WorkflowService | StorageService
    >;
    
    readonly getTaskStatus: (
      runId: string
    ) => Effect.Effect<RunRecord, StorageReadError, StorageService>;
    
    readonly markTaskComplete: (
      runId: string,
      result: RunResult
    ) => Effect.Effect<void, StorageWriteError, StorageService>;
  }
>() {
  static layer = Layer.effect(
    TaskService,
    Effect.gen(function* () {
      return TaskService.of({
        startTask: (params) =>
          Effect.gen(function* () {
            const sessionService = yield* SessionService;
            const workflowService = yield* WorkflowService;
            const storageService = yield* StorageService;
            
            // Validate session exists
            const session = yield* sessionService.getSession(params.sessionId);
            
            // Generate run ID
            const runId = `run-${crypto.randomUUID()}`;
            
            // Create workflow
            const workflow = yield* workflowService.createTaskWorkflow({
              sessionId: params.sessionId,
              sandboxId: session.sandboxId,
              task: params.task,
              model: params.model ?? session.config.defaultModel,
              runId
            });
            
            // Create run record
            const runRecord: RunRecord = {
              runId,
              workflowId: workflow.id,
              status: "running",
              task: params.task,
              model: params.model ?? session.config.defaultModel,
              startedAt: Date.now(),
              retryCount: 0,
              maxRetries: 3
            };
            
            // Save run record
            yield* storageService.put(
              `run:${runId}`,
              runRecord,
              RunRecord
            );
            
            // Add to session's run list
            yield* Effect.log("Task started", { runId, sessionId: params.sessionId });
            
            return { runId, workflowId: workflow.id };
          }),
        
        // ... other methods
      });
    })
  );
}
```

**Files to create:**
- `src/services/task.service.ts`
- `src/services/task.test.ts`

---

## Phase 3: Workflow Implementation

### 3.1 Task Execution Workflow

**Goal:** Implement the Workflow that executes OpenCode tasks

**Key insight:** Workflows provide orchestration, Effect provides business logic

**Implementation:**
```typescript
// src/workflows/execute-task.workflow.ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import { WorkflowTaskParams } from "../services/workflow.service";

export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, WorkflowTaskParams> {
  async run(
    event: WorkflowEvent<WorkflowTaskParams>,
    step: WorkflowStep
  ): Promise<OpenCodeTaskResult> {
    const { sessionId, sandboxId, task, model, runId } = event.payload;
    
    // Build runtime for this workflow execution
    const runtime = this.buildRuntime();
    
    // Step 1: Get sandbox instance
    const sandbox = await step.do("get-sandbox", async () => {
      return Effect.runPromise(
        Effect.gen(function* () {
          const sandboxService = yield* SandboxService;
          return yield* sandboxService.createSandbox(sandboxId);
        }).pipe(
          Effect.provide(runtime)
        )
      );
    });
    
    // Step 2: Execute OpenCode task (the long-running part)
    const result = await step.do("execute-opencode-task", async () => {
      return Effect.runPromise(
        Effect.gen(function* () {
          const opencodeService = yield* OpenCodeService;
          
          return yield* opencodeService.executeTask({
            sandbox,
            sessionId,
            task,
            model
          }).pipe(
            Effect.retry(
              Schedule.exponential("5 seconds", 2).pipe(
                Schedule.compose(Schedule.recurs(2))
              )
            ),
            Effect.timeout("50 minutes"),
            Effect.tapError(err => 
              Effect.log("OpenCode execution failed", { error: err })
            )
          );
        }).pipe(
          Effect.provide(runtime)
        )
      );
    });
    
    // Step 3: Report completion back to DO
    await step.do("report-completion", async () => {
      return Effect.runPromise(
        Effect.gen(function* () {
          const storageService = yield* StorageService;
          
          // Update run record
          yield* storageService.put(
            `run:${runId}`,
            {
              runId,
              status: "completed",
              completedAt: Date.now(),
              result
            },
            RunRecord
          );
          
          yield* Effect.log("Task completed", { runId });
        }).pipe(
          Effect.provide(runtime)
        )
      );
    });
    
    return result;
  }
  
  // Helper to build Effect runtime with all services
  private buildRuntime() {
    const layer = Layer.mergeAll(
      LoggerLive,
      Env.layer(this.env),
      SandboxService.layer(this.env),
      OpenCodeService.layer,
      // ... other services
    );
    
    return Runtime.defaultRuntime.pipe(
      Runtime.provide(layer)
    );
  }
}
```

**Files to create:**
- `src/workflows/execute-task.workflow.ts`
- `src/workflows/execute-task.test.ts`

**Success criteria:**
- ✅ Step-based execution
- ✅ Effect programs run within each step
- ✅ Automatic retries via Effect
- ✅ Proper timeout handling
- ✅ Error reporting back to DO

---

## Phase 4: MCP Agent (Durable Object)

### 4.1 McpAgent with Effect Runtime

**Goal:** Implement the MCP Agent as a Durable Object with Effect runtime

**Pattern:**
```typescript
// src/agent/opencode-mcp-agent.ts
import { McpAgent } from "@cloudflare/agents";
import * as Runtime from "effect/Runtime";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

export class OpencodeMcpAgent extends McpAgent<Env> {
  private runtime: Runtime.Runtime<
    SandboxService | OpenCodeService | StorageService | WorkflowService
  >;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    // Build Effect runtime with all services
    const layer = Layer.mergeAll(
      LoggerLive,
      Env.layer(env),
      ExecutionContext.layer(ctx), // Not available in DO, but conceptually
      StorageService.layer(ctx.storage),
      SandboxService.layer(env),
      OpenCodeService.layer,
      WorkflowService.layer(env),
      SessionService.layer,
      TaskService.layer
    );
    
    this.runtime = Runtime.defaultRuntime.pipe(
      Runtime.provide(layer)
    );
  }
  
  // Initialize MCP server tools
  async init() {
    // Tool 1: Create Session
    this.server.tool(
      "opencode_create_session",
      "Create or resume an OpenCode coding session",
      CreateSessionInput,
      async (input) => {
        return this.runEffect(
          Effect.gen(function* () {
            const sessionService = yield* SessionService;
            
            const session = yield* sessionService.createSession(input).pipe(
              Effect.catchAll(err => 
                Effect.gen(function* () {
                  yield* Effect.logError("Session creation failed", { error: err });
                  return yield* Effect.fail(err);
                })
              )
            );
            
            // Convert to output schema
            return {
              sessionId: session.sessionId,
              sandboxId: session.sandboxId,
              webUiUrl: session.webUiUrl,
              status: "created" as const,
              workspacePath: session.workspacePath,
              repository: session.repository
            };
          })
        );
      }
    );
    
    // Tool 2: Run Task
    this.server.tool(
      "opencode_run_task",
      "Execute a coding task asynchronously",
      RunTaskInput,
      async (input) => {
        return this.runEffect(
          Effect.gen(function* () {
            const taskService = yield* TaskService;
            const sessionService = yield* SessionService;
            
            const { runId, workflowId } = yield* taskService.startTask(input);
            
            // Get web UI URL from session
            const session = yield* sessionService.getSession(input.sessionId);
            
            return {
              runId,
              status: "started" as const,
              webUiUrl: session.webUiUrl,
              message: "Task started successfully. OpenCode is working on it autonomously. You can check status anytime with opencode_get_status, or visit the web UI to watch progress in real-time."
            };
          })
        );
      }
    );
    
    // Tool 3: Get Status
    this.server.tool(
      "opencode_get_status",
      "Check session and task status",
      GetStatusInput,
      async (input) => {
        return this.runEffect(
          Effect.gen(function* () {
            const sessionService = yield* SessionService;
            const taskService = yield* TaskService;
            const sandboxService = yield* SandboxService;
            
            // Get session metadata
            const session = yield* sessionService.getSession(input.sessionId);
            
            // Get sandbox status
            const sandboxStatus = yield* sandboxService.getSandboxStatus(
              session.sandboxId
            ).pipe(
              Effect.catchAll(() => Effect.succeed("stopped" as const))
            );
            
            // Get git status if sandbox is active
            const gitStatus = yield* Effect.if(
              sandboxStatus === "active" && input.includeGitStatus !== false,
              {
                onTrue: () => sandboxService.getGitStatus(sandbox),
                onFalse: () => Effect.succeed(Option.none())
              }
            );
            
            // Get recent runs (last 10)
            const recentRuns = yield* getRecentRuns(input.sessionId, 10);
            
            // Get specific run if requested
            const currentRun = input.runId
              ? yield* taskService.getTaskStatus(input.runId).pipe(
                  Effect.map(Option.some),
                  Effect.catchAll(() => Effect.succeed(Option.none()))
                )
              : Option.none();
            
            return {
              sessionId: session.sessionId,
              webUiUrl: session.webUiUrl,
              sandboxStatus,
              workspacePath: session.workspacePath,
              createdAt: session.createdAt,
              lastActivity: session.lastActivity,
              repository: session.repository,
              gitStatus: Option.getOrUndefined(gitStatus),
              recentRuns,
              currentRun: Option.getOrUndefined(currentRun)
            };
          })
        );
      }
    );
  }
  
  // Helper to run Effect programs from MCP tool handlers
  private async runEffect<A, E>(
    effect: Effect.Effect<A, E, any>
  ): Promise<A> {
    return Runtime.runPromise(this.runtime)(
      effect.pipe(
        Effect.tapError(error => 
          Effect.logError("Tool execution failed", { error })
        )
      )
    );
  }
}
```

**Files to create:**
- `src/agent/opencode-mcp-agent.ts`
- `src/agent/opencode-mcp-agent.test.ts`

**Success criteria:**
- ✅ DO extends McpAgent
- ✅ ManagedRuntime created in constructor
- ✅ All tools registered in `init()`
- ✅ Effect programs run via `runtime.runPromise()`
- ✅ Errors logged automatically

---

## Phase 5: Tool Handlers (Separated for Clarity)

### 5.1 Individual Tool Handlers

**Goal:** Extract tool logic into separate modules for testability

Each tool gets its own file with pure Effect programs:

**Example:**
```typescript
// src/tools/create-session.tool.ts
export const createSessionTool = (input: CreateSessionInput) =>
  Effect.gen(function* () {
    const sessionService = yield* SessionService;
    
    const session = yield* sessionService.createSession(input).pipe(
      Effect.catchTags({
        RepositoryCloneError: (err) =>
          Effect.gen(function* () {
            yield* Effect.logError("Repository clone failed", { error: err });
            // Could retry with different branch, or fail
            return yield* Effect.fail(err);
          }),
        
        SandboxStartupError: (err) =>
          Effect.gen(function* () {
            yield* Effect.logError("Sandbox startup failed", { error: err });
            // Retry once
            yield* Effect.sleep("5 seconds");
            return yield* sessionService.createSession(input);
          })
      }),
      Effect.timeout("10 minutes")
    );
    
    return {
      sessionId: session.sessionId,
      sandboxId: session.sandboxId,
      webUiUrl: session.webUiUrl,
      status: "created" as const,
      workspacePath: session.workspacePath,
      repository: session.repository
    };
  });
```

**Files to create:**
- `src/tools/create-session.tool.ts`
- `src/tools/run-task.tool.ts`
- `src/tools/get-status.tool.ts`
- `src/tools/*.test.ts`

**Success criteria:**
- ✅ Pure Effect programs (no side effects at top level)
- ✅ Comprehensive error handling with `catchTags`
- ✅ Timeout and retry logic
- ✅ Testable in isolation

---

## Phase 6: Layer Composition

### 6.1 Application Layer

**Goal:** Compose all service layers into a single application layer

**Implementation:**
```typescript
// src/layers/app.layer.ts
import * as Layer from "effect/Layer";
import { LoggerLive } from "./logger.layer";
import { SandboxService } from "../services/sandbox.service";
import { OpenCodeService } from "../services/opencode.service";
import { WorkflowService } from "../services/workflow.service";
import { SessionService } from "../services/session.service";
import { TaskService } from "../services/task.service";

// Layer dependency graph (Effect resolves automatically)
export const AppLayer = Layer.mergeAll(
  LoggerLive,
  // Lower-level services
  SandboxService.layer,
  OpenCodeService.layer,
  WorkflowService.layer,
  // Higher-level orchestration
  SessionService.layer,
  TaskService.layer
);

// For Durable Objects (storage injected at runtime)
export const makeDoAppLayer = (
  ctx: DurableObjectState,
  env: Env
) => Layer.mergeAll(
  AppLayer,
  Env.layer(env),
  StorageService.layer(ctx.storage)
);
```

**Files to create:**
- `src/layers/app.layer.ts`

**Success criteria:**
- ✅ All services composed
- ✅ Dependency graph resolves automatically
- ✅ Separate layer builders for Worker vs DO contexts

---

## Phase 7: Worker Entry Point

### 7.1 Worker Handler

**Goal:** Create Worker fetch handler (not used for MCP, but good to have)

**Implementation:**
```typescript
// src/index.ts
import { McpAgent } from "@cloudflare/agents";
import { OpencodeMcpAgent } from "./agent/opencode-mcp-agent";

export { OpencodeMcpAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Health check endpoint
    if (new URL(request.url).pathname === "/health") {
      return new Response("OK", { status: 200 });
    }
    
    // All other requests route to MCP (handled by Agents SDK)
    return new Response("MCP Server - Use MCP client to connect", { status: 200 });
  }
} satisfies ExportedHandler<Env>;
```

**Files to modify:**
- `src/index.ts`

---

## Phase 8: Wrangler Configuration

### 8.1 Configure Bindings

**Goal:** Set up all Cloudflare bindings in wrangler.jsonc

**Configuration:**
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "opencode-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2025-12-21",
  
  // Durable Objects
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["OpencodeMcpAgent"]
    }
  ],
  
  "durable_objects": {
    "bindings": [
      {
        "class_name": "OpencodeMcpAgent",
        "name": "OPENCODE_MCP_AGENT",
        "script_name": "opencode-mcp"
      }
    ]
  },
  
  // R2 Bucket
  "r2_buckets": [
    {
      "binding": "OPENCODE_SESSIONS",
      "bucket_name": "opencode-sessions"
    }
  ],
  
  // Workflows
  "workflows": [
    {
      "binding": "OPENCODE_WORKFLOW",
      "class_name": "ExecuteTaskWorkflow",
      "name": "opencode-task-execution"
    }
  ],
  
  // Sandbox binding (Container DO)
  "durable_objects": {
    "bindings": [
      // ... existing OpencodeMcpAgent binding
      {
        "class_name": "Sandbox",
        "name": "Sandbox",
        "script_name": "@cloudflare/sandbox"
      }
    ]
  },
  
  // Environment variables (non-sensitive)
  "vars": {
    "ENVIRONMENT": "development",
    "GIT_AUTHOR_NAME": "OpenCode Bot",
    "GIT_AUTHOR_EMAIL": "bot@opencode.dev"
  },
  
  // Observability
  "observability": {
    "enabled": true
  },
  
  // Logpush (optional, for production)
  // "logpush": true
}
```

**Files to modify:**
- `wrangler.jsonc`

**Secrets to configure:**
```bash
# Set GitHub token (don't commit!)
wrangler secret put GITHUB_TOKEN
```

---

## Phase 9: Testing Strategy

### 9.1 Unit Tests (Services)

**Goal:** Test each service in isolation

**Pattern:**
```typescript
// src/services/session.service.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { SessionService } from "./session.service";

describe("SessionService", () => {
  it("should create session successfully", async () => {
    const program = Effect.gen(function* () {
      const sessionService = yield* SessionService;
      
      const session = yield* sessionService.createSession({
        sessionId: "test-session",
        repositoryUrl: "https://github.com/test/repo"
      });
      
      expect(session.sessionId).toBe("test-session");
      expect(session.status).toBe("active");
    });
    
    // Provide test implementations of dependencies
    await Effect.runPromise(
      program.pipe(
        Effect.provide(TestSessionServiceLayer),
        Effect.provide(TestSandboxServiceLayer),
        Effect.provide(TestStorageServiceLayer)
      )
    );
  });
  
  it("should handle repository clone failure", async () => {
    const program = Effect.gen(function* () {
      const sessionService = yield* SessionService;
      
      const result = yield* sessionService.createSession({
        sessionId: "test",
        repositoryUrl: "https://github.com/invalid/repo"
      }).pipe(
        Effect.flip // Flip to expect failure
      );
      
      expect(result._tag).toBe("RepositoryCloneError");
    });
    
    await Effect.runPromise(
      program.pipe(
        Effect.provide(TestLayerWithFailingClone)
      )
    );
  });
});
```

**Test Layers:**
```typescript
// src/services/__test__/layers.ts
export const TestSandboxServiceLayer = Layer.succeed(
  SandboxService,
  SandboxService.of({
    createSandbox: (id) => Effect.succeed(mockSandbox),
    cloneRepository: () => Effect.void,
    // ... mocked implementations
  })
);
```

**Files to create:**
- Tests for all services
- Shared test utilities and layers
- `src/services/__test__/layers.ts` - Test service implementations

---

### 9.2 Integration Tests (MCP Agent)

**Goal:** Test complete MCP tool invocations

**Pattern:**
```typescript
// src/agent/opencode-mcp-agent.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("OpencodeMcpAgent", () => {
  it("should create session via MCP tool", async () => {
    const id = env.OPENCODE_MCP_AGENT.idFromName("test-agent");
    const agent = env.OPENCODE_MCP_AGENT.get(id);
    
    await agent.init();
    
    const result = await agent.invokeTool("opencode_create_session", {
      sessionId: "test-session",
      repositoryUrl: "https://github.com/test/repo"
    });
    
    expect(result.sessionId).toBe("test-session");
    expect(result.status).toBe("created");
  });
});
```

**Files to create:**
- `src/agent/opencode-mcp-agent.test.ts`

---

### 9.3 Workflow Tests

**Goal:** Test workflow execution

**Pattern:**
```typescript
// src/workflows/execute-task.workflow.test.ts
describe("ExecuteTaskWorkflow", () => {
  it("should execute OpenCode task", async () => {
    const workflow = env.OPENCODE_WORKFLOW.get("test-run");
    
    const result = await workflow.run({
      sessionId: "test-session",
      sandboxId: "test-sandbox",
      task: "Add a README file",
      model: "claude-haiku-4-5",
      runId: "test-run"
    });
    
    expect(result.success).toBe(true);
    expect(result.filesCreated).toContain("README.md");
  });
});
```

**Files to create:**
- `src/workflows/execute-task.test.ts`

---

## Phase 10: Documentation & Developer Experience

### 10.1 Type Generation

**Goal:** Generate Worker types for IDE support

**Setup:**
```bash
npm run cf-typegen
```

This generates `worker-configuration.d.ts` with all bindings typed.

---

### 10.2 README

**Goal:** Document setup, development, and deployment

**Sections:**
- Project overview
- Prerequisites (Cloudflare account, GitHub token)
- Installation
- Configuration (secrets setup)
- Development (`npm run dev`)
- Testing (`npm run test`)
- Deployment (`npm run deploy`)
- Usage examples (connecting MCP clients)

**Files to create:**
- `README.md`

---

## Phase 11: Local Development & Testing

### 11.1 Local Development Setup

**Challenges:**
- Sandboxes may not work locally (require deployed environment)
- Workflows may not work in `wrangler dev`
- R2 works with Miniflare

**Strategy:**
1. **Unit tests:** Mock all external services
2. **Integration tests:** Use `wrangler dev --remote` for real bindings
3. **E2E tests:** Deploy to preview environment

**Development workflow:**
```bash
# Local dev (mocked services)
npm run dev

# Remote dev (real bindings)
npm run dev:remote

# Tests (unit tests with mocks)
npm run test

# Tests (integration with real services)
npm run test:integration
```

---

## Phase 12: Deployment & Production

### 12.1 Production Deployment

**Steps:**
1. Create R2 bucket: `wrangler r2 bucket create opencode-sessions`
2. Set secrets: `wrangler secret put GITHUB_TOKEN`
3. Deploy: `npm run deploy`
4. Test deployed MCP server

**Monitoring:**
- Enable Cloudflare Logpush (optional)
- Monitor DO duration costs
- Monitor Workflow execution costs
- Monitor Sandbox usage

---

## Implementation Order (Dependency Graph)

```
Phase 1: Foundation
  ├─ 1.1 Project setup
  ├─ 1.2 Error models
  ├─ 1.3 Data models
  ├─ 1.4 Internal utilities
  └─ 1.5 Logger layer

Phase 2: Services (can be parallelized)
  ├─ 2.1 Storage Service
  ├─ 2.2 R2 Service
  ├─ 2.3 Sandbox Service (depends on R2)
  ├─ 2.4 OpenCode Service
  ├─ 2.5 Workflow Service
  ├─ 2.6 Session Service (depends on Sandbox, R2, Storage)
  └─ 2.7 Task Service (depends on Session, Workflow, Storage)

Phase 3: Workflows
  └─ 3.1 Execute Task Workflow (depends on all services)

Phase 4: MCP Agent
  └─ 4.1 OpencodeMcpAgent (depends on all services)

Phase 5: Tool Handlers
  ├─ 5.1 Create Session Tool
  ├─ 5.2 Run Task Tool
  └─ 5.3 Get Status Tool

Phase 6: Layer Composition
  └─ 6.1 App Layer (composes all service layers)

Phase 7: Entry Points
  └─ 7.1 Worker handler

Phase 8: Configuration
  └─ 8.1 Wrangler bindings

Phase 9: Testing
  ├─ 9.1 Unit tests
  ├─ 9.2 Integration tests
  └─ 9.3 Workflow tests

Phase 10: Documentation
  ├─ 10.1 Type generation
  └─ 10.2 README

Phase 11: Local Dev
  └─ 11.1 Dev setup & workflows

Phase 12: Production
  └─ 12.1 Deployment
```

---

## Key Principles (Effect-First Architecture)

### 1. **Errors in Types**
Every function signature explicitly declares what can fail:
```typescript
const createSession: Effect.Effect<
  Session,           // Success
  SessionError       // Errors (exhaustive!)
    | SandboxError
    | RepositoryError,
  SessionService     // Requirements
    | SandboxService
>
```

### 2. **Services via Layers**
All dependencies managed via Effect's Layer system:
```typescript
const layer = Layer.mergeAll(
  LoggerLive,
  SandboxService.layer,
  SessionService.layer  // Auto-depends on SandboxService
);
```

### 3. **Effect Generators for Async**
Use `Effect.gen` for async code (like async/await but better):
```typescript
Effect.gen(function* () {
  const service = yield* MyService;
  const result = yield* service.doThing();
  return result;
})
```

### 4. **Tagged Errors**
Use `Schema.TaggedError` for all error types:
```typescript
class MyError extends Schema.TaggedError<MyError>(
  "@opencode-mcp/MyError"
)("MyError", { field: Schema.String }) {}
```

### 5. **Option Instead of Null**
Use `Option.none()` and `Option.some()` instead of null:
```typescript
const result = yield* service.get(key);
if (Option.isSome(result)) {
  console.log(result.value);
}
```

### 6. **Retry & Timeout Everywhere**
Network operations get retry + timeout:
```typescript
operation.pipe(
  Effect.retry(Schedule.exponential("5 seconds")),
  Effect.timeout("10 minutes")
)
```

### 7. **Logging via Effect**
Use `Effect.log` instead of console.log:
```typescript
yield* Effect.log("Creating session", { sessionId });
```

### 8. **Test with Effect Test Context**
Provide test layers for deterministic testing:
```typescript
await Effect.runPromise(
  program.pipe(Effect.provide(TestLayer))
);
```

---

## Validation Checklist

Before considering a phase complete:

- [ ] All functions have explicit error types
- [ ] All async operations use `Effect.tryPromise`
- [ ] All network calls have timeout + retry
- [ ] All services follow Tag + Layer + Combinator pattern
- [ ] All errors extend `Schema.TaggedError`
- [ ] All data uses Effect Schema
- [ ] All logging uses `Effect.log`
- [ ] All nulls replaced with `Option`
- [ ] All tests provide mock layers
- [ ] TypeScript compiles with no errors (strict mode)
- [ ] Oxlint passes with no warnings
- [ ] All code has JSDoc comments

---

## Critical Path (MVP - Minimum Viable Product)

For a working V1, we need:

1. **Errors** (Phase 1.2) - Foundation for everything
2. **Models** (Phase 1.3) - Data structures
3. **Storage Service** (Phase 2.1) - DO persistence
4. **Sandbox Service** (Phase 2.3) - Core functionality
5. **OpenCode Service** (Phase 2.4) - Core functionality
6. **Session Service** (Phase 2.6) - Orchestration
7. **MCP Agent** (Phase 4.1) - Entry point
8. **Create Session Tool** (Phase 5.1) - First tool
9. **Wrangler Config** (Phase 8.1) - Deployment

**Estimated MVP timeline:** 3-5 days of focused work

**Full implementation:** 1-2 weeks

---

## Risk Mitigation

### Risk 1: Effect Learning Curve
- **Mitigation:** Reference effect-cloudflare heavily, start simple
- **Fallback:** Use Effect generators (familiar async/await style)

### Risk 2: Workflow + Effect Integration
- **Mitigation:** Keep Effect programs inside workflow steps (clear boundary)
- **Testing:** Test Effect programs separately from Workflow orchestration

### Risk 3: Bundle Size
- **Mitigation:** Effect tree-shakes well, Cloudflare has generous limits
- **Monitoring:** Check bundle size with `wrangler deploy --dry-run`

### Risk 4: Sandbox/Workflow Not Working Locally
- **Mitigation:** Use `--remote` flag for testing
- **Alternative:** Deploy to preview environment frequently

### Risk 5: R2 Mounting Edge Cases
- **Mitigation:** Test thoroughly with real repos, monitor logs
- **Fallback:** Provide clear error messages for debugging

---

## Success Metrics

### V1 Success Criteria:
- ✅ Can create OpenCode session from MCP client
- ✅ Can run task asynchronously
- ✅ Can check status and see results
- ✅ Can access web UI
- ✅ Sessions persist across sandbox restarts
- ✅ Git credentials work (can clone private repos)
- ✅ Errors are well-typed and informative
- ✅ All tests pass
- ✅ Successfully deployed to production

### V2 Success Criteria (Future):
- Multiple concurrent sessions per user
- Task cancellation
- Session expiration
- Cost monitoring/limits
- Multi-user support

---

## Reference Implementation Guide

### When to reference effect-cloudflare:

| Our Code | Reference |
|----------|-----------|
| Error modeling | `/home/ghost_000/github/effect-cloudflare/src/internal/kv-namespace.ts` (lines 1-820) |
| Service pattern | `/home/ghost_000/github/effect-cloudflare/src/internal/r2-bucket.ts` (Tag + Layer) |
| Worker entry point | `/home/ghost_000/github/effect-cloudflare/src/internal/worker.ts` |
| ExecutionContext | `/home/ghost_000/github/effect-cloudflare/src/internal/context.ts` |
| Error mapping | `mapError` functions in all service files |

### Effect Documentation References:

- **Services & Layers:** https://effect.website/docs/requirements-management/layers/
- **Error Handling:** https://effect.website/docs/error-management/expected-errors/
- **Retry Logic:** https://effect.website/docs/error-management/retrying/
- **Schemas:** https://effect.website/docs/schema/getting-started/
- **Testing:** https://effect.website/docs/testing/testclock/
- **Logging:** https://effect.website/docs/observability/logging/

---

## Next Steps

1. **Review this plan** - Any adjustments needed?
2. **Set up project** - Install dependencies, configure tooling
3. **Start with Phase 1** - Foundation (errors, models, utilities)
4. **Iterate incrementally** - Test each phase before moving forward
5. **Deploy early, deploy often** - Use preview deployments for testing

---

**Document Version**: 1.0  
**Last Updated**: 2025-12-21  
**Status**: Ready for Implementation  
**Estimated Time**: 1-2 weeks for full implementation, 3-5 days for MVP
