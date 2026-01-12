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
    it("should construct the correct command and start wrangler dev", async () => {
      // Mock successful cleanup and startup
      mockSandbox.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes("pkill")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("nohup npx wrangler dev")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("ps aux")) return { exitCode: 0, stdout: "wrangler dev --port 8787" };
        return { exitCode: 0, stdout: "" };
      });

      const promise = startMiniflare(mockSandbox as any, "/workspace/my-worker/src/index.ts", 8787);

      // Fast-forward the timeouts (3s + 2s)
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.port).toBe(8787);
      expect(result.logPath).toBe("/tmp/miniflare-8787.log");

      // Verify commands - should cd to project root (parent of src/)
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('pkill -f "wrangler.*dev.*--port 8787"'),
      );
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining(
          "cd /workspace/my-worker && nohup npx wrangler dev --local --ip 0.0.0.0 --port 8787",
        ),
      );
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('ps aux | grep -E "[w]rangler.*dev.*--port 8787"'),
      );
    });

    it("should return error if the startup command fails", async () => {
      mockSandbox.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes("pkill")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("nohup npx wrangler dev")) {
          return { exitCode: 1, stderr: "npx not found", stdout: "" };
        }
        return { exitCode: 0, stdout: "" };
      });

      const result = await startMiniflare(mockSandbox as any, "/workspace/worker/src/index.ts");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to start wrangler dev");
    });

    it("should return success: false with log contents if wrangler is not running after startup", async () => {
      mockSandbox.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes("pkill")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("nohup npx wrangler dev")) return { exitCode: 0, stdout: "" };
        if (cmd.includes("ps aux")) return { exitCode: 0, stdout: "" }; // Not running
        if (cmd.includes("cat")) return { exitCode: 0, stdout: "Error: Missing config" };
        return { exitCode: 0, stdout: "" };
      });

      const promise = startMiniflare(mockSandbox as any, "/workspace/worker/src/index.ts");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Wrangler dev failed to start");
      expect(result.error).toContain("Error: Missing config");
    });
  });

  describe("stopMiniflare", () => {
    it("should call pkill for both wrangler and miniflare on the specified port", async () => {
      mockSandbox.exec.mockResolvedValue({ exitCode: 0 });

      const result = await stopMiniflare(mockSandbox as any, 8888);

      expect(result).toBe(true);
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('pkill -f "wrangler.*dev.*--port 8888"'),
      );
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining('pkill -f "miniflare.*--port 8888"'),
      );
    });
  });
});
