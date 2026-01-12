import { type Sandbox } from "@cloudflare/sandbox";

/**
 * Start Miniflare inside the sandbox to preview a worker.
 *
 * Runs miniflare in the background, listening on all interfaces (0.0.0.0)
 * so it can be accessed by the engine's proxy.
 *
 * @param sandbox - The sandbox instance
 * @param workerPath - Path to the worker entry file
 * @param port - Port to listen on (default 8787)
 * @returns Object with the preview URL and log path
 */
export async function startMiniflare(
  sandbox: Sandbox<unknown>,
  workerPath: string,
  port: number = 8787,
): Promise<{ success: boolean; port: number; logPath: string }> {
  // Ensure the directory exists
  const dirMatch = workerPath.match(/(.*)\/[^/]+$/);
  const workDir = dirMatch ? dirMatch[1] : "/workspace";

  // Check if miniflare is already running on this port and kill it if so
  await sandbox.exec(`pkill -f "miniflare.*--port ${port}" || true`);

  // Start miniflare in the background
  // We use --host 0.0.0.0 so it's accessible from the engine
  const logPath = `/tmp/miniflare-${port}.log`;
  const command = `cd ${workDir} && nohup npx miniflare --host 0.0.0.0 --port ${port} ${workerPath} > ${logPath} 2>&1 &`;

  const result = await sandbox.exec(command);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start miniflare: ${result.stderr}`);
  }

  // Wait a moment for it to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check if it's actually running
  const check = await sandbox.exec(`ps aux | grep "[m]iniflare.*--port ${port}"`);
  const success = check.stdout.includes("miniflare");

  return {
    success,
    port,
    logPath,
  };
}

/**
 * Stop Miniflare for a specific port.
 */
export async function stopMiniflare(
  sandbox: Sandbox<unknown>,
  port: number = 8787,
): Promise<boolean> {
  const result = await sandbox.exec(`pkill -f "miniflare.*--port ${port}" || true`);
  return result.exitCode === 0;
}
