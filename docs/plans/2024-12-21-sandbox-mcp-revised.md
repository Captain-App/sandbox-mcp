# OpenCode Sandbox MCP Server - Revised Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Effect-first MCP server that exposes OpenCode (autonomous AI coding agent) running in Cloudflare Sandboxes, enabling async task delegation from mobile AI clients.

**Architecture:** McpAgent (Durable Object) handles MCP protocol and session coordination. Workflows execute long-running OpenCode tasks durably. Sandboxes provide isolated Linux containers with R2-mounted persistent storage. Workflow→DO communication uses RPC callbacks (no polling).

**Tech Stack:** Effect TS, Cloudflare Workers/DOs/Workflows/Sandboxes/R2, Zod (MCP tools), TypeScript 5.7, Vitest, Oxlint

---

## Key Corrections from Original Plan

| Area | Original | Corrected |
|------|----------|-----------|
| **MCP Tool Definition** | JSON Schema | **Zod schemas** - both `server.tool()` and `server.registerTool()` exist |
| **Tool Response Format** | Direct JSON | **`{ content: [{ type: "text", text: "..." }] }`** |
| **Workflow → DO** | Polling or unclear | **Direct RPC callback via `step.do()`** |
| **R2 Prefix Mounting** | Simple `prefix` option | **s3fs `bucket:/prefix` syntax** |
| **OpenCode SDK** | `createOpencodeServer()` | **`createOpencode()`** returns `{ client, server }` |
| **OpenCode prompt API** | `{ sessionId, body }` | **`{ path: { id }, body: { parts: [{ type: "text", text }] } }`** |
| **Effect in Workflows** | Full Effect inside steps | **Effect for services, serializable step returns** |
| **DO Storage** | KV-style | **SQLite** (modern McpAgent pattern) |
| **Session Persistence** | Not detailed | **Backup OpenCode storage dir to R2** |

---

## Project Structure

```
src/
  models/                    # Data models & errors
    errors.ts                # Tagged errors (Schema.TaggedError)
    session.ts               # Session metadata schema
    run.ts                   # Task run record schema
    
  services/                  # Effect services
    storage.ts               # SQLite DO storage wrapper
    r2.ts                    # R2 bucket operations
    sandbox.ts               # Sandbox SDK wrapper
    opencode.ts              # OpenCode SDK wrapper
    workflow.ts              # Workflow orchestration
    session.ts               # Session management (orchestration)
    task.ts                  # Task execution (orchestration)
    backup.ts                # Session backup/restore to R2
    
  agent/                     # MCP Agent (Durable Object)
    mcp-agent.ts             # McpAgent implementation
    tools.ts                 # MCP tool definitions (Zod)
    
  workflows/                 # Cloudflare Workflows
    execute-task.ts          # Long-running task execution
    
  lib/                       # Shared utilities
    effect-runtime.ts        # Runtime factory for workflows
    constants.ts             # Constants, defaults
    
  index.ts                   # Worker entrypoint

tests/
  models/
  services/
  agent/
  workflows/
```

---

## Phase 1: Foundation

### Task 1.1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Add dependencies**

```json
{
  "dependencies": {
    "effect": "^3.11.0",
    "@effect/schema": "^0.77.0",
    "@cloudflare/agents": "^0.0.74",
    "@cloudflare/sandbox": "^0.2.0",
    "@opencode-ai/sdk": "^1.0.137",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241218.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8",
    "wrangler": "^3.99.0",
    "oxlint": "^0.16.0"
  }
}
```

**Step 2: Run npm install**

```bash
npm install
```

**Step 3: Verify installation**

```bash
npm ls effect @cloudflare/agents @cloudflare/sandbox
```

Expected: All packages resolved without errors.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add Effect, Cloudflare, and MCP dependencies"
```

---

### Task 1.2: Configure Wrangler Bindings

**Files:**
- Modify: `wrangler.jsonc`

**Step 1: Update wrangler.jsonc with all bindings**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "sandbox-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-21",
  "compatibility_flags": ["nodejs_compat"],
  
  "observability": {
    "enabled": true
  },

  "durable_objects": {
    "bindings": [
      {
        "name": "MCP_AGENT",
        "class_name": "OpenCodeMcpAgent"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["OpenCodeMcpAgent"]
    }
  ],

  "r2_buckets": [
    {
      "binding": "SESSIONS_BUCKET",
      "bucket_name": "opencode-sessions"
    }
  ],

  "workflows": [
    {
      "name": "execute-task-workflow",
      "binding": "EXECUTE_TASK_WORKFLOW", 
      "class_name": "ExecuteTaskWorkflow"
    }
  ],

  "vars": {
    "ENVIRONMENT": "development",
    "R2_ACCOUNT_ID": "",
    "R2_ACCESS_KEY_ID": "",
    "R2_SECRET_ACCESS_KEY": ""
  }
}
```

**Step 2: Generate types**

```bash
npx wrangler types
```

Expected: `worker-configuration.d.ts` updated with new bindings.

**Step 3: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "chore: configure DO, R2, and Workflow bindings"
```

---

### Task 1.3: Create Error Models

**Files:**
- Create: `src/models/errors.ts`
- Create: `src/models/errors.test.ts`

**Step 1: Write the failing test**

```typescript
// src/models/errors.test.ts
import { describe, it, expect } from "vitest";
import { SessionNotFoundError, SandboxStartupError, isSessionError } from "./errors";

describe("Error Models", () => {
  it("should create SessionNotFoundError with correct message", () => {
    const error = new SessionNotFoundError({ sessionId: "test-123" });
    
    expect(error._tag).toBe("SessionNotFoundError");
    expect(error.sessionId).toBe("test-123");
    expect(error.message).toContain("test-123");
  });

  it("should identify session errors with type guard", () => {
    const error = new SessionNotFoundError({ sessionId: "test" });
    
    expect(isSessionError(error)).toBe(true);
    expect(isSessionError(new Error("random"))).toBe(false);
  });

  it("should create SandboxStartupError with cause", () => {
    const cause = new Error("Connection refused");
    const error = new SandboxStartupError({ 
      sandboxId: "sandbox-1", 
      cause: cause.message 
    });
    
    expect(error._tag).toBe("SandboxStartupError");
    expect(error.sandboxId).toBe("sandbox-1");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/models/errors.test.ts
```

Expected: FAIL - Cannot find module './errors'

**Step 3: Write implementation**

```typescript
// src/models/errors.ts
import * as Schema from "@effect/schema/Schema";
import * as Predicate from "effect/Predicate";

// Type ID for error identification
export const SessionErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/SessionError");
export type SessionErrorTypeId = typeof SessionErrorTypeId;

export const SandboxErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/SandboxError");
export type SandboxErrorTypeId = typeof SandboxErrorTypeId;

export const WorkflowErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/WorkflowError");
export type WorkflowErrorTypeId = typeof WorkflowErrorTypeId;

export const OpenCodeErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/OpenCodeError");
export type OpenCodeErrorTypeId = typeof OpenCodeErrorTypeId;

export const StorageErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/StorageError");
export type StorageErrorTypeId = typeof StorageErrorTypeId;

// --- Session Errors ---

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  { sessionId: Schema.String }
) {
  readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;
  
  override get message(): string {
    return `Session "${this.sessionId}" not found`;
  }
}

export class SessionCreationError extends Schema.TaggedError<SessionCreationError>()(
  "SessionCreationError",
  { 
    sessionId: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;
  
  override get message(): string {
    return `Failed to create session "${this.sessionId}": ${this.cause}`;
  }
}

export class InvalidSessionIdError extends Schema.TaggedError<InvalidSessionIdError>()(
  "InvalidSessionIdError",
  { 
    sessionId: Schema.String,
    reason: Schema.String 
  }
) {
  readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;
  
  override get message(): string {
    return `Invalid session ID "${this.sessionId}": ${this.reason}`;
  }
}

export type SessionError = 
  | SessionNotFoundError 
  | SessionCreationError 
  | InvalidSessionIdError;

export const isSessionError = (u: unknown): u is SessionError =>
  Predicate.hasProperty(u, SessionErrorTypeId);

// --- Sandbox Errors ---

export class SandboxStartupError extends Schema.TaggedError<SandboxStartupError>()(
  "SandboxStartupError",
  { 
    sandboxId: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;
  
  override get message(): string {
    return `Sandbox "${this.sandboxId}" failed to start: ${this.cause}`;
  }
}

export class SandboxConnectionError extends Schema.TaggedError<SandboxConnectionError>()(
  "SandboxConnectionError",
  { 
    sandboxId: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;
  
  override get message(): string {
    return `Lost connection to sandbox "${this.sandboxId}": ${this.cause}`;
  }
}

export class R2MountError extends Schema.TaggedError<R2MountError>()(
  "R2MountError",
  { 
    sessionId: Schema.String,
    mountPath: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;
  
  override get message(): string {
    return `Failed to mount R2 at "${this.mountPath}" for session "${this.sessionId}": ${this.cause}`;
  }
}

export class RepositoryCloneError extends Schema.TaggedError<RepositoryCloneError>()(
  "RepositoryCloneError",
  { 
    url: Schema.String,
    branch: Schema.optional(Schema.String),
    cause: Schema.String 
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;
  
  override get message(): string {
    const branchInfo = this.branch ? ` (branch: ${this.branch})` : "";
    return `Failed to clone repository "${this.url}"${branchInfo}: ${this.cause}`;
  }
}

export type SandboxError = 
  | SandboxStartupError 
  | SandboxConnectionError 
  | R2MountError 
  | RepositoryCloneError;

export const isSandboxError = (u: unknown): u is SandboxError =>
  Predicate.hasProperty(u, SandboxErrorTypeId);

// --- OpenCode Errors ---

export class OpenCodeStartupError extends Schema.TaggedError<OpenCodeStartupError>()(
  "OpenCodeStartupError",
  { cause: Schema.String }
) {
  readonly [OpenCodeErrorTypeId]: OpenCodeErrorTypeId = OpenCodeErrorTypeId;
  
  override get message(): string {
    return `OpenCode server failed to start: ${this.cause}`;
  }
}

export class OpenCodeExecutionError extends Schema.TaggedError<OpenCodeExecutionError>()(
  "OpenCodeExecutionError",
  { 
    sessionId: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [OpenCodeErrorTypeId]: OpenCodeErrorTypeId = OpenCodeErrorTypeId;
  
  override get message(): string {
    return `OpenCode task execution failed for session "${this.sessionId}": ${this.cause}`;
  }
}

export class OpenCodeTimeoutError extends Schema.TaggedError<OpenCodeTimeoutError>()(
  "OpenCodeTimeoutError",
  { 
    sessionId: Schema.String,
    timeoutMinutes: Schema.Number 
  }
) {
  readonly [OpenCodeErrorTypeId]: OpenCodeErrorTypeId = OpenCodeErrorTypeId;
  
  override get message(): string {
    return `OpenCode task timed out after ${this.timeoutMinutes} minutes for session "${this.sessionId}"`;
  }
}

export type OpenCodeError = 
  | OpenCodeStartupError 
  | OpenCodeExecutionError 
  | OpenCodeTimeoutError;

export const isOpenCodeError = (u: unknown): u is OpenCodeError =>
  Predicate.hasProperty(u, OpenCodeErrorTypeId);

// --- Workflow Errors ---

export class WorkflowCreationError extends Schema.TaggedError<WorkflowCreationError>()(
  "WorkflowCreationError",
  { 
    runId: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [WorkflowErrorTypeId]: WorkflowErrorTypeId = WorkflowErrorTypeId;
  
  override get message(): string {
    return `Failed to create workflow for run "${this.runId}": ${this.cause}`;
  }
}

export class WorkflowExecutionError extends Schema.TaggedError<WorkflowExecutionError>()(
  "WorkflowExecutionError",
  { 
    runId: Schema.String,
    step: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [WorkflowErrorTypeId]: WorkflowErrorTypeId = WorkflowErrorTypeId;
  
  override get message(): string {
    return `Workflow step "${this.step}" failed for run "${this.runId}": ${this.cause}`;
  }
}

export type WorkflowError = 
  | WorkflowCreationError 
  | WorkflowExecutionError;

export const isWorkflowError = (u: unknown): u is WorkflowError =>
  Predicate.hasProperty(u, WorkflowErrorTypeId);

// --- Storage Errors ---

export class StorageReadError extends Schema.TaggedError<StorageReadError>()(
  "StorageReadError",
  { 
    key: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [StorageErrorTypeId]: StorageErrorTypeId = StorageErrorTypeId;
  
  override get message(): string {
    return `Failed to read key "${this.key}": ${this.cause}`;
  }
}

export class StorageWriteError extends Schema.TaggedError<StorageWriteError>()(
  "StorageWriteError",
  { 
    key: Schema.String,
    cause: Schema.String 
  }
) {
  readonly [StorageErrorTypeId]: StorageErrorTypeId = StorageErrorTypeId;
  
  override get message(): string {
    return `Failed to write key "${this.key}": ${this.cause}`;
  }
}

export type StorageError = 
  | StorageReadError 
  | StorageWriteError;

export const isStorageError = (u: unknown): u is StorageError =>
  Predicate.hasProperty(u, StorageErrorTypeId);
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/models/errors.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/models/errors.ts src/models/errors.test.ts
git commit -m "feat: add tagged error models for all error categories"
```

---

### Task 1.4: Create Session Data Model

**Files:**
- Create: `src/models/session.ts`
- Create: `src/models/session.test.ts`

**Step 1: Write the failing test**

```typescript
// src/models/session.test.ts
import { describe, it, expect } from "vitest";
import * as Schema from "@effect/schema/Schema";
import { SessionMetadata, SessionStatus } from "./session";

describe("Session Model", () => {
  it("should parse valid session metadata", () => {
    const input = {
      sessionId: "my-session-123",
      sandboxId: "my-session-123",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: "active",
      workspacePath: "/workspace",
      webUiUrl: "https://my-session-123.sandbox.example.com",
      config: {
        defaultModel: "claude-sonnet-4-20250514"
      }
    };
    
    const result = Schema.decodeUnknownSync(SessionMetadata)(input);
    
    expect(result.sessionId).toBe("my-session-123");
    expect(result.status).toBe("active");
  });

  it("should reject invalid session ID format", () => {
    const input = {
      sessionId: "INVALID_ID!", // uppercase and special chars
      sandboxId: "test",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: "active",
      workspacePath: "/workspace",
      webUiUrl: "https://test.example.com",
      config: { defaultModel: "claude-sonnet-4-20250514" }
    };
    
    expect(() => Schema.decodeUnknownSync(SessionMetadata)(input)).toThrow();
  });

  it("should accept optional repository field", () => {
    const input = {
      sessionId: "test",
      sandboxId: "test",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: "active",
      workspacePath: "/workspace",
      webUiUrl: "https://test.example.com",
      repository: {
        url: "https://github.com/user/repo",
        branch: "main"
      },
      config: { defaultModel: "claude-sonnet-4-20250514" }
    };
    
    const result = Schema.decodeUnknownSync(SessionMetadata)(input);
    
    expect(result.repository?.url).toBe("https://github.com/user/repo");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/models/session.test.ts
```

Expected: FAIL - Cannot find module './session'

**Step 3: Write implementation**

```typescript
// src/models/session.ts
import * as Schema from "@effect/schema/Schema";

/**
 * Valid session status values
 */
export const SessionStatus = Schema.Literal(
  "creating",
  "active",
  "idle",
  "stopped",
  "error"
);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

/**
 * Session ID must be lowercase alphanumeric with hyphens, max 64 chars
 */
export const SessionId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),
  Schema.maxLength(64),
  Schema.annotations({ identifier: "SessionId" })
);
export type SessionId = Schema.Schema.Type<typeof SessionId>;

/**
 * Repository information for cloned repos
 */
export const RepositoryInfo = Schema.Struct({
  url: Schema.String.pipe(
    Schema.startsWith("https://github.com/"),
    Schema.annotations({ description: "GitHub repository URL" })
  ),
  branch: Schema.String.pipe(
    Schema.annotations({ description: "Git branch name" })
  )
});
export type RepositoryInfo = Schema.Schema.Type<typeof RepositoryInfo>;

/**
 * Session configuration
 */
export const SessionConfig = Schema.Struct({
  defaultModel: Schema.String.pipe(
    Schema.annotations({ description: "Default AI model for OpenCode" })
  )
});
export type SessionConfig = Schema.Schema.Type<typeof SessionConfig>;

/**
 * Complete session metadata stored in DO
 */
export const SessionMetadata = Schema.Struct({
  sessionId: SessionId,
  sandboxId: Schema.String,
  createdAt: Schema.Number.pipe(
    Schema.annotations({ description: "Unix timestamp of creation" })
  ),
  lastActivity: Schema.Number.pipe(
    Schema.annotations({ description: "Unix timestamp of last activity" })
  ),
  status: SessionStatus,
  workspacePath: Schema.String,
  webUiUrl: Schema.String,
  repository: Schema.optional(RepositoryInfo),
  title: Schema.optional(Schema.String),
  config: SessionConfig
});
export type SessionMetadata = Schema.Schema.Type<typeof SessionMetadata>;

/**
 * Input for creating a new session
 */
export const CreateSessionInput = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  repositoryUrl: Schema.optional(
    Schema.String.pipe(Schema.startsWith("https://github.com/"))
  ),
  branch: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String)
});
export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInput>;

/**
 * Output from session creation
 */
export const CreateSessionOutput = Schema.Struct({
  sessionId: Schema.String,
  sandboxId: Schema.String,
  webUiUrl: Schema.String,
  status: Schema.Literal("created", "resumed"),
  workspacePath: Schema.String,
  repository: Schema.optional(RepositoryInfo)
});
export type CreateSessionOutput = Schema.Schema.Type<typeof CreateSessionOutput>;
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/models/session.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/models/session.ts src/models/session.test.ts
git commit -m "feat: add session metadata schema with validation"
```

---

### Task 1.5: Create Run Data Model

**Files:**
- Create: `src/models/run.ts`
- Create: `src/models/run.test.ts`

**Step 1: Write the failing test**

```typescript
// src/models/run.test.ts
import { describe, it, expect } from "vitest";
import * as Schema from "@effect/schema/Schema";
import { RunRecord, RunStatus, RunResult } from "./run";

describe("Run Model", () => {
  it("should parse valid run record", () => {
    const input = {
      runId: "run-abc123",
      sessionId: "my-session",
      workflowId: "wf-xyz",
      status: "running",
      task: "Add authentication to the API",
      model: "claude-sonnet-4-20250514",
      startedAt: Date.now(),
      retryCount: 0,
      maxRetries: 3
    };
    
    const result = Schema.decodeUnknownSync(RunRecord)(input);
    
    expect(result.runId).toBe("run-abc123");
    expect(result.status).toBe("running");
  });

  it("should parse completed run with result", () => {
    const input = {
      runId: "run-abc123",
      sessionId: "my-session",
      workflowId: "wf-xyz",
      status: "completed",
      task: "Add README",
      model: "claude-sonnet-4-20250514",
      startedAt: Date.now() - 60000,
      completedAt: Date.now(),
      retryCount: 0,
      maxRetries: 3,
      result: {
        success: true,
        output: "Created README.md with project documentation",
        filesCreated: ["README.md"],
        filesModified: [],
        commits: ["abc123"]
      }
    };
    
    const result = Schema.decodeUnknownSync(RunRecord)(input);
    
    expect(result.status).toBe("completed");
    expect(result.result?.success).toBe(true);
    expect(result.result?.filesCreated).toContain("README.md");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/models/run.test.ts
```

Expected: FAIL - Cannot find module './run'

**Step 3: Write implementation**

```typescript
// src/models/run.ts
import * as Schema from "@effect/schema/Schema";

/**
 * Valid run status values
 */
export const RunStatus = Schema.Literal(
  "queued",
  "running",
  "completed",
  "failed",
  "retrying"
);
export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

/**
 * Result of a completed run
 */
export const RunResult = Schema.Struct({
  success: Schema.Boolean,
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  filesCreated: Schema.Array(Schema.String),
  filesModified: Schema.Array(Schema.String),
  commits: Schema.Array(Schema.String),
  branch: Schema.optional(Schema.String)
});
export type RunResult = Schema.Schema.Type<typeof RunResult>;

/**
 * Complete run record stored in DO
 */
export const RunRecord = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  workflowId: Schema.String,
  status: RunStatus,
  task: Schema.String,
  model: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  result: Schema.optional(RunResult),
  retryCount: Schema.Number,
  maxRetries: Schema.Number
});
export type RunRecord = Schema.Schema.Type<typeof RunRecord>;

/**
 * Input for running a task
 */
export const RunTaskInput = Schema.Struct({
  sessionId: Schema.String,
  task: Schema.String.pipe(Schema.maxLength(50000)),
  model: Schema.optional(Schema.String)
});
export type RunTaskInput = Schema.Schema.Type<typeof RunTaskInput>;

/**
 * Output from task initiation
 */
export const RunTaskOutput = Schema.Struct({
  runId: Schema.String,
  status: Schema.Literal("started"),
  webUiUrl: Schema.String,
  message: Schema.String
});
export type RunTaskOutput = Schema.Schema.Type<typeof RunTaskOutput>;

/**
 * Input for status check
 */
export const GetStatusInput = Schema.Struct({
  sessionId: Schema.String,
  runId: Schema.optional(Schema.String),
  includeGitStatus: Schema.optional(Schema.Boolean)
});
export type GetStatusInput = Schema.Schema.Type<typeof GetStatusInput>;
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/models/run.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/models/run.ts src/models/run.test.ts
git commit -m "feat: add run record schema for task execution tracking"
```

---

### Task 1.6: Create Models Index

**Files:**
- Create: `src/models/index.ts`

**Step 1: Create barrel export**

```typescript
// src/models/index.ts
export * from "./errors";
export * from "./session";
export * from "./run";
```

**Step 2: Commit**

```bash
git add src/models/index.ts
git commit -m "chore: add models barrel export"
```

---

## Phase 2: Storage Service (SQLite)

### Task 2.1: Create Storage Service

**Files:**
- Create: `src/services/storage.ts`
- Create: `src/services/storage.test.ts`

**Step 1: Write the failing test**

```typescript
// src/services/storage.test.ts
import { describe, it, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { StorageService, makeStorageService } from "./storage";
import { SessionMetadata } from "../models/session";

// Mock SQL executor for testing
const createMockSql = () => {
  const store = new Map<string, unknown>();
  return {
    exec: (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Simple mock that handles basic INSERT/SELECT
      const query = strings.join("?");
      if (query.includes("INSERT")) {
        const key = values[0] as string;
        const data = values[1] as string;
        store.set(key, JSON.parse(data));
        return { results: [], changes: 1 };
      }
      if (query.includes("SELECT")) {
        const key = values[0] as string;
        const data = store.get(key);
        return { 
          results: data ? [{ key, data: JSON.stringify(data) }] : [],
          changes: 0 
        };
      }
      return { results: [], changes: 0 };
    },
    store // expose for assertions
  };
};

describe("StorageService", () => {
  it("should store and retrieve session metadata", async () => {
    const mockSql = createMockSql();
    const service = makeStorageService(mockSql.exec as any);
    
    const session: SessionMetadata = {
      sessionId: "test-session",
      sandboxId: "test-session",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: "active",
      workspacePath: "/workspace",
      webUiUrl: "https://test.example.com",
      config: { defaultModel: "claude-sonnet-4-20250514" }
    };
    
    const program = Effect.gen(function* () {
      yield* service.putSession(session);
      const retrieved = yield* service.getSession("test-session");
      return retrieved;
    });
    
    const result = await Effect.runPromise(program);
    
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.sessionId).toBe("test-session");
    }
  });

  it("should return None for non-existent session", async () => {
    const mockSql = createMockSql();
    const service = makeStorageService(mockSql.exec as any);
    
    const program = service.getSession("non-existent");
    const result = await Effect.runPromise(program);
    
    expect(Option.isNone(result)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/services/storage.test.ts
```

Expected: FAIL - Cannot find module './storage'

**Step 3: Write implementation**

```typescript
// src/services/storage.ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "@effect/schema/Schema";
import { SessionMetadata } from "../models/session";
import { RunRecord } from "../models/run";
import { StorageReadError, StorageWriteError } from "../models/errors";

/**
 * SQL executor type (from Durable Object)
 */
export type SqlExecutor = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => { results: T[]; changes: number };

/**
 * Storage service interface
 */
export interface StorageServiceInterface {
  readonly getSession: (
    sessionId: string
  ) => Effect.Effect<Option.Option<SessionMetadata>, StorageReadError>;
  
  readonly putSession: (
    session: SessionMetadata
  ) => Effect.Effect<void, StorageWriteError>;
  
  readonly deleteSession: (
    sessionId: string
  ) => Effect.Effect<void, StorageWriteError>;
  
  readonly getRun: (
    runId: string
  ) => Effect.Effect<Option.Option<RunRecord>, StorageReadError>;
  
  readonly putRun: (
    run: RunRecord
  ) => Effect.Effect<void, StorageWriteError>;
  
  readonly listRuns: (
    sessionId: string,
    limit?: number
  ) => Effect.Effect<ReadonlyArray<RunRecord>, StorageReadError>;
  
  readonly initSchema: () => Effect.Effect<void, StorageWriteError>;
}

/**
 * Create storage service from SQL executor
 */
export const makeStorageService = (sql: SqlExecutor): StorageServiceInterface => ({
  getSession: (sessionId) =>
    Effect.try({
      try: () => {
        const result = sql<{ key: string; data: string }>`
          SELECT key, data FROM sessions WHERE key = ${sessionId}
        `;
        if (result.results.length === 0) {
          return Option.none();
        }
        const parsed = Schema.decodeUnknownSync(SessionMetadata)(
          JSON.parse(result.results[0].data)
        );
        return Option.some(parsed);
      },
      catch: (error) => new StorageReadError({ 
        key: `session:${sessionId}`, 
        cause: String(error) 
      })
    }),

  putSession: (session) =>
    Effect.try({
      try: () => {
        const data = JSON.stringify(session);
        sql`
          INSERT OR REPLACE INTO sessions (key, data, updated_at)
          VALUES (${session.sessionId}, ${data}, ${Date.now()})
        `;
      },
      catch: (error) => new StorageWriteError({ 
        key: `session:${session.sessionId}`, 
        cause: String(error) 
      })
    }),

  deleteSession: (sessionId) =>
    Effect.try({
      try: () => {
        sql`DELETE FROM sessions WHERE key = ${sessionId}`;
      },
      catch: (error) => new StorageWriteError({ 
        key: `session:${sessionId}`, 
        cause: String(error) 
      })
    }),

  getRun: (runId) =>
    Effect.try({
      try: () => {
        const result = sql<{ key: string; data: string }>`
          SELECT key, data FROM runs WHERE key = ${runId}
        `;
        if (result.results.length === 0) {
          return Option.none();
        }
        const parsed = Schema.decodeUnknownSync(RunRecord)(
          JSON.parse(result.results[0].data)
        );
        return Option.some(parsed);
      },
      catch: (error) => new StorageReadError({ 
        key: `run:${runId}`, 
        cause: String(error) 
      })
    }),

  putRun: (run) =>
    Effect.try({
      try: () => {
        const data = JSON.stringify(run);
        sql`
          INSERT OR REPLACE INTO runs (key, session_id, data, updated_at)
          VALUES (${run.runId}, ${run.sessionId}, ${data}, ${Date.now()})
        `;
      },
      catch: (error) => new StorageWriteError({ 
        key: `run:${run.runId}`, 
        cause: String(error) 
      })
    }),

  listRuns: (sessionId, limit = 10) =>
    Effect.try({
      try: () => {
        const result = sql<{ data: string }>`
          SELECT data FROM runs 
          WHERE session_id = ${sessionId}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
        return result.results.map(row => 
          Schema.decodeUnknownSync(RunRecord)(JSON.parse(row.data))
        );
      },
      catch: (error) => new StorageReadError({ 
        key: `runs:${sessionId}`, 
        cause: String(error) 
      })
    }),

  initSchema: () =>
    Effect.try({
      try: () => {
        sql`
          CREATE TABLE IF NOT EXISTS sessions (
            key TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `;
        sql`
          CREATE TABLE IF NOT EXISTS runs (
            key TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `;
        sql`
          CREATE INDEX IF NOT EXISTS idx_runs_session 
          ON runs(session_id, updated_at DESC)
        `;
      },
      catch: (error) => new StorageWriteError({ 
        key: "schema", 
        cause: String(error) 
      })
    })
});

/**
 * Storage service context tag
 */
export class StorageService extends Context.Tag("@sandbox-mcp/StorageService")<
  StorageService,
  StorageServiceInterface
>() {}

/**
 * Create storage service layer from SQL executor
 */
export const makeStorageLayer = (sql: SqlExecutor): Layer.Layer<StorageService> =>
  Layer.succeed(StorageService, makeStorageService(sql));
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/services/storage.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/storage.ts src/services/storage.test.ts
git commit -m "feat: add SQLite storage service for session and run data"
```

---

## Phase 3: MCP Agent with Tools

### Task 3.1: Create MCP Tool Definitions (Zod)

**Files:**
- Create: `src/agent/tools.ts`
- Create: `src/agent/tools.test.ts`

**Step 1: Write the failing test**

```typescript
// src/agent/tools.test.ts
import { describe, it, expect } from "vitest";
import { 
  createSessionInputSchema, 
  runTaskInputSchema, 
  getStatusInputSchema,
  formatToolResponse 
} from "./tools";

describe("MCP Tool Schemas", () => {
  it("should validate create session input", () => {
    const valid = {
      sessionId: "my-session",
      repositoryUrl: "https://github.com/user/repo",
      branch: "main"
    };
    
    const result = createSessionInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should reject invalid session ID in create session", () => {
    const invalid = {
      sessionId: "INVALID_ID!"
    };
    
    const result = createSessionInputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should validate run task input", () => {
    const valid = {
      sessionId: "my-session",
      task: "Add authentication to the API"
    };
    
    const result = runTaskInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should format tool response correctly", () => {
    const data = { sessionId: "test", status: "created" };
    const response = formatToolResponse(data);
    
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect(JSON.parse(response.content[0].text)).toEqual(data);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/agent/tools.test.ts
```

Expected: FAIL - Cannot find module './tools'

**Step 3: Write implementation**

```typescript
// src/agent/tools.ts
import { z } from "zod";

/**
 * Session ID validation pattern (lowercase alphanumeric + hyphens)
 */
const sessionIdPattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Schema for opencode_create_session tool input
 */
export const createSessionInputSchema = {
  sessionId: z.string()
    .regex(sessionIdPattern, "Session ID must be lowercase alphanumeric with hyphens")
    .max(64)
    .optional()
    .describe("Unique session identifier. Auto-generated if not provided."),
  
  repositoryUrl: z.string()
    .startsWith("https://github.com/")
    .optional()
    .describe("GitHub repository URL to clone"),
  
  branch: z.string()
    .optional()
    .describe("Git branch to checkout. Defaults to main."),
  
  title: z.string()
    .optional()
    .describe("Human-readable session title")
};

/**
 * Schema for opencode_run_task tool input
 */
export const runTaskInputSchema = {
  sessionId: z.string()
    .describe("Session ID from opencode_create_session"),
  
  task: z.string()
    .max(50000)
    .describe("Natural language task description"),
  
  model: z.string()
    .optional()
    .describe("AI model to use. Defaults to claude-sonnet-4-20250514.")
};

/**
 * Schema for opencode_get_status tool input
 */
export const getStatusInputSchema = {
  sessionId: z.string()
    .describe("Session ID to query"),
  
  runId: z.string()
    .optional()
    .describe("Specific run ID to query"),
  
  includeGitStatus: z.boolean()
    .optional()
    .default(true)
    .describe("Include git branch and commit info")
};

/**
 * MCP tool response type
 */
export interface ToolResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
}

/**
 * Format data as MCP tool response
 */
export const formatToolResponse = (data: unknown): ToolResponse => ({
  content: [{
    type: "text",
    text: JSON.stringify(data, null, 2)
  }]
});

/**
 * Format error as MCP tool response
 */
export const formatErrorResponse = (error: {
  code: string;
  message: string;
  details?: unknown;
}): ToolResponse => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && { details: error.details })
      }
    }, null, 2)
  }]
});
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/agent/tools.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts
git commit -m "feat: add Zod schemas for MCP tool inputs"
```

---

### Task 3.2: Create MCP Agent Skeleton

**Files:**
- Create: `src/agent/mcp-agent.ts`

**Step 1: Write MCP Agent implementation**

```typescript
// src/agent/mcp-agent.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import { 
  createSessionInputSchema, 
  runTaskInputSchema, 
  getStatusInputSchema,
  formatToolResponse,
  formatErrorResponse 
} from "./tools";
import { StorageService, makeStorageLayer } from "../services/storage";
import { SessionMetadata } from "../models/session";
import { RunRecord } from "../models/run";

/**
 * State managed by the MCP Agent
 */
interface AgentState {
  initialized: boolean;
}

/**
 * OpenCode MCP Agent - Durable Object that handles MCP protocol
 */
export class OpenCodeMcpAgent extends McpAgent<Env, AgentState> {
  server = new McpServer({
    name: "opencode-sandbox",
    version: "1.0.0"
  });
  
  initialState: AgentState = {
    initialized: false
  };
  
  private runtime: ManagedRuntime.ManagedRuntime<StorageService, never> | null = null;

  /**
   * Initialize the MCP server with tools
   */
  async init(): Promise<void> {
    // Initialize SQLite schema
    const storage = makeStorageLayer(this.ctx.storage.sql);
    this.runtime = ManagedRuntime.make(storage);
    
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const storageService = yield* StorageService;
        yield* storageService.initSchema();
      })
    );
    
    // Register tools
    this.registerCreateSessionTool();
    this.registerRunTaskTool();
    this.registerGetStatusTool();
    
    this.setState({ initialized: true });
  }

  /**
   * Tool: opencode_create_session
   */
  private registerCreateSessionTool(): void {
    this.server.tool(
      "opencode_create_session",
      "Create or resume an OpenCode coding session in a sandbox",
      createSessionInputSchema,
      async (params) => {
        try {
          const sessionId = params.sessionId ?? crypto.randomUUID().slice(0, 8);
          
          // Check if session exists (resume)
          const existing = await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(sessionId);
            })
          );
          
          if (existing._tag === "Some") {
            return formatToolResponse({
              sessionId: existing.value.sessionId,
              sandboxId: existing.value.sandboxId,
              webUiUrl: existing.value.webUiUrl,
              status: "resumed",
              workspacePath: existing.value.workspacePath,
              repository: existing.value.repository
            });
          }
          
          // TODO: Create sandbox, mount R2, clone repo, start OpenCode
          // For now, create session metadata only
          const session: SessionMetadata = {
            sessionId,
            sandboxId: sessionId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: "creating",
            workspacePath: "/workspace",
            webUiUrl: `https://${sessionId}.sandbox.example.com`, // Placeholder
            repository: params.repositoryUrl ? {
              url: params.repositoryUrl,
              branch: params.branch ?? "main"
            } : undefined,
            title: params.title,
            config: {
              defaultModel: "claude-sonnet-4-20250514"
            }
          };
          
          await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              yield* storage.putSession(session);
            })
          );
          
          return formatToolResponse({
            sessionId: session.sessionId,
            sandboxId: session.sandboxId,
            webUiUrl: session.webUiUrl,
            status: "created",
            workspacePath: session.workspacePath,
            repository: session.repository
          });
        } catch (error) {
          return formatErrorResponse({
            code: "SESSION_CREATION_FAILED",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    );
  }

  /**
   * Tool: opencode_run_task
   */
  private registerRunTaskTool(): void {
    this.server.tool(
      "opencode_run_task",
      "Execute a coding task asynchronously in an OpenCode session",
      runTaskInputSchema,
      async (params) => {
        try {
          // Verify session exists
          const session = await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(params.sessionId);
            })
          );
          
          if (session._tag === "None") {
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`
            });
          }
          
          const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
          
          // TODO: Create workflow to execute task
          // For now, create run record only
          const run: RunRecord = {
            runId,
            sessionId: params.sessionId,
            workflowId: `wf-${runId}`, // Placeholder
            status: "queued",
            task: params.task,
            model: params.model ?? session.value.config.defaultModel,
            startedAt: Date.now(),
            retryCount: 0,
            maxRetries: 3
          };
          
          await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              yield* storage.putRun(run);
            })
          );
          
          return formatToolResponse({
            runId,
            status: "started",
            webUiUrl: session.value.webUiUrl,
            message: "Task started. Use opencode_get_status to check progress."
          });
        } catch (error) {
          return formatErrorResponse({
            code: "TASK_START_FAILED",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    );
  }

  /**
   * Tool: opencode_get_status
   */
  private registerGetStatusTool(): void {
    this.server.tool(
      "opencode_get_status",
      "Check the status of a session and optionally a specific task run",
      getStatusInputSchema,
      async (params) => {
        try {
          const session = await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.getSession(params.sessionId);
            })
          );
          
          if (session._tag === "None") {
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`
            });
          }
          
          // Get recent runs
          const runs = await this.runtime!.runPromise(
            Effect.gen(function* () {
              const storage = yield* StorageService;
              return yield* storage.listRuns(params.sessionId, 10);
            })
          );
          
          // Get specific run if requested
          let currentRun = undefined;
          if (params.runId) {
            const run = await this.runtime!.runPromise(
              Effect.gen(function* () {
                const storage = yield* StorageService;
                return yield* storage.getRun(params.runId!);
              })
            );
            if (run._tag === "Some") {
              currentRun = run.value;
            }
          }
          
          return formatToolResponse({
            sessionId: session.value.sessionId,
            webUiUrl: session.value.webUiUrl,
            status: session.value.status,
            workspacePath: session.value.workspacePath,
            createdAt: session.value.createdAt,
            lastActivity: session.value.lastActivity,
            repository: session.value.repository,
            recentRuns: runs.map(r => ({
              runId: r.runId,
              status: r.status,
              task: r.task.slice(0, 100) + (r.task.length > 100 ? "..." : ""),
              startedAt: r.startedAt,
              completedAt: r.completedAt
            })),
            ...(currentRun && { currentRun })
          });
        } catch (error) {
          return formatErrorResponse({
            code: "STATUS_CHECK_FAILED",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    );
  }

  /**
   * RPC method called by Workflow when task completes
   */
  async onTaskComplete(params: {
    runId: string;
    result: {
      success: boolean;
      output?: string;
      error?: string;
      filesCreated: string[];
      filesModified: string[];
      commits: string[];
      branch?: string;
    };
  }): Promise<void> {
    await this.runtime!.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        const existing = yield* storage.getRun(params.runId);
        
        if (existing._tag === "Some") {
          const updated: RunRecord = {
            ...existing.value,
            status: params.result.success ? "completed" : "failed",
            completedAt: Date.now(),
            result: params.result
          };
          yield* storage.putRun(updated);
        }
      })
    );
  }
}
```

**Step 2: Commit**

```bash
git add src/agent/mcp-agent.ts
git commit -m "feat: add MCP agent skeleton with tool registration"
```

---

### Task 3.3: Create Worker Entry Point

**Files:**
- Modify: `src/index.ts`

**Step 1: Update worker entry point**

```typescript
// src/index.ts
import { OpenCodeMcpAgent } from "./agent/mcp-agent";
import { ExecuteTaskWorkflow } from "./workflows/execute-task";

// Export Durable Object and Workflow classes
export { OpenCodeMcpAgent };
export { ExecuteTaskWorkflow };

// Worker fetch handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }
    
    // MCP endpoint - route to McpAgent
    if (url.pathname.startsWith("/mcp")) {
      return OpenCodeMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }
    
    // Default response
    return new Response(JSON.stringify({
      name: "sandbox-mcp",
      version: "1.0.0",
      endpoints: {
        health: "/health",
        mcp: "/mcp"
      }
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};
```

**Step 2: Create placeholder workflow**

```typescript
// src/workflows/execute-task.ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

interface TaskParams {
  sessionId: string;
  sandboxId: string;
  task: string;
  model: string;
  runId: string;
  doId: string; // For RPC callback
}

interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
}

/**
 * Workflow that executes OpenCode tasks durably
 */
export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    const { sessionId, sandboxId, task, model, runId, doId } = event.payload;
    
    // Step 1: Setup sandbox (placeholder)
    const sandboxInfo = await step.do("setup-sandbox", async () => {
      // TODO: Get sandbox, mount R2, setup credentials
      return {
        sandboxId,
        ready: true
      };
    });
    
    // Step 2: Execute OpenCode task (placeholder)
    const result = await step.do("execute-task", {
      retries: {
        limit: 3,
        delay: "10 seconds",
        backoff: "exponential"
      },
      timeout: "50 minutes"
    }, async () => {
      // TODO: Call OpenCode SDK
      return {
        success: true,
        output: "Task completed (placeholder)",
        filesCreated: [],
        filesModified: [],
        commits: [],
        branch: "main"
      } satisfies TaskResult;
    });
    
    // Step 3: Notify DO via RPC callback
    await step.do("notify-completion", async () => {
      const doIdObj = this.env.MCP_AGENT.idFromString(doId);
      const stub = this.env.MCP_AGENT.get(doIdObj);
      
      // RPC call to DO
      await stub.onTaskComplete({
        runId,
        result
      });
    });
    
    return result;
  }
}
```

**Step 3: Commit**

```bash
git add src/index.ts src/workflows/execute-task.ts
git commit -m "feat: add worker entry point and placeholder workflow"
```

---

## Phase 4: Sandbox Integration

### Task 4.1: Create Sandbox Service

**Files:**
- Create: `src/services/sandbox.ts`

**Step 1: Write Sandbox service**

```typescript
// src/services/sandbox.ts
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { 
  SandboxStartupError, 
  SandboxConnectionError, 
  R2MountError,
  RepositoryCloneError 
} from "../models/errors";

/**
 * R2 endpoint format for mounting
 */
const getR2Endpoint = (accountId: string): string =>
  `https://${accountId}.r2.cloudflarestorage.com`;

/**
 * Sandbox service interface
 */
export interface SandboxServiceInterface {
  readonly getSandbox: (
    sandboxId: string
  ) => Effect.Effect<Sandbox<unknown>, SandboxStartupError>;
  
  readonly mountR2WithPrefix: (
    sandbox: Sandbox<unknown>,
    sessionId: string,
    config: {
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucketName: string;
    }
  ) => Effect.Effect<void, R2MountError>;
  
  readonly cloneRepository: (
    sandbox: Sandbox<unknown>,
    url: string,
    branch?: string
  ) => Effect.Effect<void, RepositoryCloneError>;
  
  readonly setupGitCredentials: (
    sandbox: Sandbox<unknown>,
    token: string,
    authorName: string,
    authorEmail: string
  ) => Effect.Effect<void, SandboxConnectionError>;
  
  readonly exposePort: (
    sandbox: Sandbox<unknown>,
    port: number,
    hostname: string
  ) => Effect.Effect<string, SandboxConnectionError>;
  
  readonly execCommand: (
    sandbox: Sandbox<unknown>,
    command: string
  ) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, SandboxConnectionError>;
}

/**
 * Create sandbox service from environment
 */
export const makeSandboxService = (
  sandboxBinding: DurableObjectNamespace
): SandboxServiceInterface => ({
  getSandbox: (sandboxId) =>
    Effect.try({
      try: () => getSandbox(sandboxBinding, sandboxId, {
        normalizeId: true, // Lowercase for preview URL compatibility
        sleepAfter: "10 minutes"
      }),
      catch: (error) => new SandboxStartupError({
        sandboxId,
        cause: String(error)
      })
    }),

  mountR2WithPrefix: (sandbox, sessionId, config) =>
    Effect.tryPromise({
      try: async () => {
        const endpoint = getR2Endpoint(config.accountId);
        
        // Use s3fs bucket:/prefix syntax for mounting a subdirectory
        // This mounts only the session's workspace, not the entire bucket
        await sandbox.mountBucket(
          `${config.bucketName}:/${sessionId}/workspace`,
          "/workspace",
          {
            endpoint,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey
            }
          }
        );
      },
      catch: (error) => new R2MountError({
        sessionId,
        mountPath: "/workspace",
        cause: String(error)
      })
    }),

  cloneRepository: (sandbox, url, branch) =>
    Effect.tryPromise({
      try: async () => {
        await sandbox.gitCheckout(url, {
          branch: branch ?? "main",
          targetDir: "/workspace"
        });
      },
      catch: (error) => new RepositoryCloneError({
        url,
        branch,
        cause: String(error)
      })
    }).pipe(
      Effect.timeout("5 minutes"),
      Effect.retry({
        times: 2,
        schedule: Effect.scheduleExponential("5 seconds")
      })
    ),

  setupGitCredentials: (sandbox, token, authorName, authorEmail) =>
    Effect.tryPromise({
      try: async () => {
        await sandbox.setEnvVars({
          GITHUB_TOKEN: token,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail
        });
        
        // Configure git credential helper
        await sandbox.exec(
          `git config --global credential.helper '!f() { echo "password=${token}"; }; f'`
        );
      },
      catch: (error) => new SandboxConnectionError({
        sandboxId: "unknown",
        cause: String(error)
      })
    }),

  exposePort: (sandbox, port, hostname) =>
    Effect.tryPromise({
      try: async () => {
        const result = await sandbox.exposePort(port, { hostname });
        return result.url;
      },
      catch: (error) => new SandboxConnectionError({
        sandboxId: "unknown",
        cause: String(error)
      })
    }),

  execCommand: (sandbox, command) =>
    Effect.tryPromise({
      try: async () => {
        const result = await sandbox.exec(command);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      },
      catch: (error) => new SandboxConnectionError({
        sandboxId: "unknown",
        cause: String(error)
      })
    })
});

/**
 * Sandbox service context tag
 */
export class SandboxService extends Context.Tag("@sandbox-mcp/SandboxService")<
  SandboxService,
  SandboxServiceInterface
>() {}

/**
 * Create sandbox service layer
 */
export const makeSandboxLayer = (
  sandboxBinding: DurableObjectNamespace
): Layer.Layer<SandboxService> =>
  Layer.succeed(SandboxService, makeSandboxService(sandboxBinding));
```

**Step 2: Commit**

```bash
git add src/services/sandbox.ts
git commit -m "feat: add sandbox service with R2 prefix mounting"
```

---

### Task 4.2: Create OpenCode Service

**Files:**
- Create: `src/services/opencode.ts`

**Step 1: Write OpenCode service**

```typescript
// src/services/opencode.ts
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Sandbox } from "@cloudflare/sandbox";
import { 
  OpenCodeStartupError, 
  OpenCodeExecutionError,
  OpenCodeTimeoutError 
} from "../models/errors";

/**
 * OpenCode task execution result
 */
export interface OpenCodeTaskResult {
  success: boolean;
  output: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
}

/**
 * OpenCode service interface
 */
export interface OpenCodeServiceInterface {
  readonly startServer: (
    sandbox: Sandbox<unknown>,
    directory?: string
  ) => Effect.Effect<{
    port: number;
    url: string;
    close: () => Promise<void>;
  }, OpenCodeStartupError>;
  
  readonly executeTask: (
    sandbox: Sandbox<unknown>,
    params: {
      sessionId: string;
      task: string;
      model: string;
      directory?: string;
    }
  ) => Effect.Effect<OpenCodeTaskResult, OpenCodeExecutionError | OpenCodeTimeoutError>;
}

/**
 * Parse OpenCode response to extract result info
 */
const parseOpenCodeResponse = (response: unknown): OpenCodeTaskResult => {
  // Extract meaningful info from OpenCode response
  // This is simplified - actual implementation depends on OpenCode SDK response format
  const data = response as {
    data?: {
      parts?: Array<{ type: string; text?: string }>;
    };
  };
  
  const textParts = data?.data?.parts
    ?.filter(p => p.type === "text")
    ?.map(p => p.text ?? "")
    ?? [];
  
  return {
    success: true,
    output: textParts.join("\n"),
    filesCreated: [], // Would need to parse from response or git status
    filesModified: [],
    commits: [],
    branch: undefined
  };
};

/**
 * Create OpenCode service
 */
export const makeOpenCodeService = (): OpenCodeServiceInterface => ({
  startServer: (sandbox, directory = "/workspace") =>
    Effect.tryPromise({
      try: async () => {
        const { server } = await createOpencode(sandbox, {
          directory,
          port: 4096
        });
        return server;
      },
      catch: (error) => new OpenCodeStartupError({
        cause: String(error)
      })
    }).pipe(
      Effect.timeout("2 minutes")
    ),

  executeTask: (sandbox, params) =>
    Effect.gen(function* () {
      // Start OpenCode server
      const { client, server } = yield* Effect.tryPromise({
        try: () => createOpencode(sandbox, {
          directory: params.directory ?? "/workspace",
          port: 4096
        }),
        catch: (error) => new OpenCodeExecutionError({
          sessionId: params.sessionId,
          cause: `Failed to start OpenCode: ${error}`
        })
      });
      
      try {
        // Create or get session
        let sessionData;
        try {
          sessionData = await client.session.get({ 
            path: { id: params.sessionId } 
          });
        } catch {
          sessionData = await client.session.create({
            body: { title: `Task: ${params.task.slice(0, 50)}` }
          });
        }
        
        // Execute task
        const response = yield* Effect.tryPromise({
          try: () => client.session.prompt({
            path: { id: sessionData.data.id },
            body: {
              model: {
                providerID: "anthropic",
                modelID: params.model
              },
              parts: [{
                type: "text",
                text: params.task
              }]
            }
          }),
          catch: (error) => new OpenCodeExecutionError({
            sessionId: params.sessionId,
            cause: String(error)
          })
        }).pipe(
          Effect.timeout("50 minutes"),
          Effect.catchTag("TimeoutException", () => 
            Effect.fail(new OpenCodeTimeoutError({
              sessionId: params.sessionId,
              timeoutMinutes: 50
            }))
          )
        );
        
        return parseOpenCodeResponse(response);
      } finally {
        // Clean up server
        await server.close();
      }
    })
});

/**
 * OpenCode service context tag
 */
export class OpenCodeService extends Context.Tag("@sandbox-mcp/OpenCodeService")<
  OpenCodeService,
  OpenCodeServiceInterface
>() {}

/**
 * OpenCode service layer
 */
export const OpenCodeServiceLive: Layer.Layer<OpenCodeService> =
  Layer.succeed(OpenCodeService, makeOpenCodeService());
```

**Step 2: Commit**

```bash
git add src/services/opencode.ts
git commit -m "feat: add OpenCode service with task execution"
```

---

## Phase 5: Session Backup/Restore

### Task 5.1: Create Backup Service

**Files:**
- Create: `src/services/backup.ts`

**Step 1: Write backup service**

```typescript
// src/services/backup.ts
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { Sandbox } from "@cloudflare/sandbox";
import type { R2Bucket } from "@cloudflare/workers-types";

/**
 * Backup service for OpenCode session persistence
 * 
 * OpenCode stores session data in ~/.local/share/opencode/storage/
 * We backup this directory to R2 and restore on session resume.
 */
export interface BackupServiceInterface {
  /**
   * Backup OpenCode session data to R2
   */
  readonly backupSession: (
    sandbox: Sandbox<unknown>,
    sessionId: string
  ) => Effect.Effect<void, Error>;
  
  /**
   * Restore OpenCode session data from R2
   */
  readonly restoreSession: (
    sandbox: Sandbox<unknown>,
    sessionId: string
  ) => Effect.Effect<boolean, Error>; // Returns true if backup existed
  
  /**
   * Check if session backup exists
   */
  readonly hasBackup: (
    sessionId: string
  ) => Effect.Effect<boolean, Error>;
}

/**
 * Create backup service
 */
export const makeBackupService = (bucket: R2Bucket): BackupServiceInterface => ({
  backupSession: (sandbox, sessionId) =>
    Effect.tryPromise({
      try: async () => {
        // Archive OpenCode storage directory
        const archiveResult = await sandbox.exec(
          `tar -czf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode storage 2>/dev/null || true`
        );
        
        if (archiveResult.exitCode !== 0) {
          // No storage directory yet, nothing to backup
          return;
        }
        
        // Read archive
        const archive = await sandbox.readFile("/tmp/opencode-backup.tar.gz");
        
        // Upload to R2
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        await bucket.put(key, archive.content);
        
        // Cleanup
        await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");
      },
      catch: (error) => new Error(`Backup failed: ${error}`)
    }),

  restoreSession: (sandbox, sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        
        // Check if backup exists
        const object = await bucket.get(key);
        if (!object) {
          return false;
        }
        
        // Download backup
        const data = await object.arrayBuffer();
        
        // Write to sandbox
        await sandbox.writeFile("/tmp/opencode-backup.tar.gz", new Uint8Array(data));
        
        // Create storage directory
        await sandbox.exec("mkdir -p ~/.local/share/opencode");
        
        // Extract backup
        await sandbox.exec(
          "tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode"
        );
        
        // Cleanup
        await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");
        
        return true;
      },
      catch: (error) => new Error(`Restore failed: ${error}`)
    }),

  hasBackup: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        const head = await bucket.head(key);
        return head !== null;
      },
      catch: (error) => new Error(`Backup check failed: ${error}`)
    })
});

/**
 * Backup service context tag
 */
export class BackupService extends Context.Tag("@sandbox-mcp/BackupService")<
  BackupService,
  BackupServiceInterface
>() {}

/**
 * Create backup service layer
 */
export const makeBackupLayer = (bucket: R2Bucket): Layer.Layer<BackupService> =>
  Layer.succeed(BackupService, makeBackupService(bucket));
```

**Step 2: Commit**

```bash
git add src/services/backup.ts
git commit -m "feat: add backup service for OpenCode session persistence"
```

---

## Phase 6: Complete Workflow Implementation

### Task 6.1: Implement Full Workflow

**Files:**
- Modify: `src/workflows/execute-task.ts`

**Step 1: Update workflow with full implementation**

```typescript
// src/workflows/execute-task.ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import { SandboxService, makeSandboxLayer } from "../services/sandbox";
import { OpenCodeService, OpenCodeServiceLive } from "../services/opencode";
import { BackupService, makeBackupLayer } from "../services/backup";

interface TaskParams {
  sessionId: string;
  sandboxId: string;
  task: string;
  model: string;
  runId: string;
  doId: string;
  repositoryUrl?: string;
  branch?: string;
}

interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
}

/**
 * Workflow that executes OpenCode tasks durably
 */
export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    const params = event.payload;
    
    // Build Effect runtime for this workflow
    const runtime = this.makeRuntime();
    
    try {
      // Step 1: Get and configure sandbox
      const sandboxInfo = await step.do("setup-sandbox", async () => {
        return runtime.runPromise(
          Effect.gen(function* () {
            const sandboxService = yield* SandboxService;
            const backupService = yield* BackupService;
            
            // Get sandbox instance
            const sandbox = yield* sandboxService.getSandbox(params.sandboxId);
            
            // Mount R2 with session prefix
            yield* sandboxService.mountR2WithPrefix(sandbox, params.sessionId, {
              accountId: process.env.R2_ACCOUNT_ID!,
              accessKeyId: process.env.R2_ACCESS_KEY_ID!,
              secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
              bucketName: "opencode-sessions"
            });
            
            // Setup git credentials
            yield* sandboxService.setupGitCredentials(
              sandbox,
              process.env.GITHUB_TOKEN!,
              process.env.GIT_AUTHOR_NAME ?? "OpenCode Bot",
              process.env.GIT_AUTHOR_EMAIL ?? "bot@opencode.dev"
            );
            
            // Restore OpenCode session if exists
            const restored = yield* backupService.restoreSession(
              sandbox, 
              params.sessionId
            );
            
            // Clone repository if provided and not already present
            if (params.repositoryUrl) {
              const exists = yield* sandboxService.execCommand(
                sandbox, 
                "test -d /workspace/.git && echo exists || echo missing"
              );
              
              if (exists.stdout.trim() === "missing") {
                yield* sandboxService.cloneRepository(
                  sandbox,
                  params.repositoryUrl,
                  params.branch
                );
              }
            }
            
            return {
              sandboxId: params.sandboxId,
              restored,
              ready: true
            };
          })
        );
      });
      
      // Step 2: Execute OpenCode task
      const taskResult = await step.do("execute-opencode-task", {
        retries: {
          limit: 3,
          delay: "10 seconds",
          backoff: "exponential"
        },
        timeout: "50 minutes"
      }, async () => {
        return runtime.runPromise(
          Effect.gen(function* () {
            const sandboxService = yield* SandboxService;
            const openCodeService = yield* OpenCodeService;
            
            const sandbox = yield* sandboxService.getSandbox(params.sandboxId);
            
            const result = yield* openCodeService.executeTask(sandbox, {
              sessionId: params.sessionId,
              task: params.task,
              model: params.model,
              directory: "/workspace"
            });
            
            return result;
          })
        );
      });
      
      // Step 3: Backup session state
      await step.do("backup-session", async () => {
        return runtime.runPromise(
          Effect.gen(function* () {
            const sandboxService = yield* SandboxService;
            const backupService = yield* BackupService;
            
            const sandbox = yield* sandboxService.getSandbox(params.sandboxId);
            yield* backupService.backupSession(sandbox, params.sessionId);
          })
        );
      });
      
      // Step 4: Get git status for result
      const gitInfo = await step.do("get-git-status", async () => {
        return runtime.runPromise(
          Effect.gen(function* () {
            const sandboxService = yield* SandboxService;
            const sandbox = yield* sandboxService.getSandbox(params.sandboxId);
            
            // Get current branch
            const branchResult = yield* sandboxService.execCommand(
              sandbox,
              "git -C /workspace rev-parse --abbrev-ref HEAD 2>/dev/null || echo main"
            );
            
            // Get recent commits
            const logResult = yield* sandboxService.execCommand(
              sandbox,
              "git -C /workspace log --oneline -5 2>/dev/null || echo ''"
            );
            
            // Get changed files
            const diffResult = yield* sandboxService.execCommand(
              sandbox,
              "git -C /workspace diff --name-only HEAD~1 2>/dev/null || echo ''"
            );
            
            return {
              branch: branchResult.stdout.trim(),
              commits: logResult.stdout.trim().split("\n").filter(Boolean).map(l => l.split(" ")[0]),
              filesModified: diffResult.stdout.trim().split("\n").filter(Boolean)
            };
          })
        );
      });
      
      const result: TaskResult = {
        success: taskResult.success,
        output: taskResult.output,
        filesCreated: taskResult.filesCreated,
        filesModified: gitInfo.filesModified,
        commits: gitInfo.commits,
        branch: gitInfo.branch
      };
      
      // Step 5: Notify DO via RPC
      await step.do("notify-completion", async () => {
        const doIdObj = this.env.MCP_AGENT.idFromString(params.doId);
        const stub = this.env.MCP_AGENT.get(doIdObj);
        await stub.onTaskComplete({ runId: params.runId, result });
      });
      
      return result;
      
    } catch (error) {
      // Handle errors and still notify DO
      const errorResult: TaskResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filesCreated: [],
        filesModified: [],
        commits: []
      };
      
      await step.do("notify-failure", async () => {
        const doIdObj = this.env.MCP_AGENT.idFromString(params.doId);
        const stub = this.env.MCP_AGENT.get(doIdObj);
        await stub.onTaskComplete({ runId: params.runId, result: errorResult });
      });
      
      return errorResult;
    }
  }
  
  /**
   * Build Effect runtime with all services
   */
  private makeRuntime() {
    // Note: In real implementation, Sandbox binding would come from this.env
    // This is a simplified version
    const layer = Layer.mergeAll(
      // makeSandboxLayer(this.env.SANDBOX),
      // makeBackupLayer(this.env.SESSIONS_BUCKET),
      OpenCodeServiceLive
    );
    
    return ManagedRuntime.make(layer);
  }
}
```

**Step 2: Commit**

```bash
git add src/workflows/execute-task.ts
git commit -m "feat: implement full workflow with sandbox, OpenCode, and backup"
```

---

## Phase 7: Integration & Testing

### Task 7.1: Create Services Index

**Files:**
- Create: `src/services/index.ts`

**Step 1: Create barrel export**

```typescript
// src/services/index.ts
export * from "./storage";
export * from "./sandbox";
export * from "./opencode";
export * from "./backup";
```

**Step 2: Commit**

```bash
git add src/services/index.ts
git commit -m "chore: add services barrel export"
```

---

### Task 7.2: Update MCP Agent with Full Integration

**Files:**
- Modify: `src/agent/mcp-agent.ts`

This task involves updating the MCP Agent to:
1. Create sandboxes when sessions are created
2. Trigger workflows when tasks are run
3. Include the DO ID in workflow params for RPC callback

The implementation details are extensive - the key changes are:
- In `registerCreateSessionTool()`: Actually create sandbox and expose web UI
- In `registerRunTaskTool()`: Create workflow instance with DO ID
- Add proper error handling throughout

**Step 1: Commit after integration**

```bash
git add src/agent/mcp-agent.ts
git commit -m "feat: integrate MCP agent with sandbox and workflow services"
```

---

## Verification Checklist

Before considering implementation complete:

- [ ] All models use Effect Schema with proper validation
- [ ] All errors extend Schema.TaggedError with TypeId
- [ ] All services follow Context.Tag + make + layer pattern
- [ ] MCP tools use Zod schemas (not JSON Schema)
- [ ] MCP tool responses use `{ content: [{ type: "text", text }] }` format
- [ ] Workflow → DO uses RPC callback (not polling)
- [ ] Workflow step callbacks return serializable data only
- [ ] R2 mounting uses `bucket:/prefix` syntax
- [ ] OpenCode uses `createOpencode()` returning `{ client, server }`
- [ ] Session backup/restore implemented for OpenCode storage
- [ ] SQLite used for DO storage (not KV)
- [ ] TypeScript compiles with no errors
- [ ] All tests pass

---

## Execution Notes

**Critical APIs (verified from source):**

1. **Sandbox SDK:**
   - `getSandbox(binding, id, options)` - Get sandbox instance
   - `sandbox.mountBucket(bucketSpec, path, options)` - Mount R2/S3
   - `sandbox.gitCheckout(url, options)` - Clone repository
   - `sandbox.exec(command)` - Execute command
   - `sandbox.exposePort(port, options)` - Get public URL

2. **Agents SDK (MCP):**
   - `server.tool(name, description, zodSchema, callback)` - Register tool
   - `server.registerTool(name, { description, inputSchema }, callback)` - Alternative
   - `McpAgent.serve(path)` - Create fetch handler

3. **OpenCode SDK:**
   - `createOpencode(sandbox, options)` - Returns `{ client, server }`
   - `client.session.create({ body })` - Create session
   - `client.session.prompt({ path: { id }, body: { parts } })` - Send prompt

4. **Workflow:**
   - `this.env.BINDING.get(id)` - Get DO stub from workflow
   - `stub.method(params)` - RPC call to DO
   - `step.do(name, options, callback)` - Durable step

---

**Document Version:** 2.0  
**Last Updated:** 2024-12-21  
**Status:** Ready for Implementation

---

Plan complete and saved to `docs/plans/2024-12-21-sandbox-mcp-revised.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
