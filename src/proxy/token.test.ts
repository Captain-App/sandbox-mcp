import { describe, it, expect } from "vitest";
import { Effect, Exit } from "effect";
import { createProxyToken, verifyProxyTokenAsync } from "./token";

describe("Proxy Token", () => {
  const SECRET = "test-secret-at-least-32-chars-long-!!!";
  const sandboxId = "sb-123";
  const userId = "user-456";
  const sessionId = "sess-789";

  it("should create and verify a valid token", async () => {
    const tokenEffect = createProxyToken({
      secret: SECRET,
      sandboxId,
      userId,
      sessionId,
      expiresIn: "1h",
    });

    const token = await Effect.runPromise(tokenEffect);
    expect(typeof token).toBe("string");

    const payload = await verifyProxyTokenAsync({ secret: SECRET, token });

    expect(payload.sandboxId).toBe(sandboxId);
    expect(payload.userId).toBe(userId);
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("should fail for invalid secret", async () => {
    const token = await Effect.runPromise(
      createProxyToken({
        secret: SECRET,
        sandboxId,
        userId,
      }),
    );

    await expect(verifyProxyTokenAsync({ secret: "wrong-secret", token })).rejects.toThrow();
  });

  it("should fail for expired token", async () => {
    // We can't easily "wait" for expiration, but we can check if it fails
    // when expiresIn is 0 (if supported) or just trust jose library.
    // Let's try creating a token that expires in 0s.
    const token = await Effect.runPromise(
      createProxyToken({
        secret: SECRET,
        sandboxId,
        userId,
        expiresIn: "0",
      }),
    );

    // Wait 1s just to be sure
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(verifyProxyTokenAsync({ secret: SECRET, token })).rejects.toThrow(); // Trust jose to throw on expiry, exact message varies
  });

  it("should fail for malformed token", async () => {
    await expect(verifyProxyTokenAsync({ secret: SECRET, token: "not-a-jwt" })).rejects.toThrow();
  });

  it("should require all mandatory fields", async () => {
    // Test creation validation
    const result = await Effect.runPromiseExit(
      createProxyToken({
        secret: "", // empty secret
        sandboxId,
        userId,
      } as any),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });
});
