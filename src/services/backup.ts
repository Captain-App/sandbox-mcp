// src/services/backup.ts
import { Context, Effect, Layer } from "effect";
import type { Sandbox } from "@cloudflare/sandbox";
import {
  BackupCreationError,
  BackupRestoreError,
  type BackupError,
} from "../models/errors";

/**
 * Backup service for OpenCode session persistence
 *
 * OpenCode stores session data in ~/.local/share/opencode/storage/
 * We backup this directory to R2 and restore on session resume.
 */
export interface BackupServiceInterface {
  /**
   * Backup OpenCode session data to R2
   */
  readonly backupSession: (
    sandbox: Sandbox<unknown>,
    sessionId: string
  ) => Effect.Effect<void, BackupCreationError>;

  /**
   * Restore OpenCode session data from R2
   * Returns true if backup existed and was restored
   */
  readonly restoreSession: (
    sandbox: Sandbox<unknown>,
    sessionId: string
  ) => Effect.Effect<boolean, BackupRestoreError>;

  /**
   * Check if session backup exists
   */
  readonly hasBackup: (
    sessionId: string
  ) => Effect.Effect<boolean, BackupError>;

  /**
   * Delete session backup
   */
  readonly deleteBackup: (
    sessionId: string
  ) => Effect.Effect<void, BackupCreationError>;
}

// --- Internal helper functions for decomposed operations ---

const createArchive = (sandbox: Sandbox<unknown>, sessionId: string) =>
  Effect.tryPromise({
    try: () =>
      sandbox.exec(
        `tar -czf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode storage 2>/dev/null || true`
      ),
    catch: (error) =>
      new BackupCreationError({
        sessionId,
        phase: "archive_creation",
        cause: String(error),
      }),
  });

const checkArchiveExists = (sandbox: Sandbox<unknown>, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await sandbox.exec(
        `test -f /tmp/opencode-backup.tar.gz && echo exists || echo missing`
      );
      return result.stdout.trim() === "exists";
    },
    catch: (error) =>
      new BackupCreationError({
        sessionId,
        phase: "archive_check",
        cause: String(error),
      }),
  });

const readArchiveAsBase64 = (sandbox: Sandbox<unknown>, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await sandbox.exec(
        `cat /tmp/opencode-backup.tar.gz | base64`
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr);
      }
      return result.stdout.trim();
    },
    catch: (error) =>
      new BackupCreationError({
        sessionId,
        phase: "archive_read",
        cause: String(error),
      }),
  });

const uploadToR2 = (
  bucket: R2Bucket,
  sessionId: string,
  base64Data: string
) =>
  Effect.tryPromise({
    try: async () => {
      // Decode base64 to Uint8Array
      const binaryString = atob(base64Data);
      const archiveBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        archiveBuffer[i] = binaryString.charCodeAt(i);
      }

      const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
      await bucket.put(key, archiveBuffer);
    },
    catch: (error) =>
      new BackupCreationError({
        sessionId,
        phase: "r2_upload",
        cause: String(error),
      }),
  });

const cleanupTempArchive = (sandbox: Sandbox<unknown>, sessionId: string) =>
  Effect.tryPromise({
    try: () => sandbox.exec("rm -f /tmp/opencode-backup.tar.gz"),
    catch: (error) =>
      new BackupCreationError({
        sessionId,
        phase: "cleanup",
        cause: String(error),
      }),
  });

const downloadFromR2 = (bucket: R2Bucket, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
      const object = await bucket.get(key);
      if (!object) {
        return null;
      }

      // Convert to base64
      const data = await object.arrayBuffer();
      const bytes = new Uint8Array(data);
      let binaryString = "";
      for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
      }
      return btoa(binaryString);
    },
    catch: (error) =>
      new BackupRestoreError({
        sessionId,
        phase: "r2_download",
        cause: String(error),
      }),
  });

const writeArchiveToSandbox = (
  sandbox: Sandbox<unknown>,
  sessionId: string,
  base64Data: string
) =>
  Effect.tryPromise({
    try: () =>
      sandbox.exec(
        `echo '${base64Data}' | base64 -d > /tmp/opencode-backup.tar.gz`
      ),
    catch: (error) =>
      new BackupRestoreError({
        sessionId,
        phase: "archive_write",
        cause: String(error),
      }),
  });

const extractArchive = (sandbox: Sandbox<unknown>, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      await sandbox.exec("mkdir -p ~/.local/share/opencode");
      const result = await sandbox.exec(
        "tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode"
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr);
      }
    },
    catch: (error) =>
      new BackupRestoreError({
        sessionId,
        phase: "archive_extract",
        cause: String(error),
      }),
  });

const cleanupTempArchiveRestore = (
  sandbox: Sandbox<unknown>,
  sessionId: string
) =>
  Effect.tryPromise({
    try: () => sandbox.exec("rm -f /tmp/opencode-backup.tar.gz"),
    catch: (error) =>
      new BackupRestoreError({
        sessionId,
        phase: "cleanup",
        cause: String(error),
      }),
  });

/**
 * Create backup service
 */
export const makeBackupService = (bucket: R2Bucket): BackupServiceInterface => ({
  backupSession: (sandbox, sessionId) =>
    Effect.gen(function* () {
      // Create archive (OK if no storage directory exists)
      yield* createArchive(sandbox, sessionId);

      // Check if archive was created
      const exists = yield* checkArchiveExists(sandbox, sessionId);
      if (!exists) {
        // No storage to backup - this is OK
        return;
      }

      // Read archive as base64
      const base64Data = yield* readArchiveAsBase64(sandbox, sessionId);

      // Upload to R2
      yield* uploadToR2(bucket, sessionId, base64Data);

      // Cleanup temp file
      yield* cleanupTempArchive(sandbox, sessionId);
    }),

  restoreSession: (sandbox, sessionId) =>
    Effect.gen(function* () {
      // Download from R2
      const base64Data = yield* downloadFromR2(bucket, sessionId);

      if (base64Data === null) {
        // No backup exists
        return false;
      }

      // Write archive to sandbox
      yield* writeArchiveToSandbox(sandbox, sessionId, base64Data);

      // Extract archive
      yield* extractArchive(sandbox, sessionId);

      // Cleanup temp file
      yield* cleanupTempArchiveRestore(sandbox, sessionId);

      return true;
    }),

  hasBackup: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        const head = await bucket.head(key);
        return head !== null;
      },
      catch: (error) =>
        new BackupCreationError({
          sessionId,
          phase: "head_check",
          cause: String(error),
        }),
    }),

  deleteBackup: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        await bucket.delete(key);
      },
      catch: (error) =>
        new BackupCreationError({
          sessionId,
          phase: "delete",
          cause: String(error),
        }),
    }),
});

/**
 * Backup service context tag
 */
export class BackupService extends Context.Tag("@sandbox-mcp/BackupService")<
  BackupService,
  BackupServiceInterface
>() {}

/**
 * Create backup service layer
 */
export const makeBackupLayer = (
  bucket: R2Bucket
): Layer.Layer<BackupService> =>
  Layer.succeed(BackupService, makeBackupService(bucket));
