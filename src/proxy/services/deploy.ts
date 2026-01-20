/**
 * Deployment proxy service.
 *
 * This service handles deployment requests from custom tools inside sandboxes.
 * Instead of forwarding to an external API, it executes deployments server-side
 * using sandbox.exec() with injected credentials.
 *
 * Endpoints:
 * - POST /proxy/deploy/pages - Deploy to Cloudflare Pages
 * - POST /proxy/deploy/worker - Deploy to Workers for Platforms
 *
 * The JWT token in the request identifies the sandbox making the request.
 * Credentials (CLOUDFLARE_API_TOKEN) are injected server-side.
 */

import { getSandbox } from "@cloudflare/sandbox";
import type { ProxyContext } from "../types";

/**
 * Parameters for Pages deployment
 */
interface DeployPagesParams {
  directory: string; // e.g., "dist", "build"
  projectName?: string; // optional, defaults to sandbox-{userId}-default
  branch?: string; // optional, defaults to "main"
}

/**
 * Parameters for Worker deployment
 */
interface DeployWorkerParams {
  entryPoint: string; // e.g., "src/index.ts"
  name?: string; // optional worker name
}

/**
 * Deployment result
 */
interface DeployResult {
  success: boolean;
  projectName?: string;
  url?: string;
  error?: string;
}

/**
 * Get sandbox instance for executing commands.
 * Uses the sandboxId from the JWT token.
 */
function getSandboxForDeployment(env: Env, sandboxId: string) {
  const binding = env.Sandbox;
  return getSandbox(
    {
      get: binding.get.bind(binding),
      idFromName: binding.idFromName.bind(binding),
      idFromString: binding.idFromString.bind(binding),
      newUniqueId: binding.newUniqueId.bind(binding),
    } as any,
    sandboxId,
    { normalizeId: true },
  );
}

/**
 * Deploy to Cloudflare Pages.
 *
 * Executes `wrangler pages deploy` inside the sandbox with credentials injected.
 */
export async function deployPages(
  ctx: ProxyContext<Env>,
  params: DeployPagesParams,
): Promise<DeployResult> {
  const { jwt, env } = ctx;
  const { directory, projectName, branch = "main" } = params;

  // Validate required env vars
  const apiToken = (env as any).CLOUDFLARE_API_TOKEN;
  const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    return {
      success: false,
      error: "Cloudflare credentials not configured on engine",
    };
  }

  // Build project name: sandbox-{userId}-{projectName || default}
  const slug = projectName || `default-${jwt.sandboxId}`;
  const fullProjectName = `sandbox-${jwt.userId}-${slug}`;

  // Get sandbox
  const sandbox = getSandboxForDeployment(env, jwt.sandboxId);

  // Check if directory exists
  const checkDir = await sandbox.exec(
    `test -d /workspace/${directory} && echo exists || echo missing`,
  );
  if (checkDir.stdout.trim() !== "exists") {
    return {
      success: false,
      error: `Directory "${directory}" not found. Make sure to build your project first (e.g., npm run build).`,
    };
  }

  // Execute wrangler pages deploy with credentials
  const deployCommand = `
    cd /workspace && \
    CLOUDFLARE_API_TOKEN="${apiToken}" \
    CLOUDFLARE_ACCOUNT_ID="${accountId}" \
    npx wrangler pages deploy ${directory} \
      --project-name=${fullProjectName} \
      --branch=${branch} \
      --commit-dirty=true \
      2>&1
  `;

  const result = await sandbox.exec(deployCommand);

  // Parse the output for the URL
  const urlMatch = result.stdout.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/);
  const deployedUrl = urlMatch ? urlMatch[0] : `https://${fullProjectName}.pages.dev`;

  if (result.exitCode !== 0) {
    // Check for common errors
    const stderr = result.stderr || result.stdout;

    if (stderr.includes("directory is empty")) {
      return {
        success: false,
        projectName: fullProjectName,
        error: `Directory "${directory}" is empty. Make sure to build your project first.`,
      };
    }

    return {
      success: false,
      projectName: fullProjectName,
      error: `Deployment failed: ${stderr.slice(0, 500)}`,
    };
  }

  return {
    success: true,
    projectName: fullProjectName,
    url: deployedUrl,
  };
}

/**
 * Deploy to Workers for Platforms.
 *
 * Bundles the worker and deploys via Cloudflare API.
 */
export async function deployWorker(
  ctx: ProxyContext<Env>,
  params: DeployWorkerParams,
): Promise<DeployResult> {
  const { jwt, env } = ctx;
  const { entryPoint, name } = params;

  // Validate required env vars
  const apiToken = (env as any).CLOUDFLARE_API_TOKEN;
  const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID;
  const dispatchNamespace = (env as any).DISPATCH_NAMESPACE;

  if (!apiToken || !accountId) {
    return {
      success: false,
      error: "Cloudflare credentials not configured on engine",
    };
  }

  const workerName = name || `sandbox-${jwt.sandboxId}`;
  const sandbox = getSandboxForDeployment(env, jwt.sandboxId);

  // Check if entry point exists
  const checkFile = await sandbox.exec(
    `test -f /workspace/${entryPoint} && echo exists || echo missing`,
  );
  if (checkFile.stdout.trim() !== "exists") {
    return {
      success: false,
      error: `Entry point "${entryPoint}" not found.`,
    };
  }

  // Bundle with esbuild
  const bundledPath = `/tmp/${workerName}.js`;
  const bundleResult = await sandbox.exec(
    `cd /workspace && npx esbuild ${entryPoint} --bundle --format=esm --outfile=${bundledPath} --platform=browser 2>&1`,
  );

  if (bundleResult.exitCode !== 0) {
    return {
      success: false,
      error: `Bundling failed: ${bundleResult.stderr || bundleResult.stdout}`,
    };
  }

  // Read bundled script
  const scriptResult = await sandbox.exec(`cat ${bundledPath}`);
  if (scriptResult.exitCode !== 0) {
    return {
      success: false,
      error: "Failed to read bundled script",
    };
  }

  // Deploy via Cloudflare API
  try {
    const formData = new FormData();

    const scriptBlob = new Blob([scriptResult.stdout], {
      type: "application/javascript+module",
    });
    formData.append("index.js", scriptBlob, "index.js");

    const metadata = {
      main_module: "index.js",
      compatibility_date: "2024-11-01",
      tags: [`session-${jwt.sandboxId}`, "sandbox-deploy"],
    };
    formData.append("metadata", JSON.stringify(metadata));

    const apiUrl = dispatchNamespace
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`
      : `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;

    const response = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: formData,
    });

    const apiResult: any = await response.json();

    if (!apiResult.success) {
      return {
        success: false,
        error: `Cloudflare API error: ${apiResult.errors?.map((e: any) => e.message).join(", ")}`,
      };
    }

    // Build URL
    const url = `https://engine.shipbox.dev/site/${jwt.sandboxId}/`;

    return {
      success: true,
      projectName: workerName,
      url,
    };
  } catch (error) {
    return {
      success: false,
      error: `Deployment failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Handle deployment proxy requests.
 *
 * This is a special handler that doesn't just forward requests,
 * but executes deployment logic server-side.
 */
export async function handleDeployRequest(
  request: Request,
  ctx: ProxyContext<Env>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/proxy\/deploy/, "");

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();

    if (path === "/pages" || path === "/pages/") {
      const result = await deployPages(ctx, body as DeployPagesParams);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/worker" || path === "/worker/") {
      const result = await deployWorker(ctx, body as DeployWorkerParams);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown deployment type" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Invalid request",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
