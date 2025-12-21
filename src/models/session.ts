import { Schema } from "effect";

/**
 * Valid session status values
 */
export const SessionStatus = Schema.Literal("creating", "active", "idle", "stopped", "error");
export type SessionStatus = typeof SessionStatus.Type;

/**
 * Session ID must be lowercase alphanumeric with hyphens, max 64 chars
 */
export const SessionId = Schema.String.pipe(
	Schema.pattern(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),
	Schema.maxLength(64),
	Schema.annotations({ identifier: "SessionId" }),
);
export type SessionId = typeof SessionId.Type;

/**
 * Repository information for cloned repos
 */
export const RepositoryInfo = Schema.Struct({
	url: Schema.String.pipe(
		Schema.startsWith("https://github.com/"),
		Schema.annotations({ description: "GitHub repository URL" }),
	),
	branch: Schema.String.pipe(Schema.annotations({ description: "Git branch name" })),
});
export type RepositoryInfo = typeof RepositoryInfo.Type;

/**
 * Session configuration
 */
export const SessionConfig = Schema.Struct({
	defaultModel: Schema.String.pipe(
		Schema.annotations({ description: "Default AI model for OpenCode" }),
	),
});
export type SessionConfig = typeof SessionConfig.Type;

/**
 * Complete session metadata stored in DO
 */
export const SessionMetadata = Schema.Struct({
	sessionId: SessionId,
	sandboxId: Schema.String,
	createdAt: Schema.Number.pipe(Schema.annotations({ description: "Unix timestamp of creation" })),
	lastActivity: Schema.Number.pipe(
		Schema.annotations({ description: "Unix timestamp of last activity" }),
	),
	status: SessionStatus,
	workspacePath: Schema.String,
	webUiUrl: Schema.String,
	repository: Schema.optional(RepositoryInfo),
	title: Schema.optional(Schema.String),
	config: SessionConfig,
});
export type SessionMetadata = typeof SessionMetadata.Type;

/**
 * Input for creating a new session
 */
export const CreateSessionInput = Schema.Struct({
	sessionId: Schema.optional(SessionId),
	repositoryUrl: Schema.optional(Schema.String.pipe(Schema.startsWith("https://github.com/"))),
	branch: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
});
export type CreateSessionInput = typeof CreateSessionInput.Type;

/**
 * Output from session creation
 */
export const CreateSessionOutput = Schema.Struct({
	sessionId: Schema.String,
	sandboxId: Schema.String,
	webUiUrl: Schema.String,
	status: Schema.Literal("created", "resumed"),
	workspacePath: Schema.String,
	repository: Schema.optional(RepositoryInfo),
});
export type CreateSessionOutput = typeof CreateSessionOutput.Type;
