import { Schema } from "effect";

/**
 * Shared validation constants - used by both Effect Schema and Zod schemas
 */
export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
export const SESSION_ID_MAX_LENGTH = 64;
export const GITHUB_URL_PREFIX = "https://github.com/";

/**
 * Valid session status values
 */
export const SessionStatus = Schema.Literal("creating", "active", "idle", "stopped", "error");
export type SessionStatus = typeof SessionStatus.Type;

/**
 * Session ID must be lowercase alphanumeric with hyphens, max 64 chars
 * Uses Schema.brand() for nominal typing - prevents mixing SessionId with plain strings
 */
export const SessionId = Schema.String.pipe(
	Schema.pattern(SESSION_ID_PATTERN),
	Schema.maxLength(SESSION_ID_MAX_LENGTH),
	Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

/**
 * Repository information for cloned repos (internal to SessionMetadata)
 */
const RepositoryInfo = Schema.Struct({
	url: Schema.String.pipe(
		Schema.startsWith(GITHUB_URL_PREFIX),
		Schema.annotations({ description: "GitHub repository URL" }),
	),
	branch: Schema.String.pipe(Schema.annotations({ description: "Git branch name" })),
});

/**
 * Session configuration (internal to SessionMetadata)
 */
const SessionConfig = Schema.Struct({
	defaultModel: Schema.String.pipe(
		Schema.annotations({ description: "Default AI model for OpenCode" }),
	),
});

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

