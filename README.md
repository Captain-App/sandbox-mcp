# sandbox-mcp

Give your AI assistant superpowers with [OpenCode](https://opencode.ai) running in secure [Cloudflare Sandboxes](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-sandbox/). This MCP server lets AI assistants delegate complex, long-running coding tasks that would normally be impossible in a chat session.

## Why Should You Care?

Ever tried to use an AI assistant on your phone to fix a bug? Clone a repo to add a feature? Run tests and open a PR? Yeah... that doesn't work.

**The Problem:**
- AI assistants timeout on long tasks
- They can't survive disconnections
- They're terrible at multi-file changes that require git operations
- They lose all context when you close the app

**The Solution:**
This MCP server gives your AI assistant a **private coding sandbox** that keeps working even when you're offline. Start a task, grab coffee, come back to a finished PR. Magic? No, just distributed systems done right.

**What You Get:**
- **Fire-and-forget tasks**: Start a coding task, check back later (or never, we don't judge)
- **Immortal sessions**: Survive disconnections, device switches, and even your laptop running out of battery
- **Real-time progress**: Watch your AI work via web UI like it's a reality TV show
- **Autonomous execution**: OpenCode handles the complexity while you pretend to be productive

> **Note:** By default, this uses Anthropic's Claude models because they're awesome. Want OpenAI, Azure, or Google instead? See [Customizing the Provider](#customizing-the-provider).

## Deploy to Cloudflare

Ready to give your AI assistant a promotion? Let's get this thing deployed!

### Prerequisites

You'll need:
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers, R2, and [Containers](https://developers.cloudflare.com/containers/) enabled (the free tier works great!)
- An [Anthropic API key](https://console.anthropic.com/) (because Claude is kind of the star of this show)
- A [GitHub token](https://github.com/settings/tokens) for git operations (so your AI can actually commit code like a real developer)

### Setup

1. **Clone and install** (the usual dance):

```bash
git clone https://github.com/ghostwriternr/sandbox-mcp.git
cd sandbox-mcp
npm install
```

2. **Set up secrets** (shh, don't tell anyone):

```bash
wrangler secret put PROXY_JWT_SECRET    # Mash your keyboard, any random string works
wrangler secret put ANTHROPIC_API_KEY   # Your sk-ant-xxx key from Anthropic
wrangler secret put GITHUB_TOKEN        # Your ghp_xxx token from GitHub
```

3. **Deploy** (the moment of truth):

```bash
npm run deploy
```

Watch the magic happen as Cloudflare does its thing. In about 30 seconds, you'll have a production-ready MCP server!

### Connect Your MCP Client

Now tell your AI assistant where to find its new sandbox. For Claude Desktop, add this to your config:

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

Once connected, your AI assistant gains three powerful new abilities. Think of them as superpowers, but for code.

### `opencode_run_task`

**The Big Red Button.** Start a coding task and get on with your life. Returns immediately with a `runId` you can check later (or forget about until you get a Slack notification).

```typescript
{
  task: string,           // What you want done
  repository?: string,    // Git repo URL to clone
  branch?: string,        // Branch to checkout
  sessionId?: string,     // Continue existing session
}
```

### `opencode_get_result`

**"Are we there yet?"** Check what your AI has been up to. Spoiler: it's probably done already.

```typescript
{
  runId: string           // The run ID from run_task
}
```

### `opencode_list_runs`

**The Hall of Fame.** Browse through your AI's greatest hits (and occasional misses).

```typescript
{
  sessionId?: string,     // Filter by session
  status?: string,        // Filter: started, running, completed, failed
  limit?: number,         // Max results (default 10)
}
```

## Local Development

Want to hack on this thing? We respect that.

```bash
cp .dev.vars.example .dev.vars  # Copy the template and add your secrets
npm run dev                      # Fire up the local server
npm run dev:inspect              # Or use this for the fancy MCP Inspector UI
```

**Pro tip:** The MCP Inspector is great for debugging. It's like DevTools but for AI assistants.

Curious about how this all works under the hood? Check out [AGENTS.md](./AGENTS.md) for architecture deep dives, contribution guidelines, and probably more information than you ever wanted about Durable Objects.

## Customizing the Provider

By default, this uses Anthropic's `claude-sonnet-4-5` because it's fast, smart, and great at coding. But hey, variety is the spice of life!

### Changing the Model (Staying with Anthropic)

Want Claude Opus instead? Just edit `src/models/session.ts`:

```typescript
export const DEFAULT_MODEL = "claude-opus-4-5";  // More power, more tokens, more fun
```

### Using a Different Provider

Feeling adventurous? Want to use OpenAI, Azure, or Google? Buckle up, here's your quest:

**Step 1: Add a proxy service**

Create `src/proxy/services/openai.ts` (or whatever provider you want):
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

**Step 2: Register the service**

Export it from `src/proxy/services/index.ts`:
```typescript
export { openai } from "./openai";
```

**Step 3: Update OpenCode config**

In `src/workflows/helpers/opencode.ts`, update `buildProxyConfig()`:
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

**Step 4: Update task execution**

In the same file, change `providerID` in `executeTask()`:
```typescript
model: {
  providerID: "openai",  // Goodbye Anthropic, hello OpenAI!
  modelID: params.model,
},
```

**Step 5: Add the secret**

```bash
wrangler secret put OPENAI_API_KEY  # Your sk-xxx key from OpenAI
```

**Step 6: Update the default model**

In `src/models/session.ts`:
```typescript
export const DEFAULT_MODEL = "gpt-5.2";  // Or whatever OpenAI is calling it these days
```

**Need help?** Check the [OpenCode provider docs](https://opencode.ai/docs/providers) for the full list of supported providers and their quirks.

## License

MIT (go wild, build cool stuff, make money, just don't blame us if your AI becomes sentient)
