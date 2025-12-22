# MCP Tool Design - Refined Specification

**Date**: 2024-12-22  
**Status**: Final Design  
**Supersedes**: Tool Specifications section in `sandbox-mcp-design.md`

---

## Overview

This document defines the MCP tool interface for sandbox-mcp. It supersedes the tool specifications in the original design document based on learnings from implementation and usage.

### Design Principles

1. **Fire-and-forget optimized**: Primary use case is kicking off tasks from mobile, checking later
2. **Parallel task support**: Multiple tasks can run concurrently
3. **Minimal tool count**: Each tool has one clear purpose
4. **Discovery enabled**: Users can reconnect to old work without remembering IDs
5. **Unstructured output**: Don't force-fit structure onto inherently variable AI output

### Tool Summary

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `opencode_run_task` | Start a coding task | "Do the thing" |
| `opencode_get_result` | Check a specific task's status/result | "What happened?" |
| `opencode_list_runs` | Browse past tasks | "What's been going on?" |

---

## Tool 1: `opencode_run_task`

**Purpose**: Execute a coding task in a sandbox. Creates a session if needed, or continues an existing one.

### Input Schema

```typescript
{
  // Session continuation (optional)
  sessionId?: string
  // Session ID to continue. If provided, reuses existing sandbox.
  // If omitted, creates a new session.

  // Repository (optional)
  repository?: string
  // GitHub URL to clone (e.g., "https://github.com/user/repo").
  // If sessionId is provided and repo is new, clones additionally.
  // If sessionId is provided and repo already exists, skips cloning.
  // If omitted and no sessionId, creates empty sandbox.

  // Task (required)
  task: string
  // Natural language description of what to do.
  // Be specific and clear.

  // Git branch (optional)
  branch?: string
  // Branch to checkout. Defaults to "main".

  // AI model (optional)
  model?: string
  // Model for OpenCode to use. Defaults to "claude-sonnet-4-20250514".

  // Title (optional)
  title?: string
  // Short label for this task (2-5 words).
  // If not provided, OpenCode generates one automatically.
}
```

### Output Schema

```typescript
{
  runId: string
  // Unique identifier for this task. Use with opencode_get_result.

  sessionId: string
  // Session identifier. Use to continue work in the same sandbox.

  status: "started"
  // Confirms task was accepted and is starting.

  webUiUrl: string
  // Absolute URL to view progress in browser.
}
```

### Behavior

1. **Session Resolution**:
   - If `sessionId` provided → continue that session (same sandbox)
   - If `repository` provided (no sessionId) → create new session, clone repo
   - If neither → create new session with empty sandbox

2. **Repository Handling**:
   - Repos clone to `/workspace/{repo-name}`
   - If `sessionId` + `repository` both provided:
     - If repo not already in sandbox → clone it additionally
     - If repo already exists → skip cloning
   - OpenCode starts with `/workspace` as working directory

3. **Title Generation**:
   - If `title` provided → use it
   - If not → OpenCode generates one (available in `get_result` after completion)

4. **Async Execution**:
   - Returns immediately after task is queued
   - Actual work happens in background via Workflow
   - Use `opencode_get_result` to check progress

### Example: New Task on Repo

```json
// Request
{
  "repository": "https://github.com/myorg/api",
  "task": "Add JWT authentication with refresh tokens",
  "title": "Add JWT auth"
}

// Response
{
  "runId": "run-a1b2c3d4",
  "sessionId": "sess-e5f6g7h8",
  "status": "started",
  "webUiUrl": "https://sandbox-mcp.example.com/session/sess-e5f6g7h8/"
}
```

### Example: Continue Previous Session

```json
// Request
{
  "sessionId": "sess-e5f6g7h8",
  "task": "Now add rate limiting to the auth endpoints"
}

// Response
{
  "runId": "run-i9j0k1l2",
  "sessionId": "sess-e5f6g7h8",
  "status": "started",
  "webUiUrl": "https://sandbox-mcp.example.com/session/sess-e5f6g7h8/"
}
```

### Example: Add Another Repo to Session

```json
// Request
{
  "sessionId": "sess-e5f6g7h8",
  "repository": "https://github.com/myorg/shared-utils",
  "task": "Integrate shared-utils into the API project"
}

// Response
{
  "runId": "run-m3n4o5p6",
  "sessionId": "sess-e5f6g7h8",
  "status": "started",
  "webUiUrl": "https://sandbox-mcp.example.com/session/sess-e5f6g7h8/"
}
```

---

## Tool 2: `opencode_get_result`

**Purpose**: Get the status and result of a specific task run.

### Input Schema

```typescript
{
  runId: string
  // Run ID from opencode_run_task.
}
```

### Output Schema

```typescript
{
  runId: string
  // The run identifier.

  sessionId: string
  // Session this run belongs to.

  status: "started" | "running" | "completed" | "failed"
  // Current state of the task.
  // - started: Task accepted, sandbox spinning up
  // - running: OpenCode is actively working
  // - completed: Finished successfully
  // - failed: Finished with error

  task: string
  // The original task description.

  title: string
  // Short label (provided or auto-generated by OpenCode).

  startedAt: number
  // Unix timestamp when task started.

  completedAt?: number
  // Unix timestamp when task finished (only if completed/failed).

  result?: {
    success: boolean
    // Whether the task completed successfully.

    output: string
    // OpenCode's response - contains summary, what was done,
    // files changed, commits made, etc. in natural language.

    error?: string
    // Error message if failed.
  }

  webUiUrl: string
  // Absolute URL to view this session in browser.
}
```

### Behavior

1. **Polling-friendly**: Safe to call repeatedly while task is running
2. **Result availability**: `result` field only present when status is `completed` or `failed`
3. **Title availability**: If title wasn't provided in `run_task`, the auto-generated title is available after task completes
4. **Unstructured output**: The `result.output` contains all details (files changed, commits, etc.) in natural language - we intentionally don't parse this into structured fields

### Example: Task In Progress

```json
// Request
{ "runId": "run-a1b2c3d4" }

// Response
{
  "runId": "run-a1b2c3d4",
  "sessionId": "sess-e5f6g7h8",
  "status": "running",
  "task": "Add JWT authentication with refresh tokens",
  "title": "Add JWT auth",
  "startedAt": 1703001234000,
  "webUiUrl": "https://sandbox-mcp.example.com/session/sess-e5f6g7h8/"
}
```

### Example: Task Completed

```json
// Request
{ "runId": "run-a1b2c3d4" }

// Response
{
  "runId": "run-a1b2c3d4",
  "sessionId": "sess-e5f6g7h8",
  "status": "completed",
  "task": "Add JWT authentication with refresh tokens",
  "title": "Add JWT auth",
  "startedAt": 1703001234000,
  "completedAt": 1703002345000,
  "result": {
    "success": true,
    "output": "I've implemented JWT authentication with refresh tokens. Here's what I did:\n\n1. Created `src/middleware/auth.ts` with JWT verification middleware\n2. Added `src/routes/auth.ts` with login, logout, and refresh endpoints\n3. Updated `src/server.ts` to use the auth middleware\n4. Added tests in `tests/auth.test.ts`\n\nCommits made:\n- a3f8d2c: Add JWT authentication middleware\n- b4e9a1f: Add auth routes and tests\n\nAll tests pass. The implementation uses RS256 for token signing."
  },
  "webUiUrl": "https://sandbox-mcp.example.com/session/sess-e5f6g7h8/"
}
```

### Example: Task Failed

```json
// Request
{ "runId": "run-x9y8z7w6" }

// Response
{
  "runId": "run-x9y8z7w6",
  "sessionId": "sess-e5f6g7h8",
  "status": "failed",
  "task": "Deploy to production",
  "title": "Production deploy",
  "startedAt": 1703003456000,
  "completedAt": 1703003567000,
  "result": {
    "success": false,
    "output": "I attempted to deploy but encountered issues.",
    "error": "Deployment failed: missing AWS credentials. The sandbox doesn't have AWS_ACCESS_KEY_ID configured."
  },
  "webUiUrl": "https://sandbox-mcp.example.com/session/sess-e5f6g7h8/"
}
```

---

## Tool 3: `opencode_list_runs`

**Purpose**: List past task runs. Use to discover old work or see what's been happening.

### Input Schema

```typescript
{
  // Filter by session (optional)
  sessionId?: string
  // Only show runs from this session.

  // Filter by status (optional)
  status?: "started" | "running" | "completed" | "failed"
  // Only show runs with this status.

  // Pagination limit (optional)
  limit?: number
  // Maximum runs to return. Defaults to 10.

  // Pagination cursor (optional)
  before?: number
  // Unix timestamp. Returns runs started before this time.
  // Use for pagination: pass startedAt of last result to get older runs.
}
```

### Output Schema

```typescript
{
  runs: Array<{
    runId: string
    // Run identifier.

    sessionId: string
    // Session this run belongs to.

    status: "started" | "running" | "completed" | "failed"
    // Current state.

    title: string
    // Short label.

    task: string
    // Task description (truncated to ~100 chars).

    startedAt: number
    // Unix timestamp.

    completedAt?: number
    // Unix timestamp (if finished).

    success?: boolean
    // Quick indicator of outcome (only if completed/failed).
  }>

  hasMore: boolean
  // True if there are older runs available.
  // Use `before: runs[runs.length-1].startedAt` to fetch more.
}
```

### Behavior

1. **Default ordering**: Most recent first
2. **Pagination**: Use `before` parameter with `startedAt` of last result to get older runs
3. **Truncated task**: Task description is truncated for readability; use `get_result` for full text
4. **Quick status**: `success` field gives quick pass/fail without fetching full result

### Example: List Recent Runs

```json
// Request
{ "limit": 5 }

// Response
{
  "runs": [
    {
      "runId": "run-a1b2c3d4",
      "sessionId": "sess-e5f6g7h8",
      "status": "completed",
      "title": "Add JWT auth",
      "task": "Add JWT authentication with refresh tokens",
      "startedAt": 1703001234000,
      "completedAt": 1703002345000,
      "success": true
    },
    {
      "runId": "run-m3n4o5p6",
      "sessionId": "sess-e5f6g7h8",
      "status": "running",
      "title": "Add rate limiting",
      "task": "Add rate limiting to the auth endpoints...",
      "startedAt": 1703000123000
    },
    {
      "runId": "run-x9y8z7w6",
      "sessionId": "sess-q1w2e3r4",
      "status": "failed",
      "title": "Fix parser bug",
      "task": "Fix the memory leak in the parser module that occurs when...",
      "startedAt": 1702999012000,
      "completedAt": 1702999123000,
      "success": false
    }
  ],
  "hasMore": true
}
```

### Example: Filter by Session

```json
// Request
{
  "sessionId": "sess-e5f6g7h8",
  "limit": 10
}

// Response
{
  "runs": [
    {
      "runId": "run-a1b2c3d4",
      "sessionId": "sess-e5f6g7h8",
      "status": "completed",
      "title": "Add JWT auth",
      "task": "Add JWT authentication with refresh tokens",
      "startedAt": 1703001234000,
      "completedAt": 1703002345000,
      "success": true
    },
    {
      "runId": "run-m3n4o5p6",
      "sessionId": "sess-e5f6g7h8",
      "status": "running",
      "title": "Add rate limiting",
      "task": "Add rate limiting to the auth endpoints...",
      "startedAt": 1703000123000
    }
  ],
  "hasMore": false
}
```

### Example: Paginate Older Runs

```json
// First request
{ "limit": 10 }
// Response includes run with startedAt: 1702999012000, hasMore: true

// Second request (get older)
{
  "limit": 10,
  "before": 1702999012000
}
// Response: runs older than that timestamp
```

---

## Error Handling

All tools return errors in a consistent format:

```typescript
{
  error: {
    code: string
    // Machine-readable error code.

    message: string
    // Human-readable description.
  }
}
```

### Error Codes

| Code | Tool(s) | Description |
|------|---------|-------------|
| `SESSION_NOT_FOUND` | `run_task`, `get_result`, `list_runs` | Session ID doesn't exist |
| `RUN_NOT_FOUND` | `get_result` | Run ID doesn't exist |
| `INVALID_REPOSITORY_URL` | `run_task` | Repository URL is malformed |
| `REPOSITORY_CLONE_FAILED` | `run_task` | Failed to clone repository |
| `SANDBOX_STARTUP_FAILED` | `run_task` | Failed to start sandbox |
| `TASK_EXECUTION_FAILED` | `get_result` | Task failed during execution |
| `INVALID_INPUT` | All | Input validation failed |

### Example Error Response

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "Run 'run-invalid' does not exist"
  }
}
```

---

## Migration from Previous Design

### Removed: `opencode_create_session`

**Reason**: Session creation is now implicit in `opencode_run_task`. The separate tool added an unnecessary step for fire-and-forget usage.

**Migration**:
```
// Old (2 calls)
create_session(repository: "...") → sessionId
run_task(sessionId, task: "...")

// New (1 call)
run_task(repository: "...", task: "...") → { sessionId, runId }
```

### Renamed: `opencode_get_status` → `opencode_get_result`

**Reason**: Clearer purpose. "Status" was ambiguous (session status? run status?). "Result" clearly indicates "what happened with my task?"

### Added: `opencode_list_runs`

**Reason**: Enables discovery of old work without remembering IDs. Essential for the "reconnect to yesterday's work" use case.

### Removed Fields

| Field | Reason |
|-------|--------|
| `workspacePath` | Always `/workspace`, not useful |
| `workflowId` | Internal implementation detail |
| `retryCount`, `maxRetries` | Internal implementation detail |
| `model` in response | Caller already knows this |
| `repository` in response | Caller already knows this |
| `filesCreated`, `filesModified`, `commits`, `branch` | Moved to unstructured `output` |

### Changed: Structured → Unstructured Output

**Old**: Parsed fields like `filesCreated`, `filesModified`, `commits`, `branch`

**New**: Single `output` field with natural language description

**Reason**: 
- OpenCode is autonomous - it might clone multiple repos, make commits in different places, or do things we didn't anticipate
- Forcing structure on variable output creates edge cases (multi-repo, no-repo, non-git workflows)
- The calling AI can parse natural language; structured data adds complexity without benefit
- OpenCode can be prompted to include relevant details in its response

---

## Typical Usage Flows

### Flow 1: Fire-and-Forget Single Task

```
User: "Add dark mode to my app"

AI: run_task(repository: "...", task: "Add dark mode toggle in settings")
    → { runId: "run-abc", sessionId: "sess-123" }

AI: "Started! I'll check on it."

[Later]

AI: get_result(runId: "run-abc")
    → { status: "completed", result: { success: true, output: "..." } }

AI: "Done! Here's what happened: ..."
```

### Flow 2: Parallel Tasks

```
User: "Add dark mode, fix the login bug, and write tests"

AI: [In parallel]
    run_task(repository: "...", task: "Add dark mode...")
    run_task(repository: "...", task: "Fix login bug...")
    run_task(repository: "...", task: "Write tests...")
    → 3 runIds, 3 sessionIds

AI: [In parallel]
    get_result(runId: "run-1")
    get_result(runId: "run-2")
    get_result(runId: "run-3")

AI: "All three done! Dark mode: ✓, Login fix: ✓, Tests: ✓"
```

### Flow 3: Sequential Continuation

```
User: "Add the feature, then write tests for it"

AI: run_task(repository: "...", task: "Add feature X")
    → { runId: "run-1", sessionId: "sess-abc" }

[Poll until complete]

AI: run_task(sessionId: "sess-abc", task: "Write tests for feature X")
    → { runId: "run-2", sessionId: "sess-abc" }

[Same sandbox, work continues where it left off]
```

### Flow 4: Reconnect to Old Work

```
User: "What happened with that auth work from yesterday?"

AI: list_runs(limit: 10)
    → runs including { title: "Add JWT auth", runId: "run-xyz" }

AI: get_result(runId: "run-xyz")
    → { status: "completed", result: { output: "..." } }

AI: "Found it! Yesterday's auth work completed successfully. Here's the summary: ..."
```

### Flow 5: Continue Old Work

```
User: "Continue working on the auth feature from yesterday"

AI: list_runs()
    → { runId: "run-xyz", sessionId: "sess-old", title: "Add JWT auth" }

AI: run_task(sessionId: "sess-old", task: "Add password reset functionality")
    → { runId: "run-new", sessionId: "sess-old" }

[Reuses same sandbox with all previous work intact]
```

---

## Implementation Notes

### Title Generation

OpenCode generates titles for conversations. To retrieve:

1. After `client.session.prompt()` completes, call `client.session.get()`
2. The `session.title` field contains the auto-generated title
3. Store this in the run record for `get_result` and `list_runs`

### Web UI URL

Must be absolute URL. Configure via `WEB_UI_BASE_URL` environment variable:

```typescript
const webUiUrl = `${env.WEB_UI_BASE_URL}/session/${sessionId}/`;
```

### Prompting OpenCode for Output

To ensure useful `output` in results, consider system prompting OpenCode to:
- Summarize what was accomplished
- List files created, modified, deleted
- Mention commits made and branches used
- Note any issues or warnings

This keeps the output informative without requiring structured parsing.
