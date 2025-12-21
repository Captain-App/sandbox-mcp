// src/agent/tools.ts
import { z } from "zod";

/**
 * Session ID validation pattern (lowercase alphanumeric + hyphens)
 */
const sessionIdPattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Schema for opencode_create_session tool input
 */
export const createSessionInputSchema = z.object({
  sessionId: z
    .string()
    .regex(
      sessionIdPattern,
      "Session ID must be lowercase alphanumeric with hyphens"
    )
    .max(64)
    .optional()
    .describe("Unique session identifier. Auto-generated if not provided."),

  repositoryUrl: z
    .string()
    .startsWith("https://github.com/")
    .optional()
    .describe("GitHub repository URL to clone"),

  branch: z.string().optional().describe("Git branch to checkout. Defaults to main."),

  directory: z
    .string()
    .optional()
    .default("/workspace")
    .describe("Working directory path in the container. Defaults to '/workspace'."),

  title: z.string().optional().describe("Human-readable session title"),
});
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

/**
 * Schema for opencode_run_task tool input
 */
export const runTaskInputSchema = z.object({
  sessionId: z.string().describe("Session ID from opencode_create_session"),

  task: z.string().max(50000).describe("Natural language task description"),

  model: z
    .string()
    .optional()
    .describe("AI model to use. Defaults to claude-sonnet-4-20250514."),
});
export type RunTaskInput = z.infer<typeof runTaskInputSchema>;

/**
 * Schema for opencode_get_status tool input
 */
export const getStatusInputSchema = z.object({
  sessionId: z.string().describe("Session ID to query"),

  runId: z.string().optional().describe("Specific run ID to query"),

  includeGitStatus: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include git branch and commit info"),
});
export type GetStatusInput = z.infer<typeof getStatusInputSchema>;

/**
 * MCP tool response type - uses index signature for SDK compatibility
 */
export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{
    type: "text";
    text: string;
  }>;
}

/**
 * Format data as MCP tool response
 */
export const formatToolResponse = (data: unknown): ToolResponse => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(data, null, 2),
    },
  ],
});

/**
 * Format error as MCP tool response
 */
export const formatErrorResponse = (error: {
  code: string;
  message: string;
  details?: unknown;
}): ToolResponse => {
  const errorObj: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error.details !== undefined) {
    errorObj.details = error.details;
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: errorObj }, null, 2),
      },
    ],
  };
};
