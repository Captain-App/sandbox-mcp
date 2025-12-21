// src/workflows/helpers/types.ts
import type { Config } from '@opencode-ai/sdk';

/**
 * Parameters for task execution workflow
 */
export interface TaskParams {
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

/**
 * Result of task execution
 */
export interface TaskResult {
	success: boolean;
	output?: string;
	error?: string;
	filesCreated: string[];
	filesModified: string[];
	commits: string[];
	branch?: string;
}

/**
 * Stub type for DO RPC callback
 */
export interface McpAgentStub {
	onTaskComplete: (params: { runId: string; result: TaskResult }) => Promise<void>;
}

/**
 * Dependencies required by workflow helpers.
 * Explicit deps rather than implicit env access.
 * Uses `unknown` for DO generics to accept any binding type.
 */
export interface WorkflowDeps {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sandboxBinding: DurableObjectNamespace<any>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mcpAgentBinding: DurableObjectNamespace<any>;
	sessionsBucket: R2Bucket;
	r2Config?: {
		accountId: string;
		accessKeyId: string;
		secretAccessKey: string;
	};
	githubToken?: string;
}

/**
 * Git status information from workspace
 */
export interface GitStatus {
	branch: string;
	commits: string[];
	filesModified: string[];
}

/**
 * OpenCode SDK response types
 */
export interface OpenCodeSessionListResponse {
	data?: Array<{ id: string }>;
}

export interface OpenCodeSessionCreateResponse {
	data?: { id: string };
}

export interface OpenCodePromptResponse {
	data?: {
		parts?: Array<{ type: string; text?: string }>;
	};
}

/**
 * Result of OpenCode task execution
 */
export interface OpenCodeTaskResult {
	success: boolean;
	output: string;
	error?: string;
	filesCreated: string[];
	filesModified: string[];
	commits: string[];
	branch?: string;
}
