import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { RunRecord } from "./run";

describe("Run Model", () => {
	it("should parse valid run record", () => {
		const input = {
			runId: "run-abc123",
			sessionId: "my-session",
			workflowId: "wf-xyz",
			status: "running",
			task: "Add authentication to the API",
			model: "claude-sonnet-4-20250514",
			startedAt: Date.now(),
			retryCount: 0,
			maxRetries: 3,
		};

		const result = Schema.decodeUnknownSync(RunRecord)(input);

		expect(result.runId).toBe("run-abc123");
		expect(result.status).toBe("running");
	});

	it("should parse completed run with result", () => {
		const input = {
			runId: "run-abc123",
			sessionId: "my-session",
			workflowId: "wf-xyz",
			status: "completed",
			task: "Add README",
			model: "claude-sonnet-4-20250514",
			startedAt: Date.now() - 60000,
			completedAt: Date.now(),
			retryCount: 0,
			maxRetries: 3,
			result: {
				success: true,
				output: "Created README.md with project documentation",
				filesCreated: ["README.md"],
				filesModified: [],
				commits: ["abc123"],
			},
		};

		const result = Schema.decodeUnknownSync(RunRecord)(input);

		expect(result.status).toBe("completed");
		expect(result.result?.success).toBe(true);
		expect(result.result?.filesCreated).toContain("README.md");
	});

	it("should validate all run status values", () => {
		const statuses = ["queued", "running", "completed", "failed", "retrying"];

		for (const status of statuses) {
			const input = {
				runId: "run-test",
				sessionId: "session",
				workflowId: "wf-test",
				status,
				task: "Test task",
				model: "claude-sonnet-4-20250514",
				startedAt: Date.now(),
				retryCount: 0,
				maxRetries: 3,
			};

			const result = Schema.decodeUnknownSync(RunRecord)(input);
			expect(result.status).toBe(status);
		}
	});

	it("should parse failed run with error", () => {
		const input = {
			runId: "run-failed",
			sessionId: "my-session",
			workflowId: "wf-xyz",
			status: "failed",
			task: "Do something",
			model: "claude-sonnet-4-20250514",
			startedAt: Date.now() - 60000,
			completedAt: Date.now(),
			retryCount: 3,
			maxRetries: 3,
			result: {
				success: false,
				error: "Timeout after 50 minutes",
				filesCreated: [],
				filesModified: [],
				commits: [],
			},
		};

		const result = Schema.decodeUnknownSync(RunRecord)(input);

		expect(result.status).toBe("failed");
		expect(result.result?.success).toBe(false);
		expect(result.result?.error).toContain("Timeout");
	});
});
