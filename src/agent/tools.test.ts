// src/agent/tools.test.ts
import { describe, it, expect } from "vitest";
import { createSessionInputSchema, runTaskInputSchema, formatToolResponse } from "./tools";

describe("MCP Tool Schemas", () => {
	it("should validate create session input", () => {
		const valid = {
			sessionId: "my-session",
			repositoryUrl: "https://github.com/user/repo",
			branch: "main",
		};

		const result = createSessionInputSchema.safeParse(valid);
		expect(result.success).toBe(true);
	});

	it("should reject invalid session ID in create session", () => {
		const invalid = {
			sessionId: "INVALID_ID!",
		};

		const result = createSessionInputSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it("should validate run task input", () => {
		const valid = {
			sessionId: "my-session",
			task: "Add authentication to the API",
		};

		const result = runTaskInputSchema.safeParse(valid);
		expect(result.success).toBe(true);
	});

	it("should format tool response correctly", () => {
		const data = { sessionId: "test", status: "created" };
		const response = formatToolResponse(data);

		expect(response.content).toHaveLength(1);
		expect(response.content[0].type).toBe("text");
		expect(JSON.parse(response.content[0].text)).toEqual(data);
	});
});
