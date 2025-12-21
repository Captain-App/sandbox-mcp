// src/workflows/helpers/git.ts
import type { Sandbox } from "@cloudflare/sandbox";

import type { GitStatus } from "./types";

/**
 * Get git status information from a directory
 *
 * @param sandbox - The sandbox instance
 * @param directory - The git repository directory
 */
export async function getStatus(sandbox: Sandbox<unknown>, directory: string): Promise<GitStatus> {
  try {
    // Get current branch
    const branchResult = await sandbox.exec(
      `git -C ${directory} rev-parse --abbrev-ref HEAD 2>/dev/null || echo main`,
    );

    // Get recent commits (just the short hashes)
    const logResult = await sandbox.exec(
      `git -C ${directory} log --oneline -5 2>/dev/null || echo ''`,
    );

    // Get changed files - handle repos with 0-1 commits
    // First check commit count, then diff appropriately
    const countResult = await sandbox.exec(
      `git -C ${directory} rev-list --count HEAD 2>/dev/null || echo 0`,
    );
    const commitCount = parseInt(countResult.stdout.trim(), 10) || 0;

    let filesModified: string[] = [];
    if (commitCount > 1) {
      // Normal case: diff against previous commit
      const diffResult = await sandbox.exec(
        `git -C ${directory} diff --name-only HEAD~1 2>/dev/null || echo ''`,
      );
      filesModified = diffResult.stdout.trim().split("\n").filter(Boolean);
    } else if (commitCount === 1) {
      // Single commit: show all files in that commit
      const diffResult = await sandbox.exec(
        `git -C ${directory} diff --name-only --root HEAD 2>/dev/null || echo ''`,
      );
      filesModified = diffResult.stdout.trim().split("\n").filter(Boolean);
    }
    // If 0 commits, filesModified stays empty

    return {
      branch: branchResult.stdout.trim(),
      commits: logResult.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[0]),
      filesModified,
    };
  } catch {
    return {
      branch: "main",
      commits: [],
      filesModified: [],
    };
  }
}
