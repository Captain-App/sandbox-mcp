import { Schema } from "effect";
import * as Predicate from "effect/Predicate";

// Type ID for error identification
export const SessionErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/SessionError");
export type SessionErrorTypeId = typeof SessionErrorTypeId;

export const SandboxErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/SandboxError");
export type SandboxErrorTypeId = typeof SandboxErrorTypeId;

export const WorkflowErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/WorkflowError");
export type WorkflowErrorTypeId = typeof WorkflowErrorTypeId;

export const OpenCodeErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/OpenCodeError");
export type OpenCodeErrorTypeId = typeof OpenCodeErrorTypeId;

export const StorageErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/StorageError");
export type StorageErrorTypeId = typeof StorageErrorTypeId;

// --- Session Errors ---

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
	"SessionNotFoundError",
	{ sessionId: Schema.String },
) {
	readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

	override get message(): string {
		return `Session "${this.sessionId}" not found`;
	}
}

export class SessionCreationError extends Schema.TaggedError<SessionCreationError>()(
	"SessionCreationError",
	{
		sessionId: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

	override get message(): string {
		return `Failed to create session "${this.sessionId}": ${this.cause}`;
	}
}

export class InvalidSessionIdError extends Schema.TaggedError<InvalidSessionIdError>()(
	"InvalidSessionIdError",
	{
		sessionId: Schema.String,
		reason: Schema.String,
	},
) {
	readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

	override get message(): string {
		return `Invalid session ID "${this.sessionId}": ${this.reason}`;
	}
}

export type SessionError = SessionNotFoundError | SessionCreationError | InvalidSessionIdError;

export const isSessionError = (u: unknown): u is SessionError =>
	Predicate.hasProperty(u, SessionErrorTypeId);

// --- Sandbox Errors ---

export class SandboxStartupError extends Schema.TaggedError<SandboxStartupError>()(
	"SandboxStartupError",
	{
		sandboxId: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;

	override get message(): string {
		return `Sandbox "${this.sandboxId}" failed to start: ${this.cause}`;
	}
}

export class SandboxConnectionError extends Schema.TaggedError<SandboxConnectionError>()(
	"SandboxConnectionError",
	{
		sandboxId: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;

	override get message(): string {
		return `Lost connection to sandbox "${this.sandboxId}": ${this.cause}`;
	}
}

export class R2MountError extends Schema.TaggedError<R2MountError>()("R2MountError", {
	sessionId: Schema.String,
	mountPath: Schema.String,
	cause: Schema.String,
}) {
	readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;

	override get message(): string {
		return `Failed to mount R2 at "${this.mountPath}" for session "${this.sessionId}": ${this.cause}`;
	}
}

export class RepositoryCloneError extends Schema.TaggedError<RepositoryCloneError>()(
	"RepositoryCloneError",
	{
		url: Schema.String,
		branch: Schema.optional(Schema.String),
		cause: Schema.String,
	},
) {
	readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId;

	override get message(): string {
		const branchInfo = this.branch ? ` (branch: ${this.branch})` : "";
		return `Failed to clone repository "${this.url}"${branchInfo}: ${this.cause}`;
	}
}

export type SandboxError =
	| SandboxStartupError
	| SandboxConnectionError
	| R2MountError
	| RepositoryCloneError;

export const isSandboxError = (u: unknown): u is SandboxError =>
	Predicate.hasProperty(u, SandboxErrorTypeId);

// --- OpenCode Errors ---

export class OpenCodeStartupError extends Schema.TaggedError<OpenCodeStartupError>()(
	"OpenCodeStartupError",
	{ cause: Schema.String },
) {
	readonly [OpenCodeErrorTypeId]: OpenCodeErrorTypeId = OpenCodeErrorTypeId;

	override get message(): string {
		return `OpenCode server failed to start: ${this.cause}`;
	}
}

export class OpenCodeExecutionError extends Schema.TaggedError<OpenCodeExecutionError>()(
	"OpenCodeExecutionError",
	{
		sessionId: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [OpenCodeErrorTypeId]: OpenCodeErrorTypeId = OpenCodeErrorTypeId;

	override get message(): string {
		return `OpenCode task execution failed for session "${this.sessionId}": ${this.cause}`;
	}
}

export class OpenCodeTimeoutError extends Schema.TaggedError<OpenCodeTimeoutError>()(
	"OpenCodeTimeoutError",
	{
		sessionId: Schema.String,
		timeoutMinutes: Schema.Number,
	},
) {
	readonly [OpenCodeErrorTypeId]: OpenCodeErrorTypeId = OpenCodeErrorTypeId;

	override get message(): string {
		return `OpenCode task timed out after ${this.timeoutMinutes} minutes for session "${this.sessionId}"`;
	}
}

export type OpenCodeError = OpenCodeStartupError | OpenCodeExecutionError | OpenCodeTimeoutError;

export const isOpenCodeError = (u: unknown): u is OpenCodeError =>
	Predicate.hasProperty(u, OpenCodeErrorTypeId);

// --- Workflow Errors ---

export class WorkflowCreationError extends Schema.TaggedError<WorkflowCreationError>()(
	"WorkflowCreationError",
	{
		runId: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [WorkflowErrorTypeId]: WorkflowErrorTypeId = WorkflowErrorTypeId;

	override get message(): string {
		return `Failed to create workflow for run "${this.runId}": ${this.cause}`;
	}
}

export class WorkflowExecutionError extends Schema.TaggedError<WorkflowExecutionError>()(
	"WorkflowExecutionError",
	{
		runId: Schema.String,
		step: Schema.String,
		cause: Schema.String,
	},
) {
	readonly [WorkflowErrorTypeId]: WorkflowErrorTypeId = WorkflowErrorTypeId;

	override get message(): string {
		return `Workflow step "${this.step}" failed for run "${this.runId}": ${this.cause}`;
	}
}

export type WorkflowError = WorkflowCreationError | WorkflowExecutionError;

export const isWorkflowError = (u: unknown): u is WorkflowError =>
	Predicate.hasProperty(u, WorkflowErrorTypeId);

// --- Storage Errors ---

export class StorageReadError extends Schema.TaggedError<StorageReadError>()("StorageReadError", {
	key: Schema.String,
	cause: Schema.String,
}) {
	readonly [StorageErrorTypeId]: StorageErrorTypeId = StorageErrorTypeId;

	override get message(): string {
		return `Failed to read key "${this.key}": ${this.cause}`;
	}
}

export class StorageWriteError extends Schema.TaggedError<StorageWriteError>()("StorageWriteError", {
	key: Schema.String,
	cause: Schema.String,
}) {
	readonly [StorageErrorTypeId]: StorageErrorTypeId = StorageErrorTypeId;

	override get message(): string {
		return `Failed to write key "${this.key}": ${this.cause}`;
	}
}

export type StorageError = StorageReadError | StorageWriteError;

export const isStorageError = (u: unknown): u is StorageError =>
	Predicate.hasProperty(u, StorageErrorTypeId);
