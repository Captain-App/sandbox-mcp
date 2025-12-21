import { describe, it, expect } from "vitest";
import { SessionNotFoundError, SandboxStartupError, isSessionError } from "./errors";

describe("Error Models", () => {
	it("should create SessionNotFoundError with correct message", () => {
		const error = new SessionNotFoundError({ sessionId: "test-123" });

		expect(error._tag).toBe("SessionNotFoundError");
		expect(error.sessionId).toBe("test-123");
		expect(error.message).toContain("test-123");
	});

	it("should identify session errors with type guard", () => {
		const error = new SessionNotFoundError({ sessionId: "test" });

		expect(isSessionError(error)).toBe(true);
		expect(isSessionError(new Error("random"))).toBe(false);
	});

	it("should create SandboxStartupError with cause", () => {
		const cause = new Error("Connection refused");
		const error = new SandboxStartupError({
			sandboxId: "sandbox-1",
			cause: cause.message,
		});

		expect(error._tag).toBe("SandboxStartupError");
		expect(error.sandboxId).toBe("sandbox-1");
	});
});
