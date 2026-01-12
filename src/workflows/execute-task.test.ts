import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cloudflare:workers
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      public env: any,
      public ctx: any,
    ) {}
  },
}));

import { ExecuteTaskWorkflow } from "./execute-task";
import { Sandbox, Run, OpenCode, Backup } from "./helpers";

// Mock helpers
vi.mock("./helpers", () => ({
  Sandbox: {
    getSandbox: vi.fn(),
    ensureSandboxReady: vi.fn(),
  },
  Run: {
    createRun: vi.fn(),
    completeRun: vi.fn(),
    updateSessionAfterRun: vi.fn(),
  },
  OpenCode: {
    executeTask: vi.fn(),
    getSessionTitle: vi.fn(),
  },
  Backup: {
    backupSession: vi.fn(),
  },
  WorkflowEventBuilder: class {
    setMetadata = vi.fn();
    setOutcome = vi.fn();
    setError = vi.fn();
    finalize = vi.fn().mockReturnValue({});
  },
}));

describe("ExecuteTaskWorkflow", () => {
  let workflow: any;
  let mockStep: any;
  let mockEvent: any;
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      Sandbox: {},
      SESSIONS_BUCKET: {},
      SHIPBOX_API: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ ok: true }),
        }),
      },
    };

    // Instantiate workflow (mocking the base class if necessary, but here we just call run)
    workflow = new ExecuteTaskWorkflow(mockEnv, {} as any);
    // Since we don't have a real runtime, we'll manually call run

    // Mock WorkflowStep
    mockStep = {
      do: vi.fn(async (name, optionsOrCallback, maybeCallback) => {
        const callback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
        return await callback();
      }),
    };

    mockEvent = {
      instanceId: "wf-123",
      payload: {
        runId: "run-456",
        sessionId: "sess-789",
        sandboxId: "sb-101",
        userId: "user-123",
        requestId: "req-123",
        task: "do stuff",
        proxyBaseUrl: "https://proxy",
        proxyToken: "jwt",
      },
    };
  });

  it("should execute the full workflow successfully", async () => {
    vi.mocked(Sandbox.ensureSandboxReady).mockResolvedValue({
      workspacePath: "/workspace",
      restoredBackup: true,
      clonedRepo: false,
      configuredProxy: true,
    });

    vi.mocked(OpenCode.executeTask).mockResolvedValue({
      opencodeSessionId: "opencode-1",
      result: { success: true, output: "done" },
    });

    vi.mocked(OpenCode.getSessionTitle).mockResolvedValue("My Task Title");

    const result = await workflow.run(mockEvent, mockStep);

    expect(result.success).toBe(true);
    expect(result.title).toBe("My Task Title");

    // Verify steps were called
    expect(mockStep.do).toHaveBeenCalledWith("create-run", expect.any(Function));
    expect(mockStep.do).toHaveBeenCalledWith("ensure-sandbox-ready", expect.any(Function));
    expect(mockStep.do).toHaveBeenCalledWith(
      "execute-opencode-task",
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockStep.do).toHaveBeenCalledWith("backup-session", expect.any(Function));
    expect(mockStep.do).toHaveBeenCalledWith("complete-run", expect.any(Function));

    // Verify side effects
    expect(Run.createRun).toHaveBeenCalled();
    expect(Run.completeRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-456",
      expect.objectContaining({ success: true }),
    );
  });

  it("should handle failures and record them", async () => {
    vi.mocked(Sandbox.ensureSandboxReady).mockRejectedValue(new Error("Sandbox failed"));

    const result = await workflow.run(mockEvent, mockStep);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sandbox failed");

    expect(mockStep.do).toHaveBeenCalledWith("complete-run-failure", expect.any(Function));
    expect(Run.completeRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-456",
      expect.objectContaining({ success: false, error: "Sandbox failed" }),
    );
  });
});
