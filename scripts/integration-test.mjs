#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const mcpUrl = process.env.MCP_URL;
const token = process.env.MCP_ACCESS_TOKEN;

if (!mcpUrl?.endsWith("/mcp") || !token) {
  throw new Error("Set MCP_URL (ending in /mcp) and MCP_ACCESS_TOKEN");
}

const testId = `sol-mcp-integration-${randomUUID()}`;
let nextId = 1;

async function execute(query) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "execute_gremlin", arguments: { query } },
    }),
  });
  const envelope = await response.json();
  const result = envelope?.result?.structuredContent;
  if (!result?.ok) {
    const code = result?.error?.code ?? "UNKNOWN_ERROR";
    throw new Error(`${code}; integration test id is ${testId}`);
  }
  return result.result;
}

function dataArray(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

console.log(`Integration test id: ${testId}`);

await execute(
  `g.addV('SolMcpIntegrationTest').property('test_id','${testId}').property('temporary',true).id()`,
);

const read = await execute(
  `g.V().hasLabel('SolMcpIntegrationTest').has('test_id','${testId}').limit(2).elementMap()`,
);
if (dataArray(read).length !== 1) {
  throw new Error(
    `Expected exactly one temporary vertex; integration test id is ${testId}`,
  );
}

await execute(
  `g.V().hasLabel('SolMcpIntegrationTest').has('test_id','${testId}').drop().iterate()`,
);

const verify = await execute(
  `g.V().hasLabel('SolMcpIntegrationTest').has('test_id','${testId}').limit(1).count()`,
);
const values = dataArray(verify);
if (values.length !== 1 || values[0] !== 0) {
  throw new Error(
    `Temporary vertex deletion was not verified; integration test id is ${testId}`,
  );
}

console.log("Controlled create/read/delete/verify integration test passed.");
