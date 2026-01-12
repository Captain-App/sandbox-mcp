import { describe, it, expect, vi, beforeEach } from "vitest";
import { Schema } from "effect";

// Mock agents/mcp
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    constructor(
      public env: any,
      public state: any,
    ) {}
    setState = vi.fn();
    async onConnect() {} // Add onConnect
  },
}));

// Mock @modelcontextprotocol/sdk
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool = vi.fn();
  },
}));

// Mock proxy
vi.mock("../proxy", () => ({
  createProxyToken: vi.fn(),
}));

import { OpenCodeMcpAgent } from "./mcp-agent";
import * as Proxy from "../proxy";
import { SessionStorage } from "../services/session";
import { RunStorage } from "../services/run";
import { Effect, Option } from "effect";

describe("OpenCodeMcpAgent", () => {
  let agent: any;
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      SESSIONS_BUCKET: {},
      PROXY_JWT_SECRET: "secret",
      EXECUTE_TASK_WORKFLOW: {
        create: vi.fn().mockResolvedValue({ id: "wf-1" }),
      },
    };

    // Create agent by casting to any to avoid constructor signature issues
    agent = new (OpenCodeMcpAgent as any)(mockEnv, { initialized: false });

    // Manually trigger init to register tools
    agent.init();

    // Mock runtime properly AFTER init() which creates it
    agent.runtime = {
      runPromise: vi.fn(),
    } as any;
  });

  it("should register 3 tools on init", () => {
    expect(agent.server.registerTool).toHaveBeenCalledTimes(3);
    const tools = agent.server.registerTool.mock.calls.map((c: any) => c[0]);
    expect(tools).toContain("opencode_run_task");
    expect(tools).toContain("opencode_get_result");
    expect(tools).toContain("opencode_list_runs");
  });

  describe("opencode_run_task", () => {
    it("should create a new session and workflow", async () => {
      const runTask = agent.server.registerTool.mock.calls.find(
        (c: any) => c[0] === "opencode_run_task",
      )[2];

      vi.mocked(Proxy.createProxyToken).mockReturnValue(Effect.succeed("jwt-token") as any);

      // Mock storage.putSession
      agent.runtime.runPromise.mockResolvedValueOnce(null);

      // Set userId and baseUrl from connect
      await agent.onConnect({} as any, {
        request: new Request("https://worker.dev/mcp", { headers: { "X-User-Id": "user-123" } }),
      });

      const result = await runTask({ task: "hello" });
      const data = JSON.parse(result.content[0].text);

      expect(data.status).toBe("started");
      expect(mockEnv.EXECUTE_TASK_WORKFLOW.create).toHaveBeenCalled();
    });

    it("should resume existing session", async () => {
      const runTask = agent.server.registerTool.mock.calls.find(
        (c: any) => c[0] === "opencode_run_task",
      )[2];

      const existingSession = {
        sessionId: "sess-123",
        sandboxId: "sb-123",
        userId: "user-123",
        clonedRepos: [],
        config: { defaultModel: "claude-3-5-sonnet" },
      };

      // Set userId and baseUrl from connect
      await agent.onConnect({} as any, {
        request: new Request("https://worker.dev/mcp", { headers: { "X-User-Id": "user-123" } }),
      });

      // Mock storage.getSession then storage.putSession
      agent.runtime.runPromise
        .mockResolvedValueOnce(Option.some(existingSession))
        .mockResolvedValueOnce(null);

      vi.mocked(Proxy.createProxyToken).mockReturnValue(Effect.succeed("jwt-token") as any);

      const result = await runTask({ sessionId: "sess-123", task: "continue" });
      const data = JSON.parse(result.content[0].text);

      expect(data.sessionId).toBe("sess-123");
      expect(mockEnv.EXECUTE_TASK_WORKFLOW.create).toHaveBeenCalled();
    });
  });

  describe("opencode_get_result", () => {
    it("should return run status", async () => {
      const getResult = agent.server.registerTool.mock.calls.find(
        (c: any) => c[0] === "opencode_get_result",
      )[2];

      const mockRun = {
        runId: "run-1",
        sessionId: "sess-1",
        status: "completed",
        result: { success: true, output: "done" },
      };

      // Mock storage.getRun then storage.getSession
      agent.runtime.runPromise
        .mockResolvedValueOnce(Option.some(mockRun))
        .mockResolvedValueOnce(Option.none());

      const result = await getResult({ runId: "run-1" });
      const data = JSON.parse(result.content[0].text);

      expect(data.status).toBe("completed");
      expect(data.result.output).toBe("done");
    });
  });
});
