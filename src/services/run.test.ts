import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import { RunStorageReadError } from "../models/errors";
import type { RunRecord } from "../models/run";
import { DEFAULT_MODEL } from "../models/session";
import { makeRunStorageLayer, RunStorage } from "./run";

/**
 * Creates a mock R2 bucket for testing
 */
const createMockBucket = (options?: { failGet?: boolean; failPut?: boolean }) => {
  const store = new Map<string, string>();
  let etagCounter = 0;
  const etags = new Map<string, string>();

  return {
    get: async (key: string) => {
      if (options?.failGet) {
        throw new Error("Simulated R2 get failure");
      }
      const data = store.get(key);
      if (!data) return null;
      return {
        json: async <T>() => JSON.parse(data) as T,
        text: async () => data,
        etag: etags.get(key) ?? "default-etag",
      };
    },
    put: async (key: string, value: string, putOptions?: R2PutOptions) => {
      if (options?.failPut) {
        throw new Error("Simulated R2 put failure");
      }

      // Handle conditional writes (optimistic locking)
      const onlyIf = putOptions?.onlyIf as { etagMatches?: string } | undefined;
      if (onlyIf?.etagMatches) {
        const currentEtag = etags.get(key);
        if (currentEtag && currentEtag !== onlyIf.etagMatches) {
          return null; // Conditional write failed
        }
      }

      store.set(key, value);
      const newEtag = `etag-${++etagCounter}`;
      etags.set(key, newEtag);
      return { etag: newEtag };
    },
    delete: async (key: string) => {
      store.delete(key);
      etags.delete(key);
    },
    list: async (listOptions: { prefix: string; limit?: number; cursor?: string }) => {
      const objects: { key: string }[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(listOptions.prefix)) {
          objects.push({ key });
        }
      }
      return {
        objects: objects.slice(0, listOptions.limit ?? 100),
        truncated: objects.length > (listOptions.limit ?? 100),
        cursor: undefined,
      };
    },
    // Expose store for test inspection
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, string> };
};

/**
 * Helper to run an effect with the RunStorage layer
 */
function runWithStorage<A, E>(
  bucket: R2Bucket,
  effect: Effect.Effect<A, E, RunStorage>,
): Promise<A> {
  const layer = makeRunStorageLayer(bucket);
  return Effect.runPromise(Effect.provide(effect, layer));
}

/**
 * Helper to run an effect with the RunStorage layer and get Exit
 */
function runWithStorageExit<A, E>(
  bucket: R2Bucket,
  effect: Effect.Effect<A, E, RunStorage>,
): Promise<Exit.Exit<A, E>> {
  const layer = makeRunStorageLayer(bucket);
  return Effect.runPromiseExit(Effect.provide(effect, layer));
}

/**
 * Create a test run record
 */
function createTestRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    runId: "run-test-123",
    sessionId: "session-123",
    workflowId: "workflow-123",
    status: "started",
    task: "Test task description",
    title: "Test Run",
    model: DEFAULT_MODEL,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("RunStorage (R2)", () => {
  describe("getRun", () => {
    it("should store and retrieve run record", async () => {
      const bucket = createMockBucket();

      const run = createTestRun();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);
        return yield* storage.getRun(run.sessionId, run.runId);
      });

      const result = await runWithStorage(bucket, program);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.runId).toBe("run-test-123");
        expect(result.value.sessionId).toBe("session-123");
        expect(result.value.status).toBe("started");
        expect(result.value.title).toBe("Test Run");
      }
    });

    it("should return None for non-existent run", async () => {
      const bucket = createMockBucket();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        return yield* storage.getRun("session-123", "non-existent-run");
      });

      const result = await runWithStorage(bucket, program);

      expect(Option.isNone(result)).toBe(true);
    });

    it("should return RunStorageReadError on R2 failure", async () => {
      const bucket = createMockBucket({ failGet: true });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        return yield* storage.getRun("session-123", "run-123");
      });

      const result = await runWithStorageExit(bucket, program);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = result.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(RunStorageReadError);
          expect((error.error as RunStorageReadError).sessionId).toBe("session-123");
          expect((error.error as RunStorageReadError).runId).toBe("run-123");
          expect((error.error as RunStorageReadError).cause).toContain("R2 get failed");
        }
      }
    });

    it("should return RunStorageReadError for invalid JSON", async () => {
      const bucket = createMockBucket();
      // Manually insert invalid JSON
      bucket._store.set("sessions/session-123/runs/bad-run.json", "not-valid-json{");

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        return yield* storage.getRun("session-123", "bad-run");
      });

      const result = await runWithStorageExit(bucket, program);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = result.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(RunStorageReadError);
          expect((error.error as RunStorageReadError).cause).toContain("Invalid JSON");
        }
      }
    });

    it("should return RunStorageReadError for schema validation failure", async () => {
      const bucket = createMockBucket();
      // Insert valid JSON but invalid run schema (missing required fields)
      bucket._store.set(
        "sessions/session-123/runs/invalid-run.json",
        JSON.stringify({ runId: "invalid-run", wrongField: true }),
      );

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        return yield* storage.getRun("session-123", "invalid-run");
      });

      const result = await runWithStorageExit(bucket, program);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = result.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(RunStorageReadError);
          expect((error.error as RunStorageReadError).cause).toContain("Schema validation failed");
        }
      }
    });
  });

  describe("putRun", () => {
    it("should store run at correct R2 key path", async () => {
      const bucket = createMockBucket();

      const run = createTestRun({
        runId: "run-key-test",
        sessionId: "session-key-test",
      });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);
      });

      await runWithStorage(bucket, program);

      expect(bucket._store.has("sessions/session-key-test/runs/run-key-test.json")).toBe(true);
    });

    it("should also update the index when storing a run", async () => {
      const bucket = createMockBucket();

      const run = createTestRun({
        runId: "run-index-test",
        sessionId: "session-index-test",
      });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);
      });

      await runWithStorage(bucket, program);

      // Check that the index was created/updated
      expect(bucket._store.has("sessions/session-index-test/runs/_index.json")).toBe(true);

      // Parse the index and verify the run is there
      const indexJson = bucket._store.get("sessions/session-index-test/runs/_index.json");
      expect(indexJson).toBeDefined();
      const index = JSON.parse(indexJson as string);
      expect(index.runs["run-index-test"]).toBeDefined();
      expect(index.runs["run-index-test"].runId).toBe("run-index-test");
      expect(index.runs["run-index-test"].status).toBe("started");
    });

    it("should update existing run", async () => {
      const bucket = createMockBucket();

      const run = createTestRun();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);

        // Update the run
        const updated: RunRecord = {
          ...run,
          status: "completed",
          completedAt: Date.now(),
          result: {
            success: true,
            output: "Task completed successfully",
          },
        };
        yield* storage.putRun(updated);

        return yield* storage.getRun(run.sessionId, run.runId);
      });

      const result = await runWithStorage(bucket, program);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("completed");
        expect(result.value.result?.success).toBe(true);
      }
    });

    it("should return RunStorageWriteError on R2 failure", async () => {
      const bucket = createMockBucket({ failPut: true });

      const run = createTestRun();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);
      });

      const result = await runWithStorageExit(bucket, program);

      expect(Exit.isFailure(result)).toBe(true);
    });
  });

  describe("listRuns", () => {
    it("should list runs from index", async () => {
      const bucket = createMockBucket();
      const sessionId = "session-list-test";

      const run1 = createTestRun({
        runId: "run-1",
        sessionId,
        startedAt: Date.now() + 1000, // More recent
        title: "Run 1",
      });

      const run2 = createTestRun({
        runId: "run-2",
        sessionId,
        startedAt: Date.now(),
        title: "Run 2",
      });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run1);
        yield* storage.putRun(run2);
        return yield* storage.listRuns(sessionId);
      });

      const result = await runWithStorage(bucket, program);

      expect(result.runs.length).toBe(2);
      expect(result.total).toBe(2);

      const runIds = result.runs.map((r) => r.runId);
      expect(runIds).toContain("run-1");
      expect(runIds).toContain("run-2");

      // Runs should be sorted by startedAt (most recent first)
      expect(result.runs[0].runId).toBe("run-1");
    });

    it("should return empty list when no runs exist", async () => {
      const bucket = createMockBucket();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        return yield* storage.listRuns("empty-session");
      });

      const result = await runWithStorage(bucket, program);

      expect(result.runs.length).toBe(0);
      expect(result.total).toBe(0);
    });

    it("should return RunStorageReadError on R2 get failure", async () => {
      const bucket = createMockBucket({ failGet: true });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        return yield* storage.listRuns("session-123");
      });

      const result = await runWithStorageExit(bucket, program);

      expect(Exit.isFailure(result)).toBe(true);
    });

    it("should support pagination with limit and offset", async () => {
      const bucket = createMockBucket();
      const layer = makeRunStorageLayer(bucket);
      const sessionId = "session-paginated";

      // Create 5 runs
      for (let i = 0; i < 5; i++) {
        const run = createTestRun({
          runId: `run-${i}`,
          sessionId,
          startedAt: Date.now() + i * 1000, // Different start times
          title: `Run ${i}`,
        });
        await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const storage = yield* RunStorage;
              yield* storage.putRun(run);
            }),
            layer,
          ),
        );
      }

      // Get first 2 runs
      const page1 = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const storage = yield* RunStorage;
            return yield* storage.listRuns(sessionId, { limit: 2, offset: 0 });
          }),
          layer,
        ),
      );
      expect(page1.runs.length).toBe(2);
      expect(page1.total).toBe(5);

      // Get next 2 runs
      const page2 = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const storage = yield* RunStorage;
            return yield* storage.listRuns(sessionId, { limit: 2, offset: 2 });
          }),
          layer,
        ),
      );
      expect(page2.runs.length).toBe(2);
      expect(page2.total).toBe(5);

      // Get last run
      const page3 = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const storage = yield* RunStorage;
            return yield* storage.listRuns(sessionId, { limit: 2, offset: 4 });
          }),
          layer,
        ),
      );
      expect(page3.runs.length).toBe(1);
      expect(page3.total).toBe(5);
    });
  });

  describe("deleteRun", () => {
    it("should delete run and update index", async () => {
      const bucket = createMockBucket();
      const sessionId = "session-delete";

      const run = createTestRun({
        runId: "run-to-delete",
        sessionId,
      });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);

        // Verify run exists
        const before = yield* storage.getRun(sessionId, run.runId);
        expect(Option.isSome(before)).toBe(true);

        yield* storage.deleteRun(sessionId, run.runId);

        // Verify run is gone
        const after = yield* storage.getRun(sessionId, run.runId);
        return after;
      });

      const result = await runWithStorage(bucket, program);
      expect(Option.isNone(result)).toBe(true);

      // Verify run was removed from index
      const indexJson = bucket._store.get("sessions/session-delete/runs/_index.json");
      expect(indexJson).toBeDefined();
      const index = JSON.parse(indexJson as string);
      expect(index.runs["run-to-delete"]).toBeUndefined();
    });
  });

  describe("deleteAllRuns", () => {
    it("should delete all runs and index for a session", async () => {
      const bucket = createMockBucket();
      const sessionId = "session-delete-all";

      const run1 = createTestRun({
        runId: "run-1",
        sessionId,
      });

      const run2 = createTestRun({
        runId: "run-2",
        sessionId,
      });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run1);
        yield* storage.putRun(run2);

        // Verify runs exist
        const listBefore = yield* storage.listRuns(sessionId);
        expect(listBefore.total).toBe(2);

        yield* storage.deleteAllRuns(sessionId);

        // Verify all runs are gone
        const listAfter = yield* storage.listRuns(sessionId);
        return listAfter;
      });

      const result = await runWithStorage(bucket, program);
      expect(result.total).toBe(0);

      // Verify index and run files are deleted
      expect(bucket._store.has("sessions/session-delete-all/runs/_index.json")).toBe(false);
      expect(bucket._store.has("sessions/session-delete-all/runs/run-1.json")).toBe(false);
      expect(bucket._store.has("sessions/session-delete-all/runs/run-2.json")).toBe(false);
    });

    it("should succeed even when no runs exist", async () => {
      const bucket = createMockBucket();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.deleteAllRuns("empty-session");
        return "success";
      });

      const result = await runWithStorage(bucket, program);
      expect(result).toBe("success");
    });
  });

  describe("concurrent modification retry", () => {
    it("should retry and succeed when index is modified concurrently", async () => {
      // Create a bucket that simulates concurrent modification
      // The first conditional write attempt will fail due to etag mismatch, but retry should succeed
      const store = new Map<string, string>();
      let etagCounter = 0;
      const etags = new Map<string, string>();
      let indexWriteAttempts = 0;

      // Pre-populate an index so that conditional writes (with etag) are used
      const sessionId = "session-concurrent";
      const indexKey = `sessions/${sessionId}/runs/_index.json`;
      const initialIndex = {
        version: 1,
        runs: {},
        updatedAt: Date.now(),
      };
      store.set(indexKey, JSON.stringify(initialIndex));
      etags.set(indexKey, "initial-etag");

      const bucket = {
        get: async (key: string) => {
          const data = store.get(key);
          if (!data) return null;
          return {
            json: async <T>() => JSON.parse(data) as T,
            etag: etags.get(key),
          };
        },
        put: async (key: string, value: string, putOptions?: R2PutOptions) => {
          const onlyIf = putOptions?.onlyIf as { etagMatches?: string } | undefined;

          // Track conditional writes to the index (these are the ones that can fail)
          if (key.endsWith("_index.json") && onlyIf?.etagMatches) {
            indexWriteAttempts++;

            // Simulate concurrent modification on first conditional write only
            // Another process changes the etag between our read and write
            if (indexWriteAttempts === 1) {
              // First, write the data (simulating another process's write)
              store.set(key, value);
              // But use a different etag than expected (simulating concurrent modification)
              const newEtag = `concurrent-etag-${++etagCounter}`;
              etags.set(key, newEtag);
              return null; // Conditional write failed - etag mismatch
            }
          }

          // For non-conditional writes or subsequent retries, succeed
          store.set(key, value);
          const newEtag = `etag-${++etagCounter}`;
          etags.set(key, newEtag);
          return { etag: newEtag };
        },
        delete: async (key: string) => {
          store.delete(key);
          etags.delete(key);
        },
      } as unknown as R2Bucket;

      const run = createTestRun({
        runId: "run-concurrent-test",
        sessionId,
      });

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);
        return yield* storage.getRun(run.sessionId, run.runId);
      });

      const result = await runWithStorage(bucket, program);

      // The run should be stored successfully despite the first attempt failing
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.runId).toBe("run-concurrent-test");
      }

      // Verify retry happened (at least 2 conditional write attempts to the index)
      expect(indexWriteAttempts).toBeGreaterThanOrEqual(2);
    });
  });

  describe("update flow", () => {
    it("should update existing run status", async () => {
      const bucket = createMockBucket();

      const run = createTestRun();

      const program = Effect.gen(function* () {
        const storage = yield* RunStorage;
        yield* storage.putRun(run);

        // Update the run
        const updated: RunRecord = {
          ...run,
          status: "completed",
          completedAt: Date.now() + 1000,
          result: {
            success: true,
            output: "Done!",
          },
        };
        yield* storage.putRun(updated);

        return yield* storage.getRun(run.sessionId, run.runId);
      });

      const result = await runWithStorage(bucket, program);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("completed");
        expect(result.value.result?.success).toBe(true);
        expect(result.value.completedAt).toBeDefined();
      }
    });

    it("should update index when run is updated", async () => {
      const bucket = createMockBucket();
      const layer = makeRunStorageLayer(bucket);
      const sessionId = "session-update-idx";

      const run = createTestRun({
        runId: "run-idx-update",
        sessionId,
        title: "Original Title",
      });

      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const storage = yield* RunStorage;
            yield* storage.putRun(run);
          }),
          layer,
        ),
      );

      // Update the run
      const updated: RunRecord = {
        ...run,
        status: "completed",
        title: "Updated Title",
        completedAt: Date.now() + 5000,
      };
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const storage = yield* RunStorage;
            yield* storage.putRun(updated);
          }),
          layer,
        ),
      );

      // Verify index was updated
      const indexJson = bucket._store.get("sessions/session-update-idx/runs/_index.json");
      expect(indexJson).toBeDefined();
      const index = JSON.parse(indexJson as string);
      expect(index.runs["run-idx-update"].status).toBe("completed");
      expect(index.runs["run-idx-update"].title).toBe("Updated Title");
      expect(index.runs["run-idx-update"].completedAt).toBeDefined();
    });
  });
});
