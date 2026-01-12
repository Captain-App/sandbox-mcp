import { describe, it, expect, vi, beforeEach } from "vitest";
import { github } from "./github";

describe("GitHub Proxy Service", () => {
  const mockEnv = {
    GITHUB_TOKEN: "platform-token",
    SHIPBOX_API: {
      fetch: vi.fn(),
    },
  };

  const mockCtx = {
    jwt: { userId: "user-123", sessionId: "sess-456" },
    env: mockEnv,
    service: "github",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate and extract the Bearer token", () => {
    const request = new Request("https://github.com/owner/repo/info/refs", {
      headers: { Authorization: "Bearer test-token" },
    });
    const token = github.validate(request);
    expect(token).toBe("test-token");
  });

  it("should return null if Authorization header is missing", () => {
    const request = new Request("https://github.com/owner/repo/info/refs");
    const token = github.validate(request);
    expect(token).toBeNull();
  });

  it("should allow valid git paths", async () => {
    mockEnv.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ githubToken: null }), { status: 200 }),
    );

    const request = new Request("https://github.com/owner/repo/info/refs?service=git-upload-pack");
    const result = await github.transform(request, mockCtx as any);

    expect(result).toBeInstanceOf(Request);
    const transformedRequest = result as Request;
    expect(transformedRequest.headers.get("Authorization")).toContain("Basic ");
    expect(transformedRequest.headers.get("User-Agent")).toBe("Sandbox-Git-Proxy");
  });

  it("should reject invalid git paths", async () => {
    mockEnv.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ githubToken: null }), { status: 200 }),
    );

    const request = new Request("https://github.com/owner/repo/settings");
    const result = await github.transform(request, mockCtx as any);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid git path");
  });

  it("should use user installation token when available", async () => {
    mockEnv.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ githubToken: "user-inst-token" }), {
        status: 200,
      }),
    );

    const request = new Request("https://github.com/owner/repo/info/refs");
    const result = await github.transform(request, mockCtx as any);

    expect(result).toBeInstanceOf(Request);
    const transformedRequest = result as Request;
    // Basic auth: btoa('x-access-token:user-inst-token')
    const expected = btoa("x-access-token:user-inst-token");
    expect(transformedRequest.headers.get("Authorization")).toBe(`Basic ${expected}`);
  });

  it("should return 500 if no GITHUB_TOKEN is available", async () => {
    const envNoToken = { ...mockEnv, GITHUB_TOKEN: undefined };
    envNoToken.SHIPBOX_API.fetch.mockResolvedValue(
      new Response(JSON.stringify({ githubToken: null }), { status: 200 }),
    );

    const request = new Request("https://github.com/owner/repo/info/refs");
    const result = await github.transform(request, {
      ...mockCtx,
      env: envNoToken,
    } as any);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("GITHUB_TOKEN not configured");
  });
});
