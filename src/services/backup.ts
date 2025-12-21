// src/services/backup.ts
import { Context, Effect, Layer } from "effect";
import type { Sandbox } from "@cloudflare/sandbox";

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
  ) => Effect.Effect<void, Error>;

  /**
   * Restore OpenCode session data from R2
   * Returns true if backup existed and was restored
   */
  readonly restoreSession: (
    sandbox: Sandbox<unknown>,
    sessionId: string
  ) => Effect.Effect<boolean, Error>;

  /**
   * Check if session backup exists
   */
  readonly hasBackup: (sessionId: string) => Effect.Effect<boolean, Error>;

  /**
   * Delete session backup
   */
  readonly deleteBackup: (sessionId: string) => Effect.Effect<void, Error>;
}

/**
 * Create backup service
 */
export const makeBackupService = (bucket: R2Bucket): BackupServiceInterface => ({
  backupSession: (sandbox, sessionId) =>
    Effect.tryPromise({
      try: async () => {
        // Archive OpenCode storage directory
        const archiveResult = await sandbox.exec(
          `tar -czf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode storage 2>/dev/null || true`
        );

        if (archiveResult.exitCode !== 0) {
          // No storage directory yet, nothing to backup
          return;
        }

        // Check if archive was created
        const checkResult = await sandbox.exec(
          `test -f /tmp/opencode-backup.tar.gz && echo exists || echo missing`
        );

        if (checkResult.stdout.trim() !== "exists") {
          // No storage to backup
          return;
        }

        // Read archive content as base64
        const catResult = await sandbox.exec(
          `cat /tmp/opencode-backup.tar.gz | base64`
        );

        if (catResult.exitCode !== 0) {
          throw new Error(`Failed to read backup archive: ${catResult.stderr}`);
        }

        // Decode base64 to Uint8Array
        const base64Data = catResult.stdout.trim();
        const binaryString = atob(base64Data);
        const archiveBuffer = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          archiveBuffer[i] = binaryString.charCodeAt(i);
        }

        // Upload to R2
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        await bucket.put(key, archiveBuffer);

        // Cleanup
        await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");
      },
      catch: (error) => new Error(`Backup failed: ${error}`),
    }),

  restoreSession: (sandbox, sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;

        // Check if backup exists
        const object = await bucket.get(key);
        if (!object) {
          return false;
        }

        // Download backup and convert to base64
        const data = await object.arrayBuffer();
        const bytes = new Uint8Array(data);
        let binaryString = "";
        for (let i = 0; i < bytes.length; i++) {
          binaryString += String.fromCharCode(bytes[i]);
        }
        const base64Data = btoa(binaryString);

        // Write to sandbox via base64
        await sandbox.exec(
          `echo '${base64Data}' | base64 -d > /tmp/opencode-backup.tar.gz`
        );

        // Create storage directory
        await sandbox.exec("mkdir -p ~/.local/share/opencode");

        // Extract backup
        const extractResult = await sandbox.exec(
          "tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode"
        );

        if (extractResult.exitCode !== 0) {
          throw new Error(`Failed to extract backup: ${extractResult.stderr}`);
        }

        // Cleanup
        await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");

        return true;
      },
      catch: (error) => new Error(`Restore failed: ${error}`),
    }),

  hasBackup: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        const head = await bucket.head(key);
        return head !== null;
      },
      catch: (error) => new Error(`Backup check failed: ${error}`),
    }),

  deleteBackup: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
        await bucket.delete(key);
      },
      catch: (error) => new Error(`Delete backup failed: ${error}`),
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
