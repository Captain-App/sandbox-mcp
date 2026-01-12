import { describe, it, expect, vi, beforeEach } from "vitest";
import { startMiniflare, stopMiniflare } from "./miniflare";

describe("Miniflare Helper", () => {
  const mockSandbox = {
    exec: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  describe("startMiniflare", () => {
    it("should construct the correct command and start miniflare", async () => {
      // Mock successful cleanup and startup
      mockSandbox.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes("pkill")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("nohup npx miniflare")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("ps aux")) return { exitCode: 0, stdout: "miniflare --port 8787" };
        return { exitCode: 0, stdout: "" };
      });

      const promise = startMiniflare(mockSandbox as any, "/workspace/worker/index.ts", 8787);

      // Fast-forward the 2s timeout
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.port).toBe(8787);
      expect(result.logPath).toBe("/tmp/miniflare-8787.log");

      // Verify commands
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('pkill -f "miniflare.*--port 8787"'),
      );
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining(
          "nohup npx miniflare --host 0.0.0.0 --port 8787 /workspace/worker/index.ts",
        ),
      );
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('ps aux | grep "[m]iniflare.*--port 8787"'),
      );
    });

    it("should throw if the startup command fails", async () => {
      mockSandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // pkill
      mockSandbox.exec.mockResolvedValueOnce({ exitCode: 1, stderr: "npx not found" }); // start

      await expect(startMiniflare(mockSandbox as any, "index.ts")).rejects.toThrow(
        "Failed to start miniflare: npx not found",
      );
    });

    it("should return success: false if miniflare is not running after startup", async () => {
      mockSandbox.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes("ps aux")) return { exitCode: 0, stdout: "" }; // Not running
        return { exitCode: 0, stdout: "" };
      });

      const promise = startMiniflare(mockSandbox as any, "index.ts");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
    });
  });

  describe("stopMiniflare", () => {
    it("should call pkill for the specified port", async () => {
      mockSandbox.exec.mockResolvedValue({ exitCode: 0 });

      const result = await stopMiniflare(mockSandbox as any, 8888);

      expect(result).toBe(true);
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('pkill -f "miniflare.*--port 8888"'),
      );
    });
  });
});
