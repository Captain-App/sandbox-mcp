// src/workflows/helpers/sandbox.ts
import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";
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
 * Mount R2 storage at /workspace using s3fs
 * Note: Session isolation is provided by the sandbox itself (each session = unique sandboxId)
 */
export async function mountR2Storage(
	sandbox: Sandbox<unknown>,
	sessionId: string,
	r2Config: WorkflowDeps["r2Config"],
): Promise<void> {
	if (!r2Config) {
		return;
	}

	const { accountId, accessKeyId, secretAccessKey } = r2Config;

	// Mount the R2 bucket at /workspace
	// Each sandbox has its own isolated filesystem, so we use sessionId as bucket subdirectory
	// Format: "bucket:/path" mounts that path prefix from the bucket
	await sandbox.mountBucket(`opencode-sessions:/${sessionId}`, "/workspace", {
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId,
			secretAccessKey,
		},
	});
}

/**
 * Set up git credentials for authenticated operations.
 * Uses environment variables instead of writing to disk for security.
 */
export async function setupGitCredentials(
	sandbox: Sandbox<unknown>,
	githubToken?: string,
): Promise<void> {
	if (!githubToken) {
		return;
	}

	// Set environment variables for git operations
	await sandbox.setEnvVars({
		GIT_ASKPASS: "echo",
		GIT_TERMINAL_PROMPT: "0",
		GH_TOKEN: githubToken,
		GITHUB_TOKEN: githubToken,
	});

	// Configure git credential helper using environment variable
	await sandbox.exec(
		`git config --global credential.helper '!f() { echo "password=$GITHUB_TOKEN"; }; f'`,
	);

	// Set git user info for commits
	await sandbox.exec(`git config --global user.email "opencode@sandbox.workers.dev"`);
	await sandbox.exec(`git config --global user.name "OpenCode Bot"`);

	// Check GH CLI auth status (silent)
	await sandbox.exec(`gh auth status 2>/dev/null || true`);
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
