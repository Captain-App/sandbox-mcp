// src/services/run.ts
import { Context, Effect, Layer, Option, ParseResult, Schedule, Schema } from "effect";

import { RunStorageReadError, RunStorageWriteError } from "../models/errors";
import { RunRecord } from "../models/run";

/**
 * Run storage service that uses R2 as the storage backend.
 *
 * Storage layout:
 * - sessions/{sessionId}/runs/_index.json  <- Index of runs for this session
 * - sessions/{sessionId}/runs/{runId}.json <- Full run record
 *
 * This provides a single source of truth for run records that can be
 * accessed from any worker or DO instance, solving the cross-DO access problem
 * inherent in the MCP library's per-connection DO model.
 */

// =============================================================================
// Index Schema
// =============================================================================

/**
 * Lightweight run entry for the index
 */
const RunIndexEntry = Schema.Struct({
  runId: Schema.String,
  status: Schema.String,
  title: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.optionalWith(Schema.Number, { exact: true }),
});
type RunIndexEntry = typeof RunIndexEntry.Type;

/**
 * The run index stored at sessions/{sessionId}/runs/_index.json
 */
const RunIndex = Schema.Struct({
  version: Schema.Literal(1),
  runs: Schema.Record({ key: Schema.String, value: RunIndexEntry }),
  updatedAt: Schema.Number,
});
type RunIndex = typeof RunIndex.Type;

// =============================================================================
// Constants
// =============================================================================

function getIndexKey(sessionId: string): string {
  return `sessions/${sessionId}/runs/_index.json`;
}

function getRunKey(sessionId: string, runId: string): string {
  return `sessions/${sessionId}/runs/${runId}.json`;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Result of listing runs
 */
interface ListRunsResult {
  /** Run entries from the index */
  runs: RunIndexEntry[];
  /** Total count of runs for this session */
  total: number;
}

/**
 * Run storage service interface
 */
interface RunStorageService {
  /**
   * Get a run by ID
   * Returns Option.none() if not found
   */
  readonly getRun: (
    sessionId: string,
    runId: string,
  ) => Effect.Effect<Option.Option<RunRecord>, RunStorageReadError>;

  /**
   * Save a run (creates or updates)
   * Also updates the run index
   */
  readonly putRun: (
    run: RunRecord,
  ) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

  /**
   * List all runs for a session from the index
   * This is O(1) - reads a single index object
   */
  readonly listRuns: (
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ) => Effect.Effect<ListRunsResult, RunStorageReadError>;

  /**
   * Delete a run by ID
   * Also removes from the run index
   */
  readonly deleteRun: (
    sessionId: string,
    runId: string,
  ) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;

  /**
   * Delete all runs for a session
   * Used for cascade delete when deleting a session
   */
  readonly deleteAllRuns: (
    sessionId: string,
  ) => Effect.Effect<void, RunStorageWriteError | RunStorageReadError>;
}

// =============================================================================
// Service Tag
// =============================================================================

/**
 * Effect Context tag for RunStorageService
 */
export class RunStorage extends Context.Tag("RunStorage")<RunStorage, RunStorageService>() {}

// =============================================================================
// Implementation Helpers
// =============================================================================

/**
 * Format parse errors for human-readable messages
 */
function formatParseError(error: ParseResult.ParseError): string {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * Read the run index from R2
 * Returns an empty index if it doesn't exist
 */
function readIndex(
  bucket: R2Bucket,
  sessionId: string,
): Effect.Effect<{ index: RunIndex; etag?: string }, RunStorageReadError> {
  return Effect.gen(function* () {
    const key = getIndexKey(sessionId);
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(key),
      catch: (error) =>
        new RunStorageReadError({
          sessionId,
          cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    if (!object) {
      // Return empty index
      return {
        index: {
          version: 1 as const,
          runs: {},
          updatedAt: Date.now(),
        },
        etag: undefined,
      };
    }

    const json = yield* Effect.tryPromise({
      try: () => object.json<unknown>(),
      catch: (error) =>
        new RunStorageReadError({
          sessionId,
          cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    const index = yield* Schema.decodeUnknown(RunIndex)(json).pipe(
      Effect.mapError(
        (parseError) =>
          new RunStorageReadError({
            sessionId,
            cause: `Schema validation failed: ${formatParseError(parseError)}`,
          }),
      ),
    );

    return { index, etag: object.etag };
  });
}

/**
 * Write the run index to R2
 * Uses conditional write with etag for optimistic concurrency
 */
function writeIndex(
  bucket: R2Bucket,
  sessionId: string,
  index: RunIndex,
  expectedEtag?: string,
): Effect.Effect<void, RunStorageWriteError> {
  return Effect.tryPromise({
    try: async () => {
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
      if (result === null && expectedEtag) {
        throw new Error("Concurrent modification detected - index was modified by another request");
      }
    },
    catch: (error) =>
      new RunStorageWriteError({
        sessionId,
        cause: error instanceof Error ? error.message : String(error),
      }),
  });
}

/**
 * Create an index entry from full run record
 */
function toIndexEntry(run: RunRecord): RunIndexEntry {
  return {
    runId: run.runId,
    status: run.status,
    title: run.title,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * Create the RunStorageService implementation
 */
function makeRunStorageService(bucket: R2Bucket): RunStorageService {
  return {
    getRun: (sessionId, runId) =>
      Effect.gen(function* () {
        const key = getRunKey(sessionId, runId);

        const object = yield* Effect.tryPromise({
          try: () => bucket.get(key),
          catch: (error) =>
            new RunStorageReadError({
              sessionId,
              runId,
              cause: `R2 get failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        if (!object) {
          return Option.none<RunRecord>();
        }

        const json = yield* Effect.tryPromise({
          try: () => object.json<unknown>(),
          catch: (error) =>
            new RunStorageReadError({
              sessionId,
              runId,
              cause: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const parsed = yield* Schema.decodeUnknown(RunRecord)(json).pipe(
          Effect.mapError(
            (parseError) =>
              new RunStorageReadError({
                sessionId,
                runId,
                cause: `Schema validation failed: ${formatParseError(parseError)}`,
              }),
          ),
        );

        return Option.some(parsed);
      }),

    putRun: (run) =>
      Effect.gen(function* () {
        const sessionId = run.sessionId;
        const runId = run.runId;

        // Validate run before writing (defense-in-depth)
        yield* Schema.encode(RunRecord)(run).pipe(
          Effect.mapError(
            (parseError) =>
              new RunStorageWriteError({
                sessionId,
                runId,
                cause: `Schema validation failed: ${formatParseError(parseError)}`,
              }),
          ),
        );

        // Write the full run record
        const key = getRunKey(sessionId, runId);
        yield* Effect.tryPromise({
          try: () =>
            bucket.put(key, JSON.stringify(run), {
              httpMetadata: { contentType: "application/json" },
            }),
          catch: (error) =>
            new RunStorageWriteError({
              sessionId,
              runId,
              cause: error instanceof Error ? error.message : String(error),
            }),
        });

        // Update the index with retry on concurrent modification
        yield* Effect.retry(
          Effect.gen(function* () {
            const { index, etag } = yield* readIndex(bucket, sessionId);

            // Update the run entry
            const updatedIndex: RunIndex = {
              ...index,
              runs: {
                ...index.runs,
                [runId]: toIndexEntry(run),
              },
              updatedAt: Date.now(),
            };

            yield* writeIndex(bucket, sessionId, updatedIndex, etag);
          }),
          // Retry up to 3 times with exponential backoff
          Schedule.intersect(Schedule.recurs(3), Schedule.exponential("10 millis", 2)),
        );
      }),

    listRuns: (sessionId, options) =>
      Effect.gen(function* () {
        const { index } = yield* readIndex(bucket, sessionId);

        // Convert to array and sort by startedAt (most recent first)
        const allRuns = Object.values(index.runs).sort((a, b) => b.startedAt - a.startedAt);

        // Apply pagination
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 100;
        const runs = allRuns.slice(offset, offset + limit);

        return {
          runs,
          total: allRuns.length,
        };
      }),

    deleteRun: (sessionId, runId) =>
      Effect.gen(function* () {
        // Delete the run record
        const key = getRunKey(sessionId, runId);
        yield* Effect.tryPromise({
          try: () => bucket.delete(key),
          catch: (error) =>
            new RunStorageWriteError({
              sessionId,
              runId,
              cause: error instanceof Error ? error.message : String(error),
            }),
        });

        // Update the index with retry on concurrent modification
        yield* Effect.retry(
          Effect.gen(function* () {
            const { index, etag } = yield* readIndex(bucket, sessionId);

            // Remove the run entry
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [runId]: _, ...remainingRuns } = index.runs;

            const updatedIndex: RunIndex = {
              ...index,
              runs: remainingRuns,
              updatedAt: Date.now(),
            };

            yield* writeIndex(bucket, sessionId, updatedIndex, etag);
          }),
          // Retry up to 3 times with exponential backoff
          Schedule.intersect(Schedule.recurs(3), Schedule.exponential("10 millis", 2)),
        );
      }),

    deleteAllRuns: (sessionId) =>
      Effect.gen(function* () {
        // Read index to get all run IDs
        const { index } = yield* readIndex(bucket, sessionId);
        const runIds = Object.keys(index.runs);

        // Delete index first - this makes the runs "invisible" even if
        // subsequent deletes fail. Orphaned run files are less problematic
        // than orphaned index entries pointing to missing runs.
        const indexKey = getIndexKey(sessionId);
        yield* Effect.tryPromise({
          try: () => bucket.delete(indexKey),
          catch: (error) =>
            new RunStorageWriteError({
              sessionId,
              cause: error instanceof Error ? error.message : String(error),
            }),
        });

        // Delete all run files (best effort after index is gone)
        for (const runId of runIds) {
          const key = getRunKey(sessionId, runId);
          yield* Effect.tryPromise({
            try: () => bucket.delete(key),
            catch: (error) =>
              new RunStorageWriteError({
                sessionId,
                runId,
                cause: error instanceof Error ? error.message : String(error),
              }),
          });
        }
      }),
  };
}

// =============================================================================
// Layer
// =============================================================================

/**
 * Create a Layer for RunStorageService from an R2 bucket
 */
export function makeRunStorageLayer(bucket: R2Bucket): Layer.Layer<RunStorage> {
  return Layer.succeed(RunStorage, makeRunStorageService(bucket));
}
