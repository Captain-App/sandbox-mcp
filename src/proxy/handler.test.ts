import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProxyHandler } from "./handler";
import * as Token from "./token";

// Mock verifyProxyTokenAsync
vi.mock("./token", () => ({
  verifyProxyTokenAsync: vi.fn(),
}));

describe("Proxy Handler", () => {
  const SECRET = "test-secret";
  const mockEnv = { PROXY_JWT_SECRET: SECRET, SHIPBOX_API: { fetch: vi.fn() } };

  const mockService = {
    target: "https://api.example.com",
    validate: vi.fn(),
    transform: vi.fn(),
  };

  const config = {
    mountPath: "/proxy",
    jwtSecret: (env: any) => env.PROXY_JWT_SECRET,
    services: {
      example: mockService,
    },
  };

  const handler = createProxyHandler(config);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default fetch mock
    global.fetch = vi.fn().mockResolvedValue(new Response("target response", { status: 200 }));
  });

  it("should successfully proxy a valid request", async () => {
    const token = "valid-token";
    const jwtPayload = {
      userId: "user-1",
      sandboxId: "sb-1",
      exp: 123,
      iat: 123,
    };

    mockService.validate.mockResolvedValue(token);
    vi.mocked(Token.verifyProxyTokenAsync).mockResolvedValue(jwtPayload);
    mockService.transform.mockImplementation(async (req) => req);

    const request = new Request("https://worker.dev/proxy/example/path?query=1", {
      method: "POST",
      body: JSON.stringify({ data: "test" }),
    });

    const response = await handler(request, mockEnv);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("target response");

    expect(mockService.validate).toHaveBeenCalledWith(request);
    expect(Token.verifyProxyTokenAsync).toHaveBeenCalledWith({
      secret: SECRET,
      token,
    });
    expect(mockService.transform).toHaveBeenCalled();

    const forwardCall = vi.mocked(global.fetch).mock.calls[0][0] as Request;
    expect(forwardCall.url).toBe("https://api.example.com/path?query=1");
    expect(forwardCall.method).toBe("POST");
  });

  it("should return 400 for invalid proxy path", async () => {
    const request = new Request("https://worker.dev/invalid/path");
    const response = await handler(request, mockEnv);

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.code).toBe("PROXY_PATH_INVALID");
  });

  it("should return 404 for unknown service", async () => {
    const request = new Request("https://worker.dev/proxy/unknown/path");
    const response = await handler(request, mockEnv);

    expect(response.status).toBe(404);
    const body = (await response.json()) as any;
    expect(body.code).toBe("PROXY_SERVICE_NOT_FOUND");
  });

  it("should return 401 when token is missing", async () => {
    mockService.validate.mockResolvedValue(null);

    const request = new Request("https://worker.dev/proxy/example/path");
    const response = await handler(request, mockEnv);

    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.code).toBe("PROXY_TOKEN_MISSING");
  });

  it("should short-circuit when transform returns a Response", async () => {
    const token = "valid-token";
    mockService.validate.mockResolvedValue(token);
    vi.mocked(Token.verifyProxyTokenAsync).mockResolvedValue({
      userId: "user-1",
      sandboxId: "sb-1",
      exp: 123,
      iat: 123,
    });

    const errorRes = new Response(JSON.stringify({ error: "denied" }), {
      status: 403,
    });
    mockService.transform.mockResolvedValue(errorRes);

    const request = new Request("https://worker.dev/proxy/example/path");
    const response = await handler(request, mockEnv);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "denied" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should handle balance check for Anthropic service", async () => {
    const anthropicService = {
      target: "https://api.anthropic.com",
      validate: vi.fn().mockResolvedValue("token"),
      transform: vi.fn().mockImplementation(async (req) => req),
    };

    const anthropicConfig = {
      ...config,
      services: { anthropic: anthropicService },
    };
    const anthropicHandler = createProxyHandler(anthropicConfig);

    vi.mocked(Token.verifyProxyTokenAsync).mockResolvedValue({
      userId: "user-1",
      sandboxId: "sb-1",
      exp: 123,
      iat: 123,
    });

    // Mock SHIPBOX_API balance check failure
    vi.mocked(mockEnv.SHIPBOX_API.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "No money" }), { status: 402 }),
    );

    const request = new Request("https://worker.dev/proxy/anthropic/v1/messages");
    const response = await anthropicHandler(request, mockEnv);

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "No money" });
    expect(mockEnv.SHIPBOX_API.fetch).toHaveBeenCalledWith(
      "http://api/internal/check-balance/user-1",
    );
  });
});
