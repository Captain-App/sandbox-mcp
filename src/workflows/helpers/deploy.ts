import { type Sandbox } from "@cloudflare/sandbox";

interface DeployParams {
  sandbox: Sandbox<unknown>;
  sessionId: string;
  workerPath: string;
  name?: string;
  accountId: string;
  apiToken: string;
  dispatchNamespace: string;
  proxyBaseUrl: string;
  proxyToken: string;
}

/**
 * Bundle and deploy a worker to Workers for Platforms.
 */
export async function deployWorker(
  params: DeployParams,
): Promise<{ success: boolean; workerName: string; url: string; error?: string }> {
  const { sandbox, sessionId, workerPath, name, accountId, apiToken, dispatchNamespace } = params;

  const workerName = name || `sandbox-${sessionId}`;

  // 1. Bundle the worker using esbuild inside the sandbox
  // We'll use npx esbuild to ensure it's available
  const bundledPath = `/tmp/${workerName}.js`;
  const bundleCommand = `npx esbuild ${workerPath} --bundle --format=esm --outfile=${bundledPath} --platform=browser`;

  const bundleResult = await sandbox.exec(bundleCommand);
  if (bundleResult.exitCode !== 0) {
    return {
      success: false,
      workerName,
      url: "",
      error: `Bundling failed: ${bundleResult.stderr}`,
    };
  }

  // 2. Read the bundled script
  const scriptContentResult = await sandbox.exec(`cat ${bundledPath}`);
  if (scriptContentResult.exitCode !== 0) {
    return {
      success: false,
      workerName,
      url: "",
      error: `Failed to read bundled script: ${scriptContentResult.stderr}`,
    };
  }
  const script = scriptContentResult.stdout;

  // 3. Deploy via Cloudflare API
  // We'll do this from the engine worker (here) using the proxy or directly if we have access.
  // Since we're in the workflow context on the engine, we have the env.

  try {
    const formData = new FormData();

    // Add the main script as a module
    const scriptBlob = new Blob([script], { type: "application/javascript+module" });
    formData.append("index.js", scriptBlob, "index.js");

    // Add metadata
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2024-11-01",
      tags: [`session-${sessionId}`, "sandbox-deploy"],
    };
    formData.append("metadata", JSON.stringify(metadata));

    // Upload to dispatch namespace
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
        body: formData,
      },
    );

    const result: any = await response.json();

    if (!result.success) {
      return {
        success: false,
        workerName,
        url: "",
        error: `Cloudflare deployment failed: ${result.errors.map((e: any) => e.message).join(", ")}`,
      };
    }

    // Construct the production URL using the engine's /site/ route
    // The engine routes /site/{sessionId}/* to the deployed worker in Workers for Platforms
    // Wildcard subdomain {sessionId}.preview.shipbox.dev is also configured as a backup
    const url = `https://engine.shipbox.dev/site/${sessionId}/`;

    return {
      success: true,
      workerName,
      url,
    };
  } catch (error) {
    return {
      success: false,
      workerName,
      url: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
