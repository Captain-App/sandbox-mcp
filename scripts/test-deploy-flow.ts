/**
 * Manual verification script for Worker Deploy tools.
 * 
 * This script demonstrates how an agent would use the new tools.
 */

async function main() {
  const ENGINE_URL = "http://localhost:8787"; // Change to your dev engine URL
  const SESSION_ID = "a1b2c3d4"; // Change to an active session ID

  console.log("🚀 Starting manual verification of Worker Deploy tools...");

  // 1. Mock Agent Action: Create a simple worker file
  // This is what the agent would do using regular file tools
  console.log("\n1. [Agent] Creating worker file in sandbox...");
  // ... (agent would use file tools)

  // 2. Mock Tool Call: preview_worker
  console.log("\n2. Calling opencode_preview_worker...");
  const previewRes = await fetch(`${ENGINE_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "tools/call",
      params: {
        name: "opencode_preview_worker",
        arguments: {
          sessionId: SESSION_ID,
          workerPath: "/workspace/worker/index.ts",
          port: 8787
        }
      }
    })
  });
  
  const previewData = (await previewRes.json()) as any;
  console.log("Response:", JSON.stringify(previewData, null, 2));

  if (previewData && previewData.content) {
    const text = JSON.parse(previewData.content[0].text);
    console.log(`✅ Preview URL: ${text.previewUrl}`);
    
    // 3. Verify Proxy Routing
    console.log(`\n3. Verifying proxy routing at ${text.previewUrl}...`);
    const routeRes = await fetch(text.previewUrl);
    console.log(`Status: ${routeRes.status} ${routeRes.statusText}`);
  }

  // 4. Mock Tool Call: deploy_worker
  console.log("\n4. Calling opencode_deploy_worker...");
  const deployRes = await fetch(`${ENGINE_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "tools/call",
      params: {
        name: "opencode_deploy_worker",
        arguments: {
          sessionId: SESSION_ID,
          workerPath: "/workspace/worker/index.ts"
        }
      }
    })
  });

  const deployData = await deployRes.json();
  console.log("Response:", JSON.stringify(deployData, null, 2));
}

main().catch(console.error);
