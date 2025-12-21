// src/workflows/helpers/types.ts

/**
 * Parameters for task execution workflow.
 *
 * Uses proxy tokens instead of real credentials for zero-trust security.
 * The proxy validates JWT tokens and injects real credentials.
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
  /**
   * JWT proxy token for authenticated API calls.
   * Used for Anthropic, GitHub, and R2 access through the proxy.
   */
  proxyToken: string;
  /**
   * Base URL of the proxy (e.g., 'https://sandbox-mcp.workers.dev')
   */
  proxyBaseUrl: string;
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
 *
 * Simplified for zero-trust model - no secrets needed here.
 * All authentication is handled by the proxy using JWT tokens
 * passed in TaskParams.
 */
export interface WorkflowDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sandboxBinding: DurableObjectNamespace<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpAgentBinding: DurableObjectNamespace<any>;
  sessionsBucket: R2Bucket;
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
