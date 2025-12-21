import { Context, Effect, Layer, Option, Schema } from "effect";
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
		sessionId: string,
	) => Effect.Effect<Option.Option<SessionMetadata>, StorageReadError>;

	readonly putSession: (session: SessionMetadata) => Effect.Effect<void, StorageWriteError>;

	readonly deleteSession: (sessionId: string) => Effect.Effect<void, StorageWriteError>;

	readonly getRun: (runId: string) => Effect.Effect<Option.Option<RunRecord>, StorageReadError>;

	readonly putRun: (run: RunRecord) => Effect.Effect<void, StorageWriteError>;

	readonly listRuns: (
		sessionId: string,
		limit?: number,
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
					JSON.parse(result.results[0].data),
				);
				return Option.some(parsed);
			},
			catch: (error) =>
				new StorageReadError({
					key: `session:${sessionId}`,
					cause: String(error),
				}),
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
			catch: (error) =>
				new StorageWriteError({
					key: `session:${session.sessionId}`,
					cause: String(error),
				}),
		}),

	deleteSession: (sessionId) =>
		Effect.try({
			try: () => {
				sql`DELETE FROM sessions WHERE key = ${sessionId}`;
			},
			catch: (error) =>
				new StorageWriteError({
					key: `session:${sessionId}`,
					cause: String(error),
				}),
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
				const parsed = Schema.decodeUnknownSync(RunRecord)(JSON.parse(result.results[0].data));
				return Option.some(parsed);
			},
			catch: (error) =>
				new StorageReadError({
					key: `run:${runId}`,
					cause: String(error),
				}),
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
			catch: (error) =>
				new StorageWriteError({
					key: `run:${run.runId}`,
					cause: String(error),
				}),
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
				return result.results.map((row) =>
					Schema.decodeUnknownSync(RunRecord)(JSON.parse(row.data)),
				);
			},
			catch: (error) =>
				new StorageReadError({
					key: `runs:${sessionId}`,
					cause: String(error),
				}),
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
export const makeStorageLayer = (sql: SqlExecutor): Layer.Layer<StorageService> =>
	Layer.succeed(StorageService, makeStorageService(sql));
