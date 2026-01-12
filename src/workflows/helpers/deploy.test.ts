import { describe, it, expect, vi, beforeEach } from "vitest";
import { deployWorker } from "./deploy";

describe("Deploy Helper", () => {
  const mockSandbox = {
    exec: vi.fn(),
  };

  const params = {
    sandbox: mockSandbox as any,
    sessionId: "sess-123",
    workerPath: "/workspace/index.ts",
    accountId: "acc-123",
    apiToken: "token-123",
    dispatchNamespace: "ns-123",
    proxyBaseUrl: "https://proxy.dev",
    proxyToken: "jwt-123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("should bundle and deploy a worker successfully", async () => {
    // 1. Mock esbuild
    mockSandbox.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes("esbuild")) return { exitCode: 0, stdout: "" };
      if (cmd.includes("cat /tmp/sandbox-sess-123.js"))
        return { exitCode: 0, stdout: "console.log('hello')" };
      return { exitCode: 0, stdout: "" };
    });

    // 2. Mock Cloudflare API response
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, errors: [] }),
    });

    const result = await deployWorker(params);

    expect(result.success).toBe(true);
    expect(result.workerName).toBe("sandbox-sess-123");
    expect(result.url).toBe("https://sandbox-sess-123.ns-123.workers.dev");

    // Verify esbuild command
    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining("npx esbuild /workspace/index.ts"),
    );

    // Verify fetch call
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/accounts/acc-123/workers/dispatch/namespaces/ns-123/scripts/sandbox-sess-123",
      ),
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bearer token-123",
        },
        body: expect.any(FormData),
      }),
    );
  });

  it("should handle bundling failures", async () => {
    mockSandbox.exec.mockResolvedValue({ exitCode: 1, stderr: "syntax error" });

    const result = await deployWorker(params);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Bundling failed: syntax error");
  });

  it("should handle Cloudflare API failures", async () => {
    mockSandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "ok" });
    (global.fetch as any).mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, errors: [{ message: "Invalid script" }] }),
    });

    const result = await deployWorker(params);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cloudflare deployment failed: Invalid script");
  });
});
