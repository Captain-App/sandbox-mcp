// src/workflows/execute-task.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { WorkflowEventBuilder, type WorkflowEvent as TelemetryEvent } from '../services/telemetry';
import { type TaskParams, type TaskResult, type McpAgentStub, type WorkflowDeps, Sandbox, OpenCode, Backup, Git } from './helpers';

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
	/**
	 * Build workflow dependencies from env
	 */
	private getDeps(): WorkflowDeps {
		return {
			sandboxBinding: this.env.Sandbox,
			mcpAgentBinding: this.env.MCP_AGENT,
			sessionsBucket: this.env.SESSIONS_BUCKET,
			r2Config:
				this.env.R2_ACCOUNT_ID && this.env.R2_ACCESS_KEY_ID && this.env.R2_SECRET_ACCESS_KEY
					? {
							accountId: this.env.R2_ACCOUNT_ID,
							accessKeyId: this.env.R2_ACCESS_KEY_ID,
							secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
						}
					: undefined,
			githubToken: this.env.GITHUB_TOKEN,
		};
	}

	async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep): Promise<TaskResult> {
		const params = event.payload;
		const deps = this.getDeps();

		// Create telemetry event builder
		// Constructor: (workflowId, runId, sessionId)
		const telemetry = new WorkflowEventBuilder(
			event.instanceId, // workflowId - the workflow instance ID
			params.runId, // runId - our run tracking ID
			params.sessionId, // sessionId
		);

		try {
			// Step 1: Mount R2 storage for workspace persistence
			await step.do('mount-storage', async () => {
				const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
				await Sandbox.mountR2Storage(sandbox, params.sessionId, deps.r2Config);
				return { mounted: true };
			});

			// Step 2: Restore OpenCode session state from backup
			const restoreResult = await step.do('restore-session', async () => {
				const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
				const restored = await Backup.restoreSession(sandbox, params.sessionId, deps.sessionsBucket);
				return { restored };
			});
			telemetry.setMetadata({ sessionRestored: restoreResult.restored });

			// Step 3: Set up git credentials
			await step.do('setup-git-credentials', async () => {
				const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
				await Sandbox.setupGitCredentials(sandbox, deps.githubToken);
				return { configured: true };
			});

			// Step 4: Clone repository if needed
			if (params.repositoryUrl) {
				await step.do('clone-repository', async () => {
					const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
					await Sandbox.cloneRepository(sandbox, params.repositoryUrl!, params.branch);
					return { cloned: true };
				});
			}

			// Step 5: Start OpenCode and execute task
			const taskResult = await step.do(
				'execute-opencode-task',
				{
					retries: {
						limit: 3,
						delay: '10 seconds',
						backoff: 'exponential',
					},
					timeout: '50 minutes',
				},
				async () => {
					const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
					return OpenCode.executeTask(sandbox, params);
				},
			);

			// Step 6: Backup session state to R2
			await step.do('backup-session', async () => {
				const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
				await Backup.backupSession(sandbox, params.sessionId, deps.sessionsBucket);
				return { backedUp: true };
			});

			// Step 7: Get git status for the result
			const gitInfo = await step.do('get-git-status', async () => {
				const sandbox = Sandbox.getSandbox(deps, params.sandboxId);
				return Git.getStatus(sandbox);
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
			await step.do('notify-completion', async () => {
				await this.notifyCompletion(deps, params.doId, params.runId, result);
				return { notified: true };
			});

			// Emit success telemetry
			telemetry.setOutcome('success');
			this.emitTelemetry(telemetry.finalize());

			return result;
		} catch (error) {
			// Record error in telemetry
			const errorName = error instanceof Error ? error.name : 'UnknownError';
			const errorMessage = error instanceof Error ? error.message : String(error);
			telemetry.setError({
				type: errorName,
				code: errorName,
				message: errorMessage,
				phase: 'execution',
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

			await step.do('notify-failure', async () => {
				await this.notifyCompletion(deps, params.doId, params.runId, errorResult);
				return { notified: true };
			});

			return errorResult;
		}
	}

	/**
	 * Emit telemetry event as wide event log line
	 */
	private emitTelemetry(event: TelemetryEvent): void {
		console.log(
			JSON.stringify({
				level: event.error ? 'error' : 'info',
				type: 'workflow.event',
				...event,
			}),
		);
	}

	/**
	 * Notify the MCP Agent DO of task completion via RPC
	 */
	private async notifyCompletion(deps: WorkflowDeps, doId: string, runId: string, result: TaskResult): Promise<void> {
		// Use unknown binding to avoid TypeScript infinite type instantiation
		const binding = deps.mcpAgentBinding as unknown as DurableObjectNamespace;
		const doIdObj = binding.idFromString(doId);
		const stub = binding.get(doIdObj) as unknown as McpAgentStub;

		await stub.onTaskComplete({
			runId,
			result,
		});
	}
}
