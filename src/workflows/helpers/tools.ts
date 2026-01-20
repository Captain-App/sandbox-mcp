/**
 * Custom tools injection for OpenCode agent.
 *
 * This module creates tool files that are injected into the sandbox during
 * initialization. These tools allow the OpenCode agent to perform privileged
 * operations (like deployment) by calling back to our proxy endpoints.
 *
 * Tools are defined using the @opencode-ai/plugin format.
 */

import type { Sandbox } from "@cloudflare/sandbox";

/**
 * Get the deploy_pages tool source code.
 *
 * This tool deploys a directory to Cloudflare Pages via our proxy endpoint.
 * Uses the @opencode-ai/plugin tool() helper for proper registration.
 */
export function getDeployPagesTool(proxyUrl: string, proxyToken: string): string {
  return `// deploy_pages - Deploy static sites to Cloudflare Pages
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Deploy a static site directory to Cloudflare Pages. Build your site first (e.g., npm run build), then deploy the output directory.",
  args: {
    directory: tool.schema.string().describe("Path to the directory containing built static files (e.g., 'dist', 'build', 'out')"),
    projectName: tool.schema.string().optional().describe("Project name slug (lowercase, alphanumeric, hyphens only). Defaults to a unique name for this sandbox."),
    branch: tool.schema.string().optional().describe("Branch name for the deployment (defaults to 'main' for production)"),
  },
  async execute(args) {
    const { directory, projectName, branch } = args;

    // Call the Shipbox deploy proxy
    const response = await fetch("${proxyUrl}/proxy/deploy/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer ${proxyToken}",
      },
      body: JSON.stringify({
        directory,
        projectName,
        branch: branch || "main",
      }),
    });

    const result = await response.json();

    if (!result.success) {
      return \`Deployment failed: \${result.error}\`;
    }

    return \`Successfully deployed to Cloudflare Pages!

**Project:** \${result.projectName}
**URL:** \${result.url}

Your site is now live at the URL above.\`;
  },
});
`;
}

/**
 * Get the deploy_worker tool source code.
 *
 * This tool deploys a Worker to Cloudflare Workers for Platforms via our proxy.
 * Uses the @opencode-ai/plugin tool() helper for proper registration.
 */
export function getDeployWorkerTool(proxyUrl: string, proxyToken: string): string {
  return `// deploy_worker - Deploy a Worker to Cloudflare
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Deploy a Cloudflare Worker from your source code. The worker will be bundled and deployed to Workers for Platforms.",
  args: {
    entryPoint: tool.schema.string().describe("Path to the worker entry file (e.g., 'src/index.ts', 'worker.js')"),
    name: tool.schema.string().optional().describe("Worker name (lowercase, alphanumeric, hyphens). Defaults to sandbox-specific name."),
  },
  async execute(args) {
    const { entryPoint, name } = args;

    // Call the Shipbox deploy proxy
    const response = await fetch("${proxyUrl}/proxy/deploy/worker", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer ${proxyToken}",
      },
      body: JSON.stringify({
        entryPoint,
        name,
      }),
    });

    const result = await response.json();

    if (!result.success) {
      return \`Deployment failed: \${result.error}\`;
    }

    return \`Successfully deployed Worker!

**Worker Name:** \${result.projectName}
**URL:** \${result.url}

Your worker is now live at the URL above.\`;
  },
});
`;
}

/**
 * Encode string to base64 for safe shell transmission.
 */
function toBase64(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64");
}

/**
 * Inject custom tools into the sandbox's .opencode/tools directory.
 *
 * This should be called during sandbox initialization, after the proxy
 * is configured but before OpenCode is started.
 *
 * Uses base64 encoding to safely transmit file contents without shell escaping issues.
 */
export async function injectCustomTools(
  sandbox: Sandbox<unknown>,
  proxyUrl: string,
  proxyToken: string,
): Promise<void> {
  // Create the tools directory
  await sandbox.exec("mkdir -p /workspace/.opencode/tools");

  // Write deploy_pages tool using base64 to avoid shell escaping issues
  const deployPagesContent = getDeployPagesTool(proxyUrl, proxyToken);
  const deployPagesBase64 = toBase64(deployPagesContent);
  const pagesResult = await sandbox.exec(
    `echo "${deployPagesBase64}" | base64 -d > /workspace/.opencode/tools/deploy_pages.js`,
  );
  if (pagesResult.exitCode !== 0) {
    console.error(`[Tools] Failed to write deploy_pages.js: ${pagesResult.stderr}`);
  }

  // Write deploy_worker tool using base64
  const deployWorkerContent = getDeployWorkerTool(proxyUrl, proxyToken);
  const deployWorkerBase64 = toBase64(deployWorkerContent);
  const workerResult = await sandbox.exec(
    `echo "${deployWorkerBase64}" | base64 -d > /workspace/.opencode/tools/deploy_worker.js`,
  );
  if (workerResult.exitCode !== 0) {
    console.error(`[Tools] Failed to write deploy_worker.js: ${workerResult.stderr}`);
  }

  // Verify tools were created
  const checkResult = await sandbox.exec("ls -la /workspace/.opencode/tools/");
  console.log(`[Tools] Injected custom tools: ${checkResult.stdout}`);
}
