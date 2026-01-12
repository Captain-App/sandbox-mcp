import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @cloudflare/sandbox before importing backup helpers
vi.mock("@cloudflare/sandbox", () => ({
  collectFile: vi.fn(),
  Sandbox: class {},
}));

import { backupSession, restoreSession } from "./backup";
import { collectFile } from "@cloudflare/sandbox";

describe("Backup Helper", () => {
  const mockSandbox = {
    exec: vi.fn(),
    readFileStream: vi.fn(),
  };

  const mockBucket = {
    get: vi.fn(),
    put: vi.fn(),
  };

  const sessionId = "sess-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("restoreSession", () => {
    it("should return false if backup not found", async () => {
      mockBucket.get.mockResolvedValue(null);
      const result = await restoreSession(mockSandbox as any, sessionId, mockBucket as any);
      expect(result).toBe(false);
    });

    it("should successfully restore from R2", async () => {
      const mockData = new Uint8Array([1, 2, 3]);
      mockBucket.get.mockResolvedValue({
        arrayBuffer: async () => mockData.buffer,
      });
      mockSandbox.exec.mockResolvedValue({ stdout: "ok", exitCode: 0 });

      const result = await restoreSession(mockSandbox as any, sessionId, mockBucket as any);

      expect(result).toBe(true);
      expect(mockBucket.get).toHaveBeenCalledWith(`sessions/${sessionId}/opencode-storage.tar.gz`);
      expect(mockSandbox.exec).toHaveBeenCalledWith(expect.stringContaining("tar -xzf"));
    });
  });

  describe("backupSession", () => {
    it("should successfully backup to R2", async () => {
      // 1. tar command
      mockSandbox.exec.mockResolvedValueOnce({ exitCode: 0 });
      // 2. test -f command
      mockSandbox.exec.mockResolvedValueOnce({ stdout: "exists", exitCode: 0 });

      const mockStream = {};
      mockSandbox.readFileStream.mockResolvedValue(mockStream);
      vi.mocked(collectFile).mockResolvedValue({
        content: new Uint8Array([4, 5, 6]),
        metadata: { size: 3 },
      } as any);

      await backupSession(mockSandbox as any, sessionId, mockBucket as any);

      expect(mockSandbox.exec).toHaveBeenCalledWith(expect.stringContaining("tar -czf"));
      expect(mockSandbox.readFileStream).toHaveBeenCalledWith("/tmp/opencode-backup.tar.gz");
      expect(mockBucket.put).toHaveBeenCalledWith(
        `sessions/${sessionId}/opencode-storage.tar.gz`,
        expect.any(Uint8Array),
      );
    });

    it("should skip backup if tar fails", async () => {
      mockSandbox.exec.mockResolvedValueOnce({ exitCode: 1, stderr: "tar error" });
      await expect(backupSession(mockSandbox as any, sessionId, mockBucket as any)).rejects.toThrow(
        /Failed to create backup archive/,
      );
      expect(mockBucket.put).not.toHaveBeenCalled();
    });
  });
});
