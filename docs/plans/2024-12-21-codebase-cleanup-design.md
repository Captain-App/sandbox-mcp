# Codebase Cleanup & Architecture Redesign

## Executive Summary

This document outlines a comprehensive refactoring plan for the sandbox-mcp codebase. A code review revealed ~1000+ lines of dead code, misaligned architectural patterns, and unused abstractions. This plan addresses these issues while maintaining clean, maintainable code.

**Core insight**: Effect-TS and Cloudflare Workflows operate in fundamentally different execution contexts. Attempting to force Effect patterns into Workflows adds complexity without benefit. This plan embraces that reality.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Architectural Decision](#architectural-decision)
3. [What Changes](#what-changes)
4. [New Architecture](#new-architecture)
5. [Implementation Plan](#implementation-plan)
6. [File-by-File Changes](#file-by-file-changes)

---

## Current State Analysis

### Dead Code Inventory

| File | Lines | Status | Issue |
|------|-------|--------|-------|
| `services/sandbox.ts` | 208 | DEAD | Never imported or used |
| `services/opencode.ts` | 266 | DEAD | Never imported or used |
| `services/backup.ts` | 305 | DEAD | Never imported or used |
| `services/telemetry.ts` | ~100 | PARTIAL | Service layer unused, only builders used |
| `models/errors.ts` | ~150 | PARTIAL | 14 error types never thrown |

**Total dead code: ~900+ lines**

### Unused Error Types

These error classes exist but are never instantiated:

- `SandboxStartupError`, `SandboxConnectionError`, `R2MountError`, `RepositoryCloneError`
- `OpenCodeStartupError`, `OpenCodeExecutionError`, `OpenCodeTimeoutError`
- `BackupCreationError`, `BackupRestoreError`, `BackupNotFoundError`
- `WorkflowCreationError`, `WorkflowExecutionError`
- `SessionCreationError`, `InvalidSessionIdError`

### Unused Effect Schemas

These schemas are only used as TypeScript types, not for runtime validation:

- `CreateSessionInput`, `CreateSessionOutput` (Zod versions used instead)
- `RunTaskInput`, `RunTaskOutput`, `GetStatusInput` (Zod versions used instead)

### What's Actually Working

| Component | Status | Notes |
|-----------|--------|-------|
| `index.ts` | ✅ | Entry point, routing |
| `agent/mcp-agent.ts` | ✅ | MCP tools, uses StorageService |
| `agent/tools.ts` | ✅ | Zod schemas for MCP |
| `workflows/execute-task.ts` | ✅ | Works but monolithic |
| `services/storage.ts` | ✅ | Only Effect service actually used |
| `models/session.ts` | ✅ | Types + validation constants |
| `models/run.ts` | ✅ | Types + validation constants |

---

## Architectural Decision

### The Core Tension

**Effect-TS** provides:
- Dependency injection via `Context.Tag` and `Layer`
- Composable error handling with `Effect.Effect<A, E, R>`
- Service abstraction with `ManagedRuntime`

**Cloudflare Workflows** provide:
- Durable execution across process restarts
- Step-based execution with automatic retries
- Hibernation between steps (no in-memory state)

**The problem**: Workflows run in separate V8 isolates. Each step can run in a different process. There's no way to maintain an Effect runtime across steps.

### Decision: Pragmatic Hybrid Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Effect Zone (DO Context)                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  MCP Agent (Durable Object)                              │   │
│  │  - Effect ManagedRuntime                                 │   │
│  │  - StorageService (Context.Tag)                          │   │
│  │  - Effect Schema for DB validation                       │   │
│  │  - Tagged errors for domain errors                       │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Spawns workflow
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                  Plain TypeScript Zone (Workflow)                │
│  ┌────────────────────────────────────────────────────��────┐   │
│  │  ExecuteTaskWorkflow                                     │   │
│  │  - No Effect runtime                                     │   │
│  │  - Helper modules (not Effect services)                  │   │
│  │  - Clear function interfaces                             │   │
│  │  - Result types for error handling                       │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Rationale

1. **Effect in DO works** - DOs are long-lived, can hold ManagedRuntime
2. **Effect in Workflow doesn't work** - Workflows hibernate, lose runtime
3. **Clean code ≠ Effect** - We can have clean TypeScript without Effect
4. **Delete dead code** - Unused abstractions are worse than no abstractions

---

## What Changes

### DELETE (Dead Code)

```
src/services/sandbox.ts      # 208 lines - never used
src/services/opencode.ts     # 266 lines - never used
src/services/backup.ts       # 305 lines - never used
```

### SIMPLIFY (Remove Unused Parts)

**`services/telemetry.ts`**:
- Keep: `ToolCallEventBuilder`, `WorkflowEventBuilder`
- Delete: `TelemetryService`, `TelemetryLive`, `TelemetryServiceInterface`

**`models/errors.ts`**:
- Keep: `SessionNotFoundError`, `StorageReadError`, `StorageWriteError`
- Keep: Type guards (`isSessionError`, `isStorageError`, `isWorkflowError`)
- Delete: All unused error types (14 classes)

**`services/index.ts`**:
- Remove exports for deleted services

### REFACTOR (Clean Up Workflow)

**`workflows/execute-task.ts`** - Extract helpers into modules:

```
src/workflows/
  execute-task.ts          # Main workflow (orchestration only)
  helpers/
    sandbox.ts             # getSandbox, mountR2, cloneRepo, gitCredentials
    opencode.ts            # startOpencode, executeTask
    backup.ts              # backupSession, restoreSession
    git.ts                 # getGitStatus
    types.ts               # TaskParams, TaskResult, etc.
```

These are **plain TypeScript modules**, not Effect services. They export functions that take explicit dependencies as parameters.

### KEEP (Working Code)

```
src/index.ts               # Entry point
src/agent/mcp-agent.ts     # MCP Agent with Effect
src/agent/tools.ts         # Zod schemas
src/services/storage.ts    # StorageService (Effect)
src/models/session.ts      # Types + constants
src/models/run.ts          # Types + constants
```

---

## New Architecture

### Directory Structure

```
src/
├── index.ts                    # Worker entry point
├── agent/
│   ├── mcp-agent.ts           # MCP Agent (Durable Object with Effect)
│   └── tools.ts               # Zod schemas for MCP tools
├── workflows/
│   ├── execute-task.ts        # Workflow orchestration
│   └── helpers/
│       ├── types.ts           # Shared types
│       ├── sandbox.ts         # Sandbox operations
│       ├── opencode.ts        # OpenCode operations
│       ├── backup.ts          # Backup/restore operations
│       └── git.ts             # Git operations
├── services/
│   ├── index.ts               # Re-exports (simplified)
│   ├── storage.ts             # StorageService (Effect)
│   └── telemetry.ts           # Event builders (simplified)
└── models/
    ├── index.ts               # Re-exports
    ├── errors.ts              # Reduced error types
    ├── session.ts             # Session types
    └── run.ts                 # Run types
```

### Workflow Helper Pattern

Instead of Effect services, use plain functions with explicit dependencies:

```typescript
// workflows/helpers/sandbox.ts

import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";

export interface SandboxDeps {
  sandboxBinding: DurableObjectNamespace;
  r2Config?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export function getSandbox(
  deps: SandboxDeps,
  sandboxId: string
): Sandbox<unknown> {
  return cfGetSandbox(deps.sandboxBinding, sandboxId, {
    normalizeId: true,
    sleepAfter: "10 minutes",
  });
}

export async function mountR2Storage(
  sandbox: Sandbox<unknown>,
  sessionId: string,
  config: SandboxDeps["r2Config"]
): Promise<void> {
  if (!config) return;

  await sandbox.mountBucket(
    `opencode-sessions:/${sessionId}/workspace`,
    "/workspace",
    {
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }
  );
}

export async function setupGitCredentials(
  sandbox: Sandbox<unknown>,
  githubToken?: string
): Promise<void> {
  if (!githubToken) return;

  await sandbox.setEnvVars({
    GIT_ASKPASS: "echo",
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: githubToken,
    GITHUB_TOKEN: githubToken,
  });

  await sandbox.exec(
    `git config --global credential.helper '!f() { echo "password=$GITHUB_TOKEN"; }; f'`
  );
  await sandbox.exec(`git config --global user.email "opencode@sandbox.workers.dev"`);
  await sandbox.exec(`git config --global user.name "OpenCode Bot"`);
}

export async function cloneRepository(
  sandbox: Sandbox<unknown>,
  url: string,
  branch?: string
): Promise<void> {
  const checkResult = await sandbox.exec(
    "test -d /workspace/.git && echo exists || echo missing"
  );

  if (checkResult.stdout.trim() === "exists") {
    await sandbox.exec("cd /workspace && git fetch origin");
    if (branch) {
      await sandbox.exec(`cd /workspace && git checkout ${branch}`);
    }
    return;
  }

  await sandbox.gitCheckout(url, {
    branch: branch ?? "main",
    targetDir: "/workspace",
  });
}
```

### Result Pattern for Error Handling

Without Effect, use a simple Result pattern for operations that can fail:

```typescript
// workflows/helpers/types.ts

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Usage in helpers:
export async function executeTask(
  client: OpencodeClient,
  params: TaskParams
): Promise<Result<TaskOutput, TaskError>> {
  try {
    // ... implementation
    return ok({ success: true, output: "..." });
  } catch (e) {
    return err({ code: "EXECUTION_FAILED", message: String(e) });
  }
}
```

### Simplified Workflow

```typescript
// workflows/execute-task.ts

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { WorkflowEventBuilder } from "../services/telemetry";
import * as Sandbox from "./helpers/sandbox";
import * as OpenCode from "./helpers/opencode";
import * as Backup from "./helpers/backup";
import * as Git from "./helpers/git";
import type { TaskParams, TaskResult } from "./helpers/types";

export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep): Promise<TaskResult> {
    const params = event.payload;
    const telemetry = new WorkflowEventBuilder(params.runId, params.sessionId, params.task.slice(0, 100));

    const deps: Sandbox.SandboxDeps = {
      sandboxBinding: this.env.Sandbox,
      r2Config: this.env.R2_ACCOUNT_ID ? {
        accountId: this.env.R2_ACCOUNT_ID,
        accessKeyId: this.env.R2_ACCESS_KEY_ID,
        secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
      } : undefined,
    };

    try {
      // Step 1: Mount storage
      await step.do("mount-storage", async () => {
        const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
        await Sandbox.mountR2Storage(sandbox, params.sessionId, deps.r2Config);
        return { mounted: true };
      });

      // Step 2: Restore session
      const restored = await step.do("restore-session", async () => {
        const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
        return Backup.restoreSession(sandbox, params.sessionId, this.env.SESSIONS_BUCKET);
      });
      telemetry.setMetadata({ sessionRestored: restored });

      // Step 3: Git credentials
      await step.do("setup-git", async () => {
        const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
        await Sandbox.setupGitCredentials(sandbox, this.env.GITHUB_TOKEN);
        return { configured: true };
      });

      // Step 4: Clone if needed
      if (params.repositoryUrl) {
        await step.do("clone-repo", async () => {
          const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
          await Sandbox.cloneRepository(sandbox, params.repositoryUrl!, params.branch);
          return { cloned: true };
        });
      }

      // Step 5: Execute task
      const taskResult = await step.do("execute-task", {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "50 minutes",
      }, async () => {
        const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
        return OpenCode.executeTask(sandbox, params);
      });

      // Step 6: Backup
      await step.do("backup-session", async () => {
        const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
        await Backup.backupSession(sandbox, params.sessionId, this.env.SESSIONS_BUCKET);
        return { backedUp: true };
      });

      // Step 7: Git status
      const gitInfo = await step.do("git-status", async () => {
        const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
        return Git.getStatus(sandbox);
      });

      const result: TaskResult = {
        success: taskResult.success,
        output: taskResult.output,
        error: taskResult.error,
        filesCreated: taskResult.filesCreated,
        filesModified: gitInfo.filesModified,
        commits: gitInfo.commits,
        branch: gitInfo.branch,
      };

      // Step 8: Notify DO
      await step.do("notify", async () => {
        await this.notifyCompletion(params.doId, params.runId, result);
        return { notified: true };
      });

      telemetry.setOutcome("success");
      this.emitTelemetry(telemetry.finalize());
      return result;

    } catch (error) {
      // Error handling...
    }
  }

  // ... helper methods
}
```

### Benefits of This Pattern

1. **Testable** - Helper functions take explicit deps, easy to mock
2. **Readable** - Workflow is orchestration, helpers are implementation
3. **No dead abstractions** - Only code that's used exists
4. **Type-safe** - Full TypeScript without Effect overhead in workflow
5. **Consistent with Effect** - DO still uses Effect properly

---

## Implementation Plan

### Phase 1: Delete Dead Code

1. Delete `src/services/sandbox.ts`
2. Delete `src/services/opencode.ts`
3. Delete `src/services/backup.ts`
4. Update `src/services/index.ts` to remove exports
5. Run tests, ensure nothing breaks

### Phase 2: Simplify Telemetry

1. Remove `TelemetryService`, `TelemetryLive`, `TelemetryServiceInterface`
2. Keep only `ToolCallEventBuilder`, `WorkflowEventBuilder`
3. Update imports in mcp-agent.ts and execute-task.ts

### Phase 3: Clean Up Errors

1. Delete unused error types from `models/errors.ts`
2. Keep only errors that are actually thrown/caught
3. Update type guards if needed

### Phase 4: Extract Workflow Helpers

1. Create `src/workflows/helpers/` directory
2. Create `types.ts` with shared types
3. Extract sandbox operations to `sandbox.ts`
4. Extract OpenCode operations to `opencode.ts`
5. Extract backup operations to `backup.ts`
6. Extract git operations to `git.ts`
7. Refactor `execute-task.ts` to use helpers

### Phase 5: Verify & Test

1. Run `npm run typecheck`
2. Run `npm test`
3. Manual testing with `wrangler dev`
4. Review for any missed dead code

---

## File-by-File Changes

### Files to DELETE

| File | Reason |
|------|--------|
| `src/services/sandbox.ts` | Never used, workflow has inline implementation |
| `src/services/opencode.ts` | Never used, workflow has inline implementation |
| `src/services/backup.ts` | Never used, workflow has inline implementation |

### Files to MODIFY

| File | Changes |
|------|---------|
| `src/services/index.ts` | Remove exports for deleted services |
| `src/services/telemetry.ts` | Remove unused Effect service layer |
| `src/models/errors.ts` | Remove ~14 unused error classes |
| `src/models/index.ts` | No changes needed |
| `src/workflows/execute-task.ts` | Refactor to use helper modules |

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/workflows/helpers/types.ts` | Shared types, Result pattern |
| `src/workflows/helpers/sandbox.ts` | Sandbox operations |
| `src/workflows/helpers/opencode.ts` | OpenCode operations |
| `src/workflows/helpers/backup.ts` | Backup/restore operations |
| `src/workflows/helpers/git.ts` | Git status operations |

### Files to KEEP (No Changes)

| File | Reason |
|------|--------|
| `src/index.ts` | Working entry point |
| `src/agent/mcp-agent.ts` | Working MCP Agent with Effect |
| `src/agent/tools.ts` | Working Zod schemas |
| `src/services/storage.ts` | Working StorageService |
| `src/models/session.ts` | Working types + constants |
| `src/models/run.ts` | Working types + constants |

---

## Success Criteria

After implementation:

1. **No dead code** - All exports are imported somewhere
2. **Tests pass** - `npm test` succeeds
3. **TypeScript compiles** - `npm run typecheck` succeeds
4. **Workflow is readable** - Orchestration separate from implementation
5. **Helpers are testable** - Functions take explicit dependencies
6. **Effect used correctly** - Only in DO context where it works

---

## Appendix: Research Summary

### Why Effect Doesn't Work in Workflows

1. **Separate execution contexts** - Workflows run in different V8 isolates
2. **Hibernation** - Workflows hibernate between steps, losing in-memory state
3. **Serialization requirement** - Step results must be JSON-serializable
4. **No runtime persistence** - Can't maintain Effect runtime across steps

### What Effect IS Good For (in this codebase)

1. **Durable Object context** - MCP Agent can hold ManagedRuntime
2. **Schema validation** - `Schema.decodeUnknown` works anywhere
3. **Tagged errors** - Good for domain modeling in DO
4. **Service abstraction** - StorageService pattern works well

### Sources

- [Effect-TS GitHub Issue #4636](https://github.com/Effect-TS/effect/issues/4636) - Cloudflare binding support
- [Cloudflare Workflows Docs](https://developers.cloudflare.com/workflows/)
- [@effect/workflow npm](https://www.npmjs.com/package/@effect/workflow) - Effect's workflow (requires Node.js)
- [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)

---

**Document Version**: 1.0
**Created**: 2024-12-21
**Status**: Ready for Implementation
