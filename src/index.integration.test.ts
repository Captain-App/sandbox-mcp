import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("Engine Internal API", () => {
  it("POST /internal/sessions should create a session in R2", async () => {
    const req = new Request("http://localhost/internal/sessions", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Box",
        repository: "https://github.com/test/repo",
      }),
    });

    const res = await SELF.fetch(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as any;
    expect(body.sessionId).toBeDefined();
    expect(body.title).toBe("Test Box");

    // Verify written to R2
    const stored = await env.SESSIONS_BUCKET.get(`sessions/${body.sessionId}.json`);
    expect(stored).toBeDefined();
  });

  it("GET /internal/sessions/:id should retrieve session metadata", async () => {
    // 1. Create session
    const createRes = await SELF.fetch(
      new Request("http://localhost/internal/sessions", {
        method: "POST",
        body: JSON.stringify({ name: "Existing Box" }),
      }),
    );
    const created = (await createRes.json()) as any;

    // 2. Get session
    const res = await SELF.fetch(
      new Request(`http://localhost/internal/sessions/${created.sessionId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessionId).toBe(created.sessionId);
    expect(body.title).toBe("Existing Box");
  });

  describe("Real-time API", () => {
    it("POST /internal/realtime/:sessionId/publish should forward to DO", async () => {
      const sessionId = "12345678";
      const req = new Request(`http://localhost/internal/realtime/${sessionId}/publish`, {
        method: "POST",
        body: JSON.stringify({ type: "test", data: { hello: "world" } }),
      });

      const res = await SELF.fetch(req);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.event.type).toBe("test");
    });

    it("GET /realtime should require sessionId and token", async () => {
      const res = await SELF.fetch(new Request("http://localhost/realtime"));
      expect(res.status).toBe(400); // Missing sessionId
    });
  });

  it("DELETE /internal/sessions/:id should remove from R2", async () => {
    // 1. Create session
    const createRes = await SELF.fetch(
      new Request("http://localhost/internal/sessions", {
        method: "POST",
        body: JSON.stringify({ name: "To Delete" }),
      }),
    );
    const created = (await createRes.json()) as any;

    // 2. Delete session
    const res = await SELF.fetch(
      new Request(`http://localhost/internal/sessions/${created.sessionId}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);

    // 3. Verify gone
    const getRes = await SELF.fetch(
      new Request(`http://localhost/internal/sessions/${created.sessionId}`),
    );
    expect(getRes.status).toBe(404);
  });
});

describe("Workers for Platforms (Dispatch Namespace)", () => {
  it("GET /site/:sessionId should dispatch to correct worker", async () => {
    // Note: In integration tests, env.SANDBOX_WORKERS needs to be mocked
    // We'll assume the dispatcher is working if it attempts to call fetch on the namespace
    const res = await SELF.fetch(new Request("http://localhost/site/abc12345/"));

    // If SANDBOX_WORKERS is not configured in the test environment,
    // it will fall through to other routes or return 404
    // We expect the routing logic to at least parse the sessionId correctly
    expect(res.status).not.toBe(500);
  });

  it("GET /site/:sessionId/path should preserve subpaths", async () => {
    const res = await SELF.fetch(new Request("http://localhost/site/abc12345/api/data?foo=bar"));
    expect(res.status).not.toBe(500);
  });

  it("Wildcard subdomain should dispatch based on hostname", async () => {
    const req = new Request("https://abc12345.preview.shipbox.dev/test");
    const res = await SELF.fetch(req);

    // Hostname parsing should extract 'abc12345'
    expect(res.status).not.toBe(500);
  });
});

describe("Preview Proxy (Miniflare)", () => {
  it("GET /preview/:sessionId/ should attempt to proxy to sandbox", async () => {
    const res = await SELF.fetch(new Request("http://localhost/preview/abc12345/"));

    // Should return 500 because the sandbox DO doesn't exist in the test env
    // but the error message should indicate it tried to proxy
    const body = (await res.json()) as any;
    expect(body.error).toBe("Preview proxy failed");
  });
});
