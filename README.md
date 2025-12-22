# sandbox-mcp

An MCP server that enables AI assistants to delegate complex, long-running coding tasks to [OpenCode](https://opencode.ai) running in secure Cloudflare Sandboxes.

## The Problem

When using AI assistants on mobile devices, you can't:

- Clone repositories and make multi-file code changes
- Run tests, builds, and create pull requests
- Execute long-running tasks (minutes to hours)
- Maintain state across disconnections

## The Solution

An MCP server that provides async task delegation to an autonomous coding agent:

- **Fire-and-forget tasks**: Start a coding task, check back later
- **Persistent sessions**: Survive network disconnections and device switches
- **Progress visibility**: Check status anytime or watch via web UI
- **Full autonomy**: OpenCode handles the complexity independently

## Quick Start

### Prerequisites

- Node.js 20+
- Cloudflare account with Workers, R2, and Containers enabled
- Anthropic API key
- GitHub token (for git operations)

### Setup

1. Clone and install:

```bash
git clone https://github.com/sst/sandbox-mcp.git
cd sandbox-mcp
npm install
```

2. Create `.dev.vars` from example:

```bash
cp .dev.vars.example .dev.vars
```

3. Fill in your secrets in `.dev.vars`:

```
PROXY_JWT_SECRET=your-secret-for-signing-tokens
PROXY_BASE_URL=http://localhost:8787
ANTHROPIC_API_KEY=sk-ant-xxx
GITHUB_TOKEN=ghp_xxx
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com
```

4. Start development server:

```bash
npm run dev
```

### Connecting to an MCP Client

Add this server to your MCP client configuration. For Claude Desktop:

```json
{
  "mcpServers": {
    "opencode": {
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

## MCP Tools

### `opencode_run_task`

Execute a coding task. Creates a new session or continues an existing one.

```typescript
{
  task: string,           // What you want done
  sessionId?: string,     // Continue existing session
  repository?: string,    // Git repo URL to clone
  branch?: string,        // Branch to checkout
  model?: string,         // LLM model to use
  title?: string          // Human-readable title
}
```

**Returns:** `{ runId, sessionId, status, webUiUrl }`

### `opencode_get_result`

Get the status and result of a task run.

```typescript
{
  sessionId: string,      // The session ID from run_task
  runId: string           // The run ID from run_task
}
```

**Returns:** `{ runId, sessionId, status, task, title, result, webUiUrl }`

### `opencode_list_runs`

List past task runs for a session.

```typescript
{
  sessionId: string,      // The session to list runs for
  limit?: number          // Max results (default 10)
}
```

**Returns:** `{ runs: [...], hasMore }`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Client (Claude, etc.)                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ MCP Protocol
┌────────────────────────────▼────────────────────────────────────┐
│                   Cloudflare Worker                              │
│  Routes: /mcp, /proxy/*, /session/{id}/                          │
└────────────────────────────┬────────────────────────────────────┘
         │                   │                    │
    ┌────▼────┐       ┌──────▼──────┐      ┌─────▼─────┐
    │ Proxy   │       │ MCP Agent   │      │ Web UI    │
    │ Handler │       │    (DO)     │      │ Proxy     │
    └────┬────┘       └──────┬──────┘      └─────┬─────┘
         │                   │                    │
         │           ┌───────▼───────┐           │
         │           │   Workflow    │           │
         │           └───────┬───────┘           │
         │                   │                   │
    ┌────▼───────────────────▼───────────────────▼────┐
    │                 Cloudflare Sandbox               │
    │   ┌─────────────────────────────────────────┐   │
    │   │           OpenCode Agent                 │   │
    │   │  - Autonomous coding                     │   │
    │   │  - Git operations                        │   │
    │   │  - Web UI on port 4096                   │   │
    │   └─────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| **Worker** | HTTP routing, MCP endpoint, proxy |
| **MCP Agent (DO)** | Protocol handling, tool implementation |
| **Workflow** | Long-running task orchestration (up to 50min) |
| **Sandbox** | Isolated container running OpenCode |
| **R2** | Session metadata, workspace persistence |

### Zero-Trust Proxy

Real credentials never enter the sandbox. All external API calls (Anthropic, GitHub, R2) go through the proxy:

1. MCP Agent creates short-lived JWT with sandboxId/sessionId
2. Sandbox uses JWT as "API key" for external calls
3. Proxy validates JWT, injects real credentials, forwards request

## Development

### Scripts

```bash
npm run dev          # Start local dev server
npm run dev:inspect  # Dev + MCP Inspector
npm run test         # Run tests
npm run check        # Full CI check (typecheck + lint + test)
npm run deploy       # Deploy to Cloudflare
```

### Project Structure

```
src/
├── index.ts              # Worker entry point, routing
├── agent/
│   └── mcp-agent.ts      # MCP protocol handler (Durable Object)
├── workflows/
│   └── execute-task.ts   # Task execution workflow
├── proxy/
│   ├── handler.ts        # Zero-trust proxy
│   └── services/         # Service-specific proxy logic
├── services/
│   ├── session.ts        # R2 session storage
│   └── run.ts            # R2 run storage
└── models/
    ├── session.ts        # Session schema
    ├── run.ts            # Run record schema
    └── errors.ts         # Typed errors
```

### Testing

```bash
npm run test              # Run all tests
npm run test:watch        # Watch mode
```

Tests use Vitest with mock layers for Effect services.

## Deployment

1. Set up secrets:

```bash
wrangler secret put PROXY_JWT_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ENDPOINT
wrangler secret put PROXY_BASE_URL
```

2. Deploy:

```bash
npm run deploy
```

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PROXY_JWT_SECRET` | Secret for signing proxy JWT tokens |
| `PROXY_BASE_URL` | Public URL of this worker |
| `ANTHROPIC_API_KEY` | Anthropic API key for OpenCode |
| `GITHUB_TOKEN` | GitHub PAT for git operations |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_ENDPOINT` | R2 S3-compatible endpoint URL |

### Cloudflare Bindings

Configured in `wrangler.jsonc`:

| Binding | Type | Purpose |
|---------|------|---------|
| `MCP_AGENT` | Durable Object | MCP protocol handler |
| `Sandbox` | Durable Object | Container instances |
| `SESSIONS_BUCKET` | R2 Bucket | Session/workspace storage |
| `EXECUTE_TASK_WORKFLOW` | Workflow | Task execution |

## License

MIT
