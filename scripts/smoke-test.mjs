#!/usr/bin/env node

const mcpUrl = process.env.MCP_URL;
const token = process.env.MCP_ACCESS_TOKEN;

if (!mcpUrl || !mcpUrl.endsWith("/mcp")) {
  throw new Error("Set MCP_URL to the exact deployed HTTPS URL ending in /mcp");
}

let nextId = 1;

async function post(message, accessToken) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return {
    status: response.status,
    authenticate: response.headers.get("www-authenticate"),
    body: text ? JSON.parse(text) : undefined,
  };
}

const initialize = await post({
  jsonrpc: "2.0",
  id: nextId++,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sol-neptune-smoke-test", version: "1.0.0" },
  },
});
if (
  initialize.status !== 200 ||
  initialize.body?.result?.serverInfo?.name !== "sol-neptune-gremlin"
) {
  throw new Error("MCP initialization failed");
}

await post({ jsonrpc: "2.0", method: "notifications/initialized" });

const tools = await post({
  jsonrpc: "2.0",
  id: nextId++,
  method: "tools/list",
  params: {},
});
const discovered = tools.body?.result?.tools ?? [];
if (discovered.length !== 1 || discovered[0]?.name !== "execute_gremlin") {
  throw new Error("Expected exactly the execute_gremlin tool");
}

const anonymous = await post({
  jsonrpc: "2.0",
  id: nextId++,
  method: "tools/call",
  params: { name: "execute_gremlin", arguments: { query: "g.V().limit(1)" } },
});
if (
  !anonymous.authenticate ||
  anonymous.body?.result?.structuredContent?.error?.code !== "AUTH_REQUIRED" ||
  !anonymous.body?.result?._meta?.["mcp/www_authenticate"]
) {
  throw new Error(
    "Anonymous tool call did not produce the required OAuth challenge",
  );
}

console.log(
  "Initialization, tool discovery, and authentication challenge passed.",
);

if (token) {
  const authenticated = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "execute_gremlin",
        arguments: { query: "g.V().limit(1).elementMap()" },
      },
    },
    token,
  );
  if (authenticated.body?.result?.structuredContent?.ok !== true) {
    throw new Error("Authenticated bounded read failed");
  }
  console.log("Authenticated bounded read passed.");
} else {
  console.log("MCP_ACCESS_TOKEN was not set; authenticated read was skipped.");
}
