# Flat R2 Storage Refactor

**Date:** 2024-12-22
**Status:** Planned

## Problem Statement

The current R2 storage layout uses per-session run indexes, which makes cross-session queries impossible without O(N) reads. This creates a poor UX for AI clients that want to:

- List all recent runs across sessions
- Find failed runs to retry
- Discover past work without knowing sessionIds
- Resume work from a fresh conversation

### Current Layout (Problematic)

```
sessions/_index.json                       # Global session index
sessions/{sessionId}/metadata.json         # Session data (nested)
sessions/{sessionId}/runs/_index.json      # Per-session run index (PROBLEM)
sessions/{sessionId}/runs/{runId}.json     # Run data (nested under session)
```

**Issues:**
1. `listRuns` requires sessionId - can't list across sessions
2. `getResult` requires sessionId - can't lookup run by ID alone
3. Runs are tightly coupled to sessions in storage structure
4. Code duplication between Effect services and workflow helpers

## Target State

```
sessions/_index.json           # Global session index
sessions/{sessionId}.json      # Session data (flat, no subdirectory)
runs/_index.json               # Global runs index (NEW)
runs/{runId}.json              # Run data (flat, independent of session)
```

**Benefits:**
- `getRun(runId)` - direct lookup without sessionId
- `listRuns({ sessionId?, status?, limit?, before? })` - all filters work
- Cross-session queries are O(1) - just read the global runs index
- Simpler mental model
- Single source of truth for key patterns

## Design

### Storage Keys

Create `src/storage/keys.ts` as single source of truth:

```typescript
export const StorageKeys = {
  sessionIndex: () => "sessions/_index.json",
  session: (sessionId: string) => `sessions/${sessionId}.json`,
  runIndex: () => "runs/_index.json",
  run: (runId: string) => `runs/${runId}.json`,
} as const;
```

### Global Run Index Entry

Add `sessionId` to enable optional filtering:

```typescript
const RunIndexEntry = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,      // Enables session filtering
  status: Schema.String,
  title: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.optionalWith(Schema.Number, { exact: true }),
});
```

### Run Storage API

```typescript
interface RunStorageService {
  // Get run by ID only (no sessionId needed)
  readonly getRun: (runId: string) => Effect.Effect<Option.Option<RunRecord>, RunStorageReadError>;

  // Save/update a run
  readonly putRun: (run: RunRecord) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

  // List runs with optional filters
  readonly listRuns: (options?: {
    sessionId?: string;
    status?: string;
    limit?: number;
    before?: number;  // startedAt cursor for pagination
  }) => Effect.Effect<ListRunsResult, RunStorageReadError>;

  // Delete a single run
  readonly deleteRun: (runId: string) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

  // Delete all runs for a session (for cascade delete)
  readonly deleteRunsForSession: (sessionId: string) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;
}
```

### MCP Tool Schemas

```typescript
// opencode_get_result - sessionId no longer required
export const getResultInputSchema = z.object({
  runId: z.string().describe("Run ID from opencode_run_task."),
});

// opencode_list_runs - sessionId optional, filters restored
export const listRunsInputSchema = z.object({
  sessionId: z.string().optional().describe("Filter by session."),
  status: z.enum(["started", "running", "completed", "failed"]).optional().describe("Filter by status."),
  limit: z.number().int().min(1).max(100).default(10).describe("Max runs to return."),
  before: z.number().optional().describe("Unix timestamp cursor. Returns runs started before this time."),
});
```

### Cascade Delete Strategy

When deleting a session:
1. Read the global runs index
2. Filter for runs with matching sessionId
3. Delete those run files
4. Update the global runs index (remove entries)
5. Delete the session file
6. Update the session index

## Implementation Phases

### Phase 1: Create StorageKeys

**Goal:** Single source of truth for R2 key patterns.

**Create:**
- `src/storage/keys.ts`

**No breaking changes - just foundation.**

### Phase 2: Refactor Session Storage

**Goal:** Flatten session path from `sessions/{id}/metadata.json` to `sessions/{id}.json`.

**Modify:**
- `src/services/session.ts` - Use StorageKeys, update path
- `src/services/session.test.ts` - Update assertions
- `src/index.ts` - Update direct R2 access for web UI redirect

### Phase 3: Refactor Run Storage

**Goal:** Global runs index with flat key structure.

**Modify:**
- `src/services/run.ts` - Complete rewrite
- `src/services/run.test.ts` - Complete rewrite
- `src/models/errors.ts` - Make sessionId optional in run errors
- `src/models/errors.test.ts` - Update tests

### Phase 4: Update Workflow Helpers

**Goal:** Align with new storage layout, eliminate duplication.

**Modify:**
- `src/workflows/helpers/run.ts` - Use StorageKeys, update all key patterns

### Phase 5: Update MCP Tools

**Goal:** Restore nice API with optional sessionId and filters.

**Modify:**
- `src/agent/tools.ts` - Update schemas
- `src/agent/tools.test.ts` - Update tests
- `src/agent/mcp-agent.ts` - Update tool handlers

### Phase 6: Update Documentation

**Modify:**
- `AGENTS.md` - Update storage layout docs
- `README.md` - Update API docs

## Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `src/storage/keys.ts` | 1 | **NEW** - Single source of truth for keys |
| `src/services/session.ts` | 2 | Use StorageKeys, flatten session path |
| `src/services/session.test.ts` | 2 | Update hardcoded paths |
| `src/index.ts` | 2 | Update direct R2 access for web UI |
| `src/services/run.ts` | 3 | Complete rewrite - global index, new API |
| `src/services/run.test.ts` | 3 | Complete rewrite for new API |
| `src/models/errors.ts` | 3 | Make sessionId optional in run errors |
| `src/models/errors.test.ts` | 3 | Update error tests |
| `src/workflows/helpers/run.ts` | 4 | Use StorageKeys, update patterns |
| `src/agent/tools.ts` | 5 | Update schemas |
| `src/agent/tools.test.ts` | 5 | Update tests |
| `src/agent/mcp-agent.ts` | 5 | Update tool handlers |
| `AGENTS.md` | 6 | Update docs |
| `README.md` | 6 | Update docs |

## Validation

Run after each phase:
```bash
npm run check  # typecheck, format, lint, knip, test
```

## Notes

- No backward compatibility needed - no users/data in production
- No migration script needed - clean slate
- Goal is cleanest possible implementation as if designing from scratch
