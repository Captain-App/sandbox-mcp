# sandbox-mcp

An MCP server that enables AI assistants to delegate complex, long-running coding tasks to [OpenCode](https://opencode.ai) running in secure [Cloudflare Sandboxes](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-sandbox/).

## Why?

When using AI assistants on mobile or in short sessions, you can't:

- Clone repositories and make multi-file code changes
- Run tests, builds, and create pull requests
- Execute long-running tasks (minutes to hours)
- Maintain state across disconnections

This MCP server solves that with **fire-and-forget task delegation**:

- Start a coding task, check back later
- Sessions survive disconnections and device switches
- Watch progress via web UI or poll for results
- OpenCode handles the complexity autonomously

> **Note:** By default, this server uses Anthropic as the AI provider. To use other providers (OpenAI, Azure, Google, etc.), see [Customizing the Provider](#customizing-the-provider).

## Deploy to Cloudflare

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers, R2, and [Containers](https://developers.cloudflare.com/containers/) enabled
- [Anthropic API key](https://console.anthropic.com/)
- [GitHub token](https://github.com/settings/tokens) (for git operations)

### Setup

1. Clone and install:

```bash
git clone https://github.com/ghostwriternr/sandbox-mcp.git
cd sandbox-mcp
npm install
```

2. Set up secrets:

```bash
wrangler secret put PROXY_JWT_SECRET    # Any random string for signing tokens
wrangler secret put ANTHROPIC_API_KEY   # sk-ant-xxx
wrangler secret put GITHUB_TOKEN        # ghp_xxx
```

3. Deploy:

```bash
npm run deploy
```

### Connect Your MCP Client

Add this server to your MCP client configuration. For Claude Desktop:

```json
{
  "mcpServers": {
    "sandbox": {
      "url": "https://sandbox-mcp.you.workers.dev/mcp"
    }
  }
}
```

## Usage

Once connected, your AI assistant has access to these tools:

### `opencode_run_task`

Start a coding task. Returns immediately with a `runId` to check later.

```typescript
{
  task: string,           // What you want done
  repository?: string,    // Git repo URL to clone
  branch?: string,        // Branch to checkout
  sessionId?: string,     // Continue existing session
}
```

### `opencode_get_result`

Check the status and result of a task.

```typescript
{
  runId: string           // The run ID from run_task
}
```

### `opencode_list_runs`

List past task runs.

```typescript
{
  sessionId?: string,     // Filter by session
  status?: string,        // Filter: started, running, completed, failed
  limit?: number,         // Max results (default 10)
}
```

## Local Development

For local development and testing:

```bash
cp .dev.vars.example .dev.vars  # Then fill in your secrets
npm run dev                      # Start local server
npm run dev:inspect              # With MCP Inspector
```

See [AGENTS.md](./AGENTS.md) for architecture details and contribution guidelines.

## Customizing the Provider

By default, sandbox-mcp uses Anthropic with `claude-sonnet-4-5`. To use a different provider:

### Changing the Model (Anthropic)

Edit `src/models/session.ts` and change `DEFAULT_MODEL`:

```typescript
export const DEFAULT_MODEL = "claude-opus-4-5";  // Change this
```

### Using a Different Provider

To use a different provider (e.g., OpenAI), you'll need to modify these files:

1. **Add a proxy service** - Create `src/proxy/services/openai.ts`:
   ```typescript
   import type { ServiceConfig } from "../types";

   export const openai: ServiceConfig<Env> = {
     target: "https://api.openai.com/v1",
     validate: (req) => req.headers.get("authorization")?.replace("Bearer ", ""),
     transform: async (req, ctx) => {
       req.headers.set("authorization", `Bearer ${ctx.env.OPENAI_API_KEY}`);
       return req;
     },
   };
   ```

2. **Register the service** - Export it from `src/proxy/services/index.ts`:
   ```typescript
   export { openai } from "./openai";
   ```

3. **Update OpenCode config** - In `src/workflows/helpers/opencode.ts`, update `buildProxyConfig()`:
   ```typescript
   function buildProxyConfig(proxyBaseUrl: string, proxyToken: string): Config {
     const containerProxyUrl = toContainerUrl(proxyBaseUrl);
     return {
       provider: {
         openai: {
           options: {
             apiKey: proxyToken,
             baseURL: `${containerProxyUrl}/proxy/openai`,
           },
         },
       },
     };
   }
   ```

4. **Update task execution** - In the same file, change `providerID` in `executeTask()`:
   ```typescript
   model: {
     providerID: "openai",  // Change from "anthropic"
     modelID: params.model,
   },
   ```

5. **Add the secret**:
   ```bash
   wrangler secret put OPENAI_API_KEY
   ```

6. **Update the default model** - In `src/models/session.ts`:
   ```typescript
   export const DEFAULT_MODEL = "gpt-5.2";  // OpenAI model
   ```

See the [OpenCode provider documentation](https://opencode.ai/docs/providers) for supported providers and their configuration.

## License

MIT
