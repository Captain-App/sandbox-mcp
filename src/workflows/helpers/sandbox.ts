// src/workflows/helpers/sandbox.ts
import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";
import * as Sentry from "@sentry/cloudflare";
import { UserError } from "@shipbox/shared";
import { StorageKeys } from "../../storage/keys";

import { configureAnthropic, configureGithub, toContainerUrl } from "../../proxy";
import { restoreSession } from "./backup";
import type { WorkflowDeps } from "./types";

/**
 * Parameters for ensuring sandbox is ready for use.
 */
interface SandboxReadyParams {
  sandbox: Sandbox<unknown>;
  sessionId: string;
  bucket: R2Bucket;
  proxyBaseUrl: string;
  proxyToken: string;
  userId?: string;
  repository?: {
    url: string;
    branch?: string;
  };
}

/**
 * Result of ensuring sandbox is ready.
 */
interface SandboxReadyResult {
  /** Working directory path ("/workspace" or "/workspace/{repo}") */
  workspacePath: string;
  /** Whether OpenCode state was restored from backup */
  restoredBackup: boolean;
  /** Whether repository was cloned */
  clonedRepo: boolean;
  /** Whether proxy was configured */
  configuredProxy: boolean;
}

/**
 * Utility to execute a command, log it to R2, and return the result.
 */
async function loggedExec(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket,
  sessionId: string,
  command: string,
  context: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const startTime = Date.now();
  const result = await sandbox.exec(command);
  const durationMs = Date.now() - startTime;

  // Generate a simple hash of the command for the key
  const commandHash = await crypto.subtle
    .digest("SHA-1", new TextEncoder().encode(command))
    .then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 8),
    );

  const logEntry = {
    timestamp: new Date().toISOString(),
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
    context,
  };

  try {
    const key = StorageKeys.commandLog(sessionId, startTime, commandHash);
    await bucket.put(key, JSON.stringify(logEntry), {
      customMetadata: {
        type: "command-log",
        context,
        exitCode: result.exitCode.toString(),
      },
    });
  } catch (error) {
    // Don't fail the execution if logging fails
    console.error(`Failed to write command log to R2: ${error}`);
  }

  return result;
}

/**
 * Utility to execute a command and throw a descriptive error if it fails.
 */
async function execOrThrow(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket,
  sessionId: string,
  command: string,
  context: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await loggedExec(sandbox, bucket, sessionId, command, context);
  if (result.exitCode !== 0) {
    const errorMsg = `${context} failed (exit code ${result.exitCode}): ${result.stderr || result.stdout || "No output"}`;
    throw new Error(errorMsg.slice(0, 1000)); // Truncate to avoid huge errors
  }
  return result;
}

/**
 * Ensure sandbox is ready for use - idempotent initialization.
 *
 * This is the main entry point for sandbox initialization. It checks the
 * current state and only performs actions that are needed:
 *
 * 1. Configures proxy if environment is not set up (MUST be first for git auth)
 * 2. Restores OpenCode backup if storage directory is missing
 * 3. Clones repository if .git directory is missing
 *
 * Safe to call multiple times - each step checks before acting.
 * Used by both workflow (execute-task.ts) and web UI (index.ts).
 */
export async function ensureSandboxReady(params: SandboxReadyParams): Promise<SandboxReadyResult> {
  const { sandbox, sessionId, bucket, proxyBaseUrl, proxyToken, repository } = params;

  const result: SandboxReadyResult = {
    workspacePath: "/workspace",
    restoredBackup: false,
    clonedRepo: false,
    configuredProxy: false,
  };

  // 1. Check & configure proxy FIRST (required for git clone to authenticate)
  // Check if ANTHROPIC_BASE_URL is set in the environment
  const proxyCheck = await loggedExec(
    sandbox,
    bucket,
    sessionId,
    "grep -q ANTHROPIC_BASE_URL /workspace/.env 2>/dev/null && echo exists || echo missing",
    "Proxy config check",
  );
  if (proxyCheck.stdout.trim() === "missing") {
    Sentry.addBreadcrumb({
      category: "sandbox",
      message: "Configuring proxy",
      level: "info",
    });
    await configureSandboxProxy(sandbox, bucket, sessionId, proxyBaseUrl, proxyToken);
    await setupGitConfig(sandbox, bucket, sessionId);
    result.configuredProxy = true;
  }

  // 2. Check & restore OpenCode backup
  const storageCheck = await loggedExec(
    sandbox,
    bucket,
    sessionId,
    "test -d ~/.local/share/opencode/storage && echo exists || echo missing",
    "OpenCode storage check",
  );
  if (storageCheck.stdout.trim() === "missing") {
    Sentry.addBreadcrumb({
      category: "sandbox",
      message: "Restoring OpenCode backup",
      level: "info",
    });
    try {
      const restored = await restoreSession(sandbox, sessionId, bucket);
      result.restoredBackup = restored;
    } catch (error) {
      Sentry.captureException(error, {
        extra: { sessionId, phase: "restore-session" },
      });
      // Don't throw here, allow session to continue without backup if needed
      // but log it for investigation
    }
  }

  // 3. Check & clone repository (now proxy is configured for git auth)
  if (repository) {
    const repoName = getRepoName(repository.url);
    const targetDir = `/workspace/${repoName}`;

    const repoCheck = await loggedExec(
      sandbox,
      bucket,
      sessionId,
      `test -d ${targetDir}/.git && echo exists || echo missing`,
      "Repo check",
    );
    if (repoCheck.stdout.trim() === "missing") {
      Sentry.addBreadcrumb({
        category: "sandbox",
        message: "Cloning repository",
        level: "info",
        data: { url: repository.url },
      });
      await cloneRepository(sandbox, bucket, sessionId, repository.url, repository.branch);
      result.clonedRepo = true;
    }

    result.workspacePath = targetDir;
  }

  return result;
}

/**
 * Get a sandbox instance from the binding.
 * IMPORTANT: Must be called fresh in each workflow step - DO stubs are NOT serializable.
 * Uses a safe binding wrapper to avoid "Illegal invocation" errors with OTel Proxies.
 */
export function getSandbox(deps: WorkflowDeps, sandboxId: string): Sandbox<unknown> {
  const binding = deps.sandboxBinding;
  return cfGetSandbox(
    {
      get: binding.get.bind(binding),
      idFromName: binding.idFromName.bind(binding),
      idFromString: binding.idFromString.bind(binding),
      newUniqueId: binding.newUniqueId.bind(binding),
    } as any,
    sandboxId,
    {
      normalizeId: true,
    },
  );
}

/**
 * Configure sandbox to use proxy for all external services.
 *
 * This sets up:
 * - Anthropic SDK to use proxy (via environment variables)
 * - Git to use proxy for github.com operations (via URL rewriting)
 *
 * After calling this, the sandbox can make authenticated API calls
 * without having access to real credentials.
 */
async function configureSandboxProxy(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket,
  sessionId: string,
  proxyBaseUrl: string,
  proxyToken: string,
): Promise<void> {
  const containerProxyUrl = toContainerUrl(proxyBaseUrl);

  await configureAnthropic(sandbox, containerProxyUrl, proxyToken);
  await configureGithub(sandbox, containerProxyUrl, proxyToken);

  // Log what was actually written to .env using logged command
  await loggedExec(sandbox, bucket, sessionId, "cat /workspace/.env", "Env file contents");

  // Test connectivity to the proxy URL
  await loggedExec(
    sandbox,
    bucket,
    sessionId,
    `curl -s -o /dev/null -w '%{http_code}' ${containerProxyUrl}/health`,
    "Proxy connectivity test",
  );
}

/**
 * Set up basic git configuration (user info for commits).
 * Authentication is handled by the proxy via configureGithub().
 */
async function setupGitConfig(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket,
  sessionId: string,
): Promise<void> {
  await execOrThrow(
    sandbox,
    bucket,
    sessionId,
    `git config --global user.email "opencode@sandbox.workers.dev"`,
    "Git email config",
  );
  await execOrThrow(
    sandbox,
    bucket,
    sessionId,
    `git config --global user.name "OpenCode Bot"`,
    "Git name config",
  );
}

/**
 * Extract repository name from URL for use as subdirectory.
 * e.g., "https://github.com/owner/repo" -> "repo"
 *       "https://github.com/owner/repo.git" -> "repo"
 */
function getRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : "repo";
}

/**
 * Clone a git repository into /workspace/{repo-name}
 */
async function cloneRepository(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket,
  sessionId: string,
  url: string,
  branch?: string,
): Promise<string> {
  const repoName = getRepoName(url);
  const targetDir = `/workspace/${repoName}`;

  // Check if already cloned
  const checkResult = await loggedExec(
    sandbox,
    bucket,
    sessionId,
    `test -d ${targetDir}/.git && echo exists || echo missing`,
    "Repo existence check",
  );

  if (checkResult.stdout.trim() === "exists") {
    // Already cloned, just fetch latest
    await execOrThrow(
      sandbox,
      bucket,
      sessionId,
      `cd ${targetDir} && git fetch origin`,
      "Git fetch",
    );
    if (branch) {
      await execOrThrow(
        sandbox,
        bucket,
        sessionId,
        `cd ${targetDir} && git checkout ${branch}`,
        "Git checkout",
      );
    }
    return targetDir;
  }

  // Clone the repository
  try {
    await sandbox.gitCheckout(url, {
      branch: branch ?? "main",
      targetDir,
    });
  } catch (error) {
    // Collect last few lines of git output if possible
    const lastOutput = await loggedExec(
      sandbox,
      bucket,
      sessionId,
      `tail -n 20 /tmp/git-checkout.log 2>/dev/null || echo "No log"`,
      "Git checkout log collection",
    );
    const output = lastOutput.stdout;

    // Classify authentication/permission failures as UserError
    if (
      output.includes("Authentication failed") ||
      output.includes("Permission denied") ||
      output.includes("could not read Username") ||
      output.includes("terminal prompts disabled")
    ) {
      throw new UserError({
        message: `Git checkout failed for ${url}: Authentication failed. Ensure the repository exists and you have access.`,
        category: "user:auth",
      });
    }

    throw new Error(`Git checkout failed for ${url}: ${error} ${output}`);
  }

  return targetDir;
}
