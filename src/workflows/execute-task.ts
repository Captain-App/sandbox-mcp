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
import { WorkflowEventBuilder, type WorkflowEvent as TelemetryEvent } from "../services/telemetry";

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
  // Git credentials for authenticated operations
  githubToken?: string;
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
 * OpenCode SDK response types for type safety
 */
interface OpenCodeSessionListResponse {
  data?: Array<{ id: string }>;
}

interface OpenCodeSessionCreateResponse {
  data?: { id: string };
}

interface OpenCodePromptResponse {
  data?: {
    parts?: Array<{ type: string; text?: string }>;
  };
}

/**
 * Workflow that executes OpenCode tasks durably inside Cloudflare Sandboxes.
 *
 * IMPORTANT: Workflow steps must return serializable values only.
 * Sandbox instances (DO stubs) are NOT serializable and must be
 * obtained fresh in each step that needs them.
 *
 * This is the core of the MCP server - it:
 * 1. Mounts R2 storage for persistence
 * 2. Restores any previous session state
 * 3. Clones the repository if needed
 * 4. Starts OpenCode inside the sandbox
 * 5. Executes the task via the OpenCode SDK
 * 6. Backs up session state
 * 7. Notifies the DO of completion via RPC
 */
export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    const params = event.payload;

    // Create telemetry event builder for this workflow
    const telemetry = new WorkflowEventBuilder(
      params.runId,
      params.sessionId,
      params.task.slice(0, 100)
    );

    try {
      // Step 1: Mount R2 storage for workspace persistence
      // Note: Get sandbox fresh in each step - DO stubs are NOT serializable
      await step.do("mount-storage", async () => {
        const sandbox = this.getSandbox(params.sandboxId);
        await this.mountR2Storage(sandbox, params.sessionId);
        return { mounted: true }; // Return serializable value
      });

      // Step 2: Restore OpenCode session state from backup
      const restoreResult = await step.do("restore-session", async () => {
        const sandbox = this.getSandbox(params.sandboxId);
        const restored = await this.restoreSession(sandbox, params.sessionId);
        return { restored }; // Return serializable value
      });
      telemetry.setMetadata({ sessionRestored: restoreResult.restored });

      // Step 3: Set up git credentials if GITHUB_TOKEN is available
      await step.do("setup-git-credentials", async () => {
        const sandbox = this.getSandbox(params.sandboxId);
        await this.setupGitCredentials(sandbox);
        return { configured: true };
      });

      // Step 4: Clone repository if needed
      if (params.repositoryUrl) {
        await step.do("clone-repository", async () => {
          const sandbox = this.getSandbox(params.sandboxId);
          await this.cloneRepository(
            sandbox,
            params.repositoryUrl!,
            params.branch
          );
          return { cloned: true };
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
          const sandbox = this.getSandbox(params.sandboxId);
          return this.executeOpenCodeTask(sandbox, params);
        }
      );

      // Step 6: Backup session state to R2
      await step.do("backup-session", async () => {
        const sandbox = this.getSandbox(params.sandboxId);
        await this.backupSession(sandbox, params.sessionId);
        return { backedUp: true };
      });

      // Step 7: Get git status for the result
      const gitInfo = await step.do("get-git-status", async () => {
        const sandbox = this.getSandbox(params.sandboxId);
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
        return { notified: true };
      });

      // Emit success telemetry
      telemetry.setOutcome("success");
      this.emitTelemetry(telemetry.finalize());

      return result;
    } catch (error) {
      // Record error in telemetry
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage = error instanceof Error ? error.message : String(error);
      telemetry.setError({
        type: errorName,
        code: errorName,
        message: errorMessage,
        phase: "execution",
        retriable: true,
      });
      this.emitTelemetry(telemetry.finalize());

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
        return { notified: true };
      });

      return errorResult;
    }
  }

  /**
   * Emit telemetry event as wide event log line
   */
  private emitTelemetry(event: TelemetryEvent): void {
    // Use structured logging for observability
    // This creates a "canonical log line" with all context
    console.log(JSON.stringify({
      level: event.error ? "error" : "info",
      type: "workflow.event",
      ...event,
    }));
  }

  /**
   * Get a sandbox instance from the SANDBOX binding.
   * IMPORTANT: This must be called fresh in each step - DO stubs are NOT serializable.
   */
  private getSandbox(sandboxId: string): Sandbox<unknown> {
    return getSandbox(this.env.Sandbox, sandboxId, {
      normalizeId: true,
      sleepAfter: "10 minutes",
    });
  }

  /**
   * Set up git credentials for authenticated operations.
   * Uses environment variables instead of writing to disk for security.
   */
  private async setupGitCredentials(sandbox: Sandbox<unknown>): Promise<void> {
    const githubToken = this.env.GITHUB_TOKEN;

    if (!githubToken) {
      // Note: We don't use console.warn here - telemetry handles this
      return;
    }

    // Set environment variables for git operations (more secure than file storage)
    await sandbox.setEnvVars({
      GIT_ASKPASS: "echo",
      GIT_TERMINAL_PROMPT: "0",
      GH_TOKEN: githubToken,
      GITHUB_TOKEN: githubToken,
    });

    // Configure git credential helper using environment variable
    await sandbox.exec(
      `git config --global credential.helper '!f() { echo "password=$GITHUB_TOKEN"; }; f'`
    );

    // Set git user info for commits
    await sandbox.exec(
      `git config --global user.email "opencode@sandbox.workers.dev"`
    );
    await sandbox.exec(`git config --global user.name "OpenCode Bot"`);

    // Set up GH CLI using environment variable (already set above)
    await sandbox.exec(`gh auth status 2>/dev/null || true`);
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
      // Skip mount if credentials not configured
      return;
    }

    // Mount R2 bucket with session prefix for isolation
    // Uses bucket:prefix syntax for s3fs
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
   * Restore OpenCode session state from R2 backup.
   * Uses base64 encoding for binary data transfer.
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

      // Convert ArrayBuffer to base64 for shell transfer
      const data = await object.arrayBuffer();
      const bytes = new Uint8Array(data);
      const base64Data = this.uint8ArrayToBase64(bytes);

      // Write base64 data and decode in sandbox
      // Split into chunks if very large to avoid command line limits
      const chunkSize = 100000; // ~100KB chunks
      if (base64Data.length > chunkSize) {
        // For large files, write in chunks
        await sandbox.exec("rm -f /tmp/opencode-backup.b64");
        for (let i = 0; i < base64Data.length; i += chunkSize) {
          const chunk = base64Data.slice(i, i + chunkSize);
          await sandbox.exec(`printf '%s' '${chunk}' >> /tmp/opencode-backup.b64`);
        }
        await sandbox.exec(
          "base64 -d /tmp/opencode-backup.b64 > /tmp/opencode-backup.tar.gz"
        );
        await sandbox.exec("rm -f /tmp/opencode-backup.b64");
      } else {
        await sandbox.exec(
          `echo '${base64Data}' | base64 -d > /tmp/opencode-backup.tar.gz`
        );
      }

      await sandbox.exec("mkdir -p ~/.local/share/opencode");
      await sandbox.exec(
        "tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode"
      );
      await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");

      return true;
    } catch {
      // Telemetry will capture errors at the workflow level
      return false;
    }
  }

  /**
   * Convert Uint8Array to base64 string (avoids btoa Unicode issues)
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    // Use chunks to avoid stack overflow with large arrays
    const CHUNK_SIZE = 0x8000; // 32KB chunks
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
    }
    return btoa(chunks.join(""));
  }

  /**
   * Convert base64 string to Uint8Array (avoids atob Unicode issues)
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
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
      // Get or create OpenCode session
      // Since we have 1:1 mapping between our session and sandbox,
      // we use the first OpenCode session if one exists, or create a new one.
      let opencodeSessionId: string;

      // Try to list existing sessions with proper directory context
      const existingSessions = await client.session.list({
        query: { directory: "/workspace" },
      }) as OpenCodeSessionListResponse;

      if (existingSessions.data && existingSessions.data.length > 0) {
        // Use the first existing session (there should only be one per sandbox)
        opencodeSessionId = existingSessions.data[0].id;
      } else {
        // Create a new session with directory context
        const created = await client.session.create({
          body: { title: `Session: ${params.sessionId}` },
          query: { directory: "/workspace" },
        }) as OpenCodeSessionCreateResponse;

        if (!created.data?.id) {
          throw new Error("Failed to create OpenCode session: no ID returned");
        }
        opencodeSessionId = created.data.id;
      }

      // Execute the task with proper directory context
      const response = await client.session.prompt({
        path: { id: opencodeSessionId },
        query: { directory: "/workspace" },
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
      }) as OpenCodePromptResponse;

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
   * Backup OpenCode session state to R2.
   * Uses readFileStream for proper binary handling instead of base64 shell commands.
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

      // Read file as stream for proper binary handling
      const fileStream = await sandbox.readFileStream("/tmp/opencode-backup.tar.gz");
      const reader = fileStream.getReader();
      const chunks: Uint8Array[] = [];

      // Read all chunks
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          chunks.push(result.value);
        }
      }

      // Combine chunks into single buffer
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const archiveBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        archiveBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
      await this.env.SESSIONS_BUCKET.put(key, archiveBuffer);

      // Cleanup
      await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");
    } catch {
      // Telemetry will capture errors at the workflow level
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
