import { type Sandbox } from "@cloudflare/sandbox";

interface DeployPagesParams {
  sandbox: Sandbox<unknown>;
  sessionId: string;
  directory: string;
  projectName?: string;
  branch?: string;
  userId: string;
  accountId: string;
  apiToken: string;
}

/**
 * Deploy a static site to Cloudflare Pages.
 *
 * Uses wrangler CLI via `npx wrangler pages deploy` which handles:
 * - Project creation (if needed)
 * - Asset upload
 * - Deployment to production or preview branches
 *
 * Project naming: sandbox-{userId}-{projectSlug}
 * - Ensures user isolation
 * - Allows project reuse across deployments
 */
export async function deployPages(params: DeployPagesParams): Promise<{
  success: boolean;
  projectName: string;
  url: string;
  error?: string;
}> {
  const { sandbox, sessionId, directory, projectName, branch, userId, accountId, apiToken } =
    params;

  // Construct full project name with user prefix for isolation
  const slug = projectName || `default-${sessionId}`;
  const fullProjectName = `sandbox-${userId}-${slug}`;

  // 1. Validate directory exists
  const checkDirResult = await sandbox.exec(`test -d ${directory} && echo "exists"`);
  if (checkDirResult.exitCode !== 0 || !checkDirResult.stdout.includes("exists")) {
    return {
      success: false,
      projectName: fullProjectName,
      url: "",
      error: `Directory not found: ${directory}. Make sure the path is correct and the directory exists.`,
    };
  }

  // 2. Check if directory has files (not empty)
  const checkFilesResult = await sandbox.exec(`ls -A ${directory} | head -1`);
  if (checkFilesResult.exitCode !== 0 || !checkFilesResult.stdout.trim()) {
    return {
      success: false,
      projectName: fullProjectName,
      url: "",
      error: `Directory is empty: ${directory}. Did you run your build command first (e.g., npm run build)?`,
    };
  }

  // 3. Deploy using wrangler pages deploy
  const deployBranch = branch || "main";
  const deployCommand = [
    `export CLOUDFLARE_API_TOKEN="${apiToken}"`,
    `export CLOUDFLARE_ACCOUNT_ID="${accountId}"`,
    `npx wrangler pages deploy ${directory}`,
    `--project-name=${fullProjectName}`,
    `--branch=${deployBranch}`,
    `--commit-dirty=true`,
  ].join(" && ");

  const deployResult = await sandbox.exec(deployCommand);

  if (deployResult.exitCode !== 0) {
    // Parse common error patterns for better user feedback
    const stderr = deployResult.stderr || "";
    const stdout = deployResult.stdout || "";
    const output = stderr + stdout;

    let errorMessage = `Deployment failed: ${stderr || stdout || "Unknown error"}`;

    if (output.includes("could not find") || output.includes("ENOENT")) {
      errorMessage = `Could not find the directory to deploy: ${directory}. Check the path and try again.`;
    } else if (output.includes("too many projects")) {
      errorMessage =
        "Cloudflare Pages project limit reached. Contact support or delete unused projects.";
    } else if (output.includes("authentication") || output.includes("unauthorized")) {
      errorMessage = "Deployment authentication failed. Please try again later.";
    }

    return {
      success: false,
      projectName: fullProjectName,
      url: "",
      error: errorMessage,
    };
  }

  // 4. Parse deployment URL from wrangler output
  // Wrangler outputs various formats, look for pages.dev URL
  const output = deployResult.stdout + deployResult.stderr;
  const urlMatch = output.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/);

  // Construct expected URL if not found in output
  let deploymentUrl: string;
  if (urlMatch) {
    deploymentUrl = urlMatch[0].replace(/[)\]]+$/, ""); // Clean trailing punctuation
  } else {
    // Fallback to expected URL pattern
    deploymentUrl =
      deployBranch === "main"
        ? `https://${fullProjectName}.pages.dev`
        : `https://${deployBranch}.${fullProjectName}.pages.dev`;
  }

  return {
    success: true,
    projectName: fullProjectName,
    url: deploymentUrl,
  };
}
