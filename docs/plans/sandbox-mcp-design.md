# OpenCode Sandbox MCP Server - Design Document

## Table of Contents
- [Problem Statement](#problem-statement)
- [Background & Context](#background--context)
- [Goals & Non-Goals](#goals--non-goals)
- [Architecture Overview](#architecture-overview)
- [Detailed Design](#detailed-design)
- [Tool Specifications](#tool-specifications)
- [Data Model](#data-model)
- [Lifecycle & State Management](#lifecycle--state-management)
- [Error Handling](#error-handling)
- [Security Considerations](#security-considerations)
- [Cost Considerations](#cost-considerations)
- [Future Enhancements](#future-enhancements)
- [References](#references)

---

## Problem Statement

### The Challenge

When using AI assistants on mobile devices (Claude, Poke, etc.), there's no way to delegate complex, multi-step coding tasks that require:
- Cloning repositories
- Making code changes across multiple files
- Running tests and builds
- Creating pull requests
- Long-running execution (minutes to hours)

Current limitations:
1. **No execution environment**: Mobile AI apps can't execute code or run commands
2. **Session constraints**: Most tool calls have 60-second timeouts
3. **No persistence**: Can't maintain state across disconnections
4. **No visibility**: Can't "check in" on progress of long-running tasks

### User Story

> "I'm on my phone during my commute. I want to tell Claude: 'Clone my repo and implement feature X, then create a PR.' I should be able to come back 30 minutes later and ask 'How's it going?' or jump into a web UI to see what's happening."

### What We're Building

An MCP server that exposes OpenCode (an autonomous AI coding agent) running in Cloudflare Sandboxes, enabling:
- **Async task delegation**: Fire-and-forget coding tasks
- **Persistent sessions**: Survive network disconnections and device switches
- **Progress visibility**: Check status anytime or watch via web UI
- **Full autonomy**: OpenCode handles all the complexity independently

---

## Background & Context

### Key Technologies

#### OpenCode
- **What**: Open-source autonomous AI coding agent
- **Capabilities**: 
  - Full filesystem access with LSP support
  - Git operations and GitHub CLI integration
  - Multi-session parallel work
  - Web UI for interactive debugging
  - Built-in tool system for file operations, command execution
- **Architecture**: Client/server model with event bus
- **Agency**: Fully autonomous - makes decisions without user intervention

#### Cloudflare Sandbox SDK
- **What**: Secure, isolated Linux container execution at the edge
- **Architecture**: Workers → Durable Objects → Containers (3-layer)
- **Features**:
  - VM-based isolation
  - File operations, process management, port exposure
  - Git checkout and repository cloning
  - R2 bucket mounting for persistence
  - First-class OpenCode integration (`@cloudflare/sandbox/opencode`)
- **Lifecycle**: Containers sleep after 10min inactivity by default

#### Cloudflare Workflows
- **What**: Durable, long-running task orchestration
- **Features**:
  - Run for minutes to weeks
  - Automatic retries and state persistence
  - Survive crashes and restarts
  - Built for async operations
- **Trade-offs**: Seconds of startup latency (acceptable for our use case)

#### Cloudflare Agents SDK (MCP)
- **What**: SDK for building MCP servers on Cloudflare Workers
- **Two modes**:
  - **Stateless (Worker)**: Simple tools, no persistence
  - **Stateful (McpAgent/DO)**: Persistent state, long-running sessions
- **Transport**: Automatic SSE + HTTP POST handling

#### Model Context Protocol (MCP)
- **What**: Standard protocol for AI-tool communication
- **Tool Pattern**: AI invokes tools, receives structured responses
- **Clients**: Claude Desktop, Poke, and other AI applications
- **MCP Elicitation**: Allows servers to ask users questions mid-execution
  - **Decision**: NOT using this - OpenCode is designed for autonomous operation

### Key Constraints & Design Insights

#### Durable Objects Lifecycle (Critical Understanding)
From production experience and Cloudflare documentation:

1. **Activity-based eviction**: DOs are evicted after 70-140 seconds of inactivity
2. **"Activity" = incoming requests**: Only RPC calls, fetch requests, WebSocket messages count
3. **In-container work doesn't count**: Running processes inside the container doesn't prevent DO eviction
4. **`waitUntil()` doesn't work in DOs**: It's a no-op (unlike in Workers)
5. **Hibernation conditions**: DOs can hibernate after 10s if no setTimeout/fetch/WebSocket active

**Implication**: We cannot rely on Durable Objects alone for long-running tasks. This is why we need Workflows.

#### OpenCode Behavior
- **Autonomous**: Doesn't require human input mid-execution (no need for MCP elicitation)
- **Session-based**: Maintains context across multiple interactions
- **Two interaction modes**:
  1. Programmatic SDK: `client.session.prompt()` API
  2. Web UI: Browser-based interactive interface
- **No built-in pause/resume**: Makes decisions and completes tasks end-to-end

#### Sandbox Persistence Strategy
- **Ephemeral disk**: Container filesystem is lost on shutdown
- **R2 mounting**: Mount S3-compatible buckets as local directories
  - Files written to mount point automatically persist to R2
  - Survives container restarts
  - Mount same bucket = instant state recovery

---

## Goals & Non-Goals

### Goals

#### Primary Goals
1. **Async task execution**: User can start a task and disconnect
2. **Persistent sessions**: Sessions survive sandbox restarts, network issues, device switches
3. **Progress visibility**: Check status anytime or observe via web UI
4. **Autonomous operation**: OpenCode works independently without user intervention
5. **Mobile-first UX**: Optimized for on-the-go usage with limited connectivity

#### Secondary Goals
1. **Multiple concurrent sessions**: User can have several projects/tasks in flight
2. **Cost efficiency**: Sandboxes sleep when idle, only pay for active usage
3. **Reliability**: Automatic retries, graceful error handling
4. **Simplicity**: Minimal configuration, works out of the box

### Non-Goals

1. **Real-time streaming**: Not exposing OpenCode's internal progress stream to MCP
2. **Multi-user support**: V1 is personal use (single GitHub account)
3. **Advanced scheduling**: No cron jobs or recurring tasks
4. **Interactive debugging**: Use web UI for that, not MCP tools
5. **Cost optimization**: Not implementing aggressive resource management in V1
6. **Custom OpenCode configuration**: Using default OpenCode settings initially

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Client                               │
│                  (Claude Desktop, Poke, etc.)                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ MCP Protocol (SSE + HTTP)
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                   MCP Server (Worker + DO)                       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │          McpAgent (Durable Object)                      │   │
│  │  - Handles MCP protocol (tools)                         │   │
│  │  - Manages session metadata & state                     │   │
│  │  - Coordinates Workflows + Sandboxes                    │   │
│  │  - Provides status queries                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                    Spawns   │   Queries                          │
│                             │                                    │
│  ┌─────────────────────────▼──────────────┐                     │
│  │     Workflow (Long-running task)       │                     │
│  │  - Executes OpenCode task              │                     │
│  │  - Handles retries & resumption        │                     │
│  │  - Survives crashes                    │                     │
│  └─────────────────────────┬──────────────┘                     │
└────────────────────────────┼────────────────────────────────────┘
                             │ Calls SDK
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                  Sandbox (Container)                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              OpenCode Agent                              │  │
│  │  - Autonomous coding agent                               │  │
│  │  - Full filesystem access                                │  │
│  │  - Git operations, gh CLI                                │  │
│  │  - Web UI on port 4096                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                             │                                    │
│                             │ Mounts                             │
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────┐   │
│  │           /workspace (R2 Mount)                          │   │
│  │  - Persistent file storage                               │   │
│  │  - Survives container restarts                           │   │
│  │  - Prefix: /session-{id}/workspace/                      │   │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                             │
                             │ Stores files
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                 R2 Bucket: opencode-sessions                     │
│                                                                  │
│  /session-abc123/workspace/     (session 1 files)               │
│  /session-xyz789/workspace/     (session 2 files)               │
│  /session-def456/workspace/     (session 3 files)               │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

#### 1. McpAgent (Durable Object)
**Role**: MCP protocol handler and session coordinator

**Responsibilities**:
- Handle MCP tool calls (`opencode_create_session`, `opencode_run_task`, `opencode_get_status`)
- Maintain session metadata in DO storage
- Spawn and track Workflows for task execution
- Provide session status and recent activity
- Generate and return web UI URLs
- Manage session lifecycle (create, query, destroy)

**Does NOT**:
- Execute long-running tasks directly (delegates to Workflow)
- Interact with OpenCode directly (Workflow handles this)
- Manage sandbox lifecycle directly (uses Sandbox SDK)

#### 2. Workflow
**Role**: Long-running task executor

**Responsibilities**:
- Execute OpenCode tasks asynchronously
- Interact with Sandbox/OpenCode via SDK
- Handle retries on transient failures (up to 3 attempts)
- Report completion/failure back to DO
- Maintain task execution state
- Timeout after 1 hour (configurable)

**Does NOT**:
- Handle MCP protocol (that's DO's job)
- Manage multiple tasks concurrently (one Workflow per task)
- Persist session state (that's in R2 + DO)

#### 3. Sandbox (Container)
**Role**: Isolated execution environment for OpenCode

**Responsibilities**:
- Run OpenCode agent autonomously
- Provide filesystem via R2 mount
- Execute git operations with authenticated credentials
- Expose web UI on port 4096
- Handle process management
- Auto-sleep after 10min inactivity (no explicit cleanup needed)

**Does NOT**:
- Know about MCP protocol
- Track task status (Workflow does this)
- Handle retries (Workflow responsibility)

#### 4. R2 Storage
**Role**: Persistent file storage

**Responsibilities**:
- Store all workspace files across container restarts
- Provide isolated namespaces per session (via prefixes)
- Enable instant state recovery on sandbox restart

**Structure**:
```
opencode-sessions/
  session-{id}/
    workspace/          # Mounted to /workspace in container
      .git/
      src/
      package.json
      ...
```

---

## Detailed Design

### Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session Creation                              │
└─────────────────────────────────────────────────────────────────┘
    opencode_create_session({
      session_id: "feature-auth",
      repository_url: "https://github.com/user/repo",
      directory: "/workspace"
    })
              │
              ▼
    ┌─────────────────────────────────────┐
    │ Create/Get DO for session           │
    │ (idFromName = session_id)           │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Get Sandbox (sandbox_id = session_id│
    │ same as session for 1:1 mapping)    │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Mount R2 bucket with prefix         │
    │ /session-{id}/workspace/ → /workspace
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Set sandbox environment variables   │
    │ - GITHUB_TOKEN                      │
    │ - GIT_AUTHOR_NAME                   │
    │ - GIT_AUTHOR_EMAIL                  │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Clone repository (if URL provided)  │
    │ await sandbox.gitCheckout(...)      │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Start OpenCode server               │
    │ await createOpencodeServer(...)     │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Expose web UI port                  │
    │ url = sandbox.exposePort(4096)      │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Store session metadata in DO        │
    │ - session_id, sandbox_id            │
    │ - web_ui_url, created_at            │
    │ - repository_url, workspace_path    │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    Return: {
      session_id, sandbox_id, web_ui_url,
      status: "created", workspace_path
    }

┌─────────────────────────────────────────────────────────────────┐
│                      Task Execution                              │
└─────────────────────────────────────────────────────────────────┘
    opencode_run_task({
      session_id: "feature-auth",
      task: "Add JWT authentication to the API"
    })
              │
              ▼
    ┌─────────────────────────────────────┐
    │ Validate session exists in DO       │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Generate run_id (UUID)              │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Create Workflow for task            │
    │ workflow = await env.WORKFLOW.create│
    │   { id: run_id,                     │
    │     params: {session_id, task} }    │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Store run metadata in DO            │
    │ runs[run_id] = {                    │
    │   workflow_id, status: "running",   │
    │   started_at, task_description      │
    │ }                                   │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    Return IMMEDIATELY: {
      run_id, status: "started",
      web_ui_url,
      message: "Task started. Check status 
               anytime or visit web UI."
    }

    ┌─────────────────────────────────────┐
    │        Workflow Executes            │
    │        (Async, in background)       │
    └─────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────────────────────┐
    │ Get sandbox instance                │
    │ sandbox = getSandbox(...)           │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Get OpenCode SDK client             │
    │ { client } = await createOpencode() │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Get or create OpenCode session      │
    │ session = await client.session      │
    │   .create() OR .get()               │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Send task prompt to OpenCode        │
    │ result = await client.session.prompt
    │   { body: { parts: [{ text: task }]}
    └─────────────┬───────────────────────┘
                  │
                  │ (OpenCode works autonomously,
                  │  may take minutes/hours)
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Extract result from response        │
    │ Parse result.data.parts             │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Update DO with completion status    │
    │ (via RPC call back to DO)           │
    │ markRunComplete(run_id, result)     │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    Workflow completes

┌─────────────────────────────────────────────────────────────────┐
│                     Status Check                                 │
└─────────────────────────────────────────────────────────────────┘
    opencode_get_status({
      session_id: "feature-auth",
      run_id: "run-abc123" (optional)
    })
              │
              ▼
    ┌─────────────────────────────────────┐
    │ Get session metadata from DO        │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Check sandbox status                │
    │ - active / idle / stopped           │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Get git status (if sandbox active)  │
    │ - current branch                    │
    │ - recent commits                    │
    │ - uncommitted changes               │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────┐
    │ Get recent runs from DO storage     │
    │ - List all runs with status         │
    │ - Include workflow status           │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    If specific run_id provided:
    ┌─────────────────────────────────────┐
    │ Query Workflow status               │
    │ workflow.getStatus(run_id)          │
    │ - running / completed / failed      │
    │ - result (if completed)             │
    └─────────────┬───────────────────────┘
                  │
                  ▼
    Return: {
      session_id, web_ui_url,
      sandbox_status, workspace_path,
      git_status: { branch, commits, dirty },
      recent_runs: [ ... ],
      last_activity: timestamp,
      
      // If run_id specified:
      run_status: { run_id, status, result }
    }
```

### Persistence Strategy

#### What's Stored Where

**Durable Object Storage (DO.ctx.storage)**:
- Session metadata:
  - `session_id`, `sandbox_id`, `created_at`
  - `repository_url`, `workspace_path`
  - `web_ui_url` (current)
- Run tracking:
  - `runs[run_id]` = `{ workflow_id, status, started_at, completed_at, task, result }`
- Configuration:
  - Any session-specific settings

**R2 Storage**:
- All workspace files
- Git repository contents
- Build artifacts, node_modules, etc.
- Anything written to `/workspace` in the container

**Workflow State** (managed by Workflows platform):
- Task execution progress
- Retry attempts
- Workflow-specific variables

**Ephemeral (in-memory, lost on restart)**:
- Sandbox process state
- OpenCode conversation history (unless persisted by OpenCode itself)
- Active network connections

#### State Recovery After Restart

**Scenario**: Sandbox dies, user comes back 2 hours later

1. **User calls `opencode_get_status`**
2. **DO still has session metadata** (DOs are durable)
3. **Sandbox is stopped** → Will be restarted on next access
4. **R2 has all files** → Mount same bucket with same prefix
5. **Workflow state** → Query Workflow API for task status
6. **Git history** → Intact in R2, can see what was done

**Recovery steps**:
```typescript
// DO detects sandbox is stopped
if (sandboxStatus === 'stopped') {
  // Re-mount same R2 bucket
  await sandbox.mountBucket('opencode-sessions', '/workspace', {
    prefix: `session-${sessionId}/workspace/`
  });
  
  // Re-expose web UI
  const newUrl = await sandbox.exposePort(4096);
  await this.updateSessionMetadata({ web_ui_url: newUrl });
}

// Files are automatically restored from R2
// Git history is intact
// Can resume work immediately
```

---

## Tool Specifications

### Tool 1: `opencode_create_session`

**Purpose**: Create or resume an OpenCode coding session in a sandbox

**Input Schema**:
```json
{
  "session_id": {
    "type": "string",
    "description": "Unique identifier for this session. Use a descriptive name like 'feature-auth' or 'bugfix-parser'. If resuming an existing session, use the same ID.",
    "required": false
  },
  "repository_url": {
    "type": "string",
    "description": "GitHub repository URL to clone (e.g., 'https://github.com/user/repo'). Optional - omit if resuming existing session or working with existing files.",
    "required": false
  },
  "branch": {
    "type": "string",
    "description": "Git branch to checkout after cloning. Defaults to repository's default branch.",
    "required": false
  },
  "directory": {
    "type": "string",
    "description": "Working directory path in the container. Defaults to '/workspace'.",
    "required": false,
    "default": "/workspace"
  },
  "title": {
    "type": "string",
    "description": "Human-readable title for this session (e.g., 'Add authentication feature'). Used for display purposes only.",
    "required": false
  }
}
```

**Output Schema**:
```json
{
  "session_id": "string - The session identifier",
  "sandbox_id": "string - The sandbox instance identifier",
  "web_ui_url": "string - URL to access OpenCode web interface",
  "status": "string - 'created' or 'resumed'",
  "workspace_path": "string - Path to working directory",
  "repository": {
    "url": "string - Repository URL (if cloned)",
    "branch": "string - Current branch"
  }
}
```

**Behavior**:
- If `session_id` is provided and exists → Resume existing session
- If `session_id` is new → Create new session
- If `session_id` is omitted → Generate UUID automatically
- If `repository_url` is provided → Clone repository on creation (not on resume)
- Mounts R2 bucket for persistence
- Sets up git credentials from server secrets
- Exposes web UI and returns URL
- Idempotent: Safe to call multiple times with same `session_id`

**Example Invocation**:
```json
{
  "session_id": "auth-feature-work",
  "repository_url": "https://github.com/myorg/api",
  "branch": "main",
  "title": "Implement JWT authentication"
}
```

**Example Response**:
```json
{
  "session_id": "auth-feature-work",
  "sandbox_id": "auth-feature-work",
  "web_ui_url": "https://auth-feature-work.sandbox.workers.dev",
  "status": "created",
  "workspace_path": "/workspace",
  "repository": {
    "url": "https://github.com/myorg/api",
    "branch": "main"
  }
}
```

---

### Tool 2: `opencode_run_task`

**Purpose**: Execute a coding task asynchronously in an OpenCode session

**Input Schema**:
```json
{
  "session_id": {
    "type": "string",
    "description": "Session identifier from opencode_create_session",
    "required": true
  },
  "task": {
    "type": "string",
    "description": "Natural language description of what to do. Be specific and clear. Examples: 'Add JWT authentication with refresh tokens', 'Fix the memory leak in the parser module', 'Refactor the API to use async/await'.",
    "required": true
  },
  "model": {
    "type": "string",
    "description": "AI model to use for OpenCode. Defaults to 'claude-haiku-4-5'.",
    "required": false,
    "default": "claude-haiku-4-5"
  }
}
```

**Output Schema**:
```json
{
  "run_id": "string - Unique identifier for this task execution",
  "status": "string - Always 'started' on successful initiation",
  "web_ui_url": "string - URL to watch progress in real-time",
  "message": "string - Guidance on how to check status later"
}
```

**Behavior**:
- Returns immediately (async execution)
- Spawns a Workflow to execute the task
- OpenCode works autonomously until completion
- Task may take minutes to hours depending on complexity
- User can check status with `opencode_get_status` anytime
- User can watch progress via web UI
- Workflow handles retries automatically (up to 3 attempts)
- Timeout after 1 hour (configurable)

**Example Invocation**:
```json
{
  "session_id": "auth-feature-work",
  "task": "Implement JWT authentication with access and refresh tokens. Add middleware to protect routes. Include tests for token validation and refresh flow.",
  "model": "claude-sonnet-4"
}
```

**Example Response**:
```json
{
  "run_id": "run-f3a89c2d",
  "status": "started",
  "web_ui_url": "https://auth-feature-work.sandbox.workers.dev",
  "message": "Task started successfully. OpenCode is working on it autonomously. You can check status anytime with opencode_get_status, or visit the web UI to watch progress in real-time."
}
```

---

### Tool 3: `opencode_get_status`

**Purpose**: Check the status of a session and optionally a specific task run

**Input Schema**:
```json
{
  "session_id": {
    "type": "string",
    "description": "Session identifier to query",
    "required": true
  },
  "run_id": {
    "type": "string",
    "description": "Specific run to query. Omit to get overall session status.",
    "required": false
  },
  "include_git_status": {
    "type": "boolean",
    "description": "Include git branch, commits, and dirty state. Requires active sandbox. Defaults to true.",
    "required": false,
    "default": true
  }
}
```

**Output Schema**:
```json
{
  "session_id": "string",
  "web_ui_url": "string - Current web UI URL (may change on sandbox restart)",
  "sandbox_status": "string - 'active', 'idle', or 'stopped'",
  "workspace_path": "string",
  "created_at": "number - Unix timestamp",
  "last_activity": "number - Unix timestamp of last activity",
  
  "repository": {
    "url": "string",
    "branch": "string - Current branch (if git status available)"
  },
  
  "git_status": {
    "branch": "string - Current branch name",
    "commits": [
      {
        "hash": "string",
        "message": "string",
        "author": "string",
        "timestamp": "number"
      }
    ],
    "uncommitted_changes": "boolean",
    "files_changed": "number"
  },
  
  "recent_runs": [
    {
      "run_id": "string",
      "status": "string - 'running', 'completed', 'failed'",
      "task": "string - Task description",
      "started_at": "number",
      "completed_at": "number (if completed)",
      "result_summary": "string (if completed)"
    }
  ],
  
  "current_run": {
    "run_id": "string",
    "status": "string",
    "task": "string",
    "started_at": "number",
    "elapsed_seconds": "number",
    "result": "object (if completed)"
  }
}
```

**Behavior**:
- Always returns session metadata
- If `run_id` provided → Focus on that specific run
- If `run_id` omitted → Return recent runs (last 10)
- Git status only available if sandbox is active
- If sandbox is stopped → Can still report metadata and stored run history
- Safe to call frequently (cheap operation)

**Example Invocation** (Check specific run):
```json
{
  "session_id": "auth-feature-work",
  "run_id": "run-f3a89c2d"
}
```

**Example Response** (Run completed):
```json
{
  "session_id": "auth-feature-work",
  "web_ui_url": "https://auth-feature-work.sandbox.workers.dev",
  "sandbox_status": "active",
  "workspace_path": "/workspace",
  "created_at": 1703001234000,
  "last_activity": 1703003456000,
  
  "repository": {
    "url": "https://github.com/myorg/api",
    "branch": "feature/jwt-auth"
  },
  
  "git_status": {
    "branch": "feature/jwt-auth",
    "commits": [
      {
        "hash": "a3f8d2c",
        "message": "Add JWT authentication middleware",
        "author": "OpenCode Bot",
        "timestamp": 1703003400000
      },
      {
        "hash": "b4e9a1f",
        "message": "Add tests for token validation",
        "author": "OpenCode Bot",
        "timestamp": 1703003200000
      }
    ],
    "uncommitted_changes": false,
    "files_changed": 0
  },
  
  "recent_runs": [
    {
      "run_id": "run-f3a89c2d",
      "status": "completed",
      "task": "Implement JWT authentication...",
      "started_at": 1703002000000,
      "completed_at": 1703003456000,
      "result_summary": "Successfully implemented JWT authentication with middleware and tests. Created 2 commits on branch feature/jwt-auth."
    }
  ],
  
  "current_run": {
    "run_id": "run-f3a89c2d",
    "status": "completed",
    "task": "Implement JWT authentication with access and refresh tokens...",
    "started_at": 1703002000000,
    "elapsed_seconds": 1456,
    "result": {
      "success": true,
      "files_created": ["src/middleware/auth.ts", "tests/auth.test.ts"],
      "files_modified": ["src/server.ts", "package.json"],
      "commits": ["a3f8d2c", "b4e9a1f"],
      "branch": "feature/jwt-auth"
    }
  }
}
```

---

## Data Model

### Durable Object Storage Schema

```typescript
interface SessionMetadata {
  session_id: string;
  sandbox_id: string;
  created_at: number;
  last_activity: number;
  
  workspace_path: string;
  web_ui_url: string;  // Current URL, may change on restart
  
  repository?: {
    url: string;
    branch: string;
  };
  
  config: {
    github_token_configured: boolean;
    default_model: string;
  };
}

interface RunRecord {
  run_id: string;
  workflow_id: string;
  status: 'running' | 'completed' | 'failed';
  
  task: string;
  model: string;
  
  started_at: number;
  completed_at?: number;
  
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    files_created?: string[];
    files_modified?: string[];
    commits?: string[];
    branch?: string;
  };
  
  retry_count: number;
  max_retries: number;
}

// Storage keys
storage.put('metadata', sessionMetadata);
storage.put(`runs/${run_id}`, runRecord);
storage.put('recent_runs', runIds[]);  // Last 50 runs
```

### R2 Storage Structure

```
Bucket: opencode-sessions

/session-{session_id}/
  workspace/              # Mounted to /workspace in container
    .git/                 # Git repository
      ...
    src/
      ...
    package.json
    README.md
    ...
  
  metadata.json           # Optional: Session-level metadata
    {
      "session_id": "...",
      "created_at": 123456,
      "repository_url": "..."
    }
```

### Workflow Parameters

```typescript
interface WorkflowParams {
  session_id: string;
  sandbox_id: string;
  task: string;
  model: string;
  run_id: string;
  
  // For callback to DO
  do_namespace: string;
  do_id: string;
}

interface WorkflowResult {
  success: boolean;
  output?: string;
  error?: string;
  
  files_created: string[];
  files_modified: string[];
  commits: string[];
  branch: string;
  
  execution_time_ms: number;
  retry_count: number;
}
```

---

## Lifecycle & State Management

### Session States

```
CREATING → ACTIVE → IDLE → STOPPED
    │         │       │        │
    │         └───────┴────────┘
    │               │
    └───────────────┴─→ ERROR
```

**CREATING**:
- Session metadata being initialized
- Sandbox starting, R2 mounting
- Repository cloning (if applicable)
- OpenCode server starting

**ACTIVE**:
- Sandbox is running
- OpenCode is responsive
- Can accept new tasks
- Web UI is accessible

**IDLE**:
- Sandbox is running but no active tasks
- Will sleep after 10 minutes of inactivity
- Web UI still accessible
- Can resume immediately

**STOPPED**:
- Sandbox has been evicted/destroyed
- Files persisted in R2
- Metadata still in DO
- Next access will restart sandbox
- Web UI URL may change

**ERROR**:
- Something went wrong during setup
- Error details in session metadata
- Can attempt recovery or recreation

### Task Run States

```
QUEUED → RUNNING → COMPLETED
           │           │
           └─→ FAILED ←┘
                │
                └─→ RETRYING → RUNNING
                       │
                       └─→ FAILED (after max retries)
```

**QUEUED**: Workflow created but not started yet (brief)

**RUNNING**: 
- Workflow is executing
- OpenCode is working on the task
- May take minutes to hours

**COMPLETED**:
- Task finished successfully
- Results stored in DO
- Git commits made (usually)

**FAILED**:
- Task failed (error, timeout, etc.)
- Error details captured
- Can be retried manually

**RETRYING**:
- Automatic retry after transient failure
- Up to 3 attempts
- Exponential backoff

### Cleanup & Garbage Collection

**V1 Strategy: Manual cleanup**
- User must explicitly destroy sessions
- Sandboxes auto-sleep after 10min (cost-efficient)
- R2 files persist indefinitely
- DO metadata persists indefinitely

**Future Enhancement: Auto-expiration**
- Sessions expire after 7 days of inactivity
- Warning before deletion
- Option to "keep alive" important sessions

---

## Error Handling

### Error Categories

#### 1. Session Creation Errors

**Repository Clone Failure**:
- Cause: Invalid URL, auth failure, network error
- Handling: Return error immediately, don't create session
- User action: Fix URL or check GitHub token

**R2 Mount Failure**:
- Cause: Bucket doesn't exist, permission issue
- Handling: Return error, don't proceed
- Recovery: Check R2 configuration

**Sandbox Startup Failure**:
- Cause: Platform issue, container image problem
- Handling: Retry once, then return error
- User action: Report issue or retry later

#### 2. Task Execution Errors

**OpenCode Crash** (rare):
- Workflow detects error response
- Retry up to 3 times with backoff (5s, 15s, 45s)
- If still failing: Mark run as failed, store error
- User action: Check error, retry manually with different approach

**Timeout** (after 1 hour):
- Workflow times out
- Mark run as failed with timeout reason
- Partial work may be committed (check git status)
- User action: Check what was completed, break task into smaller pieces

**Sandbox Evicted Mid-Task**:
- Workflow detects connection loss
- Attempt to reconnect and resume
- If can't resume: Mark as failed
- User action: Restart task (files persist in R2)

#### 3. Status Query Errors

**Session Not Found**:
- Cause: Invalid session_id or session expired/deleted
- Handling: Return clear error message
- User action: Create new session

**Sandbox Stopped**:
- Not an error, expected state
- Return metadata with sandbox_status='stopped'
- Git status unavailable but can show stored metadata

### Error Response Format

All errors follow consistent structure:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session 'invalid-id' does not exist",
    "details": {
      "session_id": "invalid-id"
    },
    "recoverable": false,
    "suggested_action": "Create a new session with opencode_create_session"
  }
}
```

### Error Codes

```typescript
enum ErrorCode {
  // Session errors
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_CREATION_FAILED = "SESSION_CREATION_FAILED",
  REPOSITORY_CLONE_FAILED = "REPOSITORY_CLONE_FAILED",
  
  // Task errors
  TASK_EXECUTION_FAILED = "TASK_EXECUTION_FAILED",
  TASK_TIMEOUT = "TASK_TIMEOUT",
  OPENCODE_ERROR = "OPENCODE_ERROR",
  
  // Infrastructure errors
  SANDBOX_STARTUP_FAILED = "SANDBOX_STARTUP_FAILED",
  SANDBOX_CONNECTION_LOST = "SANDBOX_CONNECTION_LOST",
  R2_MOUNT_FAILED = "R2_MOUNT_FAILED",
  WORKFLOW_CREATE_FAILED = "WORKFLOW_CREATE_FAILED",
  
  // Validation errors
  INVALID_SESSION_ID = "INVALID_SESSION_ID",
  INVALID_TASK = "INVALID_TASK",
  MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
}
```

---

## Security Considerations

### Authentication & Authorization

**V1 (Personal Use)**:
- No user authentication in MCP server
- Single GitHub token configured as server secret
- All sessions use same credentials
- Suitable for personal projects only

**Future (Multi-user)**:
- OAuth integration for MCP clients
- Per-user GitHub token storage
- Session isolation by user ID
- Rate limiting per user

### GitHub Token Security

**Storage**:
- Token stored as Cloudflare Worker secret
- Not exposed in logs or responses
- Injected into sandbox environment on creation
- Sandbox environment is isolated

**Scope Requirements**:
- `repo` - Full control of private repositories
- `workflow` - Update GitHub Actions workflows (if needed)
- Generate fine-grained token if possible

**Rotation**:
- Manual rotation for V1
- Update secret in Worker configuration
- Existing sessions need to be recreated

### Sandbox Isolation

**VM-level isolation**:
- Each sandbox runs in separate VM
- Cloudflare provides security boundary
- Sandbox cannot access other sandboxes or platform internals

**Network access**:
- Full internet access (can make any HTTP request)
- No restrictions on outbound traffic in V1
- Future: Network policies if needed

### Input Validation

**Session ID**:
- Alphanumeric + hyphens only
- Max 64 characters
- Prevent path traversal in R2 prefixes

**Task Description**:
- No validation (OpenCode handles arbitrary text)
- Max length: 50,000 characters

**Repository URL**:
- Must start with `https://github.com/`
- No validation beyond basic format (clone will fail if invalid)

---

## Cost Considerations

### Pricing Components

#### 1. Durable Objects
- **Request charges**: $0.15 per million requests
- **Duration charges**: $0.02 per million GB-seconds
- **Expected cost**: Very low - DO just coordinates, doesn't do heavy work
- **Estimate**: ~$1-5/month for moderate use

#### 2. Workflows
- **Execution charges**: $0.30 per million step transitions
- **Duration charges**: $0.02 per million GB-seconds
- **Expected cost**: Higher for long-running tasks
- **Estimate**: ~$5-20/month depending on task frequency/duration

#### 3. Sandboxes (Biggest Cost Driver)
- **vCPU charges**: ~$51.84/month per vCPU
- **Memory charges**: ~$6.48/GB/month
- **Default allocation**: 1 vCPU, 1GB RAM per sandbox
- **Expected cost**: ~$58/month per continuously running sandbox
- **Mitigation**: Sandboxes auto-sleep after 10min → only pay for active time
- **Estimate**: $10-30/month with typical usage patterns

#### 4. R2 Storage
- **Storage**: $0.015/GB/month
- **Class A operations** (write): $4.50 per million
- **Class B operations** (read): $0.36 per million
- **Expected cost**: Very low unless storing massive repos
- **Estimate**: $1-5/month for typical projects

#### 5. Workers
- **Request charges**: $0.15 per million requests (same as DO)
- **CPU time**: 50ms free per request, $0.02/million GB-seconds after
- **Expected cost**: Negligible (MCP protocol overhead is minimal)
- **Estimate**: <$1/month

### Total Estimated Cost

**Light usage** (few sessions, occasional tasks):
- ~$5-10/month

**Moderate usage** (multiple concurrent sessions, daily tasks):
- ~$20-40/month

**Heavy usage** (many sessions, long-running tasks):
- ~$50-100/month

### Cost Optimization Strategies (Future)

1. **Aggressive sandbox shutdown**: Stop sandboxes immediately after task completion
2. **Shared sandbox pool**: Reuse sandboxes for multiple sessions (more complex)
3. **Task batching**: Queue multiple tasks to run sequentially in one sandbox session
4. **Storage pruning**: Auto-delete old session files after expiration
5. **Cheaper models**: Use faster/cheaper OpenCode models for simple tasks

---

## Future Enhancements

### Phase 2: UX Improvements

1. **Task Templates**:
   - Pre-defined task types: "Create PR", "Run tests", "Deploy"
   - Customizable templates with parameters
   
2. **Progress Notifications**:
   - Webhook integration for task completion
   - Email/Slack notifications
   - Real-time progress updates via WebSocket

3. **Task Scheduling**:
   - Schedule tasks for future execution
   - Recurring tasks (daily tests, weekly reports)

### Phase 3: Multi-User Support

1. **User Authentication**:
   - OAuth for MCP clients
   - User-specific GitHub tokens
   - Session isolation by user

2. **Team Collaboration**:
   - Shared sessions (multiple users working on same session)
   - Permissions (owner, collaborator, viewer)
   - Activity feed per session

### Phase 4: Advanced Features

1. **Custom OpenCode Configuration**:
   - Choose models per task
   - Custom system prompts
   - Tool restrictions/permissions

2. **Workflow Composition**:
   - Chain multiple tasks
   - Conditional execution
   - Parallel task execution

3. **Integration Ecosystem**:
   - Jira/Linear issue tracking integration
   - CI/CD pipeline triggers
   - Code review automation

### Phase 5: Enterprise Features

1. **Cost Controls**:
   - Budget limits per user/team
   - Resource quotas
   - Usage analytics

2. **Compliance**:
   - Audit logs
   - SOC2 compliance helpers
   - Data residency controls

3. **Self-Hosting**:
   - Deploy on own Cloudflare account
   - Bring your own infrastructure
   - Custom domains

---

## References

### Technical Documentation

- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Agents SDK](https://github.com/cloudflare/agents)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenCode Documentation](https://opencode.ai/docs/)

### Key Blog Posts & Discussions

- [Durable Objects: Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Twitter Thread: Long-running tasks in DOs](https://twitter.com/threepointone/status/XXXXXX) (Jonas Templestein discussion)

### Example Code References

- [Sandbox SDK OpenCode Example](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)
- [Sandbox SDK Examples](https://github.com/cloudflare/sandbox-sdk/tree/main/examples)
- [MCP Server Examples](https://github.com/cloudflare/agents/tree/main/examples)

---

## Appendix: Decision Log

### Key Design Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| Use Workflows for task execution | DOs can't reliably run tasks >2min due to eviction. Workflows are built for long-running operations. | Self-WebSocket hack, alarms pattern, keepAlive flag |
| Single R2 bucket with prefixes | Cost-efficient, simpler management | One bucket per session |
| 1:1 session/sandbox mapping | Simplicity, clear lifecycle | Sandbox pooling, multi-session per sandbox |
| No MCP elicitation | OpenCode is autonomous, doesn't need user input mid-execution | Implement elicitation for edge cases |
| Server-level GitHub token | Simplest for V1 personal use | Per-user tokens, GitHub App |
| Async task execution | Mobile use case requires fire-and-forget | Sync execution with long timeout |
| Manual session cleanup (V1) | Simpler implementation, explicit control | Auto-expiration from day 1 |
| No time estimates for tasks | Models are poor at estimation, sets false expectations | Return estimate, return progress percentage |

---

**Document Version**: 1.0  
**Last Updated**: 2025-12-21  
**Status**: Draft - Ready for Implementation Planning
