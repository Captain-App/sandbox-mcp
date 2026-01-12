import { describe, it, expect, vi, beforeEach } from "vitest";
import { Exit, Option } from "effect";

// Mock agents/mcp
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    constructor(
      public env: any,
      public state: any,
    ) {}
    setState = vi.fn();
    async onConnect() {}
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

// Mock helpers
vi.mock("../workflows/helpers", () => ({
  Miniflare: {
    startMiniflare: vi.fn(),
  },
  Deploy: {
    deployWorker: vi.fn(),
  },
  Sandbox: {
    getSandbox: vi.fn().mockReturnValue({}),
  },
}));

import { OpenCodeMcpAgent } from "./mcp-agent";
import * as Helpers from "../workflows/helpers";

describe("OpenCodeMcpAgent - Worker Tools", () => {
  let agent: any;
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      SESSIONS_BUCKET: {},
      Sandbox: {},
      PROXY_JWT_SECRET: "secret",
      CLOUDFLARE_ACCOUNT_ID: "acc-123",
      CLOUDFLARE_API_TOKEN: "token-123",
      CLOUDFLARE_DISPATCH_NAMESPACE: "ns-123",
    };

    agent = new (OpenCodeMcpAgent as any)(mockEnv, { initialized: false });
    agent.init();
    agent.runtime = {
      runPromise: vi.fn(),
      runPromiseExit: vi.fn(),
    } as any;
  });

  describe("opencode_preview_worker", () => {
    it("should start miniflare and return preview URL", async () => {
      const previewWorker = agent.server.registerTool.mock.calls.find(
        (c: any) => c[0] === "opencode_preview_worker",
      )[2];

      const session = { sessionId: "sess-1", sandboxId: "sb-1" };
      agent.runtime.runPromiseExit.mockResolvedValueOnce(Exit.succeed(Option.some(session)));
      vi.mocked(Helpers.Miniflare.startMiniflare).mockResolvedValueOnce({
        success: true,
        port: 8787,
        logPath: "/tmp/log",
      });

      // Set base URL from connect
      await agent.onConnect({} as any, {
        request: new Request("https://worker.dev/mcp"),
      });

      const result = await previewWorker({ sessionId: "sess-1", workerPath: "index.ts" });
      const data = JSON.parse(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.previewUrl).toBe("https://worker.dev/preview/sess-1/");
      expect(Helpers.Miniflare.startMiniflare).toHaveBeenCalled();
    });

    it("should return error if session not found", async () => {
      const previewWorker = agent.server.registerTool.mock.calls.find(
        (c: any) => c[0] === "opencode_preview_worker",
      )[2];

      agent.runtime.runPromiseExit.mockResolvedValueOnce(Exit.succeed(Option.none()));

      const result = await previewWorker({ sessionId: "missing", workerPath: "index.ts" });
      const data = JSON.parse(result.content[0].text);

      expect(data.error.code).toBe("SESSION_NOT_FOUND");
    });
  });

  describe("opencode_deploy_worker", () => {
    it("should deploy worker and return production URL", async () => {
      const deployWorkerTool = agent.server.registerTool.mock.calls.find(
        (c: any) => c[0] === "opencode_deploy_worker",
      )[2];

      const session = { sessionId: "sess-1", sandboxId: "sb-1", userId: "user-1" };
      agent.runtime.runPromiseExit.mockResolvedValueOnce(Exit.succeed(Option.some(session)));
      agent.runtime.runPromise.mockResolvedValueOnce("jwt-token");
      vi.mocked(Helpers.Deploy.deployWorker).mockResolvedValueOnce({
        success: true,
        workerName: "sandbox-sess-1",
        url: "https://sandbox-sess-1.ns-123.workers.dev",
      });

      await agent.onConnect({} as any, {
        request: new Request("https://worker.dev/mcp"),
      });

      const result = await deployWorkerTool({ sessionId: "sess-1", workerPath: "index.ts" });
      const data = JSON.parse(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.url).toBe("https://sandbox-sess-1.ns-123.workers.dev");
      expect(Helpers.Deploy.deployWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acc-123",
          apiToken: "token-123",
        }),
      );
    });
  });
});
