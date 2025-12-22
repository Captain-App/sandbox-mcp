// src/agent/tools.test.ts
import { describe, expect, it } from "vitest";

import {
  formatToolResponse,
  getResultInputSchema,
  listRunsInputSchema,
  runTaskInputSchema,
} from "./tools";

describe("MCP Tool Schemas", () => {
  describe("runTaskInputSchema", () => {
    it("should validate run task with repository (new session)", () => {
      const valid = {
        repository: "https://github.com/user/repo",
        task: "Add authentication to the API",
      };

      const result = runTaskInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should validate run task with sessionId (continuation)", () => {
      const valid = {
        sessionId: "sess-abc123",
        task: "Continue working on authentication",
      };

      const result = runTaskInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should validate run task with all optional fields", () => {
      const valid = {
        sessionId: "sess-abc123",
        repository: "https://github.com/user/repo",
        task: "Add JWT auth",
        branch: "feature/auth",
        model: "claude-sonnet-4-20250514",
        title: "JWT auth",
      };

      const result = runTaskInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should reject invalid repository URL", () => {
      const invalid = {
        repository: "https://gitlab.com/user/repo",
        task: "Some task",
      };

      const result = runTaskInputSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("should require task field", () => {
      const invalid = {
        sessionId: "sess-abc123",
      };

      const result = runTaskInputSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("getResultInputSchema", () => {
    it("should validate get result input with sessionId and runId", () => {
      const valid = {
        sessionId: "sess-abc123",
        runId: "run-abc123",
      };

      const result = getResultInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should require sessionId", () => {
      const invalid = {
        runId: "run-abc123",
      };

      const result = getResultInputSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("should require runId", () => {
      const invalid = {
        sessionId: "sess-abc123",
      };

      const result = getResultInputSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("listRunsInputSchema", () => {
    it("should validate list runs with sessionId", () => {
      const valid = {
        sessionId: "sess-abc123",
      };

      const result = listRunsInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should validate list runs with optional limit", () => {
      const valid = {
        sessionId: "sess-abc123",
        limit: 20,
      };

      const result = listRunsInputSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should require sessionId", () => {
      const invalid = {};

      const result = listRunsInputSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("should enforce limit bounds", () => {
      expect(listRunsInputSchema.safeParse({ sessionId: "test", limit: 0 }).success).toBe(false);
      expect(listRunsInputSchema.safeParse({ sessionId: "test", limit: 101 }).success).toBe(false);
      expect(listRunsInputSchema.safeParse({ sessionId: "test", limit: 50 }).success).toBe(true);
    });
  });

  describe("formatToolResponse", () => {
    it("should format tool response correctly", () => {
      const data = { runId: "test", status: "started" };
      const response = formatToolResponse(data);

      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe("text");
      expect(JSON.parse(response.content[0].text)).toEqual(data);
    });
  });
});
