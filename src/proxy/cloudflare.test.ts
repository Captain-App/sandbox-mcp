import { describe, it, expect, vi, beforeEach } from "vitest";
import { cloudflare } from "./services/cloudflare";

describe("Cloudflare Proxy Service", () => {
  const mockCtx = {
    env: {
      CLOUDFLARE_API_TOKEN: "real-token-123",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate", () => {
    it("should extract token from Authorization header", () => {
      const req = new Request("https://proxy.dev/cloudflare", {
        headers: { Authorization: "Bearer test-token" },
      });
      const result = cloudflare.validate(req);
      expect(result).toBe("test-token");
    });

    it("should return null if Authorization header is missing or invalid", () => {
      const req = new Request("https://proxy.dev/cloudflare");
      expect(cloudflare.validate(req)).toBe(null);

      const req2 = new Request("https://proxy.dev/cloudflare", {
        headers: { Authorization: "Basic something" },
      });
      expect(cloudflare.validate(req2)).toBe(null);
    });
  });

  describe("transform", () => {
    it("should inject real token into headers", async () => {
      const req = new Request("https://proxy.dev/cloudflare", {
        headers: { Authorization: "Bearer proxy-token" },
      });

      const result = await cloudflare.transform(req, mockCtx as any);

      if (result instanceof Response) {
        throw new Error("Expected Request, got Response");
      }

      expect(result.headers.get("authorization")).toBe("Bearer real-token-123");
    });

    it("should throw if CLOUDFLARE_API_TOKEN is not configured", async () => {
      const req = new Request("https://proxy.dev/cloudflare");
      const emptyCtx = { env: {} };

      await expect(cloudflare.transform(req, emptyCtx as any)).rejects.toThrow(
        "CLOUDFLARE_API_TOKEN not configured on engine",
      );
    });
  });
});
