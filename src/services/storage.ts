// src/services/storage.ts
import { Context, Effect, Layer, Option, ParseResult, Schema } from "effect";

import { StorageReadError, StorageWriteError } from "../models/errors";
import { RunRecord } from "../models/run";

/**
 * SQL storage type - use SqlStorage from workers types at runtime,
 * but define a minimal interface for testing
 */
export type SqlStorageInterface = SqlStorage;

/**
 * Options for listing runs across sessions
 */
interface ListAllRunsOptions {
  readonly sessionId?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly before?: number;
}

/**
 * Storage service interface for run records.
 *
 * Note: Session metadata is stored in R2 via SessionService, not here.
 * This service only handles run records which are tied to workflow execution
 * and can safely be stored per-DO since runs are transient.
 */
interface StorageServiceInterface {
  readonly getRun: (runId: string) => Effect.Effect<Option.Option<RunRecord>, StorageReadError>;

  readonly putRun: (run: RunRecord) => Effect.Effect<void, StorageWriteError>;

  readonly listRuns: (
    sessionId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<RunRecord>, StorageReadError>;

  /**
   * List runs across all sessions with optional filtering and pagination
   */
  readonly listAllRuns: (
    options?: ListAllRunsOptions,
  ) => Effect.Effect<ReadonlyArray<RunRecord>, StorageReadError>;

  readonly initSchema: () => Effect.Effect<void, StorageWriteError>;
}

/**
 * Helper to format parse errors for storage error messages
 */
const formatParseError = (error: ParseResult.ParseError): string => {
  return ParseResult.TreeFormatter.formatErrorSync(error);
};

/**
 * Create storage service from SQL executor
 */
export const makeStorageService = (sql: SqlStorageInterface): StorageServiceInterface => ({
  getRun: (runId) =>
    Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () =>
          sql
            .exec<{
              key: string;
              data: string;
            }>("SELECT key, data FROM runs WHERE key = ?", runId)
            .toArray(),
        catch: (error) =>
          new StorageReadError({
            key: `run:${runId}`,
            cause: String(error),
          }),
      });

      if (result.length === 0) {
        return Option.none();
      }

      const jsonData = yield* Effect.try({
        try: () => JSON.parse(result[0].data) as unknown,
        catch: (error) =>
          new StorageReadError({
            key: `run:${runId}`,
            cause: `Invalid JSON: ${error}`,
          }),
      });

      const parsed = yield* Schema.decodeUnknown(RunRecord)(jsonData).pipe(
        Effect.mapError(
          (parseError) =>
            new StorageReadError({
              key: `run:${runId}`,
              cause: `Schema validation failed: ${formatParseError(parseError)}`,
            }),
        ),
      );

      return Option.some(parsed);
    }),

  putRun: (run) =>
    Effect.try({
      try: () => {
        const data = JSON.stringify(run);
        sql.exec(
          "INSERT OR REPLACE INTO runs (key, session_id, data, updated_at) VALUES (?, ?, ?, ?)",
          run.runId,
          run.sessionId,
          data,
          Date.now(),
        );
      },
      catch: (error) =>
        new StorageWriteError({
          key: `run:${run.runId}`,
          cause: String(error),
        }),
    }),

  listRuns: (sessionId, limit = 10) =>
    Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () =>
          sql
            .exec<{
              data: string;
            }>(
              "SELECT data FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?",
              sessionId,
              limit,
            )
            .toArray(),
        catch: (error) =>
          new StorageReadError({
            key: `runs:${sessionId}`,
            cause: String(error),
          }),
      });

      const runs: RunRecord[] = [];
      for (const row of result) {
        const jsonData = yield* Effect.try({
          try: () => JSON.parse(row.data) as unknown,
          catch: (error) =>
            new StorageReadError({
              key: `runs:${sessionId}`,
              cause: `Invalid JSON in run record: ${error}`,
            }),
        });

        const parsed = yield* Schema.decodeUnknown(RunRecord)(jsonData).pipe(
          Effect.mapError(
            (parseError) =>
              new StorageReadError({
                key: `runs:${sessionId}`,
                cause: `Schema validation failed: ${formatParseError(parseError)}`,
              }),
          ),
        );

        runs.push(parsed);
      }

      return runs;
    }),

  listAllRuns: (options = {}) =>
    Effect.gen(function* () {
      const { sessionId, status, limit = 10, before } = options;

      // Build dynamic query with optional filters
      let query = "SELECT data FROM runs WHERE 1=1";
      const params: (string | number)[] = [];

      if (sessionId !== undefined) {
        query += " AND session_id = ?";
        params.push(sessionId);
      }

      if (before !== undefined) {
        query += " AND updated_at < ?";
        params.push(before);
      }

      query += " ORDER BY updated_at DESC LIMIT ?";
      // Fetch extra if filtering by status (we'll filter in JS)
      params.push(status !== undefined ? limit * 3 : limit);

      const result = yield* Effect.try({
        try: () => sql.exec<{ data: string }>(query, ...params).toArray(),
        catch: (error) =>
          new StorageReadError({
            key: "runs:all",
            cause: String(error),
          }),
      });

      const runs: RunRecord[] = [];
      for (const row of result) {
        const jsonData = yield* Effect.try({
          try: () => JSON.parse(row.data) as unknown,
          catch: (error) =>
            new StorageReadError({
              key: "runs:all",
              cause: `Invalid JSON in run record: ${error}`,
            }),
        });

        const parsed = yield* Schema.decodeUnknown(RunRecord)(jsonData).pipe(
          Effect.mapError(
            (parseError) =>
              new StorageReadError({
                key: "runs:all",
                cause: `Schema validation failed: ${formatParseError(parseError)}`,
              }),
          ),
        );

        // Apply status filter if specified
        if (status !== undefined && parsed.status !== status) {
          continue;
        }

        runs.push(parsed);

        if (runs.length >= limit) {
          break;
        }
      }

      return runs;
    }),

  initSchema: () =>
    Effect.try({
      try: () => {
        // Only create runs table - sessions are now stored in R2
        sql.exec(`
          CREATE TABLE IF NOT EXISTS runs (
            key TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
        sql.exec(`
          CREATE INDEX IF NOT EXISTS idx_runs_session
          ON runs(session_id, updated_at DESC)
        `);
        sql.exec(`
          CREATE INDEX IF NOT EXISTS idx_runs_updated
          ON runs(updated_at DESC)
        `);
      },
      catch: (error) =>
        new StorageWriteError({
          key: "schema",
          cause: String(error),
        }),
    }),
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
export const makeStorageLayer = (sql: SqlStorageInterface): Layer.Layer<StorageService> =>
  Layer.succeed(StorageService, makeStorageService(sql));
