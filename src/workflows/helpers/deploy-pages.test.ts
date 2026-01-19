import { describe, it, expect, vi, beforeEach } from "vitest";
import { deployPages } from "./deploy-pages";

describe("Deploy Pages Helper", () => {
  let mockSandbox: any;

  beforeEach(() => {
    mockSandbox = {
      exec: vi.fn(),
    };
  });

  it("should return error if directory does not exist", async () => {
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "No such file or directory",
    });

    const result = await deployPages({
      sandbox: mockSandbox,
      sessionId: "test-session",
      directory: "dist",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
    expect(result.projectName).toBe("sandbox-user123-default-test-session");
  });

  it("should return error if directory is empty", async () => {
    // Directory exists
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "exists\n",
      stderr: "",
    });
    // But is empty
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const result = await deployPages({
      sandbox: mockSandbox,
      sessionId: "test-session",
      directory: "dist",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory is empty");
  });

  it("should construct correct project name with user prefix", async () => {
    // Directory exists
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "exists\n",
      stderr: "",
    });
    // Has files
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "index.html\n",
      stderr: "",
    });
    // Deploy succeeds
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Deploying to https://sandbox-user123-my-project.pages.dev\n",
      stderr: "",
    });

    const result = await deployPages({
      sandbox: mockSandbox,
      sessionId: "test-session",
      directory: "dist",
      projectName: "my-project",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    expect(result.success).toBe(true);
    expect(result.projectName).toBe("sandbox-user123-my-project");
  });

  it("should use default project name when not provided", async () => {
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "exists\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "index.html\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "https://sandbox-user123-default-abc123.pages.dev\n",
      stderr: "",
    });

    const result = await deployPages({
      sandbox: mockSandbox,
      sessionId: "abc123",
      directory: "build",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    expect(result.projectName).toBe("sandbox-user123-default-abc123");
  });

  it("should parse URL from wrangler output", async () => {
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "exists\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "index.html\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Published to https://abc123.sandbox-user123-test.pages.dev\n",
      stderr: "",
    });

    const result = await deployPages({
      sandbox: mockSandbox,
      sessionId: "session1",
      directory: "dist",
      projectName: "test",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://abc123.sandbox-user123-test.pages.dev");
  });

  it("should use branch parameter", async () => {
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "exists\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "index.html\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Success\n",
      stderr: "",
    });

    await deployPages({
      sandbox: mockSandbox,
      sessionId: "session1",
      directory: "dist",
      branch: "preview",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    // Check the deploy command was called with the branch
    const deployCall = mockSandbox.exec.mock.calls[2][0];
    expect(deployCall).toContain("--branch=preview");
  });

  it("should handle wrangler deployment errors", async () => {
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "exists\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "index.html\n",
      stderr: "",
    });
    mockSandbox.exec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "Error: authentication failed",
    });

    const result = await deployPages({
      sandbox: mockSandbox,
      sessionId: "session1",
      directory: "dist",
      userId: "user123",
      accountId: "acc123",
      apiToken: "token123",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("authentication failed");
  });
});
