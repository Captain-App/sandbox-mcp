import { Schema } from "effect";
import * as Predicate from "effect/Predicate";

// Type ID for error identification
export const SessionErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/SessionError");
export type SessionErrorTypeId = typeof SessionErrorTypeId;

export const StorageErrorTypeId: unique symbol = Symbol.for("@sandbox-mcp/StorageError");
export type StorageErrorTypeId = typeof StorageErrorTypeId;

export const SessionStorageErrorTypeId: unique symbol = Symbol.for(
  "@sandbox-mcp/SessionStorageError",
);
export type SessionStorageErrorTypeId = typeof SessionStorageErrorTypeId;

// --- Session Errors ---

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  { sessionId: Schema.String },
) {
  /** @public Used by isSessionError type guard */
  readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

  override get message(): string {
    return `Session "${this.sessionId}" not found`;
  }
}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()("RunNotFoundError", {
  runId: Schema.String,
}) {
  /** @public Used by isSessionError type guard */
  readonly [SessionErrorTypeId]: SessionErrorTypeId = SessionErrorTypeId;

  override get message(): string {
    return `Run "${this.runId}" not found`;
  }
}

type SessionError = SessionNotFoundError | RunNotFoundError;

export const isSessionError = (u: unknown): u is SessionError =>
  Predicate.hasProperty(u, SessionErrorTypeId);

// --- Storage Errors ---

export class StorageReadError extends Schema.TaggedError<StorageReadError>()("StorageReadError", {
  key: Schema.String,
  cause: Schema.String,
}) {
  /** @public Used by isStorageError type guard */
  readonly [StorageErrorTypeId]: StorageErrorTypeId = StorageErrorTypeId;

  override get message(): string {
    return `Failed to read key "${this.key}": ${this.cause}`;
  }
}

export class StorageWriteError extends Schema.TaggedError<StorageWriteError>()(
  "StorageWriteError",
  {
    key: Schema.String,
    cause: Schema.String,
  },
) {
  /** @public Used by isStorageError type guard */
  readonly [StorageErrorTypeId]: StorageErrorTypeId = StorageErrorTypeId;

  override get message(): string {
    return `Failed to write key "${this.key}": ${this.cause}`;
  }
}

type StorageError = StorageReadError | StorageWriteError;

export const isStorageError = (u: unknown): u is StorageError =>
  Predicate.hasProperty(u, StorageErrorTypeId);

// --- Session Storage Errors (R2) ---

/**
 * Error reading session from R2 storage
 */
export class SessionStorageReadError extends Schema.TaggedError<SessionStorageReadError>()(
  "SessionStorageReadError",
  {
    sessionId: Schema.String,
    cause: Schema.String,
  },
) {
  /** @public Used by isSessionStorageError type guard */
  readonly [SessionStorageErrorTypeId]: SessionStorageErrorTypeId = SessionStorageErrorTypeId;

  override get message(): string {
    return `Failed to read session "${this.sessionId}": ${this.cause}`;
  }
}

/**
 * Error writing session to R2 storage
 */
export class SessionStorageWriteError extends Schema.TaggedError<SessionStorageWriteError>()(
  "SessionStorageWriteError",
  {
    sessionId: Schema.String,
    cause: Schema.String,
  },
) {
  /** @public Used by isSessionStorageError type guard */
  readonly [SessionStorageErrorTypeId]: SessionStorageErrorTypeId = SessionStorageErrorTypeId;

  override get message(): string {
    return `Failed to write session "${this.sessionId}": ${this.cause}`;
  }
}

type SessionStorageError = SessionStorageReadError | SessionStorageWriteError;

export const isSessionStorageError = (u: unknown): u is SessionStorageError =>
  Predicate.hasProperty(u, SessionStorageErrorTypeId);
