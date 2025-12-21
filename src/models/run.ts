import { Schema } from "effect";

/**
 * Shared validation constants
 */
export const TASK_MAX_LENGTH = 50000;

/**
 * Valid run status values
 */
const RunStatus = Schema.Literal("queued", "running", "completed", "failed", "retrying");

/**
 * Result of a completed run
 */
const RunResult = Schema.Struct({
  success: Schema.Boolean,
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  filesCreated: Schema.Array(Schema.String),
  filesModified: Schema.Array(Schema.String),
  commits: Schema.Array(Schema.String),
  branch: Schema.optional(Schema.String),
});

/**
 * Complete run record stored in DO
 */
export const RunRecord = Schema.Struct({
  runId: Schema.String, // Note: Stored as string in DB, branded type used for new IDs
  sessionId: Schema.String,
  workflowId: Schema.String,
  status: RunStatus,
  task: Schema.String,
  model: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  result: Schema.optional(RunResult),
  retryCount: Schema.Number,
  maxRetries: Schema.Number,
});
export type RunRecord = typeof RunRecord.Type;
