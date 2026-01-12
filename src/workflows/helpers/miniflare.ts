import { type Sandbox } from "@cloudflare/sandbox";

/**
 * Start Miniflare inside the sandbox to preview a worker.
 *
 * Runs miniflare in the background, listening on all interfaces (0.0.0.0)
 * so it can be accessed by the engine's proxy.
 *
 * Uses `wrangler dev` which is the preferred way to run miniflare for a worker
 * project with a wrangler.toml file.
 *
 * @param sandbox - The sandbox instance
 * @param workerPath - Path to the worker entry file (used to determine work directory)
 * @param port - Port to listen on (default 8787)
 * @returns Object with the preview URL and log path
 */
export async function startMiniflare(
  sandbox: Sandbox<unknown>,
  workerPath: string,
  port: number = 8787,
): Promise<{
  success: boolean;
  port: number;
  logPath: string;
  error?: string;
}> {
  // Extract work directory - go up from src/index.ts to the project root
  // e.g., /workspace/my-worker/src/index.ts -> /workspace/my-worker
  let workDir: string;
  if (workerPath.includes("/src/")) {
    // Go up to project root (parent of src/)
    workDir = workerPath.substring(0, workerPath.indexOf("/src/"));
  } else {
    // Fallback to parent directory
    const dirMatch = workerPath.match(/(.*)\/[^/]+$/);
    workDir = dirMatch ? dirMatch[1] : "/workspace";
  }

  // Check if miniflare/wrangler is already running on this port and kill it if so
  await sandbox.exec(`pkill -f "wrangler.*dev.*--port ${port}" || true`);
  await sandbox.exec(`pkill -f "miniflare.*--port ${port}" || true`);

  // Start wrangler dev in the background (this uses miniflare under the hood)
  // We use --local to run locally without requiring Cloudflare auth
  // We use --ip 0.0.0.0 so it's accessible from the engine
  const logPath = `/tmp/miniflare-${port}.log`;
  const command = `cd ${workDir} && nohup npx wrangler dev --local --ip 0.0.0.0 --port ${port} > ${logPath} 2>&1 &`;

  console.log(`[miniflare] Starting with command: ${command}`);
  const result = await sandbox.exec(command);

  if (result.exitCode !== 0) {
    return {
      success: false,
      port,
      logPath,
      error: `Failed to start wrangler dev: ${result.stderr}`,
    };
  }

  // Wait a moment for it to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Check if it's actually running
  const check = await sandbox.exec(`ps aux | grep -E "[w]rangler.*dev.*--port ${port}"`);
  const success = check.stdout.includes("wrangler");

  // If not running, try to get error from log
  if (!success) {
    const logResult = await sandbox.exec(`cat ${logPath} 2>/dev/null | tail -20`);
    return {
      success: false,
      port,
      logPath,
      error: `Wrangler dev failed to start. Log: ${logResult.stdout || "(empty)"}`,
    };
  }

  // Give it a bit more time to fully initialize
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return {
    success,
    port,
    logPath,
  };
}

/**
 * Stop Miniflare/Wrangler dev for a specific port.
 */
export async function stopMiniflare(
  sandbox: Sandbox<unknown>,
  port: number = 8787,
): Promise<boolean> {
  // Kill both wrangler dev and miniflare processes
  await sandbox.exec(`pkill -f "wrangler.*dev.*--port ${port}" || true`);
  const result = await sandbox.exec(`pkill -f "miniflare.*--port ${port}" || true`);
  return result.exitCode === 0;
}
