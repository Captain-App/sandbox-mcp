// src/index.ts
import { OpenCodeMcpAgent } from "./agent/mcp-agent";
import { ExecuteTaskWorkflow } from "./workflows/execute-task";

// Export Sandbox class from @cloudflare/sandbox (required for containers)
export { Sandbox } from "@cloudflare/sandbox";

// Export Durable Object and Workflow classes
export { OpenCodeMcpAgent };
export { ExecuteTaskWorkflow };

// Worker fetch handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // MCP endpoint - route to McpAgent
    if (url.pathname.startsWith("/mcp")) {
      return OpenCodeMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    // Default response
    return new Response(
      JSON.stringify({
        name: "sandbox-mcp",
        version: "1.0.0",
        endpoints: {
          health: "/health",
          mcp: "/mcp",
        },
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};
