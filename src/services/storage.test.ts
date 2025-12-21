import { describe, it, expect } from "vitest";
import { Effect, Option } from "effect";
import { makeStorageService } from "./storage";
import type { SessionMetadata } from "../models/session";

// Mock SQL executor for testing
const createMockSql = () => {
	const store = new Map<string, string>();
	return {
		exec: (strings: TemplateStringsArray, ...values: unknown[]) => {
			// Simple mock that handles basic INSERT/SELECT/CREATE
			const query = strings.join("?");

			if (query.includes("CREATE")) {
				return { results: [], changes: 0 };
			}

			if (query.includes("INSERT") || query.includes("REPLACE")) {
				const key = values[0] as string;
				const data = values[1] as string;
				store.set(key, data);
				return { results: [], changes: 1 };
			}

			if (query.includes("SELECT") && query.includes("sessions")) {
				const key = values[0] as string;
				const data = store.get(key);
				return {
					results: data ? [{ key, data }] : [],
					changes: 0,
				};
			}

			if (query.includes("SELECT") && query.includes("runs")) {
				const key = values[0] as string;
				const data = store.get(key);
				return {
					results: data ? [{ key, data }] : [],
					changes: 0,
				};
			}

			if (query.includes("DELETE")) {
				const key = values[0] as string;
				store.delete(key);
				return { results: [], changes: 1 };
			}

			return { results: [], changes: 0 };
		},
		store, // expose for assertions
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
			config: { defaultModel: "claude-sonnet-4-20250514" },
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

	it("should initialize schema without error", async () => {
		const mockSql = createMockSql();
		const service = makeStorageService(mockSql.exec as any);

		const program = service.initSchema();
		await expect(Effect.runPromise(program)).resolves.not.toThrow();
	});

	it("should delete session", async () => {
		const mockSql = createMockSql();
		const service = makeStorageService(mockSql.exec as any);

		const session: SessionMetadata = {
			sessionId: "to-delete",
			sandboxId: "to-delete",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			status: "active",
			workspacePath: "/workspace",
			webUiUrl: "https://test.example.com",
			config: { defaultModel: "claude-sonnet-4-20250514" },
		};

		const program = Effect.gen(function* () {
			yield* service.putSession(session);
			yield* service.deleteSession("to-delete");
			return yield* service.getSession("to-delete");
		});

		const result = await Effect.runPromise(program);
		expect(Option.isNone(result)).toBe(true);
	});
});
