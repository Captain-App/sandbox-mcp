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
