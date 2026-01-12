import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @cloudflare/sandbox before importing ensureSandboxReady
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
  Sandbox: class {},
}));

import { ensureSandboxReady } from "./sandbox";
import * as Proxy from "../../proxy";
import * as Backup from "./backup";

// Mock dependencies
vi.mock("../../proxy", () => ({
  configureAnthropic: vi.fn(),
  configureGithub: vi.fn(),
  toContainerUrl: vi
    .fn()
    .mockImplementation((url) =>
      url.replace("https", "http").replace("worker.dev", "host.containers.internal"),
    ),
}));

vi.mock("./backup", () => ({
  restoreSession: vi.fn(),
}));

vi.mock("../../storage/keys", () => ({
  StorageKeys: {
    commandLog: vi.fn().mockReturnValue("command-log-key"),
  },
}));

describe("Sandbox Helper: ensureSandboxReady", () => {
  const mockSandbox = {
    exec: vi.fn(),
    gitCheckout: vi.fn(),
  };

  const mockBucket = {
    put: vi.fn().mockResolvedValue(null),
    get: vi.fn(),
  };

  const params = {
    sandbox: mockSandbox as any,
    sessionId: "sess-123",
    bucket: mockBucket as any,
    proxyBaseUrl: "https://worker.dev",
    proxyToken: "jwt-123",
    repository: { url: "https://github.com/owner/repo", branch: "main" },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Flexible exec mock based on command content
    mockSandbox.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes("ANTHROPIC_BASE_URL")) return { stdout: "missing", exitCode: 0 };
      if (cmd.includes("~/.local/share/opencode/storage"))
        return { stdout: "missing", exitCode: 0 };
      if (cmd.includes(".git && echo exists")) return { stdout: "missing", exitCode: 0 };
      return { stdout: "ok", exitCode: 0 };
    });
  });

  it("should perform full initialization when nothing is configured", async () => {
    vi.mocked(Backup.restoreSession).mockResolvedValue(true);

    const result = await ensureSandboxReady(params);

    expect(result.configuredProxy).toBe(true);
    expect(result.restoredBackup).toBe(true);
    expect(result.clonedRepo).toBe(true);
    expect(result.workspacePath).toBe("/workspace/repo");

    expect(Proxy.configureAnthropic).toHaveBeenCalled();
    expect(Proxy.configureGithub).toHaveBeenCalled();
    expect(Backup.restoreSession).toHaveBeenCalled();
    expect(mockSandbox.gitCheckout).toHaveBeenCalled();
  });

  it("should skip steps if already configured (idempotency)", async () => {
    mockSandbox.exec.mockImplementation(async (_cmd: string) => {
      return { stdout: "exists", exitCode: 0 };
    });

    const result = await ensureSandboxReady(params);

    expect(result.configuredProxy).toBe(false);
    expect(result.restoredBackup).toBe(false);
    expect(result.clonedRepo).toBe(false);

    expect(Proxy.configureAnthropic).not.toHaveBeenCalled();
    expect(Backup.restoreSession).not.toHaveBeenCalled();
    expect(mockSandbox.gitCheckout).not.toHaveBeenCalled();
  });

  it("should handle missing repository correctly", async () => {
    const noRepoParams = { ...params, repository: undefined };

    // Proxy exists, Storage exists
    mockSandbox.exec.mockResolvedValueOnce({ stdout: "exists", exitCode: 0 });
    mockSandbox.exec.mockResolvedValueOnce({ stdout: "exists", exitCode: 0 });

    const result = await ensureSandboxReady(noRepoParams);

    expect(result.workspacePath).toBe("/workspace");
    expect(result.clonedRepo).toBe(false);
  });
});
