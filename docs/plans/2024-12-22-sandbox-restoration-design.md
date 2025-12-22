# Sandbox Restoration Design

**Date:** 2024-12-22
**Status:** Ready for implementation

## Problem Statement

### Problems We're Solving

1. **Web UI doesn't restore sandbox state** - When accessing `/session/{id}/` after a container restart:
   - OpenCode backup isn't restored (conversation history lost)
   - Repository isn't re-cloned (ENOENT errors)
   - OpenCode starts in `/workspace` instead of `/workspace/{repo}`

2. **Command spam on every request** - `configureAnthropic()` and `configureGithub()` run on every web UI request, appending duplicate lines to `.env` and git config

3. **Dead code: R2 s3fs mounting** - `mountR2Storage()` is called but:
   - Nothing uses `/workspace/storage`
   - The s3fs mount fails anyway
   - Backups work via R2 binding, not s3fs

### Scope

**In scope:**
- Shared sandbox initialization helper (restore backup, clone repo, configure proxy)
- "Already initialized" detection via container state query
- Remove R2 mount dead code and `aws4fetch` dependency

**Out of scope:**
- Multi-repo support (stick with single `session.repository`)
- Any changes to backup/restore logic itself (it works)

## Architecture

### New Component: `ensureSandboxReady()`

A shared helper that both the **workflow** and **web UI** call to ensure the sandbox is in a usable state. It's idempotent - safe to call multiple times.

```
┌─────────────────┐     ┌─────────────────┐
│   MCP Workflow  │     │    Web UI       │
│ (execute-task)  │     │  (index.ts)     │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │  ensureSandboxReady() │
         │                       │
         │  1. Check state       │
         │  2. Restore backup    │
         │  3. Clone repo        │
         │  4. Configure proxy   │
         └───────────────────────┘
```

### State Detection Strategy

Rather than tracking a flag, we query actual container state:

| Check | How | Means "needs init" if... |
|-------|-----|-------------------------|
| OpenCode backup | `test -d ~/.local/share/opencode/storage` | Directory missing |
| Repository | `test -d /workspace/{repo}/.git` | Directory missing |
| Proxy config | `grep -q ANTHROPIC_BASE_URL /workspace/.env` | Not found or file missing |

If **any** check fails, we run the corresponding restoration step. This is self-healing.

## Interface Design

### Function Signature

```typescript
interface SandboxReadyParams {
  sandbox: Sandbox<unknown>;
  sessionId: string;
  bucket: R2Bucket;
  proxyBaseUrl: string;
  proxyToken: string;
  repository?: {
    url: string;
    branch: string;
  };
}

interface SandboxReadyResult {
  workspacePath: string;           // "/workspace" or "/workspace/{repo}"
  restoredBackup: boolean;         // Did we restore OpenCode state?
  clonedRepo: boolean;             // Did we clone the repo?
  configuredProxy: boolean;        // Did we configure proxy?
}

export async function ensureSandboxReady(
  params: SandboxReadyParams
): Promise<SandboxReadyResult>
```

### Logic Flow

```
ensureSandboxReady():
  result = { workspacePath: "/workspace", restoredBackup: false, clonedRepo: false, configuredProxy: false }

  // 1. Check & restore OpenCode backup
  if NOT exists ~/.local/share/opencode/storage:
    restored = await restoreSession(sandbox, sessionId, bucket)
    result.restoredBackup = restored

  // 2. Check & clone repository
  if repository provided:
    repoName = extractRepoName(repository.url)
    targetDir = "/workspace/{repoName}"
    
    if NOT exists {targetDir}/.git:
      await cloneRepository(sandbox, repository.url, repository.branch)
      result.clonedRepo = true
    
    result.workspacePath = targetDir

  // 3. Check & configure proxy
  if NOT (grep ANTHROPIC_BASE_URL /workspace/.env):
    await configureSandboxProxy(sandbox, proxyBaseUrl, proxyToken)
    await setupGitConfig(sandbox)
    result.configuredProxy = true

  return result
```

### Key Properties

1. **Idempotent** - Each step checks before acting, safe to call repeatedly
2. **Self-healing** - Partial state (repo exists but backup missing) is handled correctly
3. **Returns what it did** - Caller knows if restoration happened (useful for logging/telemetry)
4. **Reuses existing helpers** - `restoreSession()`, `cloneRepository()`, `configureSandboxProxy()` already exist

## Integration Points

### 1. Workflow Integration (`execute-task.ts`)

**Before (5 initialization steps):**
```
Step 1: configure-proxy
Step 2: create-run
Step 3: mount-storage        ← REMOVE (dead code)
Step 4: restore-session
Step 5: clone-repository
Step 6: execute-opencode-task
```

**After (2 initialization steps):**
```
Step 1: create-run           ← Move earlier (doesn't need sandbox)
Step 2: ensure-sandbox-ready ← New consolidated step
Step 3: execute-opencode-task
```

### 2. Web UI Integration (`index.ts`)

**Before:**
```typescript
async function proxyToSandbox(request, env, sessionId, targetPath) {
  // Runs EVERY request - causes command spam!
  await configureAnthropic(sandbox, containerProxyUrl, proxyToken);
  await configureGithub(sandbox, containerProxyUrl, proxyToken);
  
  const server = await createOpencodeServer(sandbox, {
    directory: "/workspace",  // WRONG - ignores workspacePath
  });
}
```

**After:**
```typescript
async function proxyToSandbox(request, env, sessionId, sessionMetadata, targetPath) {
  // Only initializes if needed - idempotent!
  const ready = await ensureSandboxReady({
    sandbox, sessionId, bucket, proxyBaseUrl, proxyToken,
    repository: sessionMetadata.repository,
  });
  
  const server = await createOpencodeServer(sandbox, {
    directory: ready.workspacePath,  // CORRECT
  });
}
```

## Dead Code Removal

### Files to Modify

| File | Change |
|------|--------|
| `src/proxy/services/r2.ts` | Delete entire file |
| `src/proxy/services/index.ts` | Remove r2 exports |
| `src/proxy/index.ts` | Remove r2 re-exports |
| `src/index.ts` | Remove `r2` from proxy services |
| `src/workflows/helpers/sandbox.ts` | Remove `mountR2Storage()` |
| `src/workflows/execute-task.ts` | Remove "mount-storage" step |
| `package.json` | Remove `aws4fetch` dependency |
| `.dev.vars.example` | Remove `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` |

### Verification

```bash
grep -r "mountR2Storage\|configureR2\|aws4fetch\|R2_ACCESS_KEY\|R2_SECRET\|R2_ENDPOINT" src/
# Should return no matches
```

## Implementation Order

| Phase | Task | Risk |
|-------|------|------|
| 1 | Remove R2 mount dead code | Low - unused code |
| 2 | Add `ensureSandboxReady()` in `sandbox.ts` | Low - new code |
| 3 | Update workflow to use `ensureSandboxReady()` | Medium - changes workflow |
| 4 | Update web UI to use `ensureSandboxReady()` | Medium - fixes the bug |
| 5 | Run tests, manual verification | - |

## Files Changed (Complete List)

| File | Change |
|------|--------|
| `src/workflows/helpers/sandbox.ts` | Add `ensureSandboxReady()`, remove `mountR2Storage()` |
| `src/workflows/execute-task.ts` | Consolidate steps, use `ensureSandboxReady()` |
| `src/index.ts` | Update `proxyToSandbox()`, remove `r2` from proxy |
| `src/proxy/services/r2.ts` | Delete file |
| `src/proxy/services/index.ts` | Remove r2 exports |
| `src/proxy/index.ts` | Remove r2 re-exports |
| `package.json` | Remove `aws4fetch` |
| `.dev.vars.example` | Remove R2 env vars |
