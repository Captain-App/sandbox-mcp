import { describe, expect, it } from 'vitest';
import { Effect, Option } from 'effect';
import { makeStorageService } from './storage';
import type { SessionMetadata, SessionId } from '../models/session';

// Mock SQL storage for testing - matches SqlStorage interface
const createMockSql = () => {
	const store = new Map<string, string>();

	const createCursor = <T>(results: T[]) => {
		let index = 0;
		return {
			next: () => {
				if (index < results.length) {
					return { done: false as const, value: results[index++] };
				}
				return { done: true as const };
			},
			toArray: () => results,
			one: () => results[0] ?? null,
			[Symbol.iterator]: function* () {
				yield* results;
			},
			raw: () => ({
				toArray: () => [],
				one: () => null,
				[Symbol.iterator]: function* () {},
				columnNames: [] as string[],
				next: () => ({ done: true as const }),
			}),
			columnNames: [] as string[],
			rowsRead: results.length,
			rowsWritten: 0,
		};
	};

	return {
		exec: <T>(query: string, ...bindings: unknown[]) => {
			const results: T[] = [];

			if (query.includes('CREATE') || query.includes('INDEX')) {
				// Schema creation - no-op for tests
			} else if (query.includes('INSERT') || query.includes('REPLACE')) {
				const key = bindings[0] as string;
				const data = bindings[1] as string;
				store.set(key, data);
			} else if (query.includes('SELECT') && query.includes('sessions')) {
				const key = bindings[0] as string;
				const data = store.get(key);
				if (data) {
					results.push({ key, data } as unknown as T);
				}
			} else if (query.includes('SELECT') && query.includes('runs')) {
				const sessionIdOrRunId = bindings[0] as string;
				// Check if this is a run lookup by ID (getRun)
				if (sessionIdOrRunId.startsWith('run-')) {
					const data = store.get(sessionIdOrRunId);
					if (data) {
						results.push({ key: sessionIdOrRunId, data } as unknown as T);
					}
				} else {
					// This is listRuns by sessionId
					for (const [k, v] of store.entries()) {
						if (k.startsWith('run-')) {
							const parsed = JSON.parse(v);
							if (parsed.sessionId === sessionIdOrRunId) {
								results.push({ data: v } as unknown as T);
							}
						}
					}
				}
			} else if (query.includes('DELETE')) {
				const key = bindings[0] as string;
				store.delete(key);
			}

			return createCursor(results);
		},
		get databaseSize() {
			return 0;
		},
		Cursor: class {},
		Statement: class {},
		store,
	};
};

describe('StorageService', () => {
	it('should store and retrieve session metadata', async () => {
		const mockSql = createMockSql();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const service = makeStorageService(mockSql as any);

		const session: SessionMetadata = {
			// Cast to branded type for tests - in production, values come from validated input
			sessionId: 'test-session' as SessionId,
			sandboxId: 'test-session',
			createdAt: Date.now(),
			lastActivity: Date.now(),
			status: 'active',
			workspacePath: '/workspace',
			webUiUrl: 'https://test.example.com',
			config: { defaultModel: 'claude-sonnet-4-20250514' },
		};

		const program = Effect.gen(function* () {
			yield* service.putSession(session);
			const retrieved = yield* service.getSession('test-session');
			return retrieved;
		});

		const result = await Effect.runPromise(program);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value.sessionId).toBe('test-session');
		}
	});

	it('should return None for non-existent session', async () => {
		const mockSql = createMockSql();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const service = makeStorageService(mockSql as any);

		const program = service.getSession('non-existent');
		const result = await Effect.runPromise(program);

		expect(Option.isNone(result)).toBe(true);
	});

	it('should initialize schema without error', async () => {
		const mockSql = createMockSql();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const service = makeStorageService(mockSql as any);

		const program = service.initSchema();
		await expect(Effect.runPromise(program)).resolves.not.toThrow();
	});

	it('should delete session', async () => {
		const mockSql = createMockSql();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const service = makeStorageService(mockSql as any);

		const session: SessionMetadata = {
			// Cast to branded type for tests - in production, values come from validated input
			sessionId: 'to-delete' as SessionId,
			sandboxId: 'to-delete',
			createdAt: Date.now(),
			lastActivity: Date.now(),
			status: 'active',
			workspacePath: '/workspace',
			webUiUrl: 'https://test.example.com',
			config: { defaultModel: 'claude-sonnet-4-20250514' },
		};

		const program = Effect.gen(function* () {
			yield* service.putSession(session);
			yield* service.deleteSession('to-delete');
			return yield* service.getSession('to-delete');
		});

		const result = await Effect.runPromise(program);
		expect(Option.isNone(result)).toBe(true);
	});
});
