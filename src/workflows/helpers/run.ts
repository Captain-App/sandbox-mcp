// src/workflows/helpers/run.ts

import { Schema } from "effect";

import { RunStorageReadError } from "../../models/errors";
import { RunRecord as RunRecordSchema, type RunRecord, type RunResult } from "../../models/run";
import type { SessionMetadata } from "../../models/session";

/**
 * Run workflow helpers - standalone async functions for use in workflow steps.
 *
 * These functions write run records directly to R2, following the same
 * storage layout as the RunStorage service. They use Effect Schema for
 * validation but avoid Effect's runtime/generator patterns for simplicity.
 *
 * IMPORTANT: The storage layout and index structure here MUST stay in sync
 * with src/services/run.ts. Both files define the same key patterns and
 * index schema because workflow helpers need to be plain async functions.
 *
 * Storage layout:
 * - sessions/{sessionId}/runs/_index.json  <- Index of runs for this session
 * - sessions/{sessionId}/runs/{runId}.json <- Full run record
 */

// =============================================================================
// Index Types (must match RunStorage service in src/services/run.ts)
// =============================================================================

interface RunIndexEntry {
  runId: string;
  status: string;
  title: string;
  startedAt: number;
  completedAt?: number;
}

interface RunIndex {
  version: 1;
  runs: Record<string, RunIndexEntry>;
  updatedAt: number;
}

// =============================================================================
// Session Index Types (must match SessionStorage service in src/services/session.ts)
// =============================================================================

interface SessionIndexEntry {
  sessionId: string;
  status: string;
  createdAt: number;
  lastActivity: number;
  title?: string;
}

interface SessionIndex {
  version: 1;
  sessions: Record<string, SessionIndexEntry>;
  updatedAt: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

const SESSION_INDEX_KEY = "sessions/_index.json";

function getRunIndexKey(sessionId: string): string {
  return `sessions/${sessionId}/runs/_index.json`;
}

function getRunKey(sessionId: string, runId: string): string {
  return `sessions/${sessionId}/runs/${runId}.json`;
}

// Keep backward-compatible alias for existing callers
function getIndexKey(sessionId: string): string {
  return getRunIndexKey(sessionId);
}

/**
 * Read the run index from R2.
 * Returns the index and its etag for optimistic locking.
 * Returns an empty index if it doesn't exist.
 */
async function readIndex(
  bucket: R2Bucket,
  sessionId: string,
): Promise<{ index: RunIndex; etag?: string }> {
  const key = getIndexKey(sessionId);
  const object = await bucket.get(key);

  if (!object) {
    return {
      index: {
        version: 1,
        runs: {},
        updatedAt: Date.now(),
      },
      etag: undefined,
    };
  }

  return {
    index: await object.json<RunIndex>(),
    etag: object.etag,
  };
}

/**
 * Write the run index to R2 with optimistic locking.
 * Returns true if write succeeded, false if there was a concurrent modification.
 */
async function writeIndex(
  bucket: R2Bucket,
  sessionId: string,
  index: RunIndex,
  expectedEtag?: string,
): Promise<boolean> {
  const key = getIndexKey(sessionId);
  const options: R2PutOptions = {
    httpMetadata: { contentType: "application/json" },
  };

  // Use conditional write if we have an etag (optimistic locking)
  if (expectedEtag) {
    options.onlyIf = { etagMatches: expectedEtag };
  }

  const result = await bucket.put(key, JSON.stringify(index), options);

  // If conditional write fails, result is null
  return result !== null || !expectedEtag;
}

/**
 * Update index with retry on concurrent modification.
 * Uses exponential backoff for retries.
 */
async function updateIndexWithRetry(
  bucket: R2Bucket,
  sessionId: string,
  updateFn: (index: RunIndex) => RunIndex,
  maxRetries = 3,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { index, etag } = await readIndex(bucket, sessionId);
    const updatedIndex = updateFn(index);

    const success = await writeIndex(bucket, sessionId, updatedIndex, etag);
    if (success) {
      return;
    }

    // Exponential backoff: 10ms, 20ms, 40ms, ...
    const delay = 10 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastError = new Error(
      `Concurrent modification detected on attempt ${attempt + 1}/${maxRetries + 1}`,
    );
  }

  throw lastError ?? new Error("Failed to update index after retries");
}

/**
 * Create an index entry from a run record.
 */
function toRunIndexEntry(run: RunRecord): RunIndexEntry {
  return {
    runId: run.runId,
    status: run.status,
    title: run.title,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

// Keep backward-compatible alias
function toIndexEntry(run: RunRecord): RunIndexEntry {
  return toRunIndexEntry(run);
}

/**
 * Read the session index from R2.
 * Returns the index and its etag for optimistic locking.
 * Returns an empty index if it doesn't exist.
 */
async function readSessionIndex(bucket: R2Bucket): Promise<{ index: SessionIndex; etag?: string }> {
  const object = await bucket.get(SESSION_INDEX_KEY);

  if (!object) {
    return {
      index: {
        version: 1,
        sessions: {},
        updatedAt: Date.now(),
      },
      etag: undefined,
    };
  }

  return {
    index: await object.json<SessionIndex>(),
    etag: object.etag,
  };
}

/**
 * Write the session index to R2 with optimistic locking.
 * Returns true if write succeeded, false if there was a concurrent modification.
 */
async function writeSessionIndex(
  bucket: R2Bucket,
  index: SessionIndex,
  expectedEtag?: string,
): Promise<boolean> {
  const options: R2PutOptions = {
    httpMetadata: { contentType: "application/json" },
  };

  // Use conditional write if we have an etag (optimistic locking)
  if (expectedEtag) {
    options.onlyIf = { etagMatches: expectedEtag };
  }

  const result = await bucket.put(SESSION_INDEX_KEY, JSON.stringify(index), options);

  // If conditional write fails, result is null
  return result !== null || !expectedEtag;
}

/**
 * Update session index with retry on concurrent modification.
 * Uses exponential backoff for retries.
 */
async function updateSessionIndexWithRetry(
  bucket: R2Bucket,
  updateFn: (index: SessionIndex) => SessionIndex,
  maxRetries = 3,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { index, etag } = await readSessionIndex(bucket);
    const updatedIndex = updateFn(index);

    const success = await writeSessionIndex(bucket, updatedIndex, etag);
    if (success) {
      return;
    }

    // Exponential backoff: 10ms, 20ms, 40ms, ...
    const delay = 10 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastError = new Error(
      `Concurrent modification detected on attempt ${attempt + 1}/${maxRetries + 1}`,
    );
  }

  throw lastError ?? new Error("Failed to update session index after retries");
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a new run record in R2.
 *
 * Called from the workflow's "create-run" step after proxy configuration.
 * Uses optimistic locking with retry for index updates.
 */
export async function createRun(bucket: R2Bucket, run: RunRecord): Promise<void> {
  // Validate run record before writing (defense-in-depth)
  // This matches the validation in RunStorage service
  Schema.decodeUnknownSync(RunRecordSchema)(run);

  // Write the full run record
  const runKey = getRunKey(run.sessionId, run.runId);
  await bucket.put(runKey, JSON.stringify(run), {
    httpMetadata: { contentType: "application/json" },
  });

  // Update the index with retry on concurrent modification
  await updateIndexWithRetry(bucket, run.sessionId, (index) => ({
    ...index,
    runs: {
      ...index.runs,
      [run.runId]: toIndexEntry(run),
    },
    updatedAt: Date.now(),
  }));
}

/**
 * Update a run with completion result.
 *
 * Called from the workflow's "complete-run" step after task execution.
 * Uses optimistic locking with retry for index updates.
 */
export async function completeRun(
  bucket: R2Bucket,
  sessionId: string,
  runId: string,
  result: {
    success: boolean;
    output?: string;
    error?: string;
    title?: string;
  },
): Promise<void> {
  // Read existing run
  const runKey = getRunKey(sessionId, runId);
  const object = await bucket.get(runKey);

  if (!object) {
    throw new RunStorageReadError({
      sessionId,
      runId,
      cause: "Run not found",
    });
  }

  const run = await object.json<RunRecord>();

  // Update run with result
  const completedAt = Date.now();
  const runResult: RunResult = {
    success: result.success,
    output: result.output ?? "",
    error: result.error,
  };

  const updatedRun: RunRecord = {
    ...run,
    status: result.success ? "completed" : "failed",
    completedAt,
    title: result.title ?? run.title,
    result: runResult,
  };

  // Write updated run
  await bucket.put(runKey, JSON.stringify(updatedRun), {
    httpMetadata: { contentType: "application/json" },
  });

  // Update the index with retry on concurrent modification
  await updateIndexWithRetry(bucket, sessionId, (index) => ({
    ...index,
    runs: {
      ...index.runs,
      [runId]: toIndexEntry(updatedRun),
    },
    updatedAt: Date.now(),
  }));
}

/**
 * Update session metadata after run completion.
 *
 * Called from the workflow's "complete-run" step to persist
 * opencodeSessionId and workspacePath back to the session.
 * Also updates the session index so lastActivity is reflected in listings.
 */
export async function updateSessionAfterRun(
  bucket: R2Bucket,
  sessionId: string,
  updates: {
    opencodeSessionId?: string;
    workspacePath?: string;
  },
): Promise<void> {
  // Read existing session
  const sessionKey = `sessions/${sessionId}/metadata.json`;
  const object = await bucket.get(sessionKey);

  if (!object) {
    // Session not found - this shouldn't happen in normal flow
    // but we don't want to fail the workflow for this
    console.warn(`Session ${sessionId} not found when updating after run`);
    return;
  }

  const session = await object.json<SessionMetadata>();
  const now = Date.now();

  // Update session with new values
  const updatedSession: SessionMetadata = {
    ...session,
    opencodeSessionId: updates.opencodeSessionId ?? session.opencodeSessionId,
    workspacePath: updates.workspacePath ?? session.workspacePath,
    lastActivity: now,
  };

  // Write updated session
  await bucket.put(sessionKey, JSON.stringify(updatedSession), {
    httpMetadata: { contentType: "application/json" },
  });

  // Update the session index so lastActivity is reflected in listings
  // This ensures sessions are sorted correctly by recent activity
  await updateSessionIndexWithRetry(bucket, (index) => {
    const existingEntry = index.sessions[sessionId];
    if (!existingEntry) {
      // Session not in index - this shouldn't happen but handle gracefully
      console.warn(`Session ${sessionId} not found in index when updating after run`);
      return index;
    }

    return {
      ...index,
      sessions: {
        ...index.sessions,
        [sessionId]: {
          ...existingEntry,
          lastActivity: now,
        },
      },
      updatedAt: now,
    };
  });
}
