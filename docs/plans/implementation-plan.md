# Implementation Plan: MCP Tool Redesign

**Date**: 2024-12-22  
**Design Doc**: `docs/plans/2024-12-22-mcp-tool-design.md`  
**Approach**: Breaking changes (no backward compatibility needed)

---

## Overview

Transform the MCP tools from the current 3-tool design to the new 3-tool design:

| Current | New |
|---------|-----|
| `opencode_create_session` | (removed - implicit in run_task) |
| `opencode_run_task` | `opencode_run_task` (enhanced) |
| `opencode_get_status` | `opencode_get_result` (simplified) |
| - | `opencode_list_runs` (new) |

---

## Key Technical Decisions

### 1. OpenCode Session Handling

**For new sessions:**
```typescript
// Create session without a title - let OpenCode auto-generate
const session = await client.session.create({
  query: { directory: workingDirectory }
  // No title - OpenCode will generate one on first prompt
});
```

**For continuing sessions:**
```typescript
// Just call prompt() with existing sessionId
// OpenCode automatically continues the conversation
const response = await client.session.prompt({
  path: { id: existingOpencodeSessionId },
  query: { directory: workingDirectory },
  body: { parts: [{ type: "text", text: task }] }
});
```

**Getting the title after task completion:**
```typescript
// Fetch session to get auto-generated title
const session = await client.session.get({
  path: { id: opencodeSessionId }
});
const title = session.data.title;
```

### 2. Session vs OpenCode Session

We have two levels of "session":
- **Our session** (`SessionMetadata`): Tracks sandbox, repo URL, runs - stored in DO
- **OpenCode session**: Conversation context inside the sandbox - managed by OpenCode

Mapping:
- One of our sessions → One sandbox → One OpenCode session (for continuation)
- We need to track the OpenCode session ID to enable true continuation

**Decision**: Store `opencodeSessionId` in `SessionMetadata` to enable continuation.

### 3. Prompting Strategy

The task description goes directly to OpenCode. For better output, we prepend instructions:

```typescript
const enhancedTask = `${task}

When you're done, please summarize:
- What you accomplished
- Files created, modified, or deleted
- Any commits made (with commit hashes and which repos)
- Any issues or warnings`;
```

This ensures the unstructured `output` contains useful information without us parsing structured fields.

---

## Implementation Tasks

### Phase 1: Models & Storage

#### Task 1.1: Update Run Model
**File**: `src/models/run.ts`

Changes:
- Add `title: string` field (required in schema, will be set after task completes)
- Update status enum: remove `"queued"`, rename to `"started"`, remove `"retrying"`
- Simplify `result` schema (remove `filesCreated`, `filesModified`, `commits`, `branch`, `toolOutputs`)

```typescript
export const RunStatus = Schema.Literal("started", "running", "completed", "failed");

export const RunResult = Schema.Struct({
  success: Schema.Boolean,
  output: Schema.String,
  error: Schema.optionalWith(Schema.String, { exact: true }),
});

export const RunRecord = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  workflowId: Schema.String,
  status: RunStatus,
  task: Schema.String,
  title: Schema.String,                // NEW - required
  model: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  result: Schema.optionalWith(RunResult, { exact: true }),
});
```

#### Task 1.2: Update Session Model
**File**: `src/models/session.ts`

Changes:
- Add `opencodeSessionId?: string` field to track OpenCode session for continuation
- Add `clonedRepos?: string[]` to track which repos have been cloned

```typescript
// Add to SessionMetadata schema
opencodeSessionId: Schema.optionalWith(Schema.String, { exact: true }),
clonedRepos: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
```

#### Task 1.3: Update Storage Service
**File**: `src/services/storage.ts`

Changes:
- Add `listAllRuns(options)` method for cross-session listing
- Update `listRuns` to support `before` cursor pagination
- Ensure index on `started_at` for efficient queries

```typescript
// New method
listAllRuns(options?: {
  sessionId?: string;
  status?: string;
  limit?: number;
  before?: number;
}): Effect.Effect<RunRecord[], StorageError>

// Implementation uses SQL:
// SELECT * FROM runs 
// WHERE ($sessionId IS NULL OR session_id = $sessionId)
//   AND ($status IS NULL OR status = $status)
//   AND ($before IS NULL OR started_at < $before)
// ORDER BY started_at DESC
// LIMIT $limit
```

#### Task 1.4: Add Error Types
**File**: `src/models/errors.ts`

Add:
```typescript
export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()(
  "RunNotFoundError",
  { runId: Schema.String }
) {
  get message() {
    return `Run "${this.runId}" not found`;
  }
}
```

---

### Phase 2: Workflow Changes

#### Task 2.1: Update Workflow Types
**File**: `src/workflows/helpers/types.ts`

Changes:
- Simplify `TaskResult` (remove structured fields)
- Simplify `OpenCodeTaskResult`
- Update `McpAgentStub.onTaskComplete` signature

```typescript
export interface OpenCodeTaskResult {
  success: boolean;
  output: string;
  error?: string;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
  };
}

export interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  title?: string;           // NEW - from OpenCode
  opencodeSessionId?: string; // NEW - for continuation tracking
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
  };
}

export interface McpAgentStub {
  onTaskComplete: (params: {
    runId: string;
    result: TaskResult;
  }) => Promise<void>;
}
```

Remove:
- `GitStatus` type
- `toolOutputs` from `OpenCodeTaskResult`
- `filesCreated`, `filesModified`, `commits`, `branch` from results

#### Task 2.2: Update OpenCode Helper
**File**: `src/workflows/helpers/opencode.ts`

Changes:
- Add `getSessionTitle()` function
- Update `executeTask()` to return `opencodeSessionId`
- Support session continuation (use existing OpenCode session if provided)
- Add task output enhancement (prepend instructions)
- Simplify return type

```typescript
// New function to get title
export async function getSessionTitle(
  client: OpencodeClient,
  opencodeSessionId: string,
): Promise<string> {
  const session = await client.session.get({
    path: { id: opencodeSessionId }
  });
  return session.data?.title ?? "Untitled";
}

// Updated executeTask signature
export async function executeTask(
  sandbox: Sandbox<unknown>,
  params: TaskParams & { existingOpencodeSessionId?: string },
  workingDirectory: string,
): Promise<{
  result: OpenCodeTaskResult;
  opencodeSessionId: string;
}>

// Enhance task with output instructions
function enhanceTask(task: string): string {
  return `${task}

When you're done, please summarize:
- What you accomplished
- Files created, modified, or deleted
- Any commits made (with commit hashes and which repos)
- Any issues or warnings`;
}
```

#### Task 2.3: Update Workflow
**File**: `src/workflows/execute-task.ts`

Changes:
- Pass `existingOpencodeSessionId` from session metadata for continuation
- Add step to get session title after task execution
- Update `onTaskComplete` callback with title and opencodeSessionId
- Remove `get-git-status` step (info goes in unstructured output)
- Simplify result structure

```typescript
// In TaskParams, add:
existingOpencodeSessionId?: string;

// New step after execute-opencode-task
const title = await step.do("get-session-title", async () => {
  return getSessionTitle(client, opencodeSessionId);
});

// Updated callback
await stub.onTaskComplete({
  runId: params.runId,
  result: {
    success: taskResult.success,
    output: taskResult.output,
    error: taskResult.error,
    title,
    opencodeSessionId,
    tokens: taskResult.tokens,
  },
});
```

---

### Phase 3: Tool Schemas

#### Task 3.1: Rewrite Tool Schemas
**File**: `src/agent/tools.ts`

Complete rewrite:

```typescript
// Remove createSessionInputSchema entirely

// opencode_run_task - enhanced
export const runTaskInputSchema = z.object({
  sessionId: z.string().optional()
    .describe("Continue existing session. Creates new if omitted."),
  
  repository: z.string()
    .refine(url => url.startsWith("https://github.com/"), {
      message: "Must be a GitHub URL"
    })
    .optional()
    .describe("GitHub repository URL to clone."),
  
  task: z.string().max(TASK_MAX_LENGTH)
    .describe("Natural language task description."),
  
  branch: z.string().optional()
    .describe("Git branch. Defaults to 'main'."),
  
  model: z.string().optional()
    .describe("AI model. Defaults to claude-sonnet-4-20250514."),
  
  title: z.string().max(100).optional()
    .describe("Short label (2-5 words). Auto-generated if omitted."),
});
export type RunTaskInput = z.infer<typeof runTaskInputSchema>;

// opencode_get_result - simplified
export const getResultInputSchema = z.object({
  runId: z.string()
    .describe("Run ID from opencode_run_task."),
});
export type GetResultInput = z.infer<typeof getResultInputSchema>;

// opencode_list_runs - new
export const listRunsInputSchema = z.object({
  sessionId: z.string().optional()
    .describe("Filter by session."),
  
  status: z.enum(["started", "running", "completed", "failed"]).optional()
    .describe("Filter by status."),
  
  limit: z.number().int().min(1).max(100).default(10)
    .describe("Max runs to return. Default 10."),
  
  before: z.number().optional()
    .describe("Unix timestamp cursor for pagination."),
});
export type ListRunsInput = z.infer<typeof listRunsInputSchema>;
```

---

### Phase 4: MCP Agent

#### Task 4.1: Remove Create Session Tool
**File**: `src/agent/mcp-agent.ts`

- Delete `registerCreateSessionTool()` method entirely
- Remove call from `init()`

#### Task 4.2: Rewrite Run Task Tool
**File**: `src/agent/mcp-agent.ts`

Major rewrite of `registerRunTaskTool()`:

```typescript
private registerRunTaskTool(): void {
  this.server.registerTool(
    "opencode_run_task",
    {
      description: "Execute a coding task in a sandbox. Creates session if needed, or continues existing session.",
      inputSchema: runTaskInputSchema,
    },
    async (params: RunTaskInput) => {
      const telemetry = new ToolCallEventBuilder("opencode_run_task", params.sessionId ?? "new");
      
      try {
        const rt = this.ensureRuntime();
        let session: SessionMetadata;
        let isNewSession = false;
        
        // 1. Resolve or create session
        if (params.sessionId) {
          // Continue existing session
          const existing = await rt.runPromise(/* getSession */);
          if (existing._tag === "None") {
            return formatErrorResponse({
              code: "SESSION_NOT_FOUND",
              message: `Session "${params.sessionId}" not found`,
            });
          }
          session = existing.value;
        } else {
          // Create new session
          isNewSession = true;
          const sessionId = crypto.randomUUID().slice(0, 8);
          session = {
            sessionId,
            sandboxId: sessionId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: "active",
            workspacePath: "/workspace",
            webUiUrl: `${this.env.WEB_UI_BASE_URL}/session/${sessionId}/`,
            repository: params.repository ? {
              url: params.repository,
              branch: params.branch ?? "main",
            } : undefined,
            clonedRepos: params.repository ? [params.repository] : [],
            config: { defaultModel: "claude-sonnet-4-20250514" },
          };
          await rt.runPromise(/* putSession */);
        }
        
        // 2. Check if additional repo needs cloning
        const needsClone = params.repository && 
          !session.clonedRepos?.includes(params.repository);
        
        // 3. Create run record
        const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
        const run: RunRecord = {
          runId,
          sessionId: session.sessionId,
          workflowId: runId,
          status: "started",
          task: params.task,
          title: params.title ?? "Processing...", // Placeholder until OpenCode generates
          model: params.model ?? session.config.defaultModel,
          startedAt: Date.now(),
        };
        await rt.runPromise(/* putRun */);
        
        // 4. Create proxy token and start workflow
        const proxyToken = await rt.runPromise(createProxyToken({...}));
        
        await this.env.EXECUTE_TASK_WORKFLOW.create({
          id: runId,
          params: {
            sessionId: session.sessionId,
            sandboxId: session.sandboxId,
            task: params.task,
            model: run.model,
            runId,
            doId: this.agentContext.ctx.id.toString(),
            repositoryUrl: needsClone ? params.repository : session.repository?.url,
            branch: params.branch ?? session.repository?.branch,
            existingOpencodeSessionId: session.opencodeSessionId,
            proxyToken,
            proxyBaseUrl: this.env.PROXY_BASE_URL,
          },
        });
        
        return formatToolResponse({
          runId,
          sessionId: session.sessionId,
          status: "started",
          webUiUrl: session.webUiUrl,
        });
      } catch (error) {
        // Error handling...
      }
    }
  );
}
```

#### Task 4.3: Rewrite Get Status → Get Result Tool
**File**: `src/agent/mcp-agent.ts`

Rename and simplify:

```typescript
private registerGetResultTool(): void {
  this.server.registerTool(
    "opencode_get_result",
    {
      description: "Get the status and result of a specific task run.",
      inputSchema: getResultInputSchema,
    },
    async (params: GetResultInput) => {
      const telemetry = new ToolCallEventBuilder("opencode_get_result", params.runId);
      
      try {
        const rt = this.ensureRuntime();
        
        const run = await rt.runPromise(/* getRun */);
        if (run._tag === "None") {
          return formatErrorResponse({
            code: "RUN_NOT_FOUND",
            message: `Run "${params.runId}" not found`,
          });
        }
        
        const session = await rt.runPromise(/* getSession */);
        
        return formatToolResponse({
          runId: run.value.runId,
          sessionId: run.value.sessionId,
          status: run.value.status,
          task: run.value.task,
          title: run.value.title,
          startedAt: run.value.startedAt,
          completedAt: run.value.completedAt,
          result: run.value.result,
          webUiUrl: session._tag === "Some" ? session.value.webUiUrl : undefined,
        });
      } catch (error) {
        // Error handling...
      }
    }
  );
}
```

#### Task 4.4: Add List Runs Tool
**File**: `src/agent/mcp-agent.ts`

New method:

```typescript
private registerListRunsTool(): void {
  this.server.registerTool(
    "opencode_list_runs",
    {
      description: "List past task runs. Use to discover old work or see history.",
      inputSchema: listRunsInputSchema,
    },
    async (params: ListRunsInput) => {
      const telemetry = new ToolCallEventBuilder("opencode_list_runs", "list");
      
      try {
        const rt = this.ensureRuntime();
        
        const runs = await rt.runPromise(
          Effect.gen(function* () {
            const storage = yield* StorageService;
            return yield* storage.listAllRuns({
              sessionId: params.sessionId,
              status: params.status,
              limit: (params.limit ?? 10) + 1, // Fetch one extra to check hasMore
              before: params.before,
            });
          })
        );
        
        const hasMore = runs.length > (params.limit ?? 10);
        const returnRuns = hasMore ? runs.slice(0, -1) : runs;
        
        return formatToolResponse({
          runs: returnRuns.map(r => ({
            runId: r.runId,
            sessionId: r.sessionId,
            status: r.status,
            title: r.title,
            task: r.task.length > 100 ? r.task.slice(0, 100) + "..." : r.task,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            success: r.result?.success,
          })),
          hasMore,
        });
      } catch (error) {
        // Error handling...
      }
    }
  );
}
```

#### Task 4.5: Update onTaskComplete RPC
**File**: `src/agent/mcp-agent.ts`

Update to handle new result shape:

```typescript
async onTaskComplete(params: {
  runId: string;
  result: {
    success: boolean;
    output?: string;
    error?: string;
    title?: string;
    opencodeSessionId?: string;
    tokens?: { input: number; output: number; reasoning: number };
  };
}): Promise<void> {
  const rt = this.ensureRuntime();
  
  await rt.runPromise(
    Effect.gen(function* () {
      const storage = yield* StorageService;
      const existing = yield* storage.getRun(params.runId);
      
      if (existing._tag === "Some") {
        // Update run with result
        const updated: RunRecord = {
          ...existing.value,
          status: params.result.success ? "completed" : "failed",
          completedAt: Date.now(),
          title: params.result.title ?? existing.value.title,
          result: {
            success: params.result.success,
            output: params.result.output ?? "",
            error: params.result.error,
          },
        };
        yield* storage.putRun(updated);
        
        // Update session with opencodeSessionId for continuation
        if (params.result.opencodeSessionId) {
          const session = yield* storage.getSession(existing.value.sessionId);
          if (session._tag === "Some") {
            yield* storage.putSession({
              ...session.value,
              opencodeSessionId: params.result.opencodeSessionId,
              lastActivity: Date.now(),
            });
          }
        }
      }
    })
  );
}
```

#### Task 4.6: Update init() Registration
**File**: `src/agent/mcp-agent.ts`

```typescript
async init(): Promise<void> {
  // ... existing setup ...
  
  // Register tools - NEW ORDER
  this.registerRunTaskTool();      // Was second, now first
  this.registerGetResultTool();    // Renamed from registerGetStatusTool
  this.registerListRunsTool();     // NEW
  
  // REMOVED: this.registerCreateSessionTool();
  
  this.setState({ initialized: true });
}
```

---

### Phase 5: Configuration & Cleanup

#### Task 5.1: Add WEB_UI_BASE_URL
**File**: `worker-configuration.d.ts`

```typescript
interface Env {
  // ... existing ...
  WEB_UI_BASE_URL: string;
}
```

**File**: `.dev.vars.example`
```
WEB_UI_BASE_URL=http://localhost:8788
```

#### Task 5.2: Cleanup Unused Code

Remove from various files:
- `createSessionInputSchema` from `tools.ts`
- `registerCreateSessionTool()` from `mcp-agent.ts`
- `GitStatus` type from `types.ts`
- `get-git-status` step from `execute-task.ts`
- `includeGitStatus` parameter from schemas
- `toolOutputs` from result types
- Structured result fields (`filesCreated`, `filesModified`, `commits`, `branch`)

---

## Task Dependency Graph

```
Phase 1 (Models & Storage)
├── 1.1 Update Run Model
├── 1.2 Update Session Model  
├── 1.3 Update Storage Service (depends on 1.1, 1.2)
└── 1.4 Add Error Types

Phase 2 (Workflow)
├── 2.1 Update Workflow Types (depends on 1.1)
├── 2.2 Update OpenCode Helper (depends on 2.1)
└── 2.3 Update Workflow (depends on 2.2, 1.2)

Phase 3 (Tool Schemas)
└── 3.1 Rewrite Tool Schemas (depends on 1.1)

Phase 4 (MCP Agent) - depends on all above
├── 4.1 Remove Create Session Tool
├── 4.2 Rewrite Run Task Tool
├── 4.3 Rewrite Get Result Tool
├── 4.4 Add List Runs Tool
├── 4.5 Update onTaskComplete RPC
└── 4.6 Update init() Registration

Phase 5 (Cleanup) - after Phase 4
├── 5.1 Add WEB_UI_BASE_URL
└── 5.2 Cleanup Unused Code
```

---

## Execution Order (Recommended)

1. **Phase 1**: Models & Storage - foundation changes
2. **Phase 2**: Workflow Changes - update how tasks execute
3. **Phase 3**: Tool Schemas - define new interfaces
4. **Phase 4**: MCP Agent - integrate everything
5. **Phase 5**: Cleanup - remove old code

Each phase can be committed separately for easier review.

---

## Testing Checklist

After implementation, test these scenarios:

- [ ] New task on new repo (no sessionId, with repository)
- [ ] New task on empty sandbox (no sessionId, no repository)
- [ ] Continue existing session (with sessionId)
- [ ] Add additional repo to session (sessionId + new repository)
- [ ] Get result for running task
- [ ] Get result for completed task
- [ ] Get result for failed task
- [ ] List runs with no filters
- [ ] List runs filtered by sessionId
- [ ] List runs filtered by status
- [ ] Pagination with `before` cursor
- [ ] Error: session not found
- [ ] Error: run not found
- [ ] Title auto-generation by OpenCode
- [ ] Session continuation (same OpenCode conversation)

---

## Files Summary

### Modified Files
- `src/models/run.ts` - Simplified schema
- `src/models/session.ts` - Add opencodeSessionId, clonedRepos
- `src/models/errors.ts` - Add RunNotFoundError
- `src/services/storage.ts` - Add listAllRuns
- `src/workflows/helpers/types.ts` - Simplified types
- `src/workflows/helpers/opencode.ts` - Title retrieval, continuation support
- `src/workflows/execute-task.ts` - New steps, simplified result
- `src/agent/tools.ts` - Complete rewrite
- `src/agent/mcp-agent.ts` - Major changes
- `worker-configuration.d.ts` - Add WEB_UI_BASE_URL
- `.dev.vars.example` - Add WEB_UI_BASE_URL

### Deleted Code
- `registerCreateSessionTool()` method
- `createSessionInputSchema`
- `GitStatus` type
- `get-git-status` workflow step
- Structured result fields
