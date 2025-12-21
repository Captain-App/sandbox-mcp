import { Schema } from "effect";

/**
 * Valid run status values
 */
export const RunStatus = Schema.Literal("queued", "running", "completed", "failed", "retrying");
export type RunStatus = typeof RunStatus.Type;

/**
 * Result of a completed run
 */
export const RunResult = Schema.Struct({
	success: Schema.Boolean,
	output: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
	filesCreated: Schema.Array(Schema.String),
	filesModified: Schema.Array(Schema.String),
	commits: Schema.Array(Schema.String),
	branch: Schema.optional(Schema.String),
});
export type RunResult = typeof RunResult.Type;

/**
 * Complete run record stored in DO
 */
export const RunRecord = Schema.Struct({
	runId: Schema.String,
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

/**
 * Input for running a task
 */
export const RunTaskInput = Schema.Struct({
	sessionId: Schema.String,
	task: Schema.String.pipe(Schema.maxLength(50000)),
	model: Schema.optional(Schema.String),
});
export type RunTaskInput = typeof RunTaskInput.Type;

/**
 * Output from task initiation
 */
export const RunTaskOutput = Schema.Struct({
	runId: Schema.String,
	status: Schema.Literal("started"),
	webUiUrl: Schema.String,
	message: Schema.String,
});
export type RunTaskOutput = typeof RunTaskOutput.Type;

/**
 * Input for status check
 */
export const GetStatusInput = Schema.Struct({
	sessionId: Schema.String,
	runId: Schema.optional(Schema.String),
	includeGitStatus: Schema.optional(Schema.Boolean),
});
export type GetStatusInput = typeof GetStatusInput.Type;
