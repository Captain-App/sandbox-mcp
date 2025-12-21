// src/workflows/execute-task.ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

// Note: Services are imported but not fully utilized in this placeholder
// Full integration would use Effect runtime with these services:
// import { Effect, Layer, ManagedRuntime } from "effect";
// import { SandboxService, makeSandboxLayer } from "../services/sandbox";
// import { OpenCodeService, OpenCodeServiceLive } from "../services/opencode";
// import { BackupService, makeBackupLayer } from "../services/backup";

interface TaskParams {
  sessionId: string;
  sandboxId: string;
  task: string;
  model: string;
  runId: string;
  doId: string; // Durable Object ID for RPC callback
  repositoryUrl?: string;
  branch?: string;
  r2Config?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
  };
  gitConfig?: {
    token: string;
    authorName: string;
    authorEmail: string;
  };
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
 * Workflow that executes OpenCode tasks durably
 */
export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    const params = event.payload;

    try {
      // Step 1: Setup sandbox with R2 mount and git credentials
      const _sandboxInfo = await step.do("setup-sandbox", async () => {
        return this.setupSandbox(params);
      });

      // Step 2: Restore OpenCode session if it exists
      const _restored = await step.do("restore-session", async () => {
        return this.restoreSession(params);
      });

      // Step 3: Clone repository if needed
      if (params.repositoryUrl) {
        await step.do("clone-repository", async () => {
          return this.cloneRepository(params);
        });
      }

      // Step 4: Execute OpenCode task
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
          return this.executeTask(params);
        }
      );

      // Step 5: Backup session state
      await step.do("backup-session", async () => {
        return this.backupSession(params);
      });

      // Step 6: Get git status for result
      const gitInfo = await step.do("get-git-status", async () => {
        return this.getGitStatus(params);
      });

      const result: TaskResult = {
        success: taskResult.success,
        output: taskResult.output,
        filesCreated: taskResult.filesCreated,
        filesModified: gitInfo.filesModified,
        commits: gitInfo.commits,
        branch: gitInfo.branch,
      };

      // Step 7: Notify DO via RPC
      await step.do("notify-completion", async () => {
        return this.notifyCompletion(params.doId, params.runId, result);
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
        return this.notifyCompletion(params.doId, params.runId, errorResult);
      });

      return errorResult;
    }
  }

  /**
   * Setup sandbox with R2 mount and git credentials
   */
  private async setupSandbox(params: TaskParams): Promise<{
    sandboxId: string;
    ready: boolean;
  }> {
    // For now, use a simplified setup without full Effect runtime
    // In production, this would use the full service layer
    console.log(`Setting up sandbox ${params.sandboxId} for session ${params.sessionId}`);

    // The actual sandbox setup would be done here using the sandbox binding
    // For now we return a placeholder since we don't have the SANDBOX binding configured
    return {
      sandboxId: params.sandboxId,
      ready: true,
    };
  }

  /**
   * Restore OpenCode session from backup
   */
  private async restoreSession(params: TaskParams): Promise<boolean> {
    console.log(`Restoring session ${params.sessionId}`);

    // Would use BackupService.restoreSession here
    // For now return false (no backup)
    return false;
  }

  /**
   * Clone repository if not already present
   */
  private async cloneRepository(params: TaskParams): Promise<void> {
    if (!params.repositoryUrl) return;

    console.log(`Cloning repository ${params.repositoryUrl}`);
    // Would use SandboxService.cloneRepository here
  }

  /**
   * Execute the OpenCode task
   */
  private async executeTask(params: TaskParams): Promise<{
    success: boolean;
    output: string;
    filesCreated: string[];
    filesModified: string[];
    commits: string[];
    branch?: string;
  }> {
    console.log(`Executing task: ${params.task.slice(0, 100)}...`);
    console.log(`Using model: ${params.model}`);

    // Would use OpenCodeService.executeTaskInSandbox here
    // For now return placeholder
    return {
      success: true,
      output: "Task completed (placeholder implementation)",
      filesCreated: [],
      filesModified: [],
      commits: [],
      branch: "main",
    };
  }

  /**
   * Backup session state to R2
   */
  private async backupSession(params: TaskParams): Promise<void> {
    console.log(`Backing up session ${params.sessionId}`);
    // Would use BackupService.backupSession here
  }

  /**
   * Get git status from the sandbox
   */
  private async getGitStatus(_params: TaskParams): Promise<{
    branch: string;
    commits: string[];
    filesModified: string[];
  }> {
    // Would use SandboxService.execCommand to get git info
    return {
      branch: "main",
      commits: [],
      filesModified: [],
    };
  }

  /**
   * Notify DO of task completion via RPC
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
