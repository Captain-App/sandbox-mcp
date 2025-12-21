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
  /** Summary text from the AI's response */
  output?: string;
  /** Detailed tool outputs (bash commands, file edits, etc.) */
  toolOutputs?: Array<{
    tool: string;
    title?: string;
    output?: string;
  }>;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
  /** Token usage from the LLM */
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
  };
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

/**
 * Tool state in OpenCode response
 */
interface OpenCodeToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Part types in OpenCode response
 */
export interface OpenCodePart {
  type: string;
  text?: string;
  tool?: string;
  state?: OpenCodeToolState;
}

/**
 * Assistant message info
 */
interface OpenCodeAssistantInfo {
  id: string;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
  };
  cost?: number;
  finish?: string;
  error?: {
    name: string;
    data: { message: string };
  };
}

export interface OpenCodePromptResponse {
  data?: {
    info?: OpenCodeAssistantInfo;
    parts?: OpenCodePart[];
  };
}

/**
 * Result of OpenCode task execution
 */
export interface OpenCodeTaskResult {
  success: boolean;
  /** Summary text from the AI's response */
  output: string;
  /** Detailed tool outputs (bash commands, file edits, etc.) */
  toolOutputs: Array<{
    tool: string;
    title?: string;
    output?: string;
  }>;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  commits: string[];
  branch?: string;
  /** Token usage from the LLM */
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
  };
}
