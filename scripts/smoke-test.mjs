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
    authenticate:
      response.headers.get("www-authenticate") ??
      response.headers.get("x-amzn-remapped-www-authenticate"),
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
const discoveredByName = new Map(discovered.map((tool) => [tool.name, tool]));
if (
  discovered.length !== 9 ||
  discoveredByName.get("search_gremlin")?.annotations?.readOnlyHint !== true ||
  discoveredByName.get("search_gremlin")?.inputSchema?.properties?.depth
    ?.default !== 3 ||
  discoveredByName.get("search_gremlin")?.inputSchema?.properties?.depth
    ?.maximum !== 7 ||
  discoveredByName.get("search_gremlin")?.inputSchema?.properties?.query
    ?.maxLength !== 262_144 ||
  discoveredByName.get("search_gremlin")?.inputSchema?.properties?.format
    ?.default !== "compact" ||
  !discoveredByName
    .get("search_gremlin")
    ?.inputSchema?.properties?.format?.enum?.includes("graphson") ||
  discoveredByName.get("get_current_time")?.annotations?.readOnlyHint !==
    true ||
  discoveredByName.get("read_gremlin")?.annotations?.readOnlyHint !== true ||
  discoveredByName.get("read_gremlin")?.annotations?.destructiveHint !==
    false ||
  discoveredByName.get("write_gremlin")?.annotations?.readOnlyHint !== false ||
  discoveredByName.get("write_gremlin")?.annotations?.destructiveHint !==
    false ||
  discoveredByName.get("delete_gremlin")?.annotations?.destructiveHint !==
    true ||
  discoveredByName.get("get_profile")?._meta?.["openai/profile"] !== true ||
  discoveredByName.get("get_graph_state")?.annotations?.readOnlyHint !== true ||
  discoveredByName.get("commit_semantic_delta")?.annotations
    ?.destructiveHint !== false ||
  discoveredByName.get("commit_semantic_delta")?.annotations?.idempotentHint !==
    true ||
  discoveredByName.get("reconcile_operation")?.annotations?.idempotentHint !==
    true
) {
  throw new Error(
    "Expected seven compatibility/semantic tools plus search_gremlin and get_current_time",
  );
}

const anonymous = await post({
  jsonrpc: "2.0",
  id: nextId++,
  method: "tools/call",
  params: {
    name: "search_gremlin",
    arguments: { query: "g.V().limit(1)", depth: 0 },
  },
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
  const graphState = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "get_graph_state",
        arguments: { include_allocators: true, include_v1_state: false },
      },
    },
    token,
  );
  if (
    graphState.body?.result?.isError !== false ||
    graphState.body?.result?.structuredContent?.primary_store !== "neptune" ||
    typeof graphState.body?.result?.structuredContent?.semantic_revision !==
      "number"
  ) {
    throw new Error("Authenticated graph-state lookup failed");
  }

  const profile = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "get_profile", arguments: {} },
    },
    token,
  );
  if (
    profile.body?.result?.isError !== false ||
    typeof profile.body?.result?.structuredContent?.id !== "string"
  ) {
    throw new Error("Authenticated profile lookup failed");
  }

  const authenticated = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "read_gremlin",
        arguments: { query: "g.V().limit(1).elementMap()" },
      },
    },
    token,
  );
  if (authenticated.body?.result?.structuredContent?.ok !== true) {
    throw new Error("Authenticated bounded read failed");
  }
  const search = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "search_gremlin",
        arguments: { query: "g.V().count()", depth: 0, format: "graphson" },
      },
    },
    token,
  );
  const searchResult = search.body?.result?.structuredContent;
  if (
    searchResult?.ok !== true ||
    searchResult.result?.graphson_version !== "3.0" ||
    searchResult.result?.graph?.["@type"] !== "g:Map" ||
    searchResult.result?.search?.query_result_count !== 1
  ) {
    throw new Error("Authenticated typed depth-zero search failed");
  }
  const compact = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "search_gremlin",
        arguments: { query: "g.V().count()", depth: 0 },
      },
    },
    token,
  );
  const compactResult = compact.body?.result?.structuredContent;
  if (
    compactResult?.ok !== true ||
    compactResult.result?.format !== "compact" ||
    compactResult.result?.compact_version !== 1 ||
    !Array.isArray(compactResult.result?.dictionary) ||
    !Array.isArray(compactResult.result?.graph) ||
    typeof compactResult.result?.encoding !== "string" ||
    compactResult.result?.search?.query_result_count !== 1
  ) {
    throw new Error("Authenticated default compact depth-zero search failed");
  }
  const expanded = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "search_gremlin",
        arguments: {
          query: "g.V('sol:authority')",
          blacklist_query: "g.V('sol:authority')",
        },
      },
    },
    token,
  );
  const expandedResult = expanded.body?.result?.structuredContent;
  if (
    expandedResult?.ok !== true ||
    expandedResult.result?.search?.consistency !==
      "unchanged_neptune_stream_head" ||
    expandedResult.result?.search?.hop_count !== 0
  ) {
    throw new Error(
      "Authenticated default-depth blacklist/stream-boundary search failed",
    );
  }
  const clock = await post(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "get_current_time", arguments: {} },
    },
    token,
  );
  const currentTime = clock.body?.result?.structuredContent;
  if (
    clock.body?.result?.isError !== false ||
    !Number.isSafeInteger(currentTime?.unix_time_ms) ||
    Date.parse(currentTime?.server_time_utc) !== currentTime?.unix_time_ms
  ) {
    throw new Error("Authenticated server clock failed");
  }
  console.log("Authenticated graph-state lookup passed.");
  console.log("Authenticated profile lookup passed.");
  console.log("Authenticated bounded read passed.");
  console.log(
    "Authenticated typed search, blacklist/stream boundary and server clock passed.",
  );
} else {
  console.log("MCP_ACCESS_TOKEN was not set; authenticated read was skipped.");
}
