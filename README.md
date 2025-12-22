# sandbox-mcp

An MCP server that enables AI assistants to delegate complex, long-running coding tasks to [OpenCode](https://opencode.ai) running in secure [Cloudflare Sandboxes](https://github.com/cloudflare/sandbox-sdk).

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
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers, R2, and [Containers](https://developers.cloudflare.com/containers/) enabled
- [Anthropic API key](https://console.anthropic.com/)
- [GitHub token](https://github.com/settings/tokens) (for git operations)

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
  runId: string           // The run ID from run_task
}
```

**Returns:** `{ runId, sessionId, status, task, title, result, webUiUrl }`

### `opencode_list_runs`

List past task runs with optional filters.

```typescript
{
  sessionId?: string,     // Filter by session
  status?: string,        // Filter by status: started, running, completed, failed
  limit?: number,         // Max results (default 10)
  before?: number         // Unix timestamp cursor for pagination
}
```

**Returns:** `{ runs: [...], hasMore }`

## Development

### Scripts

```bash
npm run dev          # Start local dev server
npm run dev:inspect  # Dev + MCP Inspector
npm run test         # Run tests
npm run check        # Full CI check (typecheck + lint + test)
npm run deploy       # Deploy to Cloudflare
```

## Deployment

1. Set up secrets:

```bash
wrangler secret put PROXY_JWT_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put PROXY_BASE_URL
```

2. Deploy:

```bash
npm run deploy
```

## Contributing

Contributions are welcome! Please read [AGENTS.md](./AGENTS.md) for guidelines on code style, architecture decisions, and common tasks.

```bash
npm run check  # Run before submitting PRs
```

## License

MIT
