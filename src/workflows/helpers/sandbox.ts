// src/workflows/helpers/sandbox.ts
import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";

import { configureAnthropic, configureGithub, configureR2 } from "../../proxy";
import type { WorkflowDeps } from "./types";

/**
 * Get a sandbox instance from the binding.
 * IMPORTANT: Must be called fresh in each workflow step - DO stubs are NOT serializable.
 */
export function getSandbox(deps: WorkflowDeps, sandboxId: string): Sandbox<unknown> {
  return cfGetSandbox(deps.sandboxBinding, sandboxId, {
    normalizeId: true,
  });
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
export async function configureSandboxProxy(
  sandbox: Sandbox<unknown>,
  proxyBaseUrl: string,
  proxyToken: string,
): Promise<void> {
  await configureAnthropic(sandbox, proxyBaseUrl, proxyToken);
  await configureGithub(sandbox, proxyBaseUrl, proxyToken);
}

/**
 * Mount R2 storage via proxy (credentials never enter sandbox).
 *
 * Uses s3fs with the proxy as the S3 endpoint. The JWT token is used
 * as the access key ID, which the proxy extracts and validates.
 */
export async function mountR2Storage(
  sandbox: Sandbox<unknown>,
  sessionId: string,
  proxyBaseUrl: string,
  proxyToken: string,
): Promise<void> {
  const bucket = "opencode-sessions";
  const mountPath = "/workspace";

  await configureR2(sandbox, proxyBaseUrl, proxyToken, `${bucket}/${sessionId}`, mountPath);
}

/**
 * Set up basic git configuration (user info for commits).
 * Authentication is handled by the proxy via configureGithub().
 */
export async function setupGitConfig(sandbox: Sandbox<unknown>): Promise<void> {
  // Set git user info for commits
  await sandbox.exec(`git config --global user.email "opencode@sandbox.workers.dev"`);
  await sandbox.exec(`git config --global user.name "OpenCode Bot"`);
}

/**
 * Clone a git repository into /workspace
 */
export async function cloneRepository(
  sandbox: Sandbox<unknown>,
  url: string,
  branch?: string,
): Promise<void> {
  // Check if already cloned
  const checkResult = await sandbox.exec("test -d /workspace/.git && echo exists || echo missing");

  if (checkResult.stdout.trim() === "exists") {
    // Already cloned, just fetch latest
    await sandbox.exec("cd /workspace && git fetch origin");
    if (branch) {
      await sandbox.exec(`cd /workspace && git checkout ${branch}`);
    }
    return;
  }

  // Clone the repository
  await sandbox.gitCheckout(url, {
    branch: branch ?? "main",
    targetDir: "/workspace",
  });
}
