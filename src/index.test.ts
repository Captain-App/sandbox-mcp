import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @cloudflare/sandbox before importing index
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
  Sandbox: class {},
}));

vi.mock("@cloudflare/sandbox/opencode", () => ({
  createOpencodeServer: vi.fn(),
}));

// Mock agents which might use cloudflare: schemes
vi.mock("agents", () => ({
  Agent: class {},
}));

import worker from "./index";
import { createMockR2Bucket } from "./test-utils/r2-mock";

describe("Engine Internal API", () => {
  let bucket: any;
  let env: any;

  beforeEach(() => {
    bucket = createMockR2Bucket();
    env = {
      SESSIONS_BUCKET: bucket,
      PROXY_JWT_SECRET: "test-secret",
      Sandbox: {
        get: (id: string) => ({
          id,
          containerFetch: async () => new Response("OK"),
        }),
      },
    };
  });

  it("POST /internal/sessions should create a session in R2", async () => {
    const req = new Request("http://localhost/internal/sessions", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Box",
        repository: "https://github.com/test/repo",
      }),
    });

    const res = await worker.fetch(req, env, {} as any);
    expect(res.status).toBe(201);

    const body = (await res.json()) as any;
    expect(body.sessionId).toBeDefined();
    expect(body.title).toBe("Test Box");

    // Verify written to R2
    const stored = await bucket.get(`sessions/${body.sessionId}.json`);
    expect(stored).toBeDefined();
  });

  it("GET /internal/sessions/:id should retrieve session metadata", async () => {
    // 1. Create session
    const createRes = await worker.fetch(
      new Request("http://localhost/internal/sessions", {
        method: "POST",
        body: JSON.stringify({ name: "Existing Box" }),
      }),
      env,
      {} as any,
    );
    const created = (await createRes.json()) as any;

    // 2. Get session
    const res = await worker.fetch(
      new Request(`http://localhost/internal/sessions/${created.sessionId}`),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessionId).toBe(created.sessionId);
    expect(body.title).toBe("Existing Box");
  });

  it("DELETE /internal/sessions/:id should remove from R2", async () => {
    // 1. Create session
    const createRes = await worker.fetch(
      new Request("http://localhost/internal/sessions", {
        method: "POST",
        body: JSON.stringify({ name: "To Delete" }),
      }),
      env,
      {} as any,
    );
    const created = (await createRes.json()) as any;

    // 2. Delete session
    const res = await worker.fetch(
      new Request(`http://localhost/internal/sessions/${created.sessionId}`, {
        method: "DELETE",
      }),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);

    // 3. Verify gone
    const getRes = await worker.fetch(
      new Request(`http://localhost/internal/sessions/${created.sessionId}`),
      env,
      {} as any,
    );
    expect(getRes.status).toBe(404);
  });
});
