// src/workflows/helpers/backup.ts
import { collectFile, type Sandbox } from "@cloudflare/sandbox";

/**
 * Restore OpenCode session state from R2 backup.
 * Uses base64 encoding for binary data transfer.
 */
export async function restoreSession(
  sandbox: Sandbox<unknown>,
  sessionId: string,
  bucket: R2Bucket,
): Promise<boolean> {
  const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
  const object = await bucket.get(key);

  if (!object) {
    return false;
  }

  // Convert ArrayBuffer to base64 for shell transfer
  const data = await object.arrayBuffer();
  const bytes = new Uint8Array(data);
  const base64Data = uint8ArrayToBase64(bytes);

  // Write base64 data and decode in sandbox
  // Split into chunks if very large to avoid command line limits
  const chunkSize = 100000; // ~100KB chunks
  if (base64Data.length > chunkSize) {
    await sandbox.exec("rm -f /tmp/opencode-backup.b64");
    for (let i = 0; i < base64Data.length; i += chunkSize) {
      const chunk = base64Data.slice(i, i + chunkSize);
      const res = await sandbox.exec(`printf '%s' '${chunk}' >> /tmp/opencode-backup.b64`);
      if (res.exitCode !== 0) throw new Error(`Failed to write backup chunk: ${res.stderr}`);
    }
    const decodeRes = await sandbox.exec(
      "base64 -d /tmp/opencode-backup.b64 > /tmp/opencode-backup.tar.gz",
    );
    if (decodeRes.exitCode !== 0) throw new Error(`Failed to decode backup: ${decodeRes.stderr}`);
    await sandbox.exec("rm -f /tmp/opencode-backup.b64");
  } else {
    const writeRes = await sandbox.exec(
      `echo '${base64Data}' | base64 -d > /tmp/opencode-backup.tar.gz`,
    );
    if (writeRes.exitCode !== 0) throw new Error(`Failed to write backup: ${writeRes.stderr}`);
  }

  await sandbox.exec("mkdir -p ~/.local/share/opencode");
  const tarRes = await sandbox.exec(
    "tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode",
  );
  if (tarRes.exitCode !== 0) throw new Error(`Failed to extract backup: ${tarRes.stderr}`);
  await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");

  return true;
}

/**
 * Backup OpenCode session state to R2.
 * Uses collectFile utility to properly handle SSE-wrapped binary streams.
 */
export async function backupSession(
  sandbox: Sandbox<unknown>,
  sessionId: string,
  bucket: R2Bucket,
): Promise<void> {
  // Create archive of OpenCode storage
  const archiveResult = await sandbox.exec(
    `tar -czf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode storage 2>/dev/null`,
  );

  if (archiveResult.exitCode !== 0) {
    throw new Error(`Failed to create backup archive: ${archiveResult.stderr}`);
  }

  // Check if archive was created
  const checkResult = await sandbox.exec(
    `test -f /tmp/opencode-backup.tar.gz && echo exists || echo missing`,
  );

  if (checkResult.stdout.trim() !== "exists") {
    throw new Error("Backup archive was not created (file missing)");
  }

  // Read file using collectFile utility which properly handles SSE-wrapped binary streams
  const fileStream = await sandbox.readFileStream("/tmp/opencode-backup.tar.gz");
  const { content } = await collectFile(fileStream);

  // content is Uint8Array for binary files
  const key = `sessions/${sessionId}/opencode-storage.tar.gz`;
  try {
    await bucket.put(key, content);
  } catch (error) {
    throw new Error(`Failed to upload backup to R2: ${error}`);
  }

  // Cleanup
  await sandbox.exec("rm -f /tmp/opencode-backup.tar.gz");
}

/**
 * Convert Uint8Array to base64 string (avoids btoa Unicode issues)
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
  }
  return btoa(chunks.join(""));
}
