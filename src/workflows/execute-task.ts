// src/workflows/execute-task.ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Config } from "@opencode-ai/sdk";

interface TaskParams {
  sessionId: string;
  sandboxId: string;
  task: string;
  model: string;
  runId: string;
  doId: string; // Durable Object ID for RPC callback
  repositoryUrl?: string;
  branch?: string;
  // OpenCode config with provider API keys
  opencodeConfig?: Config;
}

interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
}

/**
 * Stub type for DO RPC
 */
interface McpAgentStub {
  onTaskComplete: (params: {
    runId: string;
    result: TaskResult;
  }) => Promise<void>;
}

/**
 * Workflow that executes OpenCode tasks durably inside Cloudflare Sandboxes.
 *
 * This is the core of the MCP server - it:
 * 1. Gets a sandbox instance
 * 2. Mounts R2 storage for persistence
 * 3. Restores any previous session state
 * 4. Clones the repository if needed
 * 5. Starts OpenCode inside the sandbox
 * 6. Executes the task via the OpenCode SDK
 * 7. Backs up session state
 * 8. Notifies the DO of completion via RPC
 */
export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    const params = event.payload;

    try {
      // Step 1: Get sandbox instance
      const sandbox = await step.do("get-sandbox", async () => {
        return this.getSandbox(params.sandboxId);
      });

      // Step 2: Mount R2 storage for workspace persistence
      await step.do("mount-storage", async () => {
        await this.mountR2Storage(sandbox, params.sessionId);
      });

      // Step 3: Restore OpenCode session state from backup
      const _restored = await step.do("restore-session", async () => {
        return this.restoreSession(sandbox, params.sessionId);
      });

      // Step 4: Clone repository if needed
      if (params.repositoryUrl) {
        await step.do("clone-repository", async () => {
          await this.cloneRepository(
            sandbox,
            params.repositoryUrl!,
            params.branch
          );
        });
      }

      // Step 5: Start OpenCode and execute task
      const taskResult = await step.do(
        "execute-opencode-task",
        {
          retries: {
            limit: 3,
            delay: "10 seconds",
            backoff: "exponential",
          },
          timeout: "50 minutes",
        },
        async () => {
          return this.executeOpenCodeTask(sandbox, params);
        }
      );

      // Step 6: Backup session state to R2
      await step.do("backup-session", async () => {
        await this.backupSession(sandbox, params.sessionId);
      });

      // Step 7: Get git status for the result
      const gitInfo = await step.do("get-git-status", async () => {
        return this.getGitStatus(sandbox);
      });

      const result: TaskResult = {
        success: taskResult.success,
        output: taskResult.output,
        error: taskResult.error,
        filesCreated: taskResult.filesCreated,
        filesModified: gitInfo.filesModified,
        commits: gitInfo.commits,
        branch: gitInfo.branch,
      };

      // Step 8: Notify DO via RPC callback
      await step.do("notify-completion", async () => {
        await this.notifyCompletion(params.doId, params.runId, result);
      });

      return result;
    } catch (error) {
      // Handle errors and still notify DO
      const errorResult: TaskResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filesCreated: [],
        filesModified: [],
        commits: [],
      };

      await step.do("notify-failure", async () => {
        await this.notifyCompletion(params.doId, params.runId, errorResult);
      });

      return errorResult;
    }
  }

  /**
   * Get a sandbox instance from the SANDBOX binding
   */
  private getSandbox(sandboxId: string): Sandbox<unknown> {
    return getSandbox(this.env.SANDBOX, sandboxId, {
      normalizeId: true,
      sleepAfter: "10 minutes",
    });
  }

  /**
   * Mount R2 storage at /workspace using s3fs
   */
  private async mountR2Storage(
    sandbox: Sandbox<unknown>,
    sessionId: string
  ): Promise<void> {
    const accountId = this.env.R2_ACCOUNT_ID;
    const accessKeyId = this.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = this.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      console.warn("R2 credentials not configured, skipping mount");
      return;
    }

    // Mount R2 bucket with session prefix for isolation
    // Uses s3fs bucket:/prefix syntax
    await sandbox.mountBucket(
      `opencode-sessions:/${sessionId}/workspace`,
      "/workspace",
      {
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      }
    );
  }

  /**
   * Restore OpenCode session state from R2 backup
   */
  private async restoreSession(
    sandbox: Sandbox<unknown>,
    sessionId: string
  ): Promise<boolean> {
    try {
      const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
      const object = await this.env.SESSIONS_BUCKET.get(key);

      if (!object) {
        return false;
      }

      // Download and extract backup
      const data = await object.arrayBuffer();
      const bytes = new Uint8Array(data);
      let binaryString = "";
      for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
      }
      const base64Data = btoa(binaryString);

      await sandbox.exec(
        `echo '${base64Data}' | base64 -d > /tmp/opencode-backup.tar.gz`
      );
      await sandbox.exec("mkdir -p ~/.local/share/opencode");
      await sandbox.exec(
        "tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode"
      );
      await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");

      return true;
    } catch (error) {
      console.error("Failed to restore session:", error);
      return false;
    }
  }

  /**
   * Clone a git repository into /workspace
   */
  private async cloneRepository(
    sandbox: Sandbox<unknown>,
    url: string,
    branch?: string
  ): Promise<void> {
    // Check if already cloned
    const checkResult = await sandbox.exec(
      "test -d /workspace/.git && echo exists || echo missing"
    );

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

  /**
   * Execute the OpenCode task inside the sandbox
   */
  private async executeOpenCodeTask(
    sandbox: Sandbox<unknown>,
    params: TaskParams
  ): Promise<{
    success: boolean;
    output: string;
    error?: string;
    filesCreated: string[];
    filesModified: string[];
    commits: string[];
    branch?: string;
  }> {
    // Start OpenCode server in the sandbox and get SDK client
    const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
      port: 4096,
      directory: "/workspace",
      config: params.opencodeConfig,
    });

    try {
      // Create or get session
      let sessionId: string;
      try {
        const existing = (await client.session.get({
          path: { id: params.sessionId },
        })) as { data: { id: string } };
        sessionId = existing.data.id;
      } catch {
        const created = (await client.session.create({
          body: { title: `Task: ${params.task.slice(0, 50)}` },
        })) as { data: { id: string } };
        sessionId = created.data.id;
      }

      // Execute the task
      const response = (await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: {
            providerID: "anthropic",
            modelID: params.model,
          },
          parts: [
            {
              type: "text",
              text: params.task,
            },
          ],
        },
      })) as {
        data?: {
          parts?: Array<{ type: string; text?: string }>;
        };
      };

      // Extract text from response
      const textParts =
        response?.data?.parts
          ?.filter((p) => p.type === "text")
          ?.map((p) => p.text ?? "") ?? [];

      return {
        success: true,
        output: textParts.join("\n"),
        filesCreated: [],
        filesModified: [],
        commits: [],
        branch: undefined,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        filesCreated: [],
        filesModified: [],
        commits: [],
      };
    } finally {
      // Always close the server
      await server.close();
    }
  }

  /**
   * Backup OpenCode session state to R2
   */
  private async backupSession(
    sandbox: Sandbox<unknown>,
    sessionId: string
  ): Promise<void> {
    try {
      // Create archive of OpenCode storage
      const archiveResult = await sandbox.exec(
        `tar -czf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode storage 2>/dev/null || true`
      );

      if (archiveResult.exitCode !== 0) {
        return; // No storage to backup
      }

      // Check if archive was created
      const checkResult = await sandbox.exec(
        `test -f /tmp/opencode-backup.tar.gz && echo exists || echo missing`
      );

      if (checkResult.stdout.trim() !== "exists") {
        return;
      }

      // Read and upload to R2
      const catResult = await sandbox.exec(
        `cat /tmp/opencode-backup.tar.gz | base64`
      );

      if (catResult.exitCode !== 0) {
        throw new Error(`Failed to read backup: ${catResult.stderr}`);
      }

      const base64Data = catResult.stdout.trim();
      const binaryString = atob(base64Data);
      const archiveBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        archiveBuffer[i] = binaryString.charCodeAt(i);
      }

      const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
      await this.env.SESSIONS_BUCKET.put(key, archiveBuffer);

      // Cleanup
      await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");
    } catch (error) {
      console.error("Failed to backup session:", error);
    }
  }

  /**
   * Get git status information from the workspace
   */
  private async getGitStatus(sandbox: Sandbox<unknown>): Promise<{
    branch: string;
    commits: string[];
    filesModified: string[];
  }> {
    try {
      // Get current branch
      const branchResult = await sandbox.exec(
        "git -C /workspace rev-parse --abbrev-ref HEAD 2>/dev/null || echo main"
      );

      // Get recent commits (just the short hashes)
      const logResult = await sandbox.exec(
        "git -C /workspace log --oneline -5 2>/dev/null || echo ''"
      );

      // Get changed files
      const diffResult = await sandbox.exec(
        "git -C /workspace diff --name-only HEAD~1 2>/dev/null || echo ''"
      );

      return {
        branch: branchResult.stdout.trim(),
        commits: logResult.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(" ")[0]),
        filesModified: diffResult.stdout.trim().split("\n").filter(Boolean),
      };
    } catch {
      return {
        branch: "main",
        commits: [],
        filesModified: [],
      };
    }
  }

  /**
   * Notify the MCP Agent DO of task completion via RPC
   */
  private async notifyCompletion(
    doId: string,
    runId: string,
    result: TaskResult
  ): Promise<void> {
    const doIdObj = this.env.MCP_AGENT.idFromString(doId);
    const stub = this.env.MCP_AGENT.get(doIdObj) as unknown as McpAgentStub;

    await stub.onTaskComplete({
      runId,
      result,
    });
  }
}
