import { Schema } from "effect";
import * as Predicate from "effect/Predicate";

// Type ID for error identification
export const SessionErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/SessionError");
export type SessionErrorTypeId = typeof SessionErrorTypeId;

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

export type SessionError = SessionNotFoundError;

export const isSessionError = (u: unknown): u is SessionError =>
	Predicate.hasProperty(u, SessionErrorTypeId);

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
