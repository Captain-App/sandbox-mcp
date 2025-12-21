// src/workflows/execute-task.ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

interface TaskParams {
  sessionId: string;
  sandboxId: string;
  task: string;
  model: string;
  runId: string;
  doId: string; // Durable Object ID for RPC callback
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
 * Workflow that executes OpenCode tasks durably
 */
export class ExecuteTaskWorkflow extends WorkflowEntrypoint<Env, TaskParams> {
  async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    const { sessionId, sandboxId, task, model, runId, doId } = event.payload;

    // Step 1: Setup sandbox (placeholder)
    const sandboxInfo = await step.do("setup-sandbox", async () => {
      // TODO: Get sandbox, mount R2, setup credentials
      console.log(`Setting up sandbox ${sandboxId} for session ${sessionId}`);
      return {
        sandboxId,
        ready: true,
      };
    });

    // Step 2: Execute OpenCode task (placeholder)
    const result = await step.do(
      "execute-task",
      {
        retries: {
          limit: 3,
          delay: "10 seconds",
          backoff: "exponential",
        },
        timeout: "50 minutes",
      },
      async () => {
        // TODO: Call OpenCode SDK
        console.log(
          `Executing task in sandbox ${sandboxInfo.sandboxId}: ${task.slice(0, 100)}...`
        );
        console.log(`Using model: ${model}`);

        return {
          success: true,
          output: "Task completed (placeholder)",
          filesCreated: [],
          filesModified: [],
          commits: [],
          branch: "main",
        } satisfies TaskResult;
      }
    );

    // Step 3: Notify DO via RPC callback
    await step.do("notify-completion", async () => {
      const doIdObj = this.env.MCP_AGENT.idFromString(doId);
      const stub = this.env.MCP_AGENT.get(doIdObj);

      // RPC call to DO - call the onTaskComplete method
      await (stub as unknown as { onTaskComplete: (params: { runId: string; result: TaskResult }) => Promise<void> }).onTaskComplete({
        runId,
        result,
      });
    });

    return result;
  }
}
