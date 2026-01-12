import { describe, it, expect, vi, beforeEach } from "vitest";
import { anthropic } from "./anthropic";

describe("Anthropic Proxy Service", () => {
  const mockEnv = {
    ANTHROPIC_API_KEY: "platform-key",
    SHIPBOX_API: {
      fetch: vi.fn(),
    },
  };

  const mockCtx = {
    jwt: { userId: "user-123", sessionId: "sess-456" },
    env: mockEnv,
    service: "anthropic",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate and extract the x-api-key header", () => {
    const request = new Request("https://api.anthropic.com/v1/messages", {
      headers: { "x-api-key": "test-token" },
    });
    const token = anthropic.validate(request);
    expect(token).toBe("test-token");
  });

  it("should return null if x-api-key header is missing", () => {
    const request = new Request("https://api.anthropic.com/v1/messages");
    const token = anthropic.validate(request);
    expect(token).toBeNull();
  });

  it("should use platform key when user key is not available", async () => {
    mockEnv.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ anthropicKey: null }), { status: 200 }),
    );

    const request = new Request("https://api.anthropic.com/v1/messages");
    const result = await anthropic.transform(request, mockCtx as any);

    expect(result).toBeInstanceOf(Request);
    const transformedRequest = result as Request;
    expect(transformedRequest.headers.get("x-api-key")).toBe("platform-key");
    expect(mockEnv.SHIPBOX_API.fetch).toHaveBeenCalledWith(
      "http://api/internal/user-config/user-123",
    );
  });

  it("should use user key when available", async () => {
    mockEnv.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ anthropicKey: "user-key" }), { status: 200 }),
    );

    const request = new Request("https://api.anthropic.com/v1/messages");
    const result = await anthropic.transform(request, mockCtx as any);

    expect(result).toBeInstanceOf(Request);
    const transformedRequest = result as Request;
    expect(transformedRequest.headers.get("x-api-key")).toBe("user-key");
  });

  it("should return 500 if no API key is available", async () => {
    const envNoKey = { ...mockEnv, ANTHROPIC_API_KEY: undefined };
    envNoKey.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ anthropicKey: null }), { status: 200 }),
    );

    const request = new Request("https://api.anthropic.com/v1/messages");
    const result = await anthropic.transform(request, { ...mockCtx, env: envNoKey } as any);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Anthropic API key not found");
  });
});
